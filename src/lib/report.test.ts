import { describe, expect, it } from 'vitest';
import { loadDemo } from '@/lib/demo';
import {
  NARRATIVE_MAX,
  blockedAttempts,
  buildReport,
  executedPayments,
  narrate,
  taipeiDate,
  taipeiMonth,
  zhAmount,
} from '@/lib/report';
import type { AuditEvent, AuditEventType, Payment, PaymentIntent } from '@/lib/types';

/**
 * 週報的測試。
 *
 * 驗收標準（規劃書 M5.2）：**幕四數字正確**。
 *
 * 「正確」在這一格有個很具體的意思：`demo-data` 裡的 `expectedReport`
 * 從今天起**不再是畫面的資料來源，而是這份測試的期望值**。
 * 稽核頁改成從稽核鏈與異常規則算，算出來要跟劇本寫的答案一模一樣。
 * 對不上就是我們算錯了，而不是把畫面改成好看的數字。
 */

const demo = loadDemo();
const NOW = new Date('2026-09-05T01:00:00.000Z'); // 台北 9/5 早上九點

// ---------------------------------------------------------------------------
// 造假的稽核鏈
// ---------------------------------------------------------------------------

let seq = 0;

function ev(
  type: AuditEventType,
  ts: string,
  details: Record<string, unknown>,
  ids: { intentId?: string; paymentId?: string } = {},
): AuditEvent {
  seq += 1;
  return {
    seq,
    id: `e${seq}`,
    ts,
    type,
    actor: 'agent',
    summary: `${type} #${seq}`,
    details,
    prevHash: `0x${'0'.repeat(64)}`,
    hash: `0x${String(seq).padStart(64, '0')}`,
    ...ids,
  };
}

function payment(id: string, amount: number, name = '未知收款人'): Payment {
  return {
    id,
    intentId: `i_${id}`,
    payee: { id: 'p', name, kind: 'unknown', address: `0x${'1'.repeat(40)}`, allowlisted: false },
    amount,
    memoHash: `0x${'2'.repeat(64)}`,
    status: 'blocked',
    channel: 'mock',
    createdAt: NOW.toISOString(),
  } as Payment;
}

function intent(id: string, amount: number): PaymentIntent {
  return { id: `i_${id}`, amount } as PaymentIntent;
}

/** 幕二：詐騙要 50,000，授權信封封成 3,000，政策擋下。 */
function scamBlocked(ts = '2026-09-05T01:30:00.000Z') {
  return {
    audit: [ev('payment.blocked', ts, { rulesHit: ['RISK_HIGH', 'NOT_ALLOWLISTED'] }, { intentId: 'i_pay1', paymentId: 'pay1' })],
    payments: [payment('pay1', 3000, '（999）1234-5678-9012')],
    intents: [intent('pay1', 50000)],
  };
}

// ---------------------------------------------------------------------------

describe('台北時區', () => {
  it('UTC 的月初凌晨算在正確的月份', () => {
    // 台北 2026-09-01 03:00 → UTC 2026-08-31 19:00
    expect(taipeiMonth('2026-08-31T19:00:00.000Z')).toBe('2026-09');
    expect(taipeiDate('2026-08-31T19:00:00.000Z')).toBe('2026-09-01');
  });

  it('UTC 的月底晚上也不會跑到下個月', () => {
    expect(taipeiMonth('2026-08-31T15:59:00.000Z')).toBe('2026-08');
  });

  it('壞掉的時間戳回空字串，不是丟例外', () => {
    expect(taipeiDate('不是時間')).toBe('');
  });
});

describe('從稽核鏈撈攔截紀錄', () => {
  it('記的是對方開口要的金額，不是信封封的', () => {
    const [a] = blockedAttempts(scamBlocked());
    expect(a.requested).toBe(50000);
    expect(a.capped).toBe(3000);
  });

  it('紅隊按鈕不算 —— 那是我們自己按的，不是有人來騙長輩', () => {
    const s = scamBlocked();
    s.audit.push(
      ev('payment.blocked', '2026-09-05T02:00:00.000Z', { source: 'redteam-ui', amount: 9999 }),
      ev('payment.blocked', '2026-09-05T02:01:00.000Z', { source: 'redteam-api', amount: 9999 }),
    );
    expect(blockedAttempts(s)).toHaveLength(1);
  });

  it('新的在前', () => {
    const s = scamBlocked('2026-09-05T01:00:00.000Z');
    s.audit.push(ev('payment.blocked', '2026-09-05T05:00:00.000Z', {}, { paymentId: 'pay2' }));
    s.payments.push(payment('pay2', 100));
    expect(blockedAttempts(s).map((a) => a.at)).toEqual([
      '2026-09-05T05:00:00.000Z',
      '2026-09-05T01:00:00.000Z',
    ]);
  });

  it('沒有對應的 intent 時退回付款金額，不是留空', () => {
    const s = scamBlocked();
    s.intents = [];
    expect(blockedAttempts(s)[0].requested).toBe(3000);
  });
});

