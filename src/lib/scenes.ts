import type { ScenarioId } from '@/lib/types';

/**
 * 劇本按鈕。
 *
 * 舞台上的順序就是這個順序：四幕照演，兩則加演留給 Q&A。
 * 每一顆按鈕對應 `demo-data/guardian-demo.json` 的一個 scenario ——
 * `scenes.test.ts` 會確認兩邊一對一，多一顆按鈕或多一個情境都是紅燈。
 *
 * 這個檔案刻意沒有任何伺服器端的 import：demo bar 與阿嬤的操作台都是
 * client component，它們只需要知道「有哪幾幕、按了要去哪」。
 */
export type Scene = {
  id: ScenarioId;
  /** 幕一、幕二……加演 */
  act: string;
  label: string;
  /** 在哪一頁演。週報在稽核頁，其餘都在阿嬤的操作台。 */
  page: '/' | '/audit';
  /** 阿嬤頁左邊要一起秀的圖（幕一的帳單）。 */
  preview?: string;
  encore?: boolean;
};

export const SCENES: readonly Scene[] = [
  { id: 'electricity', act: '幕一', label: '電費', page: '/', preview: '/api/demo-image/bill-taipower.png' },
  { id: 'scam_nhi', act: '幕二', label: '詐騙', page: '/' },
  { id: 'redpacket', act: '幕三', label: '紅包', page: '/' },
  { id: 'weekly_report', act: '幕四', label: '週報', page: '/audit' },
  { id: 'scam_investment', act: '加演', label: '假投資', page: '/', encore: true },
  { id: 'scam_grandchild', act: '加演', label: '假孫子', page: '/', encore: true },
];

export function sceneById(id: string): Scene | undefined {
  return SCENES.find((s) => s.id === id);
}

/**
 * 按鈕帶人去的網址。
 *
 * 用網址而不是用事件傳，是因為按鈕每一頁都有、演出的元件卻只在兩頁：
 * 從守護者頁按「幕一」要先換頁，換完頁元件才掛上，事件早就發完了；
 * 網址不會消失。另一個好處是 `/?play=scam_nhi` 這種網址本身就能用，錄影時直接開它。
 *
 * `n` 是流水號：同一幕連按兩次，網址不同才會重新導、才算兩次。
 */
export function sceneUrl(scene: Scene, nonce: number): string {
  const play = scene.id === 'weekly_report' ? 'weekly' : scene.id;
  return `${scene.page}?play=${play}&n=${nonce}`;
}
