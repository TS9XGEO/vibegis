/**
 * One tab's content in the Data View Band (see DataViewBand.tsx) — a
 * paginated grid of a layer's real feature data (columns = fields, rows =
 * features), read straight from the pg_featureserv OGC API Features
 * endpoint that's already deployed for the search box (see tools.ts).
 *
 * Several of these can be mounted at once (one per open tab) but only the
 * active one actually fetches — DataViewBand hides the rest via
 * `display: none` rather than unmounting them, so each tab's paging/view
 * mode/scroll state survives switching tabs, and `isActive` below just gates
 * the network side of that.
 */
import { useEffect, useMemo, useState } from 'react'
import {
  ActionIcon, Alert, Button, Group, Loader, ScrollArea, SegmentedControl, Select, Switch, Table, Text, TextInput,
  Tooltip, useComputedColorScheme,
} from '@mantine/core'
import { notifications } from '@mantine/notifications'
import { IconArrowDown, IconArrowUp, IconCurrentLocation, IconDownload } from '@tabler/icons-react'
import { Rectangle } from 'cesium'
import { useTranslation } from 'react-i18next'

import { columnLabel } from './columns'
import { selectionRowBg } from './colorScheme'
import { downloadCsv } from './csv'
import { fetchAllFeatures, fetchFeaturePage, fetchFeaturePageInBbox, fetchFeaturesInBbox, SELECTION_FETCH_CAP, type Feature } from './features'
import { buildCql } from './filter'
import { FRESH_LAYER_WAIT_MESSAGE, isFreshLayerWait } from './freshLayerRetry'
import { useSelection } from './selection'
import { bboxWorldFraction, boundsOfFeatures, visibleGroundBbox, WIDE_VIEW_FRACTION } from './spatial'
import { useApp, type LayerState } from './wms'

const DEFAULT_PAGE_SIZE = 100
const PAGE_SIZE_OPTIONS = ['25', '50', '100', '200']

