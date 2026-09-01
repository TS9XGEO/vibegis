/**
 * Client-side geometry predicates for the selection tools (point click,
 * draw-circle, draw-polygon) — turf.js primitives, not hand-rolled math.
 * Tests run against a small, server-narrowed candidate list (see
 * features.ts's fetchFeaturesInBbox — bbox filtering happens server-side;
 * some of this app's layers run into the millions of rows, so testing every
 * row client-side isn't an option). A CQL spatial predicate would avoid the
 * client-side test entirely, but needs each table's real geometry column
 * name, which isn't available for hand-authored layers — bbox needs no
 * column name and is precise enough once paired with these exact tests.
 */
import booleanIntersects from '@turf/boolean-intersects'
import booleanPointInPolygon from '@turf/boolean-point-in-polygon'
import circle from '@turf/circle'
import distance from '@turf/distance'
import pointToLineDistance from '@turf/point-to-line-distance'
import { Camera, Cartesian2, Ellipsoid, Math as CesiumMath, Scene } from 'cesium'

import type { Feature } from './features'

export function circlePolygon(centerLon: number, centerLat: number, radiusMeters: number): GeoJSON.Feature {
  return circle([centerLon, centerLat], radiusMeters / 1000, { units: 'kilometers' })
}

// @turf/boolean-intersects doesn't accept multi-geometries — split them into
// their simple parts so a MultiPolygon/MultiLineString/MultiPoint feature
// (common for OSM-derived data) still gets tested correctly.
function explodeMulti(geometry: GeoJSON.Geometry): GeoJSON.Geometry[] {
  switch (geometry.type) {
    case 'MultiPolygon':
      return geometry.coordinates.map((c) => ({ type: 'Polygon' as const, coordinates: c }))
    case 'MultiLineString':
      return geometry.coordinates.map((c) => ({ type: 'LineString' as const, coordinates: c }))
    case 'MultiPoint':
      return geometry.coordinates.map((c) => ({ type: 'Point' as const, coordinates: c }))
    default:
      return [geometry]
  }
}

/** Every feature whose geometry intersects `shape` — a drawn polygon, or a circlePolygon(). */
export function featuresInShape(features: Feature[], shape: GeoJSON.Feature | GeoJSON.Geometry): Feature[] {
  return features.filter((f) => {
    if (!f.geometry) return false
    try {
      return explodeMulti(f.geometry).some((part) => booleanIntersects(part, shape))
    } catch {
      return false
    }
  })
}

function minDistanceToGeometry(click: number[], geometry: GeoJSON.Geometry): number {
  switch (geometry.type) {
    case 'Point':
      return distance(click, geometry.coordinates, { units: 'meters' })
    case 'MultiPoint':
      return Math.min(...geometry.coordinates.map((c) => distance(click, c, { units: 'meters' })))
    case 'LineString':
      return pointToLineDistance(click, geometry, { units: 'meters' })
    case 'MultiLineString':
      return Math.min(
        ...geometry.coordinates.map((c) =>
          pointToLineDistance(click, { type: 'LineString', coordinates: c }, { units: 'meters' }),
        ),
      )
    default:
      return Infinity
  }
}

export interface Bbox {
  west: number
  south: number
  east: number
  north: number
}

function eachCoordinate(coords: any, cb: (lon: number, lat: number) => void): void {
  if (typeof coords[0] === 'number') {
    cb(coords[0], coords[1])
    return
  }
  coords.forEach((c: any) => eachCoordinate(c, cb))
}

/** Bounding box of one geometry — no padding; see padBbox() for that. */
export function bboxOf(geometry: GeoJSON.Geometry): Bbox {
  let west = Infinity
  let south = Infinity
  let east = -Infinity
  let north = -Infinity
  eachCoordinate((geometry as any).coordinates, (lon, lat) => {
    if (lon < west) west = lon
    if (lon > east) east = lon
    if (lat < south) south = lat
    if (lat > north) north = lat
  })
  return { west, south, east, north }
}

/** Widens a bbox by `fraction` of its size (at least `minPad` degrees) — for
 * breathing room around a zoom target, or to avoid a razor-exact bbox
 * clipping a feature that only just touches the edge. */
