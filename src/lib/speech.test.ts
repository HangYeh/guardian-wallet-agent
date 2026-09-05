import { describe, expect, it } from 'vitest';
import { ELDER_ADDRESS, SPEECH_MAX, speechFor, spokenName, type SpeechInput } from '@/lib/speech';

/**
 * 唸給阿嬤聽的那一句。
 *
 * 守兩件事：金額是中文數字（TTS 拿到阿拉伯數字會唸成英文），
 * 而且每一種結果都有話可說 —— 沒有一種狀態會讓阿嬤面對沉默。
 */

function input(over: Partial<SpeechInput> & { status: SpeechInput['payment']['status']; amount?: number; name?: string; kind?: 'bill' | 'transfer' }): SpeechInput {
  return {
    intent: { kind: over.kind ?? 'bill' },
    payment: { status: over.status, amount: over.amount ?? 1280, payee: { name: over.name ?? '台灣電力公司' } },
    rulesHit: over.rulesHit ?? [],
    guardian: over.guardian ?? '小美',
    address: over.address,
  };
}

describe('阿嬤那一句', () => {
  it('幕一：帳單繳好了，金額是中文數字', () => {
    const s = speechFor(input({ status: 'executed' }));
    expect(s).toBe('阿嬤，台灣電力公司的帳單一千二百八十元，我已經幫妳繳好了，收據在這裡。');
    expect(s).not.toMatch(/\d/);
  });

  it('幕三核准後：紅包送到了，備註括號不唸', () => {
    const s = speechFor(input({ status: 'executed', kind: 'transfer', amount: 3000, name: '小宇（孫子）' }));
    expect(s).toBe('阿嬤，小宇的三千元已經送到了。');
  });

  it('幕三等核准：說要先問小美', () => {
    const s = speechFor(input({ status: 'pending_approval', kind: 'transfer', amount: 3000, name: '小宇（孫子）' }));
    expect(s).toBe('阿嬤，小宇的三千元我先問過小美再付，妳等一下。');
  });

  it('幕二：擋下詐騙，安撫，說已經通知家人', () => {
    const s = speechFor(input({ status: 'blocked', rulesHit: ['RISK_HIGH'] }));
    expect(s).toBe('阿嬤，這是詐騙，錢我沒有轉出去，我已經通知小美了，妳不用擔心。');
  });

  it('重送被擋（ALREADY_SETTLED）不是詐騙，話要不一樣', () => {
    const s = speechFor(input({ status: 'blocked', rulesHit: ['ALREADY_SETTLED'] }));
    expect(s).toContain('先前已經付過了');
    expect(s).not.toContain('詐騙');
  });

  it('被拒絕、鏈上失敗、其他狀態都有話說', () => {
    expect(speechFor(input({ status: 'rejected' }))).toContain('先不付');
    expect(speechFor(input({ status: 'failed' }))).toContain('沒有付出去');
    expect(speechFor(input({ status: 'scheduled' }))).toContain('還在處理');
  });

  it('稱呼可以換，預設是阿嬤', () => {
    expect(speechFor(input({ status: 'executed' })).startsWith(`${ELDER_ADDRESS}，`)).toBe(true);
    expect(speechFor(input({ status: 'executed', address: '媽' })).startsWith('媽，')).toBe(true);
  });

  it('劇本裡每一句都在長度上限內', () => {
    const lines = [
      speechFor(input({ status: 'executed' })),
      speechFor(input({ status: 'executed', kind: 'transfer', amount: 3000, name: '小宇（孫子）' })),
      speechFor(input({ status: 'pending_approval', kind: 'transfer', amount: 3000, name: '小宇（孫子）' })),
      speechFor(input({ status: 'blocked', rulesHit: ['RISK_HIGH'] })),
      speechFor(input({ status: 'blocked', rulesHit: ['ALREADY_SETTLED'] })),
      speechFor(input({ status: 'rejected' })),
      speechFor(input({ status: 'failed' })),
    ];
    for (const l of lines) expect(l.length, l).toBeLessThanOrEqual(SPEECH_MAX);
  });

  it('spokenName 只拿掉括號備註，沒有括號就原樣', () => {
    expect(spokenName('小宇（孫子）')).toBe('小宇');
    expect(spokenName('小宇 (孫子)')).toBe('小宇');
    expect(spokenName('台灣電力公司')).toBe('台灣電力公司');
    expect(spokenName('（）')).toBe('（）');
  });
});
