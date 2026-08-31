/**
 * Live heading indicator + "reset to north" button. Docked in Sideband.tsx's
 * icon band rather than the floating HUD stack — a sibling of <Scene>, not a
 * descendant, so it reads `camera` from wms.ts's useApp store (the same
 * Cesium Camera object Scene.tsx already stashes there for exactly this)
 * rather than Resium's useCesium(), the same pattern LayerPanel.tsx already
 * uses for UI outside the Viewer tree. The needle rotates to always point at
 * true north; clicking animates heading back to 0 without moving the
 * camera's position or pitch.
 */
import { useEffect, useState } from 'react'
import { Tooltip, UnstyledButton } from '@mantine/core'
import { IconCompass } from '@tabler/icons-react'
import { Math as CesiumMath } from 'cesium'

import { useApp } from './wms'

export default function CompassButton() {
  const camera = useApp((s) => s.camera)
  const [headingDeg, setHeadingDeg] = useState(0)

  useEffect(() => {
    if (!camera) return
    camera.percentageChanged = 0.1

    const update = () => setHeadingDeg(CesiumMath.toDegrees(camera.heading))

    update()
    const remove = camera.changed.addEventListener(update)
    return () => remove()
  }, [camera])

  function resetNorth() {
    if (!camera) return
    camera.flyTo({
      destination: camera.position.clone(),
      orientation: { heading: 0, pitch: camera.pitch, roll: 0 },
      duration: 0.8,
    })
  }

  return (
    <Tooltip label="Nach Norden ausrichten" position="left" withArrow>
      <UnstyledButton
        aria-label="Nach Norden ausrichten"
        onClick={resetNorth}
        style={{
          width: 28,
          height: 28,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          borderRadius: 6,
          color: 'var(--mantine-color-teal-5)',
        }}
      >
        <IconCompass
          size={16}
          style={{ transform: `rotate(${-headingDeg}deg)`, transition: 'transform 0.15s linear' }}
        />
      </UnstyledButton>
    </Tooltip>
  )
}
