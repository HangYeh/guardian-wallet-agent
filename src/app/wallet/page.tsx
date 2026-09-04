import { currentChainMode } from '@/lib/intent';
import { loadDemo, formatTWD } from '@/lib/demo';
import { effectivePolicy, state } from '@/lib/store';
import { walletFor } from '@/lib/wallet';
import { loadDeployment } from '@/lib/wallet-chain';

export const dynamic = 'force-dynamic';

const CHAIN_LABEL: Record<string, { name: string; desc: string; color: string }> = {
  mock: { name: '記憶體帳本', desc: '不需節點，永遠可用的備援', color: 'var(--color-ink-3)' },
  local: { name: 'Hardhat 本地鏈', desc: '舞台 demo 用，不吃現場網路', color: 'var(--color-ochre)' },
  testnet: {
    name: 'Base Sepolia',
    desc: 'chainId 84532，交易可在區塊瀏覽器查證',
    color: 'var(--color-celadon)',
  },
};

const STATUS_LABEL: Record<string, string> = {
  executed: '已付款',
  pending_approval: '等家人核准',
  blocked: '已攔截',
  rejected: '家人拒絕',
  failed: '鏈上擋下',
  scheduled: '排程中',
  approved: '已核准',
};

const STATUS_COLOR: Record<string, string> = {
  executed: 'var(--color-celadon)',
  pending_approval: 'var(--color-ochre)',
  blocked: 'var(--color-cinnabar)',
  rejected: 'var(--color-ink-2)',
  failed: 'var(--color-cinnabar)',
};

/** 合約會擋的六件事。訊息字串就是合約 require 的第二個參數，一字不差。 */
const CHECKS = [
  ['效期', 'PolicyViolation: intent expired', '過期的授權被拿來用'],
  ['防重放', 'Replay: intent already settled', '逾時重試造成的重複付款'],
  ['收款人白名單', 'PolicyViolation: payee not allowlisted', '門神被騙轉給陌生帳戶'],
  ['單筆上限', 'PolicyViolation: per-tx cap exceeded', '單次掏空'],
  ['核准門檻', 'PolicyViolation: guardian approval required', '繞過人工核准'],
  ['單日上限', 'PolicyViolation: daily cap exceeded', '分批小額掏空'],
];

