import { describe, expect, it } from 'vitest';
import { buildIntent } from '@/lib/intent';
import { decide, inQuietHours, taipeiHour, type PolicyContext } from '@/lib/policy';
import type { ParsedFields } from '@/lib/parser';
import type { Payee, Policy } from '@/lib/types';

/**
 * 政策矩陣的測試。
 *
 * 最後一條是不變量測試，也是這一整檔最重要的一條：
 * 只要 decide 回 auto，合約那六道 require 就必須全部過得去。
 * 破掉的話畫面會說「自動繳了」而鏈上 revert —— 使用者以為帳單繳掉了，
 * 那比直接擋下來還糟。
 */

const POLICY: Policy = {
  perTxCap: 3000,
  dailyCap: 5000,
  approvalThreshold: 2000,
  newPayeeRequiresApproval: true,
  newPayeeCooldownHours: 24,
  quietHours: [22, 7],
  allowlist: ['payee_taipower'],
};

const TAIPOWER: Payee = {
  id: 'payee_taipower',
  name: '台灣電力公司',
  address: '0x9965507D1a55bcC2695C58ba16FB37d819B0A4dc',
  kind: 'utility',
  allowlisted: true,
};

const STRANGER: Payee = {
  id: 'unknown_999',
  name: '（999）1234-5678-9012',
  address: '0x71bE63f3384f5fb98995898A86B02Fb2426c5788',
  kind: 'unknown',
  allowlisted: false,
};

// 台北 14:00 = UTC 06:00。白天、非深夜。
const NOON = new Date('2026-09-04T06:00:00.000Z');
// 台北 23:30 = UTC 15:30。深夜。
const NIGHT = new Date('2026-09-04T15:30:00.000Z');

function fields(over: Partial<ParsedFields> = {}): ParsedFields {
  return {
    kind: 'bill',
    payeeName: '台灣電力公司',
    amount: 1200,
    dueDate: '2026-09-20',
    category: 'utility',
    statedAccount: null,
    confidence: 0.95,
    evidence: '本期應繳金額 NT$1,200',
    ...over,
  };
}

function ctx(over: Partial<PolicyContext> = {}, draft: Partial<ParsedFields> = {}): PolicyContext {
  const now = over.now ?? NOON;
  return {
    intent: buildIntent({
      draft: fields(draft),
      rawText: '台灣電力公司 繳費通知',
      source: 'image',
      policy: POLICY,
      payee: over.payee === undefined ? TAIPOWER : over.payee,
      now,
    }),
    policy: POLICY,
    payee: TAIPOWER,
    now,
    ...over,
  };
}

