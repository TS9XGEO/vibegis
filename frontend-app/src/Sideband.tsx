/**
 * Docked band, full height, sitting outside the map itself (a flex sibling
 * next to the map/LayerPanel in App.tsx, not an overlay on top of the
 * globe) — one permanent icon per closable HUD box (see panels.ts). An icon
 * is grey while its box is open (already visible, nothing to do here) and
 * colorful while it's closed (this is how you get it back) — clicking
 * always toggles the box open/closed.
 */
import { useState } from 'react'
import { Box, RingProgress, Text, Tooltip, UnstyledButton, useComputedColorScheme } from '@mantine/core'
import { notifications } from '@mantine/notifications'
import {
  IconAlertTriangle,
  IconChartBar,
  IconCheck,
  IconCompass,
  IconDatabaseCog,
  IconHelp,
  IconLayoutSidebarRightExpand,
  IconLogout,
  IconTools,
  IconWand,
} from '@tabler/icons-react'

import { ETL_URL, useAuth } from './auth'
import { panelBg, panelBorder } from './colorScheme'
import CompassButton from './CompassButton'
import Geoprocessing from './Geoprocessing'
import Handbook from './Handbook'
import { usePanels, type PanelId } from './panels'
import { useSelection } from './selection'

const PREMIUM_TOOLTIP = 'ETL Tasks (Premium-Access)\n Buy Premium Access for 15€/month'

type EtlState = 'idle' | 'loading' | 'success' | 'error'

// Replaces the notification's default indeterminate spinner: a ring that
// fills in as the run progresses, with the percentage in its center — same
// notification layout throughout, just this one icon slot changes content.
// The ring itself keeps spinning the whole time (the animation the plain
// Mantine Loader used to give "still working"), while the percentage text
// sits in a separate, non-rotating layer on top so it stays upright and
// readable instead of spinning along with the ring.
function ProgressIcon({ percent }: { percent: number }) {
  return (
    <div style={{ position: 'relative', width: 34, height: 34 }}>
      <div style={{ animation: 'etlRingSpin 1.4s linear infinite' }}>
        <RingProgress
          size={34}
          thickness={3}
          roundCaps
          transitionDuration={900}
          sections={[{ value: percent, color: 'teal' }]}
        />
      </div>
      <div
        style={{
          position: 'absolute',
          inset: 0,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          pointerEvents: 'none',
        }}
      >
        <Text size="8px" fw={700}>
          {percent}%
        </Text>
      </div>
    </div>
  )
}

const RAIL: { id: PanelId; label: string; icon: typeof IconTools }[] = [
  { id: 'layerPanel', label: 'Layerliste', icon: IconLayoutSidebarRightExpand },
  { id: 'mapTools', label: 'Werkzeuge', icon: IconTools },
  { id: 'hud', label: 'Statusanzeige', icon: IconCompass },
]

/**
 * Visible to everyone, usable only by admins/premium users — the button
 * itself is never `disabled` (a native disabled element drops pointer
 * events, and Mantine's Tooltip needs those to fire on hover), it just
 * no-ops on click when access is missing, so the upsell tooltip always
 * shows on hover either way.
 */
