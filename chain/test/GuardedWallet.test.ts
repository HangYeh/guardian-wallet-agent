import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { network } from 'hardhat';
import { encodeAbiParameters, keccak256, toBytes } from 'viem';

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

const NET = keccak256(toBytes('tTWD@eip155:31337'));

/** 任務代號的雜湊。同一個 n 就是同一個任務。 */
function task(n: number): `0x${string}` {
  return keccak256(toBytes(`task-${n}`));
}

/**
 * 鏈下算出來的 memoHash。
 *
 * **這裡刻意用 viem 自己算一遍，而不是呼叫合約的 `intentHash()`** ——
 * 那樣等於拿合約去驗合約，公式寫錯也驗不出來。這一份是 `src/lib/intent.ts`
 * 的 `intentHash()` 的第三份實作，下面第 14 條會把三邊釘在一起。
 */
function memoFor(payee: `0x${string}`, amount: bigint, n: number): `0x${string}` {
  return keccak256(
    encodeAbiParameters(
      [{ type: 'bytes32' }, { type: 'address' }, { type: 'uint256' }, { type: 'bytes32' }],
      [task(n), payee, amount, NET],
    ),
  );
}

/** pay() 的完整參數。memoHash 現在必須描述這一筆，不能隨手捏一串。 */
function payArgs(payee: `0x${string}`, amount: bigint, n: number, expiresAt: bigint) {
  return [payee, amount, memoFor(payee, amount, n), task(n), NET, expiresAt] as const;
}

