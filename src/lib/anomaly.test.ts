import { describe, expect, it } from 'vitest';
import { RECOVERABLE, detect, isRecoverable, savedAmount } from '@/lib/anomaly';
import { loadDemo } from '@/lib/demo';
import type { Finding, PendingBill, Transaction } from '@/lib/types';

/**
 * 異常偵測的測試。
 *
 * 驗收標準（規劃書 M5.1）：**劇本資料要觸發 599（重複扣款）與 1,088（殭屍訂閱）**。
 *
 * 但這一格真正難的不是把四條規則寫出來，是**不要誤報**。
 * 台電的帳單也在漲（夏季電價），照護費也在漲（偷偷調價）——
 * 規則要能分得出來，否則家人會開始忽略通知，那比不通知還糟。
 */

const demo = loadDemo();
const NOW = new Date('2026-09-05T01:00:00.000Z'); // 台北 9/5 早上

function run(over: Partial<Parameters<typeof detect>[0]> = {}): Finding[] {
  return detect({
    transactions: demo.transactions,
    usage: demo.usage,
    pendingBills: demo.pendingBills,
    payees: demo.payees,
    now: NOW,
    ...over,
  });
}

function ofType(fs: Finding[], t: string): Finding[] {
  return fs.filter((f) => f.type === t);
}

/** 造一串每月同一天、同金額的固定扣款。 */
function monthly(merchant: string, amounts: number[], startMonth = 5): Transaction[] {
  return amounts.map((amount, i) => ({
    id: `${merchant}_${i}`,
    date: `2026-${String(startMonth + i).padStart(2, '0')}-15`,
    merchant,
    amount,
    category: 'subscription',
    recurring: true,
  }));
}

// ---------------------------------------------------------------------------

describe('驗收：劇本資料', () => {
  const found = run();

  it('重複扣款抓到 599', () => {
    const dup = ofType(found, 'duplicate_charge');
    expect(dup).toHaveLength(1);
    expect(dup[0].impactMonthly).toBe(demo.expectedReport.duplicateRefund);
    expect(dup[0].merchant).toBe('大台北有線電視');
    expect(dup[0].evidence.txIds).toHaveLength(2);
  });

  it('殭屍訂閱抓到 1,088', () => {
    const zombie = ofType(found, 'zombie_subscription');
    expect(zombie).toHaveLength(1);
    expect(zombie[0].impactMonthly).toBe(demo.expectedReport.zombieCancel);
    expect(zombie[0].merchant).toBe('銀髮健身課程');
  });

  it('偷偷調價抓到 1,600 的差額', () => {
    const hike = ofType(found, 'price_hike');
    expect(hike).toHaveLength(1);
    expect(hike[0].impactMonthly).toBe(demo.expectedReport.priceHikeDelta);
    expect(hike[0].merchant).toBe('安心居家照護');
  });

  it('快到期抓到中華電信（9/7 到期，今天 9/5）', () => {
    const due = ofType(found, 'due_soon');
    expect(due).toHaveLength(1);
    expect(due[0].merchant).toBe('中華電信');
    expect(due[0].title).toContain('2 天');
  });

  it('省下來的錢等於劇本期望值', () => {
    expect(savedAmount(found)).toBe(
      demo.expectedReport.duplicateRefund + demo.expectedReport.zombieCancel,
    );
  });

  it('四條規則各出現一次，沒有多餘的誤報', () => {
    expect(found).toHaveLength(4);
  });

  it('每一條都帶得出證據', () => {
    for (const f of found) {
      expect(f.evidence.txIds.length, f.type).toBeGreaterThan(0);
      expect(f.evidence.rule.length, f.type).toBeGreaterThan(0);
    }
  });
});

