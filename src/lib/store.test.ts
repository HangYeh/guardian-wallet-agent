import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { loadDemo } from '@/lib/demo';
import { effectivePolicy, resetAll, setAllowlisted, state, updatePolicy } from '@/lib/store';

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
