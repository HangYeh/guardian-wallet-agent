import { backlog, busStats, subscribe, type BusEvent } from '@/lib/bus';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * GET /api/events —— 伺服器推送事件（SSE）。
 *
 * 軌跡頁靠這一條看門神即時在做什麼。只讀，不改任何狀態。
 *
 * 斷線重連由瀏覽器自己處理：EventSource 會把最後收到的 `id` 放在
 * `Last-Event-ID` 標頭送回來，我們據此補齊中間漏掉的事件，
 * 所以現場網路抖一下不會讓畫面少一段。
 */

/** 心跳間隔。中間若有反向代理，太久沒有位元組流過就會被當成死連線收掉。 */
const HEARTBEAT_MS = 15_000;

export async function GET(request: Request) {
  const url = new URL(request.url);
  const header = request.headers.get('last-event-id');
  const since = Number(header ?? url.searchParams.get('since') ?? '0');
  const sinceSeq = Number.isFinite(since) && since > 0 ? since : 0;

  const encoder = new TextEncoder();
  let unsubscribe: (() => void) | null = null;
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  let closed = false;

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const write = (chunk: string) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(chunk));
        } catch {
          // 對面已經走了，controller 關掉了。收乾淨就好，不是錯誤。
          cleanup();
        }
      };

      const frame = (e: BusEvent) =>
        // JSON.stringify 會把換行轉義掉，所以 detail 不可能自己撐開一行 data:。
        `id: ${e.seq}\nevent: ${e.kind}\ndata: ${JSON.stringify(e)}\n\n`;

      const cleanup = () => {
        if (closed) return;
        closed = true;
        if (heartbeat) clearInterval(heartbeat);
        unsubscribe?.();
        unsubscribe = null;
        try {
          controller.close();
        } catch {
          // 已經關了
        }
      };

      unsubscribe = subscribe((e) => write(frame(e)));

      if (!unsubscribe) {
        // 訂閱滿了。與其悄悄丟掉事件，不如讓畫面明白顯示連不上。
        write(
          `event: rejected\ndata: ${JSON.stringify({
            detail: `同時最多 ${busStats().maxSubscribers} 個連線，現在滿了；關掉多餘的分頁再試`,
          })}\n\n`,
        );
        closed = true;
        try {
          controller.close();
        } catch {
          // 已經關了
        }
        return;
      }

      // 瀏覽器預設 3 秒重連，這裡放寬一點，免得連線滿的時候變成連續重試。
      write('retry: 3000\n\n');
      for (const e of backlog(sinceSeq)) write(frame(e));
      write(`: connected seq=${busStats().seq}\n\n`);

      heartbeat = setInterval(() => write(': ping\n\n'), HEARTBEAT_MS);
      request.signal.addEventListener('abort', cleanup);
    },

    cancel() {
      closed = true;
      if (heartbeat) clearInterval(heartbeat);
      unsubscribe?.();
      unsubscribe = null;
    },
  });

  return new Response(stream, {
    headers: {
      'content-type': 'text/event-stream; charset=utf-8',
      // 這條串流永遠不該被快取或被中途緩衝起來 —— 緩衝了就沒有「逐步出現」可言。
      'cache-control': 'no-store, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    },
  });
}
