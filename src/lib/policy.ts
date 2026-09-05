import { isIntentExpired } from '@/lib/intent';
import type {
  Payee,
  PaymentIntent,
  Policy,
  PolicyAction,
  PolicyDecision,
  RiskLevel,
} from '@/lib/types';

/**
 * 政策引擎。門神唯一有權說「這筆錢可以動」的地方。
 *
 * 三個性質是刻意的，也是這一檔存在的理由：
 *
 * 1. **純函數。** 不讀全域狀態、不碰網路、不看時鐘（時間從參數進來）。
 *    所以它測得完 —— 而一個決定要不要付錢的東西，測不完就不該上線。
 *
 * 2. **Fail closed。** 任何一條檢查出錯、任何一個欄位讀不到，
 *    結果都是 `hold`，不是 `auto`。最壞的情況是「今天沒繳到」，
 *    不會是「繳錯了」。（演講 Slide 23：validate context, fail closed）
 *
 * 3. **不會說出合約做不到的話。** 合約 `pay()` 有六道 require；
 *    這裡回 `auto` 的每一筆，那六道都必須過得去。
 *    否則畫面說「自動繳了」，鏈上卻 revert —— 那比擋下來還糟，
 *    因為使用者以為帳單繳掉了。這條有測試守著（見 policy.test.ts 最後一條）。
 */

export type PolicyRule =
  // --- 會直接擋掉的 ---
  | 'RISK_HIGH'
  | 'ALREADY_SETTLED'
  // --- 會轉人工核准的 ---
  | 'RISK_MEDIUM'
  | 'INTENT_EXPIRED'
  | 'AMOUNT_INVALID'
  | 'PAYEE_UNKNOWN'
  | 'NOT_ALLOWLISTED'
  | 'NEW_PAYEE_COOLDOWN'
  | 'OVER_PER_TX_CAP'
  | 'OVER_APPROVAL_THRESHOLD'
  | 'DAILY_CAP_EXCEEDED'
  | 'QUIET_HOURS'
  | 'ASSET_NETWORK_MISMATCH'
  // --- 判斷過程本身壞掉 ---
  | 'EVALUATION_FAILED';

export type PolicyContext = {
  intent: PaymentIntent;
  policy: Policy;
  /** 對到的收款人。沒對到就是 undefined —— 那本身就是一條規則。 */
  payee?: Payee;
  /** 風險分級。M4.x 之前一律當 low，因為還沒有風險引擎。 */
  risk?: RiskLevel;
  /** 今天已經付掉多少。M2.4 接上帳本之前是 0。 */
  spentToday?: number;
  /** 這個收款人是什麼時候被加進白名單的（ISO）。沒有就跳過冷卻檢查。 */
  payeeAddedAt?: string;
  /** 這把冪等鍵是不是已經結算過了。合約會擋，但畫面應該先講清楚。 */
  alreadySettled?: boolean;
  /**
   * 現在這個行程實際連著的資產與網路，例如 tTWD@eip155:31337。
   *
   * 意圖產生時記了一個，執行時可能已經不是同一條鏈了（切了 CHAIN_MODE、
   * 或者本地鏈跟測試網同時開著）。演講 Slide 29 的 MATCH 那一步要比對的就是這個。
   * 不傳就跳過檢查 —— 但呼叫端該傳，執行層一定會傳。
   */
  chainAssetNetwork?: string;
  now?: Date;
};

/**
 * 新收款人冷卻期還剩幾小時。0 代表不在冷卻中：規則沒開、沒有加入時間、或已經過了。
 *
 * 政策引擎與守護者頁面都用這一個。畫面上寫「冷卻中」跟引擎真的擋，
 * 必須是同一個算法 —— 否則就會出現「畫面說冷卻中、錢卻付出去了」。
 */