function EtlButton() {
  const user = useAuth((s) => s.user)
  const hasAccess = user?.role === 'admin' || !!user?.premium
  const [state, setState] = useState<EtlState>('idle')

  async function trigger() {
    if (!hasAccess || state === 'loading') return
    setState('loading')
    const id = 'etl-run'
    notifications.show({
      id,
      icon: <ProgressIcon percent={0} />,
      title: 'ETL-Lauf',
      message: 'Wird gestartet…',
      autoClose: false,
      withCloseButton: false,
    })

    let runId: string
    try {
      const res = await fetch(ETL_URL, { method: 'POST' })
      const body = await res.json().catch(() => null)
      if (!res.ok) throw new Error(body?.detail ?? `HTTP ${res.status}`)
      runId = body.runId
    } catch (e) {
      setState('error')
      notifications.update({
        id,
        loading: false,
        color: 'red',
        icon: <IconAlertTriangle size={16} />,
        title: 'Start fehlgeschlagen',
        message: e instanceof Error ? e.message : String(e),
        autoClose: 5000,
      })
      setTimeout(() => setState('idle'), 3000)
      return
    }

    // Launch confirmed — the toast now tracks the actual run, not just the
    // request that started it, since "done" means the ETL job finished, not
    // that upload-api accepted the trigger.
    notifications.update({
      id,
      icon: <ProgressIcon percent={0} />,
      color: 'teal',
      title: 'ETL-Lauf läuft',
      message: `Run-ID: ${runId}`,
      autoClose: false,
      withCloseButton: false,
    })

    for (;;) {
      await new Promise((r) => setTimeout(r, 3000))
      let status: string | null = null
      let progress = 0
      try {
        const res = await fetch(`${ETL_URL}/${runId}`)
        if (res.ok) {
          const body = await res.json()
          status = body.status
          progress = body.progress ?? 0
        }
      } catch {
        // transient network hiccup mid-poll — keep trying rather than giving up
      }

      if (status === 'SUCCESS') {
        setState('success')
        notifications.update({
          id,
          loading: false,
          color: 'teal',
          icon: <IconCheck size={16} />,
          title: 'ETL-Lauf abgeschlossen',
          message: `Run-ID: ${runId}`,
          autoClose: 5000,
        })
        break
      }
      if (status === 'FAILURE' || status === 'CANCELED') {
        setState('error')
        notifications.update({
          id,
          loading: false,
          color: 'red',
          icon: <IconAlertTriangle size={16} />,
          title: 'ETL-Lauf fehlgeschlagen',
          message: `Status: ${status}`,
          autoClose: 6000,
        })
        break
      }
      // NOT_STARTED / QUEUED / STARTING / STARTED / CANCELING — keep polling,
      // but still move the ring so it's visibly growing, not just sitting.
      notifications.update({
        id,
        icon: <ProgressIcon percent={progress} />,
        color: 'teal',
        title: 'ETL-Lauf läuft',
        message: `Run-ID: ${runId}`,
        autoClose: false,
        withCloseButton: false,
      })
    }
    setTimeout(() => setState('idle'), 3000)
  }

  const Icon = state === 'success' ? IconCheck : state === 'error' ? IconAlertTriangle : IconDatabaseCog
  const color = !hasAccess
    ? 'var(--mantine-color-dimmed)'
    : state === 'error'
      ? 'var(--mantine-color-red-5)'
      : 'var(--mantine-color-teal-5)'
  const tooltip = !hasAccess
    ? PREMIUM_TOOLTIP
    : state === 'loading'
      ? 'ETL-Lauf läuft…'
      : state === 'success'
        ? 'ETL-Lauf abgeschlossen'
        : state === 'error'
          ? 'Start fehlgeschlagen'
          : 'ETL-Lauf starten'

  return (
    <Tooltip
      label={<span style={{ whiteSpace: 'pre-line' }}>{tooltip}</span>}
      position="left"
      withArrow
      multiline
    >
      <UnstyledButton
        aria-label="ETL-Lauf starten"
        onClick={trigger}
        style={{
          width: 28,
          height: 28,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          borderRadius: 6,
          color,
          cursor: hasAccess ? 'pointer' : 'default',
          transition: 'color 150ms ease',
        }}
      >
        <Icon size={16} />
      </UnstyledButton>
    </Tooltip>
  )
}

