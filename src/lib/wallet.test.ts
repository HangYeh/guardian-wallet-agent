import { keccak256, toBytes } from 'viem';
import { beforeEach, describe, expect, it } from 'vitest';
import { intentHash } from '@/lib/intent';
import { MockWallet, PolicyViolation, type PayArgs } from '@/lib/wallet';
import type { Payee, Policy } from '@/lib/types';

/**
 * mock 錢包的測試。
 *
 * 它存在的理由不是「假裝有付款」，是把合約的六道 require 照抄一遍，
 * 讓「政策說 auto 的每一筆合約都不會 revert」這個不變量在合約寫出來之前
 * 就有東西在跑。所以這裡測的其實是**合約的規格**。
 */

const POLICY: Policy = {
  perTxCap: 3000,
  dailyCap: 5000,
  approvalThreshold: 2000,
  newPayeeRequiresApproval: true,
  newPayeeCooldownHours: 24,
  quietHours: [22, 7],
  allowlist: ['payee_taipower'],
};

const OK: Payee = {
  id: 'payee_taipower',
  name: '台灣電力公司',
  address: '0x9965507D1a55bcC2695C58ba16FB37d819B0A4dc',
  kind: 'utility',
  allowlisted: true,
};

// 位址跟 OK 不一樣。本來兩個是同一個位址 —— 而冪等鍵綁的正是位址，
// 那會讓「拿別人的授權編號來付」這種測試無聲通過。
const BAD: Payee = {
  ...OK,
  id: 'unknown_999',
  name: '陌生帳戶',
  address: '0x976EA74026E726554dB657fA54763abd0C3a0aa9',
  allowlisted: false,
};

const NOW = new Date('2026-09-04T06:00:00.000Z');
const FUTURE = new Date('2026-09-04T06:10:00.000Z').toISOString();
const PAST = new Date('2026-09-04T05:00:00.000Z').toISOString();

let wallet: MockWallet;

const ASSET = 'tTWD@eip155:31337';

/**
 * 組一份**合法的**付款參數。
 *
 * 從 9/5 起 memoHash 不能隨便給：合約與 mock 都會用
 * `(payee, amount, taskIdHash, assetNetworkHash)` 重算一次再比對。
 * 所以測試不能再自己捏一串雜湊 —— 那會全部撞上 IntentMismatch，
 * 而不是撞上各自要測的那一條。
 *
 * `n` 是任務代號的種子：同一個 n 配同一個 (payee, amount) 就是同一把鍵，
 * 防重放那幾條測試靠這個性質。
 */
function pa(payee: Payee, amount: number, n: number, expiresAt = FUTURE, approved?: boolean): PayArgs {
  const taskIdHash = keccak256(toBytes(`task-${n}`));
  const assetNetworkHash = keccak256(toBytes(ASSET));
  return {
    payee,
    amount,
    taskIdHash,
    assetNetworkHash,
    expiresAt,
    approved,
    memoHash: intentHash({ taskIdHash, payee: payee.address, amount, assetNetworkHash }),
  };
}

beforeEach(async () => {
  wallet = new MockWallet(POLICY);
  await wallet.reset();
});

