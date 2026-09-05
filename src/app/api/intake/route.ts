import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { NextResponse } from 'next/server';
import { newRunId, publish } from '@/lib/bus';
import { rateGuard } from '@/lib/rate-limit';
import { assessRisk } from '@/lib/risk';
import { loadDemo } from '@/lib/demo';
import { executeIntent, write } from '@/lib/execute';
import { walletFor } from '@/lib/wallet';
import { buildIntent, currentChainMode, intentToTransaction } from '@/lib/intent';
import { visionEnabled } from '@/lib/llm';
import { matchPayee, parseImage, parseText, type ParseResult } from '@/lib/parser';
import { speechFor } from '@/lib/speech';
import { allowlistedAt, effectivePolicy, payeesInEffect, state } from '@/lib/store';
import type { IntentSource, TraceStep } from '@/lib/types';

export const dynamic = 'force-dynamic';

/**
 * POST /api/intake
 *
 * 門神的入口。一段文字或一張圖進來，出去的是一個受管的授權信封。
 * 這條路徑上模型只做一件事：讀。要不要付、付多少、付給誰的地址，
 * 全部由 `buildIntent` 依政策決定，模型碰不到。
 *
 * body 五選一：
 *   { "text": "..." }               直接給原文
 *   { "image": "data:image/png;base64,..." }  拍下來的帳單
 *   { "messageId": "m_redpacket" }  用劇本裡的訊息
 *   { "scenarioId": "electricity" } 用劇本裡的一幕
 *   { "billId": "b002" }            用待繳帳單
 *
 * GET /api/intake?scenario=electricity 是同一件事，方便現場用瀏覽器驗。
 */

