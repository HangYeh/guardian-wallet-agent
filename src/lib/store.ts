import type { AuditEvent, Payment, PaymentIntent, Policy, TraceStep } from '@/lib/types';
import { clearAuditFile } from '@/lib/audit';
import { resetBus } from '@/lib/bus';
import { loadDemo, reloadDemo } from '@/lib/demo';

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
};

function empty(): RuntimeState {
  return { intents: [], payments: [], audit: [], trace: [], startedAt: new Date().toISOString() };
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

/** 把某個收款人加進白名單或移出去。 */
export function setAllowlisted(payeeId: string, allowed: boolean): { allowlist: string[] } {
  const current = effectivePolicy().allowlist;
  const next = allowed
    ? current.includes(payeeId)
      ? current
      : [...current, payeeId]
    : current.filter((id) => id !== payeeId);
  updatePolicy({ allowlist: next });
  return { allowlist: next };
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
