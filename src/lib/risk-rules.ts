import { taipeiHour } from '@/lib/policy';
import type { BlocklistEntry, Payee, RiskSignal, RiskSignalCode } from '@/lib/types';

/**
 * 規則風險引擎。**完全不呼叫模型。**
 *
 * 這一層存在的理由，是風險模型本身也是一個注入面 —— 它讀的就是那段詐騙文字，
 * 而且比解析器危險：解析器的輸出還要過政策，風險模型的輸出直接決定
 * auto / hold / block。所以必須有一份不靠模型、確定性的分數當地板（§7.3）。
 *
 * 兩條性質：
 *
 * 1. **純函數。** 時間從參數進來，不讀全域。所以測得完。
 * 2. **只會加分，不會減分。** 沒有任何一條規則能把分數往下拉。
 *    模型被說服的最壞結果是「沒幫上忙」，不是「幫倒忙」。
 */

/** §7.3 的權重表。改這裡就是改風險政策，要有意識。 */
export const WEIGHTS: Record<RiskSignalCode, number> = {
  BLOCKLIST_HIT: 50,
  PROMPT_INJECTION: 40,
  NOT_ALLOWLISTED: 30,
  AUTHORITY_IMPERSONATION: 20,
  URGENCY: 20,
  INVESTMENT_GUARANTEE: 20,
  FAMILY_EMERGENCY: 20,
  SECRECY: 15,
  OVER_THRESHOLD: 15,
  AMOUNT_SPIKE: 15,
  SUSPICIOUS_LINK: 10,
  NEW_PAYEE: 10,
  OFF_HOURS: 5,
};

/**
 * 兩條硬鎖：命中就直接 high，不進合成公式（§7.3）。
 *
 * 這兩條是**確定性的事實判斷**——帳號在名單上、文字裡有指令樣式——
 * 不需要模型背書。原公式下，一則命中封鎖名單（規則分 50）的訊息只要
 * 說服模型給 0 分，合成後剩 25 分就掉到 low。攻擊者只要讓模型閉嘴就能過關。
 */
export const HARD_LOCKS: readonly RiskSignalCode[] = ['BLOCKLIST_HIT', 'PROMPT_INJECTION'];

/**
 * 同一類話術用了幾種**不同**手法，要反映在強度上。
 *
 * 去重原本是要擋「立即！立即！馬上！」那種同一條樣式的重複 —— 那是同一個事實
 * 講三遍，不是三個事實。但四條**不同**樣式（老師帶單、保證獲利、名額有限、
 * 承諾報酬率）是真的四份獨立證據，全部壓成一筆 20 分會讓一則寫滿話術的訊息
 * 跟只提一句的訊息同分。
 *
 * 實測就是這樣壞的：幕二的投資詐騙命中四條投資樣式只拿 20 分，
 * 剩下的分數全來自「新收款人」「超過門檻」這種政策事實 ——
 * **等於宣稱抓到詐騙，其實只是嫌它金額大。**
 *
 * 每多一條不同樣式加 5 分，最多加到基礎權重的兩倍。有上限是因為
 * 樣式表會長大，不能讓「多寫幾條正則」自動變成「分數變高」。
 */
const REPEAT_BONUS = 5;

function strengthOf(code: RiskSignalCode, distinctHits: number): number {
  const base = WEIGHTS[code];
  return Math.min(base * 2, base + REPEAT_BONUS * Math.max(0, distinctHits - 1));
}

type Pattern = { re: RegExp; why: string };

/**
 * 樣式表。每一條都附一句「為什麼這是訊號」——
 * 半年後要調整的人得看得懂當初在想什麼，而不是只看到一堆正則。
 */
