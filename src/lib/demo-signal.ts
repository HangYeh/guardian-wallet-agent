/**
 * 同一台電腦上，分頁之間的小喇叭。
 *
 * 一鍵重置是伺服器的事，但舞台上的螢幕是瀏覽器的事：狀態清空了、
 * 阿嬤頁上一幕的判決還掛在畫面上，台下看起來就是「重置沒用」。
 * 伺服器的事件串流（/api/events）也能通知，但每條連線佔一個名額（上限 8），
 * 而這件事只需要同一台機器上的分頁互相講一聲 —— BroadcastChannel 剛好就是這個。
 *
 * 誠實的限制：跨裝置不通。手機上的守護者頁按重置，投影機那台的阿嬤頁不會清。
 * 舞台流程是在同一台筆電上按的，所以夠用；真要跨裝置就走事件串流。
 */

export type DemoSignal = { type: 'reset'; at: string };

const CHANNEL = 'guardian-demo';

function open(): BroadcastChannel | null {
  if (typeof window === 'undefined' || typeof BroadcastChannel === 'undefined') return null;
  try {
    return new BroadcastChannel(CHANNEL);
  } catch {
    return null;
  }
}

export function postDemoSignal(signal: DemoSignal): void {
  const bc = open();
  if (!bc) return;
  try {
    bc.postMessage(signal);
  } finally {
    bc.close();
  }
}

/**
 * 訂閱，回傳退訂函式。
 *
 * BroadcastChannel 不會把訊息送回**發出的那一個 channel 物件**，但同一個分頁裡
 * 另外開的 channel 收得到 —— 所以 demo bar 用一個丟、操作台用另一個聽，同頁也通。
 */
export function onDemoSignal(fn: (s: DemoSignal) => void): () => void {
  const bc = open();
  if (!bc) return () => {};
  bc.onmessage = (e: MessageEvent<unknown>) => {
    const d = e.data as Partial<DemoSignal> | null;
    if (d && typeof d === 'object' && d.type === 'reset') fn(d as DemoSignal);
  };
  return () => bc.close();
}
