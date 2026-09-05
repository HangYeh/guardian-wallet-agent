'use client';

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { postDemoSignal } from '@/lib/demo-signal';
import { SCENES, sceneUrl, type Scene } from '@/lib/scenes';

/**
 * 舞台與錄影用的控制列，每一頁底下都有。
 *
 * 劇本按鈕不自己跑管線 —— 它只把人帶到該演的那一頁，網址上寫著要演哪一幕，
 * 阿嬤的操作台（或稽核頁）看到網址就開演。所以從任何一頁按都一樣；
 * 而且 `/?play=scam_nhi` 這種網址本身就能用，錄影時直接開它就好。
 *
 * 一鍵重置是伺服器的事，但畫面也要跟著清：重置完會廣播一聲，
 * 同一台電腦上所有分頁的操作台把上一幕的判決收掉。
 */
export default function DemoBar() {
  const router = useRouter();
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [lastScene, setLastScene] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // 網址上的流水號。同一幕連按兩次要算兩次，網址不同才會重新導。
  const nonce = useRef(0);

  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );

  function flash(text: string, ms = 4000) {
    setMsg(text);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setMsg(null), ms);
  }

  function play(scene: Scene) {
    setLastScene(scene.id);
    flash(`${scene.act} ${scene.label}，開演`, 2500);
    nonce.current += 1;
    router.push(sceneUrl(scene, nonce.current));
  }

  async function reset() {
    setBusy(true);
    try {
      const res = await fetch('/api/demo/reset', { method: 'POST' });
      const data = await res.json();
      if (!data.ok) throw new Error(data.error ?? 'reset failed');
      // 伺服器清完，這一台電腦上所有分頁的畫面也要清 —— 不然阿嬤頁上一幕的判決還掛著。
      postDemoSignal({ type: 'reset', at: data.resetAt ?? new Date().toISOString() });
      setLastScene(null);
      flash(`已重置，載入 ${data.scenarios.length} 個情境`);
      router.refresh();
    } catch {
      flash('重置失敗，請看終端機的錯誤訊息');
    } finally {
      setBusy(false);
    }
  }

  const acts = SCENES.filter((s) => !s.encore);
  const encores = SCENES.filter((s) => s.encore);

  return (
    <div className="fixed inset-x-0 bottom-0 z-50 border-t border-[var(--color-line)] bg-[var(--color-surface)]">
      <div className="mx-auto flex max-w-[1080px] flex-wrap items-center gap-2 px-[clamp(1rem,4vw,2.5rem)] py-2.5">
        <span className="label mr-1">劇本</span>
        {acts.map((s) => (
          <SceneButton key={s.id} scene={s} active={lastScene === s.id} onClick={() => play(s)} />
        ))}

        <span className="label ml-2 mr-1">加演</span>
        {encores.map((s) => (
          <SceneButton key={s.id} scene={s} active={lastScene === s.id} onClick={() => play(s)} />
        ))}

        <Link
          href="/wallet#redteam"
          title="錢包頁的紅隊按鈕：跳過整條政策管線，直接拿 operator 的鑰匙打合約"
          className="ml-2 border border-dashed border-[var(--color-cinnabar)] px-2.5 py-1 text-[0.78rem] text-[var(--color-cinnabar)] no-underline"
        >
          紅隊：假設門神被騙了
        </Link>

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

function SceneButton({ scene, active, onClick }: { scene: Scene; active: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={`${scene.act}：${scene.label}。按了會到${scene.page === '/audit' ? '稽核頁' : '阿嬤頁'}開演`}
      className={`border px-2.5 py-1 text-[0.78rem] ${
        active
          ? 'border-[var(--color-cinnabar)] text-[var(--color-cinnabar)]'
          : 'border-[var(--color-line)] text-[var(--color-ink-2)] hover:border-[var(--color-ink)] hover:text-[var(--color-ink)]'
      }`}
    >
      {scene.act} {scene.label}
    </button>
  );
}
