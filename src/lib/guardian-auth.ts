import { timingSafeEqual } from 'node:crypto';

/**
 * 守護者 API 的門。
 *
 * 兩個決定值得寫下來：
 *
 * 1. **沒設 token 就一律拒絕**，不是一律放行。
 *    「忘了設定」是最常見的部署失誤，而它的預設行為若是放行，
 *    那道門等於不存在。fail closed 在這裡就是 fail closed。
 *
 * 2. **定時比對**（`timingSafeEqual`）。逐字元比對會因為比對長度不同
 *    而洩漏前綴是否正確，理論上可以一個字元一個字元試出來。
 *    比對成本是奈秒級的，沒有理由省。
 */

export type GuardCheck = { ok: true } | { ok: false; status: number; error: string };

export function guardianTokenConfigured(): boolean {
  return Boolean(process.env.GUARDIAN_TOKEN?.trim());
}

export function checkGuardian(request: Request): GuardCheck {
  const expected = process.env.GUARDIAN_TOKEN?.trim();

  if (!expected) {
    return {
      ok: false,
      status: 503,
      error: '伺服器沒有設定 GUARDIAN_TOKEN，守護者 API 一律拒絕（不設定不等於不設防）',
    };
  }

  const presented = readToken(request);
  if (!presented) {
    return { ok: false, status: 401, error: '要帶 x-guardian-token 標頭' };
  }
  if (!sameSecret(presented, expected)) {
    return { ok: false, status: 401, error: 'token 不對' };
  }
  return { ok: true };
}

/**
 * 破壞性但要給畫面按的動作（一鍵重置）用的守衛。
 *
 * 兩條路任一條通過就放行：
 *   1. **同源**：瀏覽器從我們自己的頁面按下去，會帶 Origin 而且對得上 Host
 *   2. **帶 token**：操作者的腳本與現場的自動化走這條
 *
 * 擋掉的是第三種：同一個場館網路上的人直接 curl 過來。他沒有 Origin，
 * 也沒有 token。這擋不住存心的人（Origin 是可以偽造的），但擋得住
 * 掃描器與手滑 —— 而「demo 演到一半劇本被重置」多半是後者造成的。
 *
 * token 不能塞進頁面 HTML 讓前端帶：任何能開那一頁的人就都拿到 token 了，
 * 那等於沒有 token。所以這裡走同源，不走「前端帶 token」。
 */
export function sameOriginOrToken(request: Request): GuardCheck {
  const withToken = checkGuardian(request);
  if (withToken.ok) return withToken;

  const origin = request.headers.get('origin');
  const host = request.headers.get('host');
  if (origin && host) {
    try {
      if (new URL(origin).host === host) return { ok: true };
    } catch {
      // origin 不是合法 URL，當作沒帶
    }
  }

  return {
    ok: false,
    status: 403,
    error: '這個動作只接受本站頁面按下的請求，或帶 x-guardian-token 的呼叫',
  };
}

function readToken(request: Request): string | undefined {
  const header = request.headers.get('x-guardian-token');
  if (header?.trim()) return header.trim();

  const auth = request.headers.get('authorization');
  if (auth?.startsWith('Bearer ')) return auth.slice(7).trim();

  return undefined;
}

/**
 * 長度不同時仍然跑一次比對再回 false —— 直接 return 會讓「長度對不對」
 * 變成一個免費的訊號。
 */
function sameSecret(a: string, b: string): boolean {
  const ab = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  if (ab.length !== bb.length) {
    timingSafeEqual(bb, bb);
    return false;
  }
  return timingSafeEqual(ab, bb);
}
