import { useEffect } from 'react'
import { Box } from '@mantine/core'

import LayerPanel from './LayerPanel'
import MapTools from './MapTools'
import Scene from './Scene'
import StatusHud from './StatusHud'
import ZoomBar from './ZoomBar'
import { useApp } from './wms'

export default function App() {
  const load = useApp((s) => s.load)
  const probeAssets = useApp((s) => s.probeAssets)

  useEffect(() => {
    load()
    probeAssets()
  }, [load, probeAssets])

  return (
    <Box style={{ display: 'flex', width: '100%', height: '100%' }}>
      <Box style={{ position: 'relative', flex: 1, height: '100%' }}>
        {/* MapTools, StatusHud and ZoomBar stay inside the Viewer so they
            can use Resium's useCesium() context directly. */}
        <Scene>
          <MapTools />
          <Box
            style={{
              position: 'absolute',
              bottom: 10,
              left: 10,
              zIndex: 20,
              display: 'flex',
              flexDirection: 'column',
              gap: 8,
            }}
          >
            <StatusHud />
            <ZoomBar />
          </Box>
        </Scene>
      </Box>

      {/* Docked sidebar, outside the Viewer tree — it reaches the camera via
          the store (Scene stashes it there) rather than useCesium(). */}
      <LayerPanel />
    </Box>
  )
}
