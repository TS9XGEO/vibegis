/**
 * The Cesium globe.
 *
 * Imagery order is expressed declaratively: Resium adds ImageryLayer children
 * in render order, so the LAST child ends up on top. The store keeps layers
 * top-first, so we render them reversed. Reordering the array is therefore all
 * it takes to reorder the map — no imperative raise/lower calls, which is
 * exactly the class of bug that made the hand-written version fragile.
 */
import { forwardRef, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { useComputedColorScheme } from '@mantine/core'
import {
  Cartesian3,
  CesiumTerrainProvider,
  Color,
  EllipsoidTerrainProvider,
  GetFeatureInfoFormat,
  type ImageryLayer as CesiumImageryLayer,
  Math as CesiumMath,
  OpenStreetMapImageryProvider,
  WebMapServiceImageryProvider,
  type TerrainProvider,
} from 'cesium'
import { Cesium3DTileset, Fog, Globe, ImageryLayer, Viewer, useCesium } from 'resium'

import AutoOrthographic from './AutoOrthographic'
import DashboardHighlight from './DashboardHighlight'
import ClusteredPointLayer from './PointCluster'
import PointCloudLayer from './PointCloudLayer'
import SelectionHighlight from './SelectionHighlight'

/** Where the map opens. Change these three numbers to move home. */
const HOME = {
  lon: 11.5755,      // Marienplatz
  lat: 48.1374,
  height: 3500,      // metres above ground
  pitch: -90,        // degrees; negative looks down, 0 is horizontal, -90 is straight down
}

/** Tilting down past this (towards the horizon) is disallowed — straight
 * down (pitch -90°) is always fine, this only floors how shallow/horizontal
 * the view can get. 30 = can't tilt closer to the horizon than a 30°
 * look-down angle; raise towards 90 to allow flatter views, lower towards 0
 * to force a closer-to-nadir view at all times.
 *
 * Enforced only while the store's `tiltLimited` is set — LayerPanel.tsx has a
 * switch for it, and a visible point cloud releases it automatically (see
 * below), since 3D geometry can only be read by orbiting it from the side. */
const MIN_TILT_DEG = 30

/**
 * Sets the opening view once, after Cesium is ready. Also hands the camera
 * to the store so the layer panel — a docked sidebar outside the Viewer tree
 * now, so it can't call useCesium() itself — can still fly to a layer's extent.
 */
function InitialView() {
  const { camera, scene } = useCesium()
  const done = useRef(false)
  const setCamera = useApp((s) => s.setCamera)
  const setScene = useApp((s) => s.setScene)
  const tiltLimited = useApp((s) => s.tiltLimited)
  const setTiltLimited = useApp((s) => s.setTiltLimited)
  const pointCloudVisible = useApp((s) => s.layers.some((l) => l.pointCloud && l.visible))

  useEffect(() => {
    setCamera(camera ?? null)
  }, [camera, setCamera])

  useEffect(() => {
    setScene(scene ?? null)
  }, [scene, setScene])

  useEffect(() => {
    if (!camera || done.current) return
    done.current = true
    camera.setView({
      destination: Cartesian3.fromDegrees(HOME.lon, HOME.lat, HOME.height),
      orientation: {
        heading: 0,
        pitch: CesiumMath.toRadians(HOME.pitch),
        roll: 0,
      },
    })
  }, [camera])

  // Showing a point cloud releases the tilt limit; hiding the last one puts
  // it back. Driven off the *transition*, not off `pointCloudVisible`
  // directly, which is what leaves the manual switch usable in between: turn
  // the limit back on with a cloud still showing and it stays on, because no
  // edge has occurred since. A plain derived value would instead fight the
  // user, silently reverting the switch on the next render.
  const hadPointCloud = useRef(pointCloudVisible)
  useEffect(() => {
    if (pointCloudVisible === hadPointCloud.current) return
    hadPointCloud.current = pointCloudVisible
    setTiltLimited(!pointCloudVisible)
  }, [pointCloudVisible, setTiltLimited])

  // Floors how shallow a tilt the mouse/touch drag (Cesium's own
  // ScreenSpaceCameraController — it has no built-in min/max pitch of its
  // own) can reach — see MIN_TILT_DEG. Checked every frame via preRender
  // rather than camera.changed, which only fires past a percentage-of-view
  // threshold (CompassButton.tsx sets that to 0.1 for its own heading
  // readout) and would let a fast drag overshoot well past the limit before
  // snapping back.
  //
  // Restores the *entire* last valid camera (position included, not just
  // pitch): Cesium's tilt drag orbits the camera around a ground pivot, so
  // it moves position too, not pitch alone — fixing pitch back in place
  // every frame while leaving that frame's position change in effect still
  // let the camera visibly creep/pan while "stuck" at the limit. Snapping
  // the whole camera back to the last frame that was still within bounds
  // makes hitting the limit inert instead: further drag past it does
  // nothing at all until the user drags back the other way.
  const lastGood = useRef<{ position: Cartesian3; heading: number; pitch: number; roll: number } | null>(null)
  useEffect(() => {
    // Off entirely while the limit is released (a point cloud is showing, or
    // the user asked for free tilt) — the listener is not registered at all
    // rather than early-returning inside it, so nothing runs per frame.
    if (!camera || !scene || !tiltLimited) return
    const maxPitch = CesiumMath.toRadians(-MIN_TILT_DEG)
    // Anything remembered from before the limit was lifted is stale: the
    // camera has very likely been flown somewhere else in the meantime, and
    // restoring that position would teleport the view.
    lastGood.current = null
    const clamp = () => {
      if (camera.pitch <= maxPitch) {
        lastGood.current = {
          position: Cartesian3.clone(camera.position),
          heading: camera.heading,
          pitch: camera.pitch,
          roll: camera.roll,
        }
        return
      }
      const last = lastGood.current
      if (last) {
        camera.setView({
          destination: last.position,
          orientation: { heading: last.heading, pitch: last.pitch, roll: last.roll },
        })
      } else {
        // Re-enabling the limit while already tilted past it: there is no
        // valid frame to fall back to, so tilt back up to exactly the limit
        // and keep the position. Without this the first frame would record
        // an out-of-bounds camera as "last good" and the view would stay
        // stuck below the floor it was just asked to respect.
        camera.setView({
          orientation: { heading: camera.heading, pitch: maxPitch, roll: camera.roll },
        })
      }
    }
    scene.preRender.addEventListener(clamp)
    return () => {
      scene.preRender.removeEventListener(clamp)
    }
  }, [camera, scene, tiltLimited])

  return null
}

import { buildConditionsXml, buildFilterXml } from './filter'
import { buildSld, resolveLegend } from './legend'
import { cesiumContextOptions, webglSupport } from './webgl'
import { TERRAIN_URL, TILES3D_URL, WMS_URL, collectionFor, renderUrlFor, useApp } from './wms'

/**
 * Forwards its ref down to the underlying <ImageryLayer>, so CesiumScene can
 * read out the real Cesium ImageryLayer instance once it's mounted (see
 * ImageryOrder below — reordering the store array alone doesn't reorder
 * already-mounted layers, only where a *newly created* one lands).
 */
const WmsLayer = forwardRef<{ cesiumElement?: CesiumImageryLayer }, { name: string; alpha: number; show: boolean }>(
  function WmsLayer({ name, alpha, show }, ref) {
  const overrides = useApp((s) => s.styleOverrides[name])
  const layerFilter = useApp((s) => s.attributeFilters[name])
  const classification = useApp((s) => s.layerConfigs[name]?.classification)
  const outlineWidth = useApp((s) => s.layerConfigs[name]?.outlineWidth)
  const styleVersion = useApp((s) => s.layerConfigs[name]?.styleVersion ?? 0)
  const managedLayers = useApp((s) => s.managedLayers)
  const geometryType = useApp((s) => s.dynamicGeometry[name])
  const legend = resolveLegend(name, classification, geometryType, outlineWidth)
  const hasOverrides = !!overrides && Object.keys(overrides).length > 0
  const conditionsXml = layerFilter ? buildConditionsXml(layerFilter.conditions, layerFilter.logic) : null

  // MapServer rejects FILTER combined with SLD/SLD_BODY, so when the layer has
  // a legend config (i.e. we know how to reproduce its default styling) and
  // anything at all departs from the mapfile's own styling, everything goes
  // through one SLD: filterFor() ANDs/ORs conditionsXml into every rule, so the
  // filter still applies even when no class has actually been recolored.
  // Only layers with no legend entry fall back to the plain FILTER parameter.
  //
  // `classification` is deliberately NOT a trigger any more, and re-adding it
  // would silently make every classified layer uncacheable again.
  //
  // It used to be one, and had to be: a classification existed only in
  // layer_config.json while the mapfile held the single default CLASS, so an
  // SLD_BODY was the only way it could reach the map. Leaving it out back then
  // meant a saved classification did nothing on its own, appeared the moment a
  // filter or recolor was added, and vanished again when that was removed.
  //
  // upload-api now compiles a classification into real CLASS blocks in
  // uploads.map (see apply_layer_style there), so it is the layer's own default
  // styling and needs no per-request SLD. That is the whole point: MapProxy
  // pins one fixed upstream request per layer, so anything carried per-request
  // — SLD_BODY or FILTER — cannot be served from the tile cache.
  const departsFromMapfile = hasOverrides || !!conditionsXml
  const sldBody = legend && departsFromMapfile
    ? buildSld(name, legend, overrides ?? {}, layerFilter?.conditions ?? null, layerFilter?.logic ?? 'and')
    : null
  const filterXml = !sldBody && conditionsXml && layerFilter
    ? buildFilterXml(layerFilter.conditions, layerFilter.logic)
    : null

  const provider = useMemo(
    () =>
      new WebMapServiceImageryProvider({
        // Cached layers come from MapProxy, the rest straight from MapServer.
        // MapProxy pins a fixed request per layer and caches by bbox/size
        // alone, so it can't carry a per-user SLD_BODY or FILTER — a
        // recolored or filtered layer is routed straight to MapServer
        // instead, trading the cache for per-user styling/filtering.
        url: sldBody || filterXml ? WMS_URL : renderUrlFor(name, managedLayers),
        layers: name,
        parameters: {
          service: 'WMS',
          version: '1.3.0',
          format: 'image/png',
          transparent: true,
          styles: '',
          // Cache-buster, not something any server reads. The styling now
          // lives server-side, so a restyle changes no other request
          // parameter — without this the URL is identical and Cesium keeps
          // painting the tiles it already holds. upload-api drops the
          // server-side tiles at the same time it bumps this.
          v: styleVersion,
          ...(sldBody ? { sld_body: sldBody } : {}),
          ...(filterXml ? { filter: filterXml } : {}),
        },
        enablePickFeatures: true,
        getFeatureInfoFormats: [
          new GetFeatureInfoFormat('json', 'application/json'),
          new GetFeatureInfoFormat('text', 'text/plain'),
        ],
      }),
    [name, sldBody, filterXml, styleVersion, managedLayers],
  )
  // A GetMap that MapServer rejects looks exactly like a filter that matched
  // nothing: Cesium draws no tile and says nothing. Given how much of this stack
  // reports failure with HTTP 200 — an error page from MapServer, an empty list
  // from /layers — the request that failed is worth naming.
  //
  // Console only, deliberately. Cesium retries tiles, so errorEvent also fires
  // for transient failures that resolve on their own; promoting those to a
  // banner would cry wolf. The layer name and message are what make a silent
  // blank layer diagnosable.
  useEffect(() => {
    return provider.errorEvent.addEventListener((err: { message?: string }) => {
      console.warn(`GetMap fehlgeschlagen für "${name}":`, err?.message ?? err)
    })
  }, [provider, name])

  return <ImageryLayer ref={ref} imageryProvider={provider} alpha={alpha} show={show} />
  },
)

/**
 * Enforces the store's layer order on the real Cesium ImageryLayerCollection.
 * WmsLayer's <ImageryLayer> only picks a position when it's first created —
 * Resium has no reactive "index" that moves an already-mounted layer, so
 * dragging a row in the layer panel changed `layers[]` but not what actually
 * drew on top. raiseToTop() moves a layer above everything currently in the
 * collection, so walking bottom-to-top (the store is top-first) and raising
 * each one in turn reproduces the store order exactly, no matter what order
 * they were originally added in.
 */
function ImageryOrder({
  order,
  refs,
  readyTick,
}: {
  order: string[]
  refs: { current: Map<string, CesiumImageryLayer> }
  readyTick: number
}) {
  const { viewer } = useCesium()
  useEffect(() => {
    if (!viewer) return
    for (const name of [...order].reverse()) {
      const layer = refs.current.get(name)
      if (layer && !layer.isDestroyed()) viewer.imageryLayers.raiseToTop(layer)
    }
    // readyTick isn't read in the body — it only exists so this reruns once a
    // layer still loading its provider when the order last changed registers.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [viewer, order.join(' '), readyTick])
  return null
}

const flatTerrain = new EllipsoidTerrainProvider()

/**
 * Shown instead of the Viewer when the browser can give us no WebGL context at
 * all. Constructing the Viewer anyway would throw asynchronously inside Resium,
 * which an error boundary cannot catch — the user would just get a black
 * rectangle and have to open the console to find out why.
 */
function NoWebGL() {
  const scheme = useComputedColorScheme('dark')
  const bg = scheme === 'dark' ? '#0f1115' : '#f8f9fa'
  const text = scheme === 'dark' ? '#c1c2c5' : '#343a40'
  const dimmed = scheme === 'dark' ? '#909296' : '#868e96'
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        height: '100%',
        padding: 24,
        background: bg,
        color: text,
        fontFamily: 'system-ui, sans-serif',
      }}
    >
      <div style={{ maxWidth: 460, lineHeight: 1.6 }}>
        <h2 style={{ margin: '0 0 12px', fontSize: 18 }}>Karte nicht darstellbar</h2>
        <p style={{ margin: '0 0 12px' }}>
          Dieser Browser stellt keinen WebGL-Kontext bereit, den Cesium für die
          3D-Ansicht benötigt.
        </p>
        <p style={{ margin: 0, fontSize: 13, color: dimmed }}>
          In Firefox: <code>about:config</code> → <code>webgl.disabled</code> auf{' '}
          <code>false</code> und <code>webgl.enable-webgl2</code> auf <code>true</code>.
          Hilft das nicht, ist meist der Grafiktreiber auf der Blockliste des
          Browsers — ein Treiber-Update oder ein anderer Browser löst es.
        </p>
      </div>
    </div>
  )
}

