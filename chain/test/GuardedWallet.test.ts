import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { network } from 'hardhat';

/**
 * GuardedWallet 的合約測試。
 *
 * 這一份的重點不是覆蓋率，是**每一條規則都真的擋得住**。
 * 政策寫在合約裡的意義就在這裡：就算鏈下全部被騙過去、operator 金鑰整把外洩，
 * 底下這十幾條 revert 依然成立。
 *
 * 第 9 與第 11 條合起來是演講 Slide 29 的那句話：
 * 「A timeout is an unknown outcome—not permission to pay again.」
 * 逾時重試拿到同一把冪等鍵（第 9 條擋），過期的授權本身也失效（第 11 條擋）。
 */

const { viem, networkHelpers } = await network.getOrCreate();

const PER_TX_CAP = 3000n;
const DAILY_CAP = 5000n;
const APPROVAL_THRESHOLD = 2000n;
const INITIAL_BALANCE = 100_000n;
const TTL = 900n; // 意圖效期 15 分鐘，跟鏈下的 INTENT_TTL_MS 一致

/** 測試用的冪等鍵。鏈下是 keccak256("taskId|merchant|amount|assetNetwork")。 */
function memo(n: number): `0x${string}` {
  return `0x${n.toString(16).padStart(64, '0')}`;
}

async function deploy() {
  const [guardian, operator, payee, stranger] = await viem.getWalletClients();

  const token = await viem.deployContract('TWDStable', [guardian.account.address]);
  const wallet = await viem.deployContract('GuardedWallet', [
    guardian.account.address,
    operator.account.address,
    token.address,
    { perTxCap: PER_TX_CAP, dailyCap: DAILY_CAP, approvalThreshold: APPROVAL_THRESHOLD },
  ]);

  await token.write.mint([wallet.address, INITIAL_BALANCE], { account: guardian.account });
  await wallet.write.setAllowlist([payee.account.address, true], { account: guardian.account });

  return { token, wallet, guardian, operator, payee, stranger };
}

/** 現在起算的效期。合約比的是 block.timestamp，所以要從鏈上的時間算。 */
async function soon(): Promise<bigint> {
  return BigInt(await networkHelpers.time.latest()) + TTL;
}

