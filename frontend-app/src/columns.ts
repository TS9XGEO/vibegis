/**
 * Column/value discovery shared by the attribute filter and the
 * classification editor — both need "what columns does this layer have"
 * and "what distinct values does this column have".
 */
import { FEATURES_URL } from './tools'
import { COLUMN_STATS_URL, DISTINCT_VALUES_URL } from './wms'

export interface Column {
  key: string
  numeric: boolean
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
 * A freshly uploaded/registered layer can briefly 404 here: pg_featureserv
 * discovers new tables on its own schedule, which can lag a moment behind
 * the mapfile append that makes the layer show up in the panel. One retry
 * covers that gap without making a stale collection look like a hard error.
 */
export async function fetchColumns(collection: string): Promise<Column[]> {
  try {
    return await fetchColumnsOnce(collection)
  } catch (e) {
    if (e instanceof Error && e.message.includes('404')) {
      await new Promise((r) => setTimeout(r, 1500))
      return fetchColumnsOnce(collection)
    }
    throw e
  }
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
}

export async function fetchColumnStats(schema: string, table: string, column: string): Promise<ColumnStats> {
  const url = `${COLUMN_STATS_URL}?schema=${encodeURIComponent(schema)}&table=${encodeURIComponent(table)}&column=${encodeURIComponent(column)}`
  const res = await fetch(url, { cache: 'no-store' })
  if (!res.ok) throw new Error(`Statistik: HTTP ${res.status}`)
  return res.json()
}
