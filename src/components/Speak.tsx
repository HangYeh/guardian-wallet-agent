'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * 「唸給我聽」。
 *
 * 伺服器回 mp3 就播；回 JSON（語音關掉、沒錄、雲端壞）就用瀏覽器內建的
 * 中文語音唸同一句；連那個都沒有就把字留在畫面上。三層都退完，
 * 畫面還是完整的 —— 語音是體驗，不是功能的前提。
 */

export type SpeechRequest = { intentId: string } | { kind: 'weekly' };
export type SpeechStatus = 'idle' | 'loading' | 'playing' | 'error';

type Fallback = { ok: boolean; text?: string; reason?: string; error?: string };

function speakWithBrowser(text: string, onEnd: () => void): boolean {
  if (typeof window === 'undefined' || !('speechSynthesis' in window)) return false;
  try {
    const u = new SpeechSynthesisUtterance(text);
    u.lang = 'zh-TW';
    u.rate = 0.9;
    u.onend = onEnd;
    u.onerror = onEnd;
    window.speechSynthesis.cancel();
    window.speechSynthesis.speak(u);
    return true;
  } catch {
    return false;
  }
}

export function useSpeech() {
  const [status, setStatus] = useState<SpeechStatus>('idle');
  const [note, setNote] = useState<string | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const urlRef = useRef<string | null>(null);

  const stop = useCallback(() => {
    audioRef.current?.pause();
    audioRef.current = null;
    if (urlRef.current) {
      URL.revokeObjectURL(urlRef.current);
      urlRef.current = null;
    }
    if (typeof window !== 'undefined' && 'speechSynthesis' in window) window.speechSynthesis.cancel();
  }, []);

  const speak = useCallback(
    async (req: SpeechRequest) => {
      stop();
      setStatus('loading');
      setNote(null);
      try {
        const res = await fetch('/api/tts', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(req),
        });
        const type = res.headers.get('content-type') ?? '';

        if (res.ok && type.startsWith('audio/')) {
          const url = URL.createObjectURL(await res.blob());
          urlRef.current = url;
          const audio = new Audio(url);
          audioRef.current = audio;
          audio.onended = () => setStatus('idle');
          audio.onerror = () => {
            setStatus('error');
            setNote('這台電腦放不出聲音');
          };
          await audio.play();
          setStatus('playing');
          return;
        }

        const j = (await res.json()) as Fallback;
        if (j.text && speakWithBrowser(j.text, () => setStatus('idle'))) {
          setStatus('playing');
          setNote(j.reason === 'disabled' ? '雲端語音沒開，用電腦內建的聲音' : '雲端語音沒回應，用電腦內建的聲音');
          return;
        }
        setStatus('error');
        setNote(j.error ?? (j.text ? '這台電腦沒有聲音可以用' : '沒有可以唸的內容'));
      } catch (err) {
        // 瀏覽器不准自動播放（NotAllowedError）也會走到這裡：按鈕還在，再按一次就好。
        setStatus('error');
        setNote(err instanceof Error && err.name === 'NotAllowedError' ? '按一下才會唸' : '語音暫時沒辦法用');
      }
    },
    [stop],
  );

  useEffect(() => stop, [stop]);

  return { status, note, speak, stop };
}

export function SpeakButton({
  request,
  label = '唸給我聽',
  autoplay = false,
  big = false,
}: {
  request: SpeechRequest;
  label?: string;
  /** 結果一出來就唸。同一筆只自動唸一次，之後要聽再按。 */
  autoplay?: boolean;
  big?: boolean;
}) {
  const { status, note, speak } = useSpeech();
  const key = JSON.stringify(request);
  const played = useRef<string | null>(null);

  useEffect(() => {
    if (!autoplay || played.current === key) return;
    played.current = key;
    void speak(JSON.parse(key) as SpeechRequest);
  }, [autoplay, key, speak]);

  const text =
    status === 'loading' ? '🔊 準備中……' : status === 'playing' ? '🔊 正在唸……' : `🔊 ${label}`;

  return (
    <span className="inline-flex flex-wrap items-center gap-2">
      <button
        type="button"
        className={big ? 'btn-quiet text-[1.1rem]' : 'btn-quiet'}
        disabled={status === 'loading'}
        onClick={() => void speak(request)}
      >
        {text}
      </button>
      {note && <span className="text-[0.78rem] text-[var(--color-ink-3)]">{note}</span>}
    </span>
  );
}
