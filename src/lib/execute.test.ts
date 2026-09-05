import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { readAuditFile, verifyChain } from '@/lib/audit';
import { buildIntent } from '@/lib/intent';
import { approvePayment, executeIntent, write } from '@/lib/execute';
import { resetAll, state } from '@/lib/store';
import { MockWallet } from '@/lib/wallet';
import type { ParsedFields } from '@/lib/parser';
import type { Payee, Policy } from '@/lib/types';

/**
 * 執行層的測試。
 *
 * 中間三條是被實測抓出來的 bug 的回歸測試，不是憑空想的情境：
 *   1. 伺服器重啟後稽核鏈假性斷裂 —— 沒人動過任何東西，稽核頁卻說被竄改了
 *   2. 沒有收款地址的付款可以被核准 —— 錢會付到零地址，畫面還顯示「已繳」
 *   3. 提案與核准之間換了鏈，核准照樣過
 */

// 寫到暫存資料夾，不去動開發時真的在用的那一份稽核檔
const TMP = mkdtempSync(join(tmpdir(), 'guardian-audit-'));
process.env.GUARDIAN_AUDIT_FILE = join(TMP, 'audit.jsonl');

afterAll(() => rmSync(TMP, { recursive: true, force: true }));

const POLICY: Policy = {
  perTxCap: 3000,
  dailyCap: 5000,
  approvalThreshold: 2000,
  newPayeeRequiresApproval: true,
  newPayeeCooldownHours: 24,
  quietHours: undefined, // 測試不該因為跑的時間是深夜就變成 hold
  allowlist: ['payee_taipower'],
};

const TAIPOWER: Payee = {
  id: 'payee_taipower',
  name: '台灣電力公司',
  address: '0x9965507D1a55bcC2695C58ba16FB37d819B0A4dc',
  kind: 'utility',
  allowlisted: true,
};

const IMPOSTOR = '0x976EA74026E726554dB657fA54763abd0C3a0aa9' as const;

const NOW = new Date('2026-09-04T06:00:00.000Z');

/**
 * 造一份意圖。
 *
 * `payee` 預設是 TAIPOWER，**而且一定要跟等一下 `executeIntent` 收到的那個一樣** ——
 * 冪等鍵綁的是收款地址，兩邊給不同的收款人會撞上 IntentMismatch。
 * 正式管線用的是同一個變數（`api/intake/route.ts` 的 `payee`），
 * 這裡刻意讓預設值一致，免得測試用一個現實中不存在的組合。
 */
function intentFor(over: Partial<ParsedFields> = {}, payee: Payee | undefined = TAIPOWER) {
  const draft: ParsedFields = {
    kind: 'bill',
    payeeName: '台灣電力公司',
    amount: 1200,
    dueDate: '2026-09-20',
    category: 'utility',
    statedAccount: null,
    confidence: 0.95,
    evidence: '本期應繳 1,200',
    ...over,
  };
  return buildIntent({
    draft,
    rawText: `台電 ${draft.amount} ${Math.random()}`,
    source: 'image',
    policy: POLICY,
    payee,
    now: NOW,
  });
}

function wallet() {
  return new MockWallet(POLICY);
}

beforeEach(async () => {
  resetAll();
  await wallet().reset();
});

