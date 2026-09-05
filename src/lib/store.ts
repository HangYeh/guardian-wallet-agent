import type { AuditEvent, Payee, Payment, PaymentIntent, Policy, TraceStep } from '@/lib/types';
import { clearAuditFile } from '@/lib/audit';
import { resetBus } from '@/lib/bus';
import { loadDemo, reloadDemo } from '@/lib/demo';
import { clearParseCache } from '@/lib/parser';

/**
 * 執行期狀態。M0.3 只放骨架與重置，實際寫入從 M2.4 開始。
 *
 * 刻意用行程內記憶體而不是資料庫：舞台 demo 要能在一秒內回到乾淨狀態，
 * 而且評審 clone 下來不必準備任何外部服務。
 */
export type RuntimeState = {
  intents: PaymentIntent[];
  payments: Payment[];
  audit: AuditEvent[];
  trace: TraceStep[];
  startedAt: string;
  /**
   * 守護者在執行期改過的政策。空的就照劇本檔。
   *
   * 分開存而不是直接改 `demo` 物件，是因為一鍵重置要能把政策也還原 ——
   * 舞台上第二次演出不該繼承第一次調過的上限。
   */
  policyOverride?: Partial<Policy>;
  /**
   * 守護者在執行期把誰加進白名單、什麼時候（ISO）。
   *
   * 新收款人冷卻期靠這個算：剛加進去的人 24 小時內付款仍要核准。
   * 劇本檔原本就在白名單上的（台電那些）沒有時間戳 —— 它們是「一直都在」，不是「剛加的」。
   */
  allowlistedAt?: Record<string, string>;
};

function empty(): RuntimeState {
  return {
    intents: [],
    payments: [],
    audit: [],
    trace: [],
    startedAt: new Date().toISOString(),
    allowlistedAt: {},
  };
}

// dev 模式的熱更新會重新載入模組，掛在 globalThis 上才不會每次改檔就掉狀態。
const g = globalThis as typeof globalThis & { __guardianState?: RuntimeState };
g.__guardianState ??= empty();

export function state(): RuntimeState {
  return g.__guardianState!;
}

// 劇本檔的原始政策。單獨拉出來是為了避免 effectivePolicy 直接依賴整個 demo 物件。
function reloadDemoPolicy(): Policy {
  return loadDemo().policy;
}

/** 一鍵重置：清掉執行期狀態並重讀劇本。舞台每一幕之間都會按。 */
export function resetAll(): { state: RuntimeState; scenarios: string[] } {
  g.__guardianState = empty();
  resetBus();
  clearAuditFile();
  // mock 錢包的餘額、日累計、已用過的冪等鍵也要一起回到起點，
  // 否則舞台上第二次演幕一會被自己的防重放擋下來。
  (globalThis as { __guardianWallet?: unknown }).__guardianWallet = undefined;
  // 模型的解析快取也清掉。留著的話，重置後再演幕一，軌跡上寫的是「直接用快取結果」——
  // 台下看起來像門神沒有真的讀那張帳單。重置就是回到起點，包括這個。
  clearParseCache();
  const demo = reloadDemo();
  return { state: g.__guardianState, scenarios: demo.scenarios.map((s) => s.id) };
}

/**
 * 現在真正生效的政策。
 *
 * **所有讀政策的地方都要走這裡**，不要直接讀 `loadDemo().policy` ——
 * 否則守護者改了上限，畫面顯示新的、判斷卻用舊的，而那種不一致
 * 在舞台上看起來就是「改了沒用」。
 */
export function effectivePolicy(): Policy {
  const base = reloadDemoPolicy();
  const over = state().policyOverride;
  return over ? { ...base, ...over } : base;
}

/** 守護者改政策。回傳新舊值，呼叫端負責寫稽核事件。 */
export function updatePolicy(patch: Partial<Policy>): { before: Policy; after: Policy } {
  const before = effectivePolicy();
  const s = state();
  s.policyOverride = { ...(s.policyOverride ?? {}), ...patch };
  return { before, after: effectivePolicy() };
}

/**
 * 把某個收款人加進白名單或移出去。
 *
 * 加進去的那一刻會記時間，冷卻期從那時起算。移出去再加回來會**重新起算** ——
 * 不然「先踢掉再加回」就能跳過冷卻，那條規則等於白設。已經在名單上的重複加是 no-op，
 * 不會把時間往後推。
 */
export function setAllowlisted(
  payeeId: string,
  allowed: boolean,
  now: Date = new Date(),
): { allowlist: string[]; addedAt?: string } {
  const current = effectivePolicy().allowlist;
  const s = state();
  // dev 熱更新可能留著舊形狀的狀態物件，沒有這個欄位就補上。
  const stamps = (s.allowlistedAt ??= {});

  if (allowed) {
    if (!current.includes(payeeId)) {
      stamps[payeeId] = now.toISOString();
      updatePolicy({ allowlist: [...current, payeeId] });
    }
    return { allowlist: effectivePolicy().allowlist, addedAt: stamps[payeeId] };
  }

  delete stamps[payeeId];
  updatePolicy({ allowlist: current.filter((id) => id !== payeeId) });
  return { allowlist: effectivePolicy().allowlist };
}

/** 守護者在執行期加進白名單的收款人，回傳加入時間（ISO）；劇本檔原本就有的回 undefined。 */
export function allowlistedAt(payeeId: string): string | undefined {
  return state().allowlistedAt?.[payeeId];
}

/**
 * 收款人清單，白名單旗標照**現在生效的**政策。
 *
 * 劇本檔裡每個收款人都寫死一個 `allowlisted`，而政策引擎、風險規則、mock 錢包
 * 讀的都是那個旗標；守護者按「加進白名單」改的卻是 `policy.allowlist`。
 * 9/5 之前這兩份沒接起來 —— 按鈕只會讓畫面上的標籤變色，判斷照舊，
 * 跟 `effectivePolicy()` 上面那段警告講的是同一種病。
 *
 * 所有要拿收款人去做判斷的地方都走這裡，不要直接讀 `loadDemo().payees`。
 */
export function payeesInEffect(): Payee[] {
  const allow = new Set(effectivePolicy().allowlist);
  return loadDemo().payees.map((p) => ({ ...p, allowlisted: allow.has(p.id) }));
}

export function counts() {
  const s = state();
  return {
    intents: s.intents.length,
    payments: s.payments.length,
    audit: s.audit.length,
    trace: s.trace.length,
  };
}
