/**
 * The Cesium globe.
 *
 * Imagery order is expressed declaratively: Resium adds ImageryLayer children
 * in render order, so the LAST child ends up on top. The store keeps layers
 * top-first, so we render them reversed. Reordering the array is therefore all
 * it takes to reorder the map — no imperative raise/lower calls, which is
 * exactly the class of bug that made the hand-written version fragile.
 */
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import {
  Cartesian3,
  CesiumTerrainProvider,
  Color,
  EllipsoidTerrainProvider,
  GetFeatureInfoFormat,
  Math as CesiumMath,
  OpenStreetMapImageryProvider,
  WebMapServiceImageryProvider,
  type TerrainProvider,
} from 'cesium'
import { Cesium3DTileset, Fog, Globe, ImageryLayer, Viewer, useCesium } from 'resium'

/** Where the map opens. Change these three numbers to move home. */
const HOME = {
  lon: 11.5755,      // Marienplatz
  lat: 48.1374,
  height: 3500,      // metres above ground
  pitch: -35,        // degrees; negative looks down, 0 is horizontal
}

/**
 * Sets the opening view once, after Cesium is ready. Also hands the camera
 * to the store so the layer panel — a docked sidebar outside the Viewer tree
 * now, so it can't call useCesium() itself — can still fly to a layer's extent.
 */
function InitialView() {
  const { camera } = useCesium()
  const done = useRef(false)
  const setCamera = useApp((s) => s.setCamera)

  useEffect(() => {
    setCamera(camera ?? null)
  }, [camera, setCamera])

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

  return null
}

import { buildConditionsXml, buildFilterXml } from './filter'
import { buildSld, resolveLegend } from './legend'
import { cesiumContextOptions, webglSupport } from './webgl'
import { TERRAIN_URL, TILES3D_URL, WMS_URL, renderUrlFor, useApp } from './wms'

function WmsLayer({ name, alpha, show }: { name: string; alpha: number; show: boolean }) {
  const overrides = useApp((s) => s.styleOverrides[name])
  const layerFilter = useApp((s) => s.attributeFilters[name])
  const classification = useApp((s) => s.layerConfigs[name]?.classification)
  const geometryType = useApp((s) => s.dynamicGeometry[name])
  const legend = resolveLegend(name, classification, geometryType)
  const hasOverrides = !!overrides && Object.keys(overrides).length > 0
  const conditionsXml = layerFilter ? buildConditionsXml(layerFilter.conditions, layerFilter.logic) : null

  // MapServer rejects FILTER combined with SLD/SLD_BODY, so when the layer has
  // a legend config (i.e. we know how to reproduce its default styling) and
  // anything at all departs from the mapfile's own styling, everything goes
  // through one SLD: filterFor() ANDs/ORs conditionsXml into every rule, so the
  // filter still applies even when no class has actually been recolored.
  // Only layers with no legend entry fall back to the plain FILTER parameter.
  //
  // `classification` has to be one of the triggers. A user-defined
  // classification exists ONLY in layer_config.json — the mapfile still holds
  // the single default CLASS the layer was created with — so an SLD_BODY is the
  // only way it can reach the map. Leaving it out meant a saved classification
  // did nothing on its own and then appeared out of nowhere the moment a filter
  // or a recolor was added, and vanished again when that was removed.
  const departsFromMapfile = !!classification || hasOverrides || !!conditionsXml
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
        url: sldBody || filterXml ? WMS_URL : renderUrlFor(name),
        layers: name,
        parameters: {
          service: 'WMS',
          version: '1.3.0',
          format: 'image/png',
          transparent: true,
          styles: '',
          ...(sldBody ? { sld_body: sldBody } : {}),
          ...(filterXml ? { filter: filterXml } : {}),
        },
        enablePickFeatures: true,
        getFeatureInfoFormats: [
          new GetFeatureInfoFormat('json', 'application/json'),
          new GetFeatureInfoFormat('text', 'text/plain'),
        ],
      }),
    [name, sldBody, filterXml],
  )
  return <ImageryLayer imageryProvider={provider} alpha={alpha} show={show} />
}

const flatTerrain = new EllipsoidTerrainProvider()

/**
 * Shown instead of the Viewer when the browser can give us no WebGL context at
 * all. Constructing the Viewer anyway would throw asynchronously inside Resium,
 * which an error boundary cannot catch — the user would just get a black
 * rectangle and have to open the console to find out why.
 */
function NoWebGL() {
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        height: '100%',
        padding: 24,
        background: '#0f1115',
        color: '#c1c2c5',
        fontFamily: 'system-ui, sans-serif',
      }}
    >
      <div style={{ maxWidth: 460, lineHeight: 1.6 }}>
        <h2 style={{ margin: '0 0 12px', fontSize: 18 }}>Karte nicht darstellbar</h2>
        <p style={{ margin: '0 0 12px' }}>
          Dieser Browser stellt keinen WebGL-Kontext bereit, den Cesium für die
          3D-Ansicht benötigt.
        </p>
        <p style={{ margin: 0, fontSize: 13, color: '#909296' }}>
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
  const osmVisible = useApp((s) => s.osmVisible)
  const terrainOn = useApp((s) => s.terrainOn)
  const tilesOn = useApp((s) => s.tilesOn)
  const lighting = useApp((s) => s.lighting)

  const [terrain, setTerrain] = useState<TerrainProvider>(flatTerrain)

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
      homeButton
      sceneModePicker
      navigationHelpButton={false}
      timeline={false}
      animation={false}
      infoBox
      selectionIndicator
    >
      <InitialView />

      {/* terrainProvider lives on Globe, not Viewer: Resium only applies
          Viewer's terrainProvider once at construction, but Globe's has a
          live update handler that reassigns it whenever the prop changes. */}
      <Globe
        terrainProvider={terrain}
        enableLighting={lighting}
        depthTestAgainstTerrain
        baseColor={Color.fromCssColorString('#1b2c40')}
      />
      <Fog enabled />

      {/* Basemap first => bottom of the stack, always. */}
      <ImageryLayer imageryProvider={osmProvider} show={osmVisible} />

      {/* Store is top-first; Cesium draws last-added on top. */}
      {layers
        .slice()
        .reverse()
        .map((l) => (
          <WmsLayer key={l.name} name={l.name} alpha={l.opacity} show={l.visible} />
        ))}

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
