import { loadDemo, formatTWD } from '@/lib/demo';
import { state } from '@/lib/store';

export const dynamic = 'force-dynamic';

const CHAIN_LABEL: Record<string, { name: string; desc: string; color: string }> = {
  mock: { name: '記憶體帳本', desc: '不需節點，永遠可用的備援', color: 'var(--color-ink-3)' },
  local: { name: 'Hardhat 本地鏈', desc: '舞台 demo 用，不吃現場網路', color: 'var(--color-ochre)' },
  testnet: { name: 'Base Sepolia', desc: 'chainId 84532，交易可在區塊瀏覽器查證', color: 'var(--color-celadon)' },
};

const CHECKS = [
  ['防重放', 'Replay: intent already settled', '逾時重試造成的重複付款'],
  ['收款人白名單', 'PolicyViolation: payee not allowlisted', '門神被騙轉給陌生帳戶'],
  ['單筆上限', 'PolicyViolation: per-tx cap exceeded', '單次掏空'],
  ['核准門檻', 'PolicyViolation: guardian approval required', '繞過人工核准'],
  ['單日上限', 'PolicyViolation: daily cap exceeded', '分批小額掏空'],
];

export default function WalletPage() {
  const demo = loadDemo();
  const mode = process.env.CHAIN_MODE ?? 'mock';
  const chain = CHAIN_LABEL[mode] ?? CHAIN_LABEL.mock;
  const wallet = process.env.WALLET_ADDRESS;
  const token = process.env.TOKEN_ADDRESS;
  const payments = state().payments;

  return (
    <main className="page">
      <h1 className="page-title">鏈上錢包</h1>
      <p className="page-sub">
        政策不是寫在後端，是寫在 GuardedWallet 合約裡。應用層、代理層、伺服器任何一層被攻破，
        合約照樣拒付。這一頁是那份合約的即時狀態。
      </p>

      <div className="grid gap-3 sm:grid-cols-3">
        <div className="card p-4">
          <div className="label">目前模式</div>
          <div className="mt-1 text-xl font-bold" style={{ color: chain.color }}>{chain.name}</div>
          <div className="mt-1 text-[0.8rem] text-[var(--color-ink-2)]">{chain.desc}</div>
        </div>
        <div className="card p-4">
          <div className="label">錢包餘額</div>
          <div className="mono mt-1 text-xl font-bold">{formatTWD(100000)}</div>
          <div className="mt-1 text-[0.8rem] text-[var(--color-ink-2)]">tTWD 測試代幣，零小數</div>
        </div>
        <div className="card p-4">
          <div className="label">已執行付款</div>
          <div className="mono mt-1 text-xl font-bold">{payments.length}</div>
          <div className="mt-1 text-[0.8rem] text-[var(--color-ink-2)]">本次執行期間</div>
        </div>
      </div>

      <h2 className="mt-8 mb-3 text-[1.05rem] font-bold">合約位址</h2>
      <div className="scroll-x card">
        <table className="grid">
          <thead><tr><th>合約</th><th>用途</th><th>位址</th></tr></thead>
          <tbody>
            <tr>
              <td className="font-medium">GuardedWallet</td>
              <td className="text-[var(--color-ink-2)]">政策錢包，五道檢查全在這裡</td>
              <td className="mono text-[0.75rem]">
                {wallet ?? <span className="text-[var(--color-ink-3)]">尚未部署，M3.3 本地、M3.5 測試網</span>}
              </td>
            </tr>
            <tr>
              <td className="font-medium">TWDStable</td>
              <td className="text-[var(--color-ink-2)]">模擬新台幣的測試代幣</td>
              <td className="mono text-[0.75rem]">
                {token ?? <span className="text-[var(--color-ink-3)]">尚未部署</span>}
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      <h2 className="mt-8 mb-3 text-[1.05rem] font-bold">合約強制的五件事</h2>
      <p className="page-sub">
        每一條都會回退交易並附上原因字串。舞台上的紅隊按鈕就是強制觸發第二條，
        讓評審親眼看到合約拒絕付款。
      </p>
      <div className="scroll-x card">
        <table className="grid">
          <thead><tr><th>檢查</th><th>失敗時的回覆</th><th>擋掉什麼</th></tr></thead>
          <tbody>
            {CHECKS.map(([name, msg, risk]) => (
              <tr key={name}>
                <td className="font-medium">{name}</td>
                <td className="mono text-[0.75rem] text-[var(--color-cinnabar)]">{msg}</td>
                <td className="text-[var(--color-ink-2)]">{risk}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <h2 className="mt-8 mb-3 text-[1.05rem] font-bold">交易紀錄</h2>
      {payments.length === 0 ? (
        <div className="card p-5 text-[0.88rem] text-[var(--color-ink-2)]">
          還沒有任何交易。合約在 M3.1 寫完、M3.2 測完、M3.3 部署到本地鏈，
          M3.5 再部署一份到 Base Sepolia。
        </div>
      ) : (
        <div className="scroll-x card">
          <table className="grid">
            <thead><tr><th>收款人</th><th className="num">金額</th><th>狀態</th><th>交易雜湊</th></tr></thead>
            <tbody>
              {payments.map((p) => (
                <tr key={p.id}>
                  <td>{p.payee.name}</td>
                  <td className="num">{p.amount.toLocaleString('zh-TW')}</td>
                  <td className="mono">{p.status}</td>
                  <td className="mono text-[0.72rem]">{p.txHash ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div className="todo mt-6">
        金鑰分層：守護者是根權限可改政策與撤換代理金鑰，門神 agent 只有在政策內付款的權限，
        錢包餘額本身就是受限的代理資金。三個角色的位址在
        <span className="mono"> .env </span>裡，永遠不進儲存庫。
        目前劇本共 {demo.payees.length} 個收款人已綁定 Hardhat 標準帳戶。
      </div>
    </main>
  );
}
