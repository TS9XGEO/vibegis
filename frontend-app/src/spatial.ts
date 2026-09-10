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
import { Camera, Cartesian2, Cartesian3, Cartographic, Ellipsoid, Math as CesiumMath, Scene } from 'cesium'

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

/** Whole-world extent — what visibleGroundBbox() falls back to when the view
 * is hemispheric or wraps the antimeridian; see there for both reasons. */
const WHOLE_WORLD: Bbox = { west: -180, south: -90, east: 180, north: 90 }

// Samples per axis for the ray-cast grid below. 7x7 rather than the original
// 3x3: at 3x3 a globe that doesn't fill the screen has hits only at the
// centre, and the box collapsed to a point.
const GRID = 7

// Bisection steps when walking a ray from a screen point that hit the globe
// toward one that missed. 10 steps resolves the limb to ~1/1000th of the
// distance between two grid samples — far finer than the box needs.
const LIMB_STEPS = 10

interface ScreenHit {
  x: number
  y: number
  lon: number
  lat: number
}

// A grid pass plus its silhouette bisections runs several hundred picks, and
// this whole function re-runs on every camera.changed tick — so the three
// Cesium objects each pick would otherwise allocate are reused instead.
// Safe because every result is read into plain numbers before the next call.
const scratchWindow = new Cartesian2()
const scratchCartesian = new Cartesian3()
const scratchCarto = new Cartographic()

function pickLonLat(
  camera: Camera, ellipsoid: Ellipsoid, x: number, y: number,
): { lon: number; lat: number } | null {
  scratchWindow.x = x
  scratchWindow.y = y
  const cartesian = camera.pickEllipsoid(scratchWindow, ellipsoid, scratchCartesian)
  if (!cartesian) return null
  const carto = ellipsoid.cartesianToCartographic(cartesian, scratchCarto)
  if (!carto) return null
  return { lon: CesiumMath.toDegrees(carto.longitude), lat: CesiumMath.toDegrees(carto.latitude) }
}

/**
 * Walks from a screen point known to hit the globe toward one known to miss
 * it, and returns the last point that still hits — i.e. a point on the
 * globe's silhouette. This is what keeps a partly-visible globe from
 * collapsing the box: a sample pointed at open sky used to be discarded
 * outright, so in a zoomed-out view where only the centre sample hit, the
 * "visible extent" became a single point.
 */
function limbBetween(
  camera: Camera, ellipsoid: Ellipsoid, hit: ScreenHit, missX: number, missY: number,
): { lon: number; lat: number } | null {
  let ax = hit.x
  let ay = hit.y
  let bx = missX
  let by = missY
  let best = { lon: hit.lon, lat: hit.lat }
  for (let i = 0; i < LIMB_STEPS; i += 1) {
    const mx = (ax + bx) / 2
    const my = (ay + by) / 2
    const p = pickLonLat(camera, ellipsoid, mx, my)
    if (p) {
      best = p
      ax = mx
      ay = my
    } else {
      bx = mx
      by = my
    }
  }
  return best
}

/**
 * How much of the world a bbox covers, 0..1 — 1 being the whole globe.
 * Callers use it to tell the user when a view is so wide that scoping to it
 * means almost nothing (see WIDE_VIEW_FRACTION).
 */
export function bboxWorldFraction(bbox: Bbox): number {
  const lon = Math.min(360, Math.max(0, bbox.east - bbox.west))
  const lat = Math.min(180, Math.max(0, bbox.north - bbox.south))
  return (lon * lat) / (360 * 180)
}

/**
 * Above this share of the world, "scoped to the current view" stops meaning
 * anything useful — the answer is very nearly "everything" either way, and a
 * user who picked Kartenansicht deserves to be told that rather than left
 * wondering why the filter looks broken. A continental view sits around
 * 0.02; a hemispheric one is 0.5 or more.
 */
export const WIDE_VIEW_FRACTION = 1 / 3

