import { appendEvent, persist } from '@/lib/audit';
import { assetNetworkFor, currentChainMode } from '@/lib/intent';
import { decide, type PolicyContext } from '@/lib/policy';
import { state } from '@/lib/store';
import { PolicyViolation, type WalletAdapter } from '@/lib/wallet';
import type {
  AuditEvent,
  Payee,
  Payment,
  PaymentIntent,
  Policy,
  PolicyDecision,
  RiskLevel,
} from '@/lib/types';

/**
 * 執行層：政策說了算，這裡只負責把話變成動作與紀錄。
 *
 * 三個動作各一條路：
 *   auto  → 直接付，成功寫 payment.executed，被合約擋下寫 payment.reverted
 *   hold  → 生成提案，等守護者核准
 *   block → 記錄攔截，不生成提案（不給「一鍵放行」的入口留在這一層）
 *
 * `payment.reverted` 那條路很重要：政策說可以付、合約卻擋下來，代表兩邊的
 * 規則對不起來。正常情況下它永遠不會被走到（policy.test.ts 有不變量守著），
 * 但真的發生時必須留下紀錄，而不是吞掉例外裝作沒事。
 */

export type ExecuteInput = {
  intent: PaymentIntent;
  policy: Policy;
  wallet: WalletAdapter;
  payee?: Payee;
  risk?: RiskLevel;
  payeeAddedAt?: string;
  now?: Date;
};

export type ExecuteResult = {
  decision: PolicyDecision;
  payment: Payment;
  events: AuditEvent[];
};

export function executeIntent(input: ExecuteInput): ExecuteResult {
  const now = input.now ?? new Date();
  const { intent, policy, wallet } = input;

  const ctx: PolicyContext = {
    intent,
    policy,
    payee: input.payee,
    risk: input.risk,
    payeeAddedAt: input.payeeAddedAt,
    now,
    // 這三個是執行層才知道的事實，政策自己不去問 —— 純函數不碰外面。
    spentToday: wallet.spentToday(now),
    alreadySettled: wallet.isSettled(intent.idempotencyKey),
    chainAssetNetwork: assetNetworkFor(currentChainMode()),
  };

  const decision = decide(ctx);
  const events: AuditEvent[] = [];

  const payment: Payment = {
    id: `pay_${intent.idempotencyKey.slice(2, 10)}`,
    intentId: intent.id,
    payee: input.payee ?? unknownPayee(intent),
    amount: intent.maxAmount,
    memoHash: intent.idempotencyKey,
    status: 'scheduled',
    channel: wallet.mode,
    createdAt: now.toISOString(),
  };

  events.push(
    write({
      type: 'policy.decided',
      actor: 'agent',
      intentId: intent.id,
      paymentId: payment.id,
      summary: `政策判定 ${decision.action}：${decision.reason}`,
      details: { action: decision.action, rulesHit: decision.rulesHit, spentToday: ctx.spentToday },
      memoHash: intent.idempotencyKey,
    }, now),
  );

  if (decision.action === 'auto') {
    try {
      const receipt = wallet.pay(
        {
          payee: payment.payee,
          amount: payment.amount,
          memoHash: payment.memoHash,
          expiresAt: intent.expiresAt,
        },
        now,
      );
      payment.status = 'executed';
      payment.txHash = receipt.txHash;
      payment.explorerUrl = receipt.explorerUrl;
      payment.executedAt = now.toISOString();

      events.push(
        write({
          type: 'payment.executed',
          actor: 'agent',
          intentId: intent.id,
          paymentId: payment.id,
          summary: `已繳 ${payment.payee.name} ${payment.amount.toLocaleString('zh-TW')} 元`,
          details: { txHash: receipt.txHash, channel: wallet.mode, amount: payment.amount },
          memoHash: payment.memoHash,
        }, now),
      );
    } catch (err) {
      // 政策說可以、合約說不行。這代表兩邊的規則對不起來，是 bug 不是流程。
      const reason = err instanceof PolicyViolation ? err.message : String(err);
      payment.status = 'failed';
      payment.revertReason = reason;

      events.push(
        write({
          type: 'payment.reverted',
          actor: 'chain',
          intentId: intent.id,
          paymentId: payment.id,
          summary: `政策放行但鏈上擋下：${reason}`,
          details: { reason, action: decision.action, rulesHit: decision.rulesHit },
          memoHash: payment.memoHash,
        }, now),
      );
    }
  } else if (decision.action === 'hold') {
    payment.status = 'pending_approval';
    events.push(
      write({
        type: 'payment.proposed',
        actor: 'agent',
        intentId: intent.id,
        paymentId: payment.id,
        summary: `等家人核准：${payment.payee.name} ${payment.amount.toLocaleString('zh-TW')} 元`,
        details: { rulesHit: decision.rulesHit, reason: decision.reason },
        memoHash: payment.memoHash,
      }, now),
      write({
        type: 'guardian.notified',
        actor: 'agent',
        intentId: intent.id,
        paymentId: payment.id,
        summary: `已通知${'守護者'}，附上原文與命中的規則`,
        details: { rulesHit: decision.rulesHit },
      }, now),
    );
  } else {
    payment.status = 'blocked';
    events.push(
      write({
        type: 'payment.blocked',
        actor: 'agent',
        intentId: intent.id,
        paymentId: payment.id,
        summary: `攔下：${decision.reason}`,
        details: { rulesHit: decision.rulesHit },
        memoHash: payment.memoHash,
      }, now),
    );
  }

  state().payments.push(payment);
  return { decision, payment, events };
}

