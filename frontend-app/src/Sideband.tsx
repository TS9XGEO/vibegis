/**
 * Docked band, full height, sitting outside the map itself (a flex sibling
 * next to the map/LayerPanel in App.tsx, not an overlay on top of the
 * globe) — one permanent icon per closable HUD box (see panels.ts). An icon
 * is grey while its box is open (already visible, nothing to do here) and
 * colorful while it's closed (this is how you get it back) — clicking
 * always toggles the box open/closed.
 */
import { useEffect, useState } from 'react'
import {
  ActionIcon, Alert, Box, Button, Group, Loader, Modal, Paper, RingProgress, ScrollArea, Stack, Text, TextInput,
  Tooltip, UnstyledButton, useComputedColorScheme,
} from '@mantine/core'
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
  IconPlayerPlay,
  IconPlus,
  IconRobot,
  IconSearch,
  IconStack2,
  IconTools,
  IconWand,
  IconX,
} from '@tabler/icons-react'

import AiAgentPanel from './AiAgentPanel'
import { useAiAgent } from './aiAgent'
import { ETL_JOBS_URL, ETL_URL, useAuth } from './auth'
import { panelBg, panelBorder } from './colorScheme'
import CompassButton from './CompassButton'
import Geoprocessing from './Geoprocessing'
import Handbook from './Handbook'
import { usePanels, type PanelId } from './panels'
import { useSelection } from './selection'

const PREMIUM_TOOLTIP = 'ETL Tasks (Premium-Access)\n Buy Premium Access for 15€/month'
const AI_PREMIUM_TOOLTIP = 'KI-Assistent (Premium-Zugang)\n Premium-Zugang für 15€/Monat freischalten'

type EtlState = 'idle' | 'loading' | 'success' | 'error'

interface EtlJob {
  name: string
  label: string
}

// Both the task list and the Kaskade list get this same fixed-height,
// internally-scrolling viewport — enough for 10 rows — so the picker modal
// never grows or shrinks with search results, load state, or how many
// tasks are queued; only what's inside the viewport changes.
const ETL_LIST_HEIGHT = 10 * 44

// The picker modal is a fixed pixel width (not a Mantine size token) because
// the Kaskade panel below needs to compute a screen position flush against
// its right edge — Modal centers itself in the viewport via `left: 50%`, so
// that edge is always at `50% + ETL_MODAL_WIDTH / 2`, regardless of viewport
// size.
const ETL_MODAL_WIDTH = 380
const ETL_CASCADE_WIDTH = 300

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
 * shows on hover either way. Clicking it opens a task picker (the jobs
 * defined in dagster/defs/__init__.py, fetched fresh from GET /etl/jobs —
 * same "never hardcode a list the backend already owns" convention as the
 * layer list itself) rather than firing the run directly.
 */
