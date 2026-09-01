/**
 * Per-layer attribute filter: pick a column, an operator, and a value; one or
 * more conditions get AND-ed together and sent as the WMS `filter` parameter
 * (see filter.ts) — restricts which features MapServer draws, independent of
 * how they're styled.
 */
import { useEffect, useState } from 'react'
import {
  ActionIcon, Alert, Autocomplete, Button, Group, NumberInput, Popover, SegmentedControl, Select, Stack, Switch,
  Text, Tooltip,
} from '@mantine/core'
import { IconFilter, IconX } from '@tabler/icons-react'

import { columnLabel, fetchColumns, fetchDistinctValues, type Column } from './columns'
import { fetchFeaturesWithFilter } from './features'
import { FRESH_LAYER_WAIT_MESSAGE, isFreshLayerWait } from './freshLayerRetry'
import { buildCql, NUMERIC_OPS, OP_LABELS, TEXT_OPS, type FilterCondition, type FilterLogic, type FilterOp } from './filter'
import { useSelection } from './selection'
import SqlFilterModal from './SqlFilterModal'
import { useApp } from './wms'

function ConditionRow({
  condition, columns, aliases, schema, table, onChange, onRemove,
}: {
  condition: FilterCondition
  columns: Column[]
  aliases: Record<string, string> | undefined
  schema: string
  table: string
  onChange: (c: FilterCondition) => void
  onRemove: () => void
}) {
  const numeric = columns.find((c) => c.key === condition.column)?.numeric ?? false
  const ops = numeric ? NUMERIC_OPS : TEXT_OPS

  // A real server-side SELECT DISTINCT (see upload-api's /distinct-values) —
  // not a client-side sample — so text columns get a real value picker
  // instead of free typing. Kept as Autocomplete rather than a strict Select
  // so a value outside the (capped) list, or a partial string for "enthält",
  // can still be typed.
  const [values, setValues] = useState<string[]>([])
  const [valuesLoading, setValuesLoading] = useState(false)

  useEffect(() => {
    if (numeric || !condition.column) {
      setValues([])
      return
    }
    let cancelled = false
    setValuesLoading(true)
    fetchDistinctValues(schema, table, condition.column)
      .then((v) => { if (!cancelled) setValues(v.values) })
      .catch(() => { if (!cancelled) setValues([]) })
      .finally(() => { if (!cancelled) setValuesLoading(false) })
    return () => { cancelled = true }
  }, [numeric, schema, table, condition.column])

  return (
    <Group gap={4} wrap="nowrap" align="flex-end">
      <Select
        size="xs"
        data={columns.map((c) => ({ value: c.key, label: columnLabel(aliases, c.key) }))}
        value={condition.column}
        onChange={(v) => onChange({ ...condition, column: v ?? '', value: '' })}
        style={{ flex: 2, minWidth: 0 }}
        searchable
        comboboxProps={{ withinPortal: false }}
      />
      <Select
        size="xs"
        data={ops.map((op) => ({ value: op, label: OP_LABELS[op] }))}
        value={condition.op}
        onChange={(v) => onChange({ ...condition, op: (v as FilterOp) ?? 'eq' })}
        style={{ flex: 1, minWidth: 64 }}
        allowDeselect={false}
        comboboxProps={{ withinPortal: false }}
      />
      {numeric ? (
        <NumberInput
          size="xs"
          value={condition.value === '' ? '' : Number(condition.value)}
          onChange={(v) => onChange({ ...condition, value: v === '' ? '' : String(v) })}
          style={{ flex: 2, minWidth: 0 }}
        />
      ) : (
        <Autocomplete
          size="xs"
          placeholder={valuesLoading ? 'lade…' : undefined}
          data={values}
          value={condition.value}
          onChange={(v) => onChange({ ...condition, value: v })}
          style={{ flex: 2, minWidth: 0 }}
          comboboxProps={{ withinPortal: false }}
        />
      )}
      <ActionIcon size="sm" variant="subtle" color="gray" onClick={onRemove} aria-label="Bedingung entfernen">
        <IconX size={13} />
      </ActionIcon>
    </Group>
  )
}

