'use client';

import { useState, useTransition } from 'react';
import { runAttack, type Attack, type RedTeamResult } from '@/app/wallet/actions';

/**
 * 紅隊按鈕。
 *
 * 台詞只有一句：**假設鏈下全部被攻破了 —— 解析被騙、風險模型被說服、
 * 政策引擎被繞過 —— 錢還出得去嗎？**
 *
 * 按下去會拿 operator 的鑰匙直接打合約，跳過整條政策管線。
 * 回來的是合約的 revert 訊息，一字不改地印在畫面上。
 */

const ATTACKS: { id: Attack; label: string; line: string }[] = [
  { id: 'not_allowlisted', label: '付給陌生帳戶', line: '把錢付給名單外的人' },
  { id: 'over_cap', label: '超過單筆上限', line: '一次付出遠超過上限的金額' },
  { id: 'replay', label: '重放已付的款', line: '把剛剛成功的那筆再送一次' },
  { id: 'expired', label: '用過期的授權', line: '拿一份過期的授權去付款' },
];

export default function RedTeamPanel({ enabled }: { enabled: boolean }) {
  const [pending, startTransition] = useTransition();
  const [running, setRunning] = useState<Attack | null>(null);
  const [result, setResult] = useState<RedTeamResult | null>(null);

  if (!enabled) {
    return (
      <div className="card p-5">
        <p className="text-[0.88rem] text-[var(--color-ink-2)]">
          紅隊按鈕預設是關的。要打開，把 <span className="mono">.env</span> 的{' '}
          <span className="mono">ENABLE_REDTEAM</span> 設成{' '}
          <span className="mono">true</span> 再重啟。
        </p>
        <p className="mt-2 text-[0.8rem] text-[var(--color-ink-3)]">
          預設關掉不是保守 —— 這幾顆鈕會用 operator 的金鑰送出真的交易。
          舞台上一定會打開，而那時候整個場館的網路都打得到這一頁。
        </p>
      </div>
    );
  }

  function fire(id: Attack) {
    setRunning(id);
    setResult(null);
    startTransition(async () => {
      setResult(await runAttack(id));
      setRunning(null);
    });
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="card p-5">
        <p className="max-w-[62ch] text-[0.9rem] leading-relaxed">
          下面每一顆鈕都會<b>跳過整條政策管線</b>，直接拿 operator 的鑰匙打合約。
          等於假設門神已經被完全攻破：帳單解析被騙了、風險模型被說服了、
          政策引擎也被繞過了。
        </p>
        <div className="mt-4 flex flex-wrap gap-2">
          {ATTACKS.map((a) => (
            <button
              key={a.id}
              type="button"
              className="btn-quiet"
              disabled={pending}
              title={a.line}
              onClick={() => fire(a.id)}
            >
              {running === a.id ? '送出中……' : a.label}
            </button>
          ))}
        </div>
      </div>

      {result && !result.ok && (
        <div className="card border-l-4 border-l-[var(--color-ochre)] p-5">
          <div className="label" style={{ color: 'var(--color-ochre)' }}>沒跑成</div>
          <p className="mt-1 text-[0.88rem]">{result.error}</p>
        </div>
      )}

      {result?.ok && (
        <div
          className="card p-5"
          style={{
            borderLeft: `6px solid ${result.blocked ? 'var(--color-celadon)' : 'var(--color-cinnabar)'}`,
            background: result.blocked ? 'var(--color-celadon-bg)' : 'var(--color-cinnabar-bg)',
          }}
        >
          <div className="flex items-baseline gap-3">
            <span
              className="text-[2rem] leading-none"
              style={{ color: result.blocked ? 'var(--color-celadon)' : 'var(--color-cinnabar)' }}
              aria-hidden="true"
            >
              {result.blocked ? '🛡' : '⚠'}
            </span>
            <span className="text-[1.5rem] font-bold">
              {result.blocked ? '合約擋下來了' : '防線沒擋住 —— 這是 bug'}
            </span>
          </div>

          <p className="mt-2 text-[0.9rem]">
            試的是：<b>{result.label}</b>
          </p>

          {result.setup && (
            <p className="mt-1 text-[0.82rem] text-[var(--color-ink-2)]">{result.setup}</p>
          )}

          {result.blocked && result.reason && (
            <>
              <div className="label mt-3">合約回的原話</div>
              <pre className="mono mt-1 overflow-x-auto border-l-2 border-l-[var(--color-celadon)] py-1 pl-3 text-[0.88rem]">
                {result.reason}
              </pre>
              <p className="mt-2 max-w-[58ch] text-[0.82rem] text-[var(--color-ink-2)]">
                這句話不是門神寫的，是合約 revert 出來的。政策寫在鏈上，
                所以<b>繞過門神不等於繞過政策</b> —— 這就是跟「政策寫在應用層」的差別。
              </p>
            </>
          )}

          {!result.blocked && result.txHash && (
            <p className="mono mt-2 text-[0.82rem]">交易雜湊 {result.txHash}</p>
          )}

          <div className="mt-3 flex flex-wrap gap-x-5 gap-y-1 text-[0.78rem] text-[var(--color-ink-2)]">
            <span>
              想付給 {result.attempted.payee}{' '}
              <b className="mono">{result.attempted.amount.toLocaleString('zh-TW')}</b> 元
            </span>
            <span className="mono">{result.attempted.address.slice(0, 12)}…</span>
            <span className="mono">{result.chainMode}</span>
          </div>
        </div>
      )}
    </div>
  );
}
