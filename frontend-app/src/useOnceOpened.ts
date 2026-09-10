/**
 * "Has this been open at least once?" — the guard that makes React.lazy work
 * for a modal without costing it its close animation.
 *
 * A lazy component only stays unfetched while it is not rendered at all, so
 * mounting one with `opened={false}` (which is how every modal in this app is
 * written) fetches its chunk on first render and defers nothing. Guarding the
 * render on the open flag alone fixes that but introduces a second problem:
 * closing unmounts the component outright, so Mantine's fade-out never runs
 * and the modal vanishes instantly.
 *
 * This keeps both. Render on `useOnceOpened(open)` rather than on `open`: the
 * chunk is fetched the first time the modal is opened, and from then on the
 * component stays mounted and receives `opened={open}` as normal, transitions
 * included.
 */
import { useRef } from 'react'

export function useOnceOpened(open: boolean): boolean {
  const seen = useRef(false)
  if (open) seen.current = true
  return seen.current
}