describe('不能誤報：台電的夏季電價', () => {
  /**
   * 台電四個月是 1,180 → 1,240 → 1,520 → 1,610，漲幅 +23%、+6%。
   * 照護費是 3,200 × 3 之後跳到 4,800，漲幅 +50%。
   *
   * **單看漲幅分不出來**：設 40% 門檻剛好只抓到照護，但那是湊出來的數字，
   * 換一份資料就破功。真正的差別是台電本來每個月就不一樣 —— 它從來沒有
   * 「原本的價格」可言。
   */
  it('台電不會被報成調價', () => {
    const hikes = ofType(run(), 'price_hike');
    expect(hikes.map((h) => h.merchant)).not.toContain('台灣電力公司');
  });

  it('金額每月都在變的商家，不管漲多少都不算調價', () => {
    const txs = monthly('水電行', [1000, 1200, 1400, 3000]); // 最後一筆漲一倍多
    expect(ofType(detect({ transactions: txs, now: NOW }), 'price_hike')).toHaveLength(0);
  });

  it('連續三次同價之後變了才算 —— 只有兩次不算', () => {
    const two = monthly('某訂閱', [500, 500, 900]);
    expect(ofType(detect({ transactions: two, now: NOW }), 'price_hike')).toHaveLength(0);

    const three = monthly('某訂閱', [500, 500, 500, 900]);
    const hit = ofType(detect({ transactions: three, now: NOW }), 'price_hike');
    expect(hit).toHaveLength(1);
    expect(hit[0].impactMonthly).toBe(400);
  });

  it('降價不通知家人 —— 那不是壞消息', () => {
    const txs = monthly('某訂閱', [900, 900, 900, 500]);
    expect(ofType(detect({ transactions: txs, now: NOW }), 'price_hike')).toHaveLength(0);
  });

  it('一路沒漲過的訂閱不會被報', () => {
    const txs = monthly('某訂閱', [599, 599, 599, 599, 599]);
    expect(ofType(detect({ transactions: txs, now: NOW }), 'price_hike')).toHaveLength(0);
  });
});

describe('重複扣款', () => {
  const base = (over: Partial<Transaction>): Transaction => ({
    id: 't1',
    date: '2026-08-12',
    merchant: '某店',
    amount: 599,
    category: 'subscription',
    recurring: true,
    ...over,
  });

  it('同月、同金額、相隔兩天 → 抓到', () => {
    const txs = [base({ id: 'a' }), base({ id: 'b', date: '2026-08-14' })];
    expect(ofType(detect({ transactions: txs, now: NOW }), 'duplicate_charge')).toHaveLength(1);
  });

  it('金額不同就不算重複', () => {
    const txs = [base({ id: 'a' }), base({ id: 'b', date: '2026-08-14', amount: 600 })];
    expect(ofType(detect({ transactions: txs, now: NOW }), 'duplicate_charge')).toHaveLength(0);
  });

  it('跨月的同金額是正常的月費，不是重複', () => {
    const txs = [base({ id: 'a' }), base({ id: 'b', date: '2026-09-12' })];
    expect(ofType(detect({ transactions: txs, now: NOW }), 'duplicate_charge')).toHaveLength(0);
  });

  it('同月但隔太久（超過 15 天）不算', () => {
    const txs = [base({ id: 'a', date: '2026-08-01' }), base({ id: 'b', date: '2026-08-30' })];
    expect(ofType(detect({ transactions: txs, now: NOW }), 'duplicate_charge')).toHaveLength(0);
  });

  it('不同商家同金額不算', () => {
    const txs = [base({ id: 'a' }), base({ id: 'b', date: '2026-08-14', merchant: '另一家' })];
    expect(ofType(detect({ transactions: txs, now: NOW }), 'duplicate_charge')).toHaveLength(0);
  });
});

describe('殭屍訂閱', () => {
  const gym = monthly('健身房', [1000, 1000, 1000, 1000]); // 5–8 月
  const payees = [{ id: 'p_gym', name: '健身房' }];

  it('最後使用之後扣了兩次以上 → 抓到', () => {
    const f = detect({
      transactions: gym,
      usage: [{ payeeId: 'p_gym', lastUsed: '2026-06-01' }],
      payees,
      now: NOW,
    });
    const z = ofType(f, 'zombie_subscription');
    expect(z).toHaveLength(1);
    expect(z[0].evidence.txIds).toHaveLength(3); // 6/15、7/15、8/15
  });

  it('只扣了一次還不算殭屍 —— 可能只是這個月剛好沒去', () => {
    const f = detect({
      transactions: gym,
      usage: [{ payeeId: 'p_gym', lastUsed: '2026-07-20' }],
      payees,
      now: NOW,
    });
    expect(ofType(f, 'zombie_subscription')).toHaveLength(0);
  });

  it('最近還在用就不算', () => {
    const f = detect({
      transactions: gym,
      usage: [{ payeeId: 'p_gym', lastUsed: '2026-09-01' }],
      payees,
      now: NOW,
    });
    expect(ofType(f, 'zombie_subscription')).toHaveLength(0);
  });

  it('非固定扣款不算訂閱', () => {
    const oneOff = gym.map((t) => ({ ...t, recurring: false }));
    const f = detect({
      transactions: oneOff,
      usage: [{ payeeId: 'p_gym', lastUsed: '2026-05-01' }],
      payees,
      now: NOW,
    });
    expect(ofType(f, 'zombie_subscription')).toHaveLength(0);
  });

  it('對不到收款人名稱就跳過，不會炸', () => {
    const f = detect({
      transactions: gym,
      usage: [{ payeeId: '不存在', lastUsed: '2026-05-01' }],
      payees,
      now: NOW,
    });
    expect(ofType(f, 'zombie_subscription')).toHaveLength(0);
  });
});

