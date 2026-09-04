import { describe, expect, it } from 'vitest';
import { buildIdempotencyKey, intentExpiry, isIntentExpired, INTENT_TTL_MS } from '@/lib/intent';

const base = {
  taskId: 'bill-2026-09-taipower',
  merchant: '台灣電力公司',
  amount: 1280,
  expiresAt: '2026-09-04T13:15:00.000Z',
};

describe('buildIdempotencyKey', () => {
  it('是 32 bytes 的 keccak256 雜湊', () => {
    expect(buildIdempotencyKey(base)).toMatch(/^0x[0-9a-f]{64}$/);
  });

  it('同樣的 intent 得到同一把鍵（逾時重試不會變成第二筆付款）', () => {
    expect(buildIdempotencyKey(base)).toBe(buildIdempotencyKey({ ...base }));
  });

  it('金額不同就是不同的鍵', () => {
    expect(buildIdempotencyKey({ ...base, amount: 1281 })).not.toBe(buildIdempotencyKey(base));
  });

  it('收款人不同就是不同的鍵', () => {
    expect(buildIdempotencyKey({ ...base, merchant: '詐騙帳戶' })).not.toBe(
      buildIdempotencyKey(base),
    );
  });
});

describe('intent 效期', () => {
  it('預設效期是 15 分鐘', () => {
    const now = new Date('2026-09-04T13:00:00.000Z');
    expect(intentExpiry(now)).toBe('2026-09-04T13:15:00.000Z');
    expect(INTENT_TTL_MS).toBe(900_000);
  });

  it('未到期回 false，到期後回 true', () => {
    const intent = { expiresAt: '2026-09-04T13:15:00.000Z' };
    expect(isIntentExpired(intent, new Date('2026-09-04T13:14:59.000Z'))).toBe(false);
    expect(isIntentExpired(intent, new Date('2026-09-04T13:15:01.000Z'))).toBe(true);
  });
});
