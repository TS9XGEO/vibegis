/**
 * Zoom-level readout. Cesium has no built-in "zoom level" (it's a free 3D
 * camera, not a slippy map) so this derives the equivalent WMTS/XYZ tile
 * zoom from camera height + FOV: the same ground-resolution formula that
 * defines what a tile pyramid's zoom levels mean (see mapproxy/mapproxy.yaml),
 * so the number lands in the same 0-20ish range those tiles use.
 */
import { useEffect, useState } from 'react'
import { Group, Paper, Progress, Text, useComputedColorScheme } from '@mantine/core'
import { BoundingSphere, Cartesian3, type Scene } from 'cesium'
import { useCesium } from 'resium'

import { panelBg } from './colorScheme'

const EARTH_CIRCUMFERENCE = 40075016.6856 // metres, at the equator
const MAX_ZOOM = 21

/**
 * getPixelSize() delegates to whichever frustum is actually active, unlike
 * the old height * tan(fovy/2) formula this replaced — that one only made
 * sense for a PerspectiveFrustum and returned null under the Orthographic one
 * AutoOrthographic switches to on close-in zoom, which is why the zoom
 * readout used to go blank (and stop responding to zooming) below ~18km.
 */
function computeZoomLevel(scene: Scene): number | null {
  const { camera } = scene
  const canvasWidth = scene.canvas.clientWidth
  const canvasHeight = scene.canvas.clientHeight
  if (!canvasWidth || !canvasHeight) return null

  const carto = camera.positionCartographic
  const groundPoint = Cartesian3.fromRadians(carto.longitude, carto.latitude, 0)
  const metersPerPixel = camera.getPixelSize(new BoundingSphere(groundPoint, 0), canvasWidth, canvasHeight)
  if (!metersPerPixel || !isFinite(metersPerPixel)) return null
  return Math.log2(EARTH_CIRCUMFERENCE / (256 * metersPerPixel))
}

export default function ZoomBar() {
  const { scene } = useCesium()
  const scheme = useComputedColorScheme('dark')
  const [zoom, setZoom] = useState<number | null>(null)

  useEffect(() => {
    if (!scene) return
    const camera = scene.camera
    camera.percentageChanged = 0.1

    const update = () => setZoom(computeZoomLevel(scene))

    update()
    const remove = camera.changed.addEventListener(update)
    return () => remove()
  }, [scene])

  const clamped = zoom === null ? 0 : Math.min(Math.max(zoom, 0), MAX_ZOOM)

  return (
    <Paper
      withBorder
      radius="md"
      px="sm"
      py={8}
      style={{
        minWidth: 190,
        backgroundColor: panelBg(scheme),
        backdropFilter: 'blur(8px)',
      }}
    >
      <Group justify="space-between" gap="lg" mb={4}>
        <Text size="xs" c="dimmed">Zoom</Text>
        <Text size="xs" fw={600} c="teal.4">{zoom === null ? '–' : clamped.toFixed(1)}</Text>
      </Group>
      <Progress value={(clamped / MAX_ZOOM) * 100} size="sm" radius="xl" />
    </Paper>
  )
}