describe('mock 錢包（= 合約六道 require 的規格）', () => {
  it('一般付款成功，餘額與日累計都動了', async () => {
    const before = await wallet.balance();
    const r = await wallet.pay(pa(OK, 1200, 1), NOW);

    expect(r.txHash).toMatch(/^0x[0-9a-f]{64}$/);
    expect(await wallet.balance()).toBe(before - 1200);
    expect(await wallet.spentToday(NOW)).toBe(1200);
  });

  it('過期的意圖付不出去', async () => {
    const expired = new Date('2026-09-04T05:00:00.000Z').toISOString();
    await expect(
      wallet.pay(pa(OK, 1200, 2, expired), NOW),
    ).rejects.toThrow('PolicyViolation: intent expired');
  });

  it('同一把冪等鍵付第二次會被擋 —— 逾時不等於可以再付一次', async () => {
    await wallet.pay(pa(OK, 1200, 3), NOW);
    await expect(
      wallet.pay(pa(OK, 1200, 3), NOW),
    ).rejects.toThrow('Replay: intent already settled');
    // 只扣了一次
    expect(await wallet.spentToday(NOW)).toBe(1200);
  });

  it('不在白名單的收款人付不出去', async () => {
    await expect(
      wallet.pay(pa(BAD, 500, 4), NOW),
    ).rejects.toThrow('PolicyViolation: payee not allowlisted');
  });

  it('超過單筆上限付不出去', async () => {
    await expect(
      wallet.pay(pa(OK, 50_000, 5), NOW),
    ).rejects.toThrow('PolicyViolation: per-tx cap exceeded');
  });

  it('超過核准門檻要走核准那條路', async () => {
    await expect(
      wallet.pay(pa(OK, 2500, 6), NOW),
    ).rejects.toThrow('PolicyViolation: guardian approval required');

    // 核准之後同一筆就過得去 —— 跳過的只有門檻那一道
    const r = await wallet.pay(
      pa(OK, 2500, 6, FUTURE, true),
      NOW,
    );
    expect(r.txHash).toBeTruthy();
  });

  it('核准就是白名單的授權來源：新收款人核准後付得出去', async () => {
    // 「新收款人一律要家人點頭」是設計本意。家人點頭這個動作本身就是授權，
    // 否則新收款人永遠付不出去 —— 幕三的紅包就會卡死在這裡。
    await expect(
      wallet.pay(pa(BAD, 100, 7), NOW),
    ).rejects.toThrow('PolicyViolation: payee not allowlisted');

    const r = await wallet.pay(
      pa(BAD, 100, 7, FUTURE, true),
      NOW,
    );
    expect(r.txHash).toBeTruthy();
  });

  it('核准繞不過單筆上限、效期、防重放、單日上限', async () => {
    // 家人能同意一筆付款，不能解除長期的硬上限。要那樣得去改政策。
    await expect(
      wallet.pay(
        pa(OK, 50_000, 8, FUTURE, true),
        NOW,
      ),
    ).rejects.toThrow('PolicyViolation: per-tx cap exceeded');

    const expired = new Date('2026-09-04T05:00:00.000Z').toISOString();
    await expect(
      wallet.pay(
        pa(OK, 100, 15, expired, true),
        NOW,
      ),
    ).rejects.toThrow('PolicyViolation: intent expired');

    await wallet.pay(pa(OK, 100, 16, FUTURE, true), NOW);
    await expect(
      wallet.pay(pa(OK, 100, 16, FUTURE, true), NOW),
    ).rejects.toThrow('Replay: intent already settled');

    // 這裡已經付掉 100；再付 2,900 湊到 3,000，接著 2,500 就會撞單日上限 5,000
    await wallet.pay(pa(OK, 2_900, 17, FUTURE, true), NOW);
    expect(await wallet.spentToday(NOW)).toBe(3_000);
    await expect(
      wallet.pay(
        pa(OK, 2_500, 18, FUTURE, true),
        NOW,
      ),
    ).rejects.toThrow('PolicyViolation: daily cap exceeded');
  });

  it('單日上限是累計的', async () => {
    await wallet.pay(pa(OK, 2000, 9), NOW);
    await wallet.pay(pa(OK, 2000, 10), NOW);
    expect(await wallet.spentToday(NOW)).toBe(4000);

    await expect(
      wallet.pay(pa(OK, 2000, 11), NOW),
    ).rejects.toThrow('PolicyViolation: daily cap exceeded');
  });

  it('隔天日累計歸零', async () => {
    await wallet.pay(pa(OK, 2000, 12), NOW);
    const tomorrow = new Date(NOW.getTime() + 86_400_000);
    expect(await wallet.spentToday(tomorrow)).toBe(0);
  });

  // --- 與 Solidity 的一個刻意差異 ---

  it('被擋下來的付款不會把冪等鍵燒掉', async () => {
    // Solidity 的 revert 會回滾 usedIntent 的寫入；JavaScript 沒有回滾，
    // 所以 mock 改成成功之後才記。否則使用者修好問題重送會被誤判成重放。
    //
    // 這裡用**效期**當失敗原因，不是用金額：效期刻意不在雜湊裡，所以下面兩筆
    // 是同一把鍵，「同一把鍵重送」才驗得出來。金額在雜湊裡，改了就是另一把鍵了。
    const stale = { ...pa(OK, 1500, 13), expiresAt: PAST };
    const good = pa(OK, 1500, 13);
    expect(stale.memoHash).toBe(good.memoHash);

    await expect(wallet.pay(stale, NOW)).rejects.toThrow(PolicyViolation);
    expect(await wallet.isSettled(good.memoHash)).toBe(false);

    const r = await wallet.pay(good, NOW);
    expect(r.txHash).toBeTruthy();
    expect(await wallet.isSettled(good.memoHash)).toBe(true);
  });

  // --- 意圖綁定（9/5 加）---

  describe('memoHash 必須描述這一筆付款', () => {
    it('拿一把描述別筆金額的 memoHash 會被擋下', async () => {
      const forged = { ...pa(OK, 1500, 20), memoHash: pa(OK, 1, 20).memoHash };
      await expect(wallet.pay(forged, NOW)).rejects.toThrow(
        'IntentMismatch: memo does not describe this payment',
      );
    });

    it('拿一把描述別個收款人的 memoHash 也會被擋下', async () => {
      const forged = { ...pa(OK, 1500, 21), memoHash: pa(BAD, 1500, 21).memoHash };
      await expect(wallet.pay(forged, NOW)).rejects.toThrow('IntentMismatch');
    });

    it('隨便捏一串雜湊當然也不行', async () => {
      const forged = { ...pa(OK, 1500, 22), memoHash: `0x${'f'.repeat(64)}` as `0x${string}` };
      await expect(wallet.pay(forged, NOW)).rejects.toThrow('IntentMismatch');
    });

    it('這一道排在最前面 —— 連過期都還沒檢查就先擋', async () => {
      // 順序照合約。訊息不對就代表兩邊的順序走鐘了。
      const forged = { ...pa(OK, 1500, 23), memoHash: pa(OK, 1, 23).memoHash, expiresAt: PAST };
      await expect(wallet.pay(forged, NOW)).rejects.toThrow('IntentMismatch');
    });
  });

  it('餘額不夠就是付不出去', async () => {
    const big: Policy = { ...POLICY, perTxCap: 1_000_000, dailyCap: 1_000_000, approvalThreshold: 1_000_000 };
    const w = new MockWallet(big);
    await w.reset();
    await expect(
      w.pay(pa(OK, 999_999, 14), NOW),
    ).rejects.toThrow('transfer failed');
  });
});
