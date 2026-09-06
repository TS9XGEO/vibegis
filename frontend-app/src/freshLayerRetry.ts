/**
 * pg_featureserv loads its table catalog into memory once at startup and,
 * for a lookup of one specific collection (`GET /collections/{name}`,
 * `TableByName()` in its own source — internal/data/catalog_db.go),
 * *never refreshes it again* — confirmed by reading that source directly.
 * The only thing that forces a reload is a request to the bare listing
 * endpoint, `GET /collections` (`Tables()`, which always calls
 * `refreshTables(true)`). Nothing else in this app ever calls that bare
 * endpoint, so without `warmPgFeatureservCatalog()` below, a table created
 * after pg_featureserv's own first request would stay invisible to it
 * forever, not just briefly — this used to be documented here as "pg_
 * featureserv discovers new tables on its own schedule," which turned out
 * to be wrong: there is no schedule, and confirmed live that retrying the
 * specific collection alone never resolves on its own no matter how long
 * you wait, while one `GET /collections` call resolves it immediately.
 *
 * A short backoff loop still wraps this, since the underlying Postgres
 * table itself may not exist yet the instant a caller's very first attempt
 * runs (upload still in flight) — `onRetry` lets a caller show a
 * reassuring "this can take a bit" notice instead of a bare spinner once a
 * first attempt actually comes back 404. If every attempt still 404s, the
 * final rejection is FRESH_LAYER_WAIT_MESSAGE itself rather than a raw HTTP
 * error, so a caller that just dumps its caught error into an "error" box
 * shows something reassuring instead of a technical dead end.
 */
import { FEATURES_URL } from './tools'

/**
 * Forces pg_featureserv to rescan its table catalog (see the file-level
 * comment above for why this specific endpoint, and no other, does that).
 * Best-effort: any failure here is swallowed and the retry loop below just
 * proceeds to its own next attempt regardless, exactly as if this call
 * didn't exist.
 */
async function warmPgFeatureservCatalog(): Promise<void> {
  try {
    await fetch(`${FEATURES_URL}/collections`, { cache: 'no-store' })
  } catch {
    // best-effort — the caller's own retry of the real request still runs
  }
}
export const FRESH_LAYER_WAIT_MESSAGE =
  'Diese Tabelle wurde gerade erst hochgeladen — das System braucht nach einem ' +
  'frischen Upload manchmal ein paar Minuten, bis alles bereit ist. ' +
  'Perfekter Moment für eine kurze Kaffeepause! ☕😊'

export function isFreshLayerWait(message: string | null | undefined): boolean {
  return message === FRESH_LAYER_WAIT_MESSAGE
}

const RETRY_DELAYS_MS = [1000, 2000, 4000, 8000, 15000, 30000, 30000, 30000, 30000, 30000] // ~2.5 min total budget

export async function retryFreshLayer<T>(fn: () => Promise<T>, onRetry?: () => void): Promise<T> {
  for (const delay of RETRY_DELAYS_MS) {
    try {
      return await fn()
    } catch (e) {
      if (!(e instanceof Error) || !e.message.includes('404')) throw e
      onRetry?.()
      await warmPgFeatureservCatalog()
      await new Promise((r) => setTimeout(r, delay))
    }
  }
  try {
    return await fn()
  } catch (e) {
    if (e instanceof Error && e.message.includes('404')) throw new Error(FRESH_LAYER_WAIT_MESSAGE)
    throw e
  }
}
