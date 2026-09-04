import type { AuditEvent, Payment, PaymentIntent, TraceStep } from '@/lib/types';
import { resetBus } from '@/lib/bus';
import { reloadDemo } from '@/lib/demo';

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

/** 一鍵重置：清掉執行期狀態並重讀劇本。舞台每一幕之間都會按。 */
export function resetAll(): { state: RuntimeState; scenarios: string[] } {
  g.__guardianState = empty();
  resetBus();
  const demo = reloadDemo();
  return { state: g.__guardianState, scenarios: demo.scenarios.map((s) => s.id) };
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
