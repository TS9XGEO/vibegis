/**
 * Shared open/closed state for the "add layer" modal (UploadLayer.tsx),
 * lifted out of LayerPanel so the map's drag-and-drop zone (App.tsx) can
 * open it too, with the dropped file pre-filled — same convention as
 * panels.ts/selection.ts for cross-component ephemeral UI state.
 */
import { create } from 'zustand'

/** File extensions the upload modal accepts. Lives here rather than in
 * UploadLayer.tsx so App.tsx's drag-and-drop zone can read it without
 * statically importing that whole module — which would pin it into the
 * initial bundle and undo LayerPanel.tsx's lazy import of it. */
export const ACCEPT = '.zip,.gpkg,.geojson,.json,.kml,.gml,.tif,.tiff,.las,.laz'

interface UploadState {
  opened: boolean
  /** Set when the modal was opened by dropping a file onto the map, so
   * UploadLayer's file panel can start pre-filled with it. */
  pendingFile: File | null
  open: () => void
  openWithFile: (file: File) => void
  close: () => void
}

export const useUpload = create<UploadState>((set) => ({
  opened: false,
  pendingFile: null,
  open: () => set({ opened: true, pendingFile: null }),
  openWithFile: (file) => set({ opened: true, pendingFile: file }),
  close: () => set({ opened: false, pendingFile: null }),
}))
