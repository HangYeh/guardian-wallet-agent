import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

/**
 * 四幕 + 兩則加演，離線整條跑一遍。**舞台的保險絲測試。**
 *
 * `DEMO_MODE=fixtures`、沒有 OPENAI_API_KEY、fetch 被換成會炸的假物件、`CHAIN_MODE=mock`：
 * 從 /api/intake 進、到 /api/guardian 核准、到週報的頭條數字，走的是真的 route handler，
 * 不是 mock 過的函式。劇本檔的 `scenarios[].expected` 就是期望值 —— 劇本說幕二要 block、
 * 風險 high、對方開口要 50,000，這裡就要一模一樣。
 *
 * 另外兩件只有整條跑才看得到的事：
 *   1. 每一幕唸給阿嬤聽的那一句都有錄音（`demo-data/audio/`），台上不用金鑰也不用網路
 *   2. 重置後可重跑：同一幕不重置連演兩次會被自己的防重放擋下（這是對的），
 *      重置之後要能再付一次，而且是真的重讀、不是拿上一次的解析
 */

const TMP = mkdtempSync(join(tmpdir(), 'guardian-pipeline-'));
process.env.GUARDIAN_AUDIT_FILE = join(TMP, 'audit.jsonl');
process.env.DEMO_MODE = 'fixtures';
process.env.RECORD_FIXTURES = 'false';
process.env.CHAIN_MODE = 'mock';
// 錄音是開著視覺錄的（鍵包含請求內容），播放時旗標要一致。
process.env.ENABLE_VISION = 'true';
process.env.ENABLE_TTS = 'false';
process.env.GUARDIAN_TOKEN = 'test-only-token';
// 這一檔的重點：沒有金鑰也要跑完。
delete process.env.OPENAI_API_KEY;
delete process.env.GUARDIAN_FIXTURE_DIR;
delete process.env.GUARDIAN_AUDIO_DIR;

const TOKEN = process.env.GUARDIAN_TOKEN;
const ORIGIN = 'http://localhost:3000';

// 模組讀 env 有些在載入時，所以要在設好之後才 import
const intakeRoute = await import('@/app/api/intake/route');
const guardianRoute = await import('@/app/api/guardian/route');
const resetRoute = await import('@/app/api/demo/reset/route');
const { loadDemo } = await import('@/lib/demo');
const { state, updatePolicy } = await import('@/lib/store');
const { blockedAttempts, buildReport, executedPayments } = await import('@/lib/report');
const { ELDER_ADDRESS, speechFor } = await import('@/lib/speech');
const { audioDirs, speechKey } = await import('@/lib/tts');
const { readAuditFile, verifyChain } = await import('@/lib/audit');

const demo = loadDemo();

type Intake = {
  ok: boolean;
  error?: string;
  model?: string;
  intent: { id: string; amount: number };
  decision: { action: string; rulesHit: string[]; reason: string };
  risk: { level: string; hardLocked: boolean; tacticScore: number };
  payment: { id: string; status: string };
  speech: { text: string };
  trace: { phase: string; detail: string }[];
};

function expected(id: string) {
  const s = demo.scenarios.find((x) => x.id === id);
  if (!s) throw new Error(`劇本裡沒有 ${id}`);
  return s.expected;
}