export default function Sideband() {
  const open = usePanels((s) => s.open)
  const hide = usePanels((s) => s.hide)
  const show = usePanels((s) => s.show)
  const dashboardTabOpen = useSelection((s) => s.dashboardTabOpen)
  const toggleDashboardTab = useSelection((s) => s.toggleDashboardTab)
  const [handbookOpen, setHandbookOpen] = useState(false)
  const [geoprocessOpen, setGeoprocessOpen] = useState(false)
  const logout = useAuth((s) => s.logout)
  const username = useAuth((s) => s.user?.username)
  const isAdmin = useAuth((s) => s.user?.role === 'admin')
  const scheme = useComputedColorScheme('dark')

  return (
    <Box
      style={{
        width: 40,
        flex: '0 0 40px',
        height: '100%',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        gap: 8,
        paddingTop: 12,
        backgroundColor: panelBg(scheme),
        borderLeft: `1px solid ${panelBorder(scheme)}`,
        borderRight: `1px solid ${panelBorder(scheme)}`,
      }}
    >
      {RAIL.map(({ id, label, icon: Icon }) => {
        const isOpen = open[id]
        return (
          <Tooltip key={id} label={isOpen ? `${label} ausblenden` : `${label} einblenden`} position="left" withArrow>
            <UnstyledButton
              aria-label={label}
              onClick={() => (isOpen ? hide(id) : show(id))}
              style={{
                width: 28,
                height: 28,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                borderRadius: 6,
                color: isOpen ? 'var(--mantine-color-dimmed)' : 'var(--mantine-color-teal-5)',
                transition: 'color 150ms ease',
              }}
            >
              <Icon size={16} />
            </UnstyledButton>
          </Tooltip>
        )
      })}

      {/* Not a toggle like the RAIL above — a live action button (reset
          heading to north), always available regardless of whether the HUD
          box is shown. Used to live inside that box (CompassButton.tsx),
          moved here so it's reachable without opening it. */}
      <CompassButton />

      {/* Not a RAIL entry — the dashboard is now a pinned tab in
          DataViewBand's tab strip (selection.ts's dashboardTabOpen/
          dashboardTabActive), not a simple open/closed PanelId boolean, so
          it gets its own bespoke button here, same as EtlButton/Geoprocessing/
          Handbook below. Kept in the same rail slot the RAIL entry used to
          occupy so the rail's visual order doesn't change. */}
      <Tooltip label={dashboardTabOpen ? 'Auswahl-Dashboard ausblenden' : 'Auswahl-Dashboard einblenden'} position="left" withArrow>
        <UnstyledButton
          aria-label="Auswahl-Dashboard"
          onClick={toggleDashboardTab}
          style={{
            width: 28,
            height: 28,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            borderRadius: 6,
            color: dashboardTabOpen ? 'var(--mantine-color-dimmed)' : 'var(--mantine-color-teal-5)',
            transition: 'color 150ms ease',
          }}
        >
          <IconChartBar size={16} />
        </UnstyledButton>
      </Tooltip>

      <EtlButton />

      {isAdmin && (
        <Tooltip label="Geoverarbeitung" position="left" withArrow>
          <UnstyledButton
            aria-label="Geoverarbeitung öffnen"
            onClick={() => setGeoprocessOpen(true)}
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
            <IconWand size={16} />
          </UnstyledButton>
        </Tooltip>
      )}
      <Geoprocessing opened={geoprocessOpen} onClose={() => setGeoprocessOpen(false)} />

      <Tooltip label="Handbuch" position="left" withArrow>
        <UnstyledButton
          aria-label="Handbuch öffnen"
          onClick={() => setHandbookOpen(true)}
          style={{
            width: 28,
            height: 28,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            borderRadius: 6,
            color: 'var(--mantine-color-yellow-7)',
          }}
        >
          <IconHelp size={16} />
        </UnstyledButton>
      </Tooltip>
      <Handbook opened={handbookOpen} onClose={() => setHandbookOpen(false)} />

      {/* Pinned to the very end of the band, separate from the panel toggles
          above — logout is a global action, not tied to any box's state. */}
      <Tooltip label={`Abmelden (${username})`} position="left" withArrow>
        <UnstyledButton
          aria-label="Abmelden"
          onClick={() => logout()}
          style={{
            width: 28,
            height: 28,
            marginTop: 'auto',
            marginBottom: 12,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            borderRadius: 6,
            color: 'var(--mantine-color-dimmed)',
          }}
        >
          <IconLogout size={16} />
        </UnstyledButton>
      </Tooltip>
    </Box>
  )
}
