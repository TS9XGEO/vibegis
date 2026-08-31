/**
 * Column/value discovery shared by the attribute filter and the
 * classification editor — both need "what columns does this layer have"
 * and "what distinct values does this column have".
 */
import { retryFreshLayer } from './freshLayerRetry'
import { FEATURES_URL } from './tools'
import { COLUMN_GROUPBY_URL, COLUMN_STATS_URL, DISTINCT_VALUES_URL, TABLE_COUNT_URL, type LayerFilter } from './wms'

/**
 * Appends `&filter=<json>` for the SQL aggregate endpoints below, mirroring
 * filter.ts's buildCql()'s own "usable" condition check — a filter with no
 * usable conditions (e.g. every value cleared) is the same as no filter.
 */
function filterQueryParam(filter: LayerFilter | null | undefined): string {
  const usable = filter?.conditions.filter((c) => c.column && c.value.trim() !== '') ?? []
  if (usable.length === 0) return ''
  return `&filter=${encodeURIComponent(JSON.stringify(filter))}`
}

export interface Column {
  key: string
  numeric: boolean
}

/** A column's display name if one was renamed (see AttributeTable.tsx), else its raw key. */
export function columnLabel(aliases: Record<string, string> | undefined, key: string): string {
  return aliases?.[key] || key
}

async function fetchColumnsOnce(collection: string): Promise<Column[]> {
  const url = `${FEATURES_URL}/collections/${encodeURIComponent(collection)}/items?limit=1`
  const res = await fetch(url, { cache: 'no-store' })
  if (!res.ok) throw new Error(`Spalten: HTTP ${res.status}`)
  const json = await res.json()
  const props = json.features?.[0]?.properties ?? {}
  return Object.entries(props).map(([key, val]) => ({ key, numeric: typeof val === 'number' }))
}

/**
 * A freshly uploaded/registered layer can 404 here: pg_featureserv
 * discovers new tables on its own schedule, which can lag well behind the
 * mapfile append that makes the layer show up in the panel — see
 * freshLayerRetry.ts for why that gap can't just be closed at the source.
 */
export async function fetchColumns(collection: string, onRetry?: () => void): Promise<Column[]> {
  return retryFreshLayer(() => fetchColumnsOnce(collection), onRetry)
}

export interface DistinctValues {
  values: string[]
  truncated: boolean
}

export async function fetchDistinctValues(schema: string, table: string, column: string): Promise<DistinctValues> {
  const url = `${DISTINCT_VALUES_URL}?schema=${encodeURIComponent(schema)}&table=${encodeURIComponent(table)}&column=${encodeURIComponent(column)}`
  const res = await fetch(url, { cache: 'no-store' })
  if (!res.ok) throw new Error(`Werte: HTTP ${res.status}`)
  const body = await res.json()
  return { values: body.values ?? [], truncated: !!body.truncated }
}

export interface ColumnStats {
  min: number
  max: number
  sum: number
  avg: number
  count: number
}

export async function fetchColumnStats(
  schema: string,
  table: string,
  column: string,
  filter?: LayerFilter | null,
): Promise<ColumnStats> {
  const url = `${COLUMN_STATS_URL}?schema=${encodeURIComponent(schema)}&table=${encodeURIComponent(table)}&column=${encodeURIComponent(column)}${filterQueryParam(filter)}`
  const res = await fetch(url, { cache: 'no-store' })
  if (!res.ok) throw new Error(`Statistik: HTTP ${res.status}`)
  return res.json()
}

export interface GroupByBucket {
  value: string
  count: number
}

export interface ColumnGroupBy {
  buckets: GroupByBucket[]
  totalCount: number
  truncated: boolean
}

/**
 * Server-side value+count group-by — the dashboard's "everything selected"
 * overview (SelectionDashboard.tsx's LayerOverviewCard) has no in-memory
 * features to group client-side the way a real selection does, so this
 * hits upload-api's own SQL GROUP BY instead. `totalCount` is exact across
 * every value, not just the (capped) ones in `buckets`, so an "Andere"
 * remainder can be computed exactly even beyond the cap.
 */
export async function fetchColumnGroupBy(
  schema: string,
  table: string,
  column: string,
  filter?: LayerFilter | null,
): Promise<ColumnGroupBy> {
  const url = `${COLUMN_GROUPBY_URL}?schema=${encodeURIComponent(schema)}&table=${encodeURIComponent(table)}&column=${encodeURIComponent(column)}${filterQueryParam(filter)}`
  const res = await fetch(url, { cache: 'no-store' })
  if (!res.ok) throw new Error(`Gruppierung: HTTP ${res.status}`)
  const body = await res.json()
  return { buckets: body.buckets ?? [], totalCount: body.totalCount ?? 0, truncated: !!body.truncated }
}

/** Plain row count for a whole table — see fetchColumnGroupBy's doc comment; same "no in-memory features" reason. */
export async function fetchTableCount(schema: string, table: string, filter?: LayerFilter | null): Promise<number> {
  const url = `${TABLE_COUNT_URL}?schema=${encodeURIComponent(schema)}&table=${encodeURIComponent(table)}${filterQueryParam(filter)}`
  const res = await fetch(url, { cache: 'no-store' })
  if (!res.ok) throw new Error(`Anzahl: HTTP ${res.status}`)
  const body = await res.json()
  return body.count ?? 0
}
