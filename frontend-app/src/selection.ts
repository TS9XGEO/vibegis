/**
 * Feature-selection state: which layers' attribute tables are open (as tabs
 * — mirrored here since MapTools.tsx, inside the Viewer tree, has no access
 * to LayerPanel's own local state), which one is focused, which select tool
 * is active and at what scope, and the current selection itself. Ephemeral
 * UI/interaction state, same category as tools.ts's useTools — not
 * persisted, not part of useApp's saved config.
 */
import { create } from 'zustand'

import type { Feature } from './features'

// ------------------------------------------------------------- bookmarks
//
// A named, restorable snapshot of a full selection — persisted so it
// survives a reload, unlike the rest of this store. Same localStorage
// load/save-with-try/catch idiom wms.ts already uses for
// loadStyleOverrides/saveStyleOverrides and
// loadAttributeFilters/saveAttributeFilters.

const BOOKMARKS_KEY = 'vibegis:selection-bookmarks'

export interface SelectionBookmark {
  id: string
  name: string
  createdAt: number
  entries: SelectedEntry[]
}

function loadBookmarks(): SelectionBookmark[] {
  try {
    const raw = localStorage.getItem(BOOKMARKS_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

function saveBookmarks(bookmarks: SelectionBookmark[]) {
  try {
    localStorage.setItem(BOOKMARKS_KEY, JSON.stringify(bookmarks))
  } catch {
    // storage unavailable (private mode, quota) — bookmarks just stay session-only
  }
}

export type SelectMode = 'off' | 'point' | 'circle' | 'polygon'

/** Whether map-select tools consider only the focused tab's layer, or every
 * currently visible layer at once. */
export type SelectionScope = 'active' | 'allVisible'

export interface OpenLayer {
  name: string
  collection: string
}

/** A selected feature tagged with the layer it came from — two different
 * layers can easily share feature ids (e.g. both use `gid`), so a selection
 * spanning multiple layers can't be keyed by id alone. */
export interface SelectedEntry {
  layer: string
  feature: Feature
}

function selectionKey(layer: string, featureId: string): string {
  return `${layer}:${featureId}`
}

interface SelectionState {
  openLayers: OpenLayer[]
  activeLayer: string | null
  // The Auswahl-Dashboard's own pinned slot in DataViewBand's tab strip — a
  // separate boolean pair rather than folding it into `openLayers`/
  // `activeLayer`, since those are consumed elsewhere (ToolboxControls.tsx's
  // useSelectCandidates()) as real layer-name/collection lookups; a fake
  // "dashboard" entry there would corrupt those lookups.
  //
  // `setActiveLayer`/`openLayerTab` clear `dashboardTabActive` when focusing
  // a real layer tab, but `focusDashboardTab`/`toggleDashboardTab` do NOT
  // clear `activeLayer` back to null — it deliberately keeps remembering the
  // last-focused layer, so `focusDataView()` can restore it and so
  // ToolboxControls.tsx's "select scope: active layer" still has something
  // to point at while the dashboard is showing. This means `activeLayer`
  // pointing at a real layer and `dashboardTabActive` being true CAN both be
  // true at once — anything that renders per-layer content gated on
  // `ol.name === activeLayer` (DataViewBand.tsx's AttributeTablePanel) must
  // also check `!dashboardTabActive`, or that layer's table will render
  // alongside the dashboard instead of staying hidden.
  dashboardTabOpen: boolean
  dashboardTabActive: boolean
  mode: SelectMode
  scope: SelectionScope
  // Set by MapTools.tsx's own click handlers after a circle/polygon draw —
  // shared here (rather than local component state) so the hint reading it
  // (ToolboxControls.tsx) shows correctly whether the user drew from the
  // floating toolbox or its embedded copy in SelectionDashboard.tsx.
  truncated: boolean
  selected: Map<string, SelectedEntry>
  bookmarks: SelectionBookmark[]

  openLayerTab: (layer: OpenLayer) => void
  closeLayerTab: (name: string) => void
  closeAllLayerTabs: () => void
  setActiveLayer: (name: string) => void
  toggleDashboardTab: () => void
  focusDashboardTab: () => void
  closeDashboardTab: () => void
  focusDataView: () => void
  setMode: (mode: SelectMode) => void
  setScope: (scope: SelectionScope) => void
  setTruncated: (truncated: boolean) => void
  toggleFeature: (layer: string, f: Feature) => void
  replaceSelectionForLayers: (layerNames: string[], entries: SelectedEntry[]) => void
  clearSelection: () => void
  saveBookmark: (name: string) => void
  restoreBookmark: (id: string) => void
  deleteBookmark: (id: string) => void
}

export const useSelection = create<SelectionState>((set, get) => ({
  openLayers: [],
  activeLayer: null,
  dashboardTabOpen: false,
  dashboardTabActive: false,
  mode: 'off',
  scope: 'active',
  truncated: false,
  selected: new Map(),
  bookmarks: loadBookmarks(),

  openLayerTab: (layer) =>
    set((s) => {
      if (s.openLayers.some((o) => o.name === layer.name)) {
        return { activeLayer: layer.name, dashboardTabActive: false }
      }
      return { openLayers: [...s.openLayers, layer], activeLayer: layer.name, dashboardTabActive: false }
    }),

  // Deliberately doesn't touch `selected` — closing a tab hides the table,
  // it doesn't mean "forget this layer's selection" (the map highlight for
  // it is independent of any tab being open at all).
  closeLayerTab: (name) =>
    set((s) => {
      const i = s.openLayers.findIndex((o) => o.name === name)
      if (i < 0) return s
      const openLayers = s.openLayers.filter((o) => o.name !== name)
      let activeLayer = s.activeLayer
      if (activeLayer === name) {
        const next = s.openLayers[i - 1] ?? s.openLayers[i + 1] ?? null
        activeLayer = next ? next.name : null
      }
      return { openLayers, activeLayer }
    }),

  // Same "doesn't touch `selected`" rule as closing one tab — closing every
  // tab at once is still just hiding tables, not discarding selections.
  closeAllLayerTabs: () => set({ openLayers: [], activeLayer: null }),

  setActiveLayer: (name) => set({ activeLayer: name, dashboardTabActive: false }),

  toggleDashboardTab: () =>
    set((s) => (s.dashboardTabOpen
      ? { dashboardTabOpen: false, dashboardTabActive: false }
      : { dashboardTabOpen: true, dashboardTabActive: true })),
  focusDashboardTab: () => set({ dashboardTabActive: true }),
  closeDashboardTab: () => set({ dashboardTabOpen: false, dashboardTabActive: false }),
  // Switches back from the dashboard to the layer-tabs strip without
  // changing which layer was last focused — the tab strip collapses to a
  // single "Datenansicht" pill while the dashboard is active (DataViewBand.tsx)
  // rather than showing every layer tab alongside it, so this is that pill's
  // one job: un-focus the dashboard, nothing else.
  focusDataView: () => set({ dashboardTabActive: false }),

  setMode: (mode) => set({ mode }),
  setScope: (scope) => set({ scope }),
  setTruncated: (truncated) => set({ truncated }),

  toggleFeature: (layer, f) =>
    set((s) => {
      const key = selectionKey(layer, f.id)
      const selected = new Map(s.selected)
      if (selected.has(key)) selected.delete(key)
      else selected.set(key, { layer, feature: f })
      return { selected }
    }),

  // The one primitive both single-layer replace (layerNames: [name]) and
  // multi-layer replace (layerNames: every visible layer) go through — a
  // layer not part of the current operation keeps whatever it already had.
  replaceSelectionForLayers: (layerNames, entries) =>
    set((s) => {
      const drop = new Set(layerNames)
      const selected = new Map(
        [...s.selected].filter(([, entry]) => !drop.has(entry.layer)),
      )
      for (const entry of entries) selected.set(selectionKey(entry.layer, entry.feature.id), entry)
      return { selected }
    }),

  clearSelection: () => set({ selected: new Map() }),

  saveBookmark: (name) =>
    set((s) => {
      const bookmark: SelectionBookmark = {
        id: crypto.randomUUID(),
        name,
        createdAt: Date.now(),
        entries: Array.from(s.selected.values()),
      }
      const bookmarks = [...s.bookmarks, bookmark]
      saveBookmarks(bookmarks)
      return { bookmarks }
    }),

  // A bookmark is a saved *full* selection state, not a per-layer merge —
  // restoring it replaces `selected` outright rather than going through
  // replaceSelectionForLayers, which would leave untouched layers as they
  // currently are instead of as the bookmark saved them.
  restoreBookmark: (id) => {
    const bookmark = get().bookmarks.find((b) => b.id === id)
    if (!bookmark) return
    const selected = new Map<string, SelectedEntry>()
    for (const entry of bookmark.entries) selected.set(selectionKey(entry.layer, entry.feature.id), entry)
    set({ selected })
  },

  deleteBookmark: (id) =>
    set((s) => {
      const bookmarks = s.bookmarks.filter((b) => b.id !== id)
      saveBookmarks(bookmarks)
      return { bookmarks }
    }),
}))
