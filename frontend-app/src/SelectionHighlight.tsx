/**
 * Draws a highlight outline on the globe for every currently selected
 * feature, from its real GeoJSON geometry. No UI of its own — mounted inside
 * <Scene> purely for useCesium() access, same entity-lifecycle convention as
 * MapTools' measure tool (add on change, remove on cleanup). Entity drawing
 * itself lives in mapHighlight.ts, shared with DashboardHighlight.tsx's
 * separate, non-destructive highlight.
 */
import { useEffect, useRef } from 'react'
import { Color } from 'cesium'
import { useCesium } from 'resium'

import { SELECTION_COLOR } from './colorScheme'
import { addHighlightEntities } from './mapHighlight'
import { useSelection } from './selection'

const COLORS = {
  main: Color.fromCssColorString(SELECTION_COLOR),
  glow: Color.fromCssColorString(SELECTION_COLOR).withAlpha(0.3),
}

export default function SelectionHighlight() {
  const { viewer } = useCesium()
  const selected = useSelection((s) => s.selected)
  const entities = useRef<any[]>([])

  useEffect(() => {
    if (!viewer) return
    entities.current.forEach((e) => viewer.entities.remove(e))
    entities.current = []
    selected.forEach((entry) => addHighlightEntities(viewer, entry.feature, entities.current, COLORS))
    return () => {
      entities.current.forEach((e) => viewer.entities.remove(e))
      entities.current = []
    }
  }, [viewer, selected])

  return null
}
