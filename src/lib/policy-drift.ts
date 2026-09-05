import { createPublicClient, http } from 'viem';
import type { Payee, Policy } from '@/lib/types';
import { chainFor, loadDeployment, rpcFor, WALLET_ABI } from '@/lib/wallet-chain';

/**
 * 鏈上政策 vs 鏈下政策的漂移偵測。
 *
 * 守護者在頁面上調的上限與白名單只改記憶體；合約的 `setPolicy` / `setAllowlist`
 * 應用層從沒呼叫，部署當下寫進去的值之後就凍住。9/5 決定：**偵測，不同步**。
 * 認真同步要處理「鏈下改成功、鏈上寫失敗」的半套狀態，那反而製造出更安靜的漂移。
 * 這裡做的是把合約裡的值讀出來並排，對不上就標出來、把後果講清楚。
 *
 * 只讀不寫：這個模組不碰任何金鑰。
 */

export type ChainPolicy = {
  perTxCap: number;
  dailyCap: number;
  approvalThreshold: number;
  /** 收款人地址（小寫）→ 合約白名單旗標 */
  allowlist: Record<string, boolean>;
};

/**
 * 鏈下比鏈上**寬**（looser）才會真的出事：引擎判 auto、合約 revert，寫成 `payment.reverted`。
 * 鏈下比鏈上**嚴**（tighter）鏈下先擋、合約走不到；只有代理被整個繞過時，合約才是那道比較弱的底線。
 */
export type Drift = 'none' | 'looser' | 'tighter';

export type DriftRow =
  | {
      kind: 'amount';
      key: 'perTxCap' | 'dailyCap' | 'approvalThreshold';
      label: string;
      offchain: number;
      onchain: number;
      drift: Drift;
      consequence?: string;
    }
  | {
      kind: 'allowlist';
      key: string; // payee id
      label: string; // payee name
      offchain: boolean;
      onchain: boolean;
      drift: Drift;
      consequence?: string;
    };

export type DriftReport = {
  rows: DriftRow[];
  /** 對不上的列數 */
  driftCount: number;
  /** 比對過幾個收款人的白名單旗標（一致的不列成 row，免得表格被九個「一致」淹掉） */
  allowlistChecked: number;
};

const AMOUNT_LABELS: Record<'perTxCap' | 'dailyCap' | 'approvalThreshold', string> = {
  perTxCap: '單筆上限',
  dailyCap: '單日上限',
  approvalThreshold: '核准門檻',
};

const fmt = (n: number) => n.toLocaleString('zh-TW');

/** 純函數：拿現在生效的鏈下政策，對上合約讀出來的值。 */
export function comparePolicy(offchain: Policy, payees: Payee[], onchain: ChainPolicy): DriftReport {
  const rows: DriftRow[] = [];

  for (const key of ['perTxCap', 'dailyCap', 'approvalThreshold'] as const) {
    const off = offchain[key];
    const on = onchain[key];
    // 三個都是「數字越大越寬」：鏈下大於鏈上，就是引擎會放行合約不放的金額。
    const drift: Drift = off === on ? 'none' : off > on ? 'looser' : 'tighter';
    rows.push({
      kind: 'amount',
      key,
      label: AMOUNT_LABELS[key],
      offchain: off,
      onchain: on,
      drift,
      consequence:
        drift === 'looser'
          ? `鏈下會放行到 ${fmt(off)} 元，合約只放到 ${fmt(on)} 元；中間那一段會在鏈上被擋成 payment.reverted。`
          : drift === 'tighter'
            ? `鏈下先擋在 ${fmt(off)} 元，合約走不到；但代理若被整個繞過，合約只擋到 ${fmt(on)} 元。`
            : undefined,
    });
  }

  const allow = new Set(offchain.allowlist);
  for (const p of payees) {
    const off = allow.has(p.id);
    const on = onchain.allowlist[p.address.toLowerCase()] ?? false;
    if (off === on) continue;
    rows.push({
      kind: 'allowlist',
      key: p.id,
      label: p.name,
      offchain: off,
      onchain: on,
      drift: off ? 'looser' : 'tighter',
      consequence: off
        ? `鏈下把 ${p.name} 當白名單（冷卻期過後會判自動付），合約沒有：付款會在鏈上被擋成 payment.reverted。`
        : `鏈下一律要家人核准，但合約仍讓 operator 金鑰直接付給 ${p.name}。`,
    });
  }

  return {
    rows,
    driftCount: rows.filter((r) => r.drift !== 'none').length,
    allowlistChecked: payees.length,
  };
}

/**
 * 把合約現在的政策讀出來。只用 public client，沒有帳戶、沒有簽章。
 *
 * 逾時要短：這是守護者頁的一部分，RPC 掛了頁面不能跟著掛。
 */
export async function readChainPolicy(
  mode: 'local' | 'testnet',
  payees: Payee[],
  timeoutMs = 3000,
): Promise<ChainPolicy> {
  const deployment = loadDeployment(mode);
  if (!deployment) {
    throw new Error('沒有部署紀錄（chain/deployments 或 .env 的 WALLET_ADDRESS）');
  }
  const client = createPublicClient({
    chain: chainFor(mode),
    transport: http(rpcFor(mode), { timeout: timeoutMs, retryCount: 0 }),
  });
  const read = <T>(functionName: string, args: readonly unknown[] = []) =>
    client.readContract({ address: deployment.wallet, abi: WALLET_ABI, functionName, args } as never) as Promise<T>;

  const [perTxCap, dailyCap, approvalThreshold] = await read<readonly [bigint, bigint, bigint]>('policy');
  const flags = await Promise.all(payees.map((p) => read<boolean>('allowlist', [p.address])));

  const allowlist: Record<string, boolean> = {};
  payees.forEach((p, i) => {
    allowlist[p.address.toLowerCase()] = flags[i];
  });

  return {
    perTxCap: Number(perTxCap),
    dailyCap: Number(dailyCap),
    approvalThreshold: Number(approvalThreshold),
    allowlist,
  };
}

export type DriftStatus =
  | { kind: 'mock' }
  | { kind: 'unreachable'; error: string }
  | { kind: 'ok'; report: DriftReport };

/** 給頁面用的入口：永遠不丟例外，讀不到就回 unreachable。 */
export async function detectDrift(
  mode: 'mock' | 'local' | 'testnet',
  offchain: Policy,
  payees: Payee[],
): Promise<DriftStatus> {
  if (mode === 'mock') return { kind: 'mock' };
  try {
    const onchain = await readChainPolicy(mode, payees);
    return { kind: 'ok', report: comparePolicy(offchain, payees, onchain) };
  } catch (err) {
    const text = err instanceof Error ? err.message : String(err);
    return { kind: 'unreachable', error: text.split('\n')[0].slice(0, 160) };
  }
}
