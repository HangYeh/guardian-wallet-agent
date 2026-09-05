import type { Metadata } from 'next';
import Link from 'next/link';
import './globals.css';
import DemoBar from '@/components/DemoBar';

// 字型用 <link> 從 Google Fonts 載，不走 next/font：
// next/font 會在 dev server 第一次啟動時下載字型檔，下載不到（斷網、fonts.gstatic.com 連不上）
// 整站每一頁都 500。用 <link> 的話載不到就退回系統字型（PingFang / 微軟正黑），畫面照常。
const GOOGLE_FONTS =
  'https://fonts.googleapis.com/css2?family=Noto+Sans+TC:wght@400;500;700&family=Noto+Serif+TC:wght@600;700&display=swap';

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
        <header className="border-b border-[var(--color-line)] bg-[var(--color-surface)]">
          <div className="mx-auto flex max-w-[1080px] flex-wrap items-center gap-x-6 gap-y-2 px-[clamp(1rem,4vw,2.5rem)] py-3">
            <Link href="/" className="font-serif text-[1.05rem] font-bold no-underline text-[var(--color-ink)]">
              門神錢包
              <span className="ml-2 text-[0.75rem] font-normal text-[var(--color-ink-3)]">Guardian Wallet</span>
            </Link>
            <nav className="flex flex-wrap gap-x-4 gap-y-1 text-[0.85rem]">
              {NAV.map((n) => (
                <Link
                  key={n.href}
                  href={n.href}
                  title={n.hint}
                  className="text-[var(--color-ink-2)] no-underline hover:text-[var(--color-cinnabar)]"
                >
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
