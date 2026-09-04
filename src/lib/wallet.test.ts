import { beforeEach, describe, expect, it } from 'vitest';
import { MockWallet, PolicyViolation } from '@/lib/wallet';
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

const BAD: Payee = { ...OK, id: 'unknown_999', name: '陌生帳戶', allowlisted: false };

const NOW = new Date('2026-09-04T06:00:00.000Z');
const FUTURE = new Date('2026-09-04T06:10:00.000Z').toISOString();

let wallet: MockWallet;

function key(n: number): `0x${string}` {
  return `0x${n.toString(16).padStart(64, '0')}`;
}

beforeEach(async () => {
  wallet = new MockWallet(POLICY);
  await wallet.reset();
});

describe('mock 錢包（= 合約六道 require 的規格）', () => {
  it('一般付款成功，餘額與日累計都動了', async () => {
    const before = await wallet.balance();
    const r = await wallet.pay({ payee: OK, amount: 1200, memoHash: key(1), expiresAt: FUTURE }, NOW);

    expect(r.txHash).toMatch(/^0x[0-9a-f]{64}$/);
    expect(await wallet.balance()).toBe(before - 1200);
    expect(await wallet.spentToday(NOW)).toBe(1200);
  });

  it('過期的意圖付不出去', async () => {
    const expired = new Date('2026-09-04T05:00:00.000Z').toISOString();
    await expect(
      wallet.pay({ payee: OK, amount: 1200, memoHash: key(2), expiresAt: expired }, NOW),
    ).rejects.toThrow('PolicyViolation: intent expired');
  });

  it('同一把冪等鍵付第二次會被擋 —— 逾時不等於可以再付一次', async () => {
    await wallet.pay({ payee: OK, amount: 1200, memoHash: key(3), expiresAt: FUTURE }, NOW);
    await expect(
      wallet.pay({ payee: OK, amount: 1200, memoHash: key(3), expiresAt: FUTURE }, NOW),
    ).rejects.toThrow('Replay: intent already settled');
    // 只扣了一次
    expect(await wallet.spentToday(NOW)).toBe(1200);
  });

  it('不在白名單的收款人付不出去', async () => {
    await expect(
      wallet.pay({ payee: BAD, amount: 500, memoHash: key(4), expiresAt: FUTURE }, NOW),
    ).rejects.toThrow('PolicyViolation: payee not allowlisted');
  });

  it('超過單筆上限付不出去', async () => {
    await expect(
      wallet.pay({ payee: OK, amount: 50_000, memoHash: key(5), expiresAt: FUTURE }, NOW),
    ).rejects.toThrow('PolicyViolation: per-tx cap exceeded');
  });

  it('超過核准門檻要走核准那條路', async () => {
    await expect(
      wallet.pay({ payee: OK, amount: 2500, memoHash: key(6), expiresAt: FUTURE }, NOW),
    ).rejects.toThrow('PolicyViolation: guardian approval required');

    // 核准之後同一筆就過得去 —— 跳過的只有門檻那一道
    const r = await wallet.pay(
      { payee: OK, amount: 2500, memoHash: key(6), expiresAt: FUTURE, approved: true },
      NOW,
    );
    expect(r.txHash).toBeTruthy();
  });

  it('核准就是白名單的授權來源：新收款人核准後付得出去', async () => {
    // 「新收款人一律要家人點頭」是設計本意。家人點頭這個動作本身就是授權，
    // 否則新收款人永遠付不出去 —— 幕三的紅包就會卡死在這裡。
    await expect(
      wallet.pay({ payee: BAD, amount: 100, memoHash: key(7), expiresAt: FUTURE }, NOW),
    ).rejects.toThrow('PolicyViolation: payee not allowlisted');

    const r = await wallet.pay(
      { payee: BAD, amount: 100, memoHash: key(7), expiresAt: FUTURE, approved: true },
      NOW,
    );
    expect(r.txHash).toBeTruthy();
  });

  it('核准繞不過單筆上限、效期、防重放、單日上限', async () => {
    // 家人能同意一筆付款，不能解除長期的硬上限。要那樣得去改政策。
    await expect(
      wallet.pay(
        { payee: OK, amount: 50_000, memoHash: key(8), expiresAt: FUTURE, approved: true },
        NOW,
      ),
    ).rejects.toThrow('PolicyViolation: per-tx cap exceeded');

    const expired = new Date('2026-09-04T05:00:00.000Z').toISOString();
    await expect(
      wallet.pay(
        { payee: OK, amount: 100, memoHash: key(15), expiresAt: expired, approved: true },
        NOW,
      ),
    ).rejects.toThrow('PolicyViolation: intent expired');

    await wallet.pay({ payee: OK, amount: 100, memoHash: key(16), expiresAt: FUTURE, approved: true }, NOW);
    await expect(
      wallet.pay({ payee: OK, amount: 100, memoHash: key(16), expiresAt: FUTURE, approved: true }, NOW),
    ).rejects.toThrow('Replay: intent already settled');

    // 這裡已經付掉 100；再付 2,900 湊到 3,000，接著 2,500 就會撞單日上限 5,000
    await wallet.pay({ payee: OK, amount: 2_900, memoHash: key(17), expiresAt: FUTURE, approved: true }, NOW);
    expect(await wallet.spentToday(NOW)).toBe(3_000);
    await expect(
      wallet.pay(
        { payee: OK, amount: 2_500, memoHash: key(18), expiresAt: FUTURE, approved: true },
        NOW,
      ),
    ).rejects.toThrow('PolicyViolation: daily cap exceeded');
  });

  it('單日上限是累計的', async () => {
    await wallet.pay({ payee: OK, amount: 2000, memoHash: key(9), expiresAt: FUTURE }, NOW);
    await wallet.pay({ payee: OK, amount: 2000, memoHash: key(10), expiresAt: FUTURE }, NOW);
    expect(await wallet.spentToday(NOW)).toBe(4000);

    await expect(
      wallet.pay({ payee: OK, amount: 2000, memoHash: key(11), expiresAt: FUTURE }, NOW),
    ).rejects.toThrow('PolicyViolation: daily cap exceeded');
  });

  it('隔天日累計歸零', async () => {
    await wallet.pay({ payee: OK, amount: 2000, memoHash: key(12), expiresAt: FUTURE }, NOW);
    const tomorrow = new Date(NOW.getTime() + 86_400_000);
    expect(await wallet.spentToday(tomorrow)).toBe(0);
  });

  // --- 與 Solidity 的一個刻意差異 ---

  it('被擋下來的付款不會把冪等鍵燒掉', async () => {
    // Solidity 的 revert 會回滾 usedIntent 的寫入；JavaScript 沒有回滾，
    // 所以 mock 改成成功之後才記。否則使用者修好問題重送會被誤判成重放。
    await expect(
      wallet.pay({ payee: OK, amount: 50_000, memoHash: key(13), expiresAt: FUTURE }, NOW),
    ).rejects.toThrow(PolicyViolation);
    expect(await wallet.isSettled(key(13))).toBe(false);

    // 金額改對之後同一把鍵付得出去
    const r = await wallet.pay({ payee: OK, amount: 1500, memoHash: key(13), expiresAt: FUTURE }, NOW);
    expect(r.txHash).toBeTruthy();
    expect(await wallet.isSettled(key(13))).toBe(true);
  });

  it('餘額不夠就是付不出去', async () => {
    const big: Policy = { ...POLICY, perTxCap: 1_000_000, dailyCap: 1_000_000, approvalThreshold: 1_000_000 };
    const w = new MockWallet(big);
    await w.reset();
    await expect(
      w.pay({ payee: OK, amount: 999_999, memoHash: key(14), expiresAt: FUTURE }, NOW),
    ).rejects.toThrow('transfer failed');
  });
});
