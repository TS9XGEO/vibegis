/**
 * Lets a floating HUD panel be dragged to a new spot on screen, without
 * disturbing its default anchored position (top/right or bottom/left CSS) —
 * the drag only ever adds a translate() on top of that. Deliberately
 * component state, not persisted anywhere: a reload or a new session always
 * starts every panel back at its normal spot, exactly as before this existed.
 * Dragging is purely a same-session escape hatch for whenever two panels
 * happen to overlap.
 */
import { useCallback, useRef, useState } from 'react'

export interface DragHandleProps {
  onPointerDown: (e: React.PointerEvent) => void
  onPointerMove: (e: React.PointerEvent) => void
  onPointerUp: (e: React.PointerEvent) => void
  style: React.CSSProperties
}

export function useDraggable(
  initial: { x: number; y: number } = { x: 0, y: 0 },
): { offset: { x: number; y: number }; handleProps: DragHandleProps } {
  const [offset, setOffset] = useState(initial)
  const drag = useRef<{ startX: number; startY: number; originX: number; originY: number } | null>(null)

  const onPointerDown = useCallback(
    (e: React.PointerEvent) => {
      e.preventDefault()
      e.currentTarget.setPointerCapture(e.pointerId)
      drag.current = { startX: e.clientX, startY: e.clientY, originX: offset.x, originY: offset.y }
    },
    [offset],
  )

  const onPointerMove = useCallback((e: React.PointerEvent) => {
    if (!drag.current) return
    setOffset({
      x: drag.current.originX + (e.clientX - drag.current.startX),
      y: drag.current.originY + (e.clientY - drag.current.startY),
    })
  }, [])

  const onPointerUp = useCallback((e: React.PointerEvent) => {
    drag.current = null
    e.currentTarget.releasePointerCapture(e.pointerId)
  }, [])

  return {
    offset,
    handleProps: { onPointerDown, onPointerMove, onPointerUp, style: { cursor: 'grab', touchAction: 'none' } },
  }
}
