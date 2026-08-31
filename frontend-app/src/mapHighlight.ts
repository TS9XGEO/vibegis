/**
 * Shared entity-drawing for anything that outlines a feature's real GeoJSON
 * geometry on the globe in a given color pair (a crisp shape plus a wider,
 * translucent glow underneath — Cesium has no built-in glow/bloom for
 * individual entities). Used by SelectionHighlight.tsx (the real selection,
 * always SELECTION_COLOR) and DashboardHighlight.tsx (the dashboard's
 * separate, non-destructive "preview" highlight, its own color) alike, so
 * the two independent highlights stay visually consistent without
 * duplicating this per-geometry-type logic.
 */
import { Cartesian3, Color } from 'cesium'

import type { Feature } from './features'

export interface HighlightColors {
  main: Color
  glow: Color
}

function positionsOf(ring: number[][]): Cartesian3[] {
  return ring.map(([lon, lat]) => Cartesian3.fromDegrees(lon, lat))
}

export function addHighlightEntities(viewer: any, f: Feature, bucket: any[], colors: HighlightColors) {
  const geom = f.geometry
  if (!geom) return
  const { main, glow } = colors

  const addPoint = (lon: number, lat: number) => {
    const position = Cartesian3.fromDegrees(lon, lat)
    // Halo only, no core: the classified dot itself is a pixel baked into the
    // WMS map image, not a separate object, so there's no way to draw our
    // highlight entity "beneath" it — Cesium always composites entities on
    // top of the map texture. Leaving the center untouched and only drawing
    // the two larger, translucent rings around it is the closest equivalent:
    // the real dot's own color and pixels are never covered by anything.
    bucket.push(viewer.entities.add({ position, point: { pixelSize: 30, color: main.withAlpha(0.12) } }))
    bucket.push(viewer.entities.add({ position, point: { pixelSize: 20, color: main.withAlpha(0.3) } }))
  }
  const addLine = (coords: number[][]) => {
    const positions = positionsOf(coords)
    bucket.push(
      viewer.entities.add({ polyline: { positions, width: 18, material: glow, clampToGround: true } }),
    )
    bucket.push(
      viewer.entities.add({ polyline: { positions, width: 7, material: main, clampToGround: true } }),
    )
  }
  const addPolygon = (ring: number[][]) => {
    const positions = positionsOf(ring)
    bucket.push(
      viewer.entities.add({
        polyline: { positions: [...positions, positions[0]], width: 14, material: glow, clampToGround: true },
      }),
    )
    bucket.push(
      viewer.entities.add({
        polygon: {
          hierarchy: { positions, holes: [] },
          material: main.withAlpha(0.55),
          outline: true,
          outlineColor: main,
        },
      }),
    )
  }

  switch (geom.type) {
    case 'Point':
      addPoint(geom.coordinates[0], geom.coordinates[1])
      return
    case 'MultiPoint':
      geom.coordinates.forEach((c) => addPoint(c[0], c[1]))
      return
    case 'LineString':
      addLine(geom.coordinates)
      return
    case 'MultiLineString':
      geom.coordinates.forEach(addLine)
      return
    case 'Polygon':
      addPolygon(geom.coordinates[0])
      return
    case 'MultiPolygon':
      geom.coordinates.forEach((poly) => addPolygon(poly[0]))
      return
  }
}
