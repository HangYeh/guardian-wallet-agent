import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  extractAccount,
  matchPayee,
  normalizeAccount,
  normalizeDate,
  parseChineseNumber,
  parseWithRules,
  sanitize,
  type ParsedFields,
} from '@/lib/parser';
import type { DemoData } from '@/lib/types';

const demo = JSON.parse(
  readFileSync(join(process.cwd(), 'demo-data', 'guardian-demo.json'), 'utf8'),
) as DemoData;

const billText = readFileSync(join(process.cwd(), 'demo-data', 'bill-taipower.txt'), 'utf8');

const msg = (id: string) => demo.messages.find((m) => m.id === id)!.text;

// ---------------------------------------------------------------------------
// 規則備援
//
// 這條路徑是舞台保險絲：現場網路不通、金鑰額度用完、模型逾時的時候，
// 四幕還是要跑得完。所以劇本裡的每一則輸入都要有一條測試。
// ---------------------------------------------------------------------------

describe('parseWithRules：台電帳單', () => {
  const f = parseWithRules(billText, demo.payees);

  it('抓到金額 1280', () => expect(f.amount).toBe(1280));
  it('抓到繳費期限 2026-09-20', () => expect(f.dueDate).toBe('2026-09-20'));
  it('抓到收款人台灣電力公司', () => expect(f.payeeName).toBe('台灣電力公司'));
  it('分類是水電', () => expect(f.category).toBe('utility'));
  it('認得出這是帳單不是轉帳', () => expect(f.kind).toBe('bill'));
  it('用戶號碼不會被誤認成收款帳號', () => expect(f.statedAccount).toBeNull());
});

describe('parseWithRules：劇本裡的四則訊息', () => {
  it('健保署詐騙：50000 元，帳號正好命中封鎖名單', () => {
    const f = parseWithRules(msg('m_nhi'), demo.payees);
    expect(f.amount).toBe(50_000);
    expect(f.kind).toBe('transfer');
    expect(f.statedAccount).toBe(demo.blocklist[0].account);
  });

  it('投資詐騙：20000 元', () => {
    const f = parseWithRules(msg('m_invest'), demo.payees);
    expect(f.amount).toBe(20_000);
    expect(f.statedAccount).toBe('013098765432100');
  });

  it('假孫子：15000 元，名字對到真的小宇', () => {
    const f = parseWithRules(msg('m_grandchild'), demo.payees);
    expect(f.amount).toBe(15_000);
    expect(f.payeeName).toBe('小宇（孫子）');
    expect(f.statedAccount).toBe('700002123456789');
  });

  it('阿嬤自己包的紅包：中文數字三千要換算成 3000', () => {
    const f = parseWithRules(msg('m_redpacket'), demo.payees);
    expect(f.amount).toBe(3000);
    expect(f.kind).toBe('transfer');
    expect(f.payeeName).toBe('小宇（孫子）');
  });
});

