/**
 * Runs a PostGIS operation (buffer/dissolve/intersect/join) against already-
 * published layers and publishes the result as a brand new layer, via
 * upload-api's /geoprocess — same "always re-read layers from
 * GetCapabilities" convention as UploadLayer.tsx, so a successful run just
 * needs load() afterwards for the new layer to show up.
 */
import { useEffect, useState } from 'react'
import {
  Alert, Button, Group, Modal, MultiSelect, NumberInput, SegmentedControl, Select, Stack, Text, TextInput,
} from '@mantine/core'
import { IconAlertCircle, IconCheck, IconWand } from '@tabler/icons-react'

import { fetchColumns } from './columns'
import { collectionFor, GEOPROCESS_URL, useApp } from './wms'

type Operation = 'buffer' | 'dissolve' | 'intersect' | 'join'

const OPERATIONS: { label: string; value: Operation }[] = [
  { label: 'Puffer', value: 'buffer' },
  { label: 'Auflösen', value: 'dissolve' },
  { label: 'Verschneiden', value: 'intersect' },
  { label: 'Verknüpfen', value: 'join' },
]

function splitSource(source: string): [string, string] {
  const [schema, table] = source.split(/\.(.+)/)
  return [schema, table]
}

export default function Geoprocessing({ opened, onClose }: { opened: boolean; onClose: () => void }) {
  const layers = useApp((s) => s.layers)
  const dynamicCollections = useApp((s) => s.dynamicCollections)
  const load = useApp((s) => s.load)

  const [operation, setOperation] = useState<Operation>('buffer')
  const [layerA, setLayerA] = useState<string | null>(null)
  const [layerB, setLayerB] = useState<string | null>(null)
  const [distance, setDistance] = useState<number | ''>('')
  const [groupColumn, setGroupColumn] = useState<string | null>(null)
  const [joinColumns, setJoinColumns] = useState<string[]>([])
  const [title, setTitle] = useState('')

  const [columnsA, setColumnsA] = useState<{ key: string }[]>([])
  const [columnsB, setColumnsB] = useState<{ key: string }[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [success, setSuccess] = useState<string | null>(null)

  const layerOptions = layers
    .filter((l) => l.source)
    .map((l) => ({ value: l.name, label: l.title }))

  const needsB = operation === 'intersect' || operation === 'join'

  useEffect(() => {
    if (!opened) return
    setColumnsA([])
    if (!layerA) return
    const collection = collectionFor(layerA, dynamicCollections)
    if (!collection) return
    fetchColumns(collection).then(setColumnsA).catch(() => setColumnsA([]))
  }, [opened, layerA, dynamicCollections])

  useEffect(() => {
    if (!opened) return
    setColumnsB([])
    if (!layerB) return
    const collection = collectionFor(layerB, dynamicCollections)
    if (!collection) return
    fetchColumns(collection).then(setColumnsB).catch(() => setColumnsB([]))
  }, [opened, layerB, dynamicCollections])

  function reset() {
    setOperation('buffer')
    setLayerA(null)
    setLayerB(null)
    setDistance('')
    setGroupColumn(null)
    setJoinColumns([])
    setTitle('')
    setError(null)
  }

  function close() {
    onClose()
    reset()
    setSuccess(null)
  }

  const canSubmit =
    !!layerA &&
    (!needsB || !!layerB) &&
    (operation !== 'buffer' || distance !== '') &&
    (operation !== 'join' || joinColumns.length > 0)

  async function submit() {
    if (!layerA) return
    setLoading(true)
    setError(null)
    setSuccess(null)

    const [schema_a, table_a] = splitSource(layers.find((l) => l.name === layerA)!.source!)
    const body: Record<string, unknown> = {
      operation,
      schema_a,
      table_a,
      title: title.trim() || undefined,
    }
    if (needsB && layerB) {
      const [schema_b, table_b] = splitSource(layers.find((l) => l.name === layerB)!.source!)
      body.schema_b = schema_b
      body.table_b = table_b
    }
    if (operation === 'buffer') body.distance = distance
    if (operation === 'dissolve' && groupColumn) body.group_column = groupColumn
    if (operation === 'join') body.join_columns = joinColumns

    try {
      const res = await fetch(GEOPROCESS_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      const resBody = await res.json().catch(() => null)
      if (!res.ok) throw new Error(resBody?.detail ?? `Geoprocessing fehlgeschlagen: HTTP ${res.status}`)

      setSuccess(`"${resBody.title}" als neuer Layer angelegt (${resBody.geometry_type.toLowerCase()})`)
      reset()
      await load()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }

  return (
    <Modal opened={opened} onClose={close} title="Geoverarbeitung" centered>
      <Stack gap="sm">
        <Text size="xs" c="dimmed">
          Rechnet direkt in PostGIS und veröffentlicht das Ergebnis als neuen Layer —
          der Ausgangslayer bleibt unverändert.
        </Text>

        <SegmentedControl
          fullWidth
          value={operation}
          onChange={(v) => setOperation(v as Operation)}
          data={OPERATIONS}
        />

        <Select
          label={needsB ? 'Layer A' : 'Layer'}
          placeholder="Layer auswählen"
          data={layerOptions}
          value={layerA}
          onChange={setLayerA}
          searchable
          comboboxProps={{ withinPortal: false }}
        />

        {needsB && (
          <Select
            label="Layer B"
            placeholder="Layer auswählen"
            data={layerOptions.filter((o) => o.value !== layerA)}
            value={layerB}
            onChange={setLayerB}
            searchable
            comboboxProps={{ withinPortal: false }}
          />
        )}

        {operation === 'buffer' && (
          <NumberInput
            label="Pufferabstand (Meter)"
            placeholder="z. B. 500"
            value={distance}
            onChange={(v) => setDistance(typeof v === 'number' ? v : '')}
            min={0}
          />
        )}

        {operation === 'dissolve' && (
          <Select
            label="Gruppieren nach (optional)"
            description="Ohne Auswahl wird der gesamte Layer zu einer Fläche aufgelöst"
            placeholder="keine — alles zu einer Fläche"
            data={columnsA.map((c) => c.key)}
            value={groupColumn}
            onChange={setGroupColumn}
            clearable
            comboboxProps={{ withinPortal: false }}
          />
        )}

        {operation === 'join' && (
          <MultiSelect
            label="Spalten aus Layer B übernehmen"
            placeholder="Spalten auswählen"
            data={columnsB.map((c) => c.key)}
            value={joinColumns}
            onChange={setJoinColumns}
            comboboxProps={{ withinPortal: false }}
          />
        )}

        <TextInput
          label="Titel (optional)"
          placeholder="wird automatisch vergeben"
          value={title}
          onChange={(e) => setTitle(e.currentTarget.value)}
        />

        {error && (
          <Alert color="red" variant="light" icon={<IconAlertCircle size={16} />}>{error}</Alert>
        )}
        {success && (
          <Alert color="green" variant="light" icon={<IconCheck size={16} />}>{success}</Alert>
        )}

        <Group justify="flex-end">
          <Button variant="subtle" color="gray" onClick={close}>Schliessen</Button>
          <Button leftSection={<IconWand size={16} />} loading={loading} disabled={!canSubmit} onClick={submit}>
            Ausführen
          </Button>
        </Group>
      </Stack>
    </Modal>
  )
}
