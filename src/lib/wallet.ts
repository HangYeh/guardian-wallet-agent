import { keccak256, toBytes } from 'viem';
import { currentChainMode, intentHash } from '@/lib/intent';
import { ChainWallet, loadDeployment } from '@/lib/wallet-chain';
import type { ChainMode, Payee, Policy } from '@/lib/types';

/**
 * 錢包 adapter。
 *
 * 一個介面，三種實作：mock（現在）、local（Hardhat 節點）、testnet（Base Sepolia）。
 * 上層永遠只看到這個介面，所以「今天現場網路壞了改跑 mock」不是重寫，是換一行環境變數。
 *
 * mock 的重點不是「假裝有付款」，是**把合約的六道 require 原封不動照抄一遍**。
 * 這樣「政策說 auto 的每一筆，合約都不會 revert」這個不變量在合約寫出來之前
 * 就有東西在跑；紅隊按鈕也能在 mock 模式下演出真的攔截，而不是演一段動畫。
 */

export type PayArgs = {
  payee: Payee;
  amount: number;
  memoHash: `0x${string}`;
  /**
   * 意圖的 `taskId` 與 `assetNetwork` 各自的 keccak256。跑 `intentHashParts(intent)` 拿。
   *
   * 合約用這兩個加上 `(payee, amount)` 重算一次 memoHash 再比對，所以它們**必須**
   * 跟著付款一起送上鏈 —— 不是額外的中繼資料，是那把鍵的原料。
   */
  taskIdHash: `0x${string}`;
  assetNetworkHash: `0x${string}`;
  expiresAt: string;
  /**
   * 走守護者核准的那條路（合約的 propose → approve）。
   *
   * 跳過兩道：**白名單**與**核准門檻**。因為家人核准的是「這一個收款人、
   * 這一個金額」—— 那個動作本身就是白名單的授權來源，不然新收款人永遠付不出去
   * （而「新收款人要家人點頭」正是設計本意，不是漏洞）。
   *
   * 不跳過的四道：效期、防重放、單筆上限、單日上限。
   * 家人能同意一筆付款，不能解除長期的硬上限 —— 要那樣得去改政策。
   */
  approved?: boolean;
};

export type PayReceipt = {
  txHash: `0x${string}`;
  blockNumber: number;
  explorerUrl?: string;
};

/** 對應合約的 revert。訊息字串刻意跟 Solidity 那邊一字不差，畫面才不用維護兩套翻譯。 */
export class PolicyViolation extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PolicyViolation';
  }
}

/**
 * 三種實作共用的介面。全部非同步，因為鏈上實作沒辦法是同步的 ——
 * 讓 mock 也非同步，上層的程式碼在三種模式下就是同一份，不用分支。
 */
export interface WalletAdapter {
  readonly mode: ChainMode;
  balance(): Promise<number>;
  spentToday(now?: Date): Promise<number>;
  isSettled(memoHash: `0x${string}`): Promise<boolean>;
  pay(args: PayArgs, now?: Date): Promise<PayReceipt>;
  reset(): Promise<void>;
}

// ---------------------------------------------------------------------------
// mock 實作
// ---------------------------------------------------------------------------

type MockState = {
  balance: number;
  usedIntent: Set<string>;
  spentByDay: Map<number, number>;
  nonce: number;
};

const INITIAL_BALANCE = 100_000;

function emptyState(): MockState {
  return { balance: INITIAL_BALANCE, usedIntent: new Set(), spentByDay: new Map(), nonce: 0 };
}

const g = globalThis as typeof globalThis & { __guardianWallet?: MockState };

/**
 * 取 mock 錢包狀態，沒有就現做一份。
 *
 * 這裡刻意**不是**在模組載入時初始化一次、然後到處寫 `mockState()`。
 * 那個驚嘆號是在對型別檢查器說謊：`resetAll()` 會把這個全域清成 undefined，
 * 之後第一次讀就炸「Cannot read properties of undefined (reading 'spentByDay')」。
 * 實測是**重置後的第一發 intake 直接 500** —— 而重置正是舞台上每一幕之間會按的鍵。
 *
 * 改成用的時候才取：誰把它清掉都不會有人看到 undefined。
 */
function mockState(): MockState {
  return (g.__guardianWallet ??= emptyState());
}

/** 台北是 UTC+8。合約的 `TZ_OFFSET` 是同一個值。 */
const TZ_OFFSET_MS = 8 * 3_600_000;

