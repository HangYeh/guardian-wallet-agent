import type { Finding, FindingType, PendingBill, Transaction, UsageRecord } from '@/lib/types';

/**
 * 異常偵測。四條規則，**完全不呼叫模型**。
 *
 * 這一層跟風險引擎（`risk-rules.ts`）是同一種東西的不同題目：那邊看「這一筆該不該付」，
 * 這邊看「已經付掉的這些，有沒有哪筆本來不必付」。門神的價值不只在擋詐騙 ——
 * 長輩的錢更常是這樣一點一點漏掉的：重複扣款沒人發現、三個月沒去的課還在扣、
 * 照護費悄悄漲了五成。
 *
 * 純函數，時間從參數進來，所以測得完。
 */

/**
 * 哪幾種算「省下來的錢」。
 *
 * 重複扣款可以要回來、殭屍訂閱可以停掉 —— 那是**真的錢**。
 * 調價只是提醒（服務還是要付，錢沒省下來，要家人自己去談），
 * 快到期更不是省錢。把它們加進「本月守住」會灌水，而那個數字是週報的頭條，
 * 灌水就等於在對評審誇大成果。
 */
export const RECOVERABLE: readonly FindingType[] = ['duplicate_charge', 'zombie_subscription'];

export function isRecoverable(type: FindingType): boolean {
  return RECOVERABLE.includes(type);
}

export type DetectInput = {
  transactions: Transaction[];
  usage?: UsageRecord[];
  pendingBills?: PendingBill[];
  /** merchant → payeeId 的對照，用來把 usage 接回交易。 */
  payees?: { id: string; name: string }[];
  now?: Date;
};

/** 同一商家、同樣金額，幾天內出現第二次就算重複扣款。 */
const DUPLICATE_WINDOW_DAYS = 15;

/** 訂閱從最後一次使用起算，扣過幾次還沒用就算殭屍。 */
const ZOMBIE_MIN_CHARGES = 2;

/**
 * 判定「價格穩定」需要幾次相同金額。
 *
 * 這個數字是整條規則的關鍵。台電的帳單也在漲（1,180 → 1,240 → 1,520 → 1,610），
 * 但那是夏季電價，不是被偷偷調價。**單看漲幅分不出來** —— 台電 1,240 → 1,520
 * 是 +23%，照護 3,200 → 4,800 是 +50%，隨便設個門檻就會把夏天的電費也報成異常，
 * 而那會讓家人開始忽略通知。
 *
 * 真正的差別是**價格穩不穩**：訂閱與定額服務長期是同一個數字，變了就是被調價；
 * 水電藥局每個月本來就不一樣，漲跌是常態。所以規則看的是
 * 「連續三次同一個金額之後突然變了」，不是漲幅。
 */
const STABLE_REPEATS = 3;

/** 待繳帳單剩幾天內算「快到期」。 */
const DUE_SOON_DAYS = 7;

function daysBetween(a: string, b: string): number {
  return Math.abs((Date.parse(a) - Date.parse(b)) / 86_400_000);
}

function ym(date: string): string {
  return date.slice(0, 7);
}

function nt(n: number): string {
  return n.toLocaleString('zh-TW');
}

/** 依日期排序的副本。原陣列不動。 */
function byDate(txs: Transaction[]): Transaction[] {
  return [...txs].sort((a, b) => a.date.localeCompare(b.date));
}

function groupByMerchant(txs: Transaction[]): Map<string, Transaction[]> {
  const map = new Map<string, Transaction[]>();
  for (const t of txs) {
    const list = map.get(t.merchant) ?? [];
    list.push(t);
    map.set(t.merchant, list);
  }
  for (const [k, v] of map) map.set(k, byDate(v));
  return map;
}

// ---------------------------------------------------------------------------

/** ① 重複扣款：同商家、同金額、短時間內扣了兩次。 */
function duplicateCharges(byMerchant: Map<string, Transaction[]>): Finding[] {
  const out: Finding[] = [];

  for (const [merchant, txs] of byMerchant) {
    for (let i = 1; i < txs.length; i++) {
      const prev = txs[i - 1];
      const cur = txs[i];
      if (prev.amount !== cur.amount) continue;
      if (ym(prev.date) !== ym(cur.date)) continue;
      if (daysBetween(prev.date, cur.date) > DUPLICATE_WINDOW_DAYS) continue;

      out.push({
        id: `dup_${cur.id}`,
        type: 'duplicate_charge',
        title: `${merchant}同一個月扣了兩次 ${nt(cur.amount)} 元`,
        merchant,
        impactMonthly: cur.amount,
        confidence: 0.95,
        evidence: {
          txIds: [prev.id, cur.id],
          rule: `同商家同金額，${prev.date} 與 ${cur.date} 相隔 ${Math.round(daysBetween(prev.date, cur.date))} 天`,
        },
      });
    }
  }

  return out;
}