export function cooldownRemainingHours(
  policy: Policy,
  addedAt: string | undefined,
  now: Date,
): number {
  if (!policy.newPayeeRequiresApproval || !addedAt) return 0;
  const elapsed = (now.getTime() - new Date(addedAt).getTime()) / 3_600_000;
  if (!Number.isFinite(elapsed)) return 0;
  return Math.max(0, policy.newPayeeCooldownHours - elapsed);
}

type Hit = { rule: PolicyRule; action: PolicyAction; reason: string };

const SEVERITY: Record<PolicyAction, number> = { auto: 0, hold: 1, block: 2 };

/**
 * 決策入口。
 *
 * 外面永遠只呼叫這個，不要直接呼叫 `evaluate` —— 這一層的 try/catch
 * 就是「fail closed」那句話的實作。少了它，一個沒想到的 undefined
 * 會變成 500，而 500 在某些寫法下會被上層當成「沒有攔截理由」。
 */
export function decide(ctx: PolicyContext): PolicyDecision {
  try {
    return evaluate(ctx);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    return {
      action: 'hold',
      rulesHit: ['EVALUATION_FAILED'],
      reason: `政策判斷過程出錯，依「失敗就是不付」停下來等家人核准：${detail}`,
    };
  }
}

function evaluate(ctx: PolicyContext): PolicyDecision {
  const { intent, policy } = ctx;
  const now = ctx.now ?? new Date();
  const risk = ctx.risk ?? 'low';
  const spentToday = ctx.spentToday ?? 0;
  const amount = intent.amount;

  const hits: Hit[] = [];
  const hit = (rule: PolicyRule, action: PolicyAction, reason: string) =>
    hits.push({ rule, action, reason });

  // --- 擋掉的兩條 ---

  if (risk === 'high') {
    hit('RISK_HIGH', 'block', '風險判定為高，門神不會付這一筆。');
  }

  if (ctx.alreadySettled) {
    // 演講 Slide 29：逾時代表結果未知，不代表可以再付一次。
    hit(
      'ALREADY_SETTLED',
      'block',
      '這筆意圖先前已經結算過了，重送不會再付一次（逾時不等於可以再付）。',
    );
  }

  // --- 轉人工核准的 ---

  if (risk === 'medium') {
    hit('RISK_MEDIUM', 'hold', '風險判定為中等，要家人看過再決定。');
  }

  if (isIntentExpired(intent, now)) {
    // 合約也會擋（expiresAt 上鏈檢查），但畫面不該等到鏈上才說。
    hit(
      'INTENT_EXPIRED',
      'hold',
      `這筆意圖的效期到 ${intent.expiresAt}，已經過了，要重新讀一次帳單。`,
    );
  }

  if (!Number.isInteger(amount) || amount <= 0) {
    hit('AMOUNT_INVALID', 'hold', `讀到的金額是 ${amount}，不是合理的正整數。`);
  }

  if (!ctx.payee) {
    hit(
      'PAYEE_UNKNOWN',
      'hold',
      `名單裡沒有「${intent.payeeName}」這個收款人，第一次的對象一律要家人點頭。`,
    );
  } else if (!ctx.payee.allowlisted) {
    // 合約的 require(allowlist[payee]) 一定會擋，所以這裡絕不能回 auto。
    hit(
      'NOT_ALLOWLISTED',
      'hold',
      `${ctx.payee.name} 不在白名單上，合約也不會讓門神付給它。`,
    );
  } else {
    // 剛加進白名單的人，冷卻期內照樣要家人點頭 —— 「先騙家人把帳戶加進去、
    // 然後馬上出款」是常見手法，這 24 小時是留給家人反悔的。
    const left = cooldownRemainingHours(policy, ctx.payeeAddedAt, now);
    if (left > 0) {
      const elapsed = policy.newPayeeCooldownHours - left;
      const since = elapsed < 1 ? '還不到一小時' : `才 ${Math.floor(elapsed)} 小時`;
      hit(
        'NEW_PAYEE_COOLDOWN',
        'hold',
        `${ctx.payee.name} 加進白名單${since}，未滿 ${policy.newPayeeCooldownHours} 小時冷卻期，` +
          `還要等 ${Math.ceil(left)} 小時；這段期間的付款仍要家人核准。`,
      );
    }
  }

  if (amount > policy.perTxCap) {
    // 9/4 決議：不是靜靜照上限付（那等於付一筆沒人要求的金額），
    // 是停下來把差額講清楚，讓家人決定要核准、要拒絕、還是去把上限調高。
    hit(
      'OVER_PER_TX_CAP',
      'hold',
      `要求 ${fmt(amount)} 元，超過單筆上限 ${fmt(policy.perTxCap)} 元。` +
        `核准後只會付出 ${fmt(intent.maxAmount)} 元，不足以繳清；` +
        `要全額支付得先調高上限。`,
    );
  } else if (amount > policy.approvalThreshold) {
    hit(
      'OVER_APPROVAL_THRESHOLD',
      'hold',
      `${fmt(amount)} 元超過自動繳費門檻 ${fmt(policy.approvalThreshold)} 元，要家人點頭。`,
    );
  }

  if (spentToday + amount > policy.dailyCap) {
    hit(
      'DAILY_CAP_EXCEEDED',
      'hold',
      `今天已經付掉 ${fmt(spentToday)} 元，再付 ${fmt(amount)} 元會超過單日上限 ` +
        `${fmt(policy.dailyCap)} 元。`,
    );
  }

  if (ctx.chainAssetNetwork && ctx.chainAssetNetwork !== intent.assetNetwork) {
    // 授權是對「某一條鏈上的某一種資產」開的。換了鏈，那份授權就不算數了 ——
    // 就算金額、收款人都一樣，那也是另一筆錢。
    hit(
      'ASSET_NETWORK_MISMATCH',
      'hold',
      `這筆授權是給 ${intent.assetNetwork} 的，現在連的是 ${ctx.chainAssetNetwork}，不是同一條鏈。`,
    );
  }

  if (inQuietHours(now, policy.quietHours)) {
    hit(
      'QUIET_HOURS',
      'hold',
      `現在是深夜（${policy.quietHours![0]}:00–${policy.quietHours![1]}:00），` +
        `門神不自動付款，等天亮或家人核准。`,
    );
  }

  // --- 收斂 ---

  if (hits.length === 0) {
    return {
      action: 'auto',
      rulesHit: [],
      reason: `${intent.merchant} ${fmt(amount)} 元：在白名單、金額在範圍內、時段也沒問題，門神直接繳。`,
    };
  }

  // 最嚴重的那一條決定動作；理由取同一級裡最先命中的那條（順序就是上面的排列）。
  const action = hits.reduce<PolicyAction>(
    (worst, h) => (SEVERITY[h.action] > SEVERITY[worst] ? h.action : worst),
    'auto',
  );
  const decisive = hits.find((h) => h.action === action)!;
  const others = hits.length - 1;

  return {
    action,
    rulesHit: hits.map((h) => h.rule),
    reason: others > 0 ? `${decisive.reason}（另有 ${others} 項提醒）` : decisive.reason,
  };
}

/**
 * 深夜時段。`[22, 7]` 是跨午夜的，所以不能只寫 `start <= h && h < end`。
 *
 * 時區固定台北：伺服器可能跑在 UTC，而「深夜」是阿嬤那邊的深夜。
 */
export function inQuietHours(now: Date, quietHours?: [number, number]): boolean {
  if (!quietHours) return false;
  const [start, end] = quietHours;
  if (start === end) return false;
  const h = taipeiHour(now);
  return start < end ? h >= start && h < end : h >= start || h < end;
}

export function taipeiHour(now: Date = new Date()): number {
  return Number(
    now.toLocaleString('en-US', { timeZone: 'Asia/Taipei', hour: '2-digit', hour12: false }),
  );
}

function fmt(n: number): string {
  return n.toLocaleString('zh-TW');
}
