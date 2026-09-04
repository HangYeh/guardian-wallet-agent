'use server';

import { revalidatePath } from 'next/cache';
import { approvePayment, rejectPayment, write } from '@/lib/execute';
import { effectivePolicy, setAllowlisted, state, updatePolicy } from '@/lib/store';
import { walletFor } from '@/lib/wallet';
import type { Policy } from '@/lib/types';

/**
 * 守護者頁的動作。
 *
 * 用 server action 而不是讓前端打 `/api/guardian`，理由只有一個：
 * **`GUARDIAN_TOKEN` 不能出現在瀏覽器裡。** 只要把它塞進頁面讓前端帶，
 * 任何能開那一頁的人就都拿到 token 了 —— 那等於沒有 token。
 * server action 在伺服器上跑，token 從頭到尾沒離開過伺服器。
 *
 * 誠實的限制：server action 本身是一個 POST 端點，能連到這個站的人都打得到。
 * 現在靠的是 `npm run dev` 預設只綁 localhost。真實產品要的是家人裝置上的
 * passkey 簽章，那寫在 README 的限制章，不假裝已經做了。
 */

export type ActionResult = { ok: true; message: string } | { ok: false; error: string };

export async function approveAction(paymentId: string): Promise<ActionResult> {
  try {
    const payment = state().payments.find((p) => p.id === paymentId);
    const intent = payment && state().intents.find((i) => i.id === payment.intentId);
    if (!payment || !intent) return { ok: false, error: '找不到對應的付款或意圖' };

    const policy = effectivePolicy();
    const result = await approvePayment(paymentId, {
      policy,
      wallet: walletFor(policy),
      intent,
    });

    revalidatePath('/guardian');
    revalidatePath('/wallet');
    revalidatePath('/audit');

    return result.payment.status === 'executed'
      ? { ok: true, message: `已付款給 ${result.payment.payee.name}` }
      : { ok: false, error: result.payment.revertReason ?? '核准後仍未執行' };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export async function rejectAction(paymentId: string): Promise<ActionResult> {
  try {
    const { payment } = rejectPayment(paymentId);
    revalidatePath('/guardian');
    revalidatePath('/audit');
    return { ok: true, message: `已拒絕 ${payment.payee.name} 的 ${payment.amount} 元` };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * 改支出政策。
 *
 * 四個上限都要是正整數，而且核准門檻不能高過單筆上限 ——
 * 那樣設等於門檻沒有作用，而合約的 `setPolicy` 也會 revert，
 * 兩邊的規則必須一致，否則畫面改得動、鏈上改不動。
 */
export async function updatePolicyAction(form: FormData): Promise<ActionResult> {
  const read = (k: string) => Number(form.get(k));
  const perTxCap = read('perTxCap');
  const dailyCap = read('dailyCap');
  const approvalThreshold = read('approvalThreshold');

  for (const [label, v] of [
    ['單筆上限', perTxCap],
    ['單日上限', dailyCap],
    ['核准門檻', approvalThreshold],
  ] as const) {
    if (!Number.isInteger(v) || v <= 0) return { ok: false, error: `${label}要是正整數` };
  }
  if (approvalThreshold > perTxCap) {
    return { ok: false, error: '核准門檻不能高過單筆上限（合約也會拒絕這種設定）' };
  }

  const quietRaw = String(form.get('quietHours') ?? '').trim();
  let quietHours: Policy['quietHours'];
  if (quietRaw) {
    const m = quietRaw.match(/^(\d{1,2})\s*[-–~]\s*(\d{1,2})$/);
    if (!m) return { ok: false, error: '安靜時段要寫成「22-7」這種格式，或留空表示不設' };
    const [a, b] = [Number(m[1]), Number(m[2])];
    if (a > 23 || b > 23) return { ok: false, error: '小時要在 0–23 之間' };
    quietHours = [a, b];
  }

  const { before, after } = updatePolicy({
    perTxCap,
    dailyCap,
    approvalThreshold,
    quietHours,
  });

  write({
    type: 'policy.updated',
    actor: 'guardian',
    summary: `守護者調整政策：單筆 ${before.perTxCap} → ${after.perTxCap}、單日 ${before.dailyCap} → ${after.dailyCap}、門檻 ${before.approvalThreshold} → ${after.approvalThreshold}`,
    details: { before, after },
  });

  revalidatePath('/guardian');
  revalidatePath('/');
  revalidatePath('/wallet');
  return { ok: true, message: '政策已更新，下一筆付款就照新的規則走' };
}

/** 把收款人加進白名單或移出去。加進去等於「這個人以後可以自動付」，是有份量的動作。 */
export async function toggleAllowlistAction(payeeId: string, allowed: boolean): Promise<ActionResult> {
  const { allowlist } = setAllowlisted(payeeId, allowed);

  write({
    type: 'policy.updated',
    actor: 'guardian',
    summary: allowed ? `把 ${payeeId} 加進白名單` : `把 ${payeeId} 移出白名單`,
    details: { payeeId, allowed, allowlist },
  });

  revalidatePath('/guardian');
  revalidatePath('/');
  return { ok: true, message: allowed ? '已加入白名單' : '已移出白名單' };
}
