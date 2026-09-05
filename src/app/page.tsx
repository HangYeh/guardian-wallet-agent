import { Suspense } from 'react';
import ElderConsole from '@/components/ElderConsole';
import GuardianBot from '@/components/GuardianBot';
import { effectivePolicy } from '@/lib/store';
import { loadDemo, formatTWD } from '@/lib/demo';

export const dynamic = 'force-dynamic';

export default function ElderPage() {
  const demo = loadDemo();
  const policy = effectivePolicy();
  const unpaid = demo.pendingBills.filter((b) => b.status === 'unpaid');
  const total = unpaid.reduce((s, b) => s + b.amount, 0);
  const month = new Date().toISOString().slice(0, 7);

  return (
    <main className="page">
      <section className="hero-row">
        <div>
          <span className="eyebrow">
            <span className="dot" aria-hidden="true" />
            門神在線，守著{demo.persona.elder.name}的錢包
          </span>
          <h1 className="page-title">{demo.persona.elder.name}，午安</h1>
          <p className="page-sub">
            門神在看著妳的錢包。有帳單就拍給它，收到怪怪的訊息也拿給它看。
            拿不準的事情它會先問{demo.persona.guardian.name}。
          </p>
        </div>
        <div className="bot-stage" aria-hidden="true">
          <GuardianBot size={150} />
          <div className="bot-caption">
            <span className="ok">●</span> guardian --watch wallet
          </div>
        </div>
      </section>

      {/* 操作台會讀網址上的 ?play=（劇本按鈕）；useSearchParams 要有 Suspense 邊界 */}
      <Suspense fallback={null}>
        <ElderConsole />
      </Suspense>

      <div className="mt-10">
        <span className="cli">
          <span className="prompt">$</span> guardian report <span className="flag">--month</span> {month}
        </span>
      </div>
      <h2 className="section-title">這個月的狀況</h2>

      <div className="grid gap-3 sm:grid-cols-3">
        <div className="card stat">
          <div className="label">還沒繳</div>
          <div className="stat-num">{formatTWD(total)}</div>
          <div className="stat-note">{unpaid.length} 筆帳單等門神處理</div>
        </div>
        <div className="card stat">
          <div className="label">已經擋掉</div>
          <div className="stat-num text-[var(--color-cinnabar)]">{formatTWD(demo.expectedReport.blockedScam)}</div>
          <div className="stat-note">一筆假冒健保署的轉帳</div>
        </div>
        <div className="card stat">
          <div className="label">本月守住</div>
          <div className="stat-num text-[var(--color-mint-deep)]">{formatTWD(demo.expectedReport.guardedTotal)}</div>
          <div className="stat-note">攔詐騙、退重複扣款、停用不到的訂閱</div>
        </div>
      </div>

      <div className="scroll-x card mt-4 overflow-hidden">
        <table className="grid">
          <thead>
            <tr>
              <th>要繳的帳單</th>
              <th>到期日</th>
              <th className="num">金額</th>
              <th>門神會怎麼做</th>
            </tr>
          </thead>
          <tbody>
            {unpaid.map((b) => {
              const auto = b.amount <= policy.approvalThreshold;
              return (
                <tr key={b.id}>
                  <td className="font-bold">{b.merchant}</td>
                  <td className="mono">{b.dueDate}</td>
                  <td className="num">{b.amount.toLocaleString('zh-TW')}</td>
                  <td>
                    {auto ? (
                      <span className="pill text-[var(--color-celadon)]">自動繳</span>
                    ) : (
                      <span className="pill text-[var(--color-ochre)]">問{demo.persona.guardian.name}</span>
                    )}
                    <span className="ml-2 text-[var(--color-ink-3)]">
                      {auto ? '在白名單、金額也在範圍內' : `超過 ${formatTWD(policy.approvalThreshold)} 要家人點頭`}
                    </span>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <div className="todo mt-6">
        拍帳單走視覺解析，貼訊息走規則＋模型的合成風險；結果會用語音唸出來（ElevenLabs，沒金鑰時放錄好的那幾句）。
        上面的數字全部讀自 <span className="mono">demo-data/guardian-demo.json</span>。
      </div>
    </main>
  );
}