export function padBbox(bbox: Bbox, fraction = 0.1, minPad = 0.001): Bbox {
  const padLon = Math.max((bbox.east - bbox.west) * fraction, minPad)
  const padLat = Math.max((bbox.north - bbox.south) * fraction, minPad)
  return {
    west: bbox.west - padLon,
    south: bbox.south - padLat,
    east: bbox.east + padLon,
    north: bbox.north + padLat,
  }
}

/**
 * A tight bounding box of the ground actually on screen — ray-casts a 3x3
 * grid of screen points (corners, edge midpoints, center) against the
 * ellipsoid via the same `camera.pickEllipsoid()` MapTools.tsx's own click
 * handlers already use, and bounds whichever ones hit. Deliberately not
 * `Camera.computeViewRectangle()`: that's accurate for a near-vertical view,
 * but at any real tilt it has to account for ground near the horizon — which
 * can be a very long way from the camera — so it can return a rectangle many
 * times larger than what's actually visible on screen (Legend.tsx used it
 * for its Kartenansicht-scoped class list and, at a tilt, ended up showing
 * classes nowhere near the current view). A screen point that misses the
 * globe (pointed at open sky) is just skipped rather than inflating the box
 * toward it or bailing out entirely. Null only when nothing on screen hits
 * the ellipsoid at all.
 */
export function visibleGroundBbox(camera: Camera, scene: Scene): Bbox | null {
  const width = scene.canvas.clientWidth
  const height = scene.canvas.clientHeight
  if (!width || !height) return null

  const ellipsoid = scene.globe?.ellipsoid ?? Ellipsoid.WGS84
  let west = Infinity
  let south = Infinity
  let east = -Infinity
  let north = -Infinity
  let hit = false

  for (const fx of [0, 0.5, 1]) {
    for (const fy of [0, 0.5, 1]) {
      const cartesian = camera.pickEllipsoid(new Cartesian2(fx * width, fy * height), ellipsoid)
      if (!cartesian) continue
      const carto = ellipsoid.cartesianToCartographic(cartesian)
      const lon = CesiumMath.toDegrees(carto.longitude)
      const lat = CesiumMath.toDegrees(carto.latitude)
      hit = true
      if (lon < west) west = lon
      if (lon > east) east = lon
      if (lat < south) south = lat
      if (lat > north) north = lat
    }
  }

  return hit ? { west, south, east, north } : null
}

/** Bounding box across every feature's geometry, padded for breathing room
 * (and so a single point or degenerate bbox still yields a sane zoom level
 * rather than an infinite one). Null when there's nothing to bound. */
export function boundsOfFeatures(features: Feature[]): Bbox | null {
  let west = Infinity
  let south = Infinity
  let east = -Infinity
  let north = -Infinity

  for (const f of features) {
    if (!f.geometry) continue
    const b = bboxOf(f.geometry)
    if (b.west < west) west = b.west
    if (b.east > east) east = b.east
    if (b.south < south) south = b.south
    if (b.north > north) north = b.north
  }
  if (!Number.isFinite(west)) return null
  return padBbox({ west, south, east, north })
}

/**
 * The single closest feature to a click, within toleranceMeters — polygon
 * features must actually contain the point; point/line features match by
 * proximity. Mirrors identifyAt()'s click-tolerance approach in tools.ts.
 * Returns the winning distance too (0 for a containing polygon), so callers
 * selecting across several layers at once can compare across them.
 */
export function nearestFeatureAtPoint(
  features: Feature[],
  lon: number,
  lat: number,
  toleranceMeters: number,
): { feature: Feature; distance: number } | null {
  const click = [lon, lat]
  let best: Feature | null = null
  let bestDist = toleranceMeters

  for (const f of features) {
    const geom = f.geometry
    if (!geom) continue
    try {
      if (geom.type === 'Polygon' || geom.type === 'MultiPolygon') {
        if (booleanPointInPolygon(click, geom)) return { feature: f, distance: 0 }
        continue
      }
      const d = minDistanceToGeometry(click, geom)
      if (d <= bestDist) {
        best = f
        bestDist = d
      }
    } catch {
      // malformed geometry — skip rather than fail the whole click
    }
  }
  return best ? { feature: best, distance: bestDist } : null
}
