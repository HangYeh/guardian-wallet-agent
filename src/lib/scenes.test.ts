import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadDemo } from '@/lib/demo';
import { SCENES, sceneById, sceneUrl } from '@/lib/scenes';

/**
 * 劇本按鈕跟劇本檔要一對一。
 *
 * 少一顆按鈕，舞台上那一幕就演不出來；多一顆按鈕，按下去是 400。
 * 兩種都不會在 tsc 或 lint 裡被抓到，所以放在這裡。
 */
describe('劇本按鈕', () => {
  it('每一顆按鈕都有對應的情境，每一個情境都有按鈕', () => {
    const buttons = SCENES.map((s) => s.id).sort();
    const scenarios = loadDemo()
      .scenarios.map((s) => s.id)
      .sort();
    expect(buttons).toEqual(scenarios);
  });

  it('順序就是舞台順序：四幕在前、加演在後', () => {
    expect(SCENES.filter((s) => !s.encore).map((s) => s.act)).toEqual(['幕一', '幕二', '幕三', '幕四']);
    expect(SCENES.slice(4).every((s) => s.encore)).toBe(true);
  });

  it('網址：週報去稽核頁，其餘去阿嬤頁；流水號讓同一幕連按兩次也算兩次', () => {
    expect(sceneUrl(sceneById('weekly_report')!, 7)).toBe('/audit?play=weekly&n=7');
    expect(sceneUrl(sceneById('scam_nhi')!, 7)).toBe('/?play=scam_nhi&n=7');
    expect(sceneUrl(sceneById('scam_nhi')!, 8)).not.toBe(sceneUrl(sceneById('scam_nhi')!, 7));
  });

  it('幕一帶著帳單圖，而且那張圖真的在 demo-data 裡', () => {
    const s = sceneById('electricity')!;
    expect(s.preview).toBe('/api/demo-image/bill-taipower.png');
    expect(existsSync(join(process.cwd(), 'demo-data', 'bill-taipower.png'))).toBe(true);
  });

  it('不認識的幕回 undefined，不會炸', () => {
    expect(sceneById('nope')).toBeUndefined();
  });
});
