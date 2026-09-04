import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  createPublicClient,
  createWalletClient,
  defineChain,
  http,
  type Address,
  type PublicClient,
  type WalletClient,
} from 'viem';
import { mnemonicToAccount, privateKeyToAccount } from 'viem/accounts';
import { PolicyViolation, type PayArgs, type PayReceipt, type WalletAdapter } from '@/lib/wallet';
import type { ChainMode } from '@/lib/types';

/**
 * 真正上鏈的 adapter。local 與 testnet 共用這一份，只有 RPC 與金鑰來源不同。
 *
 * 合約的 revert 訊息刻意跟 mock 一字不差，所以畫面不需要為了三種模式維護三套翻譯。
 * 換句話說：**demo 在 mock 模式看到的那句「PolicyViolation: payee not allowlisted」，
 * 就是合約真的吐出來的那一句。**
 */

/** 本地鏈的標準助記詞，跟 hardhat.config.ts 同一組。這是公開的測試助記詞，不是祕密。 */
const HARDHAT_MNEMONIC = 'test test test test test test test test test test test junk';

const LOCAL_RPC = process.env.LOCAL_RPC_URL ?? 'http://127.0.0.1:8645';

/**
 * 兩條鏈都自己定義。
 *
 * viem 內建的 `baseSepolia` 帶 OP-stack 的型別（多幾種交易型別），
 * 跟本地鏈的型別在同一個 class 欄位裡會互斥。我們只做最普通的合約呼叫，
 * 用一致的定義就好 —— 少一個型別體操，也少一個看不懂的編譯錯誤。
 */
const hardhatLocal = defineChain({
  id: 31337,
  name: 'Hardhat',
  nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  rpcUrls: { default: { http: [LOCAL_RPC] } },
});

const baseSepolia = defineChain({
  id: 84532,
  name: 'Base Sepolia',
  nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  rpcUrls: { default: { http: ['https://sepolia.base.org'] } },
  blockExplorers: { default: { name: 'BaseScan', url: 'https://sepolia.basescan.org' } },
  testnet: true,
});

/** 只放 app 會呼叫到的部分。完整 ABI 在 chain/artifacts，那個目錄不進版控。 */
const WALLET_ABI = [
  {
    type: 'function',
    name: 'pay',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'payee', type: 'address' },
      { name: 'amount', type: 'uint256' },
      { name: 'memoHash', type: 'bytes32' },
      { name: 'expiresAt', type: 'uint256' },
    ],
    outputs: [],
  },
  {
    type: 'function',
    name: 'propose',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'payee', type: 'address' },
      { name: 'amount', type: 'uint256' },
      { name: 'memoHash', type: 'bytes32' },
      { name: 'expiresAt', type: 'uint256' },
      { name: 'reason', type: 'string' },
    ],
    outputs: [{ name: 'proposalId', type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'balance',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'remainingToday',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'spentByDay',
    stateMutability: 'view',
    inputs: [{ type: 'uint256' }],
    outputs: [{ type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'usedIntent',
    stateMutability: 'view',
    inputs: [{ type: 'bytes32' }],
    outputs: [{ type: 'bool' }],
  },
  {
    type: 'function',
    name: 'policy',
    stateMutability: 'view',
    inputs: [],
    outputs: [
      { name: 'perTxCap', type: 'uint256' },
      { name: 'dailyCap', type: 'uint256' },
      { name: 'approvalThreshold', type: 'uint256' },
    ],
  },
  {
    type: 'function',
    name: 'operator',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ type: 'address' }],
  },
] as const;

export type Deployment = {
  network: string;
  chainId: number;
  guardian: Address;
  operator: Address;
  token: Address;
  wallet: Address;
  deployedAt: string;
};

/** 部署紀錄。`.env` 的位址優先，因為現場改設定比重跑部署快。 */
export function loadDeployment(mode: ChainMode): Deployment | undefined {
  const file = mode === 'testnet' ? 'baseSepolia.json' : 'localhost.json';
  let record: Partial<Deployment> = {};
  try {
    record = JSON.parse(
      readFileSync(/*turbopackIgnore: true*/ join(process.cwd(), 'chain', 'deployments', file), 'utf8'),
    ) as Deployment;
  } catch {
    // 沒部署過就只能靠 .env
  }

  const wallet = (process.env.WALLET_ADDRESS || record.wallet) as Address | undefined;
  const token = (process.env.TOKEN_ADDRESS || record.token) as Address | undefined;
  if (!wallet || !token) return undefined;

  return {
    network: record.network ?? mode,
    chainId: record.chainId ?? (mode === 'testnet' ? 84532 : 31337),
    guardian: record.guardian ?? ('0x' as Address),
    operator: record.operator ?? ('0x' as Address),
    token,
    wallet,
    deployedAt: record.deployedAt ?? '',
  };
}

/**
 * operator 的簽章帳戶。
 *
 * local  → 公開測試助記詞的帳戶 #1，跟 hardhat.config 與部署腳本是同一把
 * testnet→ `.env` 的 OPERATOR_PRIVATE_KEY，比賽現產的專用金鑰
 *
 * guardian 的金鑰**不放進這裡**。這一層只做代付，改政策與核准是另一條路徑，
 * 金鑰分層的意義就在於這兩把不會同時出現在同一個模組裡。
 */
