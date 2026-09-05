import { keccak256, toBytes } from 'viem';
import { assetNetworkFor, currentChainMode, intentHash } from '@/lib/intent';
import type { DemoData, Payee, Policy } from '@/lib/types';
import type { PayArgs } from '@/lib/wallet';

/**
 * 紅隊按鈕：**跳過整條政策管線**，直接拿 operator 的鑰匙打錢包。
 *
 * 等於假設門神已經被完全攻破 —— 解析被騙、風險模型被說服、政策引擎被繞過。
 * 錢還是出不去，而且擋下來的那句話不是門神講的，是合約 revert 出來的。
 *
 * 這個檔案存在的理由是**它本來有兩份**：`/api/redteam` 一份、`wallet/actions.ts` 一份，
 * 內容幾乎逐字相同。加第五顆按鈕時要改兩個地方，而漏掉一邊的後果是兩顆按鈕
 * 名字一樣、行為不同 —— 在舞台上那是最糟的一種 bug。
 */

export type Attack = 'not_allowlisted' | 'over_cap' | 'replay' | 'expired' | 'forged_memo';

export const ATTACKS: Record<Attack, string> = {
  not_allowlisted: '把錢付給名單外的陌生帳戶',
  over_cap: '一次付出遠超過單筆上限的金額',
  replay: '把剛剛成功的那筆重送一次',
  expired: '拿一份已經過期的授權去付款',
  forged_memo: '付一筆錢，但在紀錄上寫成另一筆',
};

export function isAttack(v: unknown): v is Attack {
  return typeof v === 'string' && v in ATTACKS;
}

/** 每次按都換一個任務代號，否則第二次按下去演的會是防重放，不是原本那一條。 */
function freshTaskId(): string {
  return `redteam-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * 組出一次攻擊要送給錢包的參數。
 *
 * 注意 `memoHash` 是**算出來的**，不是隨便給一串亂數。合約現在會用
 * `(payee, amount, taskIdHash, assetNetworkHash)` 重算一次再比對，隨便給的話
 * 四顆按鈕會全部撞上 `IntentMismatch`，演不出各自要演的那一條。
 *
 * `forged_memo` 是唯一刻意給錯的：它送一把**合法但描述另一筆付款**的 memoHash。
 */
export function buildAttack(
  attack: Attack,
  ctx: { demo: DemoData; policy: Policy; now: Date },
): { args: PayArgs; label: string } | { error: string } {
  const allowlisted = ctx.demo.payees.find((p) => p.allowlisted);
  if (!allowlisted) return { error: '劇本裡沒有白名單收款人，無法演示' };

  // 優先挑劇本裡的詐騙帳戶：舞台上「付給 (999) 1234-5678-9012」比
  // 「付給銀髮健身課程」有說服力得多。
  const stranger: Payee =
    ctx.demo.payees.find((p) => p.kind === 'unknown') ??
    ctx.demo.payees.find((p) => !p.allowlisted) ??
    ({ ...allowlisted, id: 'stranger', allowlisted: false } as Payee);

  const future = new Date(ctx.now.getTime() + 10 * 60_000).toISOString();
  const past = new Date(ctx.now.getTime() - 60_000).toISOString();

  const taskIdHash = keccak256(toBytes(freshTaskId()));
  const assetNetworkHash = keccak256(toBytes(assetNetworkFor(currentChainMode())));

  const shape: Record<Attack, { payee: Payee; amount: number; expiresAt: string }> = {
    not_allowlisted: { payee: stranger, amount: 500, expiresAt: future },
    over_cap: { payee: allowlisted, amount: ctx.policy.perTxCap * 20, expiresAt: future },
    replay: { payee: allowlisted, amount: 100, expiresAt: future },
    expired: { payee: allowlisted, amount: 100, expiresAt: past },
    forged_memo: { payee: allowlisted, amount: 100, expiresAt: future },
  };

  const s = shape[attack];

  // 誠實的 memoHash：描述的就是這一筆。
  const honest = intentHash({
    taskIdHash,
    payee: s.payee.address,
    amount: s.amount,
    assetNetworkHash,
  });

  /*
   * 偽造的 memoHash：**合法算出來的，但算的是另一筆付款**（金額 1 元）。
   *
   * 這一顆按鈕要展示的不是「攻擊者過不了這關」—— 拿到 operator 金鑰的人
   * 當然算得出正確的雜湊。要展示的是**他算出來的那個一定描述他真正付的那筆**：
   * 想付 100 卻在鏈上記成 1，合約不接受。所以每一個 PaymentExecuted 事件裡的
   * memoHash 都可證明地對應到它自己那筆付款，稽核紀錄沒有說謊的餘地。
   */
  const forged = intentHash({
    taskIdHash,
    payee: s.payee.address,
    amount: 1,
    assetNetworkHash,
  });

  return {
    label: ATTACKS[attack],
    args: {
      payee: s.payee,
      amount: s.amount,
      memoHash: attack === 'forged_memo' ? forged : honest,
      taskIdHash,
      assetNetworkHash,
      expiresAt: s.expiresAt,
    },
  };
}