export default function AttributeTablePanel({
  layer,
  collection,
  isActive,
}: {
  layer: LayerState
  collection: string | undefined
  isActive: boolean
}) {
  const { t } = useTranslation()
  const scheme = useComputedColorScheme('dark')
  const layerConfigs = useApp((s) => s.layerConfigs)
  const saveColumnAliases = useApp((s) => s.saveColumnAliases)
  const savedAliases = layerConfigs[layer.name]?.columnAliases || {}
  const camera = useApp((s) => s.camera)
  // Needed alongside `camera` for visibleGroundBbox()'s ray-casts — see the
  // store's own note on why both are stashed there.
  const scene = useApp((s) => s.scene)

  // Kartenansicht scopes to the layer's active attribute filter, same as
  // SelectionDashboard.tsx's LayerOverviewCard already does for its own
  // Kartenansicht mode (see fetchFeaturePageInBbox's cql param) — Alle
  // Zeilen deliberately stays unfiltered, unchanged.
  const activeFilter = useApp((s) => s.attributeFilters[layer.name])
  const cql = useMemo(
    () => buildCql(activeFilter?.conditions ?? [], activeFilter?.logic ?? 'and'),
    [activeFilter],
  )

  const [offset, setOffset] = useState(0)
  const [pageSize, setPageSize] = useState(DEFAULT_PAGE_SIZE)
  const [viewMode, setViewMode] = useState<'viewport' | 'all'>('viewport')
  const [viewVersion, setViewVersion] = useState(0)
  // True while the current view is so wide that scoping to it barely narrows
  // anything — surfaced as a note next to the mode switch, since otherwise
  // Kartenansicht showing essentially every row reads as a broken filter.
  const [wideView, setWideView] = useState(false)
  const [rows, setRows] = useState<Feature[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // A layer created moments ago can 404 here while pg_featureserv is still
  // discovering it (see freshLayerRetry.ts) — set as soon as the first such
  // 404 comes back, so the loading state below can say so instead of just
  // spinning silently for however long the retry ends up taking.
  const [retrying, setRetrying] = useState(false)
  const [renaming, setRenaming] = useState(false)
  const [aliases, setAliases] = useState<Record<string, string>>({})
  const [sortBySelection, setSortBySelection] = useState(false)
  // Click-to-sort by column, current page only — not a real server-side
  // ORDER BY. Tried pg_featureserv's own `sortby` param first (it exists),
  // but it 500s on any column name that needs SQL quoting (mixed-case —
  // common for uploaded data, e.g. this exact kind of dataset's
  // "POP_DENS_2024") — confirmed directly against a running layer, not
  // usable here. Same "don't fetch the whole table just to reorder it"
  // reasoning sortBySelection above already uses.
  const [sortColumn, setSortColumn] = useState<string | null>(null)
  const [sortDirection, setSortDirection] = useState<'asc' | 'desc'>('asc')
  const allSelected = useSelection((s) => s.selected)
  const toggleFeature = useSelection((s) => s.toggleFeature)

  // This tab's own slice of the (layer-tagged) global selection — two
  // layers can share feature ids, so row-selection checks must never look
  // at the raw store map directly.
  const selected = useMemo(() => {
    const mine = new Map<string, Feature>()
    allSelected.forEach((entry) => {
      if (entry.layer === layer.name) mine.set(entry.feature.id, entry.feature)
    })
    return mine
  }, [allSelected, layer.name])

  // "Kartenansicht" tracks the map live: whenever the visible area changes,
  // start over from the first page of whatever's now on screen. Same
  // camera.changed pattern as ZoomBar/StatusHud/CompassButton/AutoOrthographic
  // — this component sits outside the Viewer tree, but `camera` is a plain
  // Cesium object stashed in the store for exactly this reason. Only the
  // active tab listens — an inactive one would just be re-fetching data
  // nobody's looking at.
  useEffect(() => {
    if (!isActive || viewMode !== 'viewport' || !camera) return
    camera.percentageChanged = 0.1
    const update = () => {
      setOffset(0)
      setViewVersion((v) => v + 1)
    }
    const remove = camera.changed.addEventListener(update)
    return () => remove()
  }, [isActive, viewMode, camera])

  // Same "start over" treatment when the active filter changes while looking
  // at Kartenansicht — an old offset can point past the end of a now-smaller
  // filtered result, or just land on a confusing mid-list page.
  useEffect(() => {
    if (!isActive || viewMode !== 'viewport') return
    setOffset(0)
  }, [isActive, viewMode, cql])

  /**
   * The ground actually on screen. This used to be
   * `camera.computeViewRectangle()`, which is why Kartenansicht could show
   * every row: on a tilted or zoomed-out 3D globe that method returns a
   * rectangle far larger than the visible ground, up to the whole world.
   * spatial.ts's visibleGroundBbox() ray-casts against the globe instead,
   * and Legend.tsx has always used it — the two are on the same extent now.
   */
  function viewportBbox() {
    if (!camera || !scene) return null
    const bbox = visibleGroundBbox(camera, scene)
    setWideView(bbox !== null && bboxWorldFraction(bbox) > WIDE_VIEW_FRACTION)
    return bbox
  }

  function toggleRenaming(next: boolean) {
    if (next) {
      setAliases(savedAliases)
      setRenaming(true)
      return
    }
    setRenaming(false)
    // Blank or reverted-to-original entries carry no information, so they're
    // dropped rather than saved as a no-op alias.
    const cleaned = Object.fromEntries(
      Object.entries(aliases).filter(([k, v]) => v.trim() !== '' && v.trim() !== k),
    )
    void saveColumnAliases(layer.name, cleaned)
  }

  function changePageSize(size: number) {
    setPageSize(size)
    // A mid-page offset from the old page size lines up with a different row
    // range once the size changes, so start over rather than show a mismatch.
    setOffset(0)
  }

  function zoomToSelection() {
    const bounds = boundsOfFeatures(Array.from(selected.values()))
    if (!bounds || !camera) return
    camera.flyTo({
      destination: Rectangle.fromDegrees(bounds.west, bounds.south, bounds.east, bounds.north),
      duration: 1.2,
    })
  }

  const [exporting, setExporting] = useState(false)

  // Exports exactly what the table is currently showing, mode for mode:
  // Kartenansicht scoped to the current view (+ active filter, same as the
  // live fetch above), Alle Zeilen unfiltered across the whole table (same
  // "deliberately stays unfiltered" contract as its own live fetch) — never
  // just the current page, since that would silently omit the rest of a
  // paginated result the user has every reason to expect in the file.
  async function exportCsv() {
    if (!collection) return
    setExporting(true)
    try {
      let result: { features: Feature[]; truncated: boolean }
      if (viewMode === 'viewport') {
        const bbox = viewportBbox()
        if (!bbox) return
        result = await fetchFeaturesInBbox(collection, bbox, undefined, cql ?? undefined)
      } else {
        result = await fetchAllFeatures(collection)
      }
      downloadCsv(layer.name, result.features)
      if (result.truncated) {
        notifications.show({
          color: 'yellow',
          title: t('attributeTable.exportLimited'),
          message: t('attributeTable.exportLimitedMessage', { count: SELECTION_FETCH_CAP }),
        })
      }
    } catch (e) {
      notifications.show({
        color: 'red',
        title: t('attributeTable.exportFailed'),
        message: e instanceof Error ? e.message : String(e),
      })
    } finally {
      setExporting(false)
    }
  }

  useEffect(() => {
    if (!isActive || !collection) return
    const controller = new AbortController()
    setLoading(true)
    setError(null)
    setRetrying(false)
    const onRetry = () => setRetrying(true)

    let request: Promise<Feature[]>
    if (viewMode === 'viewport') {
      // Nothing on screen hits the globe at all (e.g. mid-rotation, camera
      // pointed at open sky) — an empty page rather than an error,
      // self-corrects on the next camera.changed tick.
      const bbox = viewportBbox()
      if (!bbox) {
        setRows([])
        setLoading(false)
        return
      }
      request = fetchFeaturePageInBbox(collection, bbox, offset, pageSize, controller.signal, onRetry, cql ?? undefined)
    } else {
      request = fetchFeaturePage(collection, offset, pageSize, controller.signal, onRetry)
    }

    request
      .then((r) => {
        setRows(r)
        setLoading(false)
        setRetrying(false)
      })
      .catch((e) => {
        if (controller.signal.aborted) return
        setError(e instanceof Error ? e.message : String(e))
        setLoading(false)
        setRetrying(false)
      })
    return () => controller.abort()
  }, [isActive, collection, offset, pageSize, viewMode, viewVersion, camera, scene, cql])

  // pg_featureserv doesn't report a total count, so columns come from
  // whatever the current page actually returned.
  const columns = useMemo(() => {
    const keys = new Set<string>()
    rows.forEach((r) => Object.keys(r.properties).forEach((k) => keys.add(k)))
    return Array.from(keys)
  }, [rows])

  // Purely a display-order change — selection itself doesn't depend on it.
  // Selected features not on this page are pinned above it rather than left
  // invisible on whatever page they actually belong to — useSelection's
  // `selected` already holds the full feature for each of them, no extra
  // fetch needed (fetching the whole layer to sort it properly would undo
  // the point of paginating in the first place, on a table that can run into
  // the millions of rows).
  const pinnedFromElsewhere = useMemo(() => {
    if (!sortBySelection) return []
    const onThisPage = new Set(rows.filter((r) => selected.has(r.id)).map((r) => r.id))
    return Array.from(selected.values()).filter((f) => !onThisPage.has(f.id))
  }, [rows, sortBySelection, selected])

  function toggleColumnSort(col: string) {
    if (sortColumn !== col) {
      setSortColumn(col)
      setSortDirection('asc')
    } else {
      setSortDirection((d) => (d === 'asc' ? 'desc' : 'asc'))
    }
  }

  const displayRows = useMemo(() => {
    let result = rows
    if (sortColumn) {
      const dir = sortDirection === 'asc' ? 1 : -1
      result = [...result].sort((a, b) => {
        const av = a.properties[sortColumn]
        const bv = b.properties[sortColumn]
        if (av == null && bv == null) return 0
        if (av == null) return 1
        if (bv == null) return -1
        if (typeof av === 'number' && typeof bv === 'number') return (av - bv) * dir
        return String(av).localeCompare(String(bv)) * dir
      })
    }
    // Stable sort, applied after: selected rows still float to the top when
    // sortBySelection is on, but each group (selected / not) keeps whatever
    // column order was just computed above instead of losing it.
    if (sortBySelection) {
      result = [...result].sort((a, b) => Number(selected.has(b.id)) - Number(selected.has(a.id)))
    }
    return result
  }, [rows, sortBySelection, selected, sortColumn, sortDirection])

  return (
    <div style={{ display: isActive ? 'flex' : 'none', flex: 1, minHeight: 0, minWidth: 0, flexDirection: 'column' }}>
      {!collection && (
        <Alert color="yellow" variant="light">
          {t('attributeTable.noData')}
        </Alert>
      )}

      {collection && (
        <>
          {loading && !retrying && (
            <Group gap={8}>
              <Loader size="xs" />
              <Text size="xs" c="dimmed">{t('common.loading')}</Text>
            </Group>
          )}

          {loading && retrying && (
            <Alert color="yellow" variant="light">
              <Group gap={8} wrap="nowrap">
                <Loader size="xs" />
                <Text size="xs">{FRESH_LAYER_WAIT_MESSAGE}</Text>
              </Group>
            </Alert>
          )}

          {error && (
            <Alert color={isFreshLayerWait(error) ? 'yellow' : 'red'} variant="light">
              <Text size="xs">{error}</Text>
            </Alert>
          )}

          {!loading && !error && (
            <>
              <Group justify="space-between" gap="md" mb={4}>
                <SegmentedControl
                  size="xs"
                  value={viewMode}
                  onChange={(v) => { setViewMode(v as 'viewport' | 'all'); setOffset(0) }}
                  data={[
                    { label: t('attributeTable.viewport'), value: 'viewport' },
                    { label: t('attributeTable.allRows'), value: 'all' },
                  ]}
                />
                {viewMode === 'viewport' && wideView && (
                  <Text size="xs" c="dimmed" style={{ flex: 1, minWidth: 0 }}>
                    {t('attributeTable.viewportTooWide')}
                  </Text>
                )}
                <Button
                  size="xs"
                  variant="light"
                  leftSection={<IconCurrentLocation size={14} />}
                  disabled={selected.size === 0}
                  onClick={zoomToSelection}
                >
                  {t('attributeTable.zoomToSelection')}
                </Button>
                <Tooltip label={t('attributeTable.exportCsv')} withArrow>
                  <ActionIcon
                    variant="subtle"
                    size="sm"
                    aria-label={t('attributeTable.exportCsv')}
                    disabled={exporting}
                    onClick={() => void exportCsv()}
                  >
                    {exporting ? <Loader size={14} /> : <IconDownload size={14} />}
                  </ActionIcon>
                </Tooltip>
                <Group gap="md">
                  <Switch
                    size="xs"
                    label={t('attributeTable.sortBySelection')}
                    checked={sortBySelection}
                    onChange={(e) => setSortBySelection(e.currentTarget.checked)}
                  />
                  <Switch
                    size="xs"
                    label={t('attributeTable.renameColumns')}
                    checked={renaming}
                    onChange={(e) => toggleRenaming(e.currentTarget.checked)}
                  />
                </Group>
              </Group>

              {/* h={0} forces the flex item to ignore its content's intrinsic
                  height and take `flex: 1` from the column above instead —
                  without it a flex child sizes to its content by default and
                  never actually becomes bounded, which is the same failure
                  mode as leaving the height unset entirely. */}
              <ScrollArea style={{ flex: 1, minWidth: 0 }} h={0}>
                <Table striped withTableBorder stickyHeader fz="xs">
                  <Table.Thead>
                    <Table.Tr>
                      {columns.map((c) => (
                        <Table.Th
                          key={c}
                          onClick={() => !renaming && toggleColumnSort(c)}
                          style={{ cursor: renaming ? undefined : 'pointer', userSelect: 'none' }}
                        >
                          {renaming ? (
                            <TextInput
                              size="xs"
                              variant="unstyled"
                              value={aliases[c] ?? c}
                              onChange={(e) =>
                                setAliases((a) => ({ ...a, [c]: e.currentTarget.value }))
                              }
                            />
                          ) : (
                            <Group gap={2} wrap="nowrap">
                              <Text fz="xs" fw={sortColumn === c ? 700 : undefined}>
                                {columnLabel(savedAliases, c)}
                              </Text>
                              {sortColumn === c && (
                                sortDirection === 'asc' ? <IconArrowUp size={12} /> : <IconArrowDown size={12} />
                              )}
                            </Group>
                          )}
                        </Table.Th>
                      ))}
                    </Table.Tr>
                  </Table.Thead>
                  <Table.Tbody>
                    {pinnedFromElsewhere.map((r) => (
                      <Table.Tr
                        key={`pinned-${r.id}`}
                        onClick={() => toggleFeature(layer.name, r)}
                        bg={selectionRowBg(scheme === 'dark' ? 0.3 : 0.18)}
                        style={{ cursor: 'pointer' }}
                      >
                        {columns.map((c) => (
                          <Table.Td key={c}>{String(r.properties[c] ?? '')}</Table.Td>
                        ))}
                      </Table.Tr>
                    ))}
                    {pinnedFromElsewhere.length > 0 && (
                      <Table.Tr>
                        <Table.Td colSpan={columns.length} c="dimmed" ta="center" fz="10px">
                          {t('attributeTable.currentPageDivider')}
                        </Table.Td>
                      </Table.Tr>
                    )}
                    {displayRows.map((r) => (
                      <Table.Tr
                        key={r.id}
                        onClick={() => toggleFeature(layer.name, r)}
                        bg={selected.has(r.id) ? selectionRowBg(scheme === 'dark' ? 0.3 : 0.18) : undefined}
                        style={{ cursor: 'pointer' }}
                      >
                        {columns.map((c) => (
                          <Table.Td key={c}>{String(r.properties[c] ?? '')}</Table.Td>
                        ))}
                      </Table.Tr>
                    ))}
                  </Table.Tbody>
                </Table>
              </ScrollArea>

              <Group justify="space-between" mt="sm">
                <Text size="xs" c="dimmed">
                  {rows.length === 0 ? t('attributeTable.rowCount') : `${offset + 1}–${offset + rows.length}`}
                </Text>
                <Group gap={6}>
                  <Button
                    size="xs"
                    variant="default"
                    disabled={offset === 0}
                    onClick={() => setOffset((o) => Math.max(0, o - pageSize))}
                  >
                    {t('attributeTable.back')}
                  </Button>
                  <Button
                    size="xs"
                    variant="default"
                    disabled={rows.length < pageSize}
                    onClick={() => setOffset((o) => o + pageSize)}
                  >
                    {t('attributeTable.next')}
                  </Button>
                  <Select
                    size="xs"
                    w={90}
                    data={PAGE_SIZE_OPTIONS}
                    value={String(pageSize)}
                    onChange={(v) => changePageSize(Number(v ?? DEFAULT_PAGE_SIZE))}
                    allowDeselect={false}
                    comboboxProps={{ withinPortal: false }}
                  />
                </Group>
              </Group>
            </>
          )}
        </>
      )}
    </div>
  )
}