function operatorAccount(mode: ChainMode) {
  if (mode === 'testnet') {
    const key = process.env.OPERATOR_PRIVATE_KEY?.trim();
    if (!/^0x[0-9a-fA-F]{64}$/.test(key ?? '')) {
      throw new Error('testnet 模式要在 .env 設 OPERATOR_PRIVATE_KEY');
    }
    return privateKeyToAccount(key as `0x${string}`);
  }
  return mnemonicToAccount(HARDHAT_MNEMONIC, { addressIndex: 1 });
}

/** 合約用的日索引：`block.timestamp / 1 days`。鏈上鏈下要算出同一個「今天」。 */
function dayIndex(now: Date): bigint {
  return BigInt(Math.floor(now.getTime() / 86_400_000));
}

/**
 * 把 viem 的錯誤壓成合約的那句 revert 訊息。
 *
 * viem 的錯誤訊息很長（含 calldata、gas、docs 連結），直接丟到畫面上是災難。
 * 我們只要那一句 require 字串 —— 那句話本來就是寫給人看的。
 */
function toPolicyViolation(err: unknown): PolicyViolation {
  const text = err instanceof Error ? `${err.message}` : String(err);
  const m =
    text.match(/reverted with the following reason:\s*\n?(.+)/) ??
    text.match(/reason:\s*(.+)/) ??
    text.match(/(PolicyViolation:[^\n"]+|Replay:[^\n"]+|Unauthorized:[^\n"]+|transfer failed)/);
  const reason = m?.[1]?.trim();
  return new PolicyViolation(reason || `鏈上呼叫失敗：${text.split('\n')[0]}`);
}

export class ChainWallet implements WalletAdapter {
  readonly mode: ChainMode;
  private readonly deployment: Deployment;
  private readonly publicClient: PublicClient;
  private readonly walletClient: WalletClient;

  constructor(mode: 'local' | 'testnet', deployment: Deployment) {
    this.mode = mode;
    this.deployment = deployment;

    const chain = mode === 'testnet' ? baseSepolia : hardhatLocal;
    const url = mode === 'testnet' ? (process.env.RPC_URL ?? 'https://sepolia.base.org') : LOCAL_RPC;

    this.publicClient = createPublicClient({ chain, transport: http(url) });
    this.walletClient = createWalletClient({
      chain,
      transport: http(url),
      account: operatorAccount(mode),
    });
  }

  private read<T>(functionName: string, args: readonly unknown[] = []): Promise<T> {
    return this.publicClient.readContract({
      address: this.deployment.wallet,
      abi: WALLET_ABI,
      functionName,
      args,
    } as never) as Promise<T>;
  }

  async balance(): Promise<number> {
    return Number(await this.read<bigint>('balance'));
  }

  async spentToday(now: Date = new Date()): Promise<number> {
    return Number(await this.read<bigint>('spentByDay', [dayIndex(now)]));
  }

  async isSettled(memoHash: `0x${string}`): Promise<boolean> {
    return this.read<boolean>('usedIntent', [memoHash]);
  }

  /**
   * 送出付款並**等到收據**才回傳。
   *
   * 不等收據的話，畫面會在交易還沒進區塊時就顯示「已繳」——
   * 那正是演講 Slide 29 說的「逾時是結果未知」。我們寧可讓使用者多等兩秒。
   */
  async pay(args: PayArgs, now: Date = new Date()): Promise<PayReceipt> {
    void now;
    const account = this.walletClient.account!;

    try {
      // 先模擬。這樣 revert 在送出之前就會被抓到，不會白花 gas，
      // 而且拿得到那句人看得懂的 require 訊息。
      const { request } = await this.publicClient.simulateContract({
        address: this.deployment.wallet,
        abi: WALLET_ABI,
        functionName: 'pay',
        args: [
          args.payee.address,
          BigInt(args.amount),
          args.memoHash,
          BigInt(Math.floor(new Date(args.expiresAt).getTime() / 1000)),
        ],
        account,
      });

      const txHash = await this.walletClient.writeContract(request);
      const receipt = await this.publicClient.waitForTransactionReceipt({ hash: txHash });

      if (receipt.status !== 'success') {
        throw new PolicyViolation('交易被鏈上回退');
      }

      return {
        txHash,
        blockNumber: Number(receipt.blockNumber),
        explorerUrl: this.explorerUrl(txHash),
      };
    } catch (err) {
      if (err instanceof PolicyViolation) throw err;
      throw toPolicyViolation(err);
    }
  }

  /**
   * 鏈上狀態沒辦法從應用層重置 —— 已經送出的交易就是送出了。
   * 舞台上要乾淨的狀態就重跑一次部署（`npm run chain:deploy`），
   * 或者切回 mock 模式。這裡不假裝成功。
   */
  async reset(): Promise<void> {
    // 刻意留空：呼叫端的一鍵重置只清鏈下狀態，不會誤以為鏈上也回到起點。
  }

  explorerUrl(txHash: string): string | undefined {
    if (this.mode !== 'testnet') return undefined;
    const base = process.env.EXPLORER_BASE ?? 'https://sepolia.basescan.org';
    return `${base}/tx/${txHash}`;
  }

  get addresses(): Deployment {
    return this.deployment;
  }
}
