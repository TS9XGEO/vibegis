/**
 * Live heading indicator + "reset to north" button. Docked in Sideband.tsx's
 * icon band rather than the floating HUD stack — a sibling of <Scene>, not a
 * descendant, so it reads `camera` from wms.ts's useApp store (the same
 * Cesium Camera object Scene.tsx already stashes there for exactly this)
 * rather than Resium's useCesium(), the same pattern LayerPanel.tsx already
 * uses for UI outside the Viewer tree. The needle rotates to always point at
 * true north; clicking animates heading back to 0 without moving the
 * camera's position.
 *
 * The same click also levels the camera back to nadir (straight down).
 * Deliberately unconditional: this used to be gated on the tilt limit being
 * released, which made the button's behaviour depend on a switch most of the
 * time set the other way — so in the app's default state it silently did
 * nothing to the pitch, which is not a "reset" in any useful sense. Nadir is
 * always within the tilt clamp's bounds (the clamp only rejects pitch
 * *shallower* than MIN_TILT_DEG), so this never fights it.
 */
import { useEffect, useState } from 'react'
import { Tooltip, UnstyledButton, rem } from '@mantine/core'
import { IconCompass } from '@tabler/icons-react'
import { Math as CesiumMath } from 'cesium'
import { useTranslation } from 'react-i18next'

import { TourTarget } from './tour/TourTarget'
import { useApp } from './wms'

/** Straight down — the same plan view Scene.tsx's HOME opens on. */
const NADIR_PITCH_DEG = -90

export default function CompassButton() {
  const { t } = useTranslation()
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
      orientation: { heading: 0, pitch: CesiumMath.toRadians(NADIR_PITCH_DEG), roll: 0 },
      duration: 0.8,
    })
  }

  return (
    <Tooltip label={t('compass.resetNorthAndNadir')} position="left" withArrow>
      <TourTarget id="compass-btn">
        <UnstyledButton
          aria-label={t('compass.resetNorthAndNadir')}
          onClick={resetNorth}
          style={{
            width: rem(28),
            height: rem(28),
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
      </TourTarget>
    </Tooltip>
  )
}
