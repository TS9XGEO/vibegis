/**
 * WMS capabilities parsing + the application store.
 *
 * The layer list is never hardcoded: it is read from MapServer's
 * GetCapabilities document, so adding a LAYER to the mapfile is enough to make
 * it appear in the UI.
 */
import { create } from 'zustand'
import type { Camera } from 'cesium'

import { isValidHex, type Classification } from './legend'
import type { FilterCondition, FilterLogic } from './filter'

/** Per-layer config from upload-api's /layer-config — classification today, more keys to follow. */
export interface LayerConfig {
  classification?: Classification
}

export const WMS_URL = '/mapserver'          // capabilities, legends, identify
export const TILE_URL = '/tiles/service'     // MapProxy: cached rendering
export const TERRAIN_URL = '/terrain'
export const TILES3D_URL = '/3dtiles/tileset.json'
export const UPLOAD_URL = '/upload'          // upload-api: new layers from a file
export const TABLES_URL = '/tables'          // upload-api: existing DB tables to register
export const REGISTER_TABLE_URL = '/register-table'
export const LAYERS_URL = '/layers'          // upload-api: DELETE /layers/<name>?drop_table=
export const DISTINCT_VALUES_URL = '/distinct-values'  // upload-api: filter builder's value list
export const LAYER_CONFIG_URL = '/layer-config'  // upload-api: per-layer classification/etc, GET all or PATCH one
export const COLUMN_STATS_URL = '/column-stats'  // upload-api: min/max for the graduated classification editor

/** MapServer GROUP that upload-api puts every layer it creates into. */
export const MANAGED_GROUP = 'uploads'

/**
 * Layers upload-api manages, i.e. everything with a LAYER block in
 * uploads.map — file uploads and registered database tables alike. These are
 * the ones it can delete; layers written by hand into webgis.map or
 * osm-layers.map have no block for it to remove and would 404.
 *
 * The primary signal travels with the layer itself: build_layer_block() writes
 * GROUP "uploads" into every block it generates, and MapServer publishes that
 * group in GetCapabilities. So if a layer is in the tree at all, MapServer read
 * its block out of uploads.map, which is exactly the condition for upload-api
 * being able to delete it by name.
 *
 * `managedLayers` (from /layers) is unioned in only as a safety net. It must
 * never be the sole source: deleting needs nothing but the layer name, and
 * gating on /layers meant an unreachable upload-api silently removed a working
 * delete button rather than reporting a problem.
 */
export function isManaged(layer: LayerState, managedLayers: ReadonlySet<string>): boolean {
  return (
    layer.groupName === MANAGED_GROUP ||
    managedLayers.has(layer.name) ||
    // Floor, kept deliberately. This name-prefix guess is the weakest of the
    // three and would be the wrong sole signal, but the three are unioned and
    // never subtract, so keeping it means this check can only ever grant more
    // than the version that worked before — which is the point.
    layer.name.startsWith('upload_') ||
    layer.name.startsWith('dbtable_')
  )
}

/**
 * Layers MapProxy has a cache configured for. Anything not listed here is
 * rendered straight from MapServer — correct, just slower. Keep in sync with
 * mapproxy/mapproxy.yaml when you add a layer you want cached.
 */
export const CACHED_LAYERS = new Set([
  'osm_landcover',
  'osm_roads',
  'osm_buildings',
  'adm2_overview',
  'adm2_detail',
  'poi',
])

export function renderUrlFor(layer: string): string {
  return CACHED_LAYERS.has(layer) ? TILE_URL : WMS_URL
}

/**
 * WMS layer name -> pg_featureserv OGC API Features collection id, so the
 * attribute table knows which table backs a given layer. Mirrors each
 * LAYER's DATA source in the mapfiles (webgis.map / osm-layers.map) — keep
 * in sync when a layer's source table changes. Layers with no entry here
 * (e.g. the raster "dem" layer) have no feature data and get no table button.
 */
export const FEATURE_COLLECTIONS: Record<string, string> = {
  poi: 'gis.poi',
  adm2_overview: 'gis.adm2_simple',
  adm2_detail: 'raw.adm2',
  osm_landcover: 'gis.landcover',
  osm_roads: 'gis.roads',
  osm_buildings: 'gis.buildings',
}

