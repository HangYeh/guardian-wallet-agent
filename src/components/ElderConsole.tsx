'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { SpeakButton, useSpeech } from '@/components/Speak';
import { onDemoSignal } from '@/lib/demo-signal';
import { sceneById } from '@/lib/scenes';

/**
 * 阿嬤的操作台。三顆鍵，其他什麼都沒有。
 *
 * 設計上只守一條規則：**七十幾歲的人要能一眼看懂門神做了什麼決定。**
 * 所以決策那一塊的字級是整頁最大的，理由用講話的口氣寫，
 * 術語（規則代碼、分數、雜湊）一律往下收到摺疊區裡給家人看。
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
  id: string;
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

type Signal = { code: string; weight: number; evidence: string };

type Risk = {
  score: number;
  rulesScore: number;
  llmScore: number | null;
  level: 'low' | 'medium' | 'high';
  hardLocked: boolean;
  signals: Signal[];
  tactics: Signal[];
  tacticScore: number;
  policyReasons: Signal[];
  scamType: string;
  elderExplanation: string;
  guardianExplanation: string;
  engine: string;
  model: string | null;
  fallbackReason: string | null;
  narrativeDropped: string | null;
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
  risk?: Risk;
  payment?: Payment;
  payee?: { id: string; name: string; allowlisted: boolean; address: string } | null;
  speech?: { text: string } | null;
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

/** 三種決策的樣子。`block` 是唯一會佔滿整個寬度的 —— 擋下來這件事不能小聲說。 */
const LOOK: Record<Decision['action'], { title: string; color: string; bg: string; icon: string }> = {
  auto: {
    title: '門神幫妳繳好了',
    color: 'var(--color-celadon)',
    bg: 'var(--color-celadon-bg)',
    icon: '✓',
  },
  hold: {
    title: '這筆要等家人點頭',
    color: 'var(--color-ochre)',
    bg: 'var(--color-ochre-bg)',
    icon: '⏸',
  },
  block: {
    title: '這是詐騙，門神沒有付',
    color: 'var(--color-cinnabar)',
    bg: 'var(--color-cinnabar-bg)',
    icon: '✕',
  },
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

/** 貼訊息面板裡的示範。舞台上手打太慢，但真的貼也一樣會跑。 */
const SAMPLES: { id: string; label: string }[] = [
  { id: 'scam_nhi', label: '假健保署' },
  { id: 'scam_investment', label: '假投資' },
  { id: 'scam_grandchild', label: '假孫子' },
  { id: 'redpacket', label: '真的紅包' },
];

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

export default function ElderConsole() {
  const fileRef = useRef<HTMLInputElement>(null);
  const [pasting, setPasting] = useState(false);
  const [text, setText] = useState('');
  const [preview, setPreview] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [result, setResult] = useState<Result | null>(null);
  // 第三顆鍵：唸這個月的週報。字是伺服器算的，這裡只負責按與放。
  const weekly = useSpeech();

  const send = useCallback(async (body: Record<string, unknown>, previewUrl: string | null) => {
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
  }, []);

  // ---- 劇本按鈕：網址上帶 ?play=<幕>，看到就開演 ----
  //
  // 按鈕在 demo bar 上、每一頁都有；它只負責把人帶來這一頁、在網址上寫要演哪一幕。
  // 開演後把參數從網址拿掉：重新整理不該再演一次。`n` 是流水號，同一幕連按兩次也算兩次。
  const params = useSearchParams();
  const play = params.get('play');
  const nonce = params.get('n');
  const playedRef = useRef<string | null>(null);
  useEffect(() => {
    if (!play) return;
    const key = `${play}#${nonce ?? ''}`;
    if (playedRef.current === key) return;
    const scene = sceneById(play);
    if (!scene || scene.page !== '/') return;
    // 排到下一個 tick 再開演，而不是在 effect 裡直接呼叫：send 會連環 setState，
    // React 不准在 effect 本體裡同步做這件事。「演過了」的記號也留到真的開演那一刻才蓋，
    // 這樣 dev 模式 effect 被跑兩次（StrictMode）時，被取消的那一次不會把記號先用掉。
    const id = setTimeout(() => {
      if (playedRef.current === key) return;
      playedRef.current = key;
      window.history.replaceState(null, '', window.location.pathname);
      void send({ scenarioId: scene.id }, scene.preview ?? null);
    }, 0);
    return () => clearTimeout(id);
  }, [play, nonce, send]);

  // ---- 一鍵重置：伺服器清了，畫面也要清，不然上一幕的判決還掛在台上 ----
  useEffect(
    () =>
      onDemoSignal(() => {
        setResult(null);
        setPreview(null);
        setPasting(false);
        setText('');
      }),
    [],
  );

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
  const blocked = result?.decision?.action === 'block';

  return (
    <section>
      {/* ---- 三顆鍵 ---- */}
      <div className="grid gap-3 sm:grid-cols-3">
        <BigKey
          icon="📄"
          label="拍帳單"
          hint="繳費單拍給門神看"
          disabled={busy}
          onClick={() => fileRef.current?.click()}
        />
        <BigKey
          icon="🛡️"
          label="這是詐騙嗎？"
          hint="把可疑的訊息貼進來"
          active={pasting}
          disabled={busy}
          onClick={() => setPasting((v) => !v)}
        />
        <BigKey
          icon="🔊"
          label={
            weekly.status === 'loading' ? '準備中……' : weekly.status === 'playing' ? '正在唸……' : '唸給我聽'
          }
          hint={weekly.note ?? '這個月的錢花到哪裡'}
          active={weekly.status === 'playing'}
          disabled={busy || weekly.status === 'loading'}
          onClick={() => void weekly.speak({ kind: 'weekly' })}
        />
      </div>

      <input
        ref={fileRef}
        type="file"
        accept="image/png,image/jpeg,image/webp"
        capture="environment"
        className="hidden"
        onChange={onPick}
      />

      {/* ---- 貼訊息 ---- */}
      {pasting && (
        <div className="card mt-3 p-5">
          <label className="label block" htmlFor="paste">
            把訊息整段貼進來，門神幫妳看
          </label>
          <textarea
            id="paste"
            rows={4}
            value={text}
            disabled={busy}
            onChange={(e) => setText(e.target.value)}
            placeholder="例如：【健保署通知】您的健保卡涉及詐領⋯⋯"
            className="mt-2 w-full resize-y rounded-[14px] border border-[var(--color-line)] bg-[var(--color-surface)] p-3 text-[1rem] leading-relaxed outline-none focus:border-[var(--color-mint-deep)]"
          />
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <button
              type="button"
              className="btn-primary"
              disabled={busy || text.trim().length === 0}
              onClick={() => send({ text: text.trim() }, null)}
            >
              {busy ? '門神正在看……' : '請門神看看'}
            </button>
            <span className="text-[0.78rem] text-[var(--color-ink-3)]">或用示範訊息：</span>
            {SAMPLES.map((s) => (
              <button
                key={s.id}
                type="button"
                className="btn-quiet text-[0.8rem]"
                disabled={busy}
                onClick={() => send({ scenarioId: s.id }, null)}
              >
                {s.label}
              </button>
            ))}
          </div>
        </div>
      )}

      {/* ---- 示範帳單 ---- */}
      <div className="mt-3 flex flex-wrap items-center gap-3">
        <button
          type="button"
          className="btn-quiet text-[0.85rem]"
          disabled={busy}
          onClick={() => send({ scenarioId: 'electricity' }, '/api/demo-image/bill-taipower.png')}
        >
          用示範帳單試試
        </button>
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
        <div className="card verdict mt-4 p-4" style={{ borderTopColor: 'var(--color-cinnabar)' }}>
          <div className="label" style={{ color: 'var(--color-cinnabar)' }}>讀不到</div>
          <p className="mt-1 text-[0.9rem]">{result.error}</p>
        </div>
      )}

      {/* ---- 攔截畫面：擋下來的時候佔滿整個寬度，先出現在最上面 ---- */}
      {result?.ok && blocked && result.decision && (
        <Verdict
          decision={result.decision}
          risk={result.risk}
          payment={result.payment}
          intentId={result.intent?.id}
          big
        />
      )}

      {result?.ok && f && i && (
        <div className="mt-4 grid gap-4 lg:grid-cols-[minmax(0,15rem)_1fr]">
          {preview && (
            <div className="card overflow-hidden p-0">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={preview} alt="剛剛送出的帳單" className="block w-full" />
            </div>
          )}

          <div className={`flex flex-col gap-4 ${preview ? '' : 'lg:col-span-2'}`}>
            {!blocked && result.decision && (
              <Verdict
                decision={result.decision}
                risk={result.risk}
                payment={result.payment}
                intentId={result.intent?.id}
              />
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
                <span className="text-[1.6rem] font-extrabold">{f.payeeName}</span>
                <span className="mono text-[2rem] font-bold text-[var(--color-mint-shadow)]">
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
              {/* 終端機的樣子不是裝飾：這六欄是程式封的，跟上面模型讀的那張卡要一眼分得出來 */}
              <div className="cli-block mt-3">
                <div className="cli-head">
                  <span className="traffic" aria-hidden="true">
                    <span />
                    <span />
                    <span />
                  </span>
                  <span className="dim">guardian seal --intent {i.id}</span>
                </div>
                <Sealed k="taskId" v={i.taskId} />
                <Sealed k="resource" v={i.resource} />
                <Sealed k="merchant" v={i.merchant} />
                <Sealed
                  k="maxAmount"
                  v={`${i.maxAmount.toLocaleString('zh-TW')} TWD`}
                  warn={i.amount > i.maxAmount}
                  note={i.amount > i.maxAmount ? `# 要求 ${i.amount.toLocaleString('zh-TW')}，壓到單筆上限` : undefined}
                />
                <Sealed k="assetNetwork" v={i.assetNetwork} />
                <Sealed k="expiresAt" v={`${i.expiresAt.slice(11, 19)} UTC`} />
                <Sealed k="memoHash" v={i.idempotencyKey} wrap />
                <span className="line">
                  <span className="ok">✓ sealed by policy</span> <span className="dim"># model has no write access</span>
                </span>
              </div>
            </div>

            {/* ---- 警告 ---- */}
            {result.warnings && result.warnings.length > 0 && (
              <div className="card verdict p-4" style={{ borderTopColor: 'var(--color-ochre)' }}>
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

// ---------------------------------------------------------------------------

function BigKey({
  icon,
  label,
  hint,
  cell,
  active,
  disabled,
  onClick,
}: {
  icon: string;
  label: string;
  hint: string;
  cell?: string;
  active?: boolean;
  disabled?: boolean;
  onClick?: () => void;
}) {
  const pending = Boolean(cell);
  return (
    <button
      type="button"
      disabled={pending || disabled}
      onClick={onClick}
      className={`keycard ${active ? 'is-active' : ''} ${pending ? 'cursor-not-allowed opacity-60' : ''}`}
    >
      <span className="keycard-icon" aria-hidden="true">{icon}</span>
      <span className="keycard-title">{label}</span>
      <span className="keycard-hint">{hint}</span>
      {cell && <span className="pill mt-2 text-[var(--color-ink-3)]">{cell} 接上</span>}
    </button>
  );
}

/**
 * 門神的判決。
 *
 * `big` 是攔截專用：擋下詐騙的時候這一塊會佔滿整個寬度、字放到最大，
 * 因為那是阿嬤唯一需要看懂的東西。理由分成兩組講 —— 這是 §7.3 的 B 案：
 * 「有人想騙你」跟「這件事要問人」是兩件事，不能混在同一個數字裡。
 */
function Verdict({
  decision,
  risk,
  payment,
  intentId,
  big,
}: {
  decision: Decision;
  risk?: Risk;
  payment?: Payment;
  intentId?: string;
  big?: boolean;
}) {
  const look = LOOK[decision.action];
  const elder = risk?.elderExplanation;

  return (
    <div
      className={`card verdict ${big ? 'mt-4 p-7' : 'p-5'}`}
      style={{ borderTopColor: look.color, background: big ? look.bg : undefined }}
    >
      <div className="flex items-center gap-4">
        <span className={`verdict-icon ${big ? 'big' : ''}`} style={{ background: look.color }} aria-hidden="true">
          {look.icon}
        </span>
        <span className={big ? 'text-[2.3rem] font-extrabold leading-tight' : 'text-[1.55rem] font-extrabold leading-tight'}>
          {look.title}
        </span>
      </div>

      {/* 阿嬤讀的那一句。模型寫的，但已經在伺服器端清洗過 —— 它讀的是詐騙者的文字。 */}
      {elder && (
        <p
          className={`mt-3 max-w-[28ch] font-bold leading-snug ${big ? 'text-[1.7rem]' : 'text-[1.15rem]'}`}
          style={{ color: look.color }}
        >
          {elder}
        </p>
      )}

      <p className={`mt-3 max-w-[52ch] leading-relaxed ${big ? 'text-[1.05rem]' : 'text-[1rem]'}`}>
        {decision.reason}
      </p>

      {/* 結果一出來就唸一次（字已經在畫面上了，聲音是給看不清楚的人）；要再聽就按。 */}
      {intentId && (
        <div className={big ? 'mt-4' : 'mt-3'}>
          <SpeakButton request={{ intentId }} autoplay big={big} />
        </div>
      )}

      {risk && <Reasons risk={risk} big={big} />}

      {payment && (
        <div className="mt-4 flex flex-wrap items-baseline gap-x-5 gap-y-1 text-[0.82rem] text-[var(--color-ink-2)]">
          <span>
            實付 <b className="mono">{payment.amount.toLocaleString('zh-TW')}</b> 元
          </span>
          <span className="mono">{payment.channel}</span>
          {payment.txHash && (
            <span className="mono" title={payment.txHash}>
              {payment.explorerUrl ? (
                <a href={payment.explorerUrl} target="_blank" rel="noreferrer">
                  {payment.txHash.slice(0, 16)}…
                </a>
              ) : (
                <>{payment.txHash.slice(0, 16)}…</>
              )}
            </span>
          )}
          {payment.revertReason && (
            <span style={{ color: 'var(--color-cinnabar)' }}>{payment.revertReason}</span>
          )}
        </div>
      )}

      <details className="mt-4">
        <summary className="cursor-pointer text-[0.8rem] text-[var(--color-ink-3)]">
          給家人看的細節
        </summary>
        <div className="mt-2 flex flex-col gap-2 text-[0.8rem] text-[var(--color-ink-2)]">
          {risk && (
            <p>
              風險 <b className="mono">{risk.score}</b> 分（{risk.level}
              {risk.hardLocked ? '，硬鎖' : ''}）＝ 規則 {risk.rulesScore}
              {risk.llmScore !== null ? ` ＋ 模型 ${risk.llmScore}` : '，沒問模型'}
              {risk.fallbackReason ? `（${risk.fallbackReason}）` : ''}
            </p>
          )}
          {risk?.guardianExplanation && <p>{risk.guardianExplanation}</p>}
          {risk?.narrativeDropped && (
            <p style={{ color: 'var(--color-ochre)' }}>模型的說法沒有採用：{risk.narrativeDropped}</p>
          )}
          {decision.rulesHit.length > 0 && (
            <div className="flex flex-wrap gap-1.5">
              {decision.rulesHit.map((r) => (
                <span key={r} className="pill mono text-[0.7rem]">
                  {r}
                </span>
              ))}
            </div>
          )}
        </div>
      </details>
    </div>
  );
}

/**
 * 理由清單，分成兩組。
 *
 * 這是 M4.1 實測踩到的坑：幕三那筆完全正常的紅包也會拿到 medium，
 * 因為它命中了「不在白名單」與「超過門檻」—— 但那是**政策事實**，
 * 不是詐騙證據。混在一起顯示會讓人以為門神覺得孫子的紅包可疑。
 */
function Reasons({ risk, big }: { risk: Risk; big?: boolean }) {
  const hasTactics = risk.tactics.length > 0;
  const hasPolicy = risk.policyReasons.length > 0;
  if (!hasTactics && !hasPolicy) return null;

  return (
    <div className={`mt-4 flex flex-col gap-3 ${big ? 'text-[0.95rem]' : 'text-[0.85rem]'}`}>
      {hasTactics && (
        <div>
          <div className="label" style={{ color: 'var(--color-cinnabar)' }}>
            詐騙的話術（{risk.tactics.length} 項）
          </div>
          <ul className="mt-1.5 flex flex-col gap-1.5">
            {risk.tactics.map((s) => (
              <li key={s.code} className="flex gap-2 leading-snug">
                <span aria-hidden="true" style={{ color: 'var(--color-cinnabar)' }}>●</span>
                <span>{s.evidence}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {hasPolicy && (
        <div>
          <div className="label">
            {hasTactics ? '另外，' : ''}要問家人的原因（{risk.policyReasons.length} 項）
          </div>
          <ul className="mt-1.5 flex flex-col gap-1.5">
            {risk.policyReasons.map((s) => (
              <li key={s.code} className="flex gap-2 leading-snug text-[var(--color-ink-2)]">
                <span aria-hidden="true" style={{ color: 'var(--color-ink-3)' }}>○</span>
                <span>{s.evidence}</span>
              </li>
            ))}
          </ul>
          {!hasTactics && (
            <p className="mt-1.5 text-[0.8rem] text-[var(--color-ink-3)]">
              這些不是詐騙的跡象，只是門神照規矩要先問過人。
            </p>
          )}
        </div>
      )}
    </div>
  );
}

/** 授權信封裡的一行：`$ key = value`，警告值用暖橘。 */
function Sealed({ k, v, wrap, warn, note }: { k: string; v: string; wrap?: boolean; warn?: boolean; note?: string }) {
  return (
    <span className={`line ${wrap ? 'wrap' : ''}`}>
      <span className="prompt">$</span> <span className="key">{k}</span> = <span className={warn ? 'warn' : undefined}>{v}</span>
      {note && <span className="dim"> {note}</span>}
    </span>
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
