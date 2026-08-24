/**
 * Identify, search and measure — the state and the network calls.
 * Kept out of the components so the UI stays declarative.
 */
import { create } from 'zustand'
import { WMS_URL } from './wms'

export const FEATURES_URL = '/features'

// ------------------------------------------------------------------ search

export interface SearchHit {
  name: string
  category: string
  score: number
  lon: number
  lat: number
}

export async function searchPlaces(q: string, signal?: AbortSignal): Promise<SearchHit[]> {
  if (!q.trim()) return []
  const url =
    `${FEATURES_URL}/functions/search/items.json` +
    `?q=${encodeURIComponent(q)}&maxrows=15&limit=15`
  const res = await fetch(url, { signal })
  if (!res.ok) throw new Error(`Suche: HTTP ${res.status}`)
  const json = await res.json()
  return (json.features ?? [])
    .filter((f: any) => f?.geometry?.coordinates)
    .map((f: any) => ({
      name: f.properties?.name ?? '(ohne Name)',
      category: f.properties?.category ?? '',
      score: Number(f.properties?.score ?? 0),
      lon: f.geometry.coordinates[0],
      lat: f.geometry.coordinates[1],
    }))
}

// ---------------------------------------------------------------- identify

export interface IdentifyResult {
  layer: string
  properties: Record<string, unknown>
}

/**
 * WMS GetFeatureInfo against one layer. Cesium can do this itself, but doing
 * it explicitly lets us query several layers at once and render the result in
 * our own panel rather than Cesium's info box.
 */
export async function identifyAt(
  layer: string,
  lon: number,
  lat: number,
  metresPerPixel: number,
  signal?: AbortSignal,
): Promise<IdentifyResult[]> {
  // a small bbox around the click, sized to the current zoom
  const half = Math.max(metresPerPixel * 6, 5) / 111320   // metres -> degrees
  const bbox = [lon - half, lat - half, lon + half, lat + half]

  const params = new URLSearchParams({
    service: 'WMS',
    version: '1.3.0',
    request: 'GetFeatureInfo',
    layers: layer,
    query_layers: layer,
    crs: 'CRS:84',
    bbox: bbox.join(','),
    width: '11',
    height: '11',
    i: '5',
    j: '5',
    info_format: 'application/json',
    feature_count: '5',
    styles: '',
  })

  const res = await fetch(`${WMS_URL}?${params}`, { signal })
  if (!res.ok) return []

  const text = await res.text()
  if (!text.trim().startsWith('{')) return []      // MapServer error document

  try {
    const json = JSON.parse(text)
    return (json.features ?? []).map((f: any) => ({
      layer,
      properties: f.properties ?? {},
    }))
  } catch {
    return []
  }
}

// ----------------------------------------------------------------- measure

export type MeasureMode = 'off' | 'distance' | 'area'

interface ToolState {
  // search
  query: string
  hits: SearchHit[]
  searching: boolean
  searchError: string | null
  setQuery: (q: string) => void
  runSearch: (q: string) => Promise<void>
  clearSearch: () => void

  // identify
  identifyOn: boolean
  identifyBusy: boolean
  results: IdentifyResult[]
  setIdentify: (v: boolean) => void
  setResults: (r: IdentifyResult[]) => void
  setIdentifyBusy: (v: boolean) => void

  // measure
  measure: MeasureMode
  measureValue: string | null
  setMeasure: (m: MeasureMode) => void
  setMeasureValue: (v: string | null) => void
}

export const useTools = create<ToolState>((set) => ({
  query: '',
  hits: [],
  searching: false,
  searchError: null,
  setQuery: (query) => set({ query }),
  runSearch: async (q) => {
    set({ searching: true, searchError: null })
    try {
      set({ hits: await searchPlaces(q), searching: false })
    } catch (e) {
      set({
        searching: false,
        hits: [],
        searchError: e instanceof Error ? e.message : String(e),
      })
    }
  },
  clearSearch: () => set({ query: '', hits: [], searchError: null }),

  identifyOn: false,
  identifyBusy: false,
  results: [],
  setIdentify: (identifyOn) => set({ identifyOn, results: [] }),
  setResults: (results) => set({ results }),
  setIdentifyBusy: (identifyBusy) => set({ identifyBusy }),

  measure: 'off',
  measureValue: null,
  setMeasure: (measure) => set({ measure, measureValue: null }),
  setMeasureValue: (measureValue) => set({ measureValue }),
}))

// ------------------------------------------------------------- formatting

export function formatDistance(m: number): string {
  return m >= 1000 ? `${(m / 1000).toFixed(2)} km` : `${m.toFixed(1)} m`
}

export function formatArea(m2: number): string {
  if (m2 >= 1e6) return `${(m2 / 1e6).toFixed(3)} km²`
  if (m2 >= 10000) return `${(m2 / 10000).toFixed(2)} ha`
  return `${m2.toFixed(1)} m²`
}