/**
 * Resolves a layer's pg_featureserv collection id: the static table above
 * for hand-authored layers, or `dynamicCollections` (fetched from
 * upload-api's /layers — see loadDynamicCollections) for anything created
 * via upload or table registration. A file upload always lands in schema
 * "raw" under its own layer name, but a *registered* table (dbtable_*) can
 * point at any schema/table, so that mapping can't be guessed from the name
 * — it has to come from upload-api, which is the only place that knows it.
 */
export function collectionFor(layerName: string, dynamicCollections: Record<string, string> = {}): string | undefined {
  if (layerName in FEATURE_COLLECTIONS) return FEATURE_COLLECTIONS[layerName]
  const dynamic = dynamicCollections[layerName]
  if (dynamic) return dynamic
  // Last resort when /layers is unavailable: a file upload always lands in
  // schema "raw" with the table named after the layer (app.py's /upload passes
  // the same string as both), so it is derivable. A registered table is not —
  // dbtable_<slug(schema_table)> flattens the schema/table boundary and cannot
  // be reversed — so those still need /layers.
  if (layerName.startsWith('upload_')) return `raw.${layerName}`
  return undefined
}

interface DynamicLayerInfo {
  collections: Record<string, string>
  geometryTypes: Record<string, string>
  /** Every layer upload-api reported, whether uploaded or registered. */
  managed: Set<string>
  /** False when upload-api could not be reached or answered with an error. */
  ok: boolean
}

const noDynamicLayers = (ok: boolean): DynamicLayerInfo => ({
  collections: {},
  geometryTypes: {},
  managed: new Set(),
  ok,
})

async function loadDynamicLayerInfo(): Promise<DynamicLayerInfo> {
  try {
    const res = await fetch(LAYERS_URL, { cache: 'no-store' })
    if (!res.ok) return noDynamicLayers(false)
    const body = await res.json()
    const collections: Record<string, string> = {}
    const geometryTypes: Record<string, string> = {}
    const managed = new Set<string>()
    for (const l of body.layers ?? []) {
      managed.add(l.name)
      collections[l.name] = `${l.schema}.${l.table}`
      if (l.geometry_type) geometryTypes[l.name] = l.geometry_type
    }
    return { collections, geometryTypes, managed, ok: true }
  } catch {
    // Report the failure rather than folding it into "no managed layers".
    // Those two look identical from an empty result, and treating them the
    // same is what let a working delete button vanish without a word.
    return noDynamicLayers(false)
  }
}

async function loadLayerConfigs(): Promise<Record<string, LayerConfig>> {
  try {
    const res = await fetch(LAYER_CONFIG_URL, { cache: 'no-store' })
    return res.ok ? await res.json() : {}
  } catch {
    return {}
  }
}

export interface Bbox {
  west: number
  south: number
  east: number
  north: number
}

/** A node exactly as it appears in the capabilities document. */
export interface CapNode {
  name: string | null
  title: string
  bbox: Bbox | null
  children: CapNode[]
}

/** A drawable layer plus its UI state. */
export interface LayerState {
  name: string
  title: string
  bbox: Bbox | null
  /** Group title, for display in the tree. */
  group: string | null
  /** Group *name* — the stable identifier. See MANAGED_GROUP / isManaged. */
  groupName: string | null
  visible: boolean
  opacity: number
}

// ---------------------------------------------------------------- parsing

function childrenNamed(el: Element, localName: string): Element[] {
  return Array.from(el.children).filter((c) => c.localName === localName)
}

function textOf(el: Element, localName: string): string | null {
  const found = childrenNamed(el, localName)[0]
  return found ? found.textContent!.trim() : null
}

function parseBbox(el: Element): Bbox | null {
  const box = childrenNamed(el, 'EX_GeographicBoundingBox')[0]
  if (!box) return null
  const num = (t: string) => Number(textOf(box, t))
  const b: Bbox = {
    west: num('westBoundLongitude'),
    east: num('eastBoundLongitude'),
    south: num('southBoundLatitude'),
    north: num('northBoundLatitude'),
  }
  return Object.values(b).some(Number.isNaN) ? null : b
}

function parseNode(el: Element): CapNode {
  return {
    name: textOf(el, 'Name'),
    title: textOf(el, 'Title') ?? textOf(el, 'Name') ?? '(ohne Titel)',
    bbox: parseBbox(el),
    children: childrenNamed(el, 'Layer').map(parseNode),
  }
}

/** First 300 characters of a response body, for error messages. */
function snippet(body: string): string {
  const flat = body.replace(/\s+/g, ' ').trim()
  return flat.length > 300 ? `${flat.slice(0, 300)}…` : flat
}

