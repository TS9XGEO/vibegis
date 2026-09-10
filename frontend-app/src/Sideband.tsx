/**
 * Docked band, full height, sitting outside the map itself (a flex sibling
 * next to the map/LayerPanel in App.tsx, not an overlay on top of the
 * globe) — one permanent icon per closable HUD box (see panels.ts). An icon
 * is grey while its box is open (already visible, nothing to do here) and
 * colorful while it's closed (this is how you get it back) — clicking
 * always toggles the box open/closed.
 */
import { lazy, Suspense, useEffect, useState } from 'react'
import {
  ActionIcon, Alert, Box, Button, Group, Loader, Modal, Paper, Popover, RingProgress, ScrollArea, Stack, Text,
  TextInput, Tooltip, UnstyledButton, rem, useComputedColorScheme,
} from '@mantine/core'
import { notifications } from '@mantine/notifications'
import {
  IconAlertTriangle,
  IconChartBar,
  IconChartHistogram,
  IconCheck,
  IconDatabaseCog,
  IconHelp,
  IconLayoutGrid,
  IconLayoutSidebarRightExpand,
  IconLogout,
  IconPlayerPlay,
  IconPlus,
  IconRobot,
  IconSearch,
  IconStack2,
  IconWand,
  IconX,
} from '@tabler/icons-react'

import { useTranslation } from 'react-i18next'

import { useOnceOpened } from './useOnceOpened'

import { useAiAgent } from './aiAgent'
// Lazy-loaded: each is a modal most sessions never open, and every one of
// them used to sit in the initial bundle. React.lazy only defers while the
// component is not rendered at all, so each render site below is gated on
// useOnceOpened() rather than mounted with `opened={false}` — see that hook
// for why it is "has it ever been open" and not simply "is it open".
const Analytics = lazy(() => import('./Analytics'))
import { ETL_JOBS_URL, ETL_URL, hasFullAccess, useAuth } from './auth'
import { accentEdge, panelBg, panelBorder } from './colorScheme'
import CompassButton from './CompassButton'
import ExtraMenu from './ExtraMenu'
import { useExtraMenu } from './extraMenu'
const Geoprocessing = lazy(() => import('./Geoprocessing'))
const QgisProcessing = lazy(() => import('./QgisProcessing'))
import QgisIcon from './QgisIcon'
const Pages = lazy(() => import('./Pages'))
import { TourTarget } from './tour/TourTarget'
import { usePanels, type PanelId } from './panels'
import { useSelection } from './selection'

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
const PROGRESS_RING_SIZE = 34

