import { keccak256, toBytes } from 'viem';
import { describe, expect, it } from 'vitest';
import {
  assetNetworkFor,
  buildIdempotencyKey,
  buildIntent,
  deriveTaskId,
  intentExpiry,
  intentHash,
  intentToTransaction,
  isIntentExpired,
  INTENT_TTL_MS,
} from '@/lib/intent';
import type { Payee, Policy } from '@/lib/types';

const base = {
  taskId: 'bill-2026-09-taipower',
  payee: `0x${'a'.repeat(40)}` as `0x${string}`,
  amount: 1280,
  assetNetwork: 'tTWD@eip155:31337',
};

describe('buildIdempotencyKey', () => {
  it('是 32 bytes 的 keccak256 雜湊', () => {
    expect(buildIdempotencyKey(base)).toMatch(/^0x[0-9a-f]{64}$/);
  });

  it('同一個任務永遠是同一把鍵', () => {
    expect(buildIdempotencyKey(base)).toBe(buildIdempotencyKey({ ...base }));
  });

  it('金額不同就是不同的鍵', () => {
    expect(buildIdempotencyKey({ ...base, amount: 1281 })).not.toBe(buildIdempotencyKey(base));
  });

  it('收款人不同就是不同的鍵', () => {
    expect(buildIdempotencyKey({ ...base, payee: `0x${'b'.repeat(40)}` })).not.toBe(
      buildIdempotencyKey(base),
    );
  });

  /**
   * 9/5 改的：鍵裡放的是**收款地址**，不是商家名字。
   *
   * 名字不規範（「台電」與「台灣電力公司」是同一個收款人），而且要讓合約重算
   * 就得把中文字串丟進 calldata。地址本來就是 pay() 的參數，也才是錢真正去的地方。
   */
  it('跟合約算出來的是同一個值 —— 這是 IntentMismatch 不會誤觸的前提', () => {
    // GuardedWallet.intentHash: keccak256(abi.encode(taskIdHash, payee, amount, assetNetworkHash))
    const viaParts = intentHash({
      taskIdHash: keccak256(toBytes(base.taskId)),
      payee: base.payee,
      amount: base.amount,
      assetNetworkHash: keccak256(toBytes(base.assetNetwork)),
    });
    expect(viaParts).toBe(buildIdempotencyKey(base));
  });

  it('欄位邊界不會被串在一起搞混（abi.encode 每格固定 32 bytes）', () => {
    const a = buildIdempotencyKey({ ...base, taskId: 'ab', assetNetwork: 'c' });
    const b = buildIdempotencyKey({ ...base, taskId: 'a', assetNetwork: 'bc' });
    expect(a).not.toBe(b);
  });

  it('換一條鏈就是不同的鍵，同一份授權不能跨鏈再結算一次', () => {
    expect(buildIdempotencyKey({ ...base, assetNetwork: 'tTWD@eip155:84532' })).not.toBe(
      buildIdempotencyKey(base),
    );
  });
});

describe('intent 效期', () => {
  it('預設效期是 15 分鐘', () => {
    const now = new Date('2026-09-04T13:00:00.000Z');
    expect(intentExpiry(now)).toBe('2026-09-04T13:15:00.000Z');
    expect(INTENT_TTL_MS).toBe(900_000);
  });

  it('未到期回 false，到期後回 true', () => {
    const intent = { expiresAt: '2026-09-04T13:15:00.000Z' };
    expect(isIntentExpired(intent, new Date('2026-09-04T13:14:59.000Z'))).toBe(false);
    expect(isIntentExpired(intent, new Date('2026-09-04T13:15:01.000Z'))).toBe(true);
  });
});

describe('deriveTaskId', () => {
  it('同一期帳單永遠是同一個任務', () => {
    const a = deriveTaskId({ kind: 'bill', slug: 'taipower', period: '2026-09', rawText: '第一次掃描' });
    const b = deriveTaskId({ kind: 'bill', slug: 'taipower', period: '2026-09', rawText: '第二次掃描，字不一樣' });
    expect(a).toBe('bill-2026-09-taipower');
    expect(b).toBe(a);
  });

  it('不同帳期是不同的任務', () => {
    expect(deriveTaskId({ kind: 'bill', slug: 'taipower', period: '2026-10', rawText: '' })).not.toBe(
      deriveTaskId({ kind: 'bill', slug: 'taipower', period: '2026-09', rawText: '' }),
    );
  });

  it('轉帳把原文雜湊帶進任務代號，同一則請求重試多少次都是同一個任務', () => {
    const text = '幫我轉三千給孫子小宇當生日紅包';
    const a = deriveTaskId({ kind: 'transfer', slug: 'xiaoyu', period: '2026-09', rawText: text });
    const b = deriveTaskId({ kind: 'transfer', slug: 'xiaoyu', period: '2026-09', rawText: text });
    expect(a).toBe(b);
    expect(a).toMatch(/^transfer-2026-09-xiaoyu-[0-9a-f]{6}$/);
  });
});