describe('從稽核鏈撈付款紀錄', () => {
  it('讀事件裡的金額', () => {
    const s = { audit: [ev('payment.executed', NOW.toISOString(), { amount: 1280 })], payments: [], intents: [] };
    expect(executedPayments(s)).toEqual([{ id: 'e' + seq, at: NOW.toISOString(), amount: 1280 }]);
  });

  it('紅隊如果真的付成功了，也不算門神的正常付款', () => {
    const s = {
      audit: [ev('payment.executed', NOW.toISOString(), { amount: 5000, source: 'redteam-ui' })],
      payments: [],
      intents: [],
    };
    expect(executedPayments(s)).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// 驗收：算出來的要等於劇本寫的答案
// ---------------------------------------------------------------------------

describe('幕四的數字', () => {
  const r = buildReport({
    transactions: demo.transactions,
    usage: demo.usage,
    payees: demo.payees,
    pendingBills: demo.pendingBills,
    blocked: blockedAttempts(scamBlocked()),
    now: NOW,
  });
  const want = demo.expectedReport;

  it('攔截金額等於劇本的 blockedScam', () => {
    expect(r.blockedAmount).toBe(want.blockedScam);
  });

  it('省下來的錢等於 重複扣款 + 殭屍訂閱', () => {
    expect(r.savedAmount).toBe(want.duplicateRefund + want.zombieCancel);
  });

  it('頭條「本月守住」等於劇本的 guardedTotal', () => {
    expect(r.guardedTotal).toBe(want.guardedTotal);
    expect(r.guardedTotal).toBe(51687);
  });

  it('調價只提醒不計入 —— 錢還沒真的省下來，要家人去談', () => {
    const hike = r.findings.find((f) => f.type === 'price_hike');
    expect(hike?.impactMonthly).toBe(want.priceHikeDelta);
    expect(r.guardedTotal).not.toBe(want.guardedTotal + want.priceHikeDelta);
  });

  it('信封封的金額一併記著，才回答得了「你真的守住五萬嗎」', () => {
    expect(r.blockedCapped).toBe(3000);
    expect(r.blockedCapped).toBeLessThan(r.blockedAmount);
  });

  it('四件事都找到了', () => {
    expect(r.findings.map((f) => f.type).sort()).toEqual([
      'due_soon',
      'duplicate_charge',
      'price_hike',
      'zombie_subscription',
    ]);
  });
});

describe('支出統計', () => {
  const r = buildReport({ transactions: demo.transactions, now: NOW });

  it('報告月份是這個月，支出月份是最後一個有帳的月份', () => {
    expect(r.month).toBe('2026-09');
    expect(r.spendMonth).toBe('2026-08');
  });

  it('分類加總等於當月總額', () => {
    expect(r.byCategory.reduce((s, c) => s + c.amount, 0)).toBe(r.totalSpend);
    expect(r.totalSpend).toBe(10770);
  });

  it('金額大的排前面', () => {
    const amounts = r.byCategory.map((c) => c.amount);
    expect([...amounts].sort((a, b) => b - a)).toEqual(amounts);
  });
});

describe('這個月付掉的', () => {
  it('只算這個月的', () => {
    const r = buildReport({
      transactions: demo.transactions,
      now: NOW,
      executed: [
        { amount: 1280, at: '2026-09-05T02:00:00.000Z' },
        { amount: 799, at: '2026-09-05T03:00:00.000Z' },
        { amount: 9999, at: '2026-08-20T02:00:00.000Z' }, // 上個月，不算
      ],
    });
    expect(r.paymentsExecuted).toBe(2);
    expect(r.paidThisMonth).toBe(2079);
  });

  it('上個月的攔截不會一直掛在這個月的頭條上', () => {
    const r = buildReport({
      transactions: demo.transactions,
      usage: demo.usage,
      payees: demo.payees,
      now: NOW,
      blocked: blockedAttempts(scamBlocked('2026-08-15T02:00:00.000Z')),
    });
    expect(r.blockedAmount).toBe(0);
    expect(r.guardedTotal).toBe(1687);
  });
});

// ---------------------------------------------------------------------------
// 唸出來的版本
// ---------------------------------------------------------------------------

describe('週報口語', () => {
  const full = buildReport({
    transactions: demo.transactions,
    usage: demo.usage,
    payees: demo.payees,
    pendingBills: demo.pendingBills,
    blocked: blockedAttempts(scamBlocked()),
    now: NOW,
  });

  it(`不超過 ${NARRATIVE_MAX} 字`, () => {
    expect(full.narrative.length).toBeLessThanOrEqual(NARRATIVE_MAX);
  });

  it('先講守住多少', () => {
    expect(full.narrative.startsWith('媽，這個月門神幫妳守住五萬一千六百八十七元。')).toBe(true);
  });

  it('最後一句是安心的話', () => {
    expect(full.narrative.endsWith('錢都好好的，不用擔心。')).toBe(true);
  });

  it('商家名稱太長時寧可少講一件，也不超過秒數', () => {
    const long = demo.transactions.map((t) =>
      t.merchant === '大台北有線電視' ? { ...t, merchant: '大台北有線電視數位服務股份有限公司北區分公司' } : t,
    );
    const r = buildReport({
      transactions: long,
      usage: demo.usage,
      payees: demo.payees,
      blocked: blockedAttempts(scamBlocked()),
      now: NOW,
    });
    expect(r.narrative.length).toBeLessThanOrEqual(NARRATIVE_MAX);
    expect(r.narrative).toContain('守住五萬一千六百八十七元'); // 頭條不會被砍
    expect(r.narrative).toContain('不用擔心'); // 結尾也不會
  });

  it('整段沒有阿拉伯數字 —— TTS 會把它們唸成英文或逐位唸', () => {
    expect(full.narrative).not.toMatch(/[0-9]/);
  });

  it('快到期不佔口語名額（門神自己會繳，不是要長輩處理的事）', () => {
    expect(full.narrative).not.toContain('快到期');
  });

  it('沒有攔截時不會硬講詐騙', () => {
    const quiet = buildReport({ transactions: demo.transactions, usage: demo.usage, payees: demo.payees, now: NOW });
    expect(quiet.narrative).not.toContain('擋下來');
    expect(quiet.narrative).toContain('守住一千六百八十七元');
  });

  it('什麼都沒發生時不會報一個空的守住金額', () => {
    const empty = buildReport({ transactions: [], now: NOW });
    expect(empty.guardedTotal).toBe(0);
    expect(empty.narrative).toContain('一切正常');
  });

  it('稱呼可以換', () => {
    expect(narrate(full, '爸')).toMatch(/^爸，/);
  });
});

// ---------------------------------------------------------------------------

describe('金額唸成中文', () => {
  const cases: [number, string][] = [
    [0, '零'],
    [7, '七'],
    [10, '十'],
    [15, '十五'],
    [99, '九十九'],
    [115, '一百一十五'],
    [599, '五百九十九'],
    [799, '七百九十九'],
    [1000, '一千'],
    [1088, '一千零八十八'],
    [1280, '一千二百八十'],
    [1600, '一千六百'],
    [1687, '一千六百八十七'],
    [3000, '三千'],
    [10000, '一萬'],
    [10015, '一萬零十五'],
    [10500, '一萬零五百'],
    [11000, '一萬一千'],
    [50000, '五萬'],
    [51687, '五萬一千六百八十七'],
    [100000, '十萬'],
    [1000000, '一百萬'],
  ];

  for (const [n, want] of cases) {
    it(`${n} → ${want}`, () => {
      expect(zhAmount(n)).toBe(want);
    });
  }

  it('小數四捨五入 —— 金額不該出現「點」', () => {
    expect(zhAmount(1687.4)).toBe('一千六百八十七');
    expect(zhAmount(1687.6)).toBe('一千六百八十八');
  });

  it('負數', () => {
    expect(zhAmount(-599)).toBe('負五百九十九');
  });

  it('壞掉的輸入不炸', () => {
    expect(zhAmount(Number.NaN)).toBe('零');
    expect(zhAmount(Number.POSITIVE_INFINITY)).toBe('零');
  });
});
