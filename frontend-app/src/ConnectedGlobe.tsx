/**
 * Wireframe globe with a few connected nodes — a "global network" glyph
 * tabler-icons has no equivalent for. Colored via currentColor, so it picks
 * up whatever color/filter the wrapping element sets (see LoginScreen.tsx,
 * AuthSplash.tsx).
 */
export default function ConnectedGlobe({ size = 64 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 64 64" fill="none">
      <g stroke="currentColor" strokeWidth={1.3} opacity={0.8}>
        <circle cx="32" cy="32" r="26" />
        <ellipse cx="32" cy="32" rx="11" ry="26" />
        <ellipse cx="32" cy="32" rx="26" ry="10" />
        <line x1="6" y1="32" x2="58" y2="32" />
      </g>
      <g stroke="currentColor" strokeWidth={1.2} strokeDasharray="2.5 3" opacity={0.9}>
        <path d="M20 18 Q32 8 44 22" />
        <path d="M44 22 Q40 36 30 46" />
        <path d="M30 46 Q20 44 14 40" />
        <path d="M14 40 Q10 26 20 18" />
      </g>
      <g fill="currentColor">
        <circle cx="20" cy="18" r="2.3" />
        <circle cx="44" cy="22" r="2.3" />
        <circle cx="30" cy="46" r="2.3" />
        <circle cx="14" cy="40" r="2.3" />
      </g>
    </svg>
  )
}
