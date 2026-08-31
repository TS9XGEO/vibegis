/**
 * Switches the camera between orthographic and perspective projection based
 * on height. Cesium's perspective camera only renders truly undistorted
 * along its optical axis (screen center) — everything else gets radially
 * stretched, which is what turns round point symbols into ovals. Orthographic
 * removes that entirely, but a whole-globe view in orthographic looks like a
 * flat disc with no depth, so it's only used close in.
 */
import { useEffect, useRef } from 'react'
import { useCesium } from 'resium'

// Hysteresis band, not a single threshold: switching exactly at one height
// would flicker if the camera hovers near it (inertia, small pans). Ortho
// below ~18km (local/city-scale browsing, where round symbols must stay
// round), perspective above ~22km (regional/globe views, where perspective
// depth is what makes the globe read as a globe rather than a flat disc).
const ORTHO_ON_BELOW = 18000
const ORTHO_OFF_ABOVE = 22000

export default function AutoOrthographic() {
  const { scene } = useCesium()
  const isOrtho = useRef(false)

  useEffect(() => {
    if (!scene) return
    const camera = scene.camera
    camera.percentageChanged = 0.1

    const update = () => {
      const height = camera.positionCartographic.height
      if (!isOrtho.current && height < ORTHO_ON_BELOW) {
        camera.switchToOrthographicFrustum()
        isOrtho.current = true
      } else if (isOrtho.current && height > ORTHO_OFF_ABOVE) {
        camera.switchToPerspectiveFrustum()
        isOrtho.current = false
      }
    }

    update()
    const remove = camera.changed.addEventListener(update)
    return () => remove()
  }, [scene])

  return null
}