/**
 * 守護者核准一筆等待中的付款。
 *
 * 核准跳過的只有「核准門檻」那一道 —— 其餘五道照舊。
 * 家人能做的是「同意這個金額」，不是「解除所有限制」。
 */
export function approvePayment(
  paymentId: string,
  args: { policy: Policy; wallet: WalletAdapter; intent: PaymentIntent; now?: Date },
): { payment: Payment; events: AuditEvent[] } {
  const now = args.now ?? new Date();
  const payment = state().payments.find((p) => p.id === paymentId);
  if (!payment) throw new Error(`沒有這筆付款：${paymentId}`);
  if (payment.status !== 'pending_approval') {
    throw new Error(`這筆付款的狀態是 ${payment.status}，不是等待核准`);
  }

  const events: AuditEvent[] = [
    write({
      type: 'payment.approved',
      actor: 'guardian',
      intentId: payment.intentId,
      paymentId: payment.id,
      summary: `守護者核准 ${payment.payee.name} ${payment.amount.toLocaleString('zh-TW')} 元`,
      details: { amount: payment.amount },
      memoHash: payment.memoHash,
    }, now),
  ];

  try {
    const receipt = args.wallet.pay(
      {
        payee: payment.payee,
        amount: payment.amount,
        memoHash: payment.memoHash,
        expiresAt: args.intent.expiresAt,
        approved: true,
      },
      now,
    );
    payment.status = 'executed';
    payment.txHash = receipt.txHash;
    payment.executedAt = now.toISOString();

    events.push(
      write({
        type: 'payment.executed',
        actor: 'agent',
        intentId: payment.intentId,
        paymentId: payment.id,
        summary: `核准後已繳 ${payment.payee.name} ${payment.amount.toLocaleString('zh-TW')} 元`,
        details: { txHash: receipt.txHash, approvedBy: 'guardian' },
        memoHash: payment.memoHash,
      }, now),
    );
  } catch (err) {
    const reason = err instanceof PolicyViolation ? err.message : String(err);
    payment.status = 'failed';
    payment.revertReason = reason;
    events.push(
      write({
        type: 'payment.reverted',
        actor: 'chain',
        intentId: payment.intentId,
        paymentId: payment.id,
        // 家人核准不等於合約放行：過期了、額度滿了，照樣擋。
        summary: `核准之後仍被鏈上擋下：${reason}`,
        details: { reason },
        memoHash: payment.memoHash,
      }, now),
    );
  }

  return { payment, events };
}

export function rejectPayment(paymentId: string, now: Date = new Date()) {
  const payment = state().payments.find((p) => p.id === paymentId);
  if (!payment) throw new Error(`沒有這筆付款：${paymentId}`);
  payment.status = 'rejected';
  const events = [
    write({
      type: 'payment.rejected',
      actor: 'guardian',
      intentId: payment.intentId,
      paymentId: payment.id,
      summary: `守護者拒絕 ${payment.payee.name} ${payment.amount.toLocaleString('zh-TW')} 元`,
      details: {},
      memoHash: payment.memoHash,
    }, now),
  ];
  return { payment, events };
}

// ---------------------------------------------------------------------------

/** 接上雜湊鏈、寫進記憶體、落地成檔案。三件事必須一起發生，所以包成一個函式。 */
export function write(
  draft: Omit<AuditEvent, 'seq' | 'id' | 'ts' | 'prevHash' | 'hash'>,
  now: Date = new Date(),
): AuditEvent {
  const s = state();
  const event = appendEvent(draft, s.audit.at(-1), now);
  s.audit.push(event);
  persist(event);
  return event;
}

function unknownPayee(intent: PaymentIntent): Payee {
  return {
    id: 'unmatched',
    name: intent.payeeName,
    address: `0x${'0'.repeat(40)}`,
    kind: 'unknown',
    allowlisted: false,
  };
}
