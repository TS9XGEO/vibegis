/**
 * Turns geodata into a new WMS layer, via upload-api (see upload-api/app.py),
 * two ways:
 *   - a file (shapefile zip, GeoPackage, GeoJSON, KML, GML) gets loaded into
 *     PostGIS and a LAYER block appended to uploads.map
 *   - an existing PostGIS table gets pointed at directly, no data movement
 * Either way the layer list is always read fresh from GetCapabilities (see
 * wms.ts), so calling load() afterwards is all it takes for it to show up.
 */
import { useEffect, useState } from 'react'
import {
  Alert, Button, FileInput, Group, Modal, SegmentedControl, Select, Stack, Text, TextInput,
} from '@mantine/core'
import { IconAlertCircle, IconCheck, IconDatabase, IconUpload } from '@tabler/icons-react'

import { REGISTER_TABLE_URL, TABLES_URL, UPLOAD_URL, useApp } from './wms'

const ACCEPT = '.zip,.gpkg,.geojson,.json,.kml,.gml'

interface DbTable {
  schema: string
  table: string
  geometry_column: string
  type: string
  srid: number
  registered: boolean
}

function FilePanel({ onDone }: { onDone: (msg: string) => void }) {
  const load = useApp((s) => s.load)
  const setLayerColumns = useApp((s) => s.setLayerColumns)
  const [file, setFile] = useState<File | null>(null)
  const [title, setTitle] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function submit() {
    if (!file) return
    setLoading(true)
    setError(null)

    const form = new FormData()
    form.append('file', file)
    if (title.trim()) form.append('title', title.trim())

    try {
      const res = await fetch(UPLOAD_URL, { method: 'POST', body: form })
      const body = await res.json().catch(() => null)
      if (!res.ok) {
        // A body-less/non-JSON error (e.g. nginx's own 413 page for a file
        // over its size limit, rather than our JSON one) still deserves a
        // readable message instead of a bare status code.
        if (!body?.detail && res.status === 413) throw new Error('Datei zu gross (Limit: 2 GB)')
        throw new Error(body?.detail ?? `Upload fehlgeschlagen: HTTP ${res.status}`)
      }

      onDone(`"${body.title}" geladen (${body.feature_count} Objekte, ${body.geometry_type.toLowerCase()})`)
      if (body.columns) setLayerColumns(body.layer, body.columns)
      setFile(null)
      setTitle('')
      await load()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }

  return (
    <Stack gap="sm">
      <Text size="xs" c="dimmed">
        Shapefile (als .zip), GeoPackage, GeoJSON, KML oder GML. Die Datei wird
        nach EPSG:4326 umprojiziert und als neuer Layer verfügbar.
      </Text>

      <FileInput label="Datei" placeholder="Datei auswählen" accept={ACCEPT} value={file} onChange={setFile} clearable />

      <TextInput
        label="Titel (optional)"
        placeholder={file?.name.replace(/\.[^.]+$/, '') ?? 'wird aus dem Dateinamen abgeleitet'}
        value={title}
        onChange={(e) => setTitle(e.currentTarget.value)}
      />

      {error && (
        <Alert color="red" variant="light" icon={<IconAlertCircle size={16} />}>{error}</Alert>
      )}

      <Group justify="flex-end">
        <Button leftSection={<IconUpload size={16} />} loading={loading} disabled={!file} onClick={submit}>
          Hochladen
        </Button>
      </Group>
    </Stack>
  )
}

function TablePanel({ opened, onDone }: { opened: boolean; onDone: (msg: string) => void }) {
  const load = useApp((s) => s.load)
  const setLayerColumns = useApp((s) => s.setLayerColumns)
  const [tables, setTables] = useState<DbTable[]>([])
  const [tablesLoading, setTablesLoading] = useState(false)
  const [tablesError, setTablesError] = useState<string | null>(null)
  const [selected, setSelected] = useState<string | null>(null)
  const [title, setTitle] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!opened) return
    setTablesLoading(true)
    setTablesError(null)
    fetch(TABLES_URL)
      .then((res) => {
        if (!res.ok) throw new Error(`Tabellenliste: HTTP ${res.status}`)
        return res.json()
      })
      .then((body) => setTables(body.tables ?? []))
      .catch((e) => setTablesError(e instanceof Error ? e.message : String(e)))
      .finally(() => setTablesLoading(false))
  }, [opened])

  const options = tables.map((t) => ({
    value: `${t.schema}.${t.table}`,
    label: `${t.schema}.${t.table}  ·  ${t.type}${t.registered ? '  ·  bereits als Layer registriert' : ''}`,
  }))

  async function submit() {
    if (!selected) return
    const [schema_name, table] = selected.split(/\.(.+)/)
    setLoading(true)
    setError(null)

    try {
      const res = await fetch(REGISTER_TABLE_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ schema_name, table, title: title.trim() || undefined }),
      })
      const body = await res.json().catch(() => null)
      if (!res.ok) throw new Error(body?.detail ?? `Registrieren fehlgeschlagen: HTTP ${res.status}`)

      onDone(`"${body.title}" als Layer registriert (${body.geometry_type.toLowerCase()})`)
      if (body.columns) setLayerColumns(body.layer, body.columns)
      setSelected(null)
      setTitle('')
      await load()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }

  return (
    <Stack gap="sm">
      <Text size="xs" c="dimmed">
        Zeigt einen bereits vorhandenen PostGIS-Tabelle direkt als Layer an — es wird
        nichts kopiert. Tabellen ohne passende Geometriespalte erscheinen nicht.
      </Text>

      <Select
        label="Tabelle"
        placeholder={tablesLoading ? 'lade…' : 'Tabelle auswählen'}
        data={options}
        value={selected}
        onChange={setSelected}
        searchable
        comboboxProps={{ withinPortal: false }}
        disabled={tablesLoading}
      />
      {tablesError && (
        <Alert color="red" variant="light" icon={<IconAlertCircle size={16} />}>{tablesError}</Alert>
      )}

      <TextInput
        label="Titel (optional)"
        placeholder={selected ?? 'wird aus dem Tabellennamen abgeleitet'}
        value={title}
        onChange={(e) => setTitle(e.currentTarget.value)}
      />

      {error && (
        <Alert color="red" variant="light" icon={<IconAlertCircle size={16} />}>{error}</Alert>
      )}

      <Group justify="flex-end">
        <Button leftSection={<IconDatabase size={16} />} loading={loading} disabled={!selected} onClick={submit}>
          Registrieren
        </Button>
      </Group>
    </Stack>
  )
}

export default function UploadLayer({ opened, onClose }: { opened: boolean; onClose: () => void }) {
  const [mode, setMode] = useState<'file' | 'table'>('file')
  const [success, setSuccess] = useState<string | null>(null)

  function close() {
    onClose()
    setSuccess(null)
  }

  return (
    <Modal opened={opened} onClose={close} title="Layer hinzufügen" centered>
      <Stack gap="sm">
        <SegmentedControl
          fullWidth
          value={mode}
          onChange={(v) => { setMode(v as 'file' | 'table'); setSuccess(null) }}
          data={[
            { label: 'Datei hochladen', value: 'file' },
            { label: 'Aus Datenbank-Tabelle', value: 'table' },
          ]}
        />

        {mode === 'file' ? <FilePanel onDone={setSuccess} /> : <TablePanel opened={opened} onDone={setSuccess} />}

        {success && (
          <Alert color="green" variant="light" icon={<IconCheck size={16} />}>{success}</Alert>
        )}

        <Group justify="flex-end">
          <Button variant="subtle" color="gray" onClick={close}>Schliessen</Button>
        </Group>
      </Stack>
    </Modal>
  )
}
