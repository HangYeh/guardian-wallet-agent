import { AUDIT_FILE, readAuditFile, verifyChain } from '@/lib/audit';
import { loadDemo, formatTWD, spendByMerchant, lastUsed } from '@/lib/demo';

export const dynamic = 'force-dynamic';

export default function AuditPage() {
  const demo = loadDemo();
  const r = demo.expectedReport;
  // 刻意讀檔案而不是讀記憶體：檔案才是證據。
  // 有人手動改了 data/audit.jsonl，這一頁就該指出來 —— 讀記憶體是看不到的。
  const { events, badLines } = readAuditFile();
  const verdict = verifyChain(events);
  const spend = spendByMerchant(demo);
  const maxSpend = Math.max(...spend.map((s) => s.total));

  const findings = [
    {
      type: 'duplicate_charge',
      title: '有線電視八月被扣了兩次',
      detail: '8/12 與 8/14 各扣 599 元，同收款人同金額且相隔七天內',
      amount: r.duplicateRefund,
      action: '申請退款',
      color: 'var(--color-cinnabar)',
    },
    {
      type: 'zombie_subscription',
      title: '銀髮健身課程已經很久沒去',
      detail: `最後出席 ${lastUsed(demo, 'payee_gym')}，之後仍每月扣款`,
      amount: r.zombieCancel,
      action: '建議退訂',
      color: 'var(--color-ochre)',
    },
    {
      type: 'price_hike',
      title: '居家照護沒通知就漲價',
      detail: '從 3,200 漲到 4,800，漲幅五成且未見通知',
      amount: r.priceHikeDelta,
      action: '請家人去談',
      color: 'var(--color-ochre)',
    },
    {
      type: 'due_soon',
      title: '中華電信三天內到期',
      detail: '9/7 到期，金額在白名單與額度範圍內',
      amount: 799,
      action: '門神會自動繳',
      color: 'var(--color-celadon)',
    },
  ];

  return (
    <main className="page">
      <h1 className="page-title">稽核與週報</h1>
      <p className="page-sub">
        每一個決策都留下可驗證的紀錄。匯出的 JSON 就是評審可以自己檢查的證據，
        鏈上的 memoHash 與這裡的稽核事件一一對應。
      </p>

      <div className="card p-6">
        <div className="label">本月守住</div>
        <div className="mono mt-1 text-4xl font-bold text-[var(--color-celadon)]">
          {formatTWD(r.guardedTotal)}
        </div>
        <div className="mt-3 flex flex-wrap gap-x-6 gap-y-1 text-[0.85rem] text-[var(--color-ink-2)]">
          <span>攔截詐騙 <b className="mono">{r.blockedScam.toLocaleString('zh-TW')}</b></span>
          <span>退重複扣款 <b className="mono">{r.duplicateRefund.toLocaleString('zh-TW')}</b></span>
          <span>停用殭屍訂閱 <b className="mono">{r.zombieCancel.toLocaleString('zh-TW')}</b></span>
        </div>
        <p className="mt-3 max-w-[62ch] text-[0.82rem] text-[var(--color-ink-3)]">
          調價多付的 {r.priceHikeDelta.toLocaleString('zh-TW')} 元只提醒不計入，
          因為錢還沒真的省下來，要家人去談。數字誠實比數字漂亮重要。
        </p>
      </div>

      <h2 className="mt-8 mb-3 text-[1.05rem] font-bold">找到的四件事</h2>
      <div className="grid gap-3 sm:grid-cols-2">
        {findings.map((f) => (
          <div key={f.type} className="card p-4">
            <div className="flex items-baseline justify-between gap-2">
              <span className="font-bold">{f.title}</span>
              <span className="mono text-lg font-bold" style={{ color: f.color }}>
                {f.amount.toLocaleString('zh-TW')}
              </span>
            </div>
            <p className="mt-1 text-[0.83rem] text-[var(--color-ink-2)]">{f.detail}</p>
            <div className="mt-2 flex items-center gap-2">
              <span className="pill" style={{ color: f.color }}>{f.action}</span>
              <span className="mono text-[0.7rem] text-[var(--color-ink-3)]">{f.type}</span>
            </div>
          </div>
        ))}
      </div>

      <h2 className="mt-8 mb-3 text-[1.05rem] font-bold">五月到八月的支出</h2>
      <p className="page-sub">{demo.transactions.length} 筆歷史交易，異常偵測就跑在這份資料上。</p>
      <div className="card p-4">
        <div className="flex flex-col gap-2">
          {spend.map((s) => (
            <div key={s.merchant} className="grid grid-cols-[minmax(7rem,11rem)_1fr_5rem] items-center gap-3">
              <span className="text-[0.83rem]">{s.merchant}</span>
              <span className="h-2.5 bg-[var(--color-surface-2)]">
                <span
                  className="block h-full bg-[var(--color-celadon)]"
                  style={{ width: `${(s.total / maxSpend) * 100}%` }}
                />
              </span>
              <span className="mono text-right text-[0.8rem] text-[var(--color-ink-2)]">
                {s.total.toLocaleString('zh-TW')}
              </span>
            </div>
          ))}
        </div>
      </div>

      <h2 className="mt-8 mb-1 text-[1.05rem] font-bold">稽核軌跡</h2>
      <p className="page-sub">
        每一筆把前一筆的雜湊包進自己的雜湊裡。改動任何一筆，之後所有的雜湊都對不上。
        這不是防竄改 —— 本機檔案擋不住有權限的人 —— 是讓竄改一定留下痕跡。
        證據讀的是 <span className="mono">{AUDIT_FILE.split(/[\/]/).slice(-2).join('/')}</span>，不是記憶體。
      </p>

      {events.length === 0 ? (
        <div className="card p-5 text-[0.88rem] text-[var(--color-ink-2)]">
          還沒有稽核事件。去阿嬤頁拍一張帳單，或在門神軌跡頁按任何一顆按鈕。
        </div>
      ) : (
        <>
          <div
            className="card p-4"
            style={{
              borderLeft: `4px solid ${verdict.ok ? 'var(--color-celadon)' : 'var(--color-cinnabar)'}`,
            }}
          >
            <div className="label" style={{ color: verdict.ok ? 'var(--color-celadon)' : 'var(--color-cinnabar)' }}>
              {verdict.ok ? '鏈接完整' : '鏈接斷了'}
            </div>
            <p className="mt-1 text-[0.88rem]">
              {verdict.ok
                ? `${verdict.length} 筆事件，每一筆的雜湊都接得上前一筆。`
                : `第 ${verdict.brokenAt} 筆開始對不上。${verdict.detail}`}
            </p>
            {badLines.length > 0 && (
              <p className="mt-1 text-[0.82rem] text-[var(--color-cinnabar)]">
                另有 {badLines.length} 行讀不出來（第 {badLines.join('、')} 行），檔案被改壞了。
              </p>
            )}
          </div>

          <div className="scroll-x card mt-3">
            <table className="grid">
              <thead>
                <tr>
                  <th className="num">#</th>
                  <th>時間</th>
                  <th>類型</th>
                  <th>誰</th>
                  <th>摘要</th>
                  <th>雜湊</th>
                </tr>
              </thead>
              <tbody>
                {events.map((e) => {
                  const broken = !verdict.ok && e.seq >= verdict.brokenAt;
                  return (
                    <tr key={e.id} style={broken ? { color: 'var(--color-cinnabar)' } : undefined}>
                      <td className="num mono">{e.seq}</td>
                      <td className="mono text-[0.75rem]">{e.ts.slice(11, 19)}</td>
                      <td className="mono">{e.type}</td>
                      <td>{e.actor}</td>
                      <td>{e.summary}</td>
                      <td className="mono text-[0.72rem]" title={e.hash}>
                        {e.hash.slice(0, 10)}…
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </>
      )}

      <div className="todo mt-6">
        週報的數字目前直接讀自劇本的期望值，用來當作 M5.1 與 M5.2 的驗收標準。
        異常規則實作完成後，這四張卡片會改成真的算出來的結果，數字必須一模一樣。
        <br />
        想自己驗？把 <span className="mono">data/audit.jsonl</span> 裡任何一筆的
        <span className="mono"> summary </span>改一個字，重新整理這一頁，
        它會告訴你斷在第幾筆。
      </div>
    </main>
  );
}
