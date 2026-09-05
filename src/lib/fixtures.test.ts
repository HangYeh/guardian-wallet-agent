import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

/**
 * 錄音（fixtures）的測試。
 *
 * 這一層在台上要負責的事只有一件：**現場網路壞掉時，demo 照跑。**
 * 所以測的重點是「鍵會不會意外命中或意外落空」——命中錯的錄音比沒錄音更糟，
 * 因為畫面看起來一切正常，內容卻是別則的答案。
 *
 * `GUARDIAN_FIXTURE_DIR` 在每一條之前指到臨時資料夾，不會碰到 repo 裡真的錄音。
 */

const TMP = mkdtempSync(join(tmpdir(), 'guardian-fixtures-'));
process.env.GUARDIAN_FIXTURE_DIR = TMP;

// 模組讀 env 是在載入時，所以要在設好之後才 import
const { fixtureKey, fixturesMode, readFixture, recording, writeFixture } = await import(
  '@/lib/fixtures'
);

const BASE = {
  model: 'gpt-4.1-mini',
  schemaName: 'bill_fields',
  system: '你是帳單解析器',
  user: '台灣電力公司 本期應繳 1,280 元',
};

beforeEach(() => {
  for (const f of readdirSync(TMP)) rmSync(join(TMP, f), { force: true });
  delete process.env.DEMO_MODE;
  delete process.env.RECORD_FIXTURES;
});

afterEach(() => {
  delete process.env.DEMO_MODE;
  delete process.env.RECORD_FIXTURES;
});

describe('請求指紋', () => {
  it('同樣的請求得到同樣的鍵', () => {
    expect(fixtureKey(BASE)).toBe(fixtureKey({ ...BASE }));
  });

  it('是 sha256 的十六進位字串', () => {
    expect(fixtureKey(BASE)).toMatch(/^[0-9a-f]{64}$/);
  });

  for (const field of ['model', 'schemaName', 'system', 'user'] as const) {
    it(`改了 ${field} 就換一把鍵`, () => {
      expect(fixtureKey({ ...BASE, [field]: 'X' })).not.toBe(fixtureKey(BASE));
    });
  }

  it('改了提示詞就自動失效 —— 不會拿舊答案配新問題', () => {
    const before = fixtureKey(BASE);
    const after = fixtureKey({ ...BASE, system: `${BASE.system}。另外請注意金額格式。` });
    expect(after).not.toBe(before);
  });

  it('有圖跟沒圖是不同的鍵（同一個情境，視覺開關不同就該落空）', () => {
    const withImage = fixtureKey({ ...BASE, images: ['data:image/png;base64,AAAA'] });
    expect(withImage).not.toBe(fixtureKey(BASE));
  });

  it('不同的圖是不同的鍵', () => {
    const a = fixtureKey({ ...BASE, images: ['data:image/png;base64,AAAA'] });
    const b = fixtureKey({ ...BASE, images: ['data:image/png;base64,BBBB'] });
    expect(a).not.toBe(b);
  });

  it('圖片的順序有意義', () => {
    const a = fixtureKey({ ...BASE, images: ['data:image/png;base64,AA', 'data:image/png;base64,BB'] });
    const b = fixtureKey({ ...BASE, images: ['data:image/png;base64,BB', 'data:image/png;base64,AA'] });
    expect(a).not.toBe(b);
  });

  it('欄位邊界不會被串在一起搞混', () => {
    // 'ab' + 'c' 跟 'a' + 'bc' 如果只是接起來雜湊就會撞
    const a = fixtureKey({ ...BASE, system: 'ab', user: 'c' });
    const b = fixtureKey({ ...BASE, system: 'a', user: 'bc' });
    expect(a).not.toBe(b);
  });
});

describe('讀寫', () => {
  it('寫進去讀得回來', () => {
    const key = fixtureKey(BASE);
    writeFixture({ key, model: BASE.model, schemaName: BASE.schemaName, note: BASE.user, latencyMs: 1234, data: { amount: 1280 } });

    const hit = readFixture(key);
    expect(hit).not.toBeNull();
    expect(hit!.data).toEqual({ amount: 1280 });
    expect(hit!.model).toBe('gpt-4.1-mini');
    expect(hit!.latencyMs).toBe(1234);
    expect(hit!.recordedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('沒錄過就回 null，不是丟例外', () => {
    expect(readFixture('0'.repeat(64))).toBeNull();
  });

  it('壞掉的錄音當作沒有 —— 讓呼叫端走它自己的備援', () => {
    const key = fixtureKey(BASE);
    writeFixture({ key, model: 'm', schemaName: 's', note: 'n', latencyMs: 1, data: {} });
    writeFixture({ key, model: 'm', schemaName: 's', note: 'n', latencyMs: 1, data: {} });
    writeFileSync(join(TMP, `${key}.json`), '{ 這不是 JSON', 'utf8');
    expect(readFixture(key)).toBeNull();
  });
});

describe('存進檔案的內容', () => {
  /**
   * 錄音要進 repo（新 clone 也要跑得動 demo），所以檔案裡不能夾帶
   * 完整的輸入。任何人拿真的帳單錄一次，帳單逐字稿就會被提交上去 ——
   * 那是別人的個資，而且是我們自己手動製造的外洩。
   */
  it('摘要只留開頭 80 字，長的輸入不會整段被存進 repo', () => {
    const long = '身分證字號 A123456789 住址台北市'.repeat(20);
    const key = fixtureKey({ ...BASE, user: long });
    writeFixture({ key, model: 'm', schemaName: 's', note: long, latencyMs: 1, data: {} });

    const raw = readFileSync(join(TMP, `${key}.json`), 'utf8');
    const saved = JSON.parse(raw) as { note: string };
    expect(saved.note.length).toBeLessThanOrEqual(81); // 80 + 省略號
    expect(raw.length).toBeLessThan(long.length);
  });

  it('短的輸入原樣留著，錄音才看得懂是哪一則', () => {
    const key = fixtureKey(BASE);
    writeFixture({ key, model: 'm', schemaName: 's', note: '台灣電力公司', latencyMs: 1, data: {} });
    expect(readFixture(key)!.note).toBe('台灣電力公司');
  });

  it('換行與多餘空白會被壓平', () => {
    const key = fixtureKey(BASE);
    writeFixture({ key, model: 'm', schemaName: 's', note: ' 第一行\n\n  第二行 ', latencyMs: 1, data: {} });
    expect(readFixture(key)!.note).toBe('第一行 第二行');
  });
});

describe('模式開關', () => {
  it('DEMO_MODE=fixtures 才是播放模式', () => {
    expect(fixturesMode()).toBe(false);
    process.env.DEMO_MODE = 'fixtures';
    expect(fixturesMode()).toBe(true);
    process.env.DEMO_MODE = 'live';
    expect(fixturesMode()).toBe(false);
  });

  it('錄音要明確設成 true 才會開 —— 不能被別的值誤觸', () => {
    expect(recording()).toBe(false);
    process.env.RECORD_FIXTURES = '1';
    expect(recording()).toBe(false);
    process.env.RECORD_FIXTURES = 'yes';
    expect(recording()).toBe(false);
    process.env.RECORD_FIXTURES = 'true';
    expect(recording()).toBe(true);
  });
});
