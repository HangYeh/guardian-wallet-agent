'use server';

import { revalidatePath } from 'next/cache';
import { loadDemo } from '@/lib/demo';
import { write } from '@/lib/execute';
import { assetNetworkFor, currentChainMode } from '@/lib/intent';
import { ATTACKS, buildAttack, type Attack } from '@/lib/redteam';
import { effectivePolicy } from '@/lib/store';
import { PolicyViolation, walletFor } from '@/lib/wallet';

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

// 攻擊清單與參數組裝都在 `@/lib/redteam`，跟 /api/redteam 共用同一份。
// 'use server' 的檔案只能匯出 async 函式，所以型別與標籤都從那裡 re-export 不了 ——
// 畫面直接 import `@/lib/redteam` 拿標籤。

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

  const built = buildAttack(attack, { demo, policy, now });
  if ('error' in built) return { ok: false, error: built.error };
  const { args } = built;
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
