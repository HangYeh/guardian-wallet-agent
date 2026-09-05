import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { checkGuardian, sameOriginOrToken, sameSiteOnly } from '@/lib/guardian-auth';
import { LIMITS, checkRate, rateGuard, resetRateLimits } from '@/lib/rate-limit';

/**
 * 對外的兩道守衛：誰能呼叫，以及能呼叫多少次。
 *
 * 這一組測試在意的是**預設值**。安全機制最常見的失效方式不是被繞過，
 * 是「忘了設定，而預設是放行」。所以每一條都問同一個問題：
 * 什麼都沒設的時候，它是開的還是關的？
 */

const ORIGINAL = process.env.GUARDIAN_TOKEN;
const TOKEN = 'a'.repeat(32);

function req(headers: Record<string, string> = {}): Request {
  return new Request('http://localhost:3000/api/guardian', { headers });
}

beforeEach(() => {
  process.env.GUARDIAN_TOKEN = TOKEN;
  resetRateLimits();
});

afterEach(() => {
  if (ORIGINAL === undefined) delete process.env.GUARDIAN_TOKEN;
  else process.env.GUARDIAN_TOKEN = ORIGINAL;
  delete process.env.TRUST_PROXY;
});

describe('跨站守衛（CSRF）', () => {
  it('瀏覽器從別的網站發過來 → 403', () => {
    const r = sameSiteOnly(req({ 'sec-fetch-site': 'cross-site', host: 'localhost:3000' }));
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error('unreachable');
    expect(r.status).toBe(403);
  });

  it('Origin 對不上 Host → 擋；壞掉的 Origin（例如 "null"）也擋', () => {
    expect(sameSiteOnly(req({ origin: 'http://evil.example', host: 'localhost:3000' })).ok).toBe(false);
    expect(sameSiteOnly(req({ origin: 'null', host: 'localhost:3000' })).ok).toBe(false);
  });

  it('同源、直接在網址列打開、curl 都放行 —— 擋的是跳板，不是腳本', () => {
    expect(
      sameSiteOnly(req({ 'sec-fetch-site': 'same-origin', origin: 'http://localhost:3000', host: 'localhost:3000' })).ok,
    ).toBe(true);
    expect(sameSiteOnly(req({ 'sec-fetch-site': 'none', host: 'localhost:3000' })).ok).toBe(true);
    expect(sameSiteOnly(req()).ok).toBe(true);
  });
});

describe('守護者 token', () => {
  it('沒設 token → 一律拒絕，不是一律放行', () => {
    delete process.env.GUARDIAN_TOKEN;
    const r = checkGuardian(req({ 'x-guardian-token': TOKEN }));
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error('unreachable');
    expect(r.status).toBe(503);
    expect(r.error).toContain('不設定不等於不設防');
  });

  it('空字串的 token 也算沒設', () => {
    process.env.GUARDIAN_TOKEN = '   ';
    const r = checkGuardian(req({ 'x-guardian-token': '   ' }));
    expect(r.ok).toBe(false);
  });

  it('沒帶、帶錯、長度不同 → 都是 401', () => {
    expect(checkGuardian(req()).ok).toBe(false);
    expect(checkGuardian(req({ 'x-guardian-token': 'b'.repeat(32) })).ok).toBe(false);
    // 長度不同不能提早回傳，否則長度本身就是免費的訊號
    expect(checkGuardian(req({ 'x-guardian-token': 'a' })).ok).toBe(false);
  });

  it('帶對了就過，Bearer 也認', () => {
    expect(checkGuardian(req({ 'x-guardian-token': TOKEN }).clone()).ok).toBe(true);
    expect(checkGuardian(req({ authorization: `Bearer ${TOKEN}` })).ok).toBe(true);
  });
});

