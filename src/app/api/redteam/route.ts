import { NextResponse } from 'next/server';
import { effectivePolicy } from '@/lib/store';
import { checkGuardian } from '@/lib/guardian-auth';
import { rateGuard } from '@/lib/rate-limit';
import { assetNetworkFor, currentChainMode } from '@/lib/intent';
import { loadDemo } from '@/lib/demo';
import { ATTACKS, buildAttack, isAttack } from '@/lib/redteam';
import { write } from '@/lib/execute';
import { PolicyViolation, walletFor } from '@/lib/wallet';

export const dynamic = 'force-dynamic';

/**
 * POST /api/redteam —— 紅隊按鈕。
 *
 * 這一支刻意繞過政策引擎，直接拿 operator 的鑰匙去打合約。
 * 也就是說：**假設鏈下全部被攻破了** —— 解析被騙、風險模型被說服、
 * 政策引擎被繞過 —— 錢還出得去嗎？
 *
 * 答案是四句 revert。這就是「政策寫在合約裡」跟「政策寫在應用層」的差別，
 * 而且它是演出來的，不是講出來的。
 *
 * **兩道守衛，因為這支端點會用 operator 的金鑰送出真的交易：**
 *   1. 預設關閉 —— `ENABLE_REDTEAM` 不是 'true' 就回 404（連存在都不承認）
 *   2. 就算打開，也要帶 `GUARDIAN_TOKEN`
 *
 * 只有第一道是不夠的：舞台上一定會把旗標打開，而那時候同一個場館網路上的
 * 任何人都打得到它。燒的是測試網 gas 不多，但那是我們的 operator 金鑰在簽名，
 * 而「誰能讓我們的金鑰簽東西」這件事不該只由一個環境變數決定。
 */


function enabled(): boolean {
  return process.env.ENABLE_REDTEAM === 'true';
}

export async function GET(request: Request) {
  if (!enabled()) return new NextResponse(null, { status: 404 });

  const limited = rateGuard(request, 'redteam');
  if (limited) return limited;

  const guard = checkGuardian(request);
  if (!guard.ok) {
    return NextResponse.json({ ok: false, error: guard.error }, { status: guard.status });
  }

  return NextResponse.json({
    ok: true,
    chainMode: currentChainMode(),
    attacks: Object.entries(ATTACKS).map(([id, label]) => ({ id, label })),
  });
}

export async function POST(request: Request) {
  if (!enabled()) return new NextResponse(null, { status: 404 });

  const limited = rateGuard(request, 'redteam');
  if (limited) return limited;

  const guard = checkGuardian(request);
  if (!guard.ok) {
    return NextResponse.json({ ok: false, error: guard.error }, { status: guard.status });
  }

  let body: { attack?: unknown };
  try {
    body = (await request.json()) as { attack?: unknown };
  } catch {
    return NextResponse.json({ ok: false, error: 'body 不是合法的 JSON' }, { status: 400 });
  }

  const attack = body.attack;
  if (!isAttack(attack)) {
    return NextResponse.json(
      { ok: false, error: `attack 要是 ${Object.keys(ATTACKS).join(' / ')} 其中一個` },
      { status: 400 },
    );
  }

  const demo = loadDemo();
  const policy = effectivePolicy();
  const wallet = walletFor(policy);
  const now = new Date();

  const built = buildAttack(attack, { demo, policy, now });
  if ('error' in built) {
    return NextResponse.json({ ok: false, error: built.error }, { status: 500 });
  }
  const { args } = built;

  // 重放這一條要先成功付一次，才有東西可以重放
  let setup: string | undefined;
  if (attack === 'replay') {
    try {
      await wallet.pay(args, now);
      setup = '先正常付了一筆（在政策範圍內），現在拿同一把冪等鍵再送一次';
    } catch (err) {
      return NextResponse.json({
        ok: false,
        attack,
        error: `連第一筆都沒付成功，無法演示重放：${err instanceof Error ? err.message : err}`,
      });
    }
  }

  try {
    const receipt = await wallet.pay(args, now);

    // 走到這裡代表防線破了。這是嚴重的事，要大聲一點。
    write({
      type: 'payment.executed',
      actor: 'chain',
      summary: `⚠ 紅隊「${ATTACKS[attack]}」竟然成功了`,
      details: { attack, txHash: receipt.txHash, amount: args.amount, source: 'redteam-api' },
      memoHash: args.memoHash,
    });

    return NextResponse.json({
      ok: true,
      attack,
      label: ATTACKS[attack],
      blocked: false,
      warning: '防線沒擋住 —— 這是 bug，不是預期結果',
      txHash: receipt.txHash,
    });
  } catch (err) {
    const reason = err instanceof PolicyViolation ? err.message : String(err);

    write({
      type: 'payment.blocked',
      actor: 'chain',
      summary: `紅隊「${ATTACKS[attack]}」被合約擋下：${reason}`,
      details: { attack, reason, amount: args.amount, chainMode: currentChainMode(), source: 'redteam-api' },
      memoHash: args.memoHash,
    });

    return NextResponse.json({
      ok: true,
      attack,
      label: ATTACKS[attack],
      blocked: true,
      reason,
      setup,
      chainMode: currentChainMode(),
      assetNetwork: assetNetworkFor(currentChainMode()),
      attempted: { payee: args.payee.name, address: args.payee.address, amount: args.amount },
    });
  }
}
