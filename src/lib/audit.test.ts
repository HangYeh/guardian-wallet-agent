import { describe, expect, it } from 'vitest';
import { GENESIS, appendEvent, hashEvent, verifyChain } from '@/lib/audit';
import type { AuditEvent } from '@/lib/types';

/**
 * 雜湊鏈的測試。
 *
 * 重點不是「hash 算得對不對」（那是 viem 的事），是**三種竄改都要被抓到**，
 * 而且訊息要分得開 —— 改內容、抽掉一筆、刪一整行，指向的是不同的事。
 */

function chain(n: number): AuditEvent[] {
  const events: AuditEvent[] = [];
  for (let i = 0; i < n; i++) {
    events.push(
      appendEvent(
        {
          type: 'payment.executed',
          actor: 'agent',
          intentId: `int_${i}`,
          summary: `第 ${i + 1} 筆付款`,
          details: { amount: 100 * (i + 1) },
        },
        events.at(-1),
        new Date(2026, 8, 4, 12, 0, i),
      ),
    );
  }
  return events;
}

describe('稽核雜湊鏈', () => {
  it('第一筆接在創世雜湊上，序號從 1 開始', () => {
    const [first] = chain(1);
    expect(first.seq).toBe(1);
    expect(first.prevHash).toBe(GENESIS);
    expect(first.hash).toMatch(/^0x[0-9a-f]{64}$/);
  });

  it('每一筆都接得上前一筆', () => {
    const events = chain(5);
    for (let i = 1; i < events.length; i++) {
      expect(events[i].prevHash).toBe(events[i - 1].hash);
      expect(events[i].seq).toBe(i + 1);
    }
    expect(verifyChain(events)).toEqual({ ok: true, length: 5 });
  });

  it('同樣的內容永遠算出同樣的雜湊，跟欄位寫入順序無關', () => {
    const base = chain(1)[0];
    const shuffled = {
      hash: base.hash,
      details: { b: 2, a: 1 },
      prevHash: base.prevHash,
      summary: base.summary,
      actor: base.actor,
      type: base.type,
      ts: base.ts,
      id: base.id,
      seq: base.seq,
      intentId: base.intentId,
    } as AuditEvent;
    const ordered = { ...base, details: { a: 1, b: 2 } };
    expect(hashEvent(shuffled)).toBe(hashEvent(ordered));
  });

  // --- 三種竄改 ---

  it('改掉一筆的內容 → 抓得到，而且指出是第幾筆', () => {
    const events = chain(5);
    events[2] = { ...events[2], summary: '第 3 筆付款（被改過）' };

    const v = verifyChain(events);
    expect(v.ok).toBe(false);
    if (v.ok) throw new Error('unreachable');
    expect(v.brokenAt).toBe(3);
    expect(v.kind).toBe('hash-mismatch');
    expect(v.detail).toContain('內容被改過');
  });

  it('改掉 details 裡的金額也一樣抓得到', () => {
    const events = chain(3);
    events[1] = { ...events[1], details: { amount: 999_999 } };

    const v = verifyChain(events);
    expect(v.ok).toBe(false);
    if (v.ok) throw new Error('unreachable');
    expect(v.brokenAt).toBe(2);
    expect(v.kind).toBe('hash-mismatch');
  });

  it('抽掉中間一筆 → 序號跳號，抓得到', () => {
    const events = chain(5);
    events.splice(2, 1); // 拿掉第 3 筆

    const v = verifyChain(events);
    expect(v.ok).toBe(false);
    if (v.ok) throw new Error('unreachable');
    expect(v.kind).toBe('seq-gap');
    expect(v.brokenAt).toBe(4);
  });

  it('把序號補好但雜湊沒重算 → 連結對不上，還是抓得到', () => {
    const events = chain(5);
    events.splice(2, 1);
    // 攻擊者聰明一點，把後面的序號補順
    for (let i = 2; i < events.length; i++) events[i] = { ...events[i], seq: i + 1 };

    const v = verifyChain(events);
    expect(v.ok).toBe(false);
    if (v.ok) throw new Error('unreachable');
    expect(v.kind).toBe('link-mismatch');
    expect(v.brokenAt).toBe(3);
  });

  it('整條重算得到的鏈是驗得過的 —— 這正是為什麼還需要鏈上的 memoHash', () => {
    // 有寫入權的人可以整條重寫。本機檔案擋不住這個，誠實承認。
    // 擋得住的是「鏈上事件與稽核事件用同一個 memoHash 對照」那一層。
    const forged = chain(3).map((e) => ({ ...e, summary: '偽造的' }));
    const rebuilt: AuditEvent[] = [];
    for (const e of forged) {
      const base = { ...e, prevHash: rebuilt.at(-1)?.hash ?? GENESIS };
      rebuilt.push({ ...base, hash: hashEvent(base) });
    }
    expect(verifyChain(rebuilt).ok).toBe(true);
  });

  it('空的鏈是合法的', () => {
    expect(verifyChain([])).toEqual({ ok: true, length: 0 });
  });
});
