import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { DemoData } from '@/lib/types';

const RAW = readFileSync(join(process.cwd(), 'demo-data', 'guardian-demo.json'), 'utf8');
const demo = JSON.parse(RAW) as DemoData;

// ---------------------------------------------------------------------------
// 劇本資料的完整性
// ---------------------------------------------------------------------------

describe('劇本資料', () => {
  it('每個收款人都有合法且唯一的地址', () => {
    const addrs = demo.payees.map((p) => p.address);
    for (const a of addrs) expect(a).toMatch(/^0x[0-9a-fA-F]{40}$/);
    expect(new Set(addrs).size).toBe(addrs.length);
  });

  it('白名單指到的收款人都存在', () => {
    for (const id of demo.policy.allowlist) {
      expect(demo.payees.some((p) => p.id === id)).toBe(true);
    }
  });

  it('週報頭條數字加得起來', () => {
    const r = demo.expectedReport;
    expect(r.blockedScam + r.duplicateRefund + r.zombieCancel).toBe(r.guardedTotal);
  });

  it('每個情境指到的訊息或檔案都存在', () => {
    for (const s of demo.scenarios) {
      if (s.input.type === 'text' && s.input.value) {
        expect(demo.messages.some((m) => m.id === s.input.value)).toBe(true);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// 公開 repo 的資料衛生
//
// 這份 JSON 會躺在公開的儲存庫裡，而且裡面有標著「詐騙樣本」的內容。
// 如果那些帳號、代碼、電話對得上真實世界的機構或個人，那就是我們自己
// 在公開場合把別人掛上詐騙的名字。全部要是查無此號。
// ---------------------------------------------------------------------------

/** 金管會實際配發給金融機構的代碼，樣本裡一個都不能出現。 */
const REAL_BANK_CODES = [
  '004', '005', '006', '007', '008', '009', '011', '012', '013', '017',
  '021', '048', '050', '052', '053', '054', '081', '102', '103', '108',
  '118', '147', '700', '803', '805', '806', '807', '808', '809', '812',
  '816', '822',
];

describe('資料衛生：公開 repo 不能帶到真實世界的識別碼', () => {
  it('詐騙樣本裡的銀行代碼都是未配發的號碼', () => {
    const found = REAL_BANK_CODES.filter(
      (c) => RAW.includes(`(${c})`) || RAW.includes(`（${c}）`),
    );
    expect(found, `這些是真的銀行代碼：${found.join(', ')}`).toEqual([]);
  });

  it('封鎖名單的帳號不以真實銀行代碼開頭', () => {
    for (const b of demo.blocklist) {
      expect(REAL_BANK_CODES).not.toContain(b.account.slice(0, 3));
    }
  });

  it('訊息來源的電話號碼都是不可能配發的號碼', () => {
    for (const m of demo.messages) {
      const digits = m.from.replace(/\D/g, '');
      if (!digits) continue; // 「LINE 投資群組」這種非號碼來源
      expect(digits, `${m.id} 的來源號碼看起來像真的：${m.from}`).toMatch(/0{6,}/);
    }
  });

  it('沒有寫死任何看起來像金鑰的字串', () => {
    expect(RAW).not.toMatch(/sk-[A-Za-z0-9_-]{20}/);
    expect(RAW).not.toMatch(/0x[0-9a-fA-F]{64}/);
  });
});
