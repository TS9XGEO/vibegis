/**
 * v13: `LayerOverviewCard`'s "everything selected" now means "everything
 * matching the layer's active attribute filter" when one is set
 * (AttributeFilter.tsx/wms.ts's `attributeFilters`) — previously the filter
 * only ever affected WMS map rendering, never selection/data-view/dashboard.
 * Kartenansicht passes the filter's CQL form (`filter.ts`'s `buildCql`,
 * already imported here) into `fetchFeaturesInBbox`'s new optional `cql`
 * param; Alle Zeilen passes the raw `LayerFilter` straight through to the
 * new optional `filter` param on `fetchTableCount`/`fetchColumnGroupBy`/
 * `fetchColumnStats`, which upload-api turns into a parameterized SQL WHERE
 * fragment (`build_filter_where()` in app.py — every column still goes
 * through `check_identifier`, every value stays a bound parameter). CSV
 * export in both modes follows the same filter, via `fetchAllFeatures`'s
 * new optional `cql` param in Alle Zeilen's case — otherwise a "filtered"
 * card's own export button would silently dump the whole unfiltered table.
 * `usableFilter()` (top of this file) is the one place that decides "does
 * this layer actually have a usable filter" — mirrors `buildCql`'s own
 * ignore-if-nothing-usable check — and is shared with
 * `SelectionDashboardPanel`'s nav list so the filter indicator (`IconFilter`,
 * next to a card's title and its `LayerNavRow`) and the eager `layerCounts`
 * pre-fetch agree with the card body on whether a filter is "on."
 * `SelectionDashboardPanel` keeps two count caches: `layerCounts` (always
 * unfiltered, used only as `totalVisibleCount`'s denominator — the "share of
 * everything visible" ring deliberately stays a rough whole-table indicator)
 * and `filteredCounts` (only for a layer with a filter, keyed by a
 * JSON-stringified filter signature via a ref so a filter change refetches
 * without spamming unrelated re-renders) — `displayCount()` picks whichever
 * applies for the nav-row/card headline number. Scoped to `LayerOverviewCard`
 * only: a real selection (`LayerSummary`) is a specific already-selected set,
 * not "everything," and the select tools/plain attribute table remain their
 * own, separate, pre-existing inconsistency.
 *
 * v12: `BreakdownColumns` polish. Each row shows its share of the layer's
 * total as a percentage next to its count now (`pct()`, denominator = every
 * bucket's count summed — Andere included — so it needs nothing extra from
 * either caller). The synthetic "Andere" bucket can be unfolded: its
 * individual (excluded-from-top-N) values are now kept as `Bucket.hidden`/
 * `CountBucket.hidden` instead of being discarded once summed, and a small
 * `IconChevronRight` next to "Andere" toggles showing them as their own
 * rows (`andereOpen` state) — clicking one works exactly like a top-level
 * row, since `bucketByLabel`/`viewportBucketByLabel` flatten `hidden` in
 * too. PieChart/DonutChart also gained a hand-built legend (they have no
 * native one, unlike BarChart) placed beside the chart rather than under
 * it, `tooltipDataSource="segment"` so hovering one slice shows only that
 * slice's tooltip instead of every segment's value at once (the default),
 * and BarChart's bars now cycle the same per-bucket LAYER_PALETTE colors
 * pieData already used, via each data row's own `color` field rather than
 * one flat color for every bar.
 *
 * v11: `LayerOverviewCard` gained the same "Kartenansicht"/"Alle Zeilen"
 * `SegmentedControl` AttributeTable.tsx already has, defaulting to
 * Kartenansicht. Kartenansicht fetches real features in the current map
 * view (features.ts's `fetchFeaturesInBbox`, refetched on `camera.changed`
 * exactly like AttributeTable.tsx's own Kartenansicht mode) and computes
 * count/aggregates/breakdown client-side via `computeAggregates()`/
 * `computeEntryBreakdown()` — the same two functions `LayerSummary` calls,
 * extracted out of it so both share the math instead of a third copy. Real
 * entries in memory means highlight-on-click, drill-through and CSV export
 * are synchronous in this mode, unlike Alle Zeilen's fetch-on-click.
 * Alle Zeilen is untouched — the original SQL-aggregate implementation
 * this card always had; its headline count was already pre-fetched by
 * `SelectionDashboardPanel` for every visible overview layer the moment
 * overview mode is shown, so switching to it is never a cold wait.
 *
 * v10: `SelectToolsRow` (exported from this file, defined below) moved out
 * of this panel's own body and into DataViewBand.tsx's tab-strip header,
 * next to the maximize button — visible in the band's header bar itself
 * rather than taking up space inside the dashboard's scrollable content,
 * and shown regardless of which tab is focused (a plain attribute-table
 * tab benefits from the select tools too, not just the dashboard). Kept
 * defined in this file (not moved bodily into DataViewBand.tsx) since it's
 * still dashboard-flavored UI sharing this file's other imports.
 *
 * v9: replaced the responsive grid of independently-collapsible per-layer
 * cards with a master-detail layout — Thomas didn't like clicking each
 * layer's own card open/closed to see it, especially with several layers
 * involved. `LayerNavRow` is the new left-hand list (one row per layer,
 * color bar + title + count, highlighted when active); `LayerSummary`/
 * `LayerOverviewCard` lost their own `expanded`/`Collapse` and gained an
 * `isActive` prop instead, the same "stay mounted, `display: none` when not
 * the current one" convention `AttributeTablePanel`/this very panel already
 * use elsewhere — so every layer's own `groupBy`/`chartType` choice and
 * already-fetched columns survive switching to another layer in the list
 * and back, exactly like switching tabs never lost that state before. Both
 * `SelectionDashboardPanel`'s modes (a real selection, or the "everything
 * selected" overview) render through the same list-plus-detail shell — see
 * `selectedLayerName`'s effect for how the active layer is kept selected
 * across a re-render (or a mode switch) whenever it's still around, and
 * only reset to "the first one" when it genuinely isn't any more.
 *
 * v6: docked into DataViewBand's tab strip as a pinned "Auswahl" tab instead
 * of a floating popup (selection.ts's `dashboardTabOpen`/`dashboardTabActive`,
 * toggled from Sideband.tsx) — this used to be a small, fixed-340px-wide
 * draggable Paper competing with MapTools.tsx's own floating panel for the
 * same corner of the screen, which doesn't match how central this panel
 * actually is to the app. It now gets the same full-width, resizable-up-to-
 * 800px docked space DataViewBand already gives every attribute-table tab
 * (see DataViewBand.tsx), and the default export is `SelectionDashboardPanel`,
 * a plain `isActive`-driven content component (`display: none` when not the
 * focused tab, same convention as AttributeTable.tsx — every open tab stays
 * mounted, so switching away and back never loses expansion/chart-type
 * state) rather than something that owns its own position/drag/resize.
 *
 * Each layer's breakdown chart is now also swappable per layer between bar,
 * pie and donut (`LayerSummary`'s own `chartType` state) — @mantine/charts
 * is actually pinned to 7.17.8 here (checked package.json and the installed
 * .d.ts directly; an earlier version of this comment wrongly claimed 7.13.x
 * with no click support), and `barProps`/`pieProps` both pass a real
 * recharts `onClick` through in this version, so every chart type also
 * doubles as a click target for the same toggleHighlight() the row list
 * below already offers — clicking a bar, pie slice or donut segment
 * highlights it on the map exactly like clicking its row does.
 *
 * v5: clicking a breakdown row no longer overrides the real selection.
 * It used to call replaceSelectionForLayers() to "preview" a subset, which
 * silently replaced whatever the user had actually selected. It now toggles
 * dashboardHighlight.ts's own store instead — a second, independent map
 * highlight (DashboardHighlight.tsx, amber vs. the real selection's blue)
 * that never touches selection.ts's `selected`. Drill-through (the small
 * icon on each row) still overrides on purpose — its whole point is "jump
 * to a detail view of exactly this," so it keeps replaceSelectionForLayers().
 *
 * v7: the old glowing total-count block and the collapsed "Werkzeuge"
 * section are both gone, replaced by `SelectToolsRow` — holding just the
 * point/circle/polygon select buttons, the "N ausgewählt" badge, and the
 * clear button. It drives the exact same useSelection()/useTools()/
 * useSelectCandidates() state ToolboxControls.tsx's buttons do (see that
 * file's own header comment), so it can't disagree with the floating
 * MapTools toolbox, which still has the full button set unchanged. (The
 * per-layer card grid this paragraph used to describe is gone — see v9
 * below; `SelectToolsRow`'s own position moved too — see v10.)
 *
 * v8: an empty real selection no longer means an empty panel. Instead it
 * shows `LayerOverviewCard` — one per currently *visible* map layer, as if
 * everything in it were selected. Some of this app's real layers run into
 * the millions of rows, so this deliberately never fetches whole layers of
 * features into the browser the way `LayerSummary` does for a real
 * (bounded) selection — every number here comes from a new set of
 * upload-api SQL aggregate endpoints instead (`/table-count`,
 * `/column-groupby`, and `/column-stats`'s new sum/avg/count fields). A
 * bucket only turns into real features on demand: clicking a row/chart
 * segment or its drill-through icon fetches just that value's matching
 * features via the existing `fetchFeaturesWithFilter` (same bounded/capped
 * contract the real select tools already use), converting it into a normal
 * `dashboardHighlight`/`replaceSelectionForLayers()` call from there. This
 * mode is otherwise display-only — it never writes to `selection.ts`'s
 * `selected` map itself, only drill-through does that (on purpose, exactly
 * like a real selection's drill-through already does). `BreakdownColumns`
 * is the row-list-plus-chart block factored out of `LayerSummary` so both
 * this and the real-selection path render it identically from a plain
 * `{label, count}[]`, without either duplicating that sizable JSX twice.
 *
 * The idea: this panel is the one place in the app that's *entirely about*
 * the map's own selection highlight, so it borrows that highlight's own
 * electric-blue (SELECTION_COLOR, otherwise only seen on the globe itself)
 * as its signature color — the glowing total count reads as "this number is
 * literally what's lit up on your map right now." Each layer then gets its
 * own deterministic accent hue (a small fixed palette, hashed from the
 * layer name) carried through its identity bar, its share-of-selection
 * ring, and its own chart/data-bars — so a glance at the color is enough to
 * tell which layer a number belongs to, no legend needed.
 */
