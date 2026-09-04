import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { DemoData, Payee, ScenarioId } from '@/lib/types';

let cache: DemoData | null = null;

/** 讀取 demo 劇本。伺服器端使用，讀一次之後常駐記憶體。 */
export function loadDemo(): DemoData {
  if (cache) return cache;
  const file = join(process.cwd(), 'demo-data', 'guardian-demo.json');
  const parsed = JSON.parse(readFileSync(file, 'utf8')) as DemoData;
  assertDemoData(parsed);
  cache = parsed;
  return parsed;
}

/** 丟掉快取，下次讀檔。改 demo 資料後不用重啟伺服器。 */
export function reloadDemo(): DemoData {
  cache = null;
  return loadDemo();
}

/**
 * 劇本資料是整個 demo 的地基，壞掉要在啟動時就炸，
 * 不要等到舞台上第三幕才發現金額對不起來。
 */
function assertDemoData(d: DemoData): void {
  const problems: string[] = [];

  if (!d.payees?.length) problems.push('payees 是空的');
  if (!d.scenarios?.length) problems.push('scenarios 是空的');
  if (!d.transactions?.length) problems.push('transactions 是空的');

  for (const p of d.payees ?? []) {
    if (!/^0x[0-9a-fA-F]{40}$/.test(p.address)) {
      problems.push(`收款人 ${p.id} 的地址不合法：${p.address}`);
    }
  }

  for (const id of d.policy?.allowlist ?? []) {
    if (!d.payees.some((p) => p.id === id)) problems.push(`白名單指向不存在的收款人 ${id}`);
  }

  const r = d.expectedReport;
  const sum = r.blockedScam + r.duplicateRefund + r.zombieCancel;
  if (sum !== r.guardedTotal) {
    problems.push(`週報頭條對不上：${r.blockedScam} + ${r.duplicateRefund} + ${r.zombieCancel} = ${sum}，但寫的是 ${r.guardedTotal}`);
  }

  for (const s of d.scenarios ?? []) {
    if (s.input.type === 'text' && s.input.value && !d.messages.some((m) => m.id === s.input.value)) {
      problems.push(`情境 ${s.id} 指向不存在的訊息 ${s.input.value}`);
    }
  }

  if (problems.length) {
    throw new Error(`demo-data/guardian-demo.json 有問題：\n  - ${problems.join('\n  - ')}`);
  }
}

// ---------------------------------------------------------------------------
// 查詢輔助
// ---------------------------------------------------------------------------

export function payeeById(d: DemoData, id: string): Payee | undefined {
  return d.payees.find((p) => p.id === id);
}

export function scenarioById(d: DemoData, id: ScenarioId) {
  return d.scenarios.find((s) => s.id === id);
}

export function allowlistedPayees(d: DemoData): Payee[] {
  return d.payees.filter((p) => d.policy.allowlist.includes(p.id));
}

/** 這個收款人最後一次真的被使用是什麼時候。殭屍訂閱規則要用。 */
export function lastUsed(d: DemoData, payeeId: string): string | undefined {
  return d.usage.find((u) => u.payeeId === payeeId)?.lastUsed;
}

/** 依收款人分組的月支出，週報與金額突增判斷共用。 */
export function spendByMerchant(d: DemoData): { merchant: string; total: number; count: number }[] {
  const map = new Map<string, { merchant: string; total: number; count: number }>();
  for (const t of d.transactions) {
    const row = map.get(t.merchant) ?? { merchant: t.merchant, total: 0, count: 0 };
    row.total += t.amount;
    row.count += 1;
    map.set(t.merchant, row);
  }
  return [...map.values()].sort((a, b) => b.total - a.total);
}

export function formatTWD(n: number): string {
  return 'NT$' + n.toLocaleString('zh-TW');
}