function ProgressIcon({ percent }: { percent: number }) {
  return (
    // rem(), not a bare 34: RingProgress puts its own `size` through Mantine's
    // rem() and so rides on --mantine-scale, while a plain px box does not.
    // At any display size but Klein the two then disagree, and because the
    // spinning layer rotates about the *box* center rather than the ring's,
    // the ring orbits that offset point instead of turning on the spot.
    <div
      style={{
        position: 'relative',
        width: rem(PROGRESS_RING_SIZE),
        height: rem(PROGRESS_RING_SIZE),
      }}
    >
      {/* Centered inside the box rather than laid out in flow, so the
          rotation origin is the ring's own center whatever the two sizes
          round to. */}
      <div
        style={{
          position: 'absolute',
          inset: 0,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          animation: 'etlRingSpin 1.4s linear infinite',
        }}
      >
        <RingProgress
          size={PROGRESS_RING_SIZE}
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

// Only the layer panel stays a direct RAIL entry — map tools and the status
// HUD toggle moved into ExtraMenu.tsx's floating grid (see the "open more
// options" button below), along with the tour/language/display-size/
// color-scheme/tips controls that used to follow this RAIL loop.
const RAIL: { id: PanelId; label: string; icon: typeof IconLayoutSidebarRightExpand }[] = [
  { id: 'layerPanel', label: 'Layerliste', icon: IconLayoutSidebarRightExpand },
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
/**
 * QGIS processing (Premium). Its own component rather than hoisted state like
 * Geoprocessing's, matching EtlButton/AiAgentButton — it owns its gate and its
 * modal, so Sideband's body stays readable.
 */
function QgisProcessingButton() {
  const { t } = useTranslation()
  const hasPremium = useAuth((s) => hasFullAccess(s.user, 'premium'))
  const [open, setOpen] = useState(false)
  const qgisEverOpen = useOnceOpened(open)
  return (
    <>
      <Tooltip
        label={
          <span style={{ whiteSpace: 'pre-line' }}>
            {hasPremium ? t('sideband.qgisTooltip') : t('sideband.qgisPremiumTooltip')}
          </span>
        }
        position="left"
        withArrow
        multiline
      >
        <TourTarget id="qgis-btn">
          {/* Never `disabled`: a disabled element swallows pointer events, so
              the upsell tooltip would never fire on hover. */}
          <UnstyledButton
            aria-label={t('sideband.qgisAriaLabel')}
            onClick={() => hasPremium && setOpen(true)}
            style={{
              width: rem(28),
              height: rem(28),
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              borderRadius: 6,
              color: hasPremium ? 'var(--mantine-color-teal-5)' : 'var(--mantine-color-dimmed)',
              cursor: hasPremium ? 'pointer' : 'default',
            }}
          >
            <QgisIcon size={16} />
          </UnstyledButton>
        </TourTarget>
      </Tooltip>
      {qgisEverOpen && <Suspense fallback={null}><QgisProcessing opened={open} onClose={() => setOpen(false)} /></Suspense>}
    </>
  )
}


function EtlButton() {
  const { t } = useTranslation()
  const user = useAuth((s) => s.user)
  const hasAccess = hasFullAccess(user, 'premium')
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
    ? t('etl.premiumTooltip')
    : state === 'loading'
      ? t('etl.stateLoading')
      : state === 'success'
        ? t('etl.stateSuccess')
        : state === 'error'
          ? t('etl.stateError')
          : t('etl.pickTask')

  return (
    <>
      <Tooltip
        label={<span style={{ whiteSpace: 'pre-line' }}>{tooltip}</span>}
        position="left"
        withArrow
        multiline
      >
        <TourTarget id="etl-btn">
          <UnstyledButton
            aria-label={t('etl.pickTask')}
            onClick={() => hasAccess && state !== 'loading' && setPickerOpen(true)}
            style={{
              width: rem(28),
              height: rem(28),
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
        </TourTarget>
      </Tooltip>

      <Modal
        opened={pickerOpen}
        onClose={() => setPickerOpen(false)}
        title={t('etl.pickTask')}
        centered
        size={ETL_MODAL_WIDTH}
      >
        <Stack gap="xs">
          {!jobsLoading && !jobsError && jobs.length > 0 && (
            <TextInput
              placeholder={t('etl.searchPlaceholder')}
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
                <Text size="sm" c="dimmed">{t('etl.noTasks')}</Text>
              )}
              {!jobsLoading && !jobsError && jobs.length > 0 && filteredJobs.length === 0 && (
                <Text size="sm" c="dimmed">{t('etl.noMatches', { query: jobSearch })}</Text>
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
                  <Tooltip label={t('etl.addToCascade')} position="top" withArrow>
                    <ActionIcon variant="light" size="lg" onClick={() => addToCascade(job)} aria-label={t('etl.addToCascade')}>
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
              <Text size="sm" fw={600}>{t('etl.cascadeTitle', { count: cascade.length })}</Text>
            </Group>

            <ScrollArea h={ETL_LIST_HEIGHT} type="auto">
              <Stack gap="xs">
                {cascade.map((job, i) => (
                  <Paper key={`${job.name}-${i}`} withBorder radius="sm" p="xs">
                    <Group gap="xs" justify="space-between" wrap="nowrap">
                      <Text size="sm">{i + 1}. {job.label}</Text>
                      <Tooltip label={t('etl.removeFromCascade')} position="top" withArrow>
                        <ActionIcon variant="subtle" color="gray" size="sm" onClick={() => removeFromCascade(i)} aria-label={t('etl.removeFromCascade')}>
                          <IconX size={14} />
                        </ActionIcon>
                      </Tooltip>
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
 * Geoprocessing's fully-hidden pattern — the AI panel toggle itself only
 * flips aiAgent.ts's `open`; AiAgentPanel.tsx is a docked column mounted by
 * App.tsx, to the right of the layer panel, not a child of this band.
 */
function AiAgentButton() {
  const { t } = useTranslation()
  const user = useAuth((s) => s.user)
  const hasAccess = hasFullAccess(user, 'premium')
  const open = useAiAgent((s) => s.open)
  const toggle = useAiAgent((s) => s.toggle)

  const tooltip = !hasAccess ? t('aiAgent.premiumTooltip') : open ? t('aiAgent.hide') : t('aiAgent.show')

  return (
    <Tooltip
      label={<span style={{ whiteSpace: 'pre-line' }}>{tooltip}</span>}
      position="left"
      withArrow
      multiline
    >
      <TourTarget id="ai-btn">
        <UnstyledButton
          aria-label={t('aiAgent.ariaLabel')}
          onClick={() => hasAccess && toggle()}
          style={{
            width: rem(28),
            height: rem(28),
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
      </TourTarget>
    </Tooltip>
  )
}

export default function Sideband() {
  const open = usePanels((s) => s.open)
  const hide = usePanels((s) => s.hide)
  const show = usePanels((s) => s.show)
  const dashboardTabOpen = useSelection((s) => s.dashboardTabOpen)
  const toggleDashboardTab = useSelection((s) => s.toggleDashboardTab)
  const [pagesOpen, setPagesOpen] = useState(false)
  const [analyticsOpen, setAnalyticsOpen] = useState(false)
  const [geoprocessOpen, setGeoprocessOpen] = useState(false)
  // Gates the lazy chunks below — see useOnceOpened().
  const pagesEverOpen = useOnceOpened(pagesOpen)
  const analyticsEverOpen = useOnceOpened(analyticsOpen)
  const geoEverOpen = useOnceOpened(geoprocessOpen)
  const logout = useAuth((s) => s.logout)
  const user = useAuth((s) => s.user)
  const username = user?.username
  const hasProAccess = hasFullAccess(user, 'pro')
  const scheme = useComputedColorScheme('dark')
  const { t } = useTranslation()
  const extraMenuOpen = useExtraMenu((s) => s.open)
  const toggleExtraMenu = useExtraMenu((s) => s.toggle)

  return (
    <Box
      style={{
        // rem() throughout, not raw px: these ride on Mantine's
        // `--mantine-scale`, which the display-size picker below drives
        // (uiScale.ts) — otherwise the rail alone would stay put while
        // everything it sits next to grows.
        width: rem(40),
        flex: `0 0 ${rem(40)}`,
        height: '100%',
        display: 'flex',
        flexDirection: 'column',
        backgroundColor: panelBg(scheme),
        borderLeft: `1px solid ${panelBorder(scheme)}`,
        borderRight: `1px solid ${panelBorder(scheme)}`,
      }}
    >
      {/* Third segment of the accent band that runs across the whole docked
          row — reversed like AiAgentPanel.tsx's, so it ends on the teal the
          layer panel's strip starts from and the three columns read as one
          sweep: amber→teal, teal→amber, amber→teal. The rail itself is the
          inner Box below; the strip has to sit outside it, or the rail's
          `alignItems: center` and top padding would inset it. */}
      <Box style={{ height: 2, flexShrink: 0, background: accentEdge(scheme, true) }} />
      <Box
        style={{
          flex: 1,
          minHeight: 0,
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          gap: rem(8),
          paddingTop: rem(12),
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
                width: rem(28),
                height: rem(28),
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

      {/* Below here: the tier-gated data-capability buttons, grouped and
          ordered to mirror CLAUDE.md's own Pro→Premium feature matrix
          ("Pro: upload, editing own data, geo tools. Premium: ETL server
          and AI bot") — Dashboard/Geoprocessing (Pro) first, then
          ETL/AI Agent (Premium). Not a RAIL entry — the dashboard is now a
          pinned tab in DataViewBand's tab strip (selection.ts's
          dashboardTabOpen/dashboardTabActive), not a simple open/closed
          PanelId boolean, so it gets its own bespoke button here, same as
          EtlButton/Geoprocessing/Pages below. */}
      <Tooltip
        label={!hasProAccess ? t('sideband.dashboardProTooltip') : dashboardTabOpen ? t('sideband.dashboardHide') : t('sideband.dashboardShow')}
        position="left"
        withArrow
        multiline
      >
        <TourTarget id="dashboard-btn">
          <UnstyledButton
            aria-label={t('sideband.dashboardAriaLabel')}
            onClick={() => hasProAccess && toggleDashboardTab()}
            style={{
              width: rem(28),
              height: rem(28),
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              borderRadius: 6,
              color: !hasProAccess ? 'var(--mantine-color-dimmed)' : dashboardTabOpen ? 'var(--mantine-color-dimmed)' : 'var(--mantine-color-teal-5)',
              cursor: hasProAccess ? 'pointer' : 'default',
              transition: 'color 150ms ease',
            }}
          >
            <IconChartBar size={16} />
          </UnstyledButton>
        </TourTarget>
      </Tooltip>

      <Tooltip label={!hasProAccess ? t('sideband.geoprocessProTooltip') : t('sideband.geoprocessTooltip')} position="left" withArrow multiline>
        <TourTarget id="geoprocess-btn">
          <UnstyledButton
            aria-label={t('sideband.geoprocessAriaLabel')}
            onClick={() => hasProAccess && setGeoprocessOpen(true)}
            style={{
              width: rem(28),
              height: rem(28),
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              borderRadius: 6,
              color: hasProAccess ? 'var(--mantine-color-teal-5)' : 'var(--mantine-color-dimmed)',
              cursor: hasProAccess ? 'pointer' : 'default',
            }}
          >
            <IconWand size={16} />
          </UnstyledButton>
        </TourTarget>
      </Tooltip>
      {geoEverOpen && <Suspense fallback={null}><Geoprocessing opened={geoprocessOpen} onClose={() => setGeoprocessOpen(false)} /></Suspense>}

      {/* Saved BI dashboards from Superset (Analytics.tsx). Ungated: every
          logged-in user has a Superset account, and what they can see there
          is decided by their own layer grants, mapped onto Superset roles at
          login — so there is nothing for a tier check to add here. */}
      <Tooltip label={t('analytics.tooltip')} position="left" withArrow>
        <TourTarget id="analytics-btn">
          <UnstyledButton
            aria-label={t('analytics.ariaLabel')}
            onClick={() => setAnalyticsOpen(true)}
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
            <IconChartHistogram size={16} />
          </UnstyledButton>
        </TourTarget>
      </Tooltip>
      {analyticsEverOpen && <Suspense fallback={null}><Analytics opened={analyticsOpen} onClose={() => setAnalyticsOpen(false)} /></Suspense>}

      <QgisProcessingButton />
      <EtlButton />
      <AiAgentButton />

      <Tooltip label={t('sideband.pagesTooltip')} position="left" withArrow>
        <TourTarget id="pages-btn">
          <UnstyledButton
            aria-label={t('sideband.pagesAriaLabel')}
            onClick={() => setPagesOpen(true)}
            style={{
              width: rem(28),
              height: rem(28),
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              borderRadius: 6,
              color: 'var(--mantine-color-yellow-7)',
            }}
          >
            <IconHelp size={16} />
          </UnstyledButton>
        </TourTarget>
      </Tooltip>
      {pagesEverOpen && <Suspense fallback={null}><Pages opened={pagesOpen} onClose={() => setPagesOpen(false)} /></Suspense>}

      {/* Pops ExtraMenu.tsx's grid out of this button (a Popover anchored to
          it, not a freely-positioned floating box) — map tools/status HUD,
          the guided tour, language, display size, color scheme and the tips
          toggle all live there now instead of each being its own RAIL-style
          entry here. Same open/closed color convention as the RAIL loop
          above (teal = closed, click to open; dimmed = already open). */}
      <Popover
        opened={extraMenuOpen}
        onChange={(o) => {
          if (o !== extraMenuOpen) toggleExtraMenu()
        }}
        position="left-start"
        offset={4}
        withArrow
        shadow="md"
        closeOnClickOutside
      >
        <Popover.Target>
          <Tooltip
            label={extraMenuOpen ? t('extraMenu.closeTooltip') : t('extraMenu.openTooltip')}
            position="left"
            withArrow
            disabled={extraMenuOpen}
          >
            <TourTarget id="extra-menu-btn">
              <UnstyledButton
                aria-label={t('extraMenu.ariaLabel')}
                onClick={toggleExtraMenu}
                style={{
                  width: rem(28),
                  height: rem(28),
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  borderRadius: 6,
                  color: extraMenuOpen ? 'var(--mantine-color-dimmed)' : 'var(--mantine-color-teal-5)',
                  transition: 'color 150ms ease',
                }}
              >
                <IconLayoutGrid size={16} />
              </UnstyledButton>
            </TourTarget>
          </Tooltip>
        </Popover.Target>
        <Popover.Dropdown p={6}>
          <ExtraMenu />
        </Popover.Dropdown>
      </Popover>

      {/* Pinned to the very end of the band, separate from the panel toggles
          above — logout is a global action, not tied to any box's state. */}
      <Tooltip label={t('sideband.logoutTooltip', { username })} position="left" withArrow>
        <TourTarget id="logout-btn">
          <UnstyledButton
            aria-label={t('sideband.logoutAriaLabel')}
            onClick={() => logout()}
            style={{
              width: rem(28),
              height: rem(28),
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
        </TourTarget>
      </Tooltip>
      </Box>
    </Box>
  )
}
