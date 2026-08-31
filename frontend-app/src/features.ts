/**
 * Shared feature-fetching for anything that needs a layer's actual rows —
 * the attribute table and the selection tools alike — from pg_featureserv's
 * OGC API Features endpoint (the same one the search box already uses).
 */
import { retryFreshLayer } from './freshLayerRetry'
import type { Bbox } from './spatial'
import { FEATURES_URL } from './tools'

// Matches PGFS_PAGING_LIMITMAX in docker-compose.yml: pg_featureserv rejects
// any limit above this, so fetching everything has to page in chunks and
// concatenate rather than request it all in one shot.
const FETCH_CHUNK = 1000

// Selection is a UI concern (highlighting on the map, listing in a popover),
// not a bulk-export one — some of this app's real layers run into the
// millions of rows (raw.osm_buildings: 1.68M), so even a server-narrowed
// bbox/filter match can still be too big to usefully select or highlight.
// Stop paginating past this many and tell the caller so, rather than either
// hammering the network or handing SelectionHighlight tens of thousands of
// Cesium entities to create.
export const SELECTION_FETCH_CAP = 10000

export interface Feature {
  id: string
  properties: Record<string, unknown>
  geometry: GeoJSON.Geometry
}

// A freshly uploaded/registered layer's collection can 404 here — see
// freshLayerRetry.ts for why pg_featureserv's own discovery lag has to be
// absorbed here rather than closed at the source. Once one page succeeds
// the collection is known to exist, so later pages in the same fetchPaged()
// loop never hit the retry path.
async function fetchOnePage(
  collection: string,
  extraQuery: string,
  offset: number,
  limit: number,
  signal?: AbortSignal,
  onRetry?: () => void,
): Promise<Feature[]> {
  return retryFreshLayer(async () => {
    const url =
      `${FEATURES_URL}/collections/${encodeURIComponent(collection)}/items` +
      `?limit=${limit}&offset=${offset}${extraQuery}`
    const res = await fetch(url, { signal })
    if (!res.ok) throw new Error(`Sachdaten: HTTP ${res.status}`)
    const json = await res.json()
    return (json.features ?? []).map((f: any) => ({
      id: String(f.id ?? ''),
      properties: f.properties ?? {},
      geometry: f.geometry,
    }))
  }, onRetry)
}

async function fetchPaged(
  collection: string,
  extraQuery: string,
  cap: number,
  signal?: AbortSignal,
): Promise<{ features: Feature[]; truncated: boolean }> {
  const all: Feature[] = []
  let offset = 0
  for (;;) {
    const page = await fetchOnePage(collection, extraQuery, offset, FETCH_CHUNK, signal)
    all.push(...page)
    if (page.length < FETCH_CHUNK) return { features: all, truncated: false }
    if (all.length >= cap) return { features: all, truncated: true }
    offset += FETCH_CHUNK
  }
}

export async function fetchFeaturePage(
  collection: string,
  offset: number,
  limit: number,
  signal?: AbortSignal,
  onRetry?: () => void,
): Promise<Feature[]> {
  return fetchOnePage(collection, '', offset, limit, signal, onRetry)
}

/** One page within a bounding box — the attribute table's "Kartenansicht" mode, same offset/limit
 * pagination as fetchFeaturePage, just scoped to what's currently on screen. */
export async function fetchFeaturePageInBbox(
  collection: string,
  bbox: Bbox,
  offset: number,
  limit: number,
  signal?: AbortSignal,
  onRetry?: () => void,
): Promise<Feature[]> {
  const extra = `&bbox=${bbox.west},${bbox.south},${bbox.east},${bbox.north}`
  return fetchOnePage(collection, extra, offset, limit, signal, onRetry)
}

/** Rows within a bounding box (`bbox=` is core OGC API Features, works for any layer with no
 * need to know its geometry column name — unlike a CQL spatial predicate). An optional `cql`
 * (see filter.ts's buildCql()) combines with the bbox in the same request — pg_featureserv
 * accepts both `bbox=` and `filter=` together — so the dashboard's Kartenansicht overview can
 * scope to a layer's active attribute filter without a second round trip. */
export async function fetchFeaturesInBbox(
  collection: string,
  bbox: Bbox,
  signal?: AbortSignal,
  cql?: string,
): Promise<{ features: Feature[]; truncated: boolean }> {
  let extra = `&bbox=${bbox.west},${bbox.south},${bbox.east},${bbox.north}`
  if (cql) extra += `&filter=${encodeURIComponent(cql)}`
  return fetchPaged(collection, extra, SELECTION_FETCH_CAP, signal)
}

/** Rows matching a CQL filter string (see filter.ts's buildCql()). */
export async function fetchFeaturesWithFilter(
  collection: string,
  cql: string,
  signal?: AbortSignal,
): Promise<{ features: Feature[]; truncated: boolean }> {
  const extra = `&filter=${encodeURIComponent(cql)}`
  return fetchPaged(collection, extra, SELECTION_FETCH_CAP, signal)
}

/** Every row in a layer, no bbox scoping — same cap as every other bulk
 * fetch here (SelectionDashboard.tsx's "everything selected" overview uses
 * this for CSV export, since a layer can run into the millions of rows and
 * this is a browser download, not a server-side aggregate). An optional
 * `cql` scopes it to a layer's active attribute filter, same as
 * fetchFeaturesInBbox's — otherwise a "filtered" overview's own CSV export
 * would silently include the whole unfiltered table. */
export async function fetchAllFeatures(
  collection: string,
  signal?: AbortSignal,
  cql?: string,
): Promise<{ features: Feature[]; truncated: boolean }> {
  const extra = cql ? `&filter=${encodeURIComponent(cql)}` : ''
  return fetchPaged(collection, extra, SELECTION_FETCH_CAP, signal)
}
