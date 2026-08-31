/**
 * Draws SelectionDashboard.tsx's own, non-destructive "preview" highlight —
 * a breakdown value's features, in a color distinct from the real selection
 * (DASHBOARD_HIGHLIGHT_COLOR vs. SELECTION_COLOR) so the two never look like
 * the same thing. Same entity-lifecycle convention as SelectionHighlight.tsx,
 * sharing its per-geometry-type drawing via mapHighlight.ts.
 */
import { useEffect, useRef } from 'react'
import { Color } from 'cesium'
import { useCesium } from 'resium'

import { DASHBOARD_HIGHLIGHT_COLOR } from './colorScheme'
import { useDashboardHighlight } from './dashboardHighlight'
import { addHighlightEntities } from './mapHighlight'

const COLORS = {
  main: Color.fromCssColorString(DASHBOARD_HIGHLIGHT_COLOR),
  glow: Color.fromCssColorString(DASHBOARD_HIGHLIGHT_COLOR).withAlpha(0.3),
}

export default function DashboardHighlight() {
  const { viewer } = useCesium()
  const entries = useDashboardHighlight((s) => s.entries)
  const entities = useRef<any[]>([])

  useEffect(() => {
    if (!viewer) return
    entities.current.forEach((e) => viewer.entities.remove(e))
    entities.current = []
    entries.forEach((entry) => addHighlightEntities(viewer, entry.feature, entities.current, COLORS))
    return () => {
      entities.current.forEach((e) => viewer.entities.remove(e))
      entities.current = []
    }
  }, [viewer, entries])

  return null
}
