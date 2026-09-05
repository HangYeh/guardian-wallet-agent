import { NextResponse } from 'next/server';

/**
 * 固定視窗的呼叫次數限制。
 *
 * 這不是為了擋 DDoS —— 一個 demo 站不會被 DDoS。它擋的是兩件真的會發生的事：
 *
 * 1. **自己寫錯的迴圈。** 前端一個沒收乾淨的 retry 可以在幾分鐘內把
 *    OpenAI 的額度燒光，而那是作者自己的信用卡。
 * 2. **同一個網路上的好奇心。** 比賽場館 261 隊在同一段網路上，
 *    `/api/intake` 每被打一次就是一次真的模型呼叫。
 *
 * 拿不到真實 IP 時（沒有反向代理的情況下就是拿不到），這會退化成
 * 全站共用一個計數器。那仍然擋得住上面兩件事 —— 而擋得住那兩件事就夠了。
 * 誠實寫在這裡，免得有人以為它是 per-user 的配額。
 */

type Bucket = { count: number; resetAt: number };

const g = globalThis as typeof globalThis & { __guardianRate?: Map<string, Bucket> };
g.__guardianRate ??= new Map();

/** 計數器最多留幾把鍵。沒有上限的話它就是另一個記憶體洩漏。 */
const MAX_KEYS = 500;

export type Limit = { max: number; windowMs: number };

/** 每一支端點的額度。數字的依據寫在旁邊，改的時候要知道自己在放寬什麼。 */
export const LIMITS = {
  /** 每一發都是一次真的模型呼叫，花的是作者的錢。 */
  intake: { max: 20, windowMs: 60_000 },
  /** 破壞性動作：按下去舞台上的劇本就沒了。 */
  reset: { max: 10, windowMs: 60_000 },
  /** 會用 operator 金鑰送出真的交易。 */
  redteam: { max: 10, windowMs: 60_000 },
  /** 讀寫待核准清單，已經有 token 守著，這裡只防迴圈。 */
  guardian: { max: 60, windowMs: 60_000 },
  /** 連線數本身有上限（MAX_SUBSCRIBERS），這裡防的是反覆連斷。 */
  events: { max: 60, windowMs: 60_000 },
  /** 沒錄過的句子會真的去跟 ElevenLabs 要，花的是額度；一分鐘三十句夠舞台用，不夠燒。 */
  tts: { max: 30, windowMs: 60_000 },
} satisfies Record<string, Limit>;

function clientKey(request: Request): string {
  // x-forwarded-for 是呼叫端自己填的。沒有反向代理幫忙覆寫時，信它等於讓每個人
  // 自己決定要算在哪一桶 —— 每次換一個假 IP 就繞過整個限流。所以預設不信，
  // 只有真的站在代理後面（TRUST_PROXY=true）才拿它分流。
  if (process.env.TRUST_PROXY !== 'true') return 'no-proxy';

  const fwd = request.headers.get('x-forwarded-for');
  if (fwd) return fwd.split(',')[0]!.trim();
  const real = request.headers.get('x-real-ip');
  if (real) return real.trim();
  // 代理沒帶 IP。退化成全站計數，這是刻意的，不是漏寫。
  return 'no-proxy';
}

export type RateResult = { ok: true; remaining: number } | { ok: false; retryAfterSec: number };

export function checkRate(request: Request, name: keyof typeof LIMITS): RateResult {
  const limit = LIMITS[name];
  const key = `${name}:${clientKey(request)}`;
  const now = Date.now();
  const m = g.__guardianRate!;

  const bucket = m.get(key);
  if (!bucket || bucket.resetAt <= now) {
    if (m.size >= MAX_KEYS) {
      // 過期的先掃掉；還是滿的話就丟最舊的一把。
      for (const [k, b] of m) if (b.resetAt <= now) m.delete(k);
      if (m.size >= MAX_KEYS) m.delete(m.keys().next().value!);
    }
    m.set(key, { count: 1, resetAt: now + limit.windowMs });
    return { ok: true, remaining: limit.max - 1 };
  }

  if (bucket.count >= limit.max) {
    return { ok: false, retryAfterSec: Math.ceil((bucket.resetAt - now) / 1000) };
  }

  bucket.count += 1;
  return { ok: true, remaining: limit.max - bucket.count };
}

/** 超過額度時的標準回覆。回 429 而不是靜靜丟掉，呼叫端才知道是被限流不是壞掉。 */
export function tooManyRequests(name: keyof typeof LIMITS, retryAfterSec: number): NextResponse {
  return NextResponse.json(
    {
      ok: false,
      error: `呼叫太頻繁（${name} 每分鐘上限 ${LIMITS[name].max} 次），${retryAfterSec} 秒後再試`,
    },
    { status: 429, headers: { 'retry-after': String(retryAfterSec) } },
  );
}

/** 一行就能用的守衛：回傳 Response 就直接 return 它，回傳 undefined 就繼續。 */
export function rateGuard(request: Request, name: keyof typeof LIMITS): NextResponse | undefined {
  const r = checkRate(request, name);
  return r.ok ? undefined : tooManyRequests(name, r.retryAfterSec);
}

export function resetRateLimits(): void {
  g.__guardianRate = new Map();
}
