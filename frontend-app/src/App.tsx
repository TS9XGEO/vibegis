import { useEffect, useRef, useState } from 'react'
import { ActionIcon, Box, Text, Transition, useComputedColorScheme } from '@mantine/core'
import { IconGripHorizontal, IconMoonStars, IconUpload, IconX } from '@tabler/icons-react'

import AuthSplash from './AuthSplash'
import { accentEdge } from './colorScheme'
import ConnectedGlobe from './ConnectedGlobe'
import DataViewBand from './DataViewBand'
import LayerPanel from './LayerPanel'
import LoginScreen from './LoginScreen'
import MapTools from './MapTools'
import { usePanels } from './panels'
import Scene from './Scene'
import Sideband from './Sideband'
import StatusHud from './StatusHud'
import { ACCEPT } from './UploadLayer'
import { useDraggable } from './useDraggable'
import { useUpload } from './uploadState'
import ZoomBar from './ZoomBar'
import { useAuth } from './auth'
import { useApp } from './wms'

const ACCEPT_EXTENSIONS = ACCEPT.split(',')

function hasAcceptedExtension(name: string): boolean {
  const lower = name.toLowerCase()
  return ACCEPT_EXTENSIONS.some((ext) => lower.endsWith(ext))
}

export default function App() {
  const scheme = useComputedColorScheme('dark')
  const { offset: hudOffset, handleProps: hudHandleProps } = useDraggable()
  const hudOpen = usePanels((s) => s.open.hud)
  const hidePanel = usePanels((s) => s.hide)
  const load = useApp((s) => s.load)
  const probeAssets = useApp((s) => s.probeAssets)
  const user = useAuth((s) => s.user)
  const authLoading = useAuth((s) => s.loading)
  const fetchMe = useAuth((s) => s.fetchMe)
  const farewell = useAuth((s) => s.farewell)
  const clearFarewell = useAuth((s) => s.clearFarewell)
  const openUploadWithFile = useUpload((s) => s.openWithFile)

  // Shows the welcome splash exactly once per session, whether the user just
  // typed their password or an existing cookie logged them in on load.
  const [welcoming, setWelcoming] = useState(false)
  const welcomed = useRef(false)
  const [dragOver, setDragOver] = useState(false)

  // Dropping a geodata file onto the map opens the same "Layer hinzufügen"
  // form the header button does, pre-filled — see UploadLayer.tsx's
  // FilePanel and uploadState.ts. Only reacts to a real file drag (checked
  // via dataTransfer.types) so it doesn't interfere with in-app drags like
  // the layer panel's dnd-kit reordering.
  function handleDragOver(e: React.DragEvent) {
    if (!e.dataTransfer.types.includes('Files')) return
    e.preventDefault()
    setDragOver(true)
  }
  function handleDragLeave() {
    setDragOver(false)
  }
  function handleDrop(e: React.DragEvent) {
    if (!e.dataTransfer.types.includes('Files')) return
    e.preventDefault()
    setDragOver(false)
    const file = e.dataTransfer.files[0]
    if (file && hasAcceptedExtension(file.name)) openUploadWithFile(file)
  }

  useEffect(() => {
    fetchMe()
  }, [fetchMe])

  useEffect(() => {
    // Would 401 before login anyway — wait for a session before asking.
    if (!user) return
    load()
    probeAssets()
  }, [user, load, probeAssets])

  useEffect(() => {
    if (user && !welcomed.current) {
      welcomed.current = true
      setWelcoming(true)
    }
    if (!user) welcomed.current = false
  }, [user])

  if (authLoading) return null

  if (farewell) {
    return (
      <AuthSplash
        icon={<IconMoonStars size={64} stroke={1.4} />}
        title={`Bis bald, ${farewell}!`}
        subtitle="Du wurdest abgemeldet."
        onDone={clearFarewell}
      />
    )
  }

  if (!user) return <LoginScreen />

  if (welcoming) {
    return (
      <AuthSplash
        icon={<ConnectedGlobe size={64} />}
        title={`Willkommen, ${user.username}!`}
        subtitle="Die Karte wird geladen…"
        onDone={() => setWelcoming(false)}
      />
    )
  }

  return (
    <Box style={{ display: 'flex', width: '100%', height: '100%' }}>
      {/* Column, not just a single relative Box: the data view band below
          is a real flex sibling of the map now (see DataViewBand.tsx), so
          opening it shrinks the map's own share of this column instead of
          floating over it. minHeight: 0 is required for the map to actually
          be allowed to shrink below its content's intrinsic size; minWidth: 0
          is the same fix for the horizontal axis — a wide attribute table
          (many columns) otherwise forces this whole column past its own
          flex-basis, and with nothing to its right clipping the overflow,
          that pushed the docked layer panel off past the viewport edge
          (clipped invisible by index.html's `overflow: hidden` on #root)
          whenever a wide table opened. */}
      <Box style={{ display: 'flex', flexDirection: 'column', flex: 1, minWidth: 0, height: '100%' }}>
      <Box
        style={{ position: 'relative', flex: 1, minHeight: 0 }}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
      >
        {/* MapTools, StatusHud and ZoomBar stay inside the Viewer so they can
            use Resium's useCesium() context directly. CompassButton moved to
            Sideband.tsx's icon band — it reads `camera` from the store
            instead, so it doesn't need to live in here any more. */}
        <Scene>
          <MapTools />
          <Transition mounted={hudOpen} transition="fade" duration={180} timingFunction="ease">
            {(transitionStyles) => (
              <Box
                style={{
                  position: 'absolute',
                  bottom: 10,
                  left: 10,
                  zIndex: 20,
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 4,
                  ...transitionStyles,
                  transform: `translate(${hudOffset.x}px, ${hudOffset.y}px) ${transitionStyles.transform ?? ''}`,
                }}
              >
                <Box
                  {...hudHandleProps}
                  style={{
                    ...hudHandleProps.style,
                    position: 'relative',
                    display: 'flex',
                    justifyContent: 'center',
                    padding: '1px 0 2px',
                    borderRadius: 8,
                    background: accentEdge(scheme),
                  }}
                >
                  <IconGripHorizontal size={16} color="rgba(255,255,255,.85)" />
                  <ActionIcon
                    variant="transparent"
                    size="xs"
                    aria-label="Statusanzeige ausblenden"
                    onPointerDown={(e) => e.stopPropagation()}
                    onClick={() => hidePanel('hud')}
                    style={{ position: 'absolute', right: 2, top: 1, color: 'rgba(255,255,255,.85)' }}
                  >
                    <IconX size={13} />
                  </ActionIcon>
                </Box>
                <StatusHud />
                <ZoomBar />
              </Box>
            )}
          </Transition>
        </Scene>

        {dragOver && (
          <Box
            style={{
              position: 'absolute',
              inset: 8,
              zIndex: 30,
              pointerEvents: 'none',
              border: '2px dashed var(--mantine-color-teal-5)',
              borderRadius: 8,
              backgroundColor: 'rgba(20,184,166,.1)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
            }}
          >
            <Box style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <IconUpload size={20} color="var(--mantine-color-teal-5)" />
              <Text fw={600} c="teal">Datei hier ablegen</Text>
            </Box>
          </Box>
        )}
      </Box>

      <DataViewBand />
      </Box>

      {/* A real docked band, outside the map entirely — not an overlay on
          top of the globe like MapTools/the HUD stack it collects icons for. */}
      <Sideband />

      {/* Docked sidebar, outside the Viewer tree — it reaches the camera via
          the store (Scene stashes it there) rather than useCesium(). */}
      <LayerPanel />
    </Box>
  )
}
