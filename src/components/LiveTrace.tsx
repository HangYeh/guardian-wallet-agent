'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * 門神軌跡的直播區。
 *
 * 開著這一頁，另一個分頁去拍帳單，這裡就會一行一行長出來。
 * 重點不是好看，是讓人相信這條管線真的存在 —— 模型讀圖那四秒鐘裡，
 * observe 那一行已經在畫面上了，證明它是逐步跑的，不是最後才一次吐出來的。
 */

type BusEvent = {
  seq: number;
  ts: string;
  runId: string;
  kind: 'run.start' | 'step' | 'run.end' | 'run.error' | 'reset';
  phase?: 'observe' | 'plan' | 'tool' | 'verify';
  tool?: string;
  detail: string;
  elapsedMs?: number;
};

type Run = {
  id: string;
  startedAt: string;
  status: 'running' | 'done' | 'error';
  head: string;
  events: BusEvent[];
};

type Trigger = { id: string; label: string; body: Record<string, unknown> };

type Status = 'connecting' | 'live' | 'lost' | 'full';

const PHASE_COLOR: Record<string, string> = {
  observe: 'var(--color-ink-2)',
  plan: 'var(--color-ochre)',
  tool: 'var(--color-celadon)',
  verify: 'var(--color-cinnabar)',
};

const PHASE_LABEL: Record<string, string> = {
  observe: '看到',
  plan: '判斷',
  tool: '動手',
  verify: '覆核',
};

const STATUS_TEXT: Record<Status, string> = {
  connecting: '連線中……',
  live: '直播中',
  lost: '斷線了，正在重連（漏掉的會補回來）',
  full: '連線數已滿，關掉多餘的分頁再重新整理',
};

const STATUS_COLOR: Record<Status, string> = {
  connecting: 'var(--color-ink-3)',
  live: 'var(--color-celadon)',
  lost: 'var(--color-ochre)',
  full: 'var(--color-cinnabar)',
};

/** 畫面上最多留幾次 run。再多也沒人看，只是讓 DOM 一直長大。 */
const MAX_RUNS = 12;

const KINDS = ['run.start', 'step', 'run.end', 'run.error', 'reset', 'rejected'] as const;

export default function LiveTrace({ triggers }: { triggers: Trigger[] }) {
  const [runs, setRuns] = useState<Run[]>([]);
  const [status, setStatus] = useState<Status>('connecting');
  const [busyId, setBusyId] = useState<string | null>(null);
  const seenRef = useRef<Set<number>>(new Set());

  const apply = useCallback((e: BusEvent) => {
    // 補送和直播可能重疊（斷線重連時尤其），用 seq 去重。
    if (seenRef.current.has(e.seq)) return;
    seenRef.current.add(e.seq);

    if (e.kind === 'reset') {
      seenRef.current = new Set([e.seq]);
      setRuns([]);
      return;
    }

    setRuns((prev) => {
      const idx = prev.findIndex((r) => r.id === e.runId);
      const base: Run =
        idx === -1
          ? { id: e.runId, startedAt: e.ts, status: 'running', head: e.detail, events: [] }
          : { ...prev[idx], events: [...prev[idx].events] };

      if (e.kind === 'run.start') base.head = e.detail;
      if (e.kind === 'run.end') base.status = 'done';
      if (e.kind === 'run.error') base.status = 'error';
      if (e.kind !== 'run.start') base.events.push(e);

      if (idx === -1) return [base, ...prev].slice(0, MAX_RUNS);
      const next = [...prev];
      next[idx] = base;
      return next;
    });
  }, []);

  useEffect(() => {
    const es = new EventSource('/api/events');

    const onEvent = (ev: MessageEvent) => {
      if (ev.type === 'rejected') {
        setStatus('full');
        es.close();
        return;
      }
      try {
        setStatus('live');
        apply(JSON.parse(ev.data) as BusEvent);
      } catch {
        // 壞掉的一則不該讓整條串流停下來
      }
    };

    for (const k of KINDS) es.addEventListener(k, onEvent as EventListener);
    es.onopen = () => setStatus('live');
    es.onerror = () => setStatus((s) => (s === 'full' ? s : 'lost'));

    return () => {
      for (const k of KINDS) es.removeEventListener(k, onEvent as EventListener);
      es.close();
    };
  }, [apply]);

  async function fire(t: Trigger) {
    setBusyId(t.id);
    try {
      await fetch('/api/intake', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(t.body),
      });
    } finally {
      setBusyId(null);
    }
  }

  return (
    <section>
      <div className="flex flex-wrap items-center gap-2">
        <span className="pill" style={{ color: STATUS_COLOR[status] }}>
          ● {STATUS_TEXT[status]}
        </span>
        {triggers.map((t) => (
          <button
            key={t.id}
            type="button"
            className="btn-quiet"
            disabled={busyId !== null}
            onClick={() => fire(t)}
          >
            {busyId === t.id ? '跑著……' : t.label}
          </button>
        ))}
      </div>

      {runs.length === 0 ? (
        <div className="card mt-3 p-5 text-[0.88rem] text-[var(--color-ink-2)]">
          還沒有輸入進來。按上面任何一顆按鈕，或在另一個分頁拍一張帳單，
          這裡會即時長出「看到 → 判斷 → 動手 → 覆核」四種步驟。
        </div>
      ) : (
        <div className="mt-3 flex flex-col gap-3">
          {runs.map((run) => (
            <div key={run.id} className="card p-4">
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <span className="text-[0.95rem] font-bold">{run.head}</span>
                <span className="mono text-[0.72rem] text-[var(--color-ink-3)]">
                  {run.id} · {run.startedAt.slice(11, 19)}
                </span>
              </div>

              <ol className="mt-3 flex flex-col gap-2">
                {run.events.map((e) => (
                  <li key={e.seq} className="flex items-baseline gap-3 text-[0.84rem]">
                    <span className="mono w-12 shrink-0 text-right text-[0.72rem] text-[var(--color-ink-3)]">
                      {e.elapsedMs != null ? `${(e.elapsedMs / 1000).toFixed(1)}s` : ''}
                    </span>
                    <span
                      className="pill shrink-0"
                      style={{
                        color:
                          e.kind === 'run.error'
                            ? 'var(--color-cinnabar)'
                            : e.kind === 'run.end'
                              ? 'var(--color-celadon)'
                              : PHASE_COLOR[e.phase ?? 'observe'],
                      }}
                    >
                      {e.kind === 'run.end'
                        ? '收工'
                        : e.kind === 'run.error'
                          ? '出錯'
                          : PHASE_LABEL[e.phase ?? 'observe']}
                    </span>
                    <span className="text-[var(--color-ink-2)]">
                      {e.detail}
                      {e.tool && (
                        <span className="mono ml-2 text-[0.72rem] text-[var(--color-ink-3)]">
                          {e.tool}
                        </span>
                      )}
                    </span>
                  </li>
                ))}
                {run.status === 'running' && (
                  <li className="flex items-baseline gap-3 text-[0.84rem] text-[var(--color-ink-3)]">
                    <span className="w-12 shrink-0" />
                    <span className="pill shrink-0">…</span>
                    <span>門神還在想</span>
                  </li>
                )}
              </ol>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
