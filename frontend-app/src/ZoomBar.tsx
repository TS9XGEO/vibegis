/**
 * Zoom-level readout. Cesium has no built-in "zoom level" (it's a free 3D
 * camera, not a slippy map) so this derives the equivalent WMTS/XYZ tile
 * zoom from camera height + FOV: the same ground-resolution formula that
 * defines what a tile pyramid's zoom levels mean (see mapproxy/mapproxy.yaml),
 * so the number lands in the same 0-20ish range those tiles use.
 */
import { useEffect, useState } from 'react'
import { Group, Paper, Progress, Text } from '@mantine/core'
import { PerspectiveFrustum, type Scene } from 'cesium'
import { useCesium } from 'resium'

const EARTH_CIRCUMFERENCE = 40075016.6856 // metres, at the equator
const MAX_ZOOM = 21

function computeZoomLevel(scene: Scene): number | null {
  const { camera } = scene
  const { frustum } = camera
  if (!(frustum instanceof PerspectiveFrustum) || frustum.fovy === undefined) return null

  const canvasHeight = scene.canvas.clientHeight
  if (!canvasHeight) return null

  const metersPerPixel = (2 * camera.positionCartographic.height * Math.tan(frustum.fovy / 2)) / canvasHeight
  return Math.log2(EARTH_CIRCUMFERENCE / (256 * metersPerPixel))
}

export default function ZoomBar() {
  const { scene } = useCesium()
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
        backgroundColor: 'rgba(20,22,28,0.92)',
        backdropFilter: 'blur(8px)',
      }}
    >
      <Group justify="space-between" gap="lg" mb={4}>
        <Text size="xs" c="dimmed">Zoom</Text>
        <Text size="xs" fw={600} c="blue.3">{zoom === null ? '–' : clamped.toFixed(1)}</Text>
      </Group>
      <Progress value={(clamped / MAX_ZOOM) * 100} size="sm" radius="xl" />
    </Paper>
  )
}
