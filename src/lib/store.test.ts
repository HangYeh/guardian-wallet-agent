import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { keccak256, toBytes } from 'viem';
import { loadDemo } from '@/lib/demo';
import { intentHash } from '@/lib/intent';
import { effectivePolicy, resetAll, setAllowlisted, state, updatePolicy } from '@/lib/store';
import { MockWallet, type PayArgs } from '@/lib/wallet';

/**
 * 執行期政策覆寫。
 *
 * 這一塊壞掉的樣子很難察覺：守護者改了上限，畫面顯示新的、判斷卻用舊的，
 * 看起來就是「改了沒用」。所以每一條都在確認**同一個來源**。
 */

const TMP = mkdtempSync(join(tmpdir(), 'guardian-store-'));
process.env.GUARDIAN_AUDIT_FILE = join(TMP, 'audit.jsonl');
afterAll(() => rmSync(TMP, { recursive: true, force: true }));

beforeEach(() => resetAll());

describe('執行期政策', () => {
  it('沒改過就跟劇本檔一模一樣', () => {
    expect(effectivePolicy()).toEqual(loadDemo().policy);
  });

  it('改了單筆上限，其餘欄位不動', () => {
    const before = effectivePolicy();
    const { after } = updatePolicy({ perTxCap: 9999 });

    expect(after.perTxCap).toBe(9999);
    expect(after.dailyCap).toBe(before.dailyCap);
    expect(after.approvalThreshold).toBe(before.approvalThreshold);
    expect(effectivePolicy().perTxCap).toBe(9999);
  });

  it('連續改兩次會疊加，不是後面蓋掉前面', () => {
    updatePolicy({ perTxCap: 8000 });
    updatePolicy({ dailyCap: 12_000 });

    const p = effectivePolicy();
    expect(p.perTxCap).toBe(8000);
    expect(p.dailyCap).toBe(12_000);
  });

  it('回傳的 before 是改之前的值', () => {
    const original = effectivePolicy().perTxCap;
    const { before, after } = updatePolicy({ perTxCap: original + 500 });
    expect(before.perTxCap).toBe(original);
    expect(after.perTxCap).toBe(original + 500);
  });

  it('一鍵重置會把政策也還原 —— 第二次演出不繼承第一次調過的上限', () => {
    updatePolicy({ perTxCap: 50_000, dailyCap: 99_999 });
    expect(effectivePolicy().perTxCap).toBe(50_000);

    resetAll();

    expect(effectivePolicy()).toEqual(loadDemo().policy);
    expect(state().policyOverride).toBeUndefined();
  });
});

describe('白名單增減', () => {
  it('加進去之後 effectivePolicy 看得到', () => {
    expect(effectivePolicy().allowlist).not.toContain('contact_xiaoyu');
    setAllowlisted('contact_xiaoyu', true);
    expect(effectivePolicy().allowlist).toContain('contact_xiaoyu');
  });

  it('重複加不會出現兩次', () => {
    setAllowlisted('contact_xiaoyu', true);
    setAllowlisted('contact_xiaoyu', true);
    const hits = effectivePolicy().allowlist.filter((id) => id === 'contact_xiaoyu');
    expect(hits).toHaveLength(1);
  });

  it('移出去就不在名單上了', () => {
    expect(effectivePolicy().allowlist).toContain('payee_taipower');
    setAllowlisted('payee_taipower', false);
    expect(effectivePolicy().allowlist).not.toContain('payee_taipower');
  });

  it('移除不存在的 id 不會炸，也不會動到別人', () => {
    const before = effectivePolicy().allowlist;
    setAllowlisted('沒有這個人', false);
    expect(effectivePolicy().allowlist).toEqual(before);
  });

  it('白名單的改動也會被一鍵重置還原', () => {
    setAllowlisted('contact_xiaoyu', true);
    resetAll();
    expect(effectivePolicy().allowlist).not.toContain('contact_xiaoyu');
  });
});

describe('重置與 mock 錢包的接縫', () => {
  /**
   * 這一組是回歸測試。
   *
   * `resetAll()` 把 `globalThis.__guardianWallet` 清成 undefined，而 `wallet.ts`
   * 原本在模組載入時初始化一次、之後到處寫 `g.__guardianWallet!`。那個驚嘆號
   * 騙過了型別檢查器，所以編譯與既有測試都沒有意見 —— 直到實際按下重置：
   * **下一發 intake 回 500，`Cannot read properties of undefined (reading 'spentByDay')`。**
   *
   * 沒被抓到的原因是上面那些測試按了重置，卻沒有人在重置**之後**碰錢包。
   * 所以這裡每一條都刻意是「先 resetAll，再用錢包」。
   */
  const wallet = () => new MockWallet(effectivePolicy());

  it('重置後讀日累計不會炸', async () => {
    resetAll();
    await expect(wallet().spentToday()).resolves.toBe(0);
  });

  it('重置後讀餘額不會炸，而且回到起點', async () => {
    resetAll();
    await expect(wallet().balance()).resolves.toBe(100_000);
  });

  it('重置後查冪等鍵不會炸', async () => {
    resetAll();
    await expect(wallet().isSettled(`0x${'ab'.repeat(32)}`)).resolves.toBe(false);
  });

  const TAIPOWER = {
    id: 'payee_taipower',
    name: '台灣電力公司',
    address: '0x9965507D1a55bcC2695C58ba16FB37d819B0A4dc',
    kind: 'utility',
    allowlisted: true,
  } as const;

  /** 合法的付款參數。memoHash 現在必須真的描述這一筆，不能隨手捏一串。 */
  function payArgs(taskId: string, amount = 1280): PayArgs {
    const taskIdHash = keccak256(toBytes(taskId));
    const assetNetworkHash = keccak256(toBytes('tTWD@eip155:31337'));
    return {
      payee: { ...TAIPOWER },
      amount,
      taskIdHash,
      assetNetworkHash,
      memoHash: intentHash({ taskIdHash, payee: TAIPOWER.address, amount, assetNetworkHash }),
      expiresAt: new Date(Date.now() + 600_000).toISOString(),
      approved: false,
    };
  }

  it('重置後可以直接付款 —— 這就是舞台上第二次演幕一的路徑', async () => {
    resetAll();
    const receipt = await wallet().pay(payArgs('bill-2026-09-taipower'));
    expect(receipt.txHash).toMatch(/^0x[0-9a-f]{64}$/);
    await expect(wallet().spentToday()).resolves.toBe(1280);
  });

  it('付過款再重置，日累計與防重放都回到起點（不然第二次演出會被自己擋下來）', async () => {
    const args = payArgs('bill-2026-08-taipower');
    const memoHash = args.memoHash;

    await wallet().pay(args);
    await expect(wallet().isSettled(memoHash)).resolves.toBe(true);

    resetAll();

    await expect(wallet().isSettled(memoHash)).resolves.toBe(false);
    await expect(wallet().spentToday()).resolves.toBe(0);
    await expect(wallet().pay(args)).resolves.toBeTruthy(); // 同一把鍵可以再付一次
  });
});