describe('快到期', () => {
  const bill = (over: Partial<PendingBill>): PendingBill => ({
    id: 'b1',
    merchant: '中華電信',
    amount: 799,
    dueDate: '2026-09-07',
    category: 'telecom',
    status: 'unpaid',
    ...over,
  });

  it('七天內到期 → 抓到', () => {
    expect(ofType(detect({ transactions: [], pendingBills: [bill({})], now: NOW }), 'due_soon')).toHaveLength(1);
  });

  it('還很久的不報', () => {
    const f = detect({ transactions: [], pendingBills: [bill({ dueDate: '2026-09-20' })], now: NOW });
    expect(ofType(f, 'due_soon')).toHaveLength(0);
  });

  it('已經過期的不報 —— 那要另一種提醒，不是「快到期」', () => {
    const f = detect({ transactions: [], pendingBills: [bill({ dueDate: '2026-09-01' })], now: NOW });
    expect(ofType(f, 'due_soon')).toHaveLength(0);
  });

  it('已經繳掉的不報', () => {
    const f = detect({ transactions: [], pendingBills: [bill({ status: 'paid' })], now: NOW });
    expect(ofType(f, 'due_soon')).toHaveLength(0);
  });

  it('今天到期的講法不一樣', () => {
    const f = detect({ transactions: [], pendingBills: [bill({ dueDate: '2026-09-05' })], now: NOW });
    expect(ofType(f, 'due_soon')[0].title).toContain('今天');
  });
});

describe('能拿回來的錢', () => {
  it('只有重複扣款與殭屍訂閱算數', () => {
    expect([...RECOVERABLE].sort()).toEqual(['duplicate_charge', 'zombie_subscription']);
    expect(isRecoverable('duplicate_charge')).toBe(true);
    expect(isRecoverable('zombie_subscription')).toBe(true);
    expect(isRecoverable('price_hike')).toBe(false);
    expect(isRecoverable('due_soon')).toBe(false);
  });

  it('調價不計入省下來的錢 —— 服務還是要付，那筆錢沒省下來', () => {
    const found = run();
    const hike = ofType(found, 'price_hike')[0];
    expect(hike.impactMonthly).toBe(1600);
    // 1,600 沒有被加進去 —— 服務還是要付，那筆錢沒省下來
    expect(savedAmount(found)).toBe(599 + 1088);
  });

  it('快到期更不是省錢', () => {
    const f = detect({
      transactions: [],
      pendingBills: demo.pendingBills,
      now: NOW,
    });
    expect(savedAmount(f)).toBe(0);
  });
});

describe('排序與邊界', () => {
  it('能拿回來的錢排在提醒前面', () => {
    const found = run();
    const firstReminder = found.findIndex((f) => !isRecoverable(f.type));
    const lastRecoverable = found.map((f) => isRecoverable(f.type)).lastIndexOf(true);
    expect(lastRecoverable).toBeLessThan(firstReminder);
  });

  it('同一組裡金額大的排前面', () => {
    const found = run();
    const rec = found.filter((f) => isRecoverable(f.type));
    expect(rec[0].impactMonthly).toBeGreaterThanOrEqual(rec[1].impactMonthly);
  });

  it('空資料不會炸', () => {
    expect(() => detect({ transactions: [], now: NOW })).not.toThrow();
    expect(detect({ transactions: [], now: NOW })).toEqual([]);
  });

  it('不會動到傳進來的陣列', () => {
    const txs = monthly('某店', [100, 100, 100, 200]);
    const before = txs.map((t) => t.id).join(',');
    detect({ transactions: txs, now: NOW });
    expect(txs.map((t) => t.id).join(',')).toBe(before);
  });
});
