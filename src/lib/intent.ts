import { keccak256, toBytes } from 'viem';
import type { PaymentIntent } from '@/lib/types';

/** Payment Intent 預設效期：15 分鐘。過期的 intent 一律不執行，也不重新發動。 */
export const INTENT_TTL_MS = 15 * 60 * 1000;

/**
 * 冪等鍵 = keccak256("taskId|merchant|amount|expiresAt")。
 *
 * 同一把鍵在合約裡就是 memoHash，`GuardedWallet` 用 `usedIntent[memoHash]`
 * 擋第二次結算。逾時重試會拿到同一把鍵，所以「逾時 ≠ 可以再付一次」。
 */
export function buildIdempotencyKey(args: {
  taskId: string;
  merchant: string;
  amount: number;
  expiresAt: string;
}): `0x${string}` {
  const canonical = `${args.taskId}|${args.merchant}|${args.amount}|${args.expiresAt}`;
  return keccak256(toBytes(canonical));
}

/** Intent 是否已逾期。逾期就必須重新走一次解析與政策，不能直接放行。 */
export function isIntentExpired(
  intent: Pick<PaymentIntent, 'expiresAt'>,
  now: Date = new Date(),
): boolean {
  return new Date(intent.expiresAt).getTime() <= now.getTime();
}

/** 產生效期截止時間（ISO 字串）。 */
export function intentExpiry(now: Date = new Date(), ttlMs: number = INTENT_TTL_MS): string {
  return new Date(now.getTime() + ttlMs).toISOString();
}