import { Fragment, useEffect, useMemo, useRef, useState } from 'react'
import {
  ActionIcon, Badge, Box, Group, Loader, RingProgress, SegmentedControl, Select, Stack, Switch,
  Text, TextInput, Tooltip, useComputedColorScheme,
} from '@mantine/core'
import { BarChart, DonutChart, PieChart } from '@mantine/charts'
import {
  IconBookmark, IconChevronRight, IconCircle, IconClick, IconDownload, IconExternalLink, IconFilter, IconLasso,
  IconTrash, IconX,
} from '@tabler/icons-react'
import { Math as CesiumMath } from 'cesium'

import {
  columnLabel, fetchColumnGroupBy, fetchColumns, fetchColumnStats, fetchTableCount, type Column, type ColumnStats,
} from './columns'
import { DASHBOARD_HIGHLIGHT_COLOR, panelBorder, SELECTION_COLOR } from './colorScheme'
import { useDashboardHighlight } from './dashboardHighlight'
import { buildCql } from './filter'
import {
  fetchAllFeatures, fetchFeaturesInBbox, fetchFeaturesWithFilter, SELECTION_FETCH_CAP, type Feature,
} from './features'
import { useTools } from './tools'
import { useSelectCandidates } from './ToolboxControls'
import { collectionFor, useApp, type LayerFilter } from './wms'
import { useSelection, type SelectedEntry } from './selection'

/** A layer's active filter, or null if it has none — or none of its conditions are
 * actually usable (mirrors filter.ts's buildCql()'s own "usable" check). Shared by
 * LayerOverviewCard and SelectionDashboardPanel so both agree on what counts as
 * "this layer has a filter applied" for their fetches and filter indicators. */
function usableFilter(filter: LayerFilter | undefined): LayerFilter | null {
  if (!filter || !buildCql(filter.conditions, filter.logic)) return null
  return filter
}

const TOP_N = 8

// One deliberate, small categorical palette — starts with the app's own
// blue/amber (SELECTION_COLOR + accentEdge's amber stop) so the first two
// layers picked land on colors already meaningful elsewhere in the UI,
// then extends with a few more hues distinguishable in both color schemes.
const LAYER_PALETTE = ['#40c4ff', '#f59f00', '#f43f5e', '#a78bfa', '#34d399', '#fb923c', '#22d3ee', '#f472b6']

function layerColor(name: string): string {
  let hash = 0
  for (let i = 0; i < name.length; i++) hash = (hash * 31 + name.charCodeAt(i)) >>> 0
  return LAYER_PALETTE[hash % LAYER_PALETTE.length]
}

function hexAlpha(hex: string, alpha: number): string {
  const r = parseInt(hex.slice(1, 3), 16)
  const g = parseInt(hex.slice(3, 5), 16)
  const b = parseInt(hex.slice(5, 7), 16)
  return `rgba(${r},${g},${b},${alpha})`
}

interface Bucket {
  label: string
  count: number
  entries: SelectedEntry[]
  /** Only ever set on the synthetic "Andere" bucket — the individual values
   * that got folded into it, kept around so BreakdownColumns can unfold
   * them again on demand instead of only ever showing the summed total. */
  hidden?: Bucket[]
}

type ChartType = 'bar' | 'pie' | 'donut'

const NUMBER_FORMAT = new Intl.NumberFormat('de-DE', { maximumFractionDigits: 2 })

function fmt(n: number): string {
  return NUMBER_FORMAT.format(n)
}

