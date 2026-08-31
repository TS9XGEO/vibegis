/** Camera readout, driven by Resium's useCesium hook rather than globals. */
import { useEffect, useState } from 'react'
import { Group, Paper, Text, useComputedColorScheme } from '@mantine/core'
import { Math as CesiumMath } from 'cesium'
import { useCesium } from 'resium'

import { panelBg } from './colorScheme'

function Readout() {
  const { scene } = useCesium()
  const [state, setState] = useState({ alt: '–', lat: '–', lon: '–' })

  useEffect(() => {
    if (!scene) return
    const camera = scene.camera
    camera.percentageChanged = 0.1

    const update = () => {
      const c = camera.positionCartographic
      setState({
        alt: c.height > 10000
          ? `${(c.height / 1000).toFixed(1)} km`
          : `${Math.round(c.height)} m`,
        lat: CesiumMath.toDegrees(c.latitude).toFixed(4),
        lon: CesiumMath.toDegrees(c.longitude).toFixed(4),
      })
    }

    update()
    const remove = camera.changed.addEventListener(update)
    return () => remove()
  }, [scene])

  return (
    <>
      <Group justify="space-between" gap="lg">
        <Text size="xs" c="dimmed">Höhe</Text>
        <Text size="xs" fw={600} c="teal.4">{state.alt}</Text>
      </Group>
      <Group justify="space-between" gap="lg">
        <Text size="xs" c="dimmed">Lat / Lon</Text>
        <Text size="xs" fw={600} c="teal.4">{state.lat} / {state.lon}</Text>
      </Group>
    </>
  )
}

export default function StatusHud() {
  const scheme = useComputedColorScheme('dark')
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
      <Readout />
    </Paper>
  )
}