type IntakeBody = {
  text?: string;
  image?: string;
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

/** 圖片上限（base64 字串長度，約等於 3 MB 原始檔）。手機拍的帳單遠低於這個數字。 */
const MAX_IMAGE_CHARS = 4_000_000;

const IMAGE_DATA_URL = /^data:image\/(png|jpeg|jpg|webp);base64,[A-Za-z0-9+/=\s]+$/;

/** 三種決策的中文說法。 */
const DECISION_LABEL = { auto: '自動繳', hold: '等家人核准', block: '已攔截' } as const;

/** 輸入來源的中文說法。軌跡是要給評審和家人看的，畫面上不該出現 message 這種字。 */
const SOURCE_LABEL: Record<IntentSource, string> = {
  image: '照片',
  text: '文字',
  message: '訊息',
  voice: '語音',
};

/** 呼叫端自訂的任務代號會進到冪等鍵，所以字元集與長度都要限制。 */
const TASK_ID_PATTERN = /^[\w.:-]{1,80}$/;

type Resolved = { text: string; source: IntentSource } | { image: string; source: IntentSource };

export async function POST(request: Request) {
  // 每一發都是一次真的模型呼叫，燒的是作者自己的額度。這道守衛擋的是
  // 寫錯的重試迴圈，以及同一個場館網路上的好奇心。
  const limited = rateGuard(request, 'intake');
  if (limited) return limited;

  let body: IntakeBody;
  try {
    body = (await request.json()) as IntakeBody;
  } catch {
    return NextResponse.json({ ok: false, error: 'body 不是合法的 JSON' }, { status: 400 });
  }
  return intake(body);
}

export async function GET(request: Request) {
  const limited = rateGuard(request, 'intake');
  if (limited) return limited;

  const q = new URL(request.url).searchParams;
  return intake({
    text: q.get('text') ?? undefined,
    messageId: q.get('message') ?? undefined,
    scenarioId: q.get('scenario') ?? undefined,
    billId: q.get('bill') ?? undefined,
  });
}

async function intake(body: IntakeBody) {
  let resolved: Resolved | { error: string };
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

  const runId = newRunId();
  try {
    return await runPipeline(resolved, body, runId);
  } catch (err) {
    // 模型逾時、金鑰失效、劇本檔案不見 —— 舞台上任何一種都可能發生。
    // 一定要收乾淨：不收的話軌跡頁會留著一個永遠跑不完的 run，
    // 看起來像門神當掉了，而不是這一次讀失敗了。
    const detail = err instanceof Error ? err.message : String(err);
    publish({ runId, kind: 'run.error', detail: `這次沒讀成功：${detail}` });
    return NextResponse.json({ ok: false, runId, error: detail }, { status: 500 });
  }
}

async function runPipeline(resolved: Resolved, body: IntakeBody, runId: string) {
  const demo = loadDemo();
  const policy = effectivePolicy();
  // 收款人的白名單旗標要跟現在生效的政策一致，不是劇本檔寫死的那個。
  const payees = payeesInEffect();
  const image = 'image' in resolved ? resolved.image : undefined;
  const inputText = 'text' in resolved ? resolved.text : undefined;
  const isImage = image !== undefined;
  const source = resolved.source;

  const startedAt = Date.now();
  const trace: TraceStep[] = [];
  const step = (phase: TraceStep['phase'], detail: string, tool?: string) => {
    trace.push({ t: new Date().toISOString(), phase, tool, detail });
    // 推到匯流排，軌跡頁在這一刻就長出一行。不是等整條管線跑完才一次吐出來 ——
    // 模型還在讀那張圖的四秒裡，畫面上 observe 那一行已經在了。
    publish({ runId, kind: 'step', phase, tool, detail, elapsedMs: Date.now() - startedAt });
  };

  publish({
    runId,
    kind: 'run.start',
    detail: isImage ? '收到一張帳單照片' : `收到一則${SOURCE_LABEL[source]}輸入`,
    elapsedMs: 0,
  });

  step(
    'observe',
    image
      ? `收到一張圖，約 ${Math.round(image.length / 1365)} KB`
      : `收到一則${SOURCE_LABEL[source]}，共 ${inputText!.length} 字`,
  );

  const parsed: ParseResult = image
    ? await parseImage(image)
    : await parseText(inputText!, payees);

  step(
    'plan',
    parsed.engine === 'llm'
      ? parsed.cached
        ? `同一份輸入先前已解析過，直接用快取結果（${parsed.model}），沒有再呼叫模型`
        : `${parsed.model} ${isImage ? '讀圖' : '讀文字'}抽取欄位，temperature 0、strict schema，耗時 ${parsed.latencyMs} 毫秒`
      : `模型未使用（${parsed.fallbackReason}），${isImage ? '圖片讀不到內容' : '改走規則解析'}`,
    isImage ? 'parseImage' : 'parseText',
  );

  // 之後所有以文字為基礎的檢查都跑在這一段上。圖片的話就是模型讀出來的逐字稿，
  // 因為指令可以印在帳單上，逐字稿必須進入風險分析，不能只留欄位。
  const rawText = isImage ? (parsed.transcript ?? '') : inputText!;

  const f = parsed.fields;
  if (isImage && parsed.transcript) {
    step('tool', `逐字讀到 ${parsed.transcript.length} 字，全文進入後續風險分析`, 'parseImage');
  }
  step(
    'tool',
    `抽出 ${f.payeeName}｜${f.amount} 元｜到期 ${f.dueDate ?? '未寫'}｜把握度 ${f.confidence.toFixed(2)}`,
    isImage ? 'parseImage' : 'parseText',
  );

  const payee = matchPayee(payees, f.payeeName, f.category);
  step(
    'tool',
    payee
      ? `對到收款人 ${payee.id}（${payee.allowlisted ? '白名單內' : '不在白名單'}），付款只會流向 ${payee.address}`
      : `名單裡沒有「${f.payeeName}」，之後一律要守護者核准`,
    'matchPayee',
  );

  const intent = buildIntent({
    draft: f,
    rawText,
    source,
    policy,
    payee,
    taskId: body.taskId,
  });

  step(
    'verify',
    `信封封緘 ${intent.taskId}｜授權上限 ${intent.maxAmount} 元｜效期至 ${intent.expiresAt}｜冪等鍵 ${intent.idempotencyKey.slice(0, 12)}…`,
  );

  const warnings: string[] = [];
  if (parsed.engine === 'rules' && isImage) {
    warnings.push(`圖片沒有解析成功：${parsed.fallbackReason}`);
  } else if (parsed.engine === 'rules') {
    warnings.push('這次是規則解析，不是模型解析，欄位可能不完整');
  } else if (parsed.fallbackReason) {
    // 欄位讀到了但逐字稿沒讀到：畫面照常，但要說清楚風險分析少了一份材料
    warnings.push(parsed.fallbackReason);
  }
  if (!payee) warnings.push('收款人不在名單內');
  if (intent.amount > policy.perTxCap) {
    warnings.push(
      `要求金額 ${intent.amount} 元超過單筆上限 ${policy.perTxCap} 元，授權上限已壓到 ${intent.maxAmount} 元`,
    );
  }
  if (f.confidence < 0.6) warnings.push('解析把握度偏低');

  const s = state();
  s.intents.push(intent);
  s.trace.push(...trace);

  write({
    type: 'intent.received',
    actor: 'elder',
    intentId: intent.id,
    summary: isImage
      ? '收到一張帳單照片'
      : `收到一則${SOURCE_LABEL[source]}輸入，共 ${rawText.length} 字`,
    details: { source, chars: rawText.length },
  });
  write({
    type: 'intent.parsed',
    actor: 'agent',
    intentId: intent.id,
    summary: `解析為 ${intent.merchant} ${intent.amount} 元，授權上限 ${intent.maxAmount} 元`,
    details: {
      engine: parsed.engine,
      model: parsed.model ?? null,
      latencyMs: parsed.latencyMs ?? null,
      confidence: f.confidence,
      statedAccount: f.statedAccount,
      payeeId: payee?.id ?? null,
      taskId: intent.taskId,
    },
    memoHash: intent.idempotencyKey,
  });

  // ---- 風險 ----
  //
  // 跑在 rawText 上，不是跑在抽出來的欄位上。圖片的話 rawText 就是**另一顆模型**
  // 獨立讀出來的逐字稿 —— 因為指令可以印在帳單角落，只看欄位是看不到的。
  //
  // 規則先跑，模型後疊，而且模型**只能往上加分**（§7.3 的地板）。
  // 命中硬鎖時連問都不問模型 —— 分級已經定案，問了也改不了結果，
  // 而且可以少讓那段惡意文字進一次模型。
  const risk = await assessRisk({
    text: rawText,
    amount: intent.amount,
    approvalThreshold: policy.approvalThreshold,
    payee,
    statedAccount: f.statedAccount,
    blocklist: demo.blocklist,
    typicalAmount: payee?.typicalAmount,
    quietHours: policy.quietHours,
  });
  const riskLevel = risk.level;

  if (riskLevel !== 'low') {
    warnings.push(`風險 ${riskLevel}（${risk.score} 分）：${risk.guardianExplanation}`);
  }

  step(
    'tool',
    risk.signals.length === 0
      ? '風險規則全部沒命中，規則分 0'
      : `規則分 ${risk.rulesScore}（話術 ${risk.groups.tacticScore}、政策 ${risk.rulesScore - risk.groups.tacticScore}）：${risk.signals.map((s) => s.code).join('、')}`,
    'ruleSignals',
  );
  step(
    'plan',
    risk.engine === 'rules+llm'
      ? `模型另判 ${risk.llmScore} 分，合成後 ${risk.score}（${riskLevel}）`
      : `沒問模型：${risk.fallbackReason}。分數維持 ${risk.score}（${riskLevel}）`,
    'assessRisk',
  );

  write({
    type: 'risk.assessed',
    actor: 'agent',
    intentId: intent.id,
    summary: `風險 ${risk.score} 分（${riskLevel}）${risk.hardLocked ? '，命中硬鎖' : ''}｜${risk.engine}`,
    details: {
      score: risk.score,
      rulesScore: risk.rulesScore,
      llmScore: risk.engine === 'rules+llm' ? risk.llmScore : null,
      level: riskLevel,
      hardLocked: risk.hardLocked,
      // 話術特徵與規則原因分開記。「有風險」跟「要問人」是兩件事（§7.3 B 案），
      // 稽核紀錄也要看得出來是哪一種，不然事後分不清門神當時在擔心什麼。
      tacticScore: risk.groups.tacticScore,
      tactics: risk.groups.tactics.map((s) => ({ code: s.code, weight: s.weight, evidence: s.evidence })),
      policyReasons: risk.groups.policyReasons.map((s) => ({ code: s.code, weight: s.weight, evidence: s.evidence })),
      scamType: risk.scamType,
      engine: risk.engine,
      model: risk.model ?? null,
      fallbackReason: risk.fallbackReason ?? null,
      narrativeDropped: risk.narrativeDropped ?? null,
    },
    memoHash: intent.idempotencyKey,
  });

  // ---- 政策與執行 ----
  const { decision, payment } = await executeIntent({
    intent,
    policy,
    wallet: walletFor(policy),
    payee,
    risk: riskLevel,
    // 守護者剛加進白名單的人，帶上加入時間讓冷卻期真的能觸發。
    payeeAddedAt: payee ? allowlistedAt(payee.id) : undefined,
  });

  step(
    'verify',
    `政策判定 ${decision.action}：${decision.reason}`,
    'policy.decide',
  );
  if (payment.status === 'executed') {
    step('tool', `已付款，交易雜湊 ${payment.txHash?.slice(0, 14)}…`, 'wallet.pay');
  } else if (payment.status === 'pending_approval') {
    step('verify', `生成提案 ${payment.id}，等守護者核准`, 'wallet.propose');
  } else if (payment.status === 'blocked') {
    step('verify', '已攔截，不會產生任何付款', 'policy.block');
  } else if (payment.status === 'failed') {
    step('verify', `鏈上擋下：${payment.revertReason}`, 'wallet.pay');
  }

  publish({
    runId,
    kind: 'run.end',
    detail: `${intent.merchant}｜${DECISION_LABEL[decision.action]}｜${intent.maxAmount} 元${
      warnings.length ? `｜${warnings.length} 項要注意` : ''
    }`,
    elapsedMs: Date.now() - startedAt,
  });

  return NextResponse.json({
    ok: true,
    runId,
    engine: parsed.engine,
    model: parsed.model,
    latencyMs: parsed.latencyMs,
    fallbackReason: parsed.fallbackReason,
    chainMode: currentChainMode(),
    // 唸給阿嬤聽的那一句。字先給畫面，聲音由 /api/tts 用 intentId 再要 —— 瀏覽器不送文字。
    speech: {
      text: speechFor({
        intent,
        payment,
        rulesHit: decision.rulesHit,
        guardian: demo.persona.guardian.name,
      }),
    },
    fields: f,
    transcript: parsed.transcript,
    intent,
    risk: {
      score: risk.score,
      rulesScore: risk.rulesScore,
      llmScore: risk.engine === 'rules+llm' ? risk.llmScore : null,
      level: riskLevel,
      hardLocked: risk.hardLocked,
      signals: risk.signals,
      // 畫面要分開講，不能把「有人想騙你」跟「這件事要問人」混在同一個數字裡
      tactics: risk.groups.tactics,
      tacticScore: risk.groups.tacticScore,
      policyReasons: risk.groups.policyReasons,
      scamType: risk.scamType,
      elderExplanation: risk.elderExplanation,
      guardianExplanation: risk.guardianExplanation,
      engine: risk.engine,
      model: risk.model ?? null,
      fallbackReason: risk.fallbackReason ?? null,
      narrativeDropped: risk.narrativeDropped ?? null,
    },
    decision,
    payment,
    payee: payee ?? null,
    transaction: intentToTransaction(intent, payee),
    trace,
    warnings,
  });
}

function resolveInput(body: IntakeBody): Resolved | { error: string } {
  const demo = loadDemo();

  if (body.taskId && !TASK_ID_PATTERN.test(body.taskId)) {
    return { error: 'taskId 只能是 80 字元以內的英數與 . : - _' };
  }

  if (body.image) {
    if (body.image.length > MAX_IMAGE_CHARS) {
      return { error: `圖片太大（約 ${Math.round(body.image.length / 1365)} KB），上限約 3 MB` };
    }
    if (!IMAGE_DATA_URL.test(body.image)) {
      return { error: '圖片要是 data:image/(png|jpeg|webp);base64 格式' };
    }
    return { image: body.image, source: 'image' };
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

    // 圖片情境：視覺模式開著就真的看圖；關著就讀同名的文字版。
    // 這條降級路徑就是 fixtures 模式在現場網路壞掉時要走的。
    if (visionEnabled()) {
      return { image: readDemoImage(sc.input.value), source: 'image' };
    }
    return {
      text: readDemoText(sc.input.value.replace(/\.(png|jpe?g|webp)$/i, '.txt')),
      source: 'text',
    };
  }

  return { error: '要給 text、image、messageId、scenarioId 或 billId 其中一個' };
}

// 檔名目前只來自我們自己 commit 進去的劇本，但讀檔的參數就是該擋，不看來源。
function demoPath(name: string, pattern: RegExp): string {
  if (!pattern.test(name)) throw new Error(`不合法的劇本檔名：${name}`);
  return join(process.cwd(), 'demo-data', name);
}

function readDemoText(name: string): string {
  return readFileSync(demoPath(name, /^[\w-]+\.txt$/), 'utf8');
}

function readDemoImage(name: string): string {
  const path = demoPath(name, /^[\w-]+\.(png|jpe?g|webp)$/i);
  const ext = name.split('.').pop()!.toLowerCase();
  const mime = ext === 'png' ? 'image/png' : ext === 'webp' ? 'image/webp' : 'image/jpeg';
  return `data:${mime};base64,${readFileSync(path).toString('base64')}`;
}