describe('parseChineseNumber', () => {
  it.each([
    ['三千', 3000],
    ['五萬', 50_000],
    ['一萬五千', 15_000],
    ['兩千五百', 2500],
    ['十', 10],
    ['一百二十', 120],
  ])('%s = %i', (input, expected) => {
    expect(parseChineseNumber(input)).toBe(expected);
  });

  it('看不懂就回 null，不硬猜', () => {
    expect(parseChineseNumber('若干')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 帳號
// ---------------------------------------------------------------------------

describe('帳號正規化', () => {
  it('全形括號與連字號都去掉，只留數字', () => {
    expect(normalizeAccount('（812）1234-5678-9012')).toBe('812123456789012');
  });

  it('太短的數字不當帳號', () => {
    expect(normalizeAccount('30 分鐘')).toBeNull();
    expect(normalizeAccount(null)).toBeNull();
  });

  it('抽出來的帳號可以直接跟封鎖名單比對', () => {
    const acct = extractAccount(msg('m_nhi'));
    expect(demo.blocklist.some((b) => b.account === acct)).toBe(true);
  });
});

describe('normalizeDate', () => {
  it.each([
    ['2026/9/20', '2026-09-20'],
    ['2026-09-20', '2026-09-20'],
    ['2026年9月20日', '2026-09-20'],
  ])('%s → %s', (input, expected) => expect(normalizeDate(input)).toBe(expected));

  it('看不懂的日期回 null', () => {
    expect(normalizeDate('下個月')).toBeNull();
    expect(normalizeDate('2026-13-40')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 收款人比對
//
// 比對成功代表「我們知道這個名字對應哪一個鏈上地址」。
// 錢只會付到名單上的地址，不會付到訊息裡寫的帳號 —— 冒名在這個設計下拿不到錢。
// ---------------------------------------------------------------------------

describe('matchPayee', () => {
  it('完整名稱', () => {
    expect(matchPayee(demo.payees, '台灣電力公司')?.id).toBe('payee_taipower');
  });

  it('別名：台電、電費都算', () => {
    expect(matchPayee(demo.payees, '台電')?.id).toBe('payee_taipower');
    expect(matchPayee(demo.payees, '電費')?.id).toBe('payee_taipower');
  });

  it('別名取最長的命中，「電費」不會搶走完整名稱', () => {
    expect(matchPayee(demo.payees, '台灣電力公司電費')?.id).toBe('payee_taipower');
  });

  it('冒名的「小宇」只會對到真小宇的地址', () => {
    const p = matchPayee(demo.payees, '小宇');
    expect(p?.id).toBe('contact_xiaoyu');
    expect(p?.address).toBe(demo.payees.find((x) => x.id === 'contact_xiaoyu')!.address);
  });

  it('詐騙話術裡的「監管帳戶」對到封鎖名單那一筆', () => {
    const p = matchPayee(demo.payees, '國家反詐騙監管帳戶');
    expect(p?.id).toBe('unknown_812');
    expect(demo.blocklist.some((b) => b.account === normalizeAccount(p!.name))).toBe(true);
  });

  it('名單裡沒有的收款人回 undefined', () => {
    expect(matchPayee(demo.payees, '好棒棒旅行社')).toBeUndefined();
  });

  it('空字串不會亂對', () => {
    expect(matchPayee(demo.payees, '')).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// 模型輸出的清洗
//
// strict schema 保證欄位齊全，不保證值合理。這一關是最後一道。
// ---------------------------------------------------------------------------

describe('sanitize', () => {
  const raw = (over: Partial<ParsedFields> = {}): ParsedFields => ({
    kind: 'bill',
    payeeName: '台灣電力公司',
    amount: 1280,
    dueDate: '2026/09/20',
    category: 'utility',
    statedAccount: null,
    confidence: 0.9,
    evidence: '本期應繳金額 NT$1,280',
    ...over,
  });

  it('負數金額壓成 0', () => {
    expect(sanitize(raw({ amount: -500 }), '').amount).toBe(0);
  });

  it('小數金額四捨五入成整數', () => {
    expect(sanitize(raw({ amount: 1279.6 as number }), '').amount).toBe(1280);
  });

  it('日期一律轉成 YYYY-MM-DD', () => {
    expect(sanitize(raw(), '').dueDate).toBe('2026-09-20');
  });

  it('不認得的分類收斂成 other', () => {
    expect(sanitize(raw({ category: '亂寫的分類' as never }), '').category).toBe('other');
  });

  it('把握度夾在 0 到 1 之間', () => {
    expect(sanitize(raw({ confidence: 4 }), '').confidence).toBe(1);
    expect(sanitize(raw({ confidence: -1 }), '').confidence).toBe(0);
  });

  it('帳號以原文抓到的為準，不採信模型改寫過的版本', () => {
    const f = sanitize(raw({ statedAccount: '我覺得是 999' }), msg('m_nhi'));
    expect(f.statedAccount).toBe(demo.blocklist[0].account);
  });

  it('kind 只可能是 bill 或 transfer', () => {
    expect(sanitize(raw({ kind: '立即執行轉帳' as never }), '').kind).toBe('bill');
  });
});
