import { detect, savedAmount } from '@/lib/anomaly';
import type {
  AuditEvent,
  Finding,
  Payment,
  PaymentIntent,
  PendingBill,
  Transaction,
  UsageRecord,
  WeeklyReport,
} from '@/lib/types';

/**
 * 週報。「本月守住 NT$51,687」那張卡背後的計算。
 *
 * **這個檔案存在的理由是：那個數字之前是寫死的。** 稽核頁直接讀
 * `demo-data/guardian-demo.json` 的 `expectedReport`，也就是說整個作品最大的那個
 * 數字，是從一份寫著「答案應該是多少」的檔案裡抄出來的。在一個主張「數字要誠實」
 * 的作品裡，那是最不能留的東西。
 *
 * 現在反過來：這裡從**真的發生過的事**算出來 —— 攔截金額來自稽核鏈，
 * 省下來的錢來自 `anomaly.ts` 的規則。`expectedReport` 降級成**測試的期望值**，
 * 由 `report.test.ts` 比對。算錯了測試會紅，而不是畫面上出現一個好看的假數字。
 *
 * 純函數，時間與資料都從參數進來。
 */

// ---------------------------------------------------------------------------
// 時區
// ---------------------------------------------------------------------------

/**
 * 台北時區的 `YYYY-MM`。
 *
 * 稽核事件的 `ts` 存 UTC。台北是 UTC+8，所以 9/1 凌晨三點在 UTC 還是 8/31 ——
 * 直接 `slice(0, 7)` 會把月初的事件算到上個月去。一年只錯那幾天，
 * 但錯的時候是頭條數字錯。
 */
export function taipeiMonth(iso: string): string {
  return taipeiDate(iso).slice(0, 7);
}

