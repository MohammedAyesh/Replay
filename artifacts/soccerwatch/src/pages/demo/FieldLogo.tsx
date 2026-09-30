/**
 * A sample pitch or academy badge for the demo's branded clips.
 *
 * It is deliberately generic, a shield with the first letter of whatever name
 * the visitor types, so it reads as "your logo goes here" and never as some
 * real club's crest. On real clips the owner's own logo is used.
 */
export function FieldLogo({ name, size = 40 }: { name: string; size?: number }) {
  const initial = (name.trim()[0] ?? "R").toUpperCase();
  return (
    <svg width={size} height={size * 1.12} viewBox="0 0 64 72" aria-hidden="true" className="dm-crest">
      <path d="M32 2 L60 10 V34 C60 52 47 64 32 70 C17 64 4 52 4 34 V10 Z" fill="#0B0F1A" stroke="#D4FF4F" strokeWidth="3" />
      <path d="M32 9 L53 15 V34 C53 47 44 56 32 61 C20 56 11 47 11 34 V15 Z" fill="none" stroke="rgba(212,255,79,.35)" strokeWidth="1.5" />
      <text x="32" y="44" textAnchor="middle" fontFamily="Cairo, Rajdhani, sans-serif" fontWeight="800" fontSize="26" fill="#D4FF4F">
        {initial}
      </text>
      <circle cx="32" cy="18" r="3.5" fill="#D4FF4F" />
    </svg>
  );
}

/** The corner bug burned into every exported clip: badge and name. */
export function LogoBug({ name, compact = false }: { name: string; compact?: boolean }) {
  return (
    <span className={`dm-bug ${compact ? "dm-bug--compact" : ""}`}>
      <FieldLogo name={name} size={compact ? 20 : 26} />
      <span className="dm-bug-name">{name}</span>
    </span>
  );
}