/**
 * MapServer reports most failures — a mapfile it cannot parse, a layer it
 * cannot open — as a ServiceExceptionReport carrying HTTP 200, so the response
 * looks entirely ordinary until you read it. Pull the message out so the layer
 * panel shows the actual fault instead of the "no <Capability>" that merely
 * follows from it.
 *
 * Only ServiceException and ExceptionText are matched: a *valid* capabilities
 * document contains <Capability><Exception><Format>, so matching a bare
 * <Exception> would report a healthy response as broken.
 */
function serviceException(doc: Document): string | null {
  for (const tag of ['ServiceException', 'ExceptionText']) {
    const text = doc.getElementsByTagNameNS('*', tag)[0]?.textContent?.trim()
    if (text) return text
  }
  return null
}

export async function fetchCapabilities(signal?: AbortSignal): Promise<CapNode> {
  const url = `${WMS_URL}?service=WMS&version=1.3.0&request=GetCapabilities`
  const res = await fetch(url, { signal })
  const body = await res.text()
  if (!res.ok) throw new Error(`GetCapabilities: HTTP ${res.status} — ${snippet(body)}`)

  const doc = new DOMParser().parseFromString(body, 'text/xml')
  if (doc.getElementsByTagName('parsererror').length) {
    throw new Error(`Capabilities ist kein gültiges XML — ${snippet(body)}`)
  }

  const fault = serviceException(doc)
  if (fault) throw new Error(`MapServer meldet: ${fault}`)

  const cap = doc.getElementsByTagNameNS('*', 'Capability')[0]
  if (!cap) {
    const root = doc.documentElement?.nodeName ?? '(leer)'
    throw new Error(`Kein <Capability>-Element gefunden. Wurzelelement: <${root}> — ${snippet(body)}`)
  }
  const rootLayer = childrenNamed(cap, 'Layer')[0]
  if (!rootLayer) throw new Error('Kein Wurzel-Layer gefunden')
  return parseNode(rootLayer)
}

/**
 * Flatten to drawable leaves, remembering which group each came from — both the
 * title (shown in the tree) and the name (identifies the group; isManaged keys
 * off it, so it must not be a display string).
 */
export function flattenLeaves(
  node: CapNode,
  group: string | null = null,
  groupName: string | null = null,
): LayerState[] {
  if (node.children.length === 0) {
    if (!node.name) return []
    return [{
      name: node.name,
      title: node.title,
      bbox: node.bbox,
      group,
      groupName,
      visible: !DEFAULT_OFF.has(node.name),
      opacity: 1,
    }]
  }
  // the outermost node is the service itself, not a real group
  const nextGroup = node.name ? node.title : group
  const nextGroupName = node.name ? node.name : groupName
  return node.children.flatMap((c) => flattenLeaves(c, nextGroup, nextGroupName))
}

const DEFAULT_OFF = new Set(['dem'])

// ------------------------------------------------------------ style overrides
//
// Per-class color overrides, keyed by layer name then class name, e.g.
// { osm_landcover: { Wald: '#2a6b3a' } }. Persisted so a recolored legend
// survives a reload. Scene.tsx turns an active override into an SLD_BODY
// GetMap request straight to MapServer, bypassing the MapProxy tile cache
// (which only ever serves the mapfile's default styling).

const STYLE_OVERRIDES_KEY = 'webgis:style-overrides'

type StyleOverrides = Record<string, Record<string, string>>

function loadStyleOverrides(): StyleOverrides {
  try {
    const raw = localStorage.getItem(STYLE_OVERRIDES_KEY)
    return raw ? JSON.parse(raw) : {}
  } catch {
    return {}
  }
}

function saveStyleOverrides(overrides: StyleOverrides) {
  try {
    localStorage.setItem(STYLE_OVERRIDES_KEY, JSON.stringify(overrides))
  } catch {
    // storage unavailable (private mode, quota) — overrides just stay session-only
  }
}

// --------------------------------------------------------- attribute filters
//
// Per-layer attribute filters (column/operator/value conditions), keyed by
// layer name. Applied as the WMS `filter` GetMap parameter (see filter.ts),
// which — like SLD_BODY — MapProxy's cache can't vary per user, so a
// filtered layer bypasses the cache the same way a recolored one does.

const ATTRIBUTE_FILTERS_KEY = 'webgis:attribute-filters'

export interface LayerFilter {
  logic: FilterLogic
  conditions: FilterCondition[]
}

type AttributeFilters = Record<string, LayerFilter>

