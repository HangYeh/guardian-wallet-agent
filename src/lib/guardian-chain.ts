import { createPublicClient, createWalletClient, http, type PublicClient, type WalletClient } from 'viem';
import { mnemonicToAccount, privateKeyToAccount } from 'viem/accounts';
import { PolicyViolation, type GuardianAdapter, type PayReceipt } from '@/lib/wallet';
import {
  HARDHAT_MNEMONIC,
  WALLET_ABI,
  chainFor,
  explorerUrlFor,
  rpcFor,
  toPolicyViolation,
  type Deployment,
} from '@/lib/wallet-chain';
import type { ChainMode } from '@/lib/types';

/**
 * 家人那把鑰匙的鏈上實作。
 *
 * 跟 `wallet-chain.ts` 分成兩個檔案是刻意的：那邊的註解寫著「guardian 的金鑰不放進這裡」，
 * 金鑰分層的意義就在於兩把鑰匙不會出現在同一個模組裡。這裡只做兩件事 ——
 * 核准、拒絕 —— 都是合約上 `onlyGuardian` 的函式。
 *
 * 誠實的限制（規劃書 §7.6 已知缺口）：這把鑰匙**現在在伺服器上**，不在家人的裝置上。
 * 家人在守護者頁按下核准，是伺服器代簽。真實產品要的是家人裝置上的 passkey 簽章，
 * 那在路線圖裡。這一層存在的理由是先讓 propose → approve 這條路**真的走到鏈上**，
 * 而不是像 9/5 之前那樣在 mock 裡走一條合約根本沒有的捷徑。
 */

/**
 * guardian 的簽章帳戶。
 *
 * local  → 公開測試助記詞的帳戶 #0，跟部署腳本的 `wallets[0]` 是同一把
 * testnet→ `.env` 的 GUARDIAN_PRIVATE_KEY
 */
function guardianAccount(mode: ChainMode) {
  if (mode === 'testnet') {
    const key = process.env.GUARDIAN_PRIVATE_KEY?.trim();
    if (!/^0x[0-9a-fA-F]{64}$/.test(key ?? '')) {
      throw new Error('testnet 模式要在 .env 設 GUARDIAN_PRIVATE_KEY');
    }
    return privateKeyToAccount(key as `0x${string}`);
  }
  return mnemonicToAccount(HARDHAT_MNEMONIC, { addressIndex: 0 });
}

export class ChainGuardian implements GuardianAdapter {
  readonly mode: ChainMode;
  private readonly deployment: Deployment;
  private readonly publicClient: PublicClient;
  private readonly walletClient: WalletClient;

  constructor(mode: 'local' | 'testnet', deployment: Deployment) {
    this.mode = mode;
    this.deployment = deployment;

    const chain = chainFor(mode);
    const url = rpcFor(mode);
    this.publicClient = createPublicClient({ chain, transport: http(url) });
    this.walletClient = createWalletClient({
      chain,
      transport: http(url),
      account: guardianAccount(mode),
    });
  }

  /**
   * 送出並**等到收據**才回傳，理由跟 `ChainWallet.pay()` 一樣：
   * 不等收據的話，畫面會在交易還沒進區塊時就顯示「已繳」。
   */
  private async send(
    functionName: 'approve' | 'reject',
    args: readonly unknown[],
  ): Promise<{ txHash: `0x${string}`; blockNumber: number }> {
    const account = this.walletClient.account!;
    try {
      // 先模擬：revert 在送出之前就抓到，不白花 gas，也拿得到人看得懂的 require 訊息
      const { request } = await this.publicClient.simulateContract({
        address: this.deployment.wallet,
        abi: WALLET_ABI,
        functionName,
        args,
        account,
      } as never);

      const txHash = await this.walletClient.writeContract(request as never);
      const receipt = await this.publicClient.waitForTransactionReceipt({ hash: txHash });
      if (receipt.status !== 'success') {
        throw new PolicyViolation('交易被鏈上回退');
      }
      return { txHash, blockNumber: Number(receipt.blockNumber) };
    } catch (err) {
      if (err instanceof PolicyViolation) throw err;
      throw toPolicyViolation(err);
    }
  }

  async approve(proposalId: number): Promise<PayReceipt> {
    const r = await this.send('approve', [BigInt(proposalId)]);
    return { ...r, explorerUrl: explorerUrlFor(this.mode, r.txHash) };
  }

  async reject(proposalId: number, reason: string): Promise<{ txHash?: `0x${string}` }> {
    const r = await this.send('reject', [BigInt(proposalId), reason]);
    return { txHash: r.txHash };
  }
}