function post(path: string, body: unknown, headers: Record<string, string> = {}): Request {
  return new Request(`${ORIGIN}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
}

async function intake(scenarioId: string): Promise<Intake> {
  const res = await intakeRoute.POST(post('/api/intake', { scenarioId }));
  const body = (await res.json()) as Intake;
  expect(res.status, `${scenarioId}: ${body.error ?? ''}`).toBe(200);
  expect(body.ok).toBe(true);
  return body;
}

async function reset(): Promise<void> {
  const res = await resetRoute.POST(
    new Request(`${ORIGIN}/api/demo/reset`, { method: 'POST', headers: { 'x-guardian-token': TOKEN! } }),
  );
  expect(res.status).toBe(200);
  // 深夜跑測試時安靜時段會把幕一變成 hold。那是政策在做事，不是這一檔要測的。
  updatePolicy({ quietHours: undefined });
}

/** 這一句有沒有錄音。有 → 台上不用金鑰也不用網路。 */
function recorded(text: string): boolean {
  return existsSync(join(audioDirs().recorded, `${speechKey(text)}.mp3`));
}

function weekly() {
  const s = state();
  return buildReport({
    transactions: demo.transactions,
    usage: demo.usage,
    payees: demo.payees,
    pendingBills: demo.pendingBills,
    blocked: blockedAttempts(s),
    executed: executedPayments(s),
    address: ELDER_ADDRESS,
  });
}

beforeAll(async () => {
  vi.stubGlobal('fetch', () => {
    throw new Error('離線測試不准碰網路');
  });
  await reset();
});

afterAll(() => {
  vi.unstubAllGlobals();
  rmSync(TMP, { recursive: true, force: true });
});

describe('四幕照劇本跑（離線、沒金鑰）', () => {
  it('幕一 電費：白名單、額度內 → 自動繳，付款已執行；用的是錄音回放', async () => {
    const r = await intake('electricity');
    const e = expected('electricity');
    expect(r.decision.action).toBe(e.action);
    expect(r.risk.level).toBe(e.riskLevel);
    expect(r.intent.amount).toBe(e.amount);
    expect(r.payment.status).toBe('executed');
    // 真的是離線播放，不是偷偷連網；軌跡上也要誠實寫出來
    expect(r.model).toContain('錄音回放');
    expect(recorded(r.speech.text), `沒錄音：${r.speech.text}`).toBe(true);
  });

  it('幕二 健保署詐騙：block、high、對方開口要 50,000，一毛沒出去', async () => {
    const r = await intake('scam_nhi');
    const e = expected('scam_nhi');
    expect(r.decision.action).toBe(e.action);
    expect(r.risk.level).toBe(e.riskLevel);
    expect(r.intent.amount).toBe(e.amount);
    expect(r.payment.status).toBe('blocked');
    expect(r.risk.hardLocked).toBe(true);
    expect(recorded(r.speech.text), `沒錄音：${r.speech.text}`).toBe(true);
  });

  it('幕三 孫子紅包：新收款人 → 等家人；沒 token 核准不了；家人核准後付出去', async () => {
    const r = await intake('redpacket');
    const e = expected('redpacket');
    expect(r.decision.action).toBe(e.action);
    // medium 是政策原因（不在白名單、超過門檻）堆出來的，不是詐騙跡象：
    // 話術分要是 0，畫面才能誠實地說「這些不是詐騙的跡象，只是門神照規矩要先問過人」。
    expect(r.risk.level).toBe(e.riskLevel);
    expect(r.risk.tacticScore).toBe(0);
    expect(r.intent.amount).toBe(e.amount);
    expect(r.payment.status).toBe('pending_approval');
    expect(recorded(r.speech.text), `沒錄音：${r.speech.text}`).toBe(true);

    // 沒帶 token：401，狀態不動
    const denied = await guardianRoute.POST(post('/api/guardian', { paymentId: r.payment.id, action: 'approve' }));
    expect(denied.status).toBe(401);
    expect(state().payments.find((p) => p.id === r.payment.id)?.status).toBe('pending_approval');

    // 家人核准
    const ok = await guardianRoute.POST(
      post('/api/guardian', { paymentId: r.payment.id, action: 'approve' }, { 'x-guardian-token': TOKEN! }),
    );
    const body = (await ok.json()) as { ok: boolean; payment: { status: string }; error?: string };
    expect(ok.status, body.error ?? '').toBe(200);
    expect(body.payment.status).toBe('executed');

    // 核准後唸的那一句（「已經送到了」）也要有錄音
    const paid = state().payments.find((p) => p.id === r.payment.id)!;
    const intent = state().intents.find((i) => i.id === r.intent.id)!;
    const line = speechFor({ intent, payment: paid, rulesHit: r.decision.rulesHit, guardian: demo.persona.guardian.name });
    expect(recorded(line), `沒錄音：${line}`).toBe(true);
  });

  it('幕四 週報：頭條從稽核鏈算出來，等於劇本檔的期望值；唸的那一段有錄音', () => {
    const report = weekly();
    expect(report.guardedTotal).toBe(demo.expectedReport.guardedTotal);
    expect(report.blockedAmount).toBe(demo.expectedReport.blockedScam);
    expect(report.paymentsExecuted).toBe(2); // 幕一自動繳 + 幕三核准後
    expect(recorded(report.narrative), `沒錄音：${report.narrative}`).toBe(true);
  });

  it('加演兩則：投資詐騙、假孫子，都擋下；同一句攔截台詞，共用一份錄音', async () => {
    for (const id of ['scam_investment', 'scam_grandchild']) {
      const r = await intake(id);
      const e = expected(id);
      expect(r.decision.action, id).toBe(e.action);
      expect(r.risk.level, id).toBe(e.riskLevel);
      expect(r.intent.amount, id).toBe(e.amount);
      expect(r.payment.status, id).toBe('blocked');
      expect(recorded(r.speech.text), `沒錄音：${r.speech.text}`).toBe(true);
    }
    // 加演之後攔下的總額會變，週報也要跟著變 —— 它是算出來的，不是抄的
    expect(weekly().blockedAmount).toBe(50_000 + 20_000 + 15_000);
  });

  it('跑完六幕，稽核鏈每一筆都接得上', () => {
    const { events, badLines } = readAuditFile();
    expect(badLines).toEqual([]);
    expect(events.length).toBeGreaterThan(10);
    expect(verifyChain(events).ok).toBe(true);
  });
});

describe('重置後可重跑', () => {
  it('同一幕不重置連演兩次：第二次被自己的防重放擋下，不會付兩次', async () => {
    const before = state().payments.filter((p) => p.status === 'executed').length;
    const again = await intake('electricity');
    expect(again.payment.status).not.toBe('executed');
    expect(again.decision.rulesHit).toContain('ALREADY_SETTLED');
    expect(state().payments.filter((p) => p.status === 'executed').length).toBe(before);
  });

  it('重置之後同一幕再演一次：照樣付得出去，而且是真的重讀，不是拿上一次的解析', async () => {
    await reset();
    expect(state().payments).toEqual([]);
    expect(state().intents).toEqual([]);

    const r = await intake('electricity');
    expect(r.decision.action).toBe('auto');
    expect(r.payment.status).toBe('executed');
    expect(r.trace.some((t) => t.detail.includes('快取'))).toBe(false);
    expect(weekly().guardedTotal).toBe(
      demo.expectedReport.duplicateRefund + demo.expectedReport.zombieCancel,
    );
  });
});