/** propose() 的完整參數。 */
function proposeArgs(
  payee: `0x${string}`,
  amount: bigint,
  n: number,
  expiresAt: bigint,
  reason: string,
) {
  return [payee, amount, memoFor(payee, amount, n), task(n), NET, expiresAt, reason] as const;
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

    const tx = await wallet.write.pay(payArgs(payee.account.address, 1200n, 1, expiresAt), {
      account: operator.account,
    });

    await viem.assertions.emitWithArgs(tx, wallet, 'PaymentExecuted', [
      2n ** 256n - 1n, // 直接付款沒有提案編號，用哨兵值
      payee.account.address,
      1200n,
      memoFor(payee.account.address, 1200n, 1),
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
      wallet.write.pay(payArgs(stranger.account.address, 100n, 2, await soon()), {
        account: operator.account,
      }),
      'PolicyViolation: payee not allowlisted',
    );
  });

  // ── 3 ────────────────────────────────────────────────────────────────
  it('3. 超過單筆上限 → revert', async () => {
    const { wallet, operator, payee } = await networkHelpers.loadFixture(deploy);

    await viem.assertions.revertWith(
      wallet.write.pay(payArgs(payee.account.address, PER_TX_CAP + 1n, 3, await soon()), {
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
      wallet.write.pay(payArgs(payee.account.address, amount, 4, await soon()), {
        account: operator.account,
      }),
      'PolicyViolation: guardian approval required',
    );

    const tx = await wallet.write.propose(
      proposeArgs(payee.account.address, amount, 4, await soon(), '超過自動繳費門檻，請家人確認'),
      { account: operator.account },
    );
    await viem.assertions.emit(tx, wallet, 'PaymentProposed');
    assert.equal(await wallet.read.proposalCount(), 1n);
  });

  // ── 5 ────────────────────────────────────────────────────────────────
  it('5. 日累計超過單日上限 → revert', async () => {
    const { wallet, operator, payee } = await networkHelpers.loadFixture(deploy);

    await wallet.write.pay(payArgs(payee.account.address, 2000n, 50, await soon()), {
      account: operator.account,
    });
    await wallet.write.pay(payArgs(payee.account.address, 2000n, 51, await soon()), {
      account: operator.account,
    });
    assert.equal(await wallet.read.remainingToday(), 1000n);

    await viem.assertions.revertWith(
      wallet.write.pay(payArgs(payee.account.address, 2000n, 52, await soon()), {
        account: operator.account,
      }),
      'PolicyViolation: daily cap exceeded',
    );
  });

  // ── 6 ────────────────────────────────────────────────────────────────
  it('6a. propose → approve → 真的付出去', async () => {
    const { token, wallet, guardian, operator, payee } = await networkHelpers.loadFixture(deploy);

    await wallet.write.propose(
      proposeArgs(payee.account.address, 2500n, 6, await soon(), '紅包'),
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
      proposeArgs(payee.account.address, 2500n, 60, await soon(), '可疑的轉帳'),
      { account: operator.account },
    );
    const tx = await wallet.write.reject([0n, '不認識這個人'], { account: guardian.account });

    await viem.assertions.emit(tx, wallet, 'PaymentRejected');
    assert.equal(await token.read.balanceOf([payee.account.address]), 0n);

    // 拒絕會把冪等鍵一起燒掉：代理重送一模一樣的東西不會重新排隊
    await viem.assertions.revertWith(
      wallet.write.propose(
        proposeArgs(payee.account.address, 2500n, 60, await soon(), '再試一次'),
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
      wallet.write.pay(payArgs(payee.account.address, 100n, 7, await soon()), {
        account: guardian.account,
      }),
      'Unauthorized: operator only',
    );

    await wallet.write.propose(
      proposeArgs(payee.account.address, 2500n, 70, await soon(), '待核准'),
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
    await wallet.write.pay(payArgs(payee.account.address, 100n, 80, await soon()), {
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
      wallet.write.pay(payArgs(payee.account.address, 100n, 81, await soon()), {
        account: operator.account,
      }),
      'Unauthorized: operator only',
    );

    // 新的可以
    await wallet.write.pay(payArgs(payee.account.address, 100n, 82, await soon()), {
      account: stranger.account,
    });
  });

  // ── 9 ────────────────────────────────────────────────────────────────
  it('9. 同一把冪等鍵付第二次 → revert（逾時重試不會變成第二筆付款）', async () => {
    const { token, wallet, operator, payee } = await networkHelpers.loadFixture(deploy);

    await wallet.write.pay(payArgs(payee.account.address, 1200n, 9, await soon()), {
      account: operator.account,
    });

    await viem.assertions.revertWith(
      wallet.write.pay(payArgs(payee.account.address, 1200n, 9, await soon()), {
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
      proposeArgs(payee.account.address, 2500n, 10, await soon(), '紅包'),
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
      wallet.write.pay(payArgs(payee.account.address, 100n, 11, expiresAt), {
        account: operator.account,
      }),
      'PolicyViolation: intent expired',
    );
  });

  // ── 12 ───────────────────────────────────────────────────────────────
  it('12. 提案過期之後才核准 → revert（家人半夜醒來按下去也不會付出去）', async () => {
    const { token, wallet, guardian, operator, payee } = await networkHelpers.loadFixture(deploy);

    await wallet.write.propose(
      proposeArgs(payee.account.address, 2500n, 12, await soon(), '深夜的紅包'),
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
      proposeArgs(stranger.account.address, 2500n, 13, await soon(), '第一次付給這個人'),
      { account: operator.account },
    );
    await wallet.write.approve([0n], { account: guardian.account });
    assert.equal(await token.read.balanceOf([stranger.account.address]), 2500n);

    // 但超過單筆上限的提案根本建不起來
    await viem.assertions.revertWith(
      wallet.write.propose(
        proposeArgs(stranger.account.address, PER_TX_CAP + 1n, 130, await soon(), '五萬'),
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

  // ── 15：意圖綁定（9/5 加）───────────────────────────────────────────
  //
  // 在這之前 memoHash 只是一把不透明的去重鍵：合約收到就寫進 usedIntent，
  // 從不檢查它是否真的描述這次的收款人與金額。所以
  // `pay(小宇, 3000, 台電那筆的 memoHash)` 會被照付，鏈上留下一筆對不起來的紀錄。
  //
  // 補上之後能講的是：拿到 operator 金鑰的人在額度內還是能偷錢（六道 require
  // 擋的是金額，不是身分），但他**沒辦法讓鏈上的紀錄說謊**。
  // 演講 Slide 26：Signatures must bind to one task and purchase。

  it('15a. memoHash 描述另一個金額 → revert', async () => {
    const { wallet, operator, payee } = await networkHelpers.loadFixture(deploy);
    const addr = payee.account.address;

    // 想付 1200，但送一把描述「1 元」的 memoHash
    await viem.assertions.revertWith(
      wallet.write.pay(
        [addr, 1200n, memoFor(addr, 1n, 200), task(200), NET, await soon()],
        { account: operator.account },
      ),
      'IntentMismatch: memo does not describe this payment',
    );
  });

  it('15b. memoHash 描述另一個收款人 → revert', async () => {
    const { wallet, operator, payee, stranger } = await networkHelpers.loadFixture(deploy);

    await viem.assertions.revertWith(
      wallet.write.pay(
        [
          payee.account.address,
          1200n,
          memoFor(stranger.account.address, 1200n, 201),
          task(201),
          NET,
          await soon(),
        ],
        { account: operator.account },
      ),
      'IntentMismatch: memo does not describe this payment',
    );
  });

  it('15c. propose 也擋 —— 不然偽造的授權可以排隊等家人按下去', async () => {
    const { wallet, operator, payee } = await networkHelpers.loadFixture(deploy);
    const addr = payee.account.address;

    await viem.assertions.revertWith(
      wallet.write.propose(
        [addr, 2500n, memoFor(addr, 1n, 202), task(202), NET, await soon(), '紅包'],
        { account: operator.account },
      ),
      'IntentMismatch: memo does not describe this payment',
    );
  });

  it('15d. intentHash 是 public —— 評審拿稽核檔的四個欄位就能自己驗', async () => {
    const { wallet, payee } = await networkHelpers.loadFixture(deploy);
    const addr = payee.account.address;

    // 鏈上算的 == viem 算的（memoFor）== src/lib/intent.ts 的 intentHash()。
    // 三份實作釘在一起：任何一邊改了公式，這一條就紅。
    const onChain = await wallet.read.intentHash([addr, 1200n, task(300), NET]);
    assert.equal(onChain, memoFor(addr, 1200n, 300));
  });

  // ── 16：日界線（9/5 改）────────────────────────────────────────────
  //
  // 位移前 `block.timestamp / 1 days` 的日界線落在 UTC 午夜，也就是
  // **台北早上八點** —— 家人設「單日上限 5,000」，實際生效的窗口卻是
  // 早上八點到隔天早上八點。而鏈下的安靜時段用的是台北時間，
  // 同一份政策裡兩種「一天」。

  it('16a. 日界線在台北午夜，不是 UTC 午夜', async () => {
    const { wallet } = await networkHelpers.loadFixture(deploy);

    // 2026-09-05 15:59:59 UTC = 台北 9/5 23:59:59
    const beforeMidnight = 1789660799n;
    // 2026-09-05 16:00:00 UTC = 台北 9/6 00:00:00
    const afterMidnight = 1789660800n;

    const a = await wallet.read.dayIndex([beforeMidnight]);
    const b = await wallet.read.dayIndex([afterMidnight]);
    assert.equal(b, a + 1n, '台北跨午夜要換一天');

    // 台北同一天的早上八點前後不該換天（那正是位移前的錯誤行為）
    const eightAm = 1789603200n; // 2026-09-05 00:00:00 UTC = 台北 08:00
    assert.equal(await wallet.read.dayIndex([eightAm - 1n]), await wallet.read.dayIndex([eightAm]));
  });

  it('16b. 跨過台北午夜之後單日額度重置', async () => {
    const { wallet, operator, payee } = await networkHelpers.loadFixture(deploy);
    const addr = payee.account.address;

    // 每筆都在核准門檻（2,000）以內，才會走 operator 直接付的那條路
    await wallet.write.pay(payArgs(addr, 2000n, 400, await soon()), { account: operator.account });
    await wallet.write.pay(payArgs(addr, 2000n, 401, await soon()), { account: operator.account });

    // 已經用掉 4,000，再付 1,500 會超過單日的 5,000
    await viem.assertions.revertWith(
      wallet.write.pay(payArgs(addr, 1500n, 402, await soon()), { account: operator.account }),
      'PolicyViolation: daily cap exceeded',
    );

    await networkHelpers.time.increase(86_400);
    await wallet.write.pay(payArgs(addr, 100n, 403, await soon()), { account: operator.account });
    assert.equal(await wallet.read.remainingToday(), DAILY_CAP - 100n);
  });
});
