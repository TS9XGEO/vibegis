/**
 * Floating toolbox panel: owns the actual Cesium click handlers for
 * identify, measure and select. The button/search UI itself lives in
 * ToolboxControls.tsx, shared with SelectionDashboard.tsx's embedded copy —
 * see that file's header comment for why one copy of the UI is enough even
 * though it can render in two places.
 * Rendered inside the Resium <Viewer> so it can reach the Cesium instance.
 */
import { useEffect, useRef } from 'react'
import {
  ActionIcon,
  Box,
  Paper,
  Transition,
  useComputedColorScheme,
} from '@mantine/core'
import { IconGripHorizontal, IconX } from '@tabler/icons-react'
import {
  BoundingSphere,
  CallbackProperty,
  Cartesian3,
  Cartographic,
  Color,
  EllipsoidGeodesic,
  Math as CesiumMath,
  type Scene,
  ScreenSpaceEventType,
} from 'cesium'
import { useCesium } from 'resium'

import { accentEdge, panelBg, SELECTION_COLOR } from './colorScheme'
import { fetchFeaturesInBbox, type Feature } from './features'
import { buildCql } from './filter'
import { useSelection } from './selection'
import { bboxOf, circlePolygon, featuresInShape, nearestFeatureAtPoint, padBbox } from './spatial'
import { formatArea, formatDistance, identifyAt, useTools } from './tools'
import ToolboxControls, { useSelectCandidates } from './ToolboxControls'
import { useDraggable } from './useDraggable'
import { usePanels } from './panels'
import { useApp } from './wms'

/**
 * Real ground meters-per-pixel at a picked point, from Cesium's own frustum
 * math. `camera.positionCartographic.height / canvas.clientHeight` (the old
 * approach here) only approximates this under a perspective frustum — once
 * AutoOrthographic switches to an orthographic one on close-in zoom (exactly
 * when a click needs to land on a small point symbol), pixel size no longer
 * depends on camera height at all, so that formula drifted arbitrarily far
 * off and made point-click tolerance far too tight to reliably hit anything.
 * getPixelSize() delegates to the frustum's own math either way.
 */
function pixelSizeAt(scene: Scene, point: Cartesian3): number {
  return scene.camera.getPixelSize(
    new BoundingSphere(point, 0),
    scene.canvas.clientWidth,
    scene.canvas.clientHeight,
  )
}

// ------------------------------------------------------------- geodesy ----

function geodesicLength(points: Cartographic[]): number {
  const g = new EllipsoidGeodesic()
  let total = 0
  for (let i = 1; i < points.length; i++) {
    g.setEndPoints(points[i - 1], points[i])
    total += g.surfaceDistance
  }
  return total
}

/** Spherical excess: accurate enough for anything short of a continent. */
function sphericalArea(points: Cartographic[]): number {
  if (points.length < 3) return 0
  const R = 6378137
  let sum = 0
  for (let i = 0; i < points.length; i++) {
    const p1 = points[i]
    const p2 = points[(i + 1) % points.length]
    sum += (p2.longitude - p1.longitude) * (2 + Math.sin(p1.latitude) + Math.sin(p2.latitude))
  }
  return Math.abs((sum * R * R) / 2)
}

// ------------------------------------------------------------------ tools --

