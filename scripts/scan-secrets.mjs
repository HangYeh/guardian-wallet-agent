#!/usr/bin/env node
/**
 * 祕密掃描。工作目錄與 git 全歷史一起掃。
 *
 * 為什麼要掃歷史：金鑰一旦 commit 過，之後 `git rm` 也刪不掉，它還在物件庫裡，
 * 而這是一個公開儲存庫。這種情況唯一正確的處理是「當作已外洩」，
 * 去服務商後台撤銷重發，不是假裝刪掉了。所以這支工具寧可吵一點。
 *
 *   npm run scan:secrets
 *
 * 有命中就以 1 結束，可以直接掛在 pre-commit 或 CI 上。
 */

import { execFileSync } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';

const RULES = [
  { name: 'OpenAI 金鑰', re: /sk-[A-Za-z0-9_-]{32,}/g },
  { name: 'Anthropic 金鑰', re: /sk-ant-[A-Za-z0-9_-]{20,}/g },
  { name: 'ElevenLabs 金鑰', re: /\bsk_[A-Za-z0-9]{40,}/g },
  { name: 'GitHub token', re: /\bgh[pousr]_[A-Za-z0-9]{36}\b/g },
  { name: 'AWS access key', re: /\bAKIA[0-9A-Z]{16}\b/g },
  { name: 'PEM 私鑰', re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/g },
  {
    name: '以太坊私鑰',
    re: /(?:PRIVATE_KEY|privateKey|PRIVKEY|privkey)\s*[=:]\s*["']?0x[0-9a-fA-F]{64}/g,
  },
  { name: '助記詞', re: /(?:MNEMONIC|mnemonic)\s*[=:]\s*["'][a-z]+(?: [a-z]+){11,23}["']/g },
  // 環境檔裡整行就是一把私鑰的寫法（沒有 PRIVATE_KEY 這種變數名也要抓到）。
  // 刻意不寫「任何 0x + 64 hex」那種規則：我們自己的冪等鍵與 memoHash 就長那樣，
  // 那樣寫會每次都誤報，然後大家開始忽略這支掃描器 —— 那才是真正的風險。
  { name: '獨立成行的私鑰', re: /^[ \t]*(?:0x)?[0-9a-fA-F]{64}[ \t]*$/gm },
];

/** 已知安全、刻意公開的字串。加東西進來要寫清楚為什麼。 */
const ALLOWED = [
  // Hardhat 的標準測試助記詞，全世界都一樣，本來就該公開
  /test test test test test test test test test test test junk/,
];

/**
 * 進了版控就是問題的檔名，不管裡面寫什麼。
 * .env.example 是刻意要進版控的樣板，所以排除掉。
 */
const FORBIDDEN_FILES = /(^|[/])[.]env($|[.](?!example))/;

const SKIP_PATHS = /(^|\/)(node_modules|\.next|artifacts|cache|typechain-types)\//;
const BINARY_EXT = /\.(png|jpe?g|gif|webp|ico|pdf|mp4|mov|woff2?|ttf|zip)$/i;
const MAX_BYTES = 2_000_000;

function git(args) {
  return execFileSync('git', args, { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
}

function scan(text, where, hits) {
  for (const rule of RULES) {
    rule.re.lastIndex = 0;
    for (const m of text.matchAll(rule.re)) {
      if (ALLOWED.some((a) => a.test(m[0]))) continue;
      const line = text.slice(0, m.index).split('\n').length;
      hits.push({ rule: rule.name, where, line, sample: mask(m[0]) });
    }
  }
}

/** 命中的內容不整段印出來 —— 掃描報告本身不該變成第二個外洩管道。 */
function mask(s) {
  const head = s.slice(0, 8);
  return `${head}…（共 ${s.length} 字元）`;
}

const hits = [];

// ---- 工作目錄裡被 git 追蹤的檔案 ----
const files = git(['ls-files']).split('\n').filter(Boolean);
let scanned = 0;
for (const f of files) {
  if (SKIP_PATHS.test(f) || BINARY_EXT.test(f)) continue;
  if (FORBIDDEN_FILES.test(f)) {
    hits.push({ rule: '環境檔進了版控', where: f, line: 1, sample: '整個檔案' });
    continue;
  }
  try {
    if (statSync(f).size > MAX_BYTES) continue;
    scan(readFileSync(f, 'utf8'), f, hits);
    scanned++;
  } catch {
    // 讀不到就跳過，不要因為一個檔案讓整個掃描停掉
  }
}

// ---- git 全歷史（含已經被刪掉的檔案）----
let commits = 0;
try {
  const history = git(['log', '-p', '--all', '--no-color']);
  commits = (git(['rev-list', '--all', '--count']).trim() || '0').replace(/\D/g, '');
  scan(history, 'git 歷史', hits);
} catch {
  console.log('（不是 git 儲存庫，只掃了工作目錄）');
}

// ---- 報告 ----
console.log(`掃描 ${scanned} 個追蹤中的檔案 + ${commits} 個 commit 的完整歷史`);

if (hits.length === 0) {
  console.log('✓ 沒有發現任何祕密');
  process.exit(0);
}

console.log(`\n✗ 發現 ${hits.length} 處可能的祕密：\n`);
for (const h of hits) {
  console.log(`  ${h.rule}  ${h.where}:${h.line}  ${h.sample}`);
}
console.log(
  `
下一步：
  1. 先去服務商後台撤銷那把金鑰再說。已經寫進 git 歷史的東西刪不乾淨，
     而這是公開儲存庫，要當作已經外洩。
  2. 重發一把新的，放進 .env（.env 不進版控）。
  3. 確認 .gitignore 有擋住那個檔案，再重跑這支掃描。`,
);
process.exit(1);
