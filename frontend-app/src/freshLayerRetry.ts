/**
 * pg_featureserv discovers a brand-new PostGIS table on its own schedule —
 * no HTTP endpoint to force a refresh, no configurable interval (checked
 * its API docs and config reference). The only lever on our side is
 * patience: retry a 404 with backoff instead of failing hard the instant a
 * layer is created, so a user who opens the data view/filter/select tool a
 * few seconds after an upload finishes never sees an error at all.
 *
 * The backoff schedule spans a couple of minutes, not seconds — the
 * documented worst case for this lag — so `onRetry` lets a caller show a
 * reassuring "this can take a bit" notice instead of a bare spinner once a
 * first attempt actually comes back 404. If every attempt still 404s, the
 * final rejection is FRESH_LAYER_WAIT_MESSAGE itself rather than a raw HTTP
 * error, so a caller that just dumps its caught error into an "error" box
 * shows something reassuring instead of a technical dead end.
 */
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