const PATTERNS: Record<Exclude<RiskSignalCode, 'BLOCKLIST_HIT' | 'NOT_ALLOWLISTED' | 'OVER_THRESHOLD' | 'AMOUNT_SPIKE' | 'OFF_HOURS' | 'NEW_PAYEE'>, Pattern[]> = {
  // 提示詞注入：想讓模型改變行為的字樣。真實帳單不會這樣寫。
  PROMPT_INJECTION: [
    { re: /忽略(上述|以上|先前|之前)?(的)?(所有)?(規則|指令|設定)/, why: '要求忽略既有規則' },
    { re: /(這是|以下是)?(系統|管理員|開發者)(指令|訊息|指示)/, why: '偽裝成系統指令' },
    { re: /ignore\s+(all\s+)?(previous|prior|above)/i, why: 'ignore previous instructions' },
    { re: /(you\s+are\s+now|act\s+as|pretend\s+to\s+be)/i, why: '要求模型改變角色' },
    { re: /立即(執行|轉帳|付款)|直接(執行|放行)/, why: '要求略過確認直接執行' },
    { re: /風險(評為|評分|設為)\s*[0０零]/, why: '直接指示風險分數' },
  ],

  // 冒充公權力：詐騙最常見的開場。
  AUTHORITY_IMPERSONATION: [
    { re: /健保署|衛福部|健保局/, why: '冒充健保機關' },
    { re: /警察|警政署|刑事局|檢察官|地檢署|法院/, why: '冒充司法或警政機關' },
    { re: /監管帳戶|安全帳戶|公證帳戶/, why: '「監管帳戶」是典型話術，真機關不會這樣要錢' },
    { re: /銀行客服|客服中心|金管會|國稅局/, why: '冒充金融機構或稅務機關' },
  ],

  // 製造時間壓力：不給人思考與求證的時間。
  URGENCY: [
    { re: /立即|馬上|立刻|盡速|限[今明]日/, why: '要求立刻行動' },
    { re: /\d+\s*(分鐘|小時)\s*(內|以內)/, why: '設定短促期限' },
    { re: /否則.{0,10}(凍結|停權|失效|法辦|通緝)/, why: '以後果威脅' },
    { re: /(帳戶|帳號).{0,6}(凍結|停用|凍住)/, why: '宣稱帳戶將被凍結' },
    { re: /最後.{0,4}(通知|機會|期限)/, why: '宣稱是最後機會' },
  ],

  // 保證獲利：投資詐騙的核心，合法金融商品不能這樣講。
  INVESTMENT_GUARANTEE: [
    { re: /保證(獲利|賺|收益|報酬)|穩賺|穩定獲利/, why: '保證獲利' },
    { re: /老師.{0,4}(帶單|報明牌|操作)/, why: '「老師帶單」話術' },
    { re: /(名額|席位).{0,6}(有限|剩|只剩)/, why: '製造稀缺感' },
    { re: /獲利\s*\d+\s*[%％]/, why: '承諾具體報酬率' },
    { re: /內線|飆股|翻倍/, why: '不實獲利承諾' },
  ],

  // 假冒親友：金額通常不大，但對長輩最有效。
  FAMILY_EMERGENCY: [
    { re: /出(車禍|事)|發生(車禍|意外)/, why: '宣稱發生意外' },
    { re: /(被|遭)(抓|捕|拘留|扣留)/, why: '宣稱被拘留' },
    { re: /急需|急用|周轉不過來/, why: '宣稱急需用錢' },
    { re: /(手機|電話).{0,6}(壞|摔|遺失|不見)/, why: '解釋為何換號碼——換號碼本身就是訊號' },
    { re: /(用|借)(朋友|同事|別人)的(手機|電話|號碼)/, why: '用他人門號聯絡' },
  ],

  // 要求保密：正當的金流不怕別人知道。
  //
  // 「不要告訴家人」的攻擊對象是阿嬤，不是模型，所以它歸在這裡而不是
  // PROMPT_INJECTION —— 放在那邊會讓它變成硬鎖，而「別跟爸說，這是生日驚喜」
  // 也會中，那太over了。15 分讓它需要跟別的訊號疊加才推得到 medium，剛好。
  SECRECY: [
    { re: /(保密|別說出去|不要聲張|勿外流)/, why: '要求保密' },
    {
      re: /(不要|不能|勿|別|切勿|請勿)\s*(告訴|告知|通知|透露|讓|跟|向).{0,8}(家人|子女|兒子|女兒|任何人|其他人|別人|說|講|知道)/,
      why: '要求不要告訴家人或別人',
    },
    { re: /(自己|私下|低調)(處理|解決|進行)/, why: '要求私下處理' },
  ],

  // 可疑連結與聯絡方式：官方不會用短網址或私人 LINE 收錢。
  SUSPICIOUS_LINK: [
    { re: /(bit\.ly|tinyurl|reurl\.cc|lihi\d?\.cc|pse\.is|risu\.io)/i, why: '短網址' },
    { re: /line\.me\/(ti\/p|R\/ti)/i, why: 'LINE 加好友連結' },
    { re: /(加|搜尋)?\s*LINE\s*(ID|帳號)?\s*[:：]/i, why: '要求加 LINE' },
    { re: /https?:\/\/(?!(www\.)?(taipower|water|cht|nhi|gov)\.)[\w.-]+\.(xyz|top|icu|cc|tk|buzz)/i, why: '非官方網域' },
  ],
};

