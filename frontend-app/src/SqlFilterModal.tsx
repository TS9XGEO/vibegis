/**
 * SQL mode for the attribute filter — a typed alternative to AttributeFilter.tsx's
 * dropdown condition rows. Parses the typed WHERE text into the exact same
 * FilterCondition[]/FilterLogic shape the dropdown UI builds (see sqlFilter.ts
 * for why that keeps this safe against injection: nothing here ever reaches a
 * query string directly) and hands it back to the caller, which loads it into
 * the same `draft`/`logic` state the visual builder edits — SQL mode fills in
 * the draft faster, it doesn't add a second place a filter gets committed.
 */
import { useEffect, useRef, useState } from 'react'
import {
  Alert, Button, Divider, Group, Loader, Modal, ScrollArea, Stack, Text, Textarea, UnstyledButton,
} from '@mantine/core'
import { IconAlertCircle } from '@tabler/icons-react'

import { columnLabel, fetchDistinctValues, type Column } from './columns'
import type { FilterCondition, FilterLogic } from './filter'
import { conditionsToSqlWhere, parseSqlWhere } from './sqlFilter'

const OPERATOR_BUTTONS = ['=', '!=', '<', '>', '<=', '>=', 'LIKE', 'AND', 'OR', "'"]

// Same fixed-height, internally-scrolling convention as the ETL Kaskade panel
// (Sideband.tsx) — the columns/values lists never resize the modal around them.
const LIST_HEIGHT = 220

interface SqlFilterModalProps {
  opened: boolean
  onClose: () => void
  columns: Column[]
  aliases: Record<string, string> | undefined
  schema: string
  table: string
  initialLogic: FilterLogic
  initialConditions: FilterCondition[]
  onApply: (logic: FilterLogic, conditions: FilterCondition[]) => void
}

export default function SqlFilterModal({
  opened, onClose, columns, aliases, schema, table, initialLogic, initialConditions, onApply,
}: SqlFilterModalProps) {
  const [text, setText] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [selectedColumn, setSelectedColumn] = useState<string | null>(null)
  const [values, setValues] = useState<string[]>([])
  const [valuesLoading, setValuesLoading] = useState(false)
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    if (!opened) return
    setText(conditionsToSqlWhere(initialConditions, initialLogic))
    setError(null)
    setSelectedColumn(null)
    setValues([])
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [opened])

  useEffect(() => {
    if (!selectedColumn) return
    let cancelled = false
    setValuesLoading(true)
    fetchDistinctValues(schema, table, selectedColumn)
      .then((v) => { if (!cancelled) setValues(v.values) })
      .catch(() => { if (!cancelled) setValues([]) })
      .finally(() => { if (!cancelled) setValuesLoading(false) })
    return () => { cancelled = true }
  }, [schema, table, selectedColumn])

  function insertAtCursor(snippet: string) {
    const el = textareaRef.current
    const start = el?.selectionStart ?? text.length
    const end = el?.selectionEnd ?? text.length
    const next = text.slice(0, start) + snippet + text.slice(end)
    setText(next)
    const cursor = start + snippet.length
    requestAnimationFrame(() => {
      el?.focus()
      el?.setSelectionRange(cursor, cursor)
    })
  }

  function insertOperator(op: string) {
    insertAtCursor(op === "'" ? "''" : ` ${op} `)
  }

  function insertColumn(column: string) {
    insertAtCursor(column)
  }

  function insertValue(value: string) {
    const numeric = value.trim() !== '' && !Number.isNaN(Number(value))
    insertAtCursor(numeric ? value : `'${value.replace(/'/g, "''")}'`)
  }

  function apply() {
    try {
      const { logic, conditions } = parseSqlWhere(text, columns.map((c) => c.key))
      setError(null)
      onApply(logic, conditions)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  return (
    <Modal opened={opened} onClose={onClose} title="SQL-Modus — WHERE-Bedingung" centered size={640}>
      <Group align="flex-start" gap="md" wrap="nowrap">
        <Stack gap="xs" flex={2} miw={0}>
          <Text size="xs" c="dimmed">
            Format: <code>spalte = 'wert' AND andere_spalte {'>'} 5</code> — nur eine
            Verknüpfung (UND oder ODER) für alle Bedingungen, keine Klammern. LIKE sucht
            immer nach Teilstring, wie im normalen Modus.
          </Text>

          <Group gap={4}>
            {OPERATOR_BUTTONS.map((op) => (
              <Button key={op} size="xs" variant="default" px={8} onClick={() => insertOperator(op)}>
                {op === "'" ? '‘ ’' : op}
              </Button>
            ))}
          </Group>

          <Textarea
            ref={textareaRef}
            value={text}
            onChange={(e) => setText(e.currentTarget.value)}
            autosize
            minRows={6}
            maxRows={10}
            placeholder="spalte = 'wert' AND andere_spalte > 5"
            styles={{ input: { fontFamily: 'monospace' } }}
          />

          {error && (
            <Alert color="red" variant="light" icon={<IconAlertCircle size={16} />}>{error}</Alert>
          )}

          <Group justify="space-between" mt="xs">
            <Button size="xs" variant="default" onClick={onClose}>Abbrechen</Button>
            <Button size="xs" onClick={apply}>Anwenden</Button>
          </Group>
        </Stack>

        <Divider orientation="vertical" />

        <Stack gap="xs" flex={1} miw={0}>
          <Text size="xs" fw={600}>Spalten</Text>
          <ScrollArea h={LIST_HEIGHT} type="auto">
            <Stack gap={2}>
              {columns.map((c) => (
                <UnstyledButton
                  key={c.key}
                  onClick={() => setSelectedColumn(c.key)}
                  onDoubleClick={() => { setSelectedColumn(c.key); insertColumn(c.key) }}
                  px={6}
                  py={4}
                  style={{
                    borderRadius: 4,
                    fontSize: 12,
                    backgroundColor: selectedColumn === c.key ? 'var(--mantine-color-teal-light)' : undefined,
                  }}
                >
                  {columnLabel(aliases, c.key)}
                </UnstyledButton>
              ))}
            </Stack>
          </ScrollArea>

          <Text size="xs" fw={600} mt={4}>Werte{selectedColumn ? ` (${columnLabel(aliases, selectedColumn)})` : ''}</Text>
          <ScrollArea h={LIST_HEIGHT} type="auto">
            <Stack gap={2}>
              {!selectedColumn && <Text size="xs" c="dimmed" px={6}>Spalte oben auswählen</Text>}
              {valuesLoading && <Loader size="xs" mx="auto" my="sm" />}
              {selectedColumn && !valuesLoading && values.length === 0 && (
                <Text size="xs" c="dimmed" px={6}>Keine Werte gefunden</Text>
              )}
              {values.map((v) => (
                <UnstyledButton
                  key={v}
                  onDoubleClick={() => insertValue(v)}
                  px={6}
                  py={4}
                  style={{ borderRadius: 4, fontSize: 12 }}
                  title="Doppelklick zum Einfügen"
                >
                  {v}
                </UnstyledButton>
              ))}
            </Stack>
          </ScrollArea>
        </Stack>
      </Group>
    </Modal>
  )
}
