/**
 * A second, independent highlight for SelectionDashboard.tsx's breakdown
 * rows — deliberately kept separate from selection.ts's `selected` map.
 * Clicking a breakdown value used to call replaceSelectionForLayers(),
 * silently overriding whatever the user had actually selected just to
 * preview a subset; this store lets the dashboard show that subset on the
 * map (via DashboardHighlight.tsx) without touching the real selection at
 * all. Ephemeral, session-only, not persisted — same category as
 * panels.ts/useDraggable/useResizeHeight.
 */
import { create } from 'zustand'

import type { SelectedEntry } from './selection'

interface DashboardHighlightState {
  layerName: string | null
  label: string | null
  entries: SelectedEntry[]
  setHighlight: (layerName: string, label: string, entries: SelectedEntry[]) => void
  clearHighlight: () => void
}

export const useDashboardHighlight = create<DashboardHighlightState>((set) => ({
  layerName: null,
  label: null,
  entries: [],
  setHighlight: (layerName, label, entries) => set({ layerName, label, entries }),
  clearHighlight: () => set({ layerName: null, label: null, entries: [] }),
}))
