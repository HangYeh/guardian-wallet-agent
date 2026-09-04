'use client';

import { useRef, useState } from 'react';

/**
 * 阿嬤的第一顆按鈕：拍帳單。
 *
 * 手機拍的照片動輒四五 MB，直接送會撞到伺服器的上限，也在浪費現場的網路。
 * 所以先在瀏覽器裡縮到長邊 1600 像素再送 —— 帳單上的字在這個尺寸下還是讀得清楚。
 */

type Fields = {
  kind: string;
  payeeName: string;
  amount: number;
  dueDate: string | null;
  category: string;
  statedAccount: string | null;
  confidence: number;
  evidence: string;
};

type Intent = {
  taskId: string;
  resource: string;
  merchant: string;
  maxAmount: number;
  assetNetwork: string;
  expiresAt: string;
  idempotencyKey: string;
  amount: number;
};

type Decision = { action: 'auto' | 'hold' | 'block'; rulesHit: string[]; reason: string };

type Payment = {
  id: string;
  status: string;
  amount: number;
  channel: string;
  txHash?: string;
  explorerUrl?: string;
  revertReason?: string;
};

type TraceStep = { phase: string; tool?: string; detail: string };

type Result = {
  ok: boolean;
  error?: string;
  engine?: 'llm' | 'rules';
  model?: string;
  latencyMs?: number;
  fields?: Fields;
  transcript?: string;
  intent?: Intent;
  decision?: Decision;
  payment?: Payment;
  payee?: { id: string; name: string; allowlisted: boolean; address: string } | null;
  trace?: TraceStep[];
  warnings?: string[];
};

const MAX_EDGE = 1600;

const PHASE_COLOR: Record<string, string> = {
  observe: 'var(--color-ink-2)',
  plan: 'var(--color-ochre)',
  tool: 'var(--color-celadon)',
  verify: 'var(--color-cinnabar)',
};

/**
 * 三種決策的樣子。阿嬤看的是這一塊，所以用字要像人講話，
 * 而且要大 —— 這一格的字級是整頁最大的。
 */
const DECISION_LOOK: Record<Decision['action'], { title: string; color: string; icon: string }> = {
  auto: { title: '門神幫妳繳好了', color: 'var(--color-celadon)', icon: '✓' },
  hold: { title: '這筆要等家人點頭', color: 'var(--color-ochre)', icon: '⏸' },
  block: { title: '門神把這筆擋下來了', color: 'var(--color-cinnabar)', icon: '✕' },
};

const CATEGORY_LABEL: Record<string, string> = {
  utility: '水電瓦斯',
  telecom: '電信網路',
  medical: '醫療藥局',
  care: '照護看護',
  subscription: '訂閱課程',
  person: '個人',
  other: '其他',
};

async function shrink(file: File): Promise<string> {
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, MAX_EDGE / Math.max(bitmap.width, bitmap.height));
  const w = Math.round(bitmap.width * scale);
  const h = Math.round(bitmap.height * scale);

  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('這個瀏覽器不支援 canvas');
  ctx.drawImage(bitmap, 0, 0, w, h);
  bitmap.close();

  return canvas.toDataURL('image/jpeg', 0.85);
}

