import type { Metadata } from 'next';
import Link from 'next/link';
import './globals.css';
import DemoBar from '@/components/DemoBar';

// 字型用 <link> 從 Google Fonts 載，不走 next/font：
// next/font 會在 dev server 第一次啟動時下載字型檔，下載不到（斷網、fonts.gstatic.com 連不上）
// 整站每一頁都 500。用 <link> 的話載不到就退回系統字型（PingFang / 微軟正黑），畫面照常。
// Quicksand 管英數與標題、Noto Sans TC 管中文、JetBrains Mono 管代碼與金額。
const GOOGLE_FONTS =
  'https://fonts.googleapis.com/css2?family=Quicksand:wght@500;600;700;800&family=Noto+Sans+TC:wght@400;500;700;900&family=JetBrains+Mono:wght@500;700&display=swap';

export const metadata: Metadata = {
  title: '門神錢包 Guardian Wallet',
  description: '幫長輩守住錢包的 AI 代理。帳單自動繳、詐騙自動擋、政策寫在鏈上合約裡。',
};

const NAV = [
  { href: '/', label: '阿嬤', hint: '拍帳單、問門神' },
  { href: '/agent', label: '門神軌跡', hint: '每一步在做什麼' },
  { href: '/guardian', label: '守護者', hint: '核准與政策' },
  { href: '/wallet', label: '鏈上錢包', hint: '餘額與交易' },
  { href: '/audit', label: '稽核週報', hint: '證據與數字' },
];

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="zh-Hant">
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
        <link rel="stylesheet" href={GOOGLE_FONTS} />
      </head>
      <body>
        <header className="nav">
          <div className="nav-inner">
            <Link href="/" className="nav-logo">
              <span className="nav-mark" aria-hidden="true">
                門
              </span>
              <span>
                門神錢包
                <small>Guardian Wallet</small>
              </span>
            </Link>
            <nav className="nav-links">
              {NAV.map((n) => (
                <Link key={n.href} href={n.href} title={n.hint}>
                  {n.label}
                </Link>
              ))}
            </nav>
          </div>
        </header>

        {children}

        <DemoBar />
      </body>
    </html>
  );
}
