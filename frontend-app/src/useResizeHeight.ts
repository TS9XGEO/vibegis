/**
 * Drag-to-resize for a panel with one edge fixed in place (the attribute
 * table, docked to the bottom of the map: its bottom edge is fixed, so a
 * handle at its top grows it upward). `edge` says which edge the handle
 * sits on — 'top' (the default, matching the attribute table) grows the
 * panel when the handle is dragged up; 'bottom' is the mirror image, for a
 * panel fixed at its *top* edge instead (e.g. a floating box anchored to a
 * screen corner, growing downward), where dragging the handle down grows
 * it. Same plain-ref pointer-capture pattern as useDraggable.ts.
 *
 * Also tracks a `maximized` toggle, independent of the drag-resize height —
 * a panel wanting a "fill the available space" button (rather than being
 * capped at `max`) reads this flag itself and swaps its own flex-basis
 * accordingly (see DataViewBand.tsx), since translating "maximized" into
 * an actual CSS size depends on how that panel sits in its parent's layout,
 * not something this generic hook can know. `height`/drag-resize keep
 * working underneath — toggling `maximized` off restores exactly the height
 * the panel had before.
 */
import { useCallback, useRef, useState } from 'react'

export interface ResizeHandleProps {
  onPointerDown: (e: React.PointerEvent) => void
  onPointerMove: (e: React.PointerEvent) => void
  onPointerUp: (e: React.PointerEvent) => void
  style: React.CSSProperties
}

export function useResizeHeight(
  initial: number,
  min: number,
  max: number,
  edge: 'top' | 'bottom' = 'top',
): { height: number; handleProps: ResizeHandleProps; maximized: boolean; toggleMaximize: () => void } {
  const [height, setHeight] = useState(initial)
  const [maximized, setMaximized] = useState(false)
  const drag = useRef<{ startY: number; startHeight: number } | null>(null)

  const onPointerDown = useCallback(
    (e: React.PointerEvent) => {
      e.preventDefault()
      e.currentTarget.setPointerCapture(e.pointerId)
      drag.current = { startY: e.clientY, startHeight: height }
    },
    [height],
  )

  const onPointerMove = useCallback(
    (e: React.PointerEvent) => {
      if (!drag.current) return
      const delta = e.clientY - drag.current.startY
      const next = drag.current.startHeight + (edge === 'top' ? -delta : delta)
      setHeight(Math.min(max, Math.max(min, next)))
      setMaximized(false)
    },
    [min, max, edge],
  )

  const onPointerUp = useCallback((e: React.PointerEvent) => {
    drag.current = null
    e.currentTarget.releasePointerCapture(e.pointerId)
  }, [])

  const toggleMaximize = useCallback(() => setMaximized((m) => !m), [])

  return {
    height,
    handleProps: { onPointerDown, onPointerMove, onPointerUp, style: { touchAction: 'none' } },
    maximized,
    toggleMaximize,
  }
}
