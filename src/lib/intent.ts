import { keccak256, toBytes } from 'viem';
import type {
  ChainMode,
  IntentSource,
  Payee,
  PaymentIntent,
  Policy,
  Transaction,
} from '@/lib/types';

/**
 * 授權信封。
 *
 * 模型只負責讀出「誰、多少、什麼時候到期」，這個檔案負責把它裝進一個
 * 受管的信封裡：六個欄位由政策決定，模型碰不到，合約只認信封上的印章。
 * 對應國泰 x402 演講的 Payment Intent 授權模型。
 */

/** Payment Intent 預設效期：15 分鐘。過期的 intent 一律不執行。 */
export const INTENT_TTL_MS = 15 * 60 * 1000;

// ---------------------------------------------------------------------------
// 冪等鍵
// ---------------------------------------------------------------------------

/**
 * 冪等鍵 = keccak256("taskId|merchant|amount|assetNetwork")。
 *
 * 同一把鍵在合約裡就是 memoHash，`GuardedWallet` 用 `usedIntent[memoHash]`
 * 擋掉第二次結算。
 *
 * 刻意「不」把 expiresAt 放進來。放進去的話，逾時重試會因為新的截止時間
 * 而得到一把新的鍵，於是同一筆錢可以付第二次 —— 那正是要防的事。
 * 效期是另一個獨立的檢查（`isIntentExpired`）：過期就重跑一次解析與政策，
 * 而重跑出來的還是同一把鍵，所以「逾時 ≠ 可以再付一次」。
 *
 * assetNetwork 進來是為了擋跨鏈重放：同一份授權不能在別條鏈上再結算一次。
 */
export function buildIdempotencyKey(args: {
  taskId: string;
  merchant: string;
  amount: number;
  assetNetwork: string;
}): `0x${string}` {
  const canonical = `${args.taskId}|${args.merchant}|${args.amount}|${args.assetNetwork}`;
  return keccak256(toBytes(canonical));
}

// ---------------------------------------------------------------------------
// 效期
// ---------------------------------------------------------------------------

/** Intent 是否已逾期。逾期就必須重新走一次解析與政策，不能直接放行。 */
export function isIntentExpired(
  intent: Pick<PaymentIntent, 'expiresAt'>,
  now: Date = new Date(),
): boolean {
  return new Date(intent.expiresAt).getTime() <= now.getTime();
}

/** 產生效期截止時間（ISO 字串）。 */
export function intentExpiry(now: Date = new Date(), ttlMs: number = INTENT_TTL_MS): string {
  return new Date(now.getTime() + ttlMs).toISOString();
}

// ---------------------------------------------------------------------------
// 資產與網路
// ---------------------------------------------------------------------------

/** CAIP-2 風格的資產識別。信封上寫明「這張授權只在這條鏈上、只對這個代幣有效」。 */
export function assetNetworkFor(mode: ChainMode = currentChainMode()): string {
  const chainId = mode === 'testnet' ? 84532 : 31337;
  return `tTWD@eip155:${chainId}`;
}

export function currentChainMode(): ChainMode {
  const m = process.env.CHAIN_MODE;
  return m === 'testnet' || m === 'local' ? m : 'mock';
}

// ---------------------------------------------------------------------------
// 任務代號
// ---------------------------------------------------------------------------

export type IntentDraft = {
  kind: 'bill' | 'transfer';
  payeeName: string;
  amount: number;
  dueDate?: string | null;
  category: string;
  confidence: number;
};

/** 台北時區的日期字串。用 UTC 會在月初凌晨把帳期算到上個月。 */
export function taipeiDate(now: Date = new Date()): string {
  return now.toLocaleDateString('en-CA', { timeZone: 'Asia/Taipei' });
}

function shortHash(s: string): string {
  return keccak256(toBytes(s.replace(/\s+/g, ''))).slice(2, 8);
}

/**
 * 推導任務代號。冪等的粒度就定在這裡。
 *
 *   帳單   `bill-2026-09-taipower`
 *          一個帳期一個任務。同一期電費解析幾次都是同一把鍵，重複繳款出不去。
 *   轉帳   `transfer-2026-09-xiaoyu-3f9a1c`
 *          後面那串是原文的雜湊。同一則請求重試多少次都是同一把鍵；
 *          真的要再包一次紅包，訊息內容不同，任務就不同。
 */
export function deriveTaskId(args: {
  kind: 'bill' | 'transfer';
  slug: string;
  period: string;
  rawText: string;
}): string {
  const base = `${args.kind}-${args.period}-${args.slug}`;
  return args.kind === 'bill' ? base : `${base}-${shortHash(args.rawText)}`;
}

function payeeSlug(payee: Payee | undefined, payeeName: string): string {
  if (payee) return payee.id.replace(/^(payee|contact|unknown)_/, '') || payee.id;
  return `x${shortHash(payeeName)}`;
}

// ---------------------------------------------------------------------------
// 組裝
// ---------------------------------------------------------------------------

/**
 * 把解析結果裝進授權信封。
 *
 * 這個函式是純的、沒有 IO，所以「模型講什麼、信封長什麼樣」這件事完全可測。
 * 注意 maxAmount：不管模型被騙去抽出多大的金額，信封上的授權額度都不會
 * 超過守護者設定的單筆上限。amount 與 maxAmount 的落差本身就是風險訊號。
 */
export function buildIntent(args: {
  draft: IntentDraft;
  rawText: string;
  source: IntentSource;
  policy: Policy;
  payee?: Payee;
  taskId?: string;
  now?: Date;
  chainMode?: ChainMode;
}): PaymentIntent {
  const now = args.now ?? new Date();
  const merchant = args.payee?.name ?? args.draft.payeeName;
  const amount = Math.max(0, Math.round(args.draft.amount));
  const assetNetwork = assetNetworkFor(args.chainMode ?? currentChainMode());

  const period = (args.draft.dueDate ?? taipeiDate(now)).slice(0, 7);
  const taskId =
    args.taskId ??
    deriveTaskId({
      kind: args.draft.kind,
      slug: payeeSlug(args.payee, args.draft.payeeName),
      period,
      rawText: args.rawText,
    });

  const idempotencyKey = buildIdempotencyKey({ taskId, merchant, amount, assetNetwork });

  return {
    id: `int_${idempotencyKey.slice(2, 10)}`,
    source: args.source,
    kind: args.draft.kind,
    payeeName: args.draft.payeeName,
    payeeId: args.payee?.id,
    amount,
    dueDate: args.draft.dueDate ?? undefined,
    category: args.draft.category,
    rawText: args.rawText,
    confidence: args.draft.confidence,

    taskId,
    resource:
      args.draft.kind === 'bill' ? `${merchant} ${period} 帳單` : `轉帳給 ${merchant}`,
    merchant,
    maxAmount: Math.min(amount, args.policy.perTxCap),
    assetNetwork,
    expiresAt: intentExpiry(now),
    idempotencyKey,
  };
}

/** 意圖在帳本上的投影。週報的異常規則跑在這種資料上。 */
export function intentToTransaction(intent: PaymentIntent, payee?: Payee): Transaction {
  const recurring = payee
    ? ['utility', 'telecom', 'subscription', 'care'].includes(payee.kind)
    : false;

  return {
    id: `tx_${intent.idempotencyKey.slice(2, 10)}`,
    date: intent.dueDate ?? taipeiDate(),
    merchant: intent.merchant,
    amount: intent.amount,
    category: intent.category,
    recurring,
    note: intent.resource,
    source: intent.source === 'image' ? 'image' : 'text',
  };
}
