import { NextResponse } from 'next/server';
import { loadDemo } from '@/lib/demo';
import { sameSiteOnly } from '@/lib/guardian-auth';
import { rateGuard } from '@/lib/rate-limit';
import { blockedAttempts, buildReport, executedPayments } from '@/lib/report';
import { ELDER_ADDRESS, speechFor } from '@/lib/speech';
import { state } from '@/lib/store';
import { synthesize, ttsEnabled, TtsError } from '@/lib/tts';

export const dynamic = 'force-dynamic';

/**
 * POST /api/tts
 *   { intentId }        唸這一筆的結果（付了 / 要問人 / 是詐騙）
 *   { kind: "weekly" }  唸這個月的週報
 *
 * 回 audio/mpeg；唸不出來（關掉、離線、雲端壞）回 JSON `{ ok: false, text, reason }`，
 * **text 一定給**：瀏覽器拿它用內建語音唸，最差也把字擺在畫面上。
 *
 * 刻意**不收自由文字**。要唸什麼由伺服器從狀態組出來，瀏覽器只說「哪一筆」——
 * 否則任何能開首頁的人都能拿我們的 ElevenLabs 額度唸他自己的東西。
 */

type Body = { intentId?: string; kind?: string };

function intentText(intentId: string): string | undefined {
  const s = state();
  const intent = s.intents.find((i) => i.id === intentId);
  const payment = s.payments.find((p) => p.intentId === intentId);
  if (!intent || !payment) return undefined;
  const decided = s.audit.filter((e) => e.type === 'policy.decided' && e.intentId === intentId).at(-1);
  const hits = decided?.details.rulesHit;
  return speechFor({
    intent,
    payment,
    rulesHit: Array.isArray(hits) ? (hits as string[]) : [],
    guardian: loadDemo().persona.guardian.name,
  });
}

function weeklyText(): string {
  const demo = loadDemo();
  const chain = state();
  return buildReport({
    transactions: demo.transactions,
    usage: demo.usage,
    payees: demo.payees,
    pendingBills: demo.pendingBills,
    blocked: blockedAttempts(chain),
    executed: executedPayments(chain),
    address: ELDER_ADDRESS,
  }).narrative;
}

export async function POST(request: Request) {
  const limited = rateGuard(request, 'tts');
  if (limited) return limited;

  // 別的網站不能借使用者的瀏覽器來燒我們的語音額度。
  const site = sameSiteOnly(request);
  if (!site.ok) return NextResponse.json({ ok: false, error: site.error }, { status: site.status });

  let body: Body;
  try {
    body = (await request.json()) as Body;
  } catch {
    return NextResponse.json({ ok: false, error: 'body 不是合法的 JSON' }, { status: 400 });
  }

  let text: string | undefined;
  if (body.kind === 'weekly') {
    text = weeklyText();
  } else if (typeof body.intentId === 'string' && body.intentId) {
    text = intentText(body.intentId);
    if (text === undefined) {
      return NextResponse.json({ ok: false, error: '找不到這一筆' }, { status: 404 });
    }
  } else {
    return NextResponse.json({ ok: false, error: '要給 intentId，或 kind: "weekly"' }, { status: 400 });
  }

  try {
    const speech = await synthesize(text);
    if (!speech) {
      return NextResponse.json({ ok: false, text, reason: ttsEnabled() ? 'not_recorded' : 'disabled' });
    }
    return new NextResponse(new Uint8Array(speech.audio), {
      headers: {
        'content-type': 'audio/mpeg',
        'content-length': String(speech.audio.byteLength),
        'cache-control': 'private, max-age=3600',
        'x-speech-source': speech.source,
        'x-speech-key': speech.key,
      },
    });
  } catch (err) {
    const message = err instanceof TtsError ? err.message : `語音合成失敗：${String(err)}`;
    return NextResponse.json({ ok: false, text, reason: 'error', error: message });
  }
}
