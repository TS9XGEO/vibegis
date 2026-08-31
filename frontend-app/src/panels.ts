/**
 * Open/closed state for the floating HUD boxes (the tools panel, the
 * status/zoom/compass stack) — closing one tucks it into the sideband rail
 * (Sideband.tsx) instead of removing it outright. Plain component-lifetime
 * state, not persisted: same convention as useDraggable's drag offset, every
 * box starts at its default below on a fresh session or reload, not
 * whatever it was left at.
 *
 * The two floating map overlays (mapTools, hud) default closed — they cover
 * part of the globe when open, so a clean map is the better first
 * impression. The docked layer panel defaults open since it's a real layout
 * column, not an overlay, and is usually what someone opens the app to use.
 */
import { create } from 'zustand'

export type PanelId = 'mapTools' | 'hud' | 'layerPanel'

interface PanelState {
  open: Record<PanelId, boolean>
  hide: (id: PanelId) => void
  show: (id: PanelId) => void
}

export const usePanels = create<PanelState>((set) => ({
  open: { mapTools: false, hud: false, layerPanel: true },
  hide: (id) => set((s) => ({ open: { ...s.open, [id]: false } })),
  show: (id) => set((s) => ({ open: { ...s.open, [id]: true } })),
}))
