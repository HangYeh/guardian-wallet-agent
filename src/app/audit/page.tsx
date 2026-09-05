import { auditFile, readAuditFile, verifyChain } from '@/lib/audit';
import { loadDemo, formatTWD, spendByMerchant } from '@/lib/demo';
import { blockedAttempts, buildReport, executedPayments } from '@/lib/report';
import { state } from '@/lib/store';
import type { FindingType } from '@/lib/types';

export const dynamic = 'force-dynamic';

/** 每一種發現怎麼呈現：顏色、家人要做什麼、算不算「省下來的錢」。 */
const LOOK: Record<FindingType, { action: string; color: string; counted: boolean }> = {
  duplicate_charge: { action: '可以申請退款', color: 'var(--color-cinnabar)', counted: true },
  zombie_subscription: { action: '建議退訂', color: 'var(--color-ochre)', counted: true },
  price_hike: { action: '請家人去談', color: 'var(--color-ochre)', counted: false },
  due_soon: { action: '門神會自動繳', color: 'var(--color-celadon)', counted: false },
};

export default function AuditPage() {
  const demo = loadDemo();
  // 刻意讀檔案而不是讀記憶體：檔案才是證據。
  // 有人手動改了 data/audit.jsonl，這一頁就該指出來 —— 讀記憶體是看不到的。
  const { events, badLines } = readAuditFile();
  const verdict = verifyChain(events);
  const spend = spendByMerchant(demo);
  const maxSpend = Math.max(...spend.map((s) => s.total));

  /*
   * 週報從**真的發生過的事**算出來。
   *
   * 這個數字以前是直接讀劇本檔的 `expectedReport` —— 也就是整個作品最大的那個
   * 數字是抄答案抄來的。現在 `expectedReport` 只留在 `report.test.ts` 當期望值：
   * 算出來要跟它一模一樣，對不上是測試紅，不是把畫面改成好看的數字。
   *
   * 攔截金額走記憶體裡的稽核事件（要對照 payments / intents 才知道對方開口要多少），
   * 上面那條鏈接驗證則走檔案 —— 兩者問的是不同的問題：一個是「發生了什麼」，
   * 一個是「紀錄有沒有被動過」。
   */
  const chain = state();
  const report = buildReport({
    transactions: demo.transactions,
    usage: demo.usage,
    payees: demo.payees,
    pendingBills: demo.pendingBills,
    blocked: blockedAttempts(chain),
    executed: executedPayments(chain),
  });

  return (
    <main className="page">
      <h1 className="page-title">稽核與週報</h1>
      <p className="page-sub">
        每一個決策都留下可驗證的紀錄。匯出的 JSON 就是評審可以自己檢查的證據，
        鏈上的 memoHash 與這裡的稽核事件一一對應。
      </p>

      <div className="card p-6">
        <div className="label">本月守住（{report.month.replace('-', ' 年 ')} 月）</div>
        <div className="mono mt-1 text-4xl font-bold text-[var(--color-celadon)]">
          {formatTWD(report.guardedTotal)}
        </div>
        <div className="mt-3 flex flex-wrap gap-x-6 gap-y-1 text-[0.85rem] text-[var(--color-ink-2)]">
          <span>
            攔下的詐騙 <b className="mono">{report.blockedAmount.toLocaleString('zh-TW')}</b>
          </span>
          <span>
            找回來的錢 <b className="mono">{report.savedAmount.toLocaleString('zh-TW')}</b>
          </span>
          {report.paymentsExecuted > 0 && (
            <span>
              門神代繳 <b className="mono">{report.paymentsExecuted}</b> 筆，共{' '}
              <b className="mono">{report.paidThisMonth.toLocaleString('zh-TW')}</b>
            </span>
          )}
        </div>

        <div className="mt-3 flex flex-col gap-1 text-[0.82rem] text-[var(--color-ink-3)]">
          {report.blockedCapped < report.blockedAmount && (
            <p className="max-w-[62ch]">
              那 <span className="mono">{report.blockedAmount.toLocaleString('zh-TW')}</span>{' '}
              是<b>對方開口要的</b>金額。實際上授權信封只封了{' '}
              <span className="mono">{report.blockedCapped.toLocaleString('zh-TW')}</span> 元 ——
              就算門神判錯、詐騙集團拿到簽好的授權，也只可能付出這個數。兩道防線都沒破。
            </p>
          )}
          <p className="max-w-[62ch]">
            調價與快到期只提醒、不加總，因為錢還沒真的省下來。數字誠實比數字漂亮重要。
          </p>
        </div>

        {/* 唸給長輩聽的版本。M5.3 會接語音；先把稿子攤在這裡，因為它是算出來的、不是寫死的。 */}
        <div
          className="mt-4 p-4 text-[0.95rem] leading-relaxed"
          style={{ background: 'var(--color-surface-2)', borderLeft: '3px solid var(--color-celadon)' }}
        >
          <div className="label mb-1">唸給{demo.persona.elder.name}聽的版本</div>
          {report.narrative}
        </div>
      </div>

      <h2 className="mt-8 mb-3 text-[1.05rem] font-bold">
        門神在帳單裡找到的 {report.findings.length} 件事
      </h2>
      <div className="grid gap-3 sm:grid-cols-2">
        {report.findings.map((f) => {
          const look = LOOK[f.type];
          return (
            <div key={f.id} className="card p-4">
              <div className="flex items-baseline justify-between gap-2">
                <span className="font-bold">{f.title}</span>
                <span className="mono text-lg font-bold" style={{ color: look.color }}>
                  {f.impactMonthly.toLocaleString('zh-TW')}
                </span>
              </div>
              <p className="mt-1 text-[0.83rem] text-[var(--color-ink-2)]">{f.evidence.rule}</p>
              <div className="mt-2 flex flex-wrap items-center gap-2">
                <span className="pill" style={{ color: look.color }}>
                  {look.action}
                </span>
                <span className="mono text-[0.7rem] text-[var(--color-ink-3)]">{f.type}</span>
                <span className="text-[0.7rem] text-[var(--color-ink-3)]">
                  {look.counted ? '計入本月守住' : '只提醒，不計入'}
                </span>
              </div>
              <p className="mono mt-1.5 text-[0.68rem] text-[var(--color-ink-3)]">
                依據 {f.evidence.txIds.length} 筆交易：{f.evidence.txIds.join('、')}
              </p>
            </div>
          );
        })}
      </div>

      <h2 className="mt-8 mb-3 text-[1.05rem] font-bold">歷史支出</h2>
      <p className="page-sub">
        {demo.transactions.length} 筆歷史交易，異常偵測就跑在這份資料上。最後一個有完整帳的月份是{' '}
        {report.spendMonth}，共 <span className="mono">{formatTWD(report.totalSpend)}</span>：
        {report.byCategory.map((c) => `${c.category} ${c.amount.toLocaleString('zh-TW')}`).join('、')}。
      </p>
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
        證據讀的是 <span className="mono">{auditFile().split(/[\\/]/).slice(-2).join('/')}</span>，不是記憶體。
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
        頭條那個數字是<b>算出來的</b>，不是寫死的：攔截金額來自上面這條稽核鏈，
        省下來的錢來自 <span className="mono">anomaly.ts</span> 的四條規則。
        劇本檔裡的 <span className="mono">expectedReport</span> 已經降級成測試的期望值 ——
        算出來要跟它一模一樣，對不上是 <span className="mono">report.test.ts</span> 會紅。
        <br />
        所以這一頁的數字會隨著你做的事變動：還沒跑幕二時是{' '}
        <span className="mono">NT$1,687</span>，攔下那筆詐騙之後才變成{' '}
        <span className="mono">NT$51,687</span>。紅隊按鈕不算在裡面，那是我們自己按的。
        <br />
        想自己驗？把 <span className="mono">data/audit.jsonl</span> 裡任何一筆的
        <span className="mono"> summary </span>改一個字，重新整理這一頁，
        它會告訴你斷在第幾筆。
      </div>
    </main>
  );
}
