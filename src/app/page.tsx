import BillUpload from '@/components/BillUpload';
import { effectivePolicy } from '@/lib/store';
import { loadDemo, formatTWD } from '@/lib/demo';

export const dynamic = 'force-dynamic';

const PENDING_BUTTONS = [
  { icon: '🛡️', label: '這是詐騙嗎？', hint: '把可疑訊息貼進來', cell: 'M4.3' },
  { icon: '🔊', label: '叫門神唸給我聽', hint: '這個月的錢花到哪裡', cell: 'M5.3' },
];

export default function ElderPage() {
  const demo = loadDemo();
  const policy = effectivePolicy();
  const unpaid = demo.pendingBills.filter((b) => b.status === 'unpaid');
  const total = unpaid.reduce((s, b) => s + b.amount, 0);

  return (
    <main className="page">
      <h1 className="page-title">{demo.persona.elder.name}，午安</h1>
      <p className="page-sub">
        門神在看著妳的錢包。有帳單就拍給它，收到怪怪的訊息也拿給它看。
        拿不準的事情它會先問{demo.persona.guardian.name}。
      </p>

      <BillUpload />

      <div className="mt-6 grid gap-3 sm:grid-cols-2">
        {PENDING_BUTTONS.map((b) => (
          <button
            key={b.label}
            type="button"
            disabled
            className="card flex cursor-not-allowed flex-col items-start gap-1 p-5 text-left"
          >
            <span className="text-3xl" aria-hidden="true">{b.icon}</span>
            <span className="text-[1.35rem] font-bold leading-snug">{b.label}</span>
            <span className="text-[0.85rem] text-[var(--color-ink-2)]">{b.hint}</span>
            <span className="pill mt-2 text-[var(--color-ink-3)]">{b.cell} 接上</span>
          </button>
        ))}
      </div>

      <h2 className="mt-9 mb-3 text-[1.05rem] font-bold">這個月的狀況</h2>

      <div className="grid gap-3 sm:grid-cols-3">
        <div className="card p-4">
          <div className="label">還沒繳</div>
          <div className="mono mt-1 text-2xl font-bold">{formatTWD(total)}</div>
          <div className="mt-1 text-[0.82rem] text-[var(--color-ink-2)]">{unpaid.length} 筆帳單等門神處理</div>
        </div>
        <div className="card p-4">
          <div className="label">已經擋掉</div>
          <div className="mono mt-1 text-2xl font-bold text-[var(--color-cinnabar)]">
            {formatTWD(demo.expectedReport.blockedScam)}
          </div>
          <div className="mt-1 text-[0.82rem] text-[var(--color-ink-2)]">一筆假冒健保署的轉帳</div>
        </div>
        <div className="card p-4">
          <div className="label">本月守住</div>
          <div className="mono mt-1 text-2xl font-bold text-[var(--color-celadon)]">
            {formatTWD(demo.expectedReport.guardedTotal)}
          </div>
          <div className="mt-1 text-[0.82rem] text-[var(--color-ink-2)]">攔詐騙、退重複扣款、停用不到的訂閱</div>
        </div>
      </div>

      <div className="scroll-x card mt-4">
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
                  <td className="font-medium">{b.merchant}</td>
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
        拍帳單已經接上視覺解析（M1.2）。詐騙判斷走 M4.3，語音走 M5.3。
        下面的數字全部讀自 <span className="mono">demo-data/guardian-demo.json</span>。
      </div>
    </main>
  );
}
