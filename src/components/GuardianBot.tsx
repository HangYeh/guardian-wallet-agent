/**
 * 門神的臉：薄荷色的小機器人。
 *
 * 純 SVG，沒有 JS；揮手、眨眼、漂浮都是 CSS keyframes（globals.css 的 .bot-*），
 * prefers-reduced-motion 時全部靜止。原稿是隊長自己的 NCKU Campus OS 設計，
 * 胸口的牌子改成門神。
 */
export default function GuardianBot({ size = 150, className = '' }: { size?: number; className?: string }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 400 400"
      xmlns="http://www.w3.org/2000/svg"
      role="img"
      aria-label="門神：薄荷色的小機器人，正在揮手"
      className={`bot ${className}`}
    >
      <defs>
        <filter id="botShadow" x="-20%" y="-20%" width="140%" height="140%">
          <feDropShadow dx="0" dy="10" stdDeviation="8" floodColor="#1f2d2a" floodOpacity="0.18" />
        </filter>
      </defs>

      <ellipse cx="200" cy="340" rx="92" ry="18" fill="#1f2d2a" opacity="0.12" />

      <g filter="url(#botShadow)">
        {/* 天線 */}
        <line x1="200" y1="118" x2="200" y2="88" className="bot-stroke" />
        <circle cx="200" cy="78" r="18" fill="#f4a261" className="bot-stroke" />
        <circle cx="193" cy="70" r="6" fill="#fff7df" opacity="0.9" />

        {/* 頭 */}
        <rect x="82" y="118" width="236" height="178" rx="76" fill="#7fc5b3" className="bot-stroke" />
        <path d="M113 140 C150 105 250 105 287 140" fill="none" stroke="#ecf7f3" strokeWidth="18" strokeLinecap="round" opacity="0.9" />

        {/* 臉 */}
        <rect x="112" y="140" width="176" height="104" rx="42" fill="#1f2d2a" className="bot-stroke" />
        <g className="bot-eyes">
          <ellipse cx="164" cy="191" rx="12" ry="20" fill="#fffdf0" />
          <ellipse cx="236" cy="191" rx="12" ry="20" fill="#fffdf0" />
        </g>
        <path d="M177 217 Q200 238 223 217" fill="none" stroke="#f4a261" strokeWidth="8" strokeLinecap="round" />
        <ellipse cx="146" cy="157" rx="16" ry="7" fill="#fff" opacity="0.75" transform="rotate(-18 146 157)" />
        <circle cx="260" cy="220" r="5" fill="#ecf7f3" opacity="0.45" />

        {/* 胸牌 */}
        <rect x="146" y="252" width="108" height="70" rx="28" fill="#ffffff" className="bot-stroke" />
        <text x="200" y="291" textAnchor="middle" className="bot-badge">
          門神
        </text>
        <text x="200" y="311" textAnchor="middle" className="bot-badge-sub">
          GUARDIAN
        </text>

        {/* 左手：揮手 */}
        <path d="M92 206 C60 188 51 150 73 128 C95 108 119 130 104 153" fill="none" className="bot-stroke" />
        <g className="bot-arm">
          <path d="M86 160 C62 156 49 171 53 193 C56 215 77 224 94 211" fill="#7fc5b3" className="bot-stroke" />
          <path d="M58 175 Q42 166 37 151" fill="none" stroke="#ecf7f3" strokeWidth="4" opacity="0.7" />
          <path d="M48 193 Q32 188 25 176" fill="none" stroke="#ecf7f3" strokeWidth="4" opacity="0.55" />
        </g>

        {/* 右手與腳 */}
        <path d="M308 206 C340 224 337 274 301 278 C284 280 279 259 296 248" fill="#7fc5b3" className="bot-stroke" />
        <path d="M127 294 L105 335 H158 L168 294 Z" fill="#7fc5b3" className="bot-stroke" />
        <path d="M233 294 L244 335 H296 L273 294 Z" fill="#7fc5b3" className="bot-stroke" />
      </g>
    </svg>
  );
}
