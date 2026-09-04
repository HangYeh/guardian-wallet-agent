import { NextResponse } from 'next/server';
import { resetAll } from '@/lib/store';

export const dynamic = 'force-dynamic';

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

// GET 方便用 curl 驗，POST 給 UI 的重置按鈕。
export const GET = run;
export const POST = run;