export type RuleInput = {
  /** 要分析的原文。圖片走的是另一顆模型讀出來的逐字稿，不是欄位。 */
  text: string;
  amount: number;
  approvalThreshold: number;
  /** 對到的收款人；沒對到就是 undefined。 */
  payee?: Payee;
  /** 訊息裡寫的帳號（解析器抽出來的）。用來比對封鎖名單。 */
  statedAccount?: string | null;
  blocklist?: BlocklistEntry[];
  /** 這個收款人的歷史中位數，用來看金額有沒有突增。 */
  typicalAmount?: number;
  quietHours?: [number, number];
  now?: Date;
};

export type RuleResult = {
  score: number;
  signals: RiskSignal[];
  /** 命中硬鎖就直接 high，不進合成公式。 */
  hardLocked: boolean;
};

/** 命中的原文片段，UI 要能標出來。取樣式命中處前後各 12 字。 */
function excerpt(text: string, index: number, length: number): string {
  const start = Math.max(0, index - 12);
  const end = Math.min(text.length, index + length + 12);
  return `${start > 0 ? '…' : ''}${text.slice(start, end)}${end < text.length ? '…' : ''}`;
}

export function ruleSignals(input: RuleInput): RuleResult {
  const text = input.text ?? '';
  const now = input.now ?? new Date();
  const signals: RiskSignal[] = [];

  /** 記一筆訊號。同一種代碼只會有一筆；`hits` 是這一類命中的不同樣式數。 */
  const add = (code: RiskSignalCode, evidence: string, hits = 1) => {
    if (signals.some((s) => s.code === code)) return;
    signals.push({ code, weight: strengthOf(code, hits), evidence });
  };

  // ── 封鎖名單：帳號或名稱命中就直接鎖 ───────────────────────────────
  for (const entry of input.blocklist ?? []) {
    const digits = entry.account.replace(/\D/g, '');
    const textDigits = text.replace(/\D/g, '');
    const stated = (input.statedAccount ?? '').replace(/\D/g, '');
    if (digits && (textDigits.includes(digits) || (stated && stated === digits))) {
      add('BLOCKLIST_HIT', `收款帳號 ${entry.account} 在${entry.source}名單上`);
      break;
    }
  }

  // ── 樣式比對 ──────────────────────────────────────────────────────
  for (const [code, patterns] of Object.entries(PATTERNS) as [RiskSignalCode, Pattern[]][]) {
    // 不 break：要數出這一類用了幾種不同手法，不是只找到一條就算。
    const hits: string[] = [];
    for (const p of patterns) {
      const m = text.match(p.re);
      if (m && m.index !== undefined) {
        hits.push(`${p.why}：「${excerpt(text, m.index, m[0].length)}」`);
      }
    }
    if (hits.length > 0) {
      const evidence = hits.length === 1 ? hits[0] : `${hits[0]}（另有 ${hits.length - 1} 項同類話術）`;
      add(code, evidence, hits.length);
    }
  }

  // ── 收款人 ────────────────────────────────────────────────────────
  if (!input.payee) {
    add('NEW_PAYEE', '名單裡沒有這個收款人，是第一次出現的對象');
  } else if (!input.payee.allowlisted) {
    add('NOT_ALLOWLISTED', `${input.payee.name} 不在白名單上`);
  }

  // ── 金額 ──────────────────────────────────────────────────────────
  if (input.amount > input.approvalThreshold) {
    add(
      'OVER_THRESHOLD',
      `${input.amount.toLocaleString('zh-TW')} 元超過自動繳費門檻 ${input.approvalThreshold.toLocaleString('zh-TW')} 元`,
    );
  }

  if (input.typicalAmount && input.typicalAmount > 0 && input.amount > input.typicalAmount * 3) {
    add(
      'AMOUNT_SPIKE',
      `平常是 ${input.typicalAmount.toLocaleString('zh-TW')} 元，這次要 ${input.amount.toLocaleString('zh-TW')} 元`,
    );
  }

  // ── 時段 ──────────────────────────────────────────────────────────
  if (input.quietHours) {
    const [start, end] = input.quietHours;
    const h = taipeiHour(now);
    const inQuiet = start < end ? h >= start && h < end : h >= start || h < end;
    if (inQuiet) add('OFF_HOURS', `深夜 ${String(h).padStart(2, '0')} 點送來的要求`);
  }

  const score = Math.min(100, signals.reduce((sum, s) => sum + s.weight, 0));
  const hardLocked = signals.some((s) => HARD_LOCKS.includes(s.code));

  return { score, signals, hardLocked };
}

/** 只看規則分的分級。合成分數（規則 + 模型）在 M4.2。 */
export function levelOf(score: number, hardLocked = false): 'low' | 'medium' | 'high' {
  if (hardLocked || score >= 70) return 'high';
  return score >= 40 ? 'medium' : 'low';
}
