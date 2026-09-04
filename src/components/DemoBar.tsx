'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';

/** 舞台與錄影用的控制列。M0.3 只有重置可用，劇本按鈕在 M5.4 接上。 */
const SCENES = [
  { id: 'electricity', label: '幕一 電費' },
  { id: 'scam_nhi', label: '幕二 詐騙' },
  { id: 'redpacket', label: '幕三 紅包' },
  { id: 'weekly_report', label: '幕四 週報' },
];

export default function DemoBar() {
  const router = useRouter();
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function reset() {
    setBusy(true);
    try {
      const res = await fetch('/api/demo/reset', { method: 'POST' });
      const data = await res.json();
      setMsg(`已重置，載入 ${data.scenarios.length} 個情境`);
      router.refresh();
    } catch {
      setMsg('重置失敗，請看終端機的錯誤訊息');
    } finally {
      setBusy(false);
      setTimeout(() => setMsg(null), 4000);
    }
  }

  return (
    <div className="fixed inset-x-0 bottom-0 z-50 border-t border-[var(--color-line)] bg-[var(--color-surface)]">
      <div className="mx-auto flex max-w-[1080px] flex-wrap items-center gap-2 px-[clamp(1rem,4vw,2.5rem)] py-2.5">
        <span className="label mr-1">劇本</span>

        {SCENES.map((s) => (
          <button
            key={s.id}
            type="button"
            disabled
            title="M5.4 接上劇本按鈕"
            className="cursor-not-allowed border border-[var(--color-line)] px-2.5 py-1 text-[0.78rem] text-[var(--color-ink-3)]"
          >
            {s.label}
          </button>
        ))}

        <button
          type="button"
          disabled
          title="M4.4 接上紅隊按鈕"
          className="cursor-not-allowed border border-dashed border-[var(--color-cinnabar)] px-2.5 py-1 text-[0.78rem] text-[var(--color-cinnabar)] opacity-60"
        >
          紅隊：假設門神被騙了
        </button>

        <div className="flex-1" />

        {msg && <span className="text-[0.78rem] text-[var(--color-celadon)]">{msg}</span>}

        <button
          type="button"
          onClick={reset}
          disabled={busy}
          className="border border-[var(--color-ink)] bg-[var(--color-ink)] px-3 py-1 text-[0.78rem] text-[var(--color-surface)] disabled:opacity-50"
        >
          {busy ? '重置中' : '一鍵重置'}
        </button>
      </div>
    </div>
  );
}
