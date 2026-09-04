import { NextResponse } from 'next/server';
import { effectivePolicy } from '@/lib/store';
import { checkGuardian } from '@/lib/guardian-auth';
import { rateGuard } from '@/lib/rate-limit';
import { assetNetworkFor, currentChainMode } from '@/lib/intent';
import { loadDemo } from '@/lib/demo';
import { write } from '@/lib/execute';
import { PolicyViolation, walletFor } from '@/lib/wallet';
import type { Payee } from '@/lib/types';

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

type Attack = 'not_allowlisted' | 'over_cap' | 'replay' | 'expired';

const ATTACKS: Record<Attack, string> = {
  not_allowlisted: '把錢付給名單外的陌生帳戶',
  over_cap: '一次付出遠超過單筆上限的金額',
  replay: '把剛剛成功的那筆重送一次',
  expired: '拿一份已經過期的授權去付款',
};

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

  let body: { attack?: Attack };
  try {
    body = (await request.json()) as { attack?: Attack };
  } catch {
    return NextResponse.json({ ok: false, error: 'body 不是合法的 JSON' }, { status: 400 });
  }

  const attack = body.attack;
  if (!attack || !(attack in ATTACKS)) {
    return NextResponse.json(
      { ok: false, error: `attack 要是 ${Object.keys(ATTACKS).join(' / ')} 其中一個` },
      { status: 400 },
    );
  }

  const demo = loadDemo();
  const policy = effectivePolicy();
  const wallet = walletFor(policy);
  const now = new Date();

  const allowlisted = demo.payees.find((p) => p.allowlisted)!;
  // 優先挑劇本裡的詐騙帳戶：舞台上「付給 (999) 1234-5678-9012」比
  // 「付給銀髮健身課程」有說服力得多。
  const stranger: Payee =
    demo.payees.find((p) => p.kind === 'unknown') ??
    demo.payees.find((p) => !p.allowlisted) ??
    ({ ...allowlisted, id: 'stranger', allowlisted: false } as Payee);

  const future = new Date(now.getTime() + 10 * 60_000).toISOString();
  const past = new Date(now.getTime() - 60_000).toISOString();

  // 每次用不同的鍵，才不會第二次按下去變成防重放而不是原本要演的那一條
  const fresh = (): `0x${string}` =>
    `0x${Date.now().toString(16).padStart(16, '0')}${Math.random().toString(16).slice(2).padEnd(48, '0')}`.slice(
      0,
      66,
    ) as `0x${string}`;

  const plan: Record<Attack, { payee: Payee; amount: number; memoHash: `0x${string}`; expiresAt: string }> = {
    not_allowlisted: { payee: stranger, amount: 500, memoHash: fresh(), expiresAt: future },
    over_cap: { payee: allowlisted, amount: policy.perTxCap * 20, memoHash: fresh(), expiresAt: future },
    replay: { payee: allowlisted, amount: 100, memoHash: fresh(), expiresAt: future },
    expired: { payee: allowlisted, amount: 100, memoHash: fresh(), expiresAt: past },
  };

  const args = plan[attack];

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
      details: { attack, txHash: receipt.txHash, amount: args.amount },
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
      details: { attack, reason, amount: args.amount, chainMode: currentChainMode() },
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
