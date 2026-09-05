import { appendEvent, persist, readAuditFile } from '@/lib/audit';
import { assetNetworkFor, currentChainMode, intentHashParts } from '@/lib/intent';
import { decide, type PolicyContext } from '@/lib/policy';
import { state } from '@/lib/store';
import { PolicyViolation, type GuardianAdapter, type WalletAdapter } from '@/lib/wallet';
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

export async function executeIntent(input: ExecuteInput): Promise<ExecuteResult> {
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
    spentToday: await wallet.spentToday(now),
    alreadySettled: await wallet.isSettled(intent.idempotencyKey),
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
      const receipt = await wallet.pay(
        {
          payee: payment.payee,
          amount: payment.amount,
          memoHash: payment.memoHash,
          ...intentHashParts(intent),
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
    /*
     * 提案要**真的送上鏈**（合約的 `propose`），家人之後核准的是那個提案編號。
     *
     * 9/5 之前這裡只改鏈下狀態，核准時再用 operator 的鑰匙呼叫 `pay()` ——
     * 但合約的 `pay()` 一定查白名單，所以幕三的紅包在 local 模式會被
     * `payee not allowlisted` 擋下。合約設計上讓 `approve()` 跳過白名單，
     * 前提是先有一筆 `propose`。
     *
     * 零地址的收款人沒有東西可以提案（合約會 revert "payee is zero address"）：
     * 那種付款留在鏈下等家人，但永遠不可核准 —— `approvePayment` 的守衛一擋著。
     */
    const proposable = !/^0x0{40}$/i.test(payment.payee.address);
    let proposal: { proposalId: number; txHash?: string } | undefined;
    let proposeError: string | undefined;

    if (proposable) {
      try {
        proposal = await wallet.propose(
          {
            payee: payment.payee,
            amount: payment.amount,
            memoHash: payment.memoHash,
            ...intentHashParts(intent),
            expiresAt: intent.expiresAt,
            reason: decision.reason,
          },
          now,
        );
        payment.proposalId = proposal.proposalId;
      } catch (err) {
        proposeError = err instanceof PolicyViolation ? err.message : String(err);
      }
    }

    if (proposeError) {
      // 連提案都被鏈上擋下，家人沒有東西可以核准。誠實記成失敗，不要留一筆
      // 永遠核准不了的「等待核准」在畫面上。
      payment.status = 'failed';
      payment.revertReason = proposeError;
      events.push(
        write({
          type: 'payment.reverted',
          actor: 'chain',
          intentId: intent.id,
          paymentId: payment.id,
          summary: `提案就被鏈上擋下：${proposeError}`,
          details: { reason: proposeError, action: decision.action, rulesHit: decision.rulesHit },
          memoHash: payment.memoHash,
        }, now),
      );
    } else {
      payment.status = 'pending_approval';
      events.push(
        write({
          type: 'payment.proposed',
          actor: 'agent',
          intentId: intent.id,
          paymentId: payment.id,
          summary: `等家人核准：${payment.payee.name} ${payment.amount.toLocaleString('zh-TW')} 元`,
          details: {
            rulesHit: decision.rulesHit,
            reason: decision.reason,
            proposalId: proposal?.proposalId ?? null,
            txHash: proposal?.txHash ?? null,
            channel: wallet.mode,
          },
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
    }
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
 * 核准跳過兩道：**白名單**與**核准門檻**。家人核准的是「這一個收款人、
 * 這一個金額」，那個動作本身就是白名單的授權來源。
 *
 * 不跳過的：效期、防重放、單筆上限、單日上限、以及下面這兩道守衛。
 * 家人能同意一筆付款，不能解除長期的硬上限。
 */
export async function approvePayment(
  paymentId: string,
  args: { policy: Policy; guardian: GuardianAdapter; intent: PaymentIntent; now?: Date },
): Promise<{ payment: Payment; events: AuditEvent[] }> {
  const now = args.now ?? new Date();
  const payment = state().payments.find((p) => p.id === paymentId);
  if (!payment) throw new Error(`沒有這筆付款：${paymentId}`);
  if (payment.status !== 'pending_approval') {
    throw new Error(`這筆付款的狀態是 ${payment.status}，不是等待核准`);
  }

  // 守衛一：沒有真實收款地址的付款不可核准。
  //
  // 名單裡對不到的收款人，付款物件上掛的是零地址佔位。核准它等於把錢燒掉，
  // 而且畫面會顯示「已繳」。家人要付給這個人，得先把他的地址加進名單。
  if (payment.payee.id === 'unmatched' || /^0x0{40}$/i.test(payment.payee.address)) {
    throw new Error(
      `「${payment.payee.name}」還沒有收款地址，不能核准。先把他加進收款人名單再說。`,
    );
  }

  // 守衛二：核准的當下鏈別要對得上。
  //
  // 授權是對「某一條鏈上的某一種資產」開的。從提案到核准中間可能過了幾小時，
  // 期間有人切了 CHAIN_MODE —— 那份授權就不算數了（演講 Slide 29 的 MATCH）。
  const chainNow = assetNetworkFor(currentChainMode());
  if (chainNow !== args.intent.assetNetwork) {
    throw new Error(
      `這筆授權是給 ${args.intent.assetNetwork} 的，現在連的是 ${chainNow}，不是同一條鏈。`,
    );
  }

  // 守衛三：要有鏈上提案才有東西可以核准。
  //
  // 零地址那種本來就不會有（守衛一已擋）；走到這裡還沒有，代表提案當時就失敗了，
  // 而那筆的狀態應該是 failed 不是 pending_approval —— 真的看到就是 bug。
  if (payment.proposalId == null) {
    throw new Error(`這筆付款沒有鏈上提案編號，無法核准（${payment.id}）`);
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
    // 家人的鑰匙呼叫合約的 approve(proposalId)：跳過白名單與門檻，其餘四道照舊。
    const receipt = await args.guardian.approve(payment.proposalId, now);
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
        details: { txHash: receipt.txHash, approvedBy: 'guardian', proposalId: payment.proposalId },
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

export async function rejectPayment(
  paymentId: string,
  args: { guardian: GuardianAdapter; now?: Date; reason?: string },
): Promise<{ payment: Payment; events: AuditEvent[] }> {
  const now = args.now ?? new Date();
  const payment = state().payments.find((p) => p.id === paymentId);
  if (!payment) throw new Error(`沒有這筆付款：${paymentId}`);
  if (payment.status !== 'pending_approval') {
    throw new Error(`這筆付款的狀態是 ${payment.status}，不是等待核准`);
  }

  // 有鏈上提案就在鏈上拒絕 —— 合約會把那把冪等鍵燒掉，代理重送一次不能重新排隊。
  // 沒有提案的（零地址那種）只改鏈下狀態。
  let txHash: string | undefined;
  if (payment.proposalId != null) {
    const r = await args.guardian.reject(payment.proposalId, args.reason ?? '守護者拒絕', now);
    txHash = r.txHash;
  }

  payment.status = 'rejected';
  const events = [
    write({
      type: 'payment.rejected',
      actor: 'guardian',
      intentId: payment.intentId,
      paymentId: payment.id,
      summary: `守護者拒絕 ${payment.payee.name} ${payment.amount.toLocaleString('zh-TW')} 元`,
      details: { proposalId: payment.proposalId ?? null, txHash: txHash ?? null },
      memoHash: payment.memoHash,
    }, now),
  ];
  return { payment, events };
}

// ---------------------------------------------------------------------------

/**
 * 接上雜湊鏈、寫進記憶體、落地成檔案。三件事必須一起發生，所以包成一個函式。
 *
 * 開頭那一段是被實測抓出來的：伺服器重啟之後記憶體是空的，但檔案還在。
 * 少了它，重啟後的第一筆會從 seq 1、prevHash 創世重新開始，接在一條已經
 * 到 seq 15 的鏈後面 —— 稽核頁會顯示「鏈接斷了」，但根本沒有人動過任何東西。
 * 在舞台上那就是一個假警報，而且是最難解釋的那種。
 */
export function write(
  draft: Omit<AuditEvent, 'seq' | 'id' | 'ts' | 'prevHash' | 'hash'>,
  now: Date = new Date(),
): AuditEvent {
  const s = state();

  if (s.audit.length === 0) {
    // 檔案才是鏈的本體，記憶體只是這個行程的快取。接回去，不要另起一條。
    // 檔案若已經被改壞，接上去之後那個斷點仍然看得見 —— 這正是我們要的。
    s.audit.push(...readAuditFile().events);
  }

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