// ---------------------------------------------------------------------------
// 授權信封
// ---------------------------------------------------------------------------

const policy: Policy = {
  perTxCap: 3000,
  dailyCap: 5000,
  approvalThreshold: 2000,
  newPayeeRequiresApproval: true,
  newPayeeCooldownHours: 24,
  quietHours: [22, 7],
  allowlist: ['payee_taipower'],
};

const taipower: Payee = {
  id: 'payee_taipower',
  name: '台灣電力公司',
  address: '0x1111111111111111111111111111111111111111',
  kind: 'utility',
  allowlisted: true,
  typicalAmount: 1380,
};

const billDraft = {
  kind: 'bill' as const,
  payeeName: '台灣電力公司',
  amount: 1280,
  dueDate: '2026-09-20',
  category: 'utility',
  confidence: 0.95,
};

const now = new Date('2026-09-04T05:00:00.000Z'); // 台北 13:00

function build(overrides: Partial<Parameters<typeof buildIntent>[0]> = {}) {
  return buildIntent({
    draft: billDraft,
    rawText: '台灣電力公司 本期應繳金額 NT$1,280 繳費期限 2026/09/20',
    source: 'text',
    policy,
    payee: taipower,
    now,
    chainMode: 'local',
    ...overrides,
  });
}

describe('buildIntent 六個受管欄位', () => {
  it('六個欄位都填好了，帳期從繳費期限推出來', () => {
    const i = build();
    expect(i.taskId).toBe('bill-2026-09-taipower');
    expect(i.resource).toBe('台灣電力公司 2026-09 帳單');
    expect(i.merchant).toBe('台灣電力公司');
    expect(i.maxAmount).toBe(1280);
    expect(i.assetNetwork).toBe('tTWD@eip155:31337');
    expect(i.expiresAt).toBe('2026-09-04T05:15:00.000Z');
    expect(i.idempotencyKey).toMatch(/^0x[0-9a-f]{64}$/);
  });

  it('授權上限永遠不會超過守護者設的單筆上限', () => {
    const scam = build({
      draft: { ...billDraft, amount: 50_000, payeeName: '監管帳戶' },
      payee: undefined,
    });
    expect(scam.amount).toBe(50_000); // 對方要的
    expect(scam.maxAmount).toBe(3000); // 我們敢授權的
  });

  it('逾時重試拿到同一把鍵：逾時不等於可以再付一次', () => {
    const first = build();
    const retry = build({ now: new Date('2026-09-04T05:30:00.000Z') }); // 效期已過才重試
    expect(retry.expiresAt).not.toBe(first.expiresAt);
    expect(retry.idempotencyKey).toBe(first.idempotencyKey);
    expect(retry.id).toBe(first.id);
  });

  it('測試網與本地鏈的信封不通用', () => {
    expect(build({ chainMode: 'testnet' }).idempotencyKey).not.toBe(build().idempotencyKey);
  });

  it('沒有繳費期限就用當天的台北日期當帳期', () => {
    const i = build({ draft: { ...billDraft, dueDate: null } });
    expect(i.taskId).toBe('bill-2026-09-taipower');
    expect(i.dueDate).toBeUndefined();
  });
});

describe('intentToTransaction', () => {
  it('把意圖投影成帳本上的一筆，水電視為固定支出', () => {
    const tx = intentToTransaction(build(), taipower);
    expect(tx).toMatchObject({
      date: '2026-09-20',
      merchant: '台灣電力公司',
      amount: 1280,
      category: 'utility',
      recurring: true,
      source: 'text',
    });
  });
});

describe('assetNetworkFor', () => {
  it('測試網是 Base Sepolia，其餘走本地鏈', () => {
    expect(assetNetworkFor('testnet')).toBe('tTWD@eip155:84532');
    expect(assetNetworkFor('local')).toBe('tTWD@eip155:31337');
    expect(assetNetworkFor('mock')).toBe('tTWD@eip155:31337');
  });
});
