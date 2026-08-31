/**
 * Renders one point layer as real Cesium entities instead of a WMS raster
 * tile, so Cesium's own EntityCluster can group overlapping points into an
 * "N points here" marker at low zoom and split them apart again on zoom-in.
 * Mounted per clustered layer from Scene.tsx, in place of that layer's
 * <WmsLayer> — see wms.ts's LayerState.clustered for why this is opt-in.
 *
 * Needs `viewer` for dataSources, which (unlike `camera`) isn't stashed in
 * the store, so this has to live inside <Viewer> and use useCesium() itself,
 * the same convention SelectionHighlight.tsx follows.
 */
import { useEffect, useRef } from 'react'
import { Color, CustomDataSource, Cartesian3, Math as CesiumMath } from 'cesium'
import { useCesium } from 'resium'

import { fetchFeaturesInBbox } from './features'
import { useApp } from './wms'

// Amber, not teal: teal already means "this control is on/active" throughout
// the layer panel, so an unclustered point uses the app's other accent color
// (see colorScheme.ts's accentEdge()) to read as "map content", not "UI toggle".
const CLUSTER_COLOR = Color.fromCssColorString('#f59f00')
const POINT_COLOR = Color.fromCssColorString('#0d9488')

// Same pixel-change threshold used by every other camera.changed listener in
// this app (ZoomBar, StatusHud, CompassButton, AutoOrthographic) — enough to
// avoid refetching on sub-pixel jitter, not so much that a real pan/zoom is missed.
const CAMERA_PERCENTAGE_CHANGED = 0.1

function eachPoint(geometry: GeoJSON.Geometry, cb: (lon: number, lat: number) => void): void {
  if (geometry.type === 'Point') cb(geometry.coordinates[0], geometry.coordinates[1])
  else if (geometry.type === 'MultiPoint') geometry.coordinates.forEach((c) => cb(c[0], c[1]))
}

export default function ClusteredPointLayer({
  name,
  collection,
  show,
}: {
  name: string
  collection: string
  show: boolean
}) {
  const { viewer, camera } = useCesium()
  const dataSourceRef = useRef<CustomDataSource | null>(null)
  const setClusterTruncated = useApp((s) => s.setClusterTruncated)

  useEffect(() => {
    if (!viewer) return
    const dataSource = new CustomDataSource(name)
    dataSourceRef.current = dataSource
    viewer.dataSources.add(dataSource)

    dataSource.clustering.enabled = true
    dataSource.clustering.pixelRange = 60
    dataSource.clustering.minimumClusterSize = 3
    // Default cluster billboard is a stock pin; swap it for a plain amber dot
    // sized a bit larger than a single point, plus the count as a label —
    // matches this layer's own unclustered dots (POINT_COLOR) in spirit, not
    // the classified layer's real per-class colors (see plan's "out of scope").
    const removeClusterEvent = dataSource.clustering.clusterEvent.addEventListener((entities, cluster) => {
      cluster.billboard.show = false
      cluster.label.show = true
      cluster.label.text = String(entities.length)
      cluster.point.show = true
      cluster.point.color = CLUSTER_COLOR
      cluster.point.pixelSize = 22
    })

    return () => {
      removeClusterEvent()
      viewer.dataSources.remove(dataSource, true)
      dataSourceRef.current = null
      setClusterTruncated(name, false)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [viewer, name])

  useEffect(() => {
    if (dataSourceRef.current) dataSourceRef.current.show = show
  }, [show])

  useEffect(() => {
    if (!viewer || !camera) return
    let controller: AbortController | null = null

    const refresh = () => {
      const dataSource = dataSourceRef.current
      if (!dataSource) return
      const rect = camera.computeViewRectangle()
      // Camera not looking at the globe (mid-rotation) — leave the current
      // markers in place rather than clearing them for no reason.
      if (!rect) return
      const bbox = {
        west: CesiumMath.toDegrees(rect.west),
        south: CesiumMath.toDegrees(rect.south),
        east: CesiumMath.toDegrees(rect.east),
        north: CesiumMath.toDegrees(rect.north),
      }
      controller?.abort()
      controller = new AbortController()
      fetchFeaturesInBbox(collection, bbox, controller.signal)
        .then(({ features, truncated: t }) => {
          dataSource.entities.removeAll()
          for (const f of features) {
            if (!f.geometry) continue
            eachPoint(f.geometry, (lon, lat) => {
              dataSource.entities.add({
                position: Cartesian3.fromDegrees(lon, lat),
                point: { pixelSize: 10, color: POINT_COLOR },
              })
            })
          }
          setClusterTruncated(name, t)
        })
        .catch((e) => {
          if (controller?.signal.aborted) return
          console.warn(`Punkte für "${name}" nicht ladbar:`, e)
        })
    }

    camera.percentageChanged = CAMERA_PERCENTAGE_CHANGED
    refresh()
    const remove = camera.changed.addEventListener(refresh)
    return () => {
      remove()
      controller?.abort()
    }
  }, [viewer, camera, collection, name, setClusterTruncated])

  return null
}
