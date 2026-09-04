import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export const dynamic = 'force-dynamic';

/**
 * 把 `demo-data/` 裡的劇本圖片送出去。
 *
 * 不放 `public/` 是為了只留一份來源：解析走的是哪一張圖，畫面上顯示的就是哪一張，
 * 不會有「public 的複本忘了更新」這種難查的落差。
 */

const NAME = /^[\w-]+\.(png|jpe?g|webp)$/i;

const MIME: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
};

export async function GET(_request: Request, ctx: { params: Promise<{ name: string }> }) {
  const { name } = await ctx.params;

  if (!NAME.test(name)) {
    return new Response('不合法的檔名', { status: 400 });
  }

  const ext = name.split('.').pop()!.toLowerCase();

  try {
    const buf = readFileSync(join(process.cwd(), 'demo-data', name));
    return new Response(new Uint8Array(buf), {
      headers: {
        'content-type': MIME[ext] ?? 'application/octet-stream',
        'cache-control': 'public, max-age=3600',
      },
    });
  } catch {
    return new Response('劇本裡沒有這張圖', { status: 404 });
  }
}
