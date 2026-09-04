import LiveTrace from '@/components/LiveTrace';
import { counts } from '@/lib/store';
import { loadDemo } from '@/lib/demo';

export const dynamic = 'force-dynamic';

const PIPELINE = [
  { n: '1', phase: 'observe', fn: 'parseIntent', io: '截圖或文字 → PaymentIntent', who: 'LLM', cell: 'M1.1' },
  { n: '2', phase: 'plan', fn: 'matchPayee', io: '名稱 → 收款人（白名單／聯絡人／未知）', who: '程式碼', cell: 'M2.2' },
  { n: '3a', phase: 'tool', fn: 'ruleSignals', io: '→ 風險訊號與規則分', who: '程式碼', cell: 'M4.1' },
  { n: '3b', phase: 'tool', fn: 'llmRisk', io: '→ 模型分數、詐騙類型、兩種解釋', who: 'LLM', cell: 'M4.2' },
  { n: '4', phase: 'plan', fn: 'decide', io: '→ auto／hold／block', who: '程式碼', cell: 'M2.1' },
  { n: '5', phase: 'tool', fn: 'adapter.pay', io: '→ 付款與交易雜湊', who: 'viem 或 mock', cell: 'M2.4' },
  { n: '6', phase: 'verify', fn: 'explain', io: '→ 阿嬤語音稿與家人通知', who: '組裝', cell: 'M4.4' },
  { n: '7', phase: 'verify', fn: 'audit.append', io: '→ 稽核事件與 memoHash', who: '程式碼', cell: 'M2.4' },
];

const PHASE_COLOR: Record<string, string> = {
  observe: 'var(--color-ink-2)',
  plan: 'var(--color-ochre)',
  tool: 'var(--color-celadon)',
  verify: 'var(--color-cinnabar)',
};

export default function AgentPage() {
  const c = counts();
  const demo = loadDemo();

  return (
    <main className="page">
      <h1 className="page-title">門神軌跡</h1>
      <p className="page-sub">
        門神不是聊天機器人，是事件驅動的管線。每一個輸入觸發一次完整的決策鏈，
        七個步驟全部留下紀錄。這一頁把每一步即時推到畫面上。
      </p>

      <div className="grid gap-3 sm:grid-cols-4">
        {[
          ['收到的意圖', c.intents],
          ['產生的付款', c.payments],
          ['稽核事件', c.audit],
          ['軌跡步驟', c.trace],
        ].map(([label, n]) => (
          <div key={label as string} className="card p-4">
            <div className="label">{label}</div>
            <div className="mono mt-1 text-2xl font-bold">{n as number}</div>
          </div>
        ))}
      </div>

      <h2 className="mt-8 mb-1 text-[1.05rem] font-bold">現在正在跑的</h2>
      <p className="page-sub">
        按一顆按鈕，或在另一個分頁拍一張帳單。步驟是伺服器一步一步推過來的，
        不是等整條管線跑完才一次吐出來 —— 所以模型讀圖的那幾秒鐘，第一行早就在了。
      </p>

      <LiveTrace
        triggers={[
          { id: 'bill', label: '示範帳單', body: { scenarioId: 'electricity' } },
          ...demo.messages.map((m) => ({
            id: m.id,
            label: m.type === 'scam' ? `詐騙：${m.from}` : `正常：${m.from}`,
            body: { messageId: m.id },
          })),
        ]}
      />

      <h2 className="mt-8 mb-1 text-[1.05rem] font-bold">完整管線</h2>
      <p className="page-sub">七個步驟，每一步都標了在哪一格接上。</p>

      <div className="scroll-x card mt-3">
        <table className="grid">
          <thead>
            <tr>
              <th className="num">步</th>
              <th>階段</th>
              <th>函式</th>
              <th>輸入到輸出</th>
              <th>誰做</th>
              <th>接上</th>
            </tr>
          </thead>
          <tbody>
            {PIPELINE.map((p) => (
              <tr key={p.n}>
                <td className="num">{p.n}</td>
                <td>
                  <span className="pill" style={{ color: PHASE_COLOR[p.phase] }}>{p.phase}</span>
                </td>
                <td className="mono font-medium">{p.fn}</td>
                <td>{p.io}</td>
                <td className="text-[var(--color-ink-2)]">{p.who}</td>
                <td className="mono text-[var(--color-ink-3)]">{p.cell}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <h2 className="mt-8 mb-2 text-[1.05rem] font-bold">等著被處理的輸入</h2>
      <p className="page-sub">劇本裡的四則訊息。三則是真實話術改寫，一則是阿嬤自己的請求。</p>

      <div className="grid gap-3 sm:grid-cols-2">
        {demo.messages.map((m) => (
          <div key={m.id} className="card p-4">
            <div className="flex items-baseline justify-between gap-2">
              <span className="mono text-[0.78rem] text-[var(--color-ink-3)]">{m.from}</span>
              <span
                className="pill"
                style={{ color: m.type === 'scam' ? 'var(--color-cinnabar)' : 'var(--color-celadon)' }}
              >
                {m.type === 'scam' ? '詐騙樣本' : '正常請求'}
              </span>
            </div>
            <p className="mt-2 text-[0.85rem] leading-relaxed text-[var(--color-ink-2)]">{m.text}</p>
          </div>
        ))}
      </div>

      <div className="todo mt-6">
        直播走 <span className="mono">GET /api/events</span>（SSE）。斷線由瀏覽器自己重連，
        重連時帶著 <span className="mono">Last-Event-ID</span>，中間漏掉的會補齊。
        風險評估（M4.1／M4.2）與付款（M2.4）接上後，同一條軌跡就會長到七步。
      </div>
    </main>
  );
}