function loadAttributeFilters(): AttributeFilters {
  try {
    const raw = localStorage.getItem(ATTRIBUTE_FILTERS_KEY)
    if (!raw) return {}
    const parsed = JSON.parse(raw)
    // Defensive: an older session may have saved the pre-AND/OR shape (a
    // bare condition array). Anything that doesn't match the current shape
    // is dropped rather than risking a crash reading it back.
    const out: AttributeFilters = {}
    for (const [layer, val] of Object.entries(parsed ?? {})) {
      if (val && typeof val === 'object' && !Array.isArray(val) && Array.isArray((val as LayerFilter).conditions)) {
        out[layer] = val as LayerFilter
      }
    }
    return out
  } catch {
    return {}
  }
}

function saveAttributeFilters(filters: AttributeFilters) {
  try {
    localStorage.setItem(ATTRIBUTE_FILTERS_KEY, JSON.stringify(filters))
  } catch {
    // storage unavailable — filters just stay session-only
  }
}

// ------------------------------------------------------------------ store

interface AppState {
  layers: LayerState[]          // index 0 draws on TOP
  loading: boolean
  error: string | null

  osmVisible: boolean
  terrainOn: boolean
  terrainAvailable: boolean | null
  tilesOn: boolean
  tilesAvailable: boolean | null
  lighting: boolean

  // The layer panel lives outside the Resium <Viewer> tree now (docked
  // sidebar), so it can't reach useCesium() directly. Scene stashes the
  // camera here once Cesium is ready, instead.
  camera: Camera | null
  setCamera: (camera: Camera | null) => void

  styleOverrides: StyleOverrides
  setClassColor: (layer: string, className: string, hex: string) => void
  resetClassColor: (layer: string, className: string) => void

  attributeFilters: AttributeFilters
  setAttributeFilter: (layer: string, filter: LayerFilter) => void

  // Session-only (not persisted): the column list upload-api hands back right
  // after a file upload or table registration, so the filter builder doesn't
  // have to wait on pg_featureserv noticing a table that didn't exist a
  // moment ago (its catalog discovery lags real table creation by minutes).
  layerColumns: Record<string, { key: string; numeric: boolean }[]>
  setLayerColumns: (layer: string, columns: { key: string; numeric: boolean }[]) => void

  // schema.table for every layer upload-api knows about (see collectionFor).
  // Refreshed whenever load() runs, so it's correct after a fresh page load
  // too, not just for layers created this session.
  dynamicCollections: Record<string, string>
  // Mapfile TYPE (POINT/LINE/POLYGON) for the same layers — resolveLegend
  // needs a geometry kind for a classified layer that has no LEGENDS entry.
  dynamicGeometry: Record<string, string>
  // Which layers upload-api can delete: every block in uploads.map, uploaded
  // and registered alike. See isManaged.
  managedLayers: Set<string>
  // Set when /layers could not be reached. The attribute table, filter and
  // classification all need the schema.table it provides, so the panel warns
  // rather than silently rendering fewer buttons.
  layersServiceDown: boolean

  // Per-layer config (classification, and more to come) from upload-api.
  // Applies to every layer, static ones included — see resolveLegend.
  layerConfigs: Record<string, LayerConfig>
  saveClassification: (layer: string, classification: Classification) => Promise<void>
  clearClassification: (layer: string) => Promise<void>

  load: () => Promise<void>
  toggle: (name: string) => void
  setOpacity: (name: string, opacity: number) => void
  reorder: (from: number, to: number) => void
  move: (name: string, delta: number) => void

  setOsm: (v: boolean) => void
  setTerrain: (v: boolean) => void
  setTiles: (v: boolean) => void
  setLighting: (v: boolean) => void
  probeAssets: () => Promise<void>
}

async function urlExists(url: string): Promise<boolean> {
  try {
    const res = await fetch(url, { cache: 'no-store' })
    return res.ok
  } catch {
    return false
  }
}