/**
 * A tight bounding box of the ground actually on screen — ray-casts a GRID x
 * GRID mesh of screen points against the ellipsoid via the same
 * `camera.pickEllipsoid()` MapTools.tsx's own click handlers already use, and
 * bounds the ones that hit plus, for every sample that missed while a
 * neighbour hit, the silhouette point between them (see limbBetween).
 *
 * Deliberately not `Camera.computeViewRectangle()`: that's accurate for a
 * near-vertical view, but at any real tilt it has to account for ground near
 * the horizon — which can be a very long way from the camera — so it returns
 * a rectangle many times larger than what's actually visible, and in a
 * zoomed-out view it simply returns the whole world.
 *
 * Two cases collapse to the whole world on purpose, because a `bbox=` query
 * cannot express either one:
 *
 *  - **Hemispheric views.** Once more than 180° of longitude is on screen,
 *    the visible ground is not a lon/lat rectangle at all. Reporting the
 *    whole world over-reports (it includes the far side of the globe) but
 *    never under-reports, and callers surface it via bboxWorldFraction().
 *  - **Views crossing the antimeridian.** OGC API Features says a bbox whose
 *    west exceeds its east wraps the dateline, but pg_featureserv does not
 *    implement that — verified against the running service: `170,-20,-170,20`
 *    returns exactly the same rows as `-170,-20,170,20`, i.e. the complement
 *    of what was asked. Emitting a wrapped box would therefore silently
 *    return the rest of the planet, so the longitude range is widened to the
 *    full span while the latitude range stays tight. Splitting the query in
 *    two either side of the dateline is the fix if this ever needs to be
 *    exact.
 *
 * Null only when nothing on screen hits the ellipsoid at all.
 */
export function visibleGroundBbox(camera: Camera, scene: Scene): Bbox | null {
  const width = scene.canvas.clientWidth
  const height = scene.canvas.clientHeight
  if (!width || !height) return null

  const ellipsoid = scene.globe?.ellipsoid ?? Ellipsoid.WGS84
  const step = (f: number, size: number) => f * (size - 1)

  // Ray-cast the grid first, keeping the misses so the silhouette pass below
  // knows where the globe's edge lies between two samples.
  const grid: (ScreenHit | null)[][] = []
  for (let i = 0; i < GRID; i += 1) {
    const row: (ScreenHit | null)[] = []
    const x = step(i / (GRID - 1), width)
    for (let j = 0; j < GRID; j += 1) {
      const y = step(j / (GRID - 1), height)
      const p = pickLonLat(camera, ellipsoid, x, y)
      row.push(p ? { x, y, lon: p.lon, lat: p.lat } : null)
    }
    grid.push(row)
  }

  const points: { lon: number; lat: number }[] = []
  for (let i = 0; i < GRID; i += 1) {
    for (let j = 0; j < GRID; j += 1) {
      const cell = grid[i][j]
      if (cell) {
        points.push({ lon: cell.lon, lat: cell.lat })
        continue
      }
      // A miss: bisect toward every orthogonal neighbour that hit. Only
      // misses on the hit/miss boundary do any work, so this costs a handful
      // of extra picks along the silhouette rather than one per sample.
      const x = step(i / (GRID - 1), width)
      const y = step(j / (GRID - 1), height)
      for (const [di, dj] of [[-1, 0], [1, 0], [0, -1], [0, 1]]) {
        const neighbour = grid[i + di]?.[j + dj]
        if (!neighbour) continue
        const limb = limbBetween(camera, ellipsoid, neighbour, x, y)
        if (limb) points.push(limb)
      }
    }
  }

  if (points.length === 0) return null

  const lats = points.map((p) => p.lat)
  const south = Math.min(...lats)
  const north = Math.max(...lats)

  // Longitude has to be read as points on a circle, not on a line: the
  // widest gap between consecutive samples is the part of the world *not*
  // on screen, and what remains is the real span. min/max alone would call
  // a view sitting either side of the dateline "the whole world".
  const lons = [...points.map((p) => p.lon)].sort((a, b) => a - b)
  let gapStart = lons[lons.length - 1]
  let gapEnd = lons[0] + 360
  let widest = gapEnd - gapStart
  for (let i = 1; i < lons.length; i += 1) {
    const gap = lons[i] - lons[i - 1]
    if (gap > widest) {
      widest = gap
      gapStart = lons[i - 1]
      gapEnd = lons[i]
    }
  }
  const covered = 360 - widest

  if (covered >= 180) return WHOLE_WORLD

  // The span runs from the far side of the widest gap round to its near
  // side; normalized back into -180..180 it may come out inverted, which is
  // exactly the antimeridian case the doc comment above explains.
  const west = gapEnd > 180 ? gapEnd - 360 : gapEnd
  const east = gapStart
  if (west > east) return { west: -180, south, east: 180, north }
  return { west, south, east, north }
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
