/**
 * Small helpers for the handful of spots using a raw inline backgroundColor
 * instead of Mantine's own (already scheme-aware) component styling — the
 * floating HUD panels, the layer panel sidebar, and the attribute drawer.
 */
export type Scheme = 'light' | 'dark'

export function panelBg(scheme: Scheme, alpha = 0.92): string {
  return scheme === 'dark' ? `rgba(20,22,28,${alpha})` : `rgba(255,255,255,${alpha})`
}

/** A faint teal tint instead of flat black/white — barely visible, just
 * enough that panel edges read as considered rather than generic chrome. */
export function panelBorder(scheme: Scheme): string {
  return scheme === 'dark' ? 'rgba(20,184,166,.14)' : 'rgba(15,118,110,.14)'
}

/** The one deliberate accent flourish: a thin teal-to-amber gradient, reused
 * as the background of the floating panels' drag-handle strips (MapTools'
 * tools panel, the bottom-left HUD stack in App.tsx) — doubles as the drag
 * affordance and the app's small splash of color, no extra DOM needed. */
export function accentEdge(scheme: Scheme): string {
  return scheme === 'dark'
    ? 'linear-gradient(90deg, #0d9488, #f59f00)'
    : 'linear-gradient(90deg, #0f766e, #f08c00)'
}

/**
 * Neon/HUD styling shared by LoginScreen and AuthSplash — the login flow gets
 * to look a bit more like a sci-fi terminal than the rest of the (otherwise
 * plain Mantine) app. Pair with the `authGradientShift` keyframes and the
 * Orbitron font link, both defined once in index.html.
 *
 * Recolored to the same teal/amber pair as the rest of the app (main.tsx's
 * `primaryColor`, `accentEdge()` above) — this used to be its own separate
 * cyan/violet identity, deliberately left alone during the original palette
 * pass. Thomas later asked for the login screen to match, so it now reuses
 * the same two hues throughout instead of a third, unrelated pair.
 */
export const AUTH_FONT = "'Orbitron', 'Segoe UI', sans-serif"

export function authAccent(scheme: Scheme): string {
  return scheme === 'dark' ? '#2dd4bf' : '#0f766e'
}

/** Three stops, not two — cycles through a teal tint and an amber tint
 * rather than sitting on one hue, so the animated shift actually reads as
 * "two accent colors moving," not just one color pulsing. */
export function authGradient(scheme: Scheme): string {
  return scheme === 'dark'
    ? 'linear-gradient(135deg, #01020a, #052e2b, #1a1400, #01020a)'
    : 'linear-gradient(135deg, #eefdfa, #fff8e6, #eefdfa)'
}

/** Faint animated tech grid, layered under the content as a separate element. */
export function authGrid(scheme: Scheme): string {
  const line = scheme === 'dark' ? 'rgba(45,212,191,0.08)' : 'rgba(15,118,110,0.09)'
  return `linear-gradient(${line} 1px, transparent 1px), linear-gradient(90deg, ${line} 1px, transparent 1px)`
}

/** Two-tone glow — a teal halo plus a faint amber one layered behind it,
 * echoing accentEdge()'s gradient rather than a single flat color. */
export function authGlow(scheme: Scheme): string {
  return scheme === 'dark'
    ? '0 0 10px rgba(45,212,191,0.16), 0 0 22px rgba(245,159,0,0.08)'
    : '0 0 10px rgba(15,118,110,0.12), 0 0 20px rgba(240,140,0,0.06)'
}

export function authTextGlow(scheme: Scheme): string {
  return scheme === 'dark' ? '0 0 6px rgba(45,212,191,0.35)' : '0 0 5px rgba(15,118,110,0.22)'
}

/** Translucent accent for borders — the fully-solid authAccent() read as too
 * intense used as a border color. */
export function authBorder(scheme: Scheme): string {
  return scheme === 'dark' ? 'rgba(45,212,191,0.35)' : 'rgba(15,118,110,0.3)'
}

export function authGradientColors(scheme: Scheme): { from: string; to: string } {
  return scheme === 'dark' ? { from: 'teal', to: 'yellow' } : { from: 'teal', to: 'orange' }
}

/** Selection highlight on the map (SelectionHighlight.tsx) and the matching
 * draw-in-progress outline (MapTools.tsx) — electric blue, glowing via a
 * translucent halo drawn behind the crisp shape (see SelectionHighlight.tsx). */
export const SELECTION_COLOR = '#40c4ff'

const SELECTION_RGB = [0x40, 0xc4, 0xff]

/** Translucent tint of SELECTION_COLOR, for anything (like a selected table
 * row) that needs to visually agree with the map's own selection highlight
 * rather than an unrelated color. */
export function selectionRowBg(alpha = 0.25): string {
  const [r, g, b] = SELECTION_RGB
  return `rgba(${r},${g},${b},${alpha})`
}

/** The dashboard's own, separate highlight (DashboardHighlight.tsx) — a
 * non-destructive "preview" of one breakdown value's features, deliberately
 * never the same color as SELECTION_COLOR so it reads as distinct from the
 * real selection it's drawn alongside rather than replacing. Reuses
 * accentEdge()'s amber stop, already this app's second accent color next to
 * teal, instead of introducing a third arbitrary hue. */
export const DASHBOARD_HIGHLIGHT_COLOR = '#f59f00'
