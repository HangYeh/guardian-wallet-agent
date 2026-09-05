import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * 錄好的模型回應。**舞台保險絲。**
 *
 * 現場的網路是最不能信的東西：場館 Wi-Fi 塞住、OpenAI 抽風、金鑰額度用完，
 * 任何一個都會讓 demo 在評審面前轉圈圈。`DEMO_MODE=fixtures` 把整條管線
 * 從網路切到硬碟 —— 同樣的四幕，同樣的畫面，**不需要金鑰、不需要網路**。
 *
 * 附帶好處是**確定性**：模型即使 temperature 0 也會飄（實測同一則紅包
 * 兩次分別給 20 和 30 分）。錄下來之後，台上跑幾次都一樣。
 *
 * 鍵是請求內容的 sha256。同一張帳單、同一段提示詞就命中同一則錄音；
 * 改了提示詞就自動失效，不會拿舊的回應搭新的問題。
 */

const DIR = process.env.GUARDIAN_FIXTURE_DIR ?? join(process.cwd(), 'demo-data', 'fixtures');

export type Fixture = {
  key: string;
  recordedAt: string;
  model: string;
  schemaName: string;
  /** 問了什麼的摘要。**只留開頭幾十個字**，理由見 `note()`。 */
  note: string;
  latencyMs: number;
  data: unknown;
};

export function fixturesMode(): boolean {
  return process.env.DEMO_MODE === 'fixtures';
}

export function recording(): boolean {
  return process.env.RECORD_FIXTURES === 'true';
}

function sha(s: string): string {
  return createHash('sha256').update(s).digest('hex');
}

/**
 * 請求的指紋。
 *
 * 圖片是 data URL，動輒幾百 KB —— 不能直接進雜湊的輸入串（記憶體），
 * 也不能存進檔案。各自先雜湊，只把摘要放進鍵裡。
 */
export function fixtureKey(args: {
  model: string;
  schemaName: string;
  system: string;
  user: string;
  images?: string[];
}): string {
  const parts = [
    args.model,
    args.schemaName,
    args.system,
    args.user,
    ...(args.images ?? []).map((img) => sha(img)),
  ];
  // 用 U+001F（單元分隔符）隔開欄位，理由跟 `audit.ts` 的 `canonical()` 一樣：
  // 直接接起來的話，system='ab'+user='c' 會跟 system='a'+user='bc' 撞成同一把鍵。
  // 這個字元不會出現在提示詞或帳單文字裡。**寫成 String.fromCharCode 而不是
  // 字面量** —— 字面控制字元在原始碼裡是隱形的，grep 看不到、diff 會吃掉，
  // 讀的人會以為這裡沒有分隔符。
  return sha(parts.join(String.fromCharCode(31)));
}

/**
 * 存進檔案的摘要只留開頭 80 字。
 *
 * 錄音是要進 repo 的（一份新 clone 也要跑得動 demo）。如果把 `user` 整段存下來，
 * 那任何人拿真的帳單錄一次，帳單逐字稿就會被提交上去 —— **那是別人的個資，
 * 而且是我們自己手動製造的外洩**。劇本資料是虛構的沒差，但預設不能挖這個坑。
 */
function note(user: string): string {
  const flat = user.replace(/\s+/g, ' ').trim();
  return flat.length > 80 ? `${flat.slice(0, 80)}…` : flat;
}

function pathOf(key: string): string {
  return join(DIR, `${key}.json`);
}

export function readFixture(key: string): Fixture | null {
  const file = pathOf(key);
  /*turbopackIgnore: true*/
  if (!existsSync(file)) return null;
  try {
    /*turbopackIgnore: true*/
    return JSON.parse(readFileSync(file, 'utf8')) as Fixture;
  } catch {
    return null; // 壞掉的錄音當作沒有，讓呼叫端走它自己的備援
  }
}

export function writeFixture(f: Omit<Fixture, 'recordedAt'>): void {
  /*turbopackIgnore: true*/
  mkdirSync(DIR, { recursive: true });
  const record: Fixture = { ...f, note: note(f.note), recordedAt: new Date().toISOString() };
  /*turbopackIgnore: true*/
  writeFileSync(pathOf(f.key), `${JSON.stringify(record, null, 2)}\n`, 'utf8');
}

export function fixtureDir(): string {
  return DIR;
}