describe('執行層', () => {
  it('白名單內、額度內 → 直接付掉，稽核留下兩筆', async () => {
    const r = await executeIntent({
      intent: intentFor(),
      policy: POLICY,
      wallet: wallet(),
      payee: TAIPOWER,
      now: NOW,
    });

    expect(r.decision.action).toBe('auto');
    expect(r.payment.status).toBe('executed');
    expect(r.payment.txHash).toMatch(/^0x[0-9a-f]{64}$/);
    expect(state().audit.map((e) => e.type)).toEqual(['policy.decided', 'payment.executed']);
  });

  it('超過門檻 → 生成提案，核准之後才付', async () => {
    const intent = intentFor({ amount: 2500 });
    const r = await executeIntent({
      intent,
      policy: POLICY,
      wallet: wallet(),
      payee: TAIPOWER,
      now: NOW,
    });
    expect(r.decision.action).toBe('hold');
    expect(r.payment.status).toBe('pending_approval');

    state().intents.push(intent);
    const approved = await approvePayment(r.payment.id, {
      policy: POLICY,
      guardian: wallet(),
      intent,
      now: NOW,
    });
    expect(approved.payment.status).toBe('executed');
  });

  // --- 回歸測試 1：伺服器重啟 ---

  it('伺服器重啟後稽核鏈要接得回去，不是假性斷裂', async () => {
    for (let i = 0; i < 3; i++) {
      write({ type: 'intent.received', actor: 'elder', summary: `重啟前第 ${i + 1} 筆`, details: {} });
    }
    expect(state().audit).toHaveLength(3);

    // 重啟：記憶體沒了，檔案還在
    state().audit.length = 0;

    write({ type: 'intent.received', actor: 'elder', summary: '重啟後第一筆', details: {} });

    const { events } = readAuditFile();
    expect(events).toHaveLength(4);
    expect(events.map((e) => e.seq)).toEqual([1, 2, 3, 4]);
    expect(verifyChain(events)).toEqual({ ok: true, length: 4 });
  });

  it('檔案被改壞的話，重啟接回去仍然看得見那個斷點', async () => {
    for (let i = 0; i < 3; i++) {
      write({ type: 'intent.received', actor: 'elder', summary: `第 ${i + 1} 筆`, details: {} });
    }

    const path = process.env.GUARDIAN_AUDIT_FILE!;
    const lines = readAuditFile().events;
    lines[1] = { ...lines[1], summary: '被改過' };
    writeFileSync(path, `${lines.map((e) => JSON.stringify(e)).join('\n')}\n`);
    state().audit.length = 0;

    write({ type: 'intent.received', actor: 'elder', summary: '重啟後第一筆', details: {} });

    const v = verifyChain(readAuditFile().events);
    expect(v.ok).toBe(false);
    if (v.ok) throw new Error('unreachable');
    expect(v.brokenAt).toBe(2);
    expect(v.kind).toBe('hash-mismatch');
  });

  // --- 回歸測試：意圖綁定（9/5 加）---

  it('意圖是對這個收款人開的，換一個人就付不出去', async () => {
    // 冪等鍵 = keccak256(abi.encode(taskIdHash, payee, amount, assetNetworkHash))。
    // 合約會重算一次比對，所以「拿台電那份授權去付給別人」在鏈上就回退了 ——
    // 不是靠應用層自律，是合約算出來的雜湊對不上。
    const intent = intentFor({ amount: 1200 }, TAIPOWER);
    const impostor: Payee = { ...TAIPOWER, id: 'payee_fake', name: '假台電', address: IMPOSTOR };

    const r = await executeIntent({
      intent,
      policy: { ...POLICY, allowlist: ['payee_taipower', 'payee_fake'] },
      wallet: wallet(),
      payee: { ...impostor, allowlisted: true },
      now: NOW,
    });

    expect(r.payment.status).toBe('failed');
    expect(r.payment.revertReason).toContain('IntentMismatch');
  });

  // --- 回歸測試 2：沒有收款地址不可核准 ---

  it('名單裡對不到的收款人，付款不可核准 —— 否則錢會付到零地址', async () => {
    const intent = intentFor({ payeeName: '好棒棒旅行社', amount: 1500 }, undefined);
    const r = await executeIntent({
      intent,
      policy: POLICY,
      wallet: wallet(),
      payee: undefined,
      now: NOW,
    });

    expect(r.decision.rulesHit).toContain('PAYEE_UNKNOWN');
    expect(r.payment.status).toBe('pending_approval');
    expect(r.payment.payee.address).toMatch(/^0x0{40}$/);

    state().intents.push(intent);
    await expect(
      approvePayment(r.payment.id, { policy: POLICY, guardian: wallet(), intent, now: NOW }),
    ).rejects.toThrow('還沒有收款地址');

    // 而且狀態沒有被動到
    expect(state().payments.find((p) => p.id === r.payment.id)!.status).toBe('pending_approval');
  });

  // --- 回歸測試 3：核准時鏈別要對得上 ---

  it('提案與核准之間換了鏈，核准要被擋下來', async () => {
    const intent = intentFor({ amount: 2500 });
    const r = await executeIntent({
      intent,
      policy: POLICY,
      wallet: wallet(),
      payee: TAIPOWER,
      now: NOW,
    });
    expect(r.payment.status).toBe('pending_approval');

    const elsewhere = { ...intent, assetNetwork: 'tTWD@eip155:999999' };
    state().intents.push(elsewhere);

    await expect(
      approvePayment(r.payment.id, {
        policy: POLICY,
        guardian: wallet(),
        intent: elsewhere,
        now: NOW,
      }),
    ).rejects.toThrow('不是同一條鏈');
  });

  // --- 已經付過的不會再付 ---

  it('同一把冪等鍵再送一次 → block，而且不會產生第二筆付款', async () => {
    const intent = intentFor();
    const w = wallet();
    await executeIntent({ intent, policy: POLICY, wallet: w, payee: TAIPOWER, now: NOW });

    const second = await executeIntent({
      intent,
      policy: POLICY,
      wallet: w,
      payee: TAIPOWER,
      now: NOW,
    });
    expect(second.decision.action).toBe('block');
    expect(second.decision.rulesHit).toContain('ALREADY_SETTLED');
    expect(second.payment.status).toBe('blocked');
    expect(await w.spentToday(NOW)).toBe(1200); // 只扣過一次
  });
});