function EtlButton() {
  const user = useAuth((s) => s.user)
  const hasAccess = user?.role === 'admin' || !!user?.premium
  const [state, setState] = useState<EtlState>('idle')
  const [pickerOpen, setPickerOpen] = useState(false)
  const [jobs, setJobs] = useState<EtlJob[]>([])
  const [jobsLoading, setJobsLoading] = useState(false)
  const [jobsError, setJobsError] = useState<string | null>(null)
  const [jobSearch, setJobSearch] = useState('')
  const filteredJobs = jobs.filter((j) => j.label.toLowerCase().includes(jobSearch.trim().toLowerCase()))

  // Cascade: a user-built, ordered queue of tasks run one after another —
  // "Add" (per task row) appends to it instead of running that task right
  // away; "Kaskade ausführen" below then runs the whole queue in order,
  // stopping at the first failure. Session-only, like every other picker
  // state here — no reason for it to survive a reload. Not collapsible —
  // the panel itself only exists once the queue holds something.
  const [cascade, setCascade] = useState<EtlJob[]>([])

  useEffect(() => {
    if (!pickerOpen) {
      setJobSearch('')
      return
    }
    setJobsLoading(true)
    setJobsError(null)
    fetch(ETL_JOBS_URL)
      .then(async (res) => {
        const body = await res.json().catch(() => null)
        if (!res.ok) throw new Error(body?.detail ?? `HTTP ${res.status}`)
        setJobs(body.jobs ?? [])
      })
      .catch((e) => setJobsError(e instanceof Error ? e.message : String(e)))
      .finally(() => setJobsLoading(false))
  }, [pickerOpen])

  function addToCascade(job: EtlJob) {
    setCascade((c) => [...c, job])
  }

  function removeFromCascade(index: number) {
    setCascade((c) => c.filter((_, i) => i !== index))
  }

  // Runs one job to completion, driving a single notification (`id`) through
  // start/poll/success/failure — shared by a single-task run and each step
  // of a cascade run, so there is exactly one implementation of "launch a
  // job and track it to a terminal state".
  async function runOneJob(job: EtlJob, id: string, title: string): Promise<'SUCCESS' | 'FAILURE' | 'CANCELED' | 'ERROR'> {
    notifications.show({
      id,
      icon: <ProgressIcon percent={0} />,
      title,
      message: 'Wird gestartet…',
      autoClose: false,
      withCloseButton: false,
    })

    let runId: string
    try {
      const res = await fetch(ETL_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ job_name: job.name }),
      })
      const body = await res.json().catch(() => null)
      if (!res.ok) throw new Error(body?.detail ?? `HTTP ${res.status}`)
      runId = body.runId
    } catch (e) {
      notifications.update({
        id,
        loading: false,
        color: 'red',
        icon: <IconAlertTriangle size={16} />,
        title: `${title} — Start fehlgeschlagen`,
        message: e instanceof Error ? e.message : String(e),
        autoClose: 5000,
      })
      return 'ERROR'
    }

    // Launch confirmed — the toast now tracks the actual run, not just the
    // request that started it, since "done" means the ETL job finished, not
    // that upload-api accepted the trigger.
    notifications.update({
      id,
      icon: <ProgressIcon percent={0} />,
      color: 'teal',
      title,
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
        notifications.update({
          id,
          loading: false,
          color: 'teal',
          icon: <IconCheck size={16} />,
          title,
          message: `Run-ID: ${runId}`,
          autoClose: 5000,
        })
        return 'SUCCESS'
      }
      if (status === 'FAILURE' || status === 'CANCELED') {
        notifications.update({
          id,
          loading: false,
          color: 'red',
          icon: <IconAlertTriangle size={16} />,
          title: `${title} — fehlgeschlagen`,
          message: `Status: ${status}`,
          autoClose: 6000,
        })
        return status
      }
      // NOT_STARTED / QUEUED / STARTING / STARTED / CANCELING — keep polling,
      // but still move the ring so it's visibly growing, not just sitting.
      notifications.update({
        id,
        icon: <ProgressIcon percent={progress} />,
        color: 'teal',
        title,
        message: `Run-ID: ${runId}`,
        autoClose: false,
        withCloseButton: false,
      })
    }
  }

  async function trigger(job: EtlJob) {
    if (!hasAccess || state === 'loading') return
    setPickerOpen(false)
    setState('loading')
    const status = await runOneJob(job, 'etl-run', job.label)
    setState(status === 'SUCCESS' ? 'success' : 'error')
    setTimeout(() => setState('idle'), 3000)
  }

  async function runCascade() {
    if (!hasAccess || state === 'loading' || cascade.length === 0) return
    setPickerOpen(false)
    setState('loading')
    const id = 'etl-cascade'
    const total = cascade.length
    let failed = false
    for (let i = 0; i < total; i++) {
      const job = cascade[i]
      const status = await runOneJob(job, id, `Kaskade (${i + 1}/${total}): ${job.label}`)
      if (status !== 'SUCCESS') {
        failed = true
        break
      }
    }
    if (!failed) {
      notifications.update({
        id,
        loading: false,
        color: 'teal',
        icon: <IconCheck size={16} />,
        title: 'Kaskade abgeschlossen',
        message: `${total} Tasks erfolgreich`,
        autoClose: 5000,
      })
      setCascade([])
    }
    setState(failed ? 'error' : 'success')
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
          : 'ETL-Task auswählen'

  return (
    <>
      <Tooltip
        label={<span style={{ whiteSpace: 'pre-line' }}>{tooltip}</span>}
        position="left"
        withArrow
        multiline
      >
        <UnstyledButton
          aria-label="ETL-Task auswählen"
          onClick={() => hasAccess && state !== 'loading' && setPickerOpen(true)}
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

      <Modal
        opened={pickerOpen}
        onClose={() => setPickerOpen(false)}
        title="ETL-Task auswählen"
        centered
        size={ETL_MODAL_WIDTH}
      >
        <Stack gap="xs">
          {!jobsLoading && !jobsError && jobs.length > 0 && (
            <TextInput
              placeholder="Tasks durchsuchen…"
              value={jobSearch}
              onChange={(e) => setJobSearch(e.currentTarget.value)}
              leftSection={<IconSearch size={14} />}
              size="sm"
            />
          )}
          <ScrollArea h={ETL_LIST_HEIGHT} type="auto">
            <Stack gap="xs">
              {jobsLoading && <Loader size="sm" mx="auto" my="sm" />}
              {jobsError && (
                <Alert color="red" variant="light" icon={<IconAlertTriangle size={16} />}>{jobsError}</Alert>
              )}
              {!jobsLoading && !jobsError && jobs.length === 0 && (
                <Text size="sm" c="dimmed">Keine ETL-Tasks verfügbar.</Text>
              )}
              {!jobsLoading && !jobsError && jobs.length > 0 && filteredJobs.length === 0 && (
                <Text size="sm" c="dimmed">Keine Treffer für „{jobSearch}“.</Text>
              )}
              {filteredJobs.map((job) => (
                <Group key={job.name} gap="xs" wrap="nowrap">
                  <Button
                    variant="light"
                    flex={1}
                    justify="space-between"
                    rightSection={<IconPlayerPlay size={14} />}
                    onClick={() => trigger(job)}
                  >
                    {job.label}
                  </Button>
                  <Tooltip label="Zur Kaskade hinzufügen" position="top" withArrow>
                    <ActionIcon variant="light" size="lg" onClick={() => addToCascade(job)} aria-label="Zur Kaskade hinzufügen">
                      <IconPlus size={16} />
                    </ActionIcon>
                  </Tooltip>
                </Group>
              ))}
            </Stack>
          </ScrollArea>
        </Stack>
      </Modal>

      {/* Not part of the Modal itself — a separate fixed-position panel
          flush against the modal's right edge, only rendered once the
          cascade holds something. The modal is centered via `left: 50%`
          (Mantine's own doing), so its right edge is always at
          `50% + ETL_MODAL_WIDTH / 2` regardless of viewport size; anchoring
          off that same formula (rather than measuring the modal DOM node)
          means adding tasks grows the picker to the right without ever
          moving or resizing the modal/window itself. zIndex above the
          modal's own (Mantine's `--mantine-z-index-modal`, 200) so it isn't
          hidden behind the modal's overlay. */}
      {pickerOpen && cascade.length > 0 && (
        <Paper
          withBorder
          radius="md"
          p="sm"
          style={{
            position: 'fixed',
            left: `calc(50% + ${ETL_MODAL_WIDTH / 2}px + 12px)`,
            top: '50%',
            transform: 'translateY(-50%)',
            width: ETL_CASCADE_WIDTH,
            zIndex: 401,
          }}
        >
          <Stack gap="xs">
            <Group gap="xs">
              <IconStack2 size={16} />
              <Text size="sm" fw={600}>Kaskade ({cascade.length})</Text>
            </Group>

            <ScrollArea h={ETL_LIST_HEIGHT} type="auto">
              <Stack gap="xs">
                {cascade.map((job, i) => (
                  <Paper key={`${job.name}-${i}`} withBorder radius="sm" p="xs">
                    <Group gap="xs" justify="space-between" wrap="nowrap">
                      <Text size="sm">{i + 1}. {job.label}</Text>
                      <ActionIcon variant="subtle" color="gray" size="sm" onClick={() => removeFromCascade(i)} aria-label="Aus Kaskade entfernen">
                        <IconX size={14} />
                      </ActionIcon>
                    </Group>
                  </Paper>
                ))}
              </Stack>
            </ScrollArea>

            <Button
              leftSection={<IconPlayerPlay size={14} />}
              disabled={state === 'loading'}
              onClick={runCascade}
            >
              Kaskade ausführen
            </Button>
          </Stack>
        </Paper>
      )}
    </>
  )
}