export default function MapTools() {
  const { viewer, scene } = useCesium()
  const scheme = useComputedColorScheme('dark')
  const layers = useApp((s) => s.layers)
  const { offset: dragOffset, handleProps: dragHandleProps } = useDraggable()
  const panelOpen = usePanels((s) => s.open.mapTools)
  const hidePanel = usePanels((s) => s.hide)

  const {
    identifyOn, setResults, setIdentifyBusy,
    measure, setMeasure, setMeasureValue,
  } = useTools()

  const measurePoints = useRef<Cartesian3[]>([])
  const measureEntities = useRef<any[]>([])

  const selectMode = useSelection((s) => s.mode)
  const toggleFeature = useSelection((s) => s.toggleFeature)
  const replaceSelectionForLayers = useSelection((s) => s.replaceSelectionForLayers)
  const setSelectTruncated = useSelection((s) => s.setTruncated)
  const selectPoints = useRef<Cartesian3[]>([])
  const selectEntities = useRef<any[]>([])
  const attributeFilters = useApp((s) => s.attributeFilters)

  // Same derivation ToolboxControls.tsx's buttons use for their disabled
  // state — a single hook so the click handlers below and the UI never see
  // a different candidate set.
  const selectCandidates = useSelectCandidates()
  // Stable-ish key for the effect below: re-runs when the actual candidate
  // set changes, not on every render just because the array is a fresh
  // reference (same pattern as Scene.tsx's ImageryOrder).
  const selectCandidatesKey = selectCandidates.map((c) => `${c.name}:${c.collection}`).join(',')

  // A feature the active attribute filter hides shouldn't be selectable
  // either — the map itself already draws only the matching features (see
  // Scene.tsx), so selecting one that doesn't match would pick something
  // invisible and pin it back into the attribute table. Scoped per layer,
  // same as the filter itself.
  function cqlFor(layerName: string): string | undefined {
    const f = attributeFilters[layerName]
    return buildCql(f?.conditions ?? [], f?.logic ?? 'and') ?? undefined
  }

  // ---- identify ----------------------------------------------------------
  useEffect(() => {
    if (!viewer || !scene || !identifyOn) return
    const handler = viewer.screenSpaceEventHandler

    const onClick = async (movement: any) => {
      const c = scene.camera.pickEllipsoid?.(movement.position)
      if (!c) return
      const carto = Cartographic.fromCartesian(c)

      const lon = CesiumMath.toDegrees(carto.longitude)
      const lat = CesiumMath.toDegrees(carto.latitude)
      const mpp = pixelSizeAt(scene, c)

      setIdentifyBusy(true)
      const visible = layers.filter((l) => l.visible).map((l) => l.name)
      const all = await Promise.all(visible.map((n) => identifyAt(n, lon, lat, mpp)))
      setResults(all.flat())
      setIdentifyBusy(false)
    }

    handler.setInputAction(onClick, ScreenSpaceEventType.LEFT_CLICK)
    return () => handler.removeInputAction(ScreenSpaceEventType.LEFT_CLICK)
  }, [viewer, scene, identifyOn, layers, setResults, setIdentifyBusy])

  // ---- measure -----------------------------------------------------------
  function clearMeasure() {
    measureEntities.current.forEach((e) => viewer?.entities.remove(e))
    measureEntities.current = []
    measurePoints.current = []
    setMeasureValue(null)
  }

  useEffect(() => {
    if (!viewer || !scene) return
    if (measure === 'off') {
      clearMeasure()
      return
    }

    clearMeasure()
    const handler = viewer.screenSpaceEventHandler

    const positions = measurePoints.current
    const line = viewer.entities.add({
      polyline: {
        positions: new CallbackProperty(() => positions.slice(), false),
        width: 2.5,
        material: Color.fromCssColorString('#7ec8ff'),
        clampToGround: true,
      },
    })
    measureEntities.current.push(line)

    if (measure === 'area') {
      const poly = viewer.entities.add({
        polygon: {
          hierarchy: new CallbackProperty(
            () => ({ positions: positions.slice(), holes: [] }),
            false,
          ),
          material: Color.fromCssColorString('#7ec8ff').withAlpha(0.25),
        },
      })
      measureEntities.current.push(poly)
    }

    const recompute = () => {
      const cartos = positions.map((p) => Cartographic.fromCartesian(p))
      if (measure === 'distance') {
        setMeasureValue(cartos.length >= 2 ? formatDistance(geodesicLength(cartos)) : null)
      } else {
        setMeasureValue(cartos.length >= 3 ? formatArea(sphericalArea(cartos)) : null)
      }
    }

    const onClick = (movement: any) => {
      const c = scene.camera.pickEllipsoid(movement.position)
      if (!c) return
      positions.push(c)
      const dot = viewer.entities.add({
        position: c,
        point: {
          pixelSize: 7,
          color: Color.WHITE,
          outlineColor: Color.fromCssColorString('#7ec8ff'),
          outlineWidth: 2,
        },
      })
      measureEntities.current.push(dot)
      recompute()
    }

    const onRightClick = () => {
      setMeasure('off')
    }

    handler.setInputAction(onClick, ScreenSpaceEventType.LEFT_CLICK)
    handler.setInputAction(onRightClick, ScreenSpaceEventType.RIGHT_CLICK)

    return () => {
      handler.removeInputAction(ScreenSpaceEventType.LEFT_CLICK)
      handler.removeInputAction(ScreenSpaceEventType.RIGHT_CLICK)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [viewer, scene, measure])

  // ---- select --------------------------------------------------------------
  // Point click toggles the nearest feature; circle/polygon draws (same
  // click-to-add-vertex, right-click-to-finish pattern as measure's area
  // mode) replace the selection with whatever's inside the drawn shape.
  // Candidates come from a bbox-scoped pg_featureserv query (features.ts's
  // fetchFeaturesInBbox), not the whole layer — some of this app's layers
  // run into the millions of rows, so testing every row client-side isn't an
  // option. The exact intersection/proximity test (spatial.ts) still runs
  // client-side, just against that small, server-narrowed candidate list.

  function clearSelectDrawing() {
    selectEntities.current.forEach((e) => viewer?.entities.remove(e))
    selectEntities.current = []
    selectPoints.current = []
  }

  useEffect(() => {
    if (!viewer || !scene) return
    if (selectMode === 'off' || selectCandidates.length === 0) {
      clearSelectDrawing()
      return
    }

    clearSelectDrawing()
    setSelectTruncated(false)
    const handler = viewer.screenSpaceEventHandler
    const candidates = selectCandidates

    if (selectMode === 'point') {
      const onClick = async (movement: any) => {
        const c = scene.camera.pickEllipsoid(movement.position)
        if (!c) return
        const carto = Cartographic.fromCartesian(c)
        const lon = CesiumMath.toDegrees(carto.longitude)
        const lat = CesiumMath.toDegrees(carto.latitude)
        // Same metres-per-pixel-derived tolerance identify's click bbox uses,
        // widened further still — a fat-finger buffer around the actual
        // symbol, since this selects exactly one feature (or none) rather
        // than listing everything under a small area the way identify does.
        const mpp = pixelSizeAt(scene, c)
        const toleranceMeters = Math.max(mpp * 20, 6)
        // Rough metres-to-degrees conversion, same simplification identifyAt()
        // already uses — fine at this scale, and only narrows candidates for
        // the exact client-side test that follows.
        const toleranceDeg = toleranceMeters / 111320

        const bbox = {
          west: lon - toleranceDeg,
          south: lat - toleranceDeg,
          east: lon + toleranceDeg,
          north: lat + toleranceDeg,
        }
        // "All visible layers" picks the single nearest feature across every
        // one of them, not one hit per layer — same click, same intent as a
        // single-layer point-select, just widened to look everywhere visible.
        const perLayer = await Promise.all(
          candidates.map(async (cand) => {
            const { features } = await fetchFeaturesInBbox(cand.collection, bbox, undefined, cqlFor(cand.name))
            const nearest = nearestFeatureAtPoint(features, lon, lat, toleranceMeters)
            return nearest ? { layer: cand.name, ...nearest } : null
          }),
        )
        let best: { layer: string; feature: Feature; distance: number } | null = null
        for (const hit of perLayer) {
          if (hit && (!best || hit.distance < best.distance)) best = hit
        }
        if (best) toggleFeature(best.layer, best.feature)
      }
      handler.setInputAction(onClick, ScreenSpaceEventType.LEFT_CLICK)
      return () => handler.removeInputAction(ScreenSpaceEventType.LEFT_CLICK)
    }

    if (selectMode === 'circle') {
      // Click-drag draws the circle live (an EllipseGraphics whose radius is
      // a CallbackProperty read from a plain ref, updated on every mouse
      // move — no React re-render per pixel). Cesium's default left-drag
      // rotates/pans the globe, so that has to be suspended for the drag to
      // draw instead of spinning the camera, and restored the moment it ends
      // (mouse-up, tool switched, or table closed).
      const cameraController = scene.screenSpaceCameraController
      const saved = {
        rotate: cameraController.enableRotate,
        translate: cameraController.enableTranslate,
        tilt: cameraController.enableTilt,
        look: cameraController.enableLook,
      }
      const restoreCamera = () => {
        cameraController.enableRotate = saved.rotate
        cameraController.enableTranslate = saved.translate
        cameraController.enableTilt = saved.tilt
        cameraController.enableLook = saved.look
      }

      let center: Cartesian3 | null = null
      const radius = { current: 0 }

      const onLeftDown = (movement: any) => {
        const c = scene.camera.pickEllipsoid(movement.position)
        if (!c) return
        center = c
        radius.current = 0
        cameraController.enableRotate = false
        cameraController.enableTranslate = false
        cameraController.enableTilt = false
        cameraController.enableLook = false
        const circleEntity = viewer.entities.add({
          position: center,
          ellipse: {
            semiMajorAxis: new CallbackProperty(() => Math.max(radius.current, 1), false),
            semiMinorAxis: new CallbackProperty(() => Math.max(radius.current, 1), false),
            material: Color.fromCssColorString(SELECTION_COLOR).withAlpha(0.25),
            outline: true,
            outlineColor: Color.fromCssColorString(SELECTION_COLOR),
            outlineWidth: 2,
          },
        })
        selectEntities.current.push(circleEntity)
      }

      const onMouseMove = (movement: any) => {
        if (!center) return
        const c = scene.camera.pickEllipsoid(movement.endPosition)
        if (!c) return
        radius.current = Cartesian3.distance(center, c)
      }

      const onLeftUp = async () => {
        if (!center) return
        restoreCamera()
        const finishedCenter = center
        const finishedRadius = radius.current
        center = null
        // A plain click with no real drag isn't a deliberate circle.
        if (finishedRadius < 5) { clearSelectDrawing(); return }

        const centerCarto = Cartographic.fromCartesian(finishedCenter)
        const centerLon = CesiumMath.toDegrees(centerCarto.longitude)
        const centerLat = CesiumMath.toDegrees(centerCarto.latitude)
        const shape = circlePolygon(centerLon, centerLat, finishedRadius)
        const bbox = padBbox(bboxOf(shape.geometry))
        // "All visible layers" replaces the selection for every one of them
        // at once (clearing ones with no hit inside the circle) — a layer
        // not currently visible isn't part of this operation at all, so
        // whatever it already had selected is left untouched.
        const perLayer = await Promise.all(
          candidates.map(async (cand) => {
            const { features, truncated } = await fetchFeaturesInBbox(cand.collection, bbox, undefined, cqlFor(cand.name))
            return { layer: cand.name, features: featuresInShape(features, shape), truncated }
          }),
        )
        const truncated = perLayer.some((r) => r.truncated)
        setSelectTruncated(truncated)
        if (!truncated) {
          const entries = perLayer.flatMap((r) => r.features.map((feature) => ({ layer: r.layer, feature })))
          replaceSelectionForLayers(candidates.map((c) => c.name), entries)
        }
        clearSelectDrawing()
      }

      handler.setInputAction(onLeftDown, ScreenSpaceEventType.LEFT_DOWN)
      handler.setInputAction(onMouseMove, ScreenSpaceEventType.MOUSE_MOVE)
      handler.setInputAction(onLeftUp, ScreenSpaceEventType.LEFT_UP)
      return () => {
        handler.removeInputAction(ScreenSpaceEventType.LEFT_DOWN)
        handler.removeInputAction(ScreenSpaceEventType.MOUSE_MOVE)
        handler.removeInputAction(ScreenSpaceEventType.LEFT_UP)
        restoreCamera()
      }
    }

    // polygon: click adds a vertex, right-click finishes.
    const positions = selectPoints.current
    const outline = viewer.entities.add({
      polyline: {
        positions: new CallbackProperty(
          () => (positions.length > 1 ? [...positions, positions[0]] : positions.slice()),
          false,
        ),
        width: 2,
        material: Color.fromCssColorString(SELECTION_COLOR),
        clampToGround: true,
      },
    })
    selectEntities.current.push(outline)

    async function finishPolygon() {
      if (selectPoints.current.length < 3) { clearSelectDrawing(); return }
      const ring = selectPoints.current.map((c) => {
        const carto = Cartographic.fromCartesian(c)
        return [CesiumMath.toDegrees(carto.longitude), CesiumMath.toDegrees(carto.latitude)]
      })
      ring.push(ring[0])
      const polygon: GeoJSON.Polygon = { type: 'Polygon', coordinates: [ring] }
      const bbox = padBbox(bboxOf(polygon))
      const perLayer = await Promise.all(
        candidates.map(async (cand) => {
          const { features, truncated } = await fetchFeaturesInBbox(cand.collection, bbox, undefined, cqlFor(cand.name))
          return { layer: cand.name, features: featuresInShape(features, polygon), truncated }
        }),
      )
      const truncated = perLayer.some((r) => r.truncated)
      setSelectTruncated(truncated)
      if (!truncated) {
        const entries = perLayer.flatMap((r) => r.features.map((feature) => ({ layer: r.layer, feature })))
        replaceSelectionForLayers(candidates.map((c) => c.name), entries)
      }
      clearSelectDrawing()
    }

    const onDrawClick = (movement: any) => {
      const c = scene.camera.pickEllipsoid(movement.position)
      if (!c) return
      positions.push(c)
      const dot = viewer.entities.add({
        position: c,
        point: {
          pixelSize: 7,
          color: Color.WHITE,
          outlineColor: Color.fromCssColorString(SELECTION_COLOR),
          outlineWidth: 2,
        },
      })
      selectEntities.current.push(dot)
    }

    const onDrawRightClick = () => {
      void finishPolygon()
    }

    handler.setInputAction(onDrawClick, ScreenSpaceEventType.LEFT_CLICK)
    handler.setInputAction(onDrawRightClick, ScreenSpaceEventType.RIGHT_CLICK)
    return () => {
      handler.removeInputAction(ScreenSpaceEventType.LEFT_CLICK)
      handler.removeInputAction(ScreenSpaceEventType.RIGHT_CLICK)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [viewer, scene, selectMode, selectCandidatesKey, attributeFilters])

  // ---- ui ----------------------------------------------------------------
  return (
    <Transition mounted={panelOpen} transition="fade" duration={180} timingFunction="ease">
      {(transitionStyles) => (
    <Paper
      shadow="md"
      radius="md"
      withBorder
      style={{
        position: 'absolute',
        top: 10,
        right: 10,
        zIndex: 20,
        width: 320,
        maxHeight: 'calc(100% - 20px)',
        display: 'flex',
        flexDirection: 'column',
        backgroundColor: panelBg(scheme),
        backdropFilter: 'blur(8px)',
        ...transitionStyles,
        transform: `translate(${dragOffset.x}px, ${dragOffset.y}px) ${transitionStyles.transform ?? ''}`,
      }}
    >
      <Box
        {...dragHandleProps}
        style={{
          ...dragHandleProps.style,
          position: 'relative',
          display: 'flex',
          justifyContent: 'center',
          padding: '1px 0 2px',
          borderRadius: '8px 8px 0 0',
          background: accentEdge(scheme),
        }}
      >
        <IconGripHorizontal size={16} color="rgba(255,255,255,.85)" />
        <ActionIcon
          variant="transparent"
          size="xs"
          aria-label="Werkzeuge ausblenden"
          onPointerDown={(e) => e.stopPropagation()}
          onClick={() => hidePanel('mapTools')}
          style={{ position: 'absolute', right: 2, top: 1, color: 'rgba(255,255,255,.85)' }}
        >
          <IconX size={13} />
        </ActionIcon>
      </Box>
      <ToolboxControls />
    </Paper>
      )}
    </Transition>
  )
}
