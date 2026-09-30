/**
 * Parents watching their son's match live from the living room. Drawn for the
 * demo (no stock photo, nobody real): a flat, warm evening scene whose TV shows
 * the same broadcast look as the live section above it.
 */
export function FamilyWatching({ title }: { title: string }) {
  return (
    <svg viewBox="0 0 640 400" role="img" aria-label={title} className="dm-family">
      <defs>
        <radialGradient id="dm-lamp" cx="0.2" cy="0.25" r="0.6">
          <stop offset="0" stopColor="#F5C77A" stopOpacity="0.35" />
          <stop offset="1" stopColor="#F5C77A" stopOpacity="0" />
        </radialGradient>
        <radialGradient id="dm-tvglow" cx="0.8" cy="0.45" r="0.45">
          <stop offset="0" stopColor="#2FD8C4" stopOpacity="0.22" />
          <stop offset="1" stopColor="#2FD8C4" stopOpacity="0" />
        </radialGradient>
      </defs>

      {/* room */}
      <rect width="640" height="400" fill="#1A2136" />
      <rect width="640" height="400" fill="url(#dm-lamp)" />
      <rect width="640" height="400" fill="url(#dm-tvglow)" />
      <rect y="318" width="640" height="82" fill="#121829" />
      <ellipse cx="300" cy="352" rx="230" ry="22" fill="#2A2440" />

      {/* window with the night outside */}
      <rect x="210" y="46" width="130" height="104" rx="4" fill="#0E1426" stroke="#2C3552" strokeWidth="6" />
      <line x1="275" y1="46" x2="275" y2="150" stroke="#2C3552" strokeWidth="4" />
      <circle cx="312" cy="78" r="12" fill="#E9E3C9" />
      <circle cx="318" cy="74" r="11" fill="#0E1426" />
      <circle cx="236" cy="70" r="1.6" fill="#E9E3C9" />
      <circle cx="252" cy="104" r="1.2" fill="#E9E3C9" />
      <circle cx="296" cy="122" r="1.4" fill="#E9E3C9" />

      {/* floor lamp */}
      <line x1="58" y1="120" x2="58" y2="330" stroke="#3A3350" strokeWidth="5" />
      <path d="M30 118 L86 118 L74 84 L42 84 Z" fill="#F0C27A" />
      <ellipse cx="58" cy="332" rx="22" ry="5" fill="#3A3350" />

      {/* TV on its stand */}
      <rect x="450" y="300" width="160" height="22" rx="3" fill="#2E2A45" />
      <rect x="440" y="150" width="182" height="112" rx="6" fill="#05070D" />
      <rect x="448" y="158" width="166" height="96" fill="#1D6B3F" />
      <g stroke="rgba(255,255,255,.7)" strokeWidth="1.2" fill="none">
        <rect x="454" y="164" width="154" height="84" />
        <line x1="531" y1="164" x2="531" y2="248" />
        <circle cx="531" cy="206" r="11" />
      </g>
      <circle cx="548" cy="214" r="3" fill="#D4FF4F" />
      <circle cx="510" cy="196" r="3.2" fill="#F4F4F4" />
      <circle cx="560" cy="226" r="3.2" fill="#F4F4F4" />
      <circle cx="575" cy="198" r="3.2" fill="#2FD8C4" />
      <circle cx="495" cy="222" r="3.2" fill="#2FD8C4" />
      <rect x="453" y="162" width="46" height="11" fill="#0B0F1A" />
      <text x="457" y="170.5" fontFamily="Rajdhani, sans-serif" fontSize="8.5" fontWeight="700" fill="#fff">A 2 · 1 B</text>
      <rect x="585" y="162" width="24" height="10" fill="#FF5A3C" />
      <text x="589" y="170" fontFamily="Rajdhani, sans-serif" fontSize="8" fontWeight="700" fill="#fff">LIVE</text>
      <text x="566" y="249" fontFamily="Rajdhani, sans-serif" fontSize="7.5" fontWeight="700" fill="#D4FF4F">REPLAY</text>
      <line x1="531" y1="262" x2="531" y2="300" stroke="#2E2A45" strokeWidth="8" />

      {/* sofa, side on, facing the TV */}
      <rect x="92" y="220" width="250" height="70" rx="18" fill="#2B6F74" />
      <rect x="80" y="176" width="46" height="118" rx="18" fill="#245E62" />
      <rect x="316" y="236" width="40" height="58" rx="14" fill="#245E62" />
      <rect x="100" y="286" width="12" height="30" fill="#1B3F43" />
      <rect x="322" y="286" width="12" height="30" fill="#1B3F43" />

      {/* father */}
      <rect x="130" y="176" width="62" height="64" rx="22" fill="#4A5C8C" />
      <rect x="176" y="222" width="70" height="18" rx="9" fill="#34405F" />
      <rect x="232" y="222" width="16" height="72" rx="7" fill="#34405F" />
      <circle cx="170" cy="152" r="23" fill="#C98C62" />
      <path d="M148 146 C150 124 190 122 194 144 C186 136 160 136 148 146 Z" fill="#2A1E1A" />
      <path d="M190 190 C214 186 226 170 232 158" stroke="#C98C62" strokeWidth="11" strokeLinecap="round" fill="none" />

      {/* mother */}
      <rect x="212" y="186" width="56" height="56" rx="20" fill="#8C4A6B" />
      <rect x="250" y="226" width="58" height="16" rx="8" fill="#5E3149" />
      <rect x="294" y="226" width="14" height="68" rx="6" fill="#5E3149" />
      <path d="M216 170 C214 140 262 136 266 166 C268 188 258 196 240 198 C224 198 216 188 216 170 Z" fill="#3E2F5B" />
      <ellipse cx="248" cy="170" rx="14" ry="16" fill="#D9A27A" />

      {/* son, standing up to cheer */}
      <rect x="352" y="206" width="36" height="58" rx="12" fill="#D4FF4F" />
      <text x="370" y="242" textAnchor="middle" fontFamily="Rajdhani, sans-serif" fontSize="18" fontWeight="700" fill="#0B0F1A">7</text>
      <rect x="356" y="262" width="12" height="58" rx="5" fill="#2A3350" />
      <rect x="374" y="262" width="12" height="58" rx="5" fill="#2A3350" />
      <path d="M356 214 L336 172" stroke="#B97A52" strokeWidth="9" strokeLinecap="round" />
      <path d="M384 214 L402 170" stroke="#B97A52" strokeWidth="9" strokeLinecap="round" />
      <circle cx="370" cy="188" r="17" fill="#B97A52" />
      <path d="M353 184 C354 166 386 164 388 182 C380 176 362 176 353 184 Z" fill="#1E1614" />

      {/* plant */}
      <rect x="400" y="292" width="28" height="30" rx="4" fill="#6B4F3A" />
      <path d="M414 292 C396 268 398 250 404 244 M414 292 C414 262 420 246 428 240 M414 292 C428 272 440 266 446 262" stroke="#3E8E5A" strokeWidth="6" strokeLinecap="round" fill="none" />
    </svg>
  );
}