/**
 * 某個時刻落在哪一個「台北日」。單日上限的計數桶，對應合約的 `dayIndex()`。
 *
 * 不位移的話日界線落在 UTC 午夜，也就是**台北早上八點** —— 家人設「單日上限 5,000」，
 * 實際生效的窗口卻是早上八點到隔天早上八點。而安靜時段（`policy.ts` 的 `taipeiHour`）
 * 用的是台北時間，同一份政策裡就有兩種「一天」。
 *
 * **導出給 `wallet-chain.ts` 用**：它本來自己抄了一份，於是同一個公式有三份實作
 * （Solidity 一份、這裡一份、那裡一份）。算錯桶不會爆炸，只會安靜地讀到空的計數，
 * 讓鏈下政策以為今天還沒花過錢 —— 這種錯最難發現。
 */
export function dayIndex(now: Date): number {
  return Math.floor((now.getTime() + TZ_OFFSET_MS) / 86_400_000);
}

export class MockWallet implements WalletAdapter {
  readonly mode: ChainMode = 'mock';

  constructor(private readonly policy: Policy) {}

  async balance(): Promise<number> {
    return mockState().balance;
  }

  async spentToday(now: Date = new Date()): Promise<number> {
    return mockState().spentByDay.get(dayIndex(now)) ?? 0;
  }

  async isSettled(memoHash: `0x${string}`): Promise<boolean> {
    return mockState().usedIntent.has(memoHash);
  }

  /**
   * 六道檢查，順序與訊息都照 `GuardedWallet.pay()`。
   *
   * 兩條路：`approved: false` 是 operator 直接付（六道全開）；`approved: true`
   * 是家人核准過的提案（合約的 `approve`），跳過白名單與核准門檻，其餘四道照舊。
   *
   * 一個刻意的差異：合約在檢查完防重放之後就寫 `usedIntent[memoHash] = true`，
   * 因為 Solidity 的 revert 會把那個寫入一起回滾。JavaScript 沒有回滾，
   * 所以這裡改成**成功之後才記**——否則一筆被擋下來的付款會把鍵燒掉，
   * 使用者修好問題重送反而被當成重放。
   */
  async pay(args: PayArgs, now: Date = new Date()): Promise<PayReceipt> {
    const s = mockState();

    // 第一道，順序照合約：這把 memoHash 真的描述了這筆付款嗎？
    // mock 少了這一條，mock 模式就演不出這道防線 —— 而 demo 預設跑的正是 mock。
    const expected = intentHash({
      taskIdHash: args.taskIdHash,
      payee: args.payee.address,
      amount: args.amount,
      assetNetworkHash: args.assetNetworkHash,
    });
    if (args.memoHash !== expected) {
      throw new PolicyViolation('IntentMismatch: memo does not describe this payment');
    }
    if (new Date(args.expiresAt).getTime() < now.getTime()) {
      throw new PolicyViolation('PolicyViolation: intent expired');
    }
    if (s.usedIntent.has(args.memoHash)) {
      throw new PolicyViolation('Replay: intent already settled');
    }
    if (!args.approved && !args.payee.allowlisted) {
      throw new PolicyViolation('PolicyViolation: payee not allowlisted');
    }
    if (args.amount > this.policy.perTxCap) {
      throw new PolicyViolation('PolicyViolation: per-tx cap exceeded');
    }
    if (!args.approved && args.amount > this.policy.approvalThreshold) {
      throw new PolicyViolation('PolicyViolation: guardian approval required');
    }

    const day = dayIndex(now);
    const spent = s.spentByDay.get(day) ?? 0;
    if (spent + args.amount > this.policy.dailyCap) {
      throw new PolicyViolation('PolicyViolation: daily cap exceeded');
    }
    if (s.balance < args.amount) {
      throw new PolicyViolation('transfer failed');
    }

    s.spentByDay.set(day, spent + args.amount);
    s.balance -= args.amount;
    s.usedIntent.add(args.memoHash);
    s.nonce += 1;

    return {
      txHash: keccak256(toBytes(`${args.memoHash}:${s.nonce}`)),
      blockNumber: s.nonce,
    };
  }

  async reset(): Promise<void> {
    g.__guardianWallet = emptyState();
  }
}

/**
 * 依 `CHAIN_MODE` 挑實作。
 *
 * 沒部署過、或設定不全，就**明確地退回 mock 並說出來** —— 不是靜靜地當作沒事。
 * 現場網路壞掉時要能一秒切回 mock，但畫面必須誠實顯示現在跑的是哪一種，
 * 不能讓評審以為看到的是鏈上交易。
 */
export function walletFor(policy: Policy): WalletAdapter {
  const mode = currentChainMode();
  if (mode === 'mock') return new MockWallet(policy);

  const deployment = loadDeployment(mode);
  if (!deployment) {
    console.warn(`[wallet] CHAIN_MODE=${mode} 但找不到部署位址，退回 mock`);
    return new MockWallet(policy);
  }

  try {
    return new ChainWallet(mode, deployment);
  } catch (err) {
    console.warn(`[wallet] 連不上鏈（${err instanceof Error ? err.message : err}），退回 mock`);
    return new MockWallet(policy);
  }
}
