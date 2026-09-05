'use client';

import { useState, useTransition } from 'react';
import {
  approveAction,
  rejectAction,
  toggleAllowlistAction,
  updatePolicyAction,
  type ActionResult,
} from '@/app/guardian/actions';

/**
 * 守護者的按鈕與表單。
 *
 * 只有這一層是 client component，動作本身跑在伺服器上 ——
 * 所以 `GUARDIAN_TOKEN` 從頭到尾沒進過瀏覽器。
 */

function useAction() {
  const [pending, startTransition] = useTransition();
  const [result, setResult] = useState<ActionResult | null>(null);

  const run = (fn: () => Promise<ActionResult>) => {
    startTransition(async () => {
      setResult(await fn());
      setTimeout(() => setResult(null), 6000);
    });
  };

  return { pending, result, run };
}

function Feedback({ result }: { result: ActionResult | null }) {
  if (!result) return null;
  return (
    <span
      className="text-[0.8rem]"
      style={{ color: result.ok ? 'var(--color-celadon)' : 'var(--color-cinnabar)' }}
    >
      {result.ok ? result.message : result.error}
    </span>
  );
}

// ---------------------------------------------------------------------------

export function ApprovalButtons({
  paymentId,
  payeeName,
  amount,
  hasAddress,
}: {
  paymentId: string;
  payeeName: string;
  amount: number;
  hasAddress: boolean;
}) {
  const { pending, result, run } = useAction();
  const [confirming, setConfirming] = useState(false);

  if (!hasAddress) {
    // 沒有鏈上地址的收款人核准了也付不出去（會付到零地址）。
    // 與其讓人按了才知道，不如一開始就說清楚要先做什麼。
    return (
      <span className="text-[0.8rem] text-[var(--color-cinnabar)]">
        沒有收款地址，要先把 {payeeName} 加進收款人名單
      </span>
    );
  }

  if (!confirming) {
    return (
      <div className="flex flex-wrap items-center gap-2">
        <button type="button" className="btn-quiet" onClick={() => setConfirming(true)}>
          核准
        </button>
        <button
          type="button"
          className="btn-quiet"
          disabled={pending}
          onClick={() => run(() => rejectAction(paymentId))}
        >
          拒絕
        </button>
        <Feedback result={result} />
      </div>
    );
  }

  // 核准是不可逆的（錢會真的出去），所以多一步確認，而且把金額再講一次。
  return (
    <div className="flex flex-wrap items-center gap-2">
      <span className="text-[0.82rem]">
        確定付 <b className="mono">{amount.toLocaleString('zh-TW')}</b> 元給 {payeeName}？
      </span>
      <button
        type="button"
        className="btn-primary"
        disabled={pending}
        onClick={() => {
          setConfirming(false);
          run(() => approveAction(paymentId));
        }}
      >
        {pending ? '送出中……' : '確定'}
      </button>
      <button type="button" className="btn-quiet" onClick={() => setConfirming(false)}>
        取消
      </button>
      <Feedback result={result} />
    </div>
  );
}

// ---------------------------------------------------------------------------

export function PolicyForm({
  perTxCap,
  dailyCap,
  approvalThreshold,
  quietHours,
}: {
  perTxCap: number;
  dailyCap: number;
  approvalThreshold: number;
  quietHours?: [number, number];
}) {
  const { pending, result, run } = useAction();

  return (
    <form
      className="card flex flex-wrap items-end gap-4 p-5"
      action={(fd) => run(() => updatePolicyAction(fd))}
    >
      <Field name="perTxCap" label="單筆上限" defaultValue={perTxCap} />
      <Field name="dailyCap" label="單日上限" defaultValue={dailyCap} />
      <Field name="approvalThreshold" label="自動繳費門檻" defaultValue={approvalThreshold} />
      <div>
        <label className="label block" htmlFor="quietHours">
          安靜時段
        </label>
        <input
          id="quietHours"
          name="quietHours"
          defaultValue={quietHours ? `${quietHours[0]}-${quietHours[1]}` : ''}
          placeholder="22-7，留空表示不設"
          className="mono mt-1 w-36 border border-[var(--color-line)] bg-transparent px-2 py-1 text-[0.9rem]"
        />
      </div>

      <button type="submit" className="btn-primary" disabled={pending}>
        {pending ? '更新中……' : '更新政策'}
      </button>
      <Feedback result={result} />

      <p className="w-full text-[0.78rem] text-[var(--color-ink-3)]">
        改完立刻對下一筆生效。合約端的 <span className="mono">setPolicy</span> 走的是同一組規則
        —— 核准門檻設得比單筆上限高，這裡跟鏈上都會拒絕。
      </p>
    </form>
  );
}

function Field({
  name,
  label,
  defaultValue,
}: {
  name: string;
  label: string;
  defaultValue: number;
}) {
  return (
    <div>
      <label className="label block" htmlFor={name}>
        {label}
      </label>
      <input
        id={name}
        name={name}
        type="number"
        min={1}
        step={1}
        defaultValue={defaultValue}
        className="mono mt-1 w-28 border border-[var(--color-line)] bg-transparent px-2 py-1 text-[0.9rem]"
      />
    </div>
  );
}

// ---------------------------------------------------------------------------

export function AllowlistToggle({
  payeeId,
  payeeName,
  allowed,
  cooldownHours,
}: {
  payeeId: string;
  payeeName: string;
  allowed: boolean;
  /** 新收款人冷卻期（小時）。0 代表這條規則沒開。 */
  cooldownHours: number;
}) {
  const { pending, result, run } = useAction();

  return (
    <div className="flex items-center gap-2">
      <button
        type="button"
        className="btn-quiet"
        disabled={pending}
        title={
          allowed
            ? `移出白名單之後，${payeeName} 的付款一律要你核准`
            : cooldownHours > 0
              ? `加進白名單之後，${payeeName} 要先過 ${cooldownHours} 小時冷卻期，之後在額度內才會自動付`
              : `加進白名單之後，${payeeName} 在額度內可以自動付`
        }
        onClick={() => run(() => toggleAllowlistAction(payeeId, !allowed))}
      >
        {pending ? '……' : allowed ? '移出白名單' : '加進白名單'}
      </button>
      <Feedback result={result} />
    </div>
  );
}
