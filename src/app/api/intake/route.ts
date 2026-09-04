import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { NextResponse } from 'next/server';
import { loadDemo } from '@/lib/demo';
import { buildIntent, currentChainMode, intentToTransaction } from '@/lib/intent';
import { matchPayee, parseText } from '@/lib/parser';
import { state } from '@/lib/store';
import type { AuditEvent, IntentSource, TraceStep } from '@/lib/types';

export const dynamic = 'force-dynamic';

/**
 * POST /api/intake
 *
 * 門神的入口。一段文字進來，出去的是一個受管的授權信封。
 * 這條路徑上模型只做一件事：讀。要不要付、付多少、付給誰的地址，
 * 全部由 `buildIntent` 依政策決定，模型碰不到。
 *
 * body 四選一：
 *   { "text": "..." }              直接給原文
 *   { "messageId": "m_redpacket" } 用劇本裡的訊息
 *   { "scenarioId": "electricity" } 用劇本裡的一幕
 *   { "billId": "b002" }           用待繳帳單
 *
 * GET /api/intake?scenario=electricity 是同一件事，方便現場用瀏覽器驗。
 */

type IntakeBody = {
  text?: string;
  messageId?: string;
  scenarioId?: string;
  billId?: string;
  source?: IntentSource;
  taskId?: string;
};

/**
 * 單次輸入的字數上限。一張帳單或一則訊息不會超過這個長度，
 * 超過就是誤貼或惡意灌入 —— 不該原封不動送進要付費的模型。
 */
const MAX_INPUT_CHARS = 4000;

/** 呼叫端自訂的任務代號會進到冪等鍵，所以字元集與長度都要限制。 */
const TASK_ID_PATTERN = /^[\w.:-]{1,80}$/;

export async function POST(request: Request) {
  let body: IntakeBody;
  try {
    body = (await request.json()) as IntakeBody;
  } catch {
    return NextResponse.json({ ok: false, error: 'body 不是合法的 JSON' }, { status: 400 });
  }
  return intake(body);
}

export async function GET(request: Request) {
  const q = new URL(request.url).searchParams;
  return intake({
    text: q.get('text') ?? undefined,
    messageId: q.get('message') ?? undefined,
    scenarioId: q.get('scenario') ?? undefined,
    billId: q.get('bill') ?? undefined,
  });
}

async function intake(body: IntakeBody) {
  const demo = loadDemo();

  let resolved: { text: string; source: IntentSource } | { error: string };
  try {
    resolved = resolveInput(body);
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : String(err) },
      { status: 400 },
    );
  }
  if ('error' in resolved) {
    return NextResponse.json({ ok: false, error: resolved.error }, { status: 400 });
  }

  const { text, source } = resolved;
  const trace: TraceStep[] = [];
  const step = (phase: TraceStep['phase'], detail: string, tool?: string) =>
    trace.push({ t: new Date().toISOString(), phase, tool, detail });

  step('observe', `收到 ${source} 輸入，共 ${text.length} 字`);

  const parsed = await parseText(text, demo.payees);
  step(
    'plan',
    parsed.engine === 'llm'
      ? `${parsed.model} 抽取七個欄位，temperature 0、strict schema，耗時 ${parsed.latencyMs} 毫秒`
      : `模型未使用（${parsed.fallbackReason}），改走規則解析`,
    'parseText',
  );

  const f = parsed.fields;
  step(
    'tool',
    `抽出 ${f.payeeName}｜${f.amount} 元｜到期 ${f.dueDate ?? '未寫'}｜把握度 ${f.confidence.toFixed(2)}`,
    'parseText',
  );

  const payee = matchPayee(demo.payees, f.payeeName, f.category);
  step(
    'tool',
    payee
      ? `對到收款人 ${payee.id}（${payee.allowlisted ? '白名單內' : '不在白名單'}），付款只會流向 ${payee.address}`
      : `名單裡沒有「${f.payeeName}」，之後一律要守護者核准`,
    'matchPayee',
  );

  const intent = buildIntent({
    draft: f,
    rawText: text,
    source,
    policy: demo.policy,
    payee,
    taskId: body.taskId,
  });

  step(
    'verify',
    `信封封緘 ${intent.taskId}｜授權上限 ${intent.maxAmount} 元｜效期至 ${intent.expiresAt}｜冪等鍵 ${intent.idempotencyKey.slice(0, 12)}…`,
  );

  const warnings: string[] = [];
  if (parsed.engine === 'rules') warnings.push('這次是規則解析，不是模型解析，欄位可能不完整');
  if (!payee) warnings.push('收款人不在名單內');
  if (intent.amount > demo.policy.perTxCap) {
    warnings.push(
      `要求金額 ${intent.amount} 元超過單筆上限 ${demo.policy.perTxCap} 元，授權上限已壓到 ${intent.maxAmount} 元`,
    );
  }
  if (f.confidence < 0.6) warnings.push('解析把握度偏低');

  const s = state();
  s.intents.push(intent);
  s.trace.push(...trace);
  s.audit.push(
    auditEvent({
      type: 'intent.received',
      actor: 'elder',
      intentId: intent.id,
      summary: `收到一則${source === 'text' ? '文字' : source}輸入，共 ${text.length} 字`,
      details: { source, chars: text.length },
    }),
    auditEvent({
      type: 'intent.parsed',
      actor: 'agent',
      intentId: intent.id,
      summary: `解析為 ${intent.merchant} ${intent.amount} 元，授權上限 ${intent.maxAmount} 元`,
      details: {
        engine: parsed.engine,
        model: parsed.model,
        latencyMs: parsed.latencyMs,
        confidence: f.confidence,
        statedAccount: f.statedAccount,
        payeeId: payee?.id ?? null,
        taskId: intent.taskId,
      },
      memoHash: intent.idempotencyKey,
    }),
  );

  return NextResponse.json({
    ok: true,
    engine: parsed.engine,
    model: parsed.model,
    latencyMs: parsed.latencyMs,
    fallbackReason: parsed.fallbackReason,
    chainMode: currentChainMode(),
    fields: f,
    intent,
    payee: payee ?? null,
    transaction: intentToTransaction(intent, payee),
    trace,
    warnings,
  });
}

