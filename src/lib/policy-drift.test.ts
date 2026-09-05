import { describe, expect, it } from 'vitest';
import { comparePolicy, type ChainPolicy } from '@/lib/policy-drift';
import type { Payee, Policy } from '@/lib/types';

/**
 * 漂移偵測的純函數部分。合約讀取那一段在 local 模式實測，不在這裡。
 *
 * 要守的是方向：鏈下比鏈上「寬」才會真的出事（引擎放行、合約 revert），
 * 「嚴」只是合約變成比較弱的底線。兩種都要標，但後果要講對。
 */

const TAIPOWER: Payee = {
  id: 'payee_taipower',
  name: '台灣電力公司',
  address: '0x9965507D1a55bcC2695C58ba16FB37d819B0A4dc',
  kind: 'utility',
  allowlisted: true,
};
const XIAOYU: Payee = {
  id: 'contact_xiaoyu',
  name: '小宇（孫子）',
  address: '0x71bE63f3384f5fb98995898A86B02Fb2426c5788',
  kind: 'person',
  allowlisted: false,
};
const PAYEES = [TAIPOWER, XIAOYU];

const OFF: Policy = {
  perTxCap: 3000,
  dailyCap: 5000,
  approvalThreshold: 2000,
  newPayeeRequiresApproval: true,
  newPayeeCooldownHours: 24,
  quietHours: [22, 7],
  allowlist: ['payee_taipower'],
};

// 合約的 mapping 是用小寫地址讀回來的；這裡故意也用小寫，測大小寫不敏感。
const ON: ChainPolicy = {
  perTxCap: 3000,
  dailyCap: 5000,
  approvalThreshold: 2000,
  allowlist: {
    [TAIPOWER.address.toLowerCase()]: true,
    [XIAOYU.address.toLowerCase()]: false,
  },
};

describe('鏈上鏈下政策比對', () => {
  it('一致：三個上限都列出來、白名單不列、對不上的是 0', () => {
    const r = comparePolicy(OFF, PAYEES, ON);
    expect(r.driftCount).toBe(0);
    expect(r.rows.map((x) => x.key)).toEqual(['perTxCap', 'dailyCap', 'approvalThreshold']);
    expect(r.rows.every((x) => x.drift === 'none' && x.consequence === undefined)).toBe(true);
    expect(r.allowlistChecked).toBe(2);
  });

  it('鏈下把單筆上限調高 → looser，後果講到 payment.reverted', () => {
    const r = comparePolicy({ ...OFF, perTxCap: 10_000 }, PAYEES, ON);
    const row = r.rows.find((x) => x.key === 'perTxCap')!;
    expect(row.drift).toBe('looser');
    expect(row.consequence).toContain('10,000');
    expect(row.consequence).toContain('3,000');
    expect(row.consequence).toContain('payment.reverted');
    expect(r.driftCount).toBe(1);
  });

  it('鏈下把單日上限調低 → tighter，後果是合約變成比較弱的底線', () => {
    const r = comparePolicy({ ...OFF, dailyCap: 1000 }, PAYEES, ON);
    const row = r.rows.find((x) => x.key === 'dailyCap')!;
    expect(row.drift).toBe('tighter');
    expect(row.consequence).toContain('鏈下先擋');
    expect(row.consequence).toContain('5,000');
  });

  it('核准門檻方向一樣：鏈下比鏈上高就是寬', () => {
    const r = comparePolicy({ ...OFF, approvalThreshold: 2500 }, PAYEES, ON);
    expect(r.rows.find((x) => x.key === 'approvalThreshold')!.drift).toBe('looser');
  });

  it('鏈下加了小宇、合約沒有 → looser，那一列才出現', () => {
    const r = comparePolicy({ ...OFF, allowlist: ['payee_taipower', 'contact_xiaoyu'] }, PAYEES, ON);
    const row = r.rows.find((x) => x.key === 'contact_xiaoyu')!;
    expect(row).toBeDefined();
    expect(row.kind).toBe('allowlist');
    expect(row.drift).toBe('looser');
    expect(row.consequence).toContain('payment.reverted');
    expect(r.rows.find((x) => x.key === 'payee_taipower')).toBeUndefined();
    expect(r.driftCount).toBe(1);
  });

  it('鏈下把台電移出、合約還在 → tighter，後果是 operator 金鑰仍付得出去', () => {
    const r = comparePolicy({ ...OFF, allowlist: [] }, PAYEES, ON);
    const row = r.rows.find((x) => x.key === 'payee_taipower')!;
    expect(row.drift).toBe('tighter');
    expect(row.consequence).toContain('operator');
  });

  it('合約那邊沒讀到的地址當作不在白名單 —— 鏈下有台電、鏈上沒有，是寬', () => {
    const r = comparePolicy(OFF, PAYEES, { ...ON, allowlist: {} });
    expect(r.rows.find((x) => x.key === 'payee_taipower')!.drift).toBe('looser');
  });

  it('同時好幾處對不上，數字要對', () => {
    const r = comparePolicy(
      { ...OFF, perTxCap: 9999, dailyCap: 100, allowlist: ['contact_xiaoyu'] },
      PAYEES,
      ON,
    );
    // perTxCap looser、dailyCap tighter、台電 tighter、小宇 looser
    expect(r.driftCount).toBe(4);
  });
});