export default function AttributeFilterButton({ layerName, collection }: { layerName: string; collection: string }) {
  const [schema, table] = collection.split(/\.(.+)/)
  const active = useApp((s) => s.attributeFilters[layerName])
  const setAttributeFilter = useApp((s) => s.setAttributeFilter)
  const cachedColumns = useApp((s) => s.layerColumns[layerName])
  const aliases = useApp((s) => s.layerConfigs[layerName]?.columnAliases)
  const [opened, setOpened] = useState(false)
  const [columns, setColumns] = useState<Column[]>([])
  const [error, setError] = useState<string | null>(null)
  const [draft, setDraft] = useState<FilterCondition[]>(active?.conditions ?? [])
  const [logic, setLogic] = useState<FilterLogic>(active?.logic ?? 'and')
  const [selecting, setSelecting] = useState(false)
  const [sqlModalOpen, setSqlModalOpen] = useState(false)
  const replaceSelectionForLayers = useSelection((s) => s.replaceSelectionForLayers)

  useEffect(() => {
    if (!opened) return
    setDraft(active?.conditions ?? [])
    setLogic(active?.logic ?? 'and')
    setError(null)
    // A layer just created via upload/register-table already has its column
    // list handed back in that response (see UploadLayer.tsx) — use it
    // directly rather than asking pg_featureserv, whose catalog can take
    // minutes to notice a table that didn't exist a moment ago.
    if (cachedColumns) {
      setColumns(cachedColumns)
      return
    }
    fetchColumns(collection, () => setError(FRESH_LAYER_WAIT_MESSAGE))
      .then((cols) => { setColumns(cols); setError(null) })
      .catch((e) => setError(e instanceof Error ? e.message : String(e)))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [opened, collection, cachedColumns])

  const hasActive = (active?.conditions ?? []).some((c) => c.column && c.value.trim() !== '')
  const draftUsable = draft.some((c) => c.column && c.value.trim() !== '')

  // Two `=` conditions on one column can never both hold, so UND yields an empty
  // layer. Nothing about the map says why — it just goes blank — and the old
  // per-gap toggle made it easy to land here by accident, so name it instead.
  const contradictory =
    logic === 'and' &&
    [...draft
      .filter((c) => c.op === 'eq' && c.column && c.value.trim() !== '')
      .reduce((acc, c) => {
        acc.set(c.column, (acc.get(c.column) ?? new Set<string>()).add(c.value))
        return acc
      }, new Map<string, Set<string>>())
      .values()].some((vals) => vals.size > 1)

  function addCondition() {
    setDraft((d) => [...d, { column: columns[0]?.key ?? '', op: 'eq', value: '' }])
  }

  function apply() {
    setAttributeFilter(layerName, { logic, conditions: draft })
    setOpened(false)
  }

  function clear() {
    setDraft([])
    setLogic('and')
    setAttributeFilter(layerName, { logic: 'and', conditions: [] })
  }

  // Selects the matching features instead of restyling the map — leaves
  // attributeFilters/the WMS rendering untouched entirely. The server does
  // the filtering (CQL, see filter.ts's buildCql) rather than fetching the
  // whole layer to test client-side, which doesn't scale on this app's
  // larger tables (some run into the millions of rows).
  async function selectMatches() {
    const cql = buildCql(draft, logic)
    if (!cql) return
    setSelecting(true)
    setError(null)
    try {
      const { features, truncated } = await fetchFeaturesWithFilter(collection, cql)
      replaceSelectionForLayers([layerName], features.map((feature) => ({ layer: layerName, feature })))
      if (truncated) {
        setError(`Zu viele Treffer (>${features.length}) — Filter weiter eingrenzen, um alle auszuwählen.`)
      } else {
        setOpened(false)
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setSelecting(false)
    }
  }

  return (
    <>
      <Popover opened={opened} onChange={setOpened} position="bottom-end" withArrow shadow="md">
        <Popover.Target>
          <Tooltip label="Filtern" withArrow>
            <ActionIcon
              variant="subtle"
              color={hasActive ? 'teal' : 'gray'}
              size="sm"
              aria-label="Layer filtern"
              onClick={() => setOpened((o) => !o)}
            >
              <IconFilter size={13} />
            </ActionIcon>
          </Tooltip>
        </Popover.Target>
        {/* Mantine's Popover.Dropdown clips overflow (for its open/close
            animation); the condition Selects below render inline rather than
            in a portal (see ConditionRow) so their own dropdowns don't count
            as an "outside click" that closes this popover — which means they'd
            otherwise get clipped away invisibly right here. */}
        <Popover.Dropdown miw={340} style={{ overflow: 'visible' }}>
          <Stack gap={6}>
            <Group justify="space-between" wrap="nowrap">
              <Text size="xs" fw={600}>Filter</Text>
              <ActionIcon variant="subtle" color="gray" size="sm" aria-label="Schliessen" onClick={() => setOpened(false)}>
                <IconX size={14} />
              </ActionIcon>
            </Group>

            <Switch
              size="xs"
              label="SQL-Modus"
              checked={sqlModalOpen}
              onChange={(e) => {
                if (e.currentTarget.checked) {
                  setOpened(false)
                  setSqlModalOpen(true)
                }
              }}
            />

            {error && <Text size="xs" c={isFreshLayerWait(error) ? 'yellow' : 'red'}>{error}</Text>}
            {!error && columns.length === 0 && <Text size="xs" c="dimmed">lade Spalten…</Text>}

            {/* One control, because there is one `logic` for the whole filter.
                It used to be rendered between every pair of conditions, which
                implied a per-pair setting that does not exist: with three
                conditions you got two controls bound to the same state, so
                switching one silently switched the other. Hidden below two
                conditions because there is then nothing to combine — and
                buildConditionsXml correctly emits no And/Or wrapper for one. */}
            {draft.length > 1 && (
              <Group gap={8} align="center" justify="center" my={2} wrap="nowrap">
                <Text size="xs" c="dimmed" style={{ whiteSpace: 'nowrap' }}>
                  Bedingungen verknüpfen:
                </Text>
                <SegmentedControl
                  size="xs"
                  value={logic}
                  onChange={(v) => setLogic(v as FilterLogic)}
                  data={[
                    { label: 'UND', value: 'and' },
                    { label: 'ODER', value: 'or' },
                  ]}
                />
              </Group>
            )}

            {draft.map((c, i) => (
              <ConditionRow
                key={i}
                condition={c}
                columns={columns}
                aliases={aliases}
                schema={schema}
                table={table}
                onChange={(next) => setDraft((d) => d.map((x, j) => (j === i ? next : x)))}
                onRemove={() => setDraft((d) => d.filter((_, j) => j !== i))}
              />
            ))}

            {contradictory && (
              <Alert color="yellow" variant="light" p="xs">
                <Text size="xs">
                  Mit UND können diese Bedingungen nie gleichzeitig zutreffen — eine Spalte
                  kann nur einen Wert haben. Der Layer bleibt leer. Für „einer der Werte"
                  ODER wählen.
                </Text>
              </Alert>
            )}

            <Button size="xs" variant="subtle" disabled={columns.length === 0} onClick={addCondition}>
              + Bedingung
            </Button>

            <Group justify="space-between" mt={4}>
              <Button size="xs" variant="default" onClick={clear}>Zurücksetzen</Button>
              <Group gap={6}>
                <Button size="xs" variant="light" loading={selecting} disabled={!draftUsable} onClick={selectMatches}>Auswählen</Button>
                <Button size="xs" onClick={apply}>Anwenden</Button>
              </Group>
            </Group>
          </Stack>
        </Popover.Dropdown>
      </Popover>

      <SqlFilterModal
        opened={sqlModalOpen}
        onClose={() => setSqlModalOpen(false)}
        columns={columns}
        aliases={aliases}
        schema={schema}
        table={table}
        initialLogic={logic}
        initialConditions={draft}
        onApply={(l, c) => {
          // Commits straight to the store, exactly like the visual builder's
          // own "Anwenden" (apply() above) — loading the result into local
          // draft/logic instead and reopening the popover doesn't work: the
          // popover's own reset effect re-seeds draft/logic from the store's
          // (still-unchanged) active filter the moment `opened` flips back
          // to true, silently discarding whatever was just parsed.
          setAttributeFilter(layerName, { logic: l, conditions: c })
          setSqlModalOpen(false)
          setOpened(true)
        }}
      />
    </>
  )
}
