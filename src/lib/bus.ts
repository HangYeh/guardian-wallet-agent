import type { TracePhase } from '@/lib/types';

/**
 * 行程內的事件匯流排。
 *
 * 門神不是聊天機器人，是一條管線：一個輸入進來，observe → plan → tool → verify
 * 依序跑完。這個匯流排的用途只有一個 —— 讓那條管線在跑的時候就看得見，
 * 而不是跑完才一次吐出結果。評審看到的是它「正在想」，不是「想完了」。
 *
 * 刻意不用 Redis 或任何外部佇列：舞台上不能有第二個要顧的服務，
 * 評審 clone 下來也不必準備任何東西。代價是多開的 Next 行程各有各的匯流排，
 * 但 demo 只有一個行程，這個代價不存在。
 */

export type BusEventKind = 'run.start' | 'step' | 'run.end' | 'run.error' | 'reset';

export type BusEvent = {
  seq: number;
  ts: string;
  runId: string;
  kind: BusEventKind;
  phase?: TracePhase;
  tool?: string;
  detail: string;
  /** 這一步距離該次 run 開始過了幾毫秒。畫面用它顯示「模型讀了 4.4 秒」。 */
  elapsedMs?: number;
};

/**
 * 環形緩衝的長度。晚一步打開軌跡頁的人要看得到剛剛發生的事，
 * 但不能讓它無上限長大 —— 一個沒人看的伺服器跑一整天也不該吃掉記憶體。
 */
const MAX_BUFFER = 200;

/**
 * 同時訂閱數上限。每個訂閱都佔著一條沒有結束時間的 HTTP 連線，
 * 沒有上限的話，開幾百個分頁就能把行程拖垮。現場只會有一到兩個分頁在看。
 */
export const MAX_SUBSCRIBERS = 8;

/** 單一則事件的字數上限。detail 有一部分來自使用者輸入，該截就截。 */
const MAX_DETAIL = 500;

type Listener = (e: BusEvent) => void;

type Bus = {
  seq: number;
  runSeq: number;
  buffer: BusEvent[];
  subs: Set<Listener>;
};

// dev 的熱更新會重新載入模組，掛在 globalThis 上狀態才不會每次改檔就斷。
const g = globalThis as typeof globalThis & { __guardianBus?: Bus };
g.__guardianBus ??= { seq: 0, runSeq: 0, buffer: [], subs: new Set() };

function bus(): Bus {
  return g.__guardianBus!;
}

/**
 * detail 可能夾帶模型從帳單上讀到的字，而帳單上的字是攻擊者可以控制的。
 * SSE 的框架是以行為單位的，所以送出前要確定它不可能自己造出一行 `data:`。
 * 實際送出時走 JSON.stringify（會把換行轉義掉），這裡再把控制字元清一次，
 * 兩道都做是因為框架被撐開的代價太大 —— 那等於讓帳單上的文字偽造事件。
 */
function clean(detail: string): string {
  const flat = detail.replace(/[\r\n\u2028\u2029]+/g, ' ').replace(/[\u0000-\u001f\u007f]/g, '');
  return flat.length > MAX_DETAIL ? `${flat.slice(0, MAX_DETAIL)}…` : flat;
}

export function publish(e: Omit<BusEvent, 'seq' | 'ts'>): BusEvent {
  const b = bus();
  const full: BusEvent = { ...e, detail: clean(e.detail), seq: ++b.seq, ts: new Date().toISOString() };

  b.buffer.push(full);
  if (b.buffer.length > MAX_BUFFER) b.buffer.splice(0, b.buffer.length - MAX_BUFFER);

  // 一個壞掉的訂閱者不該讓管線停下來：付款流程比看畫面重要。
  for (const fn of b.subs) {
    try {
      fn(full);
    } catch {
      b.subs.delete(fn);
    }
  }
  return full;
}

/** 訂閱。回傳退訂函式；超過上限回傳 null，呼叫端要把它變成 503。 */
export function subscribe(fn: Listener): (() => void) | null {
  const b = bus();
  if (b.subs.size >= MAX_SUBSCRIBERS) return null;
  b.subs.add(fn);
  return () => {
    b.subs.delete(fn);
  };
}

/** 補送：新連上來或斷線重連的人，先把錯過的補齊再接直播。 */
export function backlog(sinceSeq = 0): BusEvent[] {
  return bus().buffer.filter((e) => e.seq > sinceSeq);
}

export function busStats() {
  const b = bus();
  return { seq: b.seq, buffered: b.buffer.length, subscribers: b.subs.size, maxSubscribers: MAX_SUBSCRIBERS };
}

/** 一鍵重置時清掉歷史，但不踢掉訂閱者 —— 舞台上分頁是開著的，畫面自己清空就好。 */
export function resetBus(): void {
  const b = bus();
  b.buffer = [];
  publish({ runId: 'system', kind: 'reset', detail: '劇本已重置，軌跡清空' });
}

/**
 * 給一次 run 用的短代號。
 *
 * 時間戳 + 亂數是不夠的：同一毫秒進來的兩個輸入只剩三個亂數字元可分辨，
 * 36^3 的空間跑兩百次就撞得到（第一版的測試就撞了）。撞到的後果是兩次 run
 * 的步驟混進畫面上同一張卡，看起來像門神把兩張帳單當成一張。
 * 所以改成行程內遞增的序號 —— 在同一個行程裡永遠不會重複。
 */
export function newRunId(): string {
  const b = bus();
  b.runSeq = (b.runSeq + 1) % 46656; // 36^3
  return `run_${Date.now().toString(36).slice(-4)}${b.runSeq.toString(36).padStart(3, '0')}`;
}