function resolveInput(body: IntakeBody): { text: string; source: IntentSource } | { error: string } {
  const demo = loadDemo();

  if (body.taskId && !TASK_ID_PATTERN.test(body.taskId)) {
    return { error: 'taskId 只能是 80 字元以內的英數與 . : - _' };
  }

  if (body.text?.trim()) {
    const t = body.text.trim();
    if (t.length > MAX_INPUT_CHARS) {
      return { error: `輸入 ${t.length} 字，超過上限 ${MAX_INPUT_CHARS} 字` };
    }
    return { text: t, source: body.source ?? 'text' };
  }

  if (body.messageId) {
    const m = demo.messages.find((x) => x.id === body.messageId);
    if (!m) return { error: `劇本裡沒有訊息 ${body.messageId}` };
    return { text: m.text, source: 'message' };
  }

  if (body.billId) {
    const b = demo.pendingBills.find((x) => x.id === body.billId);
    if (!b) return { error: `劇本裡沒有帳單 ${body.billId}` };
    return {
      text: `${b.merchant}\n繳款通知\n本期應繳金額 NT$${b.amount.toLocaleString('en-US')}\n繳費期限 ${b.dueDate}`,
      source: 'text',
    };
  }

  if (body.scenarioId) {
    const sc = demo.scenarios.find((x) => x.id === body.scenarioId);
    if (!sc) return { error: `劇本裡沒有情境 ${body.scenarioId}` };

    if (sc.input.type === 'text') {
      const m = demo.messages.find((x) => x.id === sc.input.value);
      if (!m) return { error: `情境 ${sc.id} 沒有可解析的文字輸入` };
      return { text: m.text, source: 'message' };
    }

    // 圖片情境在 M1.1 先讀同名的文字版；真正的視覺解析在 M1.2 接上。
    const txt = sc.input.value.replace(/\.(png|jpg|jpeg|webp)$/i, '.txt');
    return { text: readDemoFile(txt), source: 'text' };
  }

  return { error: '要給 text、messageId、scenarioId 或 billId 其中一個' };
}

function readDemoFile(name: string): string {
  // 檔名目前只來自我們自己 commit 進去的劇本，但讀檔的參數就是該擋，不看來源。
  if (!/^[\w-]+\.[a-z]{2,4}$/.test(name)) throw new Error(`不合法的劇本檔名：${name}`);
  return readFileSync(join(process.cwd(), 'demo-data', name), 'utf8');
}

function auditEvent(e: Omit<AuditEvent, 'id' | 'ts'>): AuditEvent {
  return { id: `evt_${crypto.randomUUID().slice(0, 8)}`, ts: new Date().toISOString(), ...e };
}