describe('GuardedWallet', () => {
  // ── 1 ────────────────────────────────────────────────────────────────
  it('1. 白名單內、額度內 → pay 成功，餘額與事件都正確', async () => {
    const { token, wallet, operator, payee } = await networkHelpers.loadFixture(deploy);
    const expiresAt = await soon();

    const tx = await wallet.write.pay([payee.account.address, 1200n, memo(1), expiresAt], {
      account: operator.account,
    });

    await viem.assertions.emitWithArgs(tx, wallet, 'PaymentExecuted', [
      2n ** 256n - 1n, // 直接付款沒有提案編號，用哨兵值
      payee.account.address,
      1200n,
      memo(1),
      operator.account.address,
    ]);

    assert.equal(await token.read.balanceOf([payee.account.address]), 1200n);
    assert.equal(await wallet.read.balance(), INITIAL_BALANCE - 1200n);
    assert.equal(await wallet.read.remainingToday(), DAILY_CAP - 1200n);
  });

  // ── 2 ────────────────────────────────────────────────────────────────
  it('2. 不在白名單的收款人 → revert', async () => {
    const { wallet, operator, stranger } = await networkHelpers.loadFixture(deploy);

    await viem.assertions.revertWith(
      wallet.write.pay([stranger.account.address, 100n, memo(2), await soon()], {
        account: operator.account,
      }),
      'PolicyViolation: payee not allowlisted',
    );
  });

  // ── 3 ────────────────────────────────────────────────────────────────
  it('3. 超過單筆上限 → revert', async () => {
    const { wallet, operator, payee } = await networkHelpers.loadFixture(deploy);

    await viem.assertions.revertWith(
      wallet.write.pay([payee.account.address, PER_TX_CAP + 1n, memo(3), await soon()], {
        account: operator.account,
      }),
      'PolicyViolation: per-tx cap exceeded',
    );
  });

  // ── 4 ────────────────────────────────────────────────────────────────
  it('4. 超過核准門檻 → pay revert，但 propose 走得通', async () => {
    const { wallet, operator, payee } = await networkHelpers.loadFixture(deploy);
    const amount = APPROVAL_THRESHOLD + 1n;

    await viem.assertions.revertWith(
      wallet.write.pay([payee.account.address, amount, memo(4), await soon()], {
        account: operator.account,
      }),
      'PolicyViolation: guardian approval required',
    );

    const tx = await wallet.write.propose(
      [payee.account.address, amount, memo(4), await soon(), '超過自動繳費門檻，請家人確認'],
      { account: operator.account },
    );
    await viem.assertions.emit(tx, wallet, 'PaymentProposed');
    assert.equal(await wallet.read.proposalCount(), 1n);
  });

  // ── 5 ────────────────────────────────────────────────────────────────
  it('5. 日累計超過單日上限 → revert', async () => {
    const { wallet, operator, payee } = await networkHelpers.loadFixture(deploy);

    await wallet.write.pay([payee.account.address, 2000n, memo(50), await soon()], {
      account: operator.account,
    });
    await wallet.write.pay([payee.account.address, 2000n, memo(51), await soon()], {
      account: operator.account,
    });
    assert.equal(await wallet.read.remainingToday(), 1000n);

    await viem.assertions.revertWith(
      wallet.write.pay([payee.account.address, 2000n, memo(52), await soon()], {
        account: operator.account,
      }),
      'PolicyViolation: daily cap exceeded',
    );
  });

  // ── 6 ────────────────────────────────────────────────────────────────
  it('6a. propose → approve → 真的付出去', async () => {
    const { token, wallet, guardian, operator, payee } = await networkHelpers.loadFixture(deploy);

    await wallet.write.propose(
      [payee.account.address, 2500n, memo(6), await soon(), '紅包'],
      { account: operator.account },
    );
    const tx = await wallet.write.approve([0n], { account: guardian.account });

    await viem.assertions.emit(tx, wallet, 'PaymentApproved');
    await viem.assertions.emit(tx, wallet, 'PaymentExecuted');
    assert.equal(await token.read.balanceOf([payee.account.address]), 2500n);

    // proposals() 回傳 tuple：payee, amount, memoHash, expiresAt, reason, status, createdAt
    const p = (await wallet.read.proposals([0n])) as readonly unknown[];
    assert.equal(p[5], 3); // Status.Executed
  });

  it('6b. propose → reject → 不執行，而且那把鍵之後也用不了', async () => {
    const { token, wallet, guardian, operator, payee } = await networkHelpers.loadFixture(deploy);

    await wallet.write.propose(
      [payee.account.address, 2500n, memo(60), await soon(), '可疑的轉帳'],
      { account: operator.account },
    );
    const tx = await wallet.write.reject([0n, '不認識這個人'], { account: guardian.account });

    await viem.assertions.emit(tx, wallet, 'PaymentRejected');
    assert.equal(await token.read.balanceOf([payee.account.address]), 0n);

    // 拒絕會把冪等鍵一起燒掉：代理重送一模一樣的東西不會重新排隊
    await viem.assertions.revertWith(
      wallet.write.propose(
        [payee.account.address, 2500n, memo(60), await soon(), '再試一次'],
        { account: operator.account },
      ),
      'Replay: intent already settled',
    );
  });

  // ── 7 ────────────────────────────────────────────────────────────────
  it('7. 角色分離：非 operator 不能付，非 guardian 不能核准', async () => {
    const { wallet, guardian, operator, payee, stranger } =
      await networkHelpers.loadFixture(deploy);

    // guardian 自己也不能用 operator 的入口 —— 這不是疏忽，是刻意的職責分離
    await viem.assertions.revertWith(
      wallet.write.pay([payee.account.address, 100n, memo(7), await soon()], {
        account: guardian.account,
      }),
      'Unauthorized: operator only',
    );

    await wallet.write.propose(
      [payee.account.address, 2500n, memo(70), await soon(), '待核准'],
      { account: operator.account },
    );

    for (const who of [operator, stranger]) {
      await viem.assertions.revertWith(
        wallet.write.approve([0n], { account: who.account }),
        'Unauthorized: guardian only',
      );
    }
  });

  // ── 8 ────────────────────────────────────────────────────────────────
  it('8. rotateOperator 之後，舊金鑰立刻失效', async () => {
    const { wallet, guardian, operator, payee, stranger } =
      await networkHelpers.loadFixture(deploy);

    // 換鑰匙前舊的可以用
    await wallet.write.pay([payee.account.address, 100n, memo(80), await soon()], {
      account: operator.account,
    });

    const tx = await wallet.write.rotateOperator([stranger.account.address], {
      account: guardian.account,
    });
    await viem.assertions.emitWithArgs(tx, wallet, 'OperatorRotated', [
      operator.account.address,
      stranger.account.address,
    ]);

    // 金鑰外洩時家人的第一個動作：換掉。舊的立刻付不出去。
    await viem.assertions.revertWith(
      wallet.write.pay([payee.account.address, 100n, memo(81), await soon()], {
        account: operator.account,
      }),
      'Unauthorized: operator only',
    );

    // 新的可以
    await wallet.write.pay([payee.account.address, 100n, memo(82), await soon()], {
      account: stranger.account,
    });
  });

  // ── 9 ────────────────────────────────────────────────────────────────
  it('9. 同一把冪等鍵付第二次 → revert（逾時重試不會變成第二筆付款）', async () => {
    const { token, wallet, operator, payee } = await networkHelpers.loadFixture(deploy);

    await wallet.write.pay([payee.account.address, 1200n, memo(9), await soon()], {
      account: operator.account,
    });

    await viem.assertions.revertWith(
      wallet.write.pay([payee.account.address, 1200n, memo(9), await soon()], {
        account: operator.account,
      }),
      'Replay: intent already settled',
    );

    // 只扣了一次
    assert.equal(await token.read.balanceOf([payee.account.address]), 1200n);
    assert.equal(await wallet.read.remainingToday(), DAILY_CAP - 1200n);
  });

  // ── 10 ───────────────────────────────────────────────────────────────
  it('10. 已結算的提案再核准一次 → revert', async () => {
    const { token, wallet, guardian, operator, payee } = await networkHelpers.loadFixture(deploy);

    await wallet.write.propose(
      [payee.account.address, 2500n, memo(10), await soon(), '紅包'],
      { account: operator.account },
    );
    await wallet.write.approve([0n], { account: guardian.account });

    // 家人手滑按第二次，不會付第二筆
    await viem.assertions.revertWith(
      wallet.write.approve([0n], { account: guardian.account }),
      'proposal is not pending',
    );
    assert.equal(await token.read.balanceOf([payee.account.address]), 2500n);
  });

  // ── 11 ───────────────────────────────────────────────────────────────
  it('11. 效期已過的意圖 → revert', async () => {
    const { wallet, operator, payee } = await networkHelpers.loadFixture(deploy);
    const expiresAt = BigInt(await networkHelpers.time.latest()) - 1n;

    await viem.assertions.revertWith(
      wallet.write.pay([payee.account.address, 100n, memo(11), expiresAt], {
        account: operator.account,
      }),
      'PolicyViolation: intent expired',
    );
  });

  // ── 12 ───────────────────────────────────────────────────────────────
  it('12. 提案過期之後才核准 → revert（家人半夜醒來按下去也不會付出去）', async () => {
    const { token, wallet, guardian, operator, payee } = await networkHelpers.loadFixture(deploy);

    await wallet.write.propose(
      [payee.account.address, 2500n, memo(12), await soon(), '深夜的紅包'],
      { account: operator.account },
    );

    // 快轉超過效期
    await networkHelpers.time.increase(Number(TTL) + 60);

    await viem.assertions.revertWith(
      wallet.write.approve([0n], { account: guardian.account }),
      'PolicyViolation: intent expired',
    );
    assert.equal(await token.read.balanceOf([payee.account.address]), 0n);
  });

  // ── 額外：核准的權限邊界 ─────────────────────────────────────────────

  it('13. 核准是白名單的授權來源，但繞不過單筆上限', async () => {
    const { token, wallet, guardian, operator, stranger } =
      await networkHelpers.loadFixture(deploy);

    // 不在白名單的人，經過核准付得出去 —— 家人點頭本身就是授權
    await wallet.write.propose(
      [stranger.account.address, 2500n, memo(13), await soon(), '第一次付給這個人'],
      { account: operator.account },
    );
    await wallet.write.approve([0n], { account: guardian.account });
    assert.equal(await token.read.balanceOf([stranger.account.address]), 2500n);

    // 但超過單筆上限的提案根本建不起來
    await viem.assertions.revertWith(
      wallet.write.propose(
        [stranger.account.address, PER_TX_CAP + 1n, memo(130), await soon(), '五萬'],
        { account: operator.account },
      ),
      'PolicyViolation: per-tx cap exceeded',
    );
  });

  it('14. setPolicy 不能把門檻設得比單筆上限還高', async () => {
    const { wallet, guardian } = await networkHelpers.loadFixture(deploy);

    await viem.assertions.revertWith(
      wallet.write.setPolicy([1000n, 5000n, 2000n], { account: guardian.account }),
      'approvalThreshold exceeds perTxCap',
    );

    const tx = await wallet.write.setPolicy([4000n, 6000n, 1500n], { account: guardian.account });
    await viem.assertions.emitWithArgs(tx, wallet, 'PolicyUpdated', [4000n, 6000n, 1500n]);
  });
});
