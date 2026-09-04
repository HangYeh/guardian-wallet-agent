import { appendFileSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { keccak256, toBytes } from 'viem';
import type { AuditEvent } from '@/lib/types';

/**
 * 稽核日誌 —— 雜湊鏈版。
 *
 * 演講的第四層是 SETTLEMENT + **EVIDENCE**。純附加寫入的日誌不算證據，
 * 因為門神自己就有寫入權，事後改一筆沒人看得出來。
 *
 * 所以每一筆把前一筆的 hash 包進自己的 hash 裡。改動任何一筆，之後所有的
 * hash 都對不上，稽核頁會直接指出斷在第幾筆。
 *
 * 這不是「防竄改」—— 本機檔案擋不住有 root 的人，他可以整條重算。
 * 這是「**讓竄改留下痕跡**」：要嘛整條重算（那就會跟鏈上的 memoHash 對不起來），
 * 要嘛留下一個對不上的斷點。兩條路都走不通才叫證據。
 */

/**
 * 稽核檔的位置。做成函式而不是常數，是為了讓測試可以指到暫存檔，
 * 不去動開發時真的在用的那一份 —— 測試污染證據檔是很難查的一種問題。
 *
 * 代價是 Turbopack 靜態分析不出這個路徑，會退而把整個專案打包進 server bundle
 * 並在 build 時警告。下面四個檔案操作因此標了 turbopackIgnore：
 * 路徑是動態的這件事是刻意的，不是漏寫。
 */
export function auditFile(): string {
  return process.env.GUARDIAN_AUDIT_FILE?.trim() || join(process.cwd(), 'data', 'audit.jsonl');
}

/** 創世 hash。第一筆的 prevHash。 */
export const GENESIS: `0x${string}` = `0x${'0'.repeat(64)}`;

/**
 * 正規化：把一筆事件變成一個字串，同樣的內容永遠得到同樣的字串。
 *
 * 欄位順序寫死不用 Object.keys，`details` 的鍵先排序 —— 否則同樣的內容
 * 只因為寫入順序不同就算出不同的 hash，驗證會假性失敗。
 */
/** 欄位分隔符：ASCII 單元分隔字元。摘要與 JSON 裡都不會出現它，所以欄位邊界撐不開。 */
const SEP = String.fromCharCode(31);

export function canonical(e: Omit<AuditEvent, 'hash'>): string {
  return [
    e.seq,
    e.ts,
    e.type,
    e.actor,
    e.intentId ?? '',
    e.paymentId ?? '',
    e.summary,
    stableJson(e.details),
    e.memoHash ?? '',
    e.prevHash,
  ].join(SEP);
}

function stableJson(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v) ?? 'null';
  if (Array.isArray(v)) return `[${v.map(stableJson).join(',')}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${stableJson(o[k])}`)
    .join(',')}}`;
}

export function hashEvent(e: Omit<AuditEvent, 'hash'>): `0x${string}` {
  return keccak256(toBytes(canonical(e)));
}

// ---------------------------------------------------------------------------
// 寫入
// ---------------------------------------------------------------------------

type Draft = Omit<AuditEvent, 'seq' | 'id' | 'ts' | 'prevHash' | 'hash'>;

/**
 * 接上一筆事件。呼叫端只給內容，序號、時間、兩個雜湊由這裡補。
 *
 * `previous` 是目前鏈上的最後一筆（沒有就傳 undefined）。刻意用參數傳而不是
 * 讀全域狀態，這樣這個函式是純的，測試不必準備環境。
 */
export function appendEvent(draft: Draft, previous?: AuditEvent, now: Date = new Date()): AuditEvent {
  const base: Omit<AuditEvent, 'hash'> = {
    ...draft,
    seq: (previous?.seq ?? 0) + 1,
    id: `evt_${crypto.randomUUID().slice(0, 8)}`,
    ts: now.toISOString(),
    prevHash: previous?.hash ?? GENESIS,
  };
  return { ...base, hash: hashEvent(base) };
}

/** 落地。檔案是證據，記憶體只是快取。 */
export function persist(event: AuditEvent): void {
  mkdirSync(/*turbopackIgnore: true*/ dirname(auditFile()), { recursive: true });
  appendFileSync(/*turbopackIgnore: true*/ auditFile(), `${JSON.stringify(event)}\n`, 'utf8');
}

export function clearAuditFile(): void {
  try {
    rmSync(/*turbopackIgnore: true*/ auditFile());
  } catch {
    // 本來就不存在
  }
}

// ---------------------------------------------------------------------------
// 讀取與驗證
// ---------------------------------------------------------------------------

/** 從檔案讀回來。壞掉的行不吞掉 —— 讀不出來本身就是一種「鏈斷了」。 */
export function readAuditFile(): { events: AuditEvent[]; badLines: number[] } {
  let raw: string;
  try {
    raw = readFileSync(/*turbopackIgnore: true*/ auditFile(), 'utf8');
  } catch {
    return { events: [], badLines: [] };
  }

  const events: AuditEvent[] = [];
  const badLines: number[] = [];
  raw.split('\n').forEach((line, i) => {
    if (!line.trim()) return;
    try {
      events.push(JSON.parse(line) as AuditEvent);
    } catch {
      badLines.push(i + 1);
    }
  });
  return { events, badLines };
}

export type ChainVerdict =
  | { ok: true; length: number }
  | {
      ok: false;
      length: number;
      /** 第幾筆斷的（用事件自己的 seq）。 */
      brokenAt: number;
      kind: 'hash-mismatch' | 'link-mismatch' | 'seq-gap';
      detail: string;
    };

/**
 * 驗證整條鏈。
 *
 * 三種斷法，訊息要分得開，因為它們指向不同的事：
 *   hash-mismatch —— 這一筆的內容被改過
 *   link-mismatch —— 有一筆被抽掉或插進來
 *   seq-gap       —— 序號跳號，通常是有人刪了一整行
 */
export function verifyChain(events: AuditEvent[]): ChainVerdict {
  let prev: `0x${string}` = GENESIS;

  for (let i = 0; i < events.length; i++) {
    const e = events[i];

    if (e.seq !== i + 1) {
      return {
        ok: false,
        length: events.length,
        brokenAt: e.seq,
        kind: 'seq-gap',
        detail: `第 ${i + 1} 行的序號是 ${e.seq}，中間有事件被刪掉或重排。`,
      };
    }

    if (e.prevHash !== prev) {
      return {
        ok: false,
        length: events.length,
        brokenAt: e.seq,
        kind: 'link-mismatch',
        detail: `第 ${e.seq} 筆接的是 ${short(e.prevHash)}，但前一筆的雜湊是 ${short(prev)}。有事件被抽掉或插入。`,
      };
    }

    const expected = hashEvent(e);
    if (expected !== e.hash) {
      return {
        ok: false,
        length: events.length,
        brokenAt: e.seq,
        kind: 'hash-mismatch',
        detail: `第 ${e.seq} 筆的內容被改過：重算得到 ${short(expected)}，檔案裡寫的是 ${short(e.hash)}。`,
      };
    }

    prev = e.hash;
  }

  return { ok: true, length: events.length };
}

function short(h: string): string {
  return `${h.slice(0, 10)}…`;
}
