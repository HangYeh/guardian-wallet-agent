import { NextResponse } from 'next/server';
import { approvePayment, rejectPayment } from '@/lib/execute';
import { checkGuardian } from '@/lib/guardian-auth';
import { rateGuard } from '@/lib/rate-limit';
import { effectivePolicy, state } from '@/lib/store';
import { guardianFor } from '@/lib/wallet';

export const dynamic = 'force-dynamic';

/**
 * GET  /api/guardian  → 待核准清單（也要帶 token：等待中的付款會露出金額與收款人）
 * POST /api/guardian  → { paymentId, action: "approve" | "reject" }
 *
 * 這是整個系統唯一能把 `hold` 變成 `executed` 的入口，所以它是最該被守住的一支。
 * 核准跳過的只有「核准門檻」那一道，其餘五道照舊 —— 家人能做的是同意這個金額，
 * 不是解除所有限制。
 */

type Body = { paymentId?: string; action?: 'approve' | 'reject' };

export async function GET(request: Request) {
  const limited = rateGuard(request, 'guardian');
  if (limited) return limited;

  const guard = checkGuardian(request);
  if (!guard.ok) {
    return NextResponse.json({ ok: false, error: guard.error }, { status: guard.status });
  }

  const pending = state().payments.filter((p) => p.status === 'pending_approval');
  return NextResponse.json({ ok: true, pending });
}

export async function POST(request: Request) {
  // 限流放在驗證之前：猜 token 的人不該有無限次機會。
  const limited = rateGuard(request, 'guardian');
  if (limited) return limited;

  const guard = checkGuardian(request);
  if (!guard.ok) {
    return NextResponse.json({ ok: false, error: guard.error }, { status: guard.status });
  }

  let body: Body;
  try {
    body = (await request.json()) as Body;
  } catch {
    return NextResponse.json({ ok: false, error: 'body 不是合法的 JSON' }, { status: 400 });
  }

  if (!body.paymentId || (body.action !== 'approve' && body.action !== 'reject')) {
    return NextResponse.json(
      { ok: false, error: '要給 paymentId 與 action（approve 或 reject）' },
      { status: 400 },
    );
  }

  try {
    if (body.action === 'reject') {
      const { payment, events } = await rejectPayment(body.paymentId, {
        guardian: guardianFor(effectivePolicy()),
      });
      return NextResponse.json({ ok: true, payment, events });
    }

    const payment = state().payments.find((p) => p.id === body.paymentId);
    const intent = payment && state().intents.find((i) => i.id === payment.intentId);
    if (!payment || !intent) {
      return NextResponse.json({ ok: false, error: '找不到對應的付款或意圖' }, { status: 404 });
    }

    const policy = effectivePolicy();
    const result = await approvePayment(body.paymentId, {
      policy,
      guardian: guardianFor(policy),
      intent,
    });
    return NextResponse.json({ ok: true, payment: result.payment, events: result.events });
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : String(err) },
      { status: 400 },
    );
  }
}