/**
 * Hook-free wrapper, so the "no WebGL at all" branch never sits above a hook
 * call. Everything below this point can assume a context is obtainable.
 */
export default function Scene({ children }: { children?: ReactNode }) {
  if (webglSupport === 'none') return <NoWebGL />
  return <CesiumScene>{children}</CesiumScene>
}

function CesiumScene({ children }: { children?: ReactNode }) {
  const layers = useApp((s) => s.layers)
  const dynamicCollections = useApp((s) => s.dynamicCollections)
  const osmVisible = useApp((s) => s.osmVisible)
  const terrainOn = useApp((s) => s.terrainOn)
  const tilesOn = useApp((s) => s.tilesOn)
  const lighting = useApp((s) => s.lighting)

  const [terrain, setTerrain] = useState<TerrainProvider>(flatTerrain)

  // Registers each WmsLayer's real Cesium ImageryLayer as it mounts, so
  // ImageryOrder can raise them in the store's order. A plain ref, not state
  // — mutating it must not itself cause a render; `readyTick` below is what
  // tells ImageryOrder a new one has shown up.
  const layerRefs = useRef(new Map<string, CesiumImageryLayer>())
  const refSetters = useRef(new Map<string, (el: { cesiumElement?: CesiumImageryLayer } | null) => void>())
  const [readyTick, setReadyTick] = useState(0)
  const getRefSetter = (name: string) => {
    let fn = refSetters.current.get(name)
    if (!fn) {
      fn = (el) => {
        if (el?.cesiumElement) {
          layerRefs.current.set(name, el.cesiumElement)
          setReadyTick((t) => t + 1)
        } else {
          layerRefs.current.delete(name)
        }
      }
      refSetters.current.set(name, fn)
    }
    return fn
  }

  const osmProvider = useMemo(
    () => new OpenStreetMapImageryProvider({ url: 'https://tile.openstreetmap.org/' }),
    [],
  )

  // Terrain loads lazily, and only when asked for. Swapping the provider
  // rebuilds the globe surface, so we never do it speculatively.
  useEffect(() => {
    let cancelled = false
    if (!terrainOn) {
      setTerrain(flatTerrain)
      return
    }
    CesiumTerrainProvider.fromUrl(TERRAIN_URL, { requestVertexNormals: true })
      .then((p) => { if (!cancelled) setTerrain(p) })
      .catch((e) => {
        console.warn('Terrain nicht ladbar:', e)
        if (!cancelled) setTerrain(flatTerrain)
      })
    return () => { cancelled = true }
  }, [terrainOn])

  return (
    <Viewer
      full
      // Cesium asks for a WebGL2 context by default and throws instead of
      // falling back, which is what made the globe fail to construct in
      // Firefox wherever WebGL2 is blocked. See webgl.ts.
      contextOptions={cesiumContextOptions}
      baseLayer={false}
      baseLayerPicker={false}
      geocoder={false}
      // Cesium's own default toolbar/info-box widgets are unstyled and pin
      // themselves to the same top-right corner as MapTools.tsx's search/
      // measure panel — every other default widget here is disabled for the
      // same reason (this app's UI is fully custom-built, not native Cesium
      // chrome). infoBox/selectionIndicator are unused too: identify results
      // render through MapTools' own React table, never Cesium's picking UI.
      homeButton={false}
      sceneModePicker={false}
      navigationHelpButton={false}
      timeline={false}
      animation={false}
      infoBox={false}
      selectionIndicator={false}
    >
      <InitialView />
      <AutoOrthographic />
      <SelectionHighlight />
      <DashboardHighlight />

      {/* terrainProvider lives on Globe, not Viewer: Resium only applies
          Viewer's terrainProvider once at construction, but Globe's has a
          live update handler that reassigns it whenever the prop changes. */}
      <Globe
        terrainProvider={terrain}
        enableLighting={lighting}
        depthTestAgainstTerrain
        baseColor={Color.WHITE}
      />
      <Fog enabled />

      {/* Basemap first => bottom of the stack, always. */}
      <ImageryLayer imageryProvider={osmProvider} show={osmVisible} />

      {/* Store is top-first; Cesium draws last-added on top. Only true for
          the order layers were first created in, though — ImageryOrder is
          what keeps it true after a drag-and-drop reorder. */}
      {layers
        .slice()
        .reverse()
        .map((l) => {
          // Point clouds first: they are 3D Tiles scene primitives, not
          // imagery, so neither the clustering branch nor WmsLayer applies.
          if (l.pointCloud) return <PointCloudLayer key={l.name} layer={l} />
          const collection = l.clustered ? collectionFor(l.name, dynamicCollections) : undefined
          return collection ? (
            <ClusteredPointLayer key={l.name} name={l.name} collection={collection} show={l.visible} />
          ) : (
            <WmsLayer key={l.name} name={l.name} alpha={l.opacity} show={l.visible} ref={getRefSetter(l.name)} />
          )
        })}
      <ImageryOrder order={layers.map((l) => l.name)} refs={layerRefs} readyTick={readyTick} />

      {/* Resium builds and owns the tileset itself from `url` — there is no
          prop to hand it a pre-built instance, so mount/unmount is what
          drives loading rather than toggling a manually-created object. */}
      {tilesOn && (
        <Cesium3DTileset
          url={TILES3D_URL}
          maximumScreenSpaceError={16}
          onError={(e) => console.info('Keine 3D Tiles:', e)}
        />
      )}

      {/* UI lives inside the Viewer so it can use Resium's useCesium() hook. */}
      {children}
    </Viewer>
  )
}
