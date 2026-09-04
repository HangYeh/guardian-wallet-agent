import { NextResponse } from 'next/server';
import { sameOriginOrToken } from '@/lib/guardian-auth';
import { rateGuard } from '@/lib/rate-limit';
import { resetAll } from '@/lib/store';

export const dynamic = 'force-dynamic';

/**
 * 一鍵重置。破壞性動作 —— 按下去舞台上的劇本就沒了 ——
 * 所以要嘛是我們自己頁面上的按鈕，要嘛帶 token。
 */
function guard(request: Request): NextResponse | undefined {
  const limited = rateGuard(request, 'reset');
  if (limited) return limited;

  const allowed = sameOriginOrToken(request);
  if (!allowed.ok) {
    return NextResponse.json({ ok: false, error: allowed.error }, { status: allowed.status });
  }
  return undefined;
}

function run() {
  const { scenarios } = resetAll();
  return NextResponse.json({
    ok: true,
    resetAt: new Date().toISOString(),
    chainMode: process.env.CHAIN_MODE ?? 'mock',
    demoMode: process.env.DEMO_MODE ?? 'live',
    scenarios,
  });
}

// GET 方便用 curl 驗（要帶 token），POST 給 UI 的重置按鈕（同源即可）。
export async function GET(request: Request) {
  return guard(request) ?? run();
}

export async function POST(request: Request) {
  return guard(request) ?? run();
}
