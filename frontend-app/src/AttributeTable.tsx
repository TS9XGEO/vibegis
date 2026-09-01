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
  Alert, Button, Group, Loader, ScrollArea, SegmentedControl, Select, Switch, Table, Text, TextInput,
  useComputedColorScheme,
} from '@mantine/core'
import { IconCurrentLocation } from '@tabler/icons-react'
import { Math as CesiumMath, Rectangle } from 'cesium'

import { columnLabel } from './columns'
import { selectionRowBg } from './colorScheme'
import { fetchFeaturePage, fetchFeaturePageInBbox, type Feature } from './features'
import { buildCql } from './filter'
import { FRESH_LAYER_WAIT_MESSAGE, isFreshLayerWait } from './freshLayerRetry'
import { useSelection } from './selection'
import { boundsOfFeatures } from './spatial'
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
  const scheme = useComputedColorScheme('dark')
  const layerConfigs = useApp((s) => s.layerConfigs)
  const saveColumnAliases = useApp((s) => s.saveColumnAliases)
  const savedAliases = layerConfigs[layer.name]?.columnAliases || {}
  const camera = useApp((s) => s.camera)

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

  useEffect(() => {
    if (!isActive || !collection) return
    const controller = new AbortController()
    setLoading(true)
    setError(null)
    setRetrying(false)
    const onRetry = () => setRetrying(true)

    let request: Promise<Feature[]>
    if (viewMode === 'viewport') {
      // Camera not looking at the globe at all (e.g. mid-rotation) — an
      // empty page rather than an error, self-corrects on the next
      // camera.changed tick once it's looking at the map again.
      const rect = camera?.computeViewRectangle()
      if (!rect) {
        setRows([])
        setLoading(false)
        return
      }
      const bbox = {
        west: CesiumMath.toDegrees(rect.west),
        south: CesiumMath.toDegrees(rect.south),
        east: CesiumMath.toDegrees(rect.east),
        north: CesiumMath.toDegrees(rect.north),
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
  }, [isActive, collection, offset, pageSize, viewMode, viewVersion, camera, cql])

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

  const displayRows = useMemo(() => {
    if (!sortBySelection) return rows
    return [...rows].sort((a, b) => Number(selected.has(b.id)) - Number(selected.has(a.id)))
  }, [rows, sortBySelection, selected])

  return (
    <div style={{ display: isActive ? 'flex' : 'none', flex: 1, minHeight: 0, minWidth: 0, flexDirection: 'column' }}>
      {!collection && (
        <Alert color="yellow" variant="light">
          Für diesen Layer sind keine Sachdaten verfügbar.
        </Alert>
      )}

      {collection && (
        <>
          {loading && !retrying && (
            <Group gap={8}>
              <Loader size="xs" />
              <Text size="xs" c="dimmed">lade…</Text>
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
                    { label: 'Kartenansicht', value: 'viewport' },
                    { label: 'Alle Zeilen', value: 'all' },
                  ]}
                />
                <Button
                  size="xs"
                  variant="light"
                  leftSection={<IconCurrentLocation size={14} />}
                  disabled={selected.size === 0}
                  onClick={zoomToSelection}
                >
                  Auf Auswahl zoomen
                </Button>
                <Group gap="md">
                  <Switch
                    size="xs"
                    label="Nach Auswahl sortieren"
                    checked={sortBySelection}
                    onChange={(e) => setSortBySelection(e.currentTarget.checked)}
                  />
                  <Switch
                    size="xs"
                    label="Spalten umbenennen"
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
                        <Table.Th key={c}>
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
                            columnLabel(savedAliases, c)
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
                          — aktuelle Seite —
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
                  {rows.length === 0 ? '0 Zeilen' : `${offset + 1}–${offset + rows.length}`}
                </Text>
                <Group gap={6}>
                  <Button
                    size="xs"
                    variant="default"
                    disabled={offset === 0}
                    onClick={() => setOffset((o) => Math.max(0, o - pageSize))}
                  >
                    Zurück
                  </Button>
                  <Button
                    size="xs"
                    variant="default"
                    disabled={rows.length < pageSize}
                    onClick={() => setOffset((o) => o + pageSize)}
                  >
                    Weiter
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