/** ② 殭屍訂閱：還在扣款，但已經很久沒用了。 */
function zombieSubscriptions(
  byMerchant: Map<string, Transaction[]>,
  usage: UsageRecord[],
  payees: { id: string; name: string }[],
): Finding[] {
  const out: Finding[] = [];
  const nameOf = new Map(payees.map((p) => [p.id, p.name]));

  for (const u of usage) {
    const merchant = nameOf.get(u.payeeId);
    if (!merchant) continue;

    const txs = byMerchant.get(merchant);
    if (!txs) continue;

    // 只看最後一次使用**之後**的扣款。之前的扣款是正常消費，不能算進去。
    const after = txs.filter((t) => t.recurring && t.date > u.lastUsed);
    if (after.length < ZOMBIE_MIN_CHARGES) continue;

    const monthly = after.at(-1)!.amount;
    out.push({
      id: `zombie_${u.payeeId}`,
      type: 'zombie_subscription',
      title: `${merchant}從 ${u.lastUsed} 之後沒去過，還扣了 ${after.length} 次`,
      merchant,
      impactMonthly: monthly,
      confidence: 0.85,
      evidence: {
        txIds: after.map((t) => t.id),
        rule: `最後一次使用 ${u.lastUsed}，之後仍有 ${after.length} 筆固定扣款，每次 ${nt(monthly)} 元`,
      },
    });
  }

  return out;
}

/** ③ 悄悄調價：長期固定的金額突然變了。 */
function priceHikes(byMerchant: Map<string, Transaction[]>): Finding[] {
  const out: Finding[] = [];

  for (const [merchant, txs] of byMerchant) {
    if (txs.length < STABLE_REPEATS + 1) continue;

    // 從最後一筆往前看：前面連續 STABLE_REPEATS 筆是不是同一個金額？
    const latest = txs.at(-1)!;
    const before = txs.slice(-(STABLE_REPEATS + 1), -1);
    if (before.length < STABLE_REPEATS) continue;

    const baseline = before[0].amount;
    const stable = before.every((t) => t.amount === baseline);
    if (!stable || latest.amount === baseline) continue;

    const delta = latest.amount - baseline;
    if (delta <= 0) continue; // 降價不用通知家人

    out.push({
      id: `hike_${latest.id}`,
      type: 'price_hike',
      title: `${merchant}從 ${nt(baseline)} 元漲到 ${nt(latest.amount)} 元`,
      merchant,
      impactMonthly: delta,
      confidence: 0.9,
      evidence: {
        txIds: [...before.map((t) => t.id), latest.id],
        rule: `連續 ${before.length} 個月都是 ${nt(baseline)} 元，${latest.date} 變成 ${nt(latest.amount)} 元，多了 ${nt(delta)} 元`,
      },
    });
  }

  return out;
}

/** ④ 快到期：待繳帳單剩沒幾天。 */
function dueSoon(bills: PendingBill[], now: Date): Finding[] {
  const today = now.toISOString().slice(0, 10);

  return bills
    .filter((b) => b.status === 'unpaid')
    .filter((b) => {
      const days = (Date.parse(b.dueDate) - Date.parse(today)) / 86_400_000;
      return days >= 0 && days <= DUE_SOON_DAYS;
    })
    .map((b) => {
      const days = Math.round((Date.parse(b.dueDate) - Date.parse(today)) / 86_400_000);
      return {
        id: `due_${b.id}`,
        type: 'due_soon' as const,
        title: days === 0 ? `${b.merchant}今天到期` : `${b.merchant}還有 ${days} 天到期`,
        merchant: b.merchant,
        impactMonthly: b.amount,
        confidence: 1,
        evidence: {
          txIds: [b.id],
          rule: `到期日 ${b.dueDate}，今天 ${today}`,
        },
      };
    });
}

// ---------------------------------------------------------------------------

/**
 * 跑四條規則。
 *
 * 排序是刻意的：能拿回來的錢排前面，提醒排後面。家人只會看最上面兩三條。
 */
export function detect(input: DetectInput): Finding[] {
  const now = input.now ?? new Date();
  const byMerchant = groupByMerchant(input.transactions ?? []);

  const findings = [
    ...duplicateCharges(byMerchant),
    ...zombieSubscriptions(byMerchant, input.usage ?? [], input.payees ?? []),
    ...priceHikes(byMerchant),
    ...dueSoon(input.pendingBills ?? [], now),
  ];

  return findings.sort((a, b) => {
    const ra = isRecoverable(a.type) ? 0 : 1;
    const rb = isRecoverable(b.type) ? 0 : 1;
    return ra !== rb ? ra - rb : b.impactMonthly - a.impactMonthly;
  });
}

/** 這些發現裡，真正能拿回來的錢有多少。週報的「省下來」用這個數字。 */
export function savedAmount(findings: Finding[]): number {
  return findings
    .filter((f) => isRecoverable(f.type))
    .reduce((sum, f) => sum + f.impactMonthly, 0);
}
