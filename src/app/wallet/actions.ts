'use server';

import { revalidatePath } from 'next/cache';
import { loadDemo } from '@/lib/demo';
import { write } from '@/lib/execute';
import { assetNetworkFor, currentChainMode } from '@/lib/intent';
import { effectivePolicy } from '@/lib/store';
import { PolicyViolation, walletFor } from '@/lib/wallet';
import type { Payee } from '@/lib/types';

/**
 * 紅隊按鈕。
 *
 * 這一支刻意繞過政策引擎，直接拿 operator 的鑰匙去打合約 —— 也就是假設
 * **鏈下全部被攻破了**：解析被騙、風險模型被說服、政策引擎被繞過。
 * 錢還出得去嗎？
 *
 * 答案是四句 revert。這就是「政策寫在合約裡」跟「政策寫在應用層」的差別，
 * 而且它是**演出來的，不是講出來的**。
 *
 * 為什麼是 server action 而不是讓前端打 `/api/redteam`：那支端點要帶
 * `GUARDIAN_TOKEN`，而 token 不能進瀏覽器（理由同 `guardian/actions.ts`）。
 * `/api/redteam` 保留給腳本與 curl 演示，畫面走這裡。
 *
 * **旗標照樣要檢查。** 這條路徑跟 API 一樣會用 operator 金鑰送出真的交易，
 * 不能因為它長在自己站上就少一道守衛 —— 能開這一頁的人就打得到這個 action。
 */

export type Attack = 'not_allowlisted' | 'over_cap' | 'replay' | 'expired';

// 不匯出：'use server' 的檔案只能匯出 async 函式。畫面自己有一份給人看的標籤。
const ATTACKS: Record<Attack, string> = {
  not_allowlisted: '把錢付給名單外的陌生帳戶',
  over_cap: '一次付出遠超過單筆上限的金額',
  replay: '把剛剛成功的那筆重送一次',
  expired: '拿一份已經過期的授權去付款',
};

export type RedTeamResult =
  | { ok: false; error: string }
  | {
      ok: true;
      attack: Attack;
      label: string;
      blocked: boolean;
      reason?: string;
      setup?: string;
      txHash?: string;
      chainMode: string;
      attempted: { payee: string; address: string; amount: number };
    };

export async function runAttack(attack: Attack): Promise<RedTeamResult> {
  if (process.env.ENABLE_REDTEAM !== 'true') {
    return { ok: false, error: '紅隊功能沒有開啟（ENABLE_REDTEAM 不是 true）' };
  }
  if (!(attack in ATTACKS)) {
    return { ok: false, error: '不認得這種攻擊' };
  }

  const demo = loadDemo();
  const policy = effectivePolicy();
  const wallet = walletFor(policy);
  const now = new Date();

  const allowlisted = demo.payees.find((p) => p.allowlisted);
  if (!allowlisted) return { ok: false, error: '劇本裡沒有白名單收款人，無法演示' };

  // 優先挑劇本裡的詐騙帳戶：舞台上「付給 (999) 1234-5678-9012」比
  // 「付給銀髮健身課程」有說服力得多。
  const stranger: Payee =
    demo.payees.find((p) => p.kind === 'unknown') ??
    demo.payees.find((p) => !p.allowlisted) ??
    ({ ...allowlisted, id: 'stranger', allowlisted: false } as Payee);

  const future = new Date(now.getTime() + 10 * 60_000).toISOString();
  const past = new Date(now.getTime() - 60_000).toISOString();

  // 每次用不同的鍵，否則第二次按下去演到的會是防重放，而不是原本要演的那一條
  const fresh = (): `0x${string}` =>
    `0x${Date.now().toString(16).padStart(16, '0')}${Math.random().toString(16).slice(2).padEnd(48, '0')}`.slice(
      0,
      66,
    ) as `0x${string}`;

  const plan: Record<Attack, { payee: Payee; amount: number; memoHash: `0x${string}`; expiresAt: string }> = {
    not_allowlisted: { payee: stranger, amount: 500, memoHash: fresh(), expiresAt: future },
    over_cap: { payee: allowlisted, amount: policy.perTxCap * 20, memoHash: fresh(), expiresAt: future },
    replay: { payee: allowlisted, amount: 100, memoHash: fresh(), expiresAt: future },
    expired: { payee: allowlisted, amount: 100, memoHash: fresh(), expiresAt: past },
  };

  const args = plan[attack];
  const attempted = { payee: args.payee.name, address: args.payee.address, amount: args.amount };

  // 重放要先成功付一次，才有東西可以重放
  let setup: string | undefined;
  if (attack === 'replay') {
    try {
      await wallet.pay(args, now);
      setup = '先正常付了一筆（在政策範圍內），現在拿同一把冪等鍵再送一次';
    } catch (err) {
      return {
        ok: false,
        error: `連第一筆都沒付成功，無法演示重放：${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }

  try {
    const receipt = await wallet.pay(args, now);

    // 走到這裡代表防線破了。這是嚴重的事，要大聲一點。
    write({
      type: 'payment.executed',
      actor: 'chain',
      summary: `⚠ 紅隊「${ATTACKS[attack]}」竟然成功了`,
      details: { attack, txHash: receipt.txHash, amount: args.amount, source: 'redteam-ui' },
      memoHash: args.memoHash,
    });
    revalidatePath('/wallet');
    revalidatePath('/audit');

    return {
      ok: true,
      attack,
      label: ATTACKS[attack],
      blocked: false,
      txHash: receipt.txHash,
      chainMode: currentChainMode(),
      attempted,
    };
  } catch (err) {
    const reason = err instanceof PolicyViolation ? err.message : String(err);

    write({
      type: 'payment.blocked',
      actor: 'chain',
      summary: `紅隊「${ATTACKS[attack]}」被合約擋下：${reason}`,
      details: {
        attack,
        reason,
        amount: args.amount,
        chainMode: currentChainMode(),
        assetNetwork: assetNetworkFor(currentChainMode()),
        source: 'redteam-ui',
      },
      memoHash: args.memoHash,
    });
    revalidatePath('/wallet');
    revalidatePath('/audit');

    return {
      ok: true,
      attack,
      label: ATTACKS[attack],
      blocked: true,
      reason,
      setup,
      chainMode: currentChainMode(),
      attempted,
    };
  }
}