describe('政策矩陣', () => {
  it('白名單 + 金額在範圍 + 白天 + 風險低 → 自動繳', () => {
    const d = decide(ctx());
    expect(d.action).toBe('auto');
    expect(d.rulesHit).toEqual([]);
    expect(d.reason).toContain('直接繳');
  });

  it('超過自動繳費門檻 → 等家人核准', () => {
    const d = decide(ctx({}, { amount: 2500 }));
    expect(d.action).toBe('hold');
    expect(d.rulesHit).toContain('OVER_APPROVAL_THRESHOLD');
  });

  it('超過單筆上限 → hold，而且理由要把差額講清楚', () => {
    const d = decide(ctx({}, { amount: 50_000 }));
    expect(d.action).toBe('hold');
    expect(d.rulesHit).toContain('OVER_PER_TX_CAP');
    // 9/4 決議：不是靜靜照上限付，是把「要求多少、只會付多少」寫出來
    expect(d.reason).toContain('50,000');
    expect(d.reason).toContain('3,000');
    expect(d.reason).toContain('不足以繳清');
    // 而且不可以同時命中門檻那條 —— 上限已經涵蓋它，兩條都報會讓畫面囉唆
    expect(d.rulesHit).not.toContain('OVER_APPROVAL_THRESHOLD');
  });

  it('日累計會超過單日上限 → hold', () => {
    const d = decide(ctx({ spentToday: 4500 }));
    expect(d.action).toBe('hold');
    expect(d.rulesHit).toContain('DAILY_CAP_EXCEEDED');
    expect(d.reason).toContain('4,500');
  });

  it('深夜不自動付', () => {
    const d = decide(ctx({ now: NIGHT }));
    expect(d.action).toBe('hold');
    expect(d.rulesHit).toContain('QUIET_HOURS');
  });

  it('收款人在名單上但不在白名單 → hold（合約也會擋）', () => {
    const d = decide(ctx({ payee: STRANGER }));
    expect(d.action).toBe('hold');
    expect(d.rulesHit).toContain('NOT_ALLOWLISTED');
  });

  it('名單裡根本沒有這個收款人 → hold', () => {
    const d = decide(ctx({ payee: undefined }));
    expect(d.action).toBe('hold');
    expect(d.rulesHit).toContain('PAYEE_UNKNOWN');
  });

  it('剛加進白名單、冷卻期沒過 → hold', () => {
    const addedAt = new Date(NOON.getTime() - 3 * 3_600_000).toISOString();
    const d = decide(ctx({ payeeAddedAt: addedAt }));
    expect(d.action).toBe('hold');
    expect(d.rulesHit).toContain('NEW_PAYEE_COOLDOWN');
    expect(d.reason).toContain('3 小時');
  });

  it('冷卻期過了就不再擋', () => {
    const addedAt = new Date(NOON.getTime() - 30 * 3_600_000).toISOString();
    const d = decide(ctx({ payeeAddedAt: addedAt }));
    expect(d.action).toBe('auto');
  });

  it('風險高 → 直接擋，不是等核准', () => {
    const d = decide(ctx({ risk: 'high' }));
    expect(d.action).toBe('block');
    expect(d.rulesHit).toContain('RISK_HIGH');
  });

  it('風險中等 + 白名單 → hold', () => {
    const d = decide(ctx({ risk: 'medium' }));
    expect(d.action).toBe('hold');
    expect(d.rulesHit).toContain('RISK_MEDIUM');
  });

  // --- fail closed 那一類 ---

  it('意圖過期 → hold，絕不 auto', () => {
    // 信封在 NOON 封的（效期 15 分鐘），到 20 分鐘後才拿來判斷
    const c = ctx();
    const late = new Date(NOON.getTime() + 20 * 60_000);
    const d = decide({ ...c, now: late });
    expect(d.action).toBe('hold');
    expect(d.rulesHit).toContain('INTENT_EXPIRED');
  });

  it('金額不是正整數 → hold', () => {
    const c = ctx();
    const d = decide({ ...c, intent: { ...c.intent, amount: 0 } });
    expect(d.action).toBe('hold');
    expect(d.rulesHit).toContain('AMOUNT_INVALID');
  });

  it('已經結算過的冪等鍵 → block（逾時不等於可以再付一次）', () => {
    const d = decide(ctx({ alreadySettled: true }));
    expect(d.action).toBe('block');
    expect(d.rulesHit).toContain('ALREADY_SETTLED');
  });

  it('判斷過程自己壞掉也要停在 hold，不能變成 auto', () => {
    // policy 缺欄位是最典型的「沒想到」：讀設定檔失敗、欄位打錯字
    const broken = { ...ctx(), policy: null as unknown as typeof POLICY };
    const d = decide(broken);
    expect(d.action).toBe('hold');
    expect(d.rulesHit).toEqual(['EVALUATION_FAILED']);
    expect(d.reason).toContain('失敗就是不付');
  });

  // --- 時段工具 ---

  it('深夜跨午夜的判斷是對的', () => {
    expect(inQuietHours(NIGHT, [22, 7])).toBe(true); // 台北 23:30
    expect(inQuietHours(NOON, [22, 7])).toBe(false); // 台北 14:00
    expect(inQuietHours(new Date('2026-09-04T22:00:00.000Z'), [22, 7])).toBe(true); // 台北 06:00
    expect(inQuietHours(NOON, undefined)).toBe(false);
    expect(inQuietHours(NOON, [9, 17])).toBe(true); // 不跨午夜也要會算
  });

  it('時區看的是台北，不是伺服器', () => {
    // UTC 15:30 在 UTC 是下午，在台北是深夜。伺服器跑在哪都不該改變結果。
    expect(taipeiHour(NIGHT)).toBe(23);
    expect(taipeiHour(NOON)).toBe(14);
  });

  // --- 不變量：這一條破了，畫面就會騙人 ---

  it('凡是回 auto 的，合約六道 require 都過得去', () => {
    const cases: Array<{ label: string; c: PolicyContext }> = [
      { label: '一般帳單', c: ctx() },
      { label: '剛好等於門檻', c: ctx({}, { amount: 2000 }) },
      { label: '日累計剛好不超過', c: ctx({ spentToday: 3800 }) },
      { label: '冷卻期已過', c: ctx({ payeeAddedAt: new Date(NOON.getTime() - 25 * 3_600_000).toISOString() }) },
    ];

    for (const { label, c } of cases) {
      const d = decide(c);
      if (d.action !== 'auto') continue;

      const { intent, policy } = c;
      const spent = c.spentToday ?? 0;

      // 合約 pay() 的六道，逐條比對
      expect(new Date(intent.expiresAt).getTime(), `${label}: 效期`).toBeGreaterThan(
        (c.now ?? NOON).getTime(),
      );
      expect(c.alreadySettled ?? false, `${label}: 防重放`).toBe(false);
      expect(c.payee?.allowlisted, `${label}: 白名單`).toBe(true);
      expect(intent.amount, `${label}: 單筆上限`).toBeLessThanOrEqual(policy.perTxCap);
      expect(intent.amount, `${label}: 核准門檻`).toBeLessThanOrEqual(policy.approvalThreshold);
      expect(spent + intent.amount, `${label}: 單日上限`).toBeLessThanOrEqual(policy.dailyCap);
    }
  });

  it('信封的 scheme 是 exact，而且結算金額就是信封裡那個數字', () => {
    const c = ctx();
    expect(c.intent.scheme).toBe('exact');
    expect(c.intent.maxAmount).toBe(c.intent.amount);

    // 超過天花板時，maxAmount 被壓低 —— 但那時候政策是 hold，不會照著付
    const over = ctx({}, { amount: 50_000 });
    expect(over.intent.maxAmount).toBe(POLICY.perTxCap);
    expect(decide(over).action).toBe('hold');
  });
});