function csvEscape(v: unknown): string {
  const s = String(v ?? '')
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

function downloadCsv(filenameBase: string, features: Feature[]) {
  const keys = Array.from(new Set(features.flatMap((f) => Object.keys(f.properties))))
  const lines = [
    keys.join(','),
    ...features.map((f) => keys.map((k) => csvEscape(f.properties[k])).join(',')),
  ]
  const blob = new Blob([lines.join('\n')], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = `${filenameBase.replace(/[^a-z0-9]+/gi, '_').toLowerCase() || 'auswahl'}.csv`
  a.click()
  URL.revokeObjectURL(url)
}

/** Top-N by count + an exact "Andere" remainder — same bucketing math
 * LayerSummary's own breakdown uses, generalized for a plain {label, count}
 * shape with no real entries behind it (LayerOverviewCard's server-side
 * group-by). `exactTotal` (from /column-groupby's totalCount) lets "Andere"
 * be exact even when the server capped the bucket list itself. */
/** A plain label+count pair, optionally carrying the individual values that
 * got folded into it — only ever set on a synthetic "Andere" bucket, same
 * idea as `Bucket.hidden` for the entries-bearing shape. */
interface CountBucket {
  label: string
  count: number
  hidden?: CountBucket[]
}

function bucketTopN(items: { label: string; count: number }[], exactTotal: number): CountBucket[] {
  const sorted = [...items].sort((a, b) => b.count - a.count)
  if (sorted.length <= TOP_N) return sorted
  const top = sorted.slice(0, TOP_N)
  const rest = sorted.slice(TOP_N)
  const topSum = top.reduce((n, r) => n + r.count, 0)
  return [...top, { label: 'Andere', count: exactTotal - topSum, hidden: rest }]
}

/** One formatted number in its own rounded, tinted box — the numeric
 * aggregates used to be a single "Σ12345 · ø67.8 · 0–999" line of plain
 * text; this is what replaced it, one box per value instead. */
function StatBox({ value, color }: { value: string; color: string }) {
  return (
    <Box
      style={{
        borderRadius: 6,
        padding: '3px 6px',
        textAlign: 'center',
        backgroundColor: hexAlpha(color, 0.12),
        border: `1px solid ${hexAlpha(color, 0.35)}`,
      }}
    >
      <Text size="xs" ff="monospace" fw={600} truncate>{value}</Text>
    </Box>
  )
}

/** Numeric aggregates as an actual grid — one row per numeric column, one
 * boxed StatBox per stat, all sharing the same four stat columns (Σ/Ø/Min/
 * Max) so every row's boxes line up like a real table without needing a
 * literal <table> (a CSS grid gets the same alignment far more simply,
 * since every "row" here is just four more grid children, no <tr>/<td>
 * bookkeeping). `stats` is null while a card is still waiting on the
 * fetch that fills it in (LayerOverviewCard's per-column /column-stats
 * call) — LayerSummary's real-selection aggregates are computed
 * synchronously and never hit that branch. Shared by both so this fairly
 * involved layout exists once, not twice. */
function AggregatesTable({
  rows, color,
}: {
  rows: { key: string; label: string; stats: { sum: number; avg: number; min: number; max: number } | null }[]
  color: string
}) {
  if (rows.length === 0) return null
  return (
    <Box
      mt={4}
      style={{
        display: 'grid',
        gridTemplateColumns: 'minmax(0,1fr) repeat(4, minmax(52px, 1fr))',
        gap: 4,
        alignItems: 'center',
      }}
    >
      <div />
      {['Σ', 'Ø', 'Min', 'Max'].map((h) => (
        <Text key={h} size="9px" c="dimmed" fw={700} ta="center" tt="uppercase" style={{ letterSpacing: '0.04em' }}>
          {h}
        </Text>
      ))}
      {rows.map((r) => (
        <Fragment key={r.key}>
          <Text size="xs" c="dimmed" truncate>{r.label}</Text>
          {r.stats ? (
            <>
              <StatBox value={fmt(r.stats.sum)} color={color} />
              <StatBox value={fmt(r.stats.avg)} color={color} />
              <StatBox value={fmt(r.stats.min)} color={color} />
              <StatBox value={fmt(r.stats.max)} color={color} />
            </>
          ) : (
            <Text size="xs" c="dimmed" style={{ gridColumn: 'span 4' }}>lädt…</Text>
          )}
        </Fragment>
      ))}
    </Box>
  )
}

/** The row-list-plus-chart block shared by LayerSummary (a real selection's
 * in-memory breakdown) and LayerOverviewCard (a server-side group-by) —
 * both reduce to the same plain {label, count}[] by the time they get here,
 * so this never needs to know which mode produced them. Callers resolve a
 * clicked row's label back to whatever richer data (real entries, or an
 * on-demand fetch) their own mode needs. */
function BreakdownColumns({
  buckets, color, chartType, setChartType, showLabels, setShowLabels, highlightedLabel, loadingLabel,
  onRowClick, onDrillThrough, drillThroughTooltip, donutCenterLabel,
}: {
  buckets: CountBucket[]
  color: string
  chartType: ChartType
  setChartType: (t: ChartType) => void
  showLabels: boolean
  setShowLabels: (v: boolean) => void
  highlightedLabel: string | null
  loadingLabel?: string | null
  onRowClick: (label: string) => void
  onDrillThrough?: (label: string) => void
  drillThroughTooltip?: string
  donutCenterLabel: string
}) {
  const [andereOpen, setAndereOpen] = useState(false)
  const maxCount = buckets.length > 0 ? Math.max(...buckets.map((b) => b.count)) : 0
  // Every bucket here already sums to the layer's real total (Andere's own
  // count is exactly "everything not in the top N"), so this is the right
  // denominator for a percentage next to each count, no separate total prop
  // needed from either caller.
  const total = buckets.reduce((n, b) => n + b.count, 0)
  const pct = (count: number) => (total > 0 ? Math.round((count / total) * 100) : 0)
  const pieData = useMemo(
    () => buckets.map((b, i) => ({ name: b.label, value: b.count, color: LAYER_PALETTE[i % LAYER_PALETTE.length] })),
    [buckets],
  )

  if (buckets.length === 0) return null

  function row(b: CountBucket, indent: boolean) {
    const isHighlighted = highlightedLabel === b.label
    const isLoading = loadingLabel === b.label
    const isAndere = b.label === 'Andere' && !!b.hidden?.length
    return (
      <Tooltip key={b.label} label="Auf der Karte hervorheben" withArrow position="left" openDelay={400}>
        <Group
          justify="space-between"
          gap={6}
          wrap="nowrap"
          onClick={(e) => { e.stopPropagation(); onRowClick(b.label) }}
          style={{
            cursor: 'pointer',
            position: 'relative',
            borderRadius: 4,
            padding: '1px 4px',
            paddingLeft: indent ? 16 : 4,
            boxShadow: isHighlighted ? `inset 0 0 0 1px ${DASHBOARD_HIGHLIGHT_COLOR}` : undefined,
          }}
        >
          <Box
            style={{
              position: 'absolute',
              inset: 0,
              width: `${(b.count / maxCount) * 100}%`,
              backgroundColor: hexAlpha(color, 0.16),
              borderRadius: 4,
            }}
          />
          <Group gap={2} wrap="nowrap" style={{ position: 'relative', minWidth: 0 }}>
            {isAndere && (
              <ActionIcon
                variant="transparent" size="xs" aria-label={andereOpen ? 'Andere einklappen' : 'Andere aufklappen'}
                onClick={(e) => { e.stopPropagation(); setAndereOpen((o) => !o) }}
                style={{ flexShrink: 0 }}
              >
                <IconChevronRight size={12} style={{ transform: andereOpen ? 'rotate(90deg)' : undefined, transition: 'transform 150ms' }} />
              </ActionIcon>
            )}
            <Text size="xs" c="dimmed" truncate>{b.label}</Text>
          </Group>
          <Group gap={2} wrap="nowrap" style={{ position: 'relative' }}>
            <Text size="xs" fw={600}>{b.count}</Text>
            <Text size="9px" c="dimmed">{pct(b.count)}%</Text>
            {isLoading && <Loader size={10} />}
            {!isLoading && onDrillThrough && (
              <Tooltip label={drillThroughTooltip ?? 'In Tabelle öffnen'} withArrow>
                <ActionIcon
                  variant="subtle" size="xs" aria-label="In Tabelle öffnen"
                  onClick={(e) => { e.stopPropagation(); onDrillThrough(b.label) }}
                >
                  <IconExternalLink size={11} />
                </ActionIcon>
              </Tooltip>
            )}
          </Group>
        </Group>
      </Tooltip>
    )
  }

  return (
    // Two-column split: the breakdown rows (a data table, in effect) on the
    // left, the diagram that visualizes the same data on the right — the
    // standard dashboard-card pairing, rather than stacking the chart above
    // the rows. Wraps to a single column once the detail pane itself gets
    // narrow (SelectionDashboardPanel's nav list takes a fixed slice of the
    // width, so this can happen well before the whole panel is narrow).
    <Group align="flex-start" gap="md" wrap="wrap" mt={6}>
      <Stack gap={2} style={{ flex: '1 1 200px', minWidth: 180 }}>
        {buckets.map((b) => (
          <Fragment key={b.label}>
            {row(b, false)}
            {b.label === 'Andere' && andereOpen && b.hidden?.map((h) => row(h, true))}
          </Fragment>
        ))}
      </Stack>

      <Stack gap={6} style={{ flex: '1 1 200px', minWidth: 200 }}>
        <SegmentedControl
          size="xs"
          fullWidth
          data={[
            { label: 'Balken', value: 'bar' },
            { label: 'Kreis', value: 'pie' },
            { label: 'Ring', value: 'donut' },
          ]}
          value={chartType}
          onChange={(v) => setChartType(v as ChartType)}
        />
        <Switch
          size="xs"
          label="Beschriftungen"
          checked={showLabels}
          onChange={(e) => setShowLabels(e.currentTarget.checked)}
        />
        {chartType === 'bar' && (
          <BarChart
            h={220}
            w="100%"
            // Same per-segment LAYER_PALETTE cycling pieData uses, via each
            // row's own `color` field — Mantine's BarChart prefers that over
            // the flat `series` color below (which stays only as a fallback)
            // whenever it's present, one <Cell> per bar under the hood.
            data={buckets.map((b, i) => ({ label: b.label, count: b.count, color: LAYER_PALETTE[i % LAYER_PALETTE.length] }))}
            dataKey="label"
            series={[{ name: 'count', color }]}
            withLegend={false}
            withTooltip
            gridAxis="y"
            withBarValueLabel={showLabels}
            barProps={{ radius: 3, onClick: (_, index) => onRowClick(buckets[index].label) }}
          />
        )}
        {(chartType === 'pie' || chartType === 'donut') && (
          // PieChart/DonutChart have no native `withLegend` (unlike BarChart,
          // which deliberately skips one — its bars are already self-labeled
          // by the x-axis) — this is a small hand-built stand-in, placed
          // beside the chart rather than under it, one swatch per segment in
          // the exact colors pieData already assigns them.
          <Group align="center" wrap="nowrap" gap="md" justify="center">
            {chartType === 'pie' && (
              <PieChart
                data={pieData}
                size={180}
                withTooltip
                tooltipDataSource="segment"
                withLabels={showLabels}
                pieProps={{ onClick: (_, index) => onRowClick(buckets[index].label) }}
              />
            )}
            {chartType === 'donut' && (
              <DonutChart
                data={pieData}
                size={180}
                thickness={28}
                chartLabel={donutCenterLabel}
                withTooltip
                tooltipDataSource="segment"
                withLabels={showLabels}
                pieProps={{ onClick: (_, index) => onRowClick(buckets[index].label) }}
              />
            )}
            <Stack gap={4} style={{ minWidth: 0 }}>
              {pieData.map((d) => (
                <Group key={d.name} gap={4} wrap="nowrap">
                  <Box style={{ width: 8, height: 8, borderRadius: '50%', backgroundColor: d.color, flexShrink: 0 }} />
                  <Text size="9px" c="dimmed" truncate style={{ maxWidth: 100 }}>{d.name}</Text>
                </Group>
              ))}
            </Stack>
          </Group>
        )}
      </Stack>
    </Group>
  )
}

/** One row in the dashboard's left-hand layer list — the master in the
 * master-detail layout that replaced the old grid of collapsible cards.
 * `count` is `null` while LayerOverviewCard's async row count hasn't
 * resolved yet (a real selection's `entries.length` is always known
 * synchronously, so this only ever shows "…" in overview mode). */
function LayerNavRow({
  title, color, count, active, hasFilter, onClick,
}: {
  title: string
  color: string
  count: number | null
  active: boolean
  hasFilter?: boolean
  onClick: () => void
}) {
  return (
    <Group
      gap={6}
      wrap="nowrap"
      onClick={onClick}
      style={{
        cursor: 'pointer',
        padding: '4px 6px',
        borderRadius: 6,
        backgroundColor: active ? hexAlpha(color, 0.16) : undefined,
        boxShadow: active ? `inset 0 0 0 1px ${hexAlpha(color, 0.5)}` : undefined,
      }}
    >
      <Box style={{ width: 3, alignSelf: 'stretch', minHeight: 16, borderRadius: 2, backgroundColor: color, flexShrink: 0 }} />
      <Text size="xs" c={active ? undefined : 'dimmed'} fw={active ? 600 : 400} truncate style={{ flex: 1, minWidth: 0 }}>
        {title}
      </Text>
      {hasFilter && (
        <Tooltip label="Filter aktiv" withArrow>
          <IconFilter size={11} style={{ flexShrink: 0, opacity: 0.7 }} />
        </Tooltip>
      )}
      <Text size="xs" fw={600}>{count === null ? '…' : count}</Text>
    </Group>
  )
}

/** Sum/avg/min/max per numeric column, computed straight from real
 * in-memory entries — LayerSummary's own aggregates for a real selection,
 * and LayerOverviewCard's Kartenansicht mode's (a viewport-bounded fetch's
 * entries are just as real, only their provenance differs). */
function computeAggregates(entries: SelectedEntry[], numericCols: Column[]) {
  return numericCols
    .map((c) => {
      const values = entries
        .map((e) => e.feature.properties[c.key])
        .filter((v): v is number => typeof v === 'number')
      if (values.length === 0) return null
      const sum = values.reduce((a, b) => a + b, 0)
      return { key: c.key, sum, avg: sum / values.length, min: Math.min(...values), max: Math.max(...values) }
    })
    .filter((a): a is NonNullable<typeof a> => a !== null)
}

/** Grouped by distinct value, then capped to the top N by count — the rest
 * collapse into one "Andere" bucket (its own entries kept, so it stays
 * clickable/drill-through-able like any real value) so neither the chart
 * nor the row list ever has to render an unreadable, high-cardinality list.
 * Shared by LayerSummary (a real selection) and LayerOverviewCard's
 * Kartenansicht mode (a viewport-bounded fetch) — both have real entries to
 * group, unlike LayerOverviewCard's Alle-Zeilen mode, which only ever gets
 * `{label, count}` back from the server (see bucketTopN above instead). */
function computeEntryBreakdown(entries: SelectedEntry[], groupBy: string): Bucket[] {
  const groups = new Map<string, SelectedEntry[]>()
  for (const e of entries) {
    const raw = e.feature.properties[groupBy]
    const label = raw === null || raw === undefined || raw === '' ? '(leer)' : String(raw)
    const arr = groups.get(label)
    if (arr) arr.push(e)
    else groups.set(label, [e])
  }
  const sorted = Array.from(groups.entries())
    .map(([label, es]) => ({ label, count: es.length, entries: es }))
    .sort((a, b) => b.count - a.count)
  if (sorted.length <= TOP_N) return sorted
  const top = sorted.slice(0, TOP_N)
  const rest = sorted.slice(TOP_N)
  return [...top, {
    label: 'Andere',
    count: rest.reduce((n, r) => n + r.count, 0),
    entries: rest.flatMap((r) => r.entries),
    hidden: rest,
  }]
}

function LayerSummary({
  layerName, title, entries, totalSelected, isActive,
}: {
  layerName: string
  title: string
  entries: SelectedEntry[]
  totalSelected: number
  isActive: boolean
}) {
  const dynamicCollections = useApp((s) => s.dynamicCollections)
  const layerConfigs = useApp((s) => s.layerConfigs)
  const replaceSelectionForLayers = useSelection((s) => s.replaceSelectionForLayers)
  const openLayerTab = useSelection((s) => s.openLayerTab)
  const highlight = useDashboardHighlight()
  const aliases = layerConfigs[layerName]?.columnAliases || {}
  const collection = collectionFor(layerName, dynamicCollections)
  const color = layerColor(layerName)

  const [columns, setColumns] = useState<Column[] | null>(null)
  const [colError, setColError] = useState<string | null>(null)
  const [groupBy, setGroupBy] = useState<string | null>(null)
  // Per layer, not global — a layer with a handful of categories often reads
  // better as a pie/donut, while one capped to the top 8 + "Andere" often
  // reads better as a bar; local state here (alongside groupBy) means each
  // layer's choice survives switching to another layer in the nav list and
  // back, since every layer's detail component stays mounted underneath
  // (see SelectionDashboardPanel's isActive handling below).
  const [chartType, setChartType] = useState<ChartType>('bar')
  const [showLabels, setShowLabels] = useState(true)

  // Fetched once, lazily, the first time this layer becomes the active one
  // in the nav list — not eagerly for every layer with a selection.
  useEffect(() => {
    if (!isActive || columns || !collection) return
    fetchColumns(collection)
      .then(setColumns)
      .catch((e) => setColError(e instanceof Error ? e.message : String(e)))
  }, [isActive, columns, collection])

  const numericCols = columns?.filter((c) => c.numeric) ?? []
  const categoricalCols = columns?.filter((c) => !c.numeric) ?? []

  const aggregates = useMemo(() => computeAggregates(entries, numericCols), [numericCols, entries])

  const breakdown = useMemo<Bucket[] | null>(
    () => (groupBy ? computeEntryBreakdown(entries, groupBy) : null),
    [groupBy, entries],
  )

  const share = totalSelected > 0 ? (entries.length / totalSelected) * 100 : 0
  // Flattens in "Andere"'s own hidden entries too, so clicking one of them
  // once unfolded (BreakdownColumns) resolves exactly like a top-level row.
  const bucketByLabel = useMemo(
    () => new Map((breakdown ?? []).flatMap((b) => [b, ...(b.hidden ?? [])]).map((b) => [b.label, b])),
    [breakdown],
  )

  // Non-destructive: previews a breakdown value on the map via its own,
  // separate highlight (see dashboardHighlight.ts) rather than overriding
  // the real selection — clicking the already-active bucket again clears it.
  function toggleHighlight(bucket: Bucket) {
    if (highlight.layerName === layerName && highlight.label === bucket.label) {
      highlight.clearHighlight()
    } else {
      highlight.setHighlight(layerName, bucket.label, bucket.entries)
    }
  }

  function drillThrough(bucket: Bucket) {
    if (!collection) return
    replaceSelectionForLayers([layerName], bucket.entries)
    openLayerTab({ name: layerName, collection })
  }

  return (
    <Box style={{ display: isActive ? 'block' : 'none' }}>
      <Group gap={6} wrap="nowrap">
        <Box style={{ width: 3, alignSelf: 'stretch', minHeight: 18, borderRadius: 2, backgroundColor: color }} />
        <RingProgress size={22} thickness={3} roundCaps sections={[{ value: share, color }]} />
        <Text size="xs" c="dimmed" truncate style={{ flex: 1, minWidth: 0 }}>{title}</Text>
        <Text size="xs" fw={700}>{entries.length}</Text>
        <Tooltip label="Als CSV exportieren" withArrow>
          <ActionIcon
            variant="subtle" size="xs" aria-label="Als CSV exportieren"
            onClick={() => downloadCsv(title, entries.map((en) => en.feature))}
          >
            <IconDownload size={12} />
          </ActionIcon>
        </Tooltip>
      </Group>
      <Box pt={8}>
        {!collection && <Text size="xs" c="dimmed">Keine Attribute verfügbar</Text>}
        {colError && <Text size="xs" c="red">{colError}</Text>}
        <AggregatesTable
          rows={aggregates.map((a) => ({ key: a.key, label: columnLabel(aliases, a.key), stats: a }))}
          color={color}
        />
        {categoricalCols.length > 0 && (
          <>
            <Select
              size="xs"
              mt={4}
              placeholder="Gruppieren nach…"
              clearable
              data={categoricalCols.map((c) => ({ value: c.key, label: columnLabel(aliases, c.key) }))}
              value={groupBy}
              onChange={setGroupBy}
              comboboxProps={{ withinPortal: false }}
            />
            {breakdown && (
              <BreakdownColumns
                buckets={breakdown}
                color={color}
                chartType={chartType}
                setChartType={setChartType}
                showLabels={showLabels}
                setShowLabels={setShowLabels}
                highlightedLabel={highlight.layerName === layerName ? highlight.label : null}
                onRowClick={(label) => {
                  const b = bucketByLabel.get(label)
                  if (b) toggleHighlight(b)
                }}
                onDrillThrough={collection ? (label) => {
                  const b = bucketByLabel.get(label)
                  if (b) drillThrough(b)
                } : undefined}
                drillThroughTooltip="In Tabelle öffnen (ersetzt die Auswahl)"
                donutCenterLabel={String(entries.length)}
              />
            )}
          </>
        )}
      </Box>
    </Box>
  )
}

/**
 * The "everything selected" counterpart to LayerSummary — same visual
 * chrome, but backed by upload-api's SQL aggregates instead of a real
 * selection's in-memory features (see this file's v8 doc note). `count`
 * arrives from the panel (fetched once per visible layer, shared so the
 * RingProgress "share" below has a real cross-layer denominator); every
 * other number is fetched lazily, same trigger points LayerSummary already
 * uses (expand for columns, picking a column for its stats/breakdown).
 */
function LayerOverviewCard({
  layerName, title, collection, count, totalVisibleCount, isActive,
}: {
  layerName: string
  title: string
  collection: string
  count: number | null
  totalVisibleCount: number
  isActive: boolean
}) {
  const layerConfigs = useApp((s) => s.layerConfigs)
  const replaceSelectionForLayers = useSelection((s) => s.replaceSelectionForLayers)
  const openLayerTab = useSelection((s) => s.openLayerTab)
  const highlight = useDashboardHighlight()
  const camera = useApp((s) => s.camera)
  const aliases = layerConfigs[layerName]?.columnAliases || {}
  const color = layerColor(layerName)
  const [schema, table] = collection.split(/\.(.+)/)

  // This layer's active attribute filter (AttributeFilter.tsx/wms.ts), if
  // any — makes "everything selected" mean "everything matching the
  // filter" instead of the whole table, in both view modes below.
  const activeFilter = usableFilter(useApp((s) => s.attributeFilters[layerName]))
  const filterCql = useMemo(
    () => (activeFilter ? buildCql(activeFilter.conditions, activeFilter.logic) : null),
    [activeFilter],
  )

  // Kartenansicht (default) vs Alle Zeilen — same toggle/labels as
  // AttributeTable.tsx's. Alle Zeilen's own headline count (`count`, the
  // prop) is already pre-fetched by the panel for every visible overview
  // layer the moment overview mode is shown, not just the active one, so
  // switching to Alle Zeilen never has to wait on that number — only its
  // per-column stats/breakdown are still fetched lazily, same as before.
  const [viewMode, setViewMode] = useState<'viewport' | 'all'>('viewport')

  const [columns, setColumns] = useState<Column[] | null>(null)
  const [colError, setColError] = useState<string | null>(null)
  const [groupBy, setGroupBy] = useState<string | null>(null)
  const [chartType, setChartType] = useState<ChartType>('bar')
  const [showLabels, setShowLabels] = useState(true)
  const [numericStats, setNumericStats] = useState<Record<string, ColumnStats>>({})
  const [groupBuckets, setGroupBuckets] = useState<{ label: string; count: number }[] | null>(null)
  const [groupError, setGroupError] = useState<string | null>(null)
  const [loadingLabel, setLoadingLabel] = useState<string | null>(null)
  const [exporting, setExporting] = useState(false)

  // Kartenansicht's own data — real features fetched within the current map
  // view (same bounded fetchFeaturesInBbox/cap the real select tools use),
  // recomputed on camera.changed exactly like AttributeTable.tsx's own
  // "Kartenansicht" mode. Having real entries here (unlike Alle Zeilen,
  // which only ever gets `{label, count}` back from the server) means
  // aggregates/breakdown reuse LayerSummary's own math (computeAggregates/
  // computeEntryBreakdown) and highlight/drill-through/CSV export are all
  // synchronous — no fetch-on-click needed.
  const [viewVersion, setViewVersion] = useState(0)
  const [viewportEntries, setViewportEntries] = useState<SelectedEntry[]>([])
  const [viewportTruncated, setViewportTruncated] = useState(false)
  const [viewportLoading, setViewportLoading] = useState(false)
  const [viewportError, setViewportError] = useState<string | null>(null)

  useEffect(() => {
    if (!isActive || viewMode !== 'viewport' || !camera) return
    camera.percentageChanged = 0.1
    const update = () => setViewVersion((v) => v + 1)
    const remove = camera.changed.addEventListener(update)
    return () => remove()
  }, [isActive, viewMode, camera])

  useEffect(() => {
    if (!isActive || viewMode !== 'viewport') return
    const controller = new AbortController()
    setViewportLoading(true)
    setViewportError(null)
    // Camera not looking at the globe at all — an empty result rather than
    // an error, self-corrects on the next camera.changed tick.
    const rect = camera?.computeViewRectangle()
    if (!rect) {
      setViewportEntries([])
      setViewportTruncated(false)
      setViewportLoading(false)
      return
    }
    const bbox = {
      west: CesiumMath.toDegrees(rect.west),
      south: CesiumMath.toDegrees(rect.south),
      east: CesiumMath.toDegrees(rect.east),
      north: CesiumMath.toDegrees(rect.north),
    }
    fetchFeaturesInBbox(collection, bbox, controller.signal, filterCql ?? undefined)
      .then(({ features, truncated }) => {
        setViewportEntries(features.map((feature) => ({ layer: layerName, feature })))
        setViewportTruncated(truncated)
        setViewportLoading(false)
      })
      .catch((e) => {
        if (controller.signal.aborted) return
        setViewportError(e instanceof Error ? e.message : String(e))
        setViewportLoading(false)
      })
    return () => controller.abort()
  }, [isActive, viewMode, collection, layerName, viewVersion, camera, filterCql])

  useEffect(() => {
    if (!isActive || columns) return
    fetchColumns(collection)
      .then(setColumns)
      .catch((e) => setColError(e instanceof Error ? e.message : String(e)))
  }, [isActive, columns, collection])

  const numericCols = columns?.filter((c) => c.numeric) ?? []
  const categoricalCols = columns?.filter((c) => !c.numeric) ?? []

  // A filter change invalidates every cached Alle-Zeilen numeric stat — the
  // effect below caches per column key with no knowledge of the filter, so
  // without this a stat fetched before a filter was set/changed would stick
  // around stale instead of being refetched under the new WHERE.
  useEffect(() => {
    setNumericStats({})
  }, [activeFilter])

  // One SQL aggregate per numeric column, lazily once the column list is in
  // — Alle Zeilen only; mirrors LayerSummary's aggregates, just server-side
  // instead of a client-side reduce over in-memory entries.
  useEffect(() => {
    if (!isActive || viewMode !== 'all') return
    for (const c of numericCols) {
      if (c.key in numericStats) continue
      fetchColumnStats(schema, table, c.key, activeFilter)
        .then((stats) => setNumericStats((s) => ({ ...s, [c.key]: stats })))
        .catch(() => setNumericStats((s) => ({ ...s, [c.key]: s[c.key] })))
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isActive, viewMode, numericCols, schema, table, activeFilter])

  useEffect(() => {
    if (viewMode !== 'all' || !groupBy) { setGroupBuckets(null); return }
    setGroupError(null)
    fetchColumnGroupBy(schema, table, groupBy, activeFilter)
      .then((r) => setGroupBuckets(bucketTopN(r.buckets.map((b) => ({ label: b.value, count: b.count })), r.totalCount)))
      .catch((e) => setGroupError(e instanceof Error ? e.message : String(e)))
  }, [viewMode, groupBy, schema, table, activeFilter])

  const viewportAggregates = useMemo(() => computeAggregates(viewportEntries, numericCols), [viewportEntries, numericCols])
  const viewportBuckets = useMemo<Bucket[] | null>(
    () => (groupBy ? computeEntryBreakdown(viewportEntries, groupBy) : null),
    [groupBy, viewportEntries],
  )
  const viewportBucketByLabel = useMemo(
    () => new Map((viewportBuckets ?? []).flatMap((b) => [b, ...(b.hidden ?? [])]).map((b) => [b.label, b])),
    [viewportBuckets],
  )

  const displayCount = viewMode === 'viewport' ? viewportEntries.length : count
  const share = totalVisibleCount > 0 && displayCount !== null ? (displayCount / totalVisibleCount) * 100 : 0

  function toggleViewportHighlight(bucket: Bucket) {
    if (highlight.layerName === layerName && highlight.label === bucket.label) {
      highlight.clearHighlight()
    } else {
      highlight.setHighlight(layerName, bucket.label, bucket.entries)
    }
  }

  // A bucket here is only ever a label+count — there's no real Feature
  // behind it until something actually needs one, which only happens on a
  // click (highlight or drill-through): fetch just that value's matching
  // rows via the same bounded/capped query the real select tools already
  // use, then hand the result to the exact same primitives a real
  // selection's row click/drill-through use. "Andere" has no single CQL
  // condition that means "everything not in the top N" without deeper
  // filter.ts changes, so it's shown but not clickable. Alle Zeilen only —
  // Kartenansicht already has every bucket's real entries in memory.
  async function fetchBucketEntries(label: string): Promise<SelectedEntry[] | null> {
    if (!groupBy) return null
    const cql = buildCql([{ column: groupBy, op: 'eq', value: label }], 'and')
    if (!cql) return null
    const { features } = await fetchFeaturesWithFilter(collection, cql)
    return features.map((feature) => ({ layer: layerName, feature }))
  }

  async function onRowClick(label: string) {
    if (label === 'Andere') return
    if (highlight.layerName === layerName && highlight.label === label) {
      highlight.clearHighlight()
      return
    }
    setLoadingLabel(label)
    const entries = await fetchBucketEntries(label)
    setLoadingLabel(null)
    if (entries) highlight.setHighlight(layerName, label, entries)
  }

  async function onDrillThrough(label: string) {
    if (label === 'Andere') return
    setLoadingLabel(label)
    const entries = await fetchBucketEntries(label)
    setLoadingLabel(null)
    if (entries) {
      replaceSelectionForLayers([layerName], entries)
      openLayerTab({ name: layerName, collection })
    }
  }

  async function exportCsv() {
    if (viewMode === 'viewport') {
      downloadCsv(title, viewportEntries.map((e) => e.feature))
      return
    }
    setExporting(true)
    try {
      const { features } = await fetchAllFeatures(collection, undefined, filterCql ?? undefined)
      downloadCsv(title, features)
    } finally {
      setExporting(false)
    }
  }

  const csvTooltip = viewMode === 'viewport'
    ? (viewportTruncated ? `Als CSV exportieren (erste ${SELECTION_FETCH_CAP} im Kartenausschnitt)` : 'Als CSV exportieren')
    : (count !== null && count > SELECTION_FETCH_CAP
      ? `Als CSV exportieren (erste ${SELECTION_FETCH_CAP} von ${count})`
      : 'Als CSV exportieren')

  return (
    <Box style={{ display: isActive ? 'block' : 'none' }}>
      <Group gap={6} wrap="nowrap">
        <Box style={{ width: 3, alignSelf: 'stretch', minHeight: 18, borderRadius: 2, backgroundColor: color }} />
        <RingProgress size={22} thickness={3} roundCaps sections={[{ value: share, color }]} />
        <Text size="xs" c="dimmed" truncate style={{ flex: 1, minWidth: 0 }}>{title}</Text>
        {activeFilter && (
          <Tooltip label="Filter aktiv — zeigt nur passende Zeilen" withArrow>
            <IconFilter size={12} style={{ flexShrink: 0, opacity: 0.75 }} />
          </Tooltip>
        )}
        <Text size="xs" fw={700}>
          {viewMode === 'viewport' ? (viewportLoading ? '…' : displayCount) : (count === null ? '…' : count)}
        </Text>
        <Tooltip label={csvTooltip} withArrow>
          <ActionIcon
            variant="subtle" size="xs" aria-label="Als CSV exportieren" disabled={exporting}
            onClick={() => void exportCsv()}
          >
            {exporting ? <Loader size={12} /> : <IconDownload size={12} />}
          </ActionIcon>
        </Tooltip>
      </Group>
      <SegmentedControl
        size="xs"
        mt={6}
        fullWidth
        value={viewMode}
        onChange={(v) => setViewMode(v as 'viewport' | 'all')}
        data={[
          { label: 'Kartenansicht', value: 'viewport' },
          { label: 'Alle Zeilen', value: 'all' },
        ]}
      />
      {viewMode === 'viewport' && viewportTruncated && (
        <Text size="9px" c="dimmed" mt={2}>Zeigt nur einen Ausschnitt — weiter einzoomen für Vollständigkeit.</Text>
      )}
      {viewMode === 'viewport' && viewportError && <Text size="xs" c="red" mt={4}>{viewportError}</Text>}
      <Box pt={8}>
        {colError && <Text size="xs" c="red">{colError}</Text>}
        {viewMode === 'viewport' ? (
          <AggregatesTable
            rows={viewportAggregates.map((a) => ({ key: a.key, label: columnLabel(aliases, a.key), stats: a }))}
            color={color}
          />
        ) : (
          <AggregatesTable
            rows={numericCols.map((c) => ({ key: c.key, label: columnLabel(aliases, c.key), stats: numericStats[c.key] ?? null }))}
            color={color}
          />
        )}
        {categoricalCols.length > 0 && (
          <>
            <Select
              size="xs"
              mt={4}
              placeholder="Gruppieren nach…"
              clearable
              data={categoricalCols.map((c) => ({ value: c.key, label: columnLabel(aliases, c.key) }))}
              value={groupBy}
              onChange={setGroupBy}
              comboboxProps={{ withinPortal: false }}
            />
            {viewMode === 'all' && groupError && <Text size="xs" c="red" mt={4}>{groupError}</Text>}
            {viewMode === 'viewport' && viewportBuckets && (
              <BreakdownColumns
                buckets={viewportBuckets}
                color={color}
                chartType={chartType}
                setChartType={setChartType}
                showLabels={showLabels}
                setShowLabels={setShowLabels}
                highlightedLabel={highlight.layerName === layerName ? highlight.label : null}
                onRowClick={(label) => {
                  const b = viewportBucketByLabel.get(label)
                  if (b) toggleViewportHighlight(b)
                }}
                onDrillThrough={(label) => {
                  const b = viewportBucketByLabel.get(label)
                  if (!b) return
                  replaceSelectionForLayers([layerName], b.entries)
                  openLayerTab({ name: layerName, collection })
                }}
                drillThroughTooltip="In Tabelle öffnen (ersetzt die Auswahl)"
                donutCenterLabel={String(viewportEntries.length)}
              />
            )}
            {viewMode === 'all' && groupBuckets && (
              <BreakdownColumns
                buckets={groupBuckets}
                color={color}
                chartType={chartType}
                setChartType={setChartType}
                showLabels={showLabels}
                setShowLabels={setShowLabels}
                highlightedLabel={highlight.layerName === layerName ? highlight.label : null}
                loadingLabel={loadingLabel}
                onRowClick={onRowClick}
                onDrillThrough={onDrillThrough}
                drillThroughTooltip="In Tabelle öffnen (ersetzt die Auswahl)"
                donutCenterLabel={count === null ? '' : String(count)}
              />
            )}
          </>
        )}
      </Box>
    </Box>
  )
}

// Exported rather than kept local — DataViewBand.tsx renders this in its own
// tab-strip header row (next to the maximize button), not this file, so it's
// visible right in the band's header instead of taking up space inside the
// dashboard's own scrollable body. Still lives here since it's dashboard-only
// UI (only DataViewBand renders it, gated on `dashboardTabActive`) and shares
// this file's other imports. Reuses ToolboxControls.tsx's exact button block
// and shares its state, so this copy and the floating toolbox's copy can
// never disagree.
export function SelectToolsRow() {
  const { setIdentify, setMeasure } = useTools()
  const selectMode = useSelection((s) => s.mode)
  const setSelectMode = useSelection((s) => s.setMode)
  const selectScope = useSelection((s) => s.scope)
  const selected = useSelection((s) => s.selected)
  const clearSelection = useSelection((s) => s.clearSelection)
  const selectCandidates = useSelectCandidates()

  return (
    <Group gap={6} wrap="nowrap">
      {(['point', 'circle', 'polygon'] as const).map((m) => {
        const icon = m === 'point' ? <IconClick size={15} /> : m === 'circle' ? <IconCircle size={15} /> : <IconLasso size={15} />
        const label = m === 'point' ? 'Punkt' : m === 'circle' ? 'Kreis' : 'Polygon'
        const disabledReason = selectScope === 'active'
          ? 'Zuerst eine Sachdatentabelle öffnen'
          : 'Mindestens einen Layer sichtbar schalten'
        return (
          <Tooltip key={m} label={selectCandidates.length > 0 ? `${label} auswählen` : disabledReason} withArrow>
            <ActionIcon
              variant={selectMode === m ? 'filled' : 'subtle'}
              color={selectMode === m ? 'yellow' : 'gray'}
              size="sm"
              disabled={selectCandidates.length === 0}
              onClick={() => {
                setIdentify(false)
                setMeasure('off')
                setSelectMode(selectMode === m ? 'off' : m)
              }}
            >
              {icon}
            </ActionIcon>
          </Tooltip>
        )
      })}

      {selected.size > 0 && (
        <>
          <Badge size="sm" variant="light" color="yellow">
            {selected.size} ausgewählt
          </Badge>
          <Tooltip label="Auswahl aufheben" withArrow>
            <ActionIcon variant="subtle" size="sm" color="gray" onClick={clearSelection}>
              <IconX size={13} />
            </ActionIcon>
          </Tooltip>
        </>
      )}
    </Group>
  )
}

function BookmarkBar({ hasSelection, scheme }: { hasSelection: boolean; scheme: 'light' | 'dark' }) {
  const bookmarks = useSelection((s) => s.bookmarks)
  const saveBookmark = useSelection((s) => s.saveBookmark)
  const restoreBookmark = useSelection((s) => s.restoreBookmark)
  const deleteBookmark = useSelection((s) => s.deleteBookmark)
  const [naming, setNaming] = useState(false)
  const [name, setName] = useState('')

  function commit() {
    const trimmed = name.trim()
    if (trimmed) saveBookmark(trimmed)
    setName('')
    setNaming(false)
  }

  if (!hasSelection && bookmarks.length === 0) return null

  return (
    <Box mt={6} pt={6} style={{ borderTop: `1px solid ${panelBorder(scheme)}` }}>
      {naming ? (
        <TextInput
          size="xs"
          autoFocus
          placeholder="Name der Auswahl"
          value={name}
          onChange={(e) => setName(e.currentTarget.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') commit()
            if (e.key === 'Escape') { setNaming(false); setName('') }
          }}
          onBlur={commit}
        />
      ) : (
        hasSelection && (
          <Group gap={4} wrap="nowrap" onClick={() => setNaming(true)} style={{ cursor: 'pointer' }}>
            <IconBookmark size={12} color={SELECTION_COLOR} />
            <Text size="xs" c="dimmed">Auswahl merken…</Text>
          </Group>
        )
      )}
      {bookmarks.map((b) => (
        <Group key={b.id} justify="space-between" gap={4} wrap="nowrap" mt={naming || hasSelection ? 4 : 0}>
          <Group gap={4} wrap="nowrap" style={{ flex: 1, minWidth: 0, cursor: 'pointer' }} onClick={() => restoreBookmark(b.id)}>
            <IconBookmark size={11} />
            <Text size="xs" c="dimmed" truncate>{b.name}</Text>
          </Group>
          <ActionIcon
            variant="subtle" size="xs" color="gray" aria-label="Lesezeichen löschen"
            onClick={() => deleteBookmark(b.id)}
          >
            <IconTrash size={11} />
          </ActionIcon>
        </Group>
      ))}
    </Box>
  )
}

export default function SelectionDashboardPanel({ isActive }: { isActive: boolean }) {
  const scheme = useComputedColorScheme('dark')
  const selected = useSelection((s) => s.selected)
  const closeDashboardTab = useSelection((s) => s.closeDashboardTab)
  const layers = useApp((s) => s.layers)
  const layerConfigs = useApp((s) => s.layerConfigs)
  const dynamicCollections = useApp((s) => s.dynamicCollections)
  const attributeFilters = useApp((s) => s.attributeFilters)

  const byLayer = useMemo(() => {
    const m = new Map<string, SelectedEntry[]>()
    selected.forEach((entry) => {
      const arr = m.get(entry.layer)
      if (arr) arr.push(entry)
      else m.set(entry.layer, [entry])
    })
    return m
  }, [selected])

  // Every visible layer with a resolvable pg_featureserv collection — a
  // raster layer, or a hand-authored one collectionFor() can't place,
  // simply has nothing to aggregate and is skipped (same as LayerSummary's
  // own `!collection` guard for a real selection).
  const overviewLayers = useMemo(
    () => layers
      .filter((l) => l.visible)
      .map((l) => ({ layer: l, collection: l.source ?? collectionFor(l.name, dynamicCollections) }))
      .filter((x): x is { layer: typeof layers[number]; collection: string } => !!x.collection),
    [layers, dynamicCollections],
  )

  // Fetched once per layer name and kept for the session — a table's row
  // count essentially never changes while the app is open, so there's no
  // reason to re-fetch it every time the overview mode toggles on and off.
  // Deliberately unfiltered even for a layer with an active filter: this is
  // also the "share of everything visible" ring's denominator
  // (totalVisibleCount below), which stays a rough whole-table indicator —
  // see filteredCounts for the filtered number actually shown per layer.
  const [layerCounts, setLayerCounts] = useState<Record<string, number | null>>({})

  useEffect(() => {
    if (byLayer.size > 0) return
    overviewLayers.forEach(({ layer, collection }) => {
      if (layer.name in layerCounts) return
      const [schema, table] = collection.split(/\.(.+)/)
      fetchTableCount(schema, table)
        .then((count) => setLayerCounts((c) => ({ ...c, [layer.name]: count })))
        .catch(() => setLayerCounts((c) => ({ ...c, [layer.name]: null })))
    })
  }, [byLayer.size, overviewLayers, layerCounts])

  const totalVisibleCount = useMemo(
    () => Object.values(layerCounts).reduce((sum: number, c) => sum + (c ?? 0), 0),
    [layerCounts],
  )

  // Filtered row count, only for a layer that actually has an active
  // filter — refetched whenever that filter changes, so the nav-row count
  // and LayerOverviewCard's own headline number agree with its detail body
  // the moment you switch to it, not only once the card itself has loaded.
  const [filteredCounts, setFilteredCounts] = useState<Record<string, number | null>>({})
  const fetchedFilterKeys = useRef<Record<string, string>>({})

  useEffect(() => {
    if (byLayer.size > 0) return
    overviewLayers.forEach(({ layer, collection }) => {
      const filter = usableFilter(attributeFilters[layer.name])
      if (!filter) {
        if (fetchedFilterKeys.current[layer.name] !== undefined) {
          delete fetchedFilterKeys.current[layer.name]
          setFilteredCounts((c) => {
            const { [layer.name]: _removed, ...rest } = c
            return rest
          })
        }
        return
      }
      const key = JSON.stringify(filter)
      if (fetchedFilterKeys.current[layer.name] === key) return
      fetchedFilterKeys.current[layer.name] = key
      const [schema, table] = collection.split(/\.(.+)/)
      fetchTableCount(schema, table, filter)
        .then((count) => setFilteredCounts((c) => ({ ...c, [layer.name]: count })))
        .catch(() => setFilteredCounts((c) => ({ ...c, [layer.name]: null })))
    })
  }, [byLayer.size, overviewLayers, attributeFilters])

  function displayCount(name: string): number | null {
    return name in filteredCounts ? filteredCounts[name] : (layerCounts[name] ?? null)
  }

  function displayTitle(name: string): string {
    return layerConfigs[name]?.title || layers.find((l) => l.name === name)?.title || name
  }

  // The nav list's master — whichever layer is currently shown in the
  // detail pane. Kept across a re-render (including a mode switch between a
  // real selection and the "everything selected" overview) as long as the
  // same layer name is still present in the current list; only falls back
  // to "pick the first one" when it genuinely isn't there any more, so a
  // clear/re-select doesn't force you back to the top of the list every time.
  const [selectedLayerName, setSelectedLayerName] = useState<string | null>(null)
  useEffect(() => {
    const names = byLayer.size > 0 ? Array.from(byLayer.keys()) : overviewLayers.map((o) => o.layer.name)
    if (selectedLayerName && names.includes(selectedLayerName)) return
    setSelectedLayerName(names[0] ?? null)
  }, [byLayer, overviewLayers, selectedLayerName])

  return (
    <div
      style={{
        display: isActive ? 'flex' : 'none',
        flex: 1,
        minHeight: 0,
        minWidth: 0,
        flexDirection: 'column',
        overflow: 'hidden',
      }}
    >
      {/* SelectToolsRow moved to DataViewBand.tsx's own tab-strip header
          (next to the maximize button) — this panel no longer has its own
          corner row of tools, just its close button. Duplicates the tab
          strip's own small X on the "Dashboard" pill (DataViewBand.tsx) —
          that one is easy to miss once this tab is focused and the pill
          sits among others, so this is a second, more visible way to reach
          the exact same closeDashboardTab(). */}
      <Group justify="flex-end" pb={6} style={{ flexShrink: 0 }}>
        <Tooltip label="Dashboard schliessen" withArrow>
          <ActionIcon variant="subtle" size="sm" color="gray" aria-label="Dashboard schliessen" onClick={closeDashboardTab}>
            <IconX size={15} />
          </ActionIcon>
        </Tooltip>
      </Group>

      {/* Master-detail body — the panel's own height comes entirely from
          DataViewBand's resizable band (up to 800px, shared with every
          other tab). A fixed-width layer list on the left, the selected
          one's full breakdown on the right, both independently scrollable
          — replaced a grid of independently-collapsible cards per Thomas's
          request (see this file's v9 doc note). */}
      <Box pb={8} style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
        {byLayer.size === 0 && overviewLayers.length > 0 && (
          // Distinguishes this from a real selection, since drill-through
          // from here does turn into one (see this file's v8 doc note).
          <Text size="9px" c="dimmed" fw={700} tt="uppercase" mb={6} style={{ letterSpacing: '0.08em', flexShrink: 0 }}>
            Keine Auswahl — Übersicht aller sichtbaren Layer
          </Text>
        )}

        {/* align="stretch" (not the default "flex-start") is load-bearing:
            in a row-direction flex container, children only get a real
            height to work with if they're stretched to the row's own
            height. Without it, the nav Stack/detail Box below never had a
            bounded height for their `overflowY: auto` to size against —
            content just grew to full natural height and got clipped by
            this panel's own `overflow: hidden` instead of scrolling. */}
        {(byLayer.size > 0 || overviewLayers.length > 0) && (
          <Group align="stretch" wrap="nowrap" gap="md" style={{ flex: 1, minHeight: 0 }}>
            <Stack gap={2} style={{ flex: '0 0 180px', minWidth: 140, minHeight: 0, overflowY: 'auto' }}>
              {byLayer.size > 0
                ? Array.from(byLayer.entries()).map(([name, entries]) => (
                    <LayerNavRow
                      key={name}
                      title={displayTitle(name)}
                      color={layerColor(name)}
                      count={entries.length}
                      active={name === selectedLayerName}
                      onClick={() => setSelectedLayerName(name)}
                    />
                  ))
                : overviewLayers.map(({ layer }) => (
                    <LayerNavRow
                      key={layer.name}
                      title={displayTitle(layer.name)}
                      color={layerColor(layer.name)}
                      count={displayCount(layer.name)}
                      hasFilter={!!usableFilter(attributeFilters[layer.name])}
                      active={layer.name === selectedLayerName}
                      onClick={() => setSelectedLayerName(layer.name)}
                    />
                  ))}
            </Stack>

            <Box style={{ flex: 1, minWidth: 0, minHeight: 0, overflowY: 'auto' }}>
              {byLayer.size > 0
                ? Array.from(byLayer.entries()).map(([name, entries]) => (
                    <LayerSummary
                      key={name}
                      isActive={name === selectedLayerName}
                      layerName={name}
                      title={displayTitle(name)}
                      entries={entries}
                      totalSelected={selected.size}
                    />
                  ))
                : overviewLayers.map(({ layer, collection }) => (
                    <LayerOverviewCard
                      key={layer.name}
                      isActive={layer.name === selectedLayerName}
                      layerName={layer.name}
                      title={displayTitle(layer.name)}
                      collection={collection}
                      count={displayCount(layer.name)}
                      totalVisibleCount={totalVisibleCount}
                    />
                  ))}
            </Box>
          </Group>
        )}

        <BookmarkBar hasSelection={selected.size > 0} scheme={scheme} />
      </Box>
    </div>
  )
}