/** 台北時區的 `YYYY-MM-DD`。 */
export function taipeiDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  // en-CA 的日期格式就是 YYYY-MM-DD
  return d.toLocaleDateString('en-CA', {
    timeZone: 'Asia/Taipei',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
}

// ---------------------------------------------------------------------------
// 從稽核鏈撈事實
// ---------------------------------------------------------------------------

/** 一次「有人來要錢，門神沒給」的紀錄。 */
export type BlockedAttempt = {
  id: string;
  at: string;
  summary: string;
  rulesHit: string[];
  payee?: string;
  /** 對方**開口要**的金額。 */
  requested?: number;
  /** 授權信封實際封上去的上限。可能遠小於 requested。 */
  capped?: number;
};

/** `blockedAttempts` 要看的執行期資料。 */
export type ChainView = {
  audit: AuditEvent[];
  payments: Payment[];
  intents: PaymentIntent[];
};

/**
 * 紅隊按鈕也寫 `payment.blocked`，但那是**我們自己按的**，不是有人來騙長輩。
 *
 * 這個過濾條件同時被家人通知卡與週報頭條用到，所以**只能有一份**。
 * 兩邊各寫一次的話，遲早有一邊漏掉，而漏掉的後果是週報把我們自己按的四次
 * 紅隊算成「擋下四次詐騙」—— 頭條數字被自己灌水。
 */
function fromRedTeam(e: AuditEvent): boolean {
  return String(e.details.source ?? '').startsWith('redteam');
}

/** 稽核鏈裡所有被擋下的付款請求，新的在前。 */
export function blockedAttempts(s: ChainView): BlockedAttempt[] {
  return s.audit
    .filter((e) => e.type === 'payment.blocked' && !fromRedTeam(e))
    .slice()
    .reverse()
    .map((e) => {
      const payment = s.payments.find((p) => p.id === e.paymentId);
      const intent = s.intents.find((x) => x.id === e.intentId);
      const hits = e.details.rulesHit;
      return {
        id: e.id,
        at: e.ts,
        summary: e.summary,
        rulesHit: Array.isArray(hits) ? (hits as string[]) : [],
        payee: payment?.payee.name,
        // 對方**開口要的金額**，不是 payment.amount —— 後者已經被授權信封壓到
        // min(讀到的金額, 單筆上限)。幕二那則詐騙要 50,000、信封封成 3,000，
        // 寫 3,000 就是把規模低報了十六倍。
        requested: intent?.amount ?? payment?.amount,
        capped: payment?.amount,
      };
    });
}

/** 稽核鏈裡門神實際付出去的每一筆。 */
export function executedPayments(s: ChainView): { id: string; at: string; amount: number }[] {
  return s.audit
    .filter((e) => e.type === 'payment.executed' && !fromRedTeam(e))
    .map((e) => ({
      id: e.id,
      at: e.ts,
      amount:
        typeof e.details.amount === 'number'
          ? e.details.amount
          : (s.payments.find((p) => p.id === e.paymentId)?.amount ?? 0),
    }));
}

// ---------------------------------------------------------------------------
// 組週報
// ---------------------------------------------------------------------------

export type ReportInput = {
  now?: Date;
  transactions: Transaction[];
  usage?: UsageRecord[];
  payees?: { id: string; name: string }[];
  pendingBills?: PendingBill[];
  /** 被擋下的請求。跑 `blockedAttempts()` 拿。 */
  blocked?: BlockedAttempt[];
  /** 實際付出去的款。跑 `executedPayments()` 拿。 */
  executed?: { amount: number; at: string }[];
  /** 唸出來時怎麼稱呼長輩。預設「媽」（劇本裡說話的是女兒）。 */
  address?: string;
};

function ym(date: string): string {
  return date.slice(0, 7);
}

/** 交易紀錄裡最後一個有資料的月份。 */
function latestMonth(txs: Transaction[]): string {
  return txs.reduce((max, t) => (ym(t.date) > max ? ym(t.date) : max), '');
}

export function buildReport(input: ReportInput): WeeklyReport {
  const now = input.now ?? new Date();
  const month = taipeiMonth(now.toISOString());
  const transactions = input.transactions ?? [];

  const findings = detect({
    transactions,
    usage: input.usage,
    payees: input.payees,
    pendingBills: input.pendingBills,
    now,
  });
  const saved = savedAmount(findings);

  // 只算這個月被擋下的。上個月的詐騙不該一直掛在這個月的頭條上。
  const blocked = (input.blocked ?? []).filter((b) => taipeiMonth(b.at) === month);
  const blockedAmount = blocked.reduce((sum, b) => sum + (b.requested ?? 0), 0);
  const blockedCapped = blocked.reduce((sum, b) => sum + (b.capped ?? b.requested ?? 0), 0);

  /*
   * 支出統計看的是**最後一個有交易紀錄的月份**，不是 `month`。
   *
   * 這兩個常常不一樣：異常偵測跑的是歷史帳（劇本裡是五月到八月），
   * 而「本月守住」講的是今天發生的事。硬把它們湊成同一個月，畫面就會出現
   * 「本月支出 0 元」配「本月守住五萬」這種自相矛盾的組合。分開標，各自說實話。
   */
  const spendMonth = latestMonth(transactions);
  const rows = transactions.filter((t) => ym(t.date) === spendMonth);
  const totalSpend = rows.reduce((sum, t) => sum + t.amount, 0);

  const cat = new Map<string, number>();
  for (const t of rows) cat.set(t.category, (cat.get(t.category) ?? 0) + t.amount);
  const byCategory = [...cat.entries()]
    .map(([category, amount]) => ({ category, amount }))
    .sort((a, b) => b.amount - a.amount);

  const executed = (input.executed ?? []).filter((e) => taipeiMonth(e.at) === month);

  const draft = {
    month,
    spendMonth,
    totalSpend,
    byCategory,
    blockedAmount,
    blockedCapped,
    savedAmount: saved,
    guardedTotal: blockedAmount + saved,
    findings,
    paymentsExecuted: executed.length,
    paidThisMonth: executed.reduce((sum, e) => sum + e.amount, 0),
  };

  return { ...draft, narrative: narrate(draft, input.address) };
}

// ---------------------------------------------------------------------------
// 唸出來的版本
// ---------------------------------------------------------------------------

/** 講幾件事。規劃寫的是「先講守住多少，再講三件事，最後一句安心」。 */
const SPOKEN_ITEMS = 3;

/** 唸出來的長度上限。中文 TTS 大約每秒五個字，90 字約 18 秒。 */
export const NARRATIVE_MAX = 90;

/**
 * 一件事的口語版。
 *
 * 金額後面不加「元」是刻意的：開頭已經講過一次幣別，後面再講就是浪費秒數，
 * 而口語中文本來就這樣說（「多的五百九十九可以退」）。
 */
function spokenFinding(f: Finding): string {
  const amount = zhAmount(f.impactMonthly);
  switch (f.type) {
    case 'duplicate_charge':
      return `${f.merchant}扣了兩次，多的${amount}可以退。`;
    case 'zombie_subscription':
      return `${f.merchant}很久沒去，每月還扣${amount}。`;
    case 'price_hike':
      return `${f.merchant}沒說一聲就漲了${amount}。`;
    case 'due_soon':
      return `${f.merchant}快到期了，門神會繳。`;
  }
}

/**
 * 週報的口語版。**故意不送模型。**
 *
 * 規劃原本寫的是用 gpt-4.1-mini 把週報 JSON 轉成口語（§7.2 Weekly narrator）。
 * 改成模板，是因為這段話**唸給長輩聽、而且整段都是金額**：模型把「五百九十九」
 * 講成「五千九百」不會有任何東西擋下來，聽的人也沒有第二個來源可以對。
 * 整個作品在講「不要讓模型碰它不該碰的東西」，金額就是那個東西。
 *
 * 模型在這裡負責的是解析與判斷 —— 那些有規則兜底、有分數可查。
 * 把已經算好的數字再讓它複述一遍，是白白多開一個出錯的洞。
 */
export function narrate(r: Omit<WeeklyReport, 'narrative' | 'audioUrl'>, address = '媽'): string {
  const head =
    r.guardedTotal > 0
      ? `${address}，這個月門神幫妳守住${zhAmount(r.guardedTotal)}元。`
      : `${address}，這個月一切正常，沒有可疑的付款。`;
  const tail = '錢都好好的，不用擔心。';

  const items: string[] = [];
  if (r.blockedAmount > 0) items.push(`有人要走${zhAmount(r.blockedAmount)}，被擋掉了。`);
  for (const f of r.findings) {
    // 快到期只是提醒，門神自己會繳，不佔口語的名額
    if (f.type !== 'due_soon') items.push(spokenFinding(f));
  }
  items.length = Math.min(items.length, SPOKEN_ITEMS);

  // 超過就從最後一件開始砍。商家名稱是資料，長度不受我們控制 ——
  // 靠「剛好排得下」來守住秒數，換一份資料就破功。頭尾是必要的，中間可以少講。
  while (items.length > 0 && head.length + items.join('').length + tail.length > NARRATIVE_MAX) {
    items.pop();
  }

  return `${head}${items.join('')}${tail}`;
}

// ---------------------------------------------------------------------------
// 數字轉中文
// ---------------------------------------------------------------------------

const DIGITS = ['零', '一', '二', '三', '四', '五', '六', '七', '八', '九'];
const UNITS = ['', '十', '百', '千'];

/** 0 < n < 10000。 */
function under10k(n: number): string {
  const s = String(n);
  let out = '';
  let zeroPending = false;
  for (let i = 0; i < s.length; i++) {
    const d = Number(s[i]);
    if (d === 0) {
      zeroPending = true;
      continue;
    }
    if (zeroPending && out) out += '零';
    zeroPending = false;
    out += DIGITS[d] + UNITS[s.length - 1 - i];
  }
  return out;
}

/** 開頭的「一十」唸成「十」。一十五 → 十五。 */
function trimTen(s: string): string {
  return s.startsWith('一十') ? s.slice(1) : s;
}

/**
 * 金額唸成中文。`51687` → 「五萬一千六百八十七」。
 *
 * TTS 拿到阿拉伯數字時，中文語音常常唸成英文，或逐位唸成「五一六八七」。
 * 長輩聽到的唯一一次金額不能是那樣。
 */
export function zhAmount(n: number): string {
  if (!Number.isFinite(n)) return '零';
  const sign = n < 0 ? '負' : '';
  const i = Math.round(Math.abs(n));
  if (i === 0) return '零';

  if (i >= 100_000_000) {
    const yi = Math.floor(i / 100_000_000);
    const rest = i % 100_000_000;
    if (rest === 0) return `${sign}${zhAmount(yi)}億`;
    return `${sign}${zhAmount(yi)}億${rest < 10_000_000 ? '零' : ''}${zhAmount(rest)}`;
  }

  if (i < 10_000) return sign + trimTen(under10k(i));

  const wan = Math.floor(i / 10_000);
  const rest = i % 10_000;
  const head = `${trimTen(under10k(wan))}萬`;
  if (rest === 0) return sign + head;
  // 一萬零五百：不足千的餘數要補「零」，否則「一萬五百」聽起來像一萬五
  return sign + head + (rest < 1000 ? `零${trimTen(under10k(rest))}` : under10k(rest));
}