export const useApp = create<AppState>((set, get) => ({
  layers: [],
  loading: true,
  error: null,

  osmVisible: true,
  terrainOn: false,
  terrainAvailable: null,
  tilesOn: false,
  tilesAvailable: null,
  lighting: false,

  camera: null,
  setCamera: (camera) => set({ camera }),

  styleOverrides: loadStyleOverrides(),

  setClassColor: (layer, className, hex) => {
    if (!isValidHex(hex)) return
    set((s) => {
      const styleOverrides = {
        ...s.styleOverrides,
        [layer]: { ...s.styleOverrides[layer], [className]: hex },
      }
      saveStyleOverrides(styleOverrides)
      return { styleOverrides }
    })
  },

  resetClassColor: (layer, className) => {
    set((s) => {
      const layerOverrides = { ...s.styleOverrides[layer] }
      delete layerOverrides[className]
      const styleOverrides = { ...s.styleOverrides, [layer]: layerOverrides }
      saveStyleOverrides(styleOverrides)
      return { styleOverrides }
    })
  },

  attributeFilters: loadAttributeFilters(),

  setAttributeFilter: (layer, filter) => {
    set((s) => {
      const attributeFilters = { ...s.attributeFilters, [layer]: filter }
      saveAttributeFilters(attributeFilters)
      return { attributeFilters }
    })
  },

  layerColumns: {},
  setLayerColumns: (layer, columns) =>
    set((s) => ({ layerColumns: { ...s.layerColumns, [layer]: columns } })),

  dynamicCollections: {},
  dynamicGeometry: {},
  managedLayers: new Set<string>(),
  layersServiceDown: false,

  layerConfigs: {},

  saveClassification: async (layer, classification) => {
    const res = await fetch(`${LAYER_CONFIG_URL}/${encodeURIComponent(layer)}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ classification }),
    })
    if (!res.ok) {
      const body = await res.json().catch(() => null)
      throw new Error(body?.detail ?? `Klassifizierung speichern fehlgeschlagen: HTTP ${res.status}`)
    }
    const merged = await res.json()
    set((s) => ({ layerConfigs: { ...s.layerConfigs, [layer]: merged } }))
  },

  // There's no "unset just this key" in a PATCH-merges-keys model, so
  // clearing deletes the layer's config entirely — fine while classification
  // is the only key; once more keys land here this'll need to become a real
  // partial-delete instead.
  clearClassification: async (layer) => {
    set((s) => ({ layerConfigs: { ...s.layerConfigs, [layer]: {} } }))
    await fetch(`${LAYER_CONFIG_URL}/${encodeURIComponent(layer)}`, { method: 'DELETE' })
  },

  load: async () => {
    set({ loading: true, error: null })
    try {
      const [root, dynamicInfo, layerConfigs] = await Promise.all([
        fetchCapabilities(),
        loadDynamicLayerInfo(),
        loadLayerConfigs(),
      ])
      // Capabilities list layers in mapfile order, which is bottom-to-top by
      // MapServer convention: landcover, then roads, then buildings on top.
      // The store is top-first, so reverse it — otherwise land cover would
      // default to covering everything beneath it.
      set({
        layers: flattenLeaves(root).reverse(),
        dynamicCollections: dynamicInfo.collections,
        dynamicGeometry: dynamicInfo.geometryTypes,
        managedLayers: dynamicInfo.managed,
        layersServiceDown: !dynamicInfo.ok,
        layerConfigs,
        loading: false,
      })
    } catch (err) {
      set({ error: err instanceof Error ? err.message : String(err), loading: false })
    }
  },

  toggle: (name) =>
    set((s) => ({
      layers: s.layers.map((l) => (l.name === name ? { ...l, visible: !l.visible } : l)),
    })),

  setOpacity: (name, opacity) =>
    set((s) => ({
      layers: s.layers.map((l) => (l.name === name ? { ...l, opacity } : l)),
    })),

  reorder: (from, to) =>
    set((s) => {
      if (from === to) return s
      const next = s.layers.slice()
      const [moved] = next.splice(from, 1)
      next.splice(to, 0, moved)
      return { layers: next }
    }),

  move: (name, delta) => {
    const { layers, reorder } = get()
    const i = layers.findIndex((l) => l.name === name)
    const j = i + delta
    if (i < 0 || j < 0 || j >= layers.length) return
    reorder(i, j)
  },

  setOsm: (v) => set({ osmVisible: v }),
  setTerrain: (v) => set({ terrainOn: v }),
  setTiles: (v) => set({ tilesOn: v }),
  setLighting: (v) => set({ lighting: v }),

  probeAssets: async () => {
    const [terrain, tiles] = await Promise.all([
      urlExists(`${TERRAIN_URL}/layer.json`),
      urlExists(TILES3D_URL),
    ])
    set({ terrainAvailable: terrain, tilesAvailable: tiles })
    if (!terrain) set({ terrainOn: false })
    if (!tiles) set({ tilesOn: false })
  },
}))
