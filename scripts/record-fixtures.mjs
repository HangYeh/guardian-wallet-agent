#!/usr/bin/env node
/**
 * 錄下四幕 + 兩則加演的模型回應，讓 `DEMO_MODE=fixtures` 有東西可以播。
 *
 * 用法（兩步，都在 `.env` 裡切，next dev 會自己重載）：
 *
 *   1. `.env` 設 `RECORD_FIXTURES=true`，確認 `DEMO_MODE=live`，然後
 *      `npm run fixtures:record`
 *   2. 錄完把 `RECORD_FIXTURES` 設回 false
 *
 * 播放時 `.env` 設 `DEMO_MODE=fixtures` —— 那時候不需要 `OPENAI_API_KEY`，
 * 也不需要網路。
 *
 * ⚠ **錄音的鍵包含請求內容，所以旗標要一致。** `ENABLE_VISION=true` 錄的是
 * 「看圖」那一則，關掉之後走的是文字版，鍵不一樣、會播不到。用什麼設定上台，
 * 就用什麼設定錄。
 */

import { readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const BASE = process.env.GUARDIAN_BASE_URL ?? 'http://127.0.0.1:3000';
const DIR = process.env.GUARDIAN_FIXTURE_DIR ?? join(process.cwd(), 'demo-data', 'fixtures');

// 幕四（weekly_report）不在這裡：它是週報，不經過 /api/intake，也沒有模型呼叫要錄。
const SCENARIOS = [
  ['electricity', '幕一：電費自動繳'],
  ['scam_nhi', '幕二：健保署詐騙'],
  ['redpacket', '幕三：孫子紅包'],
  ['scam_investment', '加演：投資詐騙'],
  ['scam_grandchild', '加演：假孫子'],
];

function count() {
  if (!existsSync(DIR)) return 0;
  return readdirSync(DIR).filter((f) => f.endsWith('.json')).length;
}

async function main() {
  let health;
  try {
    health = await fetch(`${BASE}/api/demo/reset`, {
      method: 'POST',
      headers: { authorization: `Bearer ${process.env.GUARDIAN_TOKEN ?? ''}` },
    }).then((r) => r.json());
  } catch {
    console.error(`連不上 ${BASE}。先開一個 npm run dev。`);
    process.exit(1);
  }

  if (!health?.ok) {
    console.error('重置端點沒回 ok，可能是 GUARDIAN_TOKEN 沒帶對：', health);
    process.exit(1);
  }
  if (health.demoMode === 'fixtures') {
    console.error('現在是 DEMO_MODE=fixtures（播放模式），錄不到東西。先切回 live。');
    process.exit(1);
  }

  const before = count();
  console.log(`錄音資料夾現有 ${before} 則\n`);

  let failed = 0;
  for (const [id, title] of SCENARIOS) {
    const started = Date.now();
    const res = await fetch(`${BASE}/api/intake`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ scenarioId: id }),
    }).then((r) => r.json());

    const ms = Date.now() - started;
    if (!res.ok) {
      failed += 1;
      console.log(`  ✗ ${title.padEnd(16)} ${res.error}`);
      continue;
    }
    const engine = res.risk?.engine === 'rules+llm' ? '規則+模型' : '只有規則';
    console.log(
      `  ✓ ${title.padEnd(16)} ${String(res.decision.action).padEnd(6)} 風險 ${String(res.risk.score).padStart(3)} ${engine.padEnd(8)} ${ms} ms`,
    );
  }

  const after = count();
  console.log(`\n新錄了 ${after - before} 則，總共 ${after} 則`);

  if (after === before) {
    console.error(
      '\n一則都沒錄到。八成是 RECORD_FIXTURES 沒設成 true —— 它是伺服器端讀的，' +
        '改完 .env 要等 next dev 重載（幾秒）再跑一次。',
    );
    process.exit(1);
  }
  if (failed > 0) process.exit(1);

  console.log('\n接著把 .env 的 RECORD_FIXTURES 設回 false。');
  console.log('要驗播放：DEMO_MODE=fixtures，並且把 OPENAI_API_KEY 註解掉，再跑一次六幕。');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
