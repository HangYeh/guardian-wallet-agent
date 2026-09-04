import type { NextConfig } from 'next';

/**
 * 安全標頭。
 *
 * 這個站不收密碼也不放個資，但它會在比賽場館的網路上跑，而且評審會打開它。
 * 這幾條是零成本的基本盤，沒有理由不設。
 */
const SECURITY_HEADERS = [
  // 不要讓瀏覽器自己猜 MIME —— 猜錯就是把上傳的東西當成腳本執行
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  // 不准被別的頁面嵌成 iframe（點擊劫持：把「核准」蓋在別的按鈕底下）
  { key: 'X-Frame-Options', value: 'DENY' },
  // 離站時不要把完整網址送出去
  { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
  // 這個站不需要相機、麥克風、定位。拍帳單走的是 <input type=file>，不是 getUserMedia。
  { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=(), payment=()' },
];

const nextConfig: NextConfig = {
  async headers() {
    return [{ source: '/:path*', headers: SECURITY_HEADERS }];
  },
};

export default nextConfig;