describe('同源或帶 token', () => {
  it('同源的請求放行', () => {
    const r = sameOriginOrToken(
      req({ origin: 'http://localhost:3000', host: 'localhost:3000' }),
    );
    expect(r.ok).toBe(true);
  });

  it('別的站送過來的擋掉', () => {
    const r = sameOriginOrToken(req({ origin: 'http://evil.example', host: 'localhost:3000' }));
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error('unreachable');
    expect(r.status).toBe(403);
  });

  it('沒有 Origin 的裸請求（curl）擋掉', () => {
    expect(sameOriginOrToken(req({ host: 'localhost:3000' })).ok).toBe(false);
  });

  it('沒有 Origin 但帶對 token 的放行 —— 腳本走這條', () => {
    expect(sameOriginOrToken(req({ host: 'localhost:3000', 'x-guardian-token': TOKEN })).ok).toBe(
      true,
    );
  });

  it('Origin 是壞掉的字串不會炸，當作沒帶', () => {
    expect(sameOriginOrToken(req({ origin: 'not a url', host: 'localhost:3000' })).ok).toBe(false);
  });
});

describe('限流', () => {
  it('在額度內一路放行，超過就擋', () => {
    const { max } = LIMITS.intake;
    for (let i = 0; i < max; i++) {
      expect(checkRate(req(), 'intake').ok, `第 ${i + 1} 次`).toBe(true);
    }
    const over = checkRate(req(), 'intake');
    expect(over.ok).toBe(false);
    if (over.ok) throw new Error('unreachable');
    expect(over.retryAfterSec).toBeGreaterThan(0);
  });

  it('每一支端點各算各的 —— 打爆 intake 不該讓核准也停擺', () => {
    for (let i = 0; i < LIMITS.intake.max + 5; i++) checkRate(req(), 'intake');
    expect(checkRate(req(), 'intake').ok).toBe(false);
    expect(checkRate(req(), 'guardian').ok).toBe(true);
  });

  it('沒設 TRUST_PROXY 時 x-forwarded-for 不算數 —— 那是呼叫端自己填的', () => {
    const a = () => req({ 'x-forwarded-for': '10.0.0.1' });
    const b = () => req({ 'x-forwarded-for': '10.0.0.2' });
    for (let i = 0; i < LIMITS.intake.max; i++) checkRate(a(), 'intake');
    expect(checkRate(a(), 'intake').ok).toBe(false);
    // 換個假 IP 也不會拿到新的一桶
    expect(checkRate(b(), 'intake').ok).toBe(false);
  });

  it('站在代理後面（TRUST_PROXY=true）時不同來源 IP 各算各的', () => {
    process.env.TRUST_PROXY = 'true';
    const a = () => req({ 'x-forwarded-for': '10.0.0.1' });
    const b = () => req({ 'x-forwarded-for': '10.0.0.2' });
    for (let i = 0; i < LIMITS.intake.max; i++) checkRate(a(), 'intake');
    expect(checkRate(a(), 'intake').ok).toBe(false);
    expect(checkRate(b(), 'intake').ok).toBe(true);
  });

  it('視窗過了就重新開始', () => {
    for (let i = 0; i < LIMITS.reset.max; i++) checkRate(req(), 'reset');
    expect(checkRate(req(), 'reset').ok).toBe(false);

    // 直接把視窗推到過去，模擬時間流逝
    const g = globalThis as { __guardianRate?: Map<string, { count: number; resetAt: number }> };
    for (const b of g.__guardianRate!.values()) b.resetAt = Date.now() - 1;

    expect(checkRate(req(), 'reset').ok).toBe(true);
  });

  it('超額回 429 而且帶 Retry-After', async () => {
    for (let i = 0; i < LIMITS.redteam.max; i++) checkRate(req(), 'redteam');
    const res = rateGuard(req(), 'redteam');
    expect(res).toBeDefined();
    expect(res!.status).toBe(429);
    expect(res!.headers.get('retry-after')).toMatch(/^\d+$/);
    expect((await res!.json()).error).toContain('呼叫太頻繁');
  });

  it('計數器的鍵數有上限，不會無限長大', () => {
    process.env.TRUST_PROXY = 'true';
    for (let i = 0; i < 800; i++) checkRate(req({ 'x-forwarded-for': `10.1.${i >> 8}.${i & 255}` }), 'intake');
    const g = globalThis as { __guardianRate?: Map<string, unknown> };
    expect(g.__guardianRate!.size).toBeLessThanOrEqual(500);
  });
});