export default function BillUpload() {
  const fileRef = useRef<HTMLInputElement>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [result, setResult] = useState<Result | null>(null);

  async function send(body: Record<string, unknown>, previewUrl: string | null) {
    setBusy(true);
    setResult(null);
    setPreview(previewUrl);
    const started = Date.now();
    const tick = setInterval(() => setElapsed(Date.now() - started), 100);
    try {
      const res = await fetch('/api/intake', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      setResult((await res.json()) as Result);
    } catch (err) {
      setResult({ ok: false, error: err instanceof Error ? err.message : String(err) });
    } finally {
      clearInterval(tick);
      setElapsed(Date.now() - started);
      setBusy(false);
    }
  }

  async function onPick(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      const dataUrl = await shrink(file);
      await send({ image: dataUrl }, dataUrl);
    } catch (err) {
      setResult({ ok: false, error: err instanceof Error ? err.message : String(err) });
    }
    e.target.value = '';
  }

  const f = result?.fields;
  const i = result?.intent;

  return (
    <section>
      <div className="flex flex-wrap items-center gap-3">
        <button
          type="button"
          className="btn-primary"
          disabled={busy}
          onClick={() => fileRef.current?.click()}
        >
          📄 拍帳單
        </button>
        <button
          type="button"
          className="btn-quiet"
          disabled={busy}
          onClick={() => send({ scenarioId: 'electricity' }, '/api/demo-image/bill-taipower.png')}
        >
          用示範帳單試試
        </button>
        <input
          ref={fileRef}
          type="file"
          accept="image/png,image/jpeg,image/webp"
          capture="environment"
          className="hidden"
          onChange={onPick}
        />
        {busy && (
          <span className="mono text-[0.85rem] text-[var(--color-ink-2)]">
            門神正在讀…… {(elapsed / 1000).toFixed(1)} 秒
          </span>
        )}
        {!busy && result?.ok && (
          <span className="mono text-[0.85rem] text-[var(--color-ink-3)]">
            {(elapsed / 1000).toFixed(1)} 秒
          </span>
        )}
      </div>

      {result && !result.ok && (
        <div className="card mt-4 border-l-4 border-l-[var(--color-cinnabar)] p-4">
          <div className="label" style={{ color: 'var(--color-cinnabar)' }}>讀不到</div>
          <p className="mt-1 text-[0.9rem]">{result.error}</p>
        </div>
      )}

      {result?.ok && f && i && (
        <div className="mt-4 grid gap-4 lg:grid-cols-[minmax(0,15rem)_1fr]">
          {preview && (
            <div className="card overflow-hidden p-0">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={preview} alt="剛剛送出的帳單" className="block w-full" />
            </div>
          )}

          <div className="flex flex-col gap-4">
            {/* ---- 門神做了什麼：整頁最重要的一塊 ---- */}
            {result.decision && (
              <div
                className="card p-5"
                style={{ borderLeft: `6px solid ${DECISION_LOOK[result.decision.action].color}` }}
              >
                <div className="flex items-baseline gap-3">
                  <span
                    className="text-[2rem] leading-none"
                    style={{ color: DECISION_LOOK[result.decision.action].color }}
                    aria-hidden="true"
                  >
                    {DECISION_LOOK[result.decision.action].icon}
                  </span>
                  <span className="text-[1.6rem] font-bold">
                    {DECISION_LOOK[result.decision.action].title}
                  </span>
                </div>

                <p className="mt-2 max-w-[52ch] text-[1rem] leading-relaxed">
                  {result.decision.reason}
                </p>

                {result.payment && (
                  <div className="mt-3 flex flex-wrap items-baseline gap-x-5 gap-y-1 text-[0.82rem] text-[var(--color-ink-2)]">
                    <span>
                      實付{' '}
                      <b className="mono">{result.payment.amount.toLocaleString('zh-TW')}</b> 元
                    </span>
                    <span className="mono">{result.payment.channel}</span>
                    {result.payment.txHash && (
                      <span className="mono" title={result.payment.txHash}>
                        {result.payment.explorerUrl ? (
                          <a href={result.payment.explorerUrl} target="_blank" rel="noreferrer">
                            {result.payment.txHash.slice(0, 16)}…
                          </a>
                        ) : (
                          <>{result.payment.txHash.slice(0, 16)}…</>
                        )}
                      </span>
                    )}
                    {result.payment.revertReason && (
                      <span style={{ color: 'var(--color-cinnabar)' }}>
                        {result.payment.revertReason}
                      </span>
                    )}
                  </div>
                )}

                {result.decision.rulesHit.length > 0 && (
                  <div className="mt-3 flex flex-wrap gap-1.5">
                    {result.decision.rulesHit.map((r) => (
                      <span key={r} className="pill mono text-[0.7rem]">
                        {r}
                      </span>
                    ))}
                  </div>
                )}
              </div>
            )}

            {/* ---- 讀到什麼 ---- */}
            <div className="card p-5">
              <div className="flex items-baseline justify-between gap-3">
                <span className="label">門神讀到的</span>
                <span className="mono text-[0.72rem] text-[var(--color-ink-3)]">
                  {result.engine === 'llm' ? result.model : '規則解析'}
                  {result.latencyMs != null && ` · ${result.latencyMs} ms`}
                </span>
              </div>

              <div className="mt-2 flex flex-wrap items-baseline gap-x-4 gap-y-1">
                <span className="text-[1.6rem] font-bold">{f.payeeName}</span>
                <span className="mono text-[2rem] font-bold">
                  {f.amount.toLocaleString('zh-TW')}
                  <span className="ml-1 text-[1rem] font-normal text-[var(--color-ink-2)]">元</span>
                </span>
              </div>

              <div className="mt-3 grid gap-x-6 gap-y-2 text-[0.85rem] sm:grid-cols-3">
                <Field label="種類" value={f.kind === 'bill' ? '帳單' : '轉帳'} />
                <Field label="到期日" value={f.dueDate ?? '沒寫'} mono />
                <Field label="分類" value={CATEGORY_LABEL[f.category] ?? f.category} />
                <Field label="把握度" value={`${Math.round(f.confidence * 100)}%`} mono />
                <Field label="帳號" value={f.statedAccount ?? '沒有'} mono />
                <Field
                  label="收款人"
                  value={
                    result.payee
                      ? `${result.payee.id}${result.payee.allowlisted ? '（白名單）' : '（要核准）'}`
                      : '不在名單內'
                  }
                />
              </div>

              {f.evidence && (
                <p className="mt-3 border-l-2 border-l-[var(--color-line)] pl-3 text-[0.82rem] text-[var(--color-ink-2)]">
                  依據：{f.evidence}
                </p>
              )}
            </div>

            {/* ---- 授權信封 ---- */}
            <div className="card p-5">
              <div className="label">封好的授權信封</div>
              <p className="mt-1 max-w-[60ch] text-[0.82rem] text-[var(--color-ink-2)]">
                上面六個欄位是模型讀出來的，下面六個是政策引擎封上去的。
                模型碰不到這六個，所以就算它被帳單上的文字騙過去，也改不了能付多少。
              </p>
              <div className="mt-3 grid gap-x-6 gap-y-2 text-[0.85rem] sm:grid-cols-2">
                <Field label="任務" value={i.taskId} mono />
                <Field label="標的" value={i.resource} />
                <Field label="收款方" value={i.merchant} />
                <Field
                  label="授權上限"
                  value={`${i.maxAmount.toLocaleString('zh-TW')} 元`}
                  mono
                  accent={i.amount > i.maxAmount ? 'var(--color-cinnabar)' : undefined}
                />
                <Field label="資產與網路" value={i.assetNetwork} mono />
                <Field label="效期至" value={i.expiresAt.slice(11, 19) + ' UTC'} mono />
              </div>
              <div className="mt-3">
                <Field label="冪等鍵（鏈上的 memoHash）" value={i.idempotencyKey} mono wrap />
              </div>
            </div>

            {/* ---- 警告 ---- */}
            {result.warnings && result.warnings.length > 0 && (
              <div className="card border-l-4 border-l-[var(--color-ochre)] p-4">
                <div className="label" style={{ color: 'var(--color-ochre)' }}>要注意</div>
                <ul className="mt-1 flex list-disc flex-col gap-1 pl-5 text-[0.85rem]">
                  {result.warnings.map((w) => (
                    <li key={w}>{w}</li>
                  ))}
                </ul>
              </div>
            )}

            {/* ---- 軌跡 ---- */}
            {result.trace && result.trace.length > 0 && (
              <details className="card p-4">
                <summary className="cursor-pointer text-[0.88rem] font-bold">
                  門神這幾秒做了什麼（{result.trace.length} 步）
                </summary>
                <ol className="mt-3 flex flex-col gap-2">
                  {result.trace.map((t, n) => (
                    <li key={n} className="flex gap-3 text-[0.83rem]">
                      <span className="pill shrink-0" style={{ color: PHASE_COLOR[t.phase] }}>
                        {t.phase}
                      </span>
                      <span className="text-[var(--color-ink-2)]">{t.detail}</span>
                    </li>
                  ))}
                </ol>
              </details>
            )}

            {/* ---- 逐字稿 ---- */}
            {result.transcript && (
              <details className="card p-4">
                <summary className="cursor-pointer text-[0.88rem] font-bold">
                  逐字讀到的內容（{result.transcript.length} 字）
                </summary>
                <p className="mt-1 text-[0.78rem] text-[var(--color-ink-3)]">
                  這一段是另一顆模型獨立讀出來的，之後的詐騙偵測跑在它上面，
                  因為指令可以印在帳單上。
                </p>
                <pre className="mono mt-2 max-h-64 overflow-auto whitespace-pre-wrap text-[0.78rem] text-[var(--color-ink-2)]">
                  {result.transcript}
                </pre>
              </details>
            )}
          </div>
        </div>
      )}
    </section>
  );
}

function Field({
  label,
  value,
  mono,
  wrap,
  accent,
}: {
  label: string;
  value: string;
  mono?: boolean;
  wrap?: boolean;
  accent?: string;
}) {
  return (
    <div>
      <div className="label">{label}</div>
      <div
        className={`${mono ? 'mono ' : ''}${wrap ? 'break-all ' : 'truncate '}text-[0.9rem]`}
        style={accent ? { color: accent } : undefined}
        title={value}
      >
        {value}
      </div>
    </div>
  );
}
