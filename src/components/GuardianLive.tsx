'use client';

import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';

/**
 * 讓守護者頁自己會動。
 *
 * 做法刻意選最小的一種：**匯流排只當觸發器，不當資料來源。**
 * 收到事件就 `router.refresh()`，讓伺服器重新算一次這一頁 ——
 * 通知卡的內容照樣從稽核鏈讀，跟 `decisionOf()` 同一個來源。
 *
 * 另一種寫法是讓這個元件自己接住事件、在客戶端組出通知內容。那要解析
 * 匯流排的 `detail` 字串（它是給人看的句子，不是結構化資料），而且會變成
 * 第二份狀態 —— 稽核鏈說擋下了 50,000，畫面卻因為漏接一則事件說 5,000。
 * 這一頁的規矩從 M2.3 就定了：**兩份會走鐘，所以只留一份。**
 */

/** 這幾種事件代表「有事情發生完了」，值得重新拉一次頁面。 */
const KINDS = ['run.end', 'run.error', 'reset'] as const;

export default function GuardianLive() {
  const router = useRouter();
  const [connected, setConnected] = useState(false);
  const [flash, setFlash] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const es = new EventSource('/api/events');

    es.onopen = () => setConnected(true);
    es.onerror = () => setConnected(false);

    const onEvent = () => {
      router.refresh();
      setFlash(true);
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => setFlash(false), 2500);
    };

    for (const k of KINDS) es.addEventListener(k, onEvent);

    // 訂閱數有上限（MAX_SUBSCRIBERS = 8），離開這一頁一定要還回去，
    // 否則來回切幾次分頁就把名額用完，軌跡頁反而連不上。
    return () => {
      for (const k of KINDS) es.removeEventListener(k, onEvent);
      es.close();
      if (timer.current) clearTimeout(timer.current);
    };
  }, [router]);

  return (
    <span
      className="mono text-[0.72rem]"
      style={{ color: flash ? 'var(--color-cinnabar)' : 'var(--color-ink-3)' }}
      title={connected ? '連著門神的事件串流，有新動靜會自己更新' : '事件串流斷了，重整一次'}
    >
      {flash ? '● 剛剛有新動靜' : connected ? '● 即時連線中' : '○ 連線中斷'}
    </span>
  );
}
