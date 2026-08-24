/**
 * Per-layer attribute filter: pick a column, an operator, and a value; one or
 * more conditions get AND-ed together and sent as the WMS `filter` parameter
 * (see filter.ts) — restricts which features MapServer draws, independent of
 * how they're styled.
 */
import { useEffect, useState } from 'react'
import {
  ActionIcon, Autocomplete, Button, Group, NumberInput, Popover, SegmentedControl, Select, Stack, Text, Tooltip,
} from '@mantine/core'
import { IconFilter, IconX } from '@tabler/icons-react'

import { fetchColumns, fetchDistinctValues, type Column } from './columns'
import { NUMERIC_OPS, OP_LABELS, TEXT_OPS, type FilterCondition, type FilterLogic, type FilterOp } from './filter'
import { useApp } from './wms'

function ConditionRow({
  condition, columns, schema, table, onChange, onRemove,
}: {
  condition: FilterCondition
  columns: Column[]
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
        data={columns.map((c) => c.key)}
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
  const [opened, setOpened] = useState(false)
  const [columns, setColumns] = useState<Column[]>([])
  const [error, setError] = useState<string | null>(null)
  const [draft, setDraft] = useState<FilterCondition[]>(active?.conditions ?? [])
  const [logic, setLogic] = useState<FilterLogic>(active?.logic ?? 'and')

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
    fetchColumns(collection)
      .then(setColumns)
      .catch((e) => setError(e instanceof Error ? e.message : String(e)))
  }, [opened, collection, cachedColumns]) // eslint-disable-line react-hooks/exhaustive-deps

  const hasActive = (active?.conditions ?? []).some((c) => c.column && c.value.trim() !== '')

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

  return (
    <Popover opened={opened} onChange={setOpened} position="bottom-end" withArrow shadow="md">
      <Popover.Target>
        <Tooltip label="Filtern" withArrow>
          <ActionIcon
            variant="subtle"
            color={hasActive ? 'blue' : 'gray'}
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
          <Text size="xs" fw={600}>Filter</Text>

          {error && <Text size="xs" c="red">{error}</Text>}
          {!error && columns.length === 0 && <Text size="xs" c="dimmed">lade Spalten…</Text>}

          {draft.map((c, i) => (
            <div key={i}>
              <ConditionRow
                condition={c}
                columns={columns}
                schema={schema}
                table={table}
                onChange={(next) => setDraft((d) => d.map((x, j) => (j === i ? next : x)))}
                onRemove={() => setDraft((d) => d.filter((_, j) => j !== i))}
              />
              {i < draft.length - 1 && (
                <Group justify="center" my={2}>
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
            </div>
          ))}

          <Button size="xs" variant="subtle" disabled={columns.length === 0} onClick={addCondition}>
            + Bedingung
          </Button>

          <Group justify="space-between" mt={4}>
            <Button size="xs" variant="default" onClick={clear}>Zurücksetzen</Button>
            <Button size="xs" onClick={apply}>Anwenden</Button>
          </Group>
        </Stack>
      </Popover.Dropdown>
    </Popover>
  )
}
