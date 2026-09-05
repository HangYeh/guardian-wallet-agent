import { zhAmount } from '@/lib/report';
import type { Payment, PaymentIntent } from '@/lib/types';

/**
 * 唸給阿嬤聽的那一句。
 *
 * 跟週報的口語版一樣**故意不送模型**：這句話唸出來的是金額與「錢有沒有出去」，
 * 模型把三千講成三萬不會有任何東西擋下來。模板短、固定、可測；
 * 阿拉伯數字全部換成中文數字，因為 TTS 拿到「3,000」常常唸成英文。
 *
 * 一句話只講一件事：錢付了 / 錢沒付、要問誰 / 錢沒付、是詐騙。其餘的都留給畫面。
 */

/** 門神叫阿嬤的方式。週報與攔截畫面都用這個，聲音才會是同一個人。 */
export const ELDER_ADDRESS = '阿嬤';

/** 一句話的長度上限。中文 TTS 大約每秒五個字，六十字約十二秒 —— 再長阿嬤就不會聽完。 */
export const SPEECH_MAX = 60;

export type SpeechInput = {
  intent: Pick<PaymentIntent, 'kind'>;
  payment: Pick<Payment, 'status' | 'amount'> & { payee: { name: string } };
  rulesHit: string[];
  /** 守護者的名字，例「小美」 */
  guardian: string;
  address?: string;
};

/**
 * 「小宇（孫子）」唸出來會變成「小宇括號孫子括號」。括號裡是給家人看的備註，不唸。
 */
export function spokenName(name: string): string {
  const stripped = name.replace(/[（(][^）)]*[）)]/g, '').trim();
  return stripped || name;
}

export function speechFor(s: SpeechInput): string {
  const who = s.address ?? ELDER_ADDRESS;
  const name = spokenName(s.payment.payee.name);
  const amount = `${zhAmount(s.payment.amount)}元`;

  switch (s.payment.status) {
    case 'executed':
      return s.intent.kind === 'transfer'
        ? `${who}，${name}的${amount}已經送到了。`
        : `${who}，${name}的帳單${amount}，我已經幫妳繳好了，收據在這裡。`;
    case 'pending_approval':
    case 'approved':
      return `${who}，${name}的${amount}我先問過${s.guardian}再付，妳等一下。`;
    case 'rejected':
      return `${who}，${s.guardian}說${name}這一筆先不付，錢還在。`;
    case 'blocked':
      if (s.rulesHit.includes('ALREADY_SETTLED')) {
        return `${who}，這一筆先前已經付過了，我沒有再付一次。`;
      }
      return `${who}，這是詐騙，錢我沒有轉出去，我已經通知${s.guardian}了，妳不用擔心。`;
    case 'failed':
      return `${who}，這筆錢我沒有付出去，我再問問${s.guardian}。`;
    default:
      return `${who}，這一筆我還在處理，妳等一下。`;
  }
}