/**
 * Same visible-but-disabled + upsell-tooltip shape as EtlButton above
 * (never `disabled`, so the Tooltip still fires on hover) rather than
 * Geoprocessing's fully-hidden pattern — the AI panel toggle itself opens
 * AiAgentPanel.tsx, mounted once below in the main render.
 */
function AiAgentButton() {
  const user = useAuth((s) => s.user)
  const hasAccess = user?.role === 'admin' || !!user?.premium
  const open = useAiAgent((s) => s.open)
  const toggle = useAiAgent((s) => s.toggle)

  const tooltip = !hasAccess ? AI_PREMIUM_TOOLTIP : open ? 'KI-Assistent ausblenden' : 'KI-Assistent einblenden'

  return (
    <Tooltip
      label={<span style={{ whiteSpace: 'pre-line' }}>{tooltip}</span>}
      position="left"
      withArrow
      multiline
    >
      <UnstyledButton
        aria-label="KI-Assistent"
        onClick={() => hasAccess && toggle()}
        style={{
          width: 28,
          height: 28,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          borderRadius: 6,
          color: !hasAccess ? 'var(--mantine-color-dimmed)' : open ? 'var(--mantine-color-dimmed)' : 'var(--mantine-color-teal-5)',
          cursor: hasAccess ? 'pointer' : 'default',
          transition: 'color 150ms ease',
        }}
      >
        <IconRobot size={16} />
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
      <AiAgentButton />

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
      <AiAgentPanel />

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