export default async function WalletPage() {
  const demo = loadDemo();
  const policy = effectivePolicy();
  const mode = currentChainMode();
  const chain = CHAIN_LABEL[mode] ?? CHAIN_LABEL.mock;
  const payments = state().payments;

  // 位址與餘額都問「實際在用的那個 adapter」，不是讀環境變數猜。
  // 猜的話「畫面說 local、其實跑 mock」不會被發現 —— 而那正是最該被發現的事。
  const deployment = mode === 'mock' ? undefined : loadDeployment(mode);
  const adapter = walletFor(policy);
  const actualMode = adapter.mode;

  let balance: number | undefined;
  let spentToday: number | undefined;
  let chainError: string | undefined;
  try {
    balance = await adapter.balance();
    spentToday = await adapter.spentToday();
  } catch (err) {
    chainError = err instanceof Error ? err.message : String(err);
  }

  const explorer = process.env.EXPLORER_BASE ?? 'https://sepolia.basescan.org';

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
          <div className="mt-1 text-xl font-bold" style={{ color: chain.color }}>
            {chain.name}
          </div>
          <div className="mt-1 text-[0.8rem] text-[var(--color-ink-2)]">{chain.desc}</div>
        </div>
        <div className="card p-4">
          <div className="label">錢包餘額</div>
          <div className="mono mt-1 text-xl font-bold">
            {balance === undefined ? '讀不到' : formatTWD(balance)}
          </div>
          <div className="mt-1 text-[0.8rem] text-[var(--color-ink-2)]">tTWD 測試代幣，零小數</div>
        </div>
        <div className="card p-4">
          <div className="label">今天還能付</div>
          <div className="mono mt-1 text-xl font-bold">
            {spentToday === undefined
              ? '讀不到'
              : formatTWD(Math.max(0, policy.dailyCap - spentToday))}
          </div>
          <div className="mt-1 text-[0.8rem] text-[var(--color-ink-2)]">
            單日上限 {formatTWD(policy.dailyCap)}，已用 {formatTWD(spentToday ?? 0)}
          </div>
        </div>
      </div>

      {actualMode !== mode && (
        <div className="card mt-3 border-l-4 border-l-[var(--color-cinnabar)] p-4">
          <div className="label" style={{ color: 'var(--color-cinnabar)' }}>
            設定與實際不符
          </div>
          <p className="mt-1 text-[0.88rem]">
            <span className="mono">CHAIN_MODE={mode}</span>，但實際跑的是{' '}
            <span className="mono">{actualMode}</span> —— 通常是還沒部署，或連不上節點。
          </p>
          {chainError && (
            <p className="mono mt-1 text-[0.78rem] text-[var(--color-ink-2)]">{chainError}</p>
          )}
        </div>
      )}

      <h2 className="mt-8 mb-3 text-[1.05rem] font-bold">合約位址</h2>
      <div className="scroll-x card">
        <table className="grid">
          <thead>
            <tr>
              <th>合約</th>
              <th>用途</th>
              <th>位址</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td className="font-medium">GuardedWallet</td>
              <td className="text-[var(--color-ink-2)]">政策錢包，六道檢查全在這裡</td>
              <td className="mono text-[0.75rem]">
                {deployment?.wallet ?? (
                  <span className="text-[var(--color-ink-3)]">
                    尚未部署（npm run chain:deploy）
                  </span>
                )}
              </td>
            </tr>
            <tr>
              <td className="font-medium">TWDStable</td>
              <td className="text-[var(--color-ink-2)]">模擬新台幣的測試代幣</td>
              <td className="mono text-[0.75rem]">
                {deployment?.token ?? <span className="text-[var(--color-ink-3)]">尚未部署</span>}
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      <h2 className="mt-8 mb-3 text-[1.05rem] font-bold">合約強制的六件事</h2>
      <p className="page-sub">
        每一條都會回退交易並附上原因字串。紅隊按鈕（<span className="mono">/api/redteam</span>，
        預設關閉）會繞過政策引擎直接打合約，四種攻擊各演一次 ——
        也就是假設鏈下全部被攻破之後，錢還出不出得去。
      </p>
      <div className="scroll-x card">
        <table className="grid">
          <thead>
            <tr>
              <th>檢查</th>
              <th>失敗時的回覆</th>
              <th>擋掉什麼</th>
            </tr>
          </thead>
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
          本次執行還沒有付款。去阿嬤頁拍一張帳單，或在門神軌跡頁按任何一顆按鈕。
        </div>
      ) : (
        <div className="scroll-x card">
          <table className="grid">
            <thead>
              <tr>
                <th>收款人</th>
                <th className="num">金額</th>
                <th>狀態</th>
                <th>通道</th>
                <th>交易雜湊</th>
              </tr>
            </thead>
            <tbody>
              {payments.map((p) => (
                <tr key={p.id}>
                  <td>{p.payee.name}</td>
                  <td className="num">{p.amount.toLocaleString('zh-TW')}</td>
                  <td>
                    <span className="pill" style={{ color: STATUS_COLOR[p.status] }}>
                      {STATUS_LABEL[p.status] ?? p.status}
                    </span>
                    {p.revertReason && (
                      <span className="mono ml-2 text-[0.7rem] text-[var(--color-cinnabar)]">
                        {p.revertReason}
                      </span>
                    )}
                  </td>
                  <td className="mono text-[0.75rem]">{p.channel}</td>
                  <td className="mono text-[0.72rem]">
                    {!p.txHash ? (
                      '—'
                    ) : p.channel === 'testnet' ? (
                      <a href={explorer + '/tx/' + p.txHash} target="_blank" rel="noreferrer">
                        {p.txHash.slice(0, 18)}…
                      </a>
                    ) : (
                      <span title={p.txHash}>{p.txHash.slice(0, 18)}…</span>
                    )}
                  </td>
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
