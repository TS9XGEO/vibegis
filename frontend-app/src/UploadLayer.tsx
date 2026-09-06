/**
 * Turns geodata into a new layer, via upload-api (see upload-api/app.py),
 * four ways:
 *   - a vector file (shapefile zip, GeoPackage, GeoJSON, KML, GML) gets
 *     loaded into PostGIS and a LAYER block appended to uploads.map
 *   - an existing PostGIS table gets pointed at directly, no data movement
 *   - a GeoTIFF gets reprojected/tiled by upload-api and published as a
 *     TYPE RASTER layer, no PostGIS table involved
 *   - a LAS/LAZ point cloud gets converted to Cesium 3D Tiles and published
 *     with no MapServer layer at all — it draws as a scene primitive, not as
 *     a WMS tile (see PointCloudLayer.tsx)
 * Calling load() afterwards is all it takes for any of them to show up: the
 * first three are read fresh from GetCapabilities, the fourth from /layers
 * (see wms.ts).
 */
import { useEffect, useState } from 'react'
import {
  Alert, Button, FileInput, Group, Modal, SegmentedControl, Select, Stack, Text, TextInput,
} from '@mantine/core'
import {
  IconAlertCircle, IconCheck, IconDatabase, IconPhoto, IconUpload, IconChartDots3,
} from '@tabler/icons-react'

import { TourTarget } from './tour/TourTarget'
import { useUpload } from './uploadState'
import {
  REGISTER_TABLE_URL, TABLES_URL, UPLOAD_POINTCLOUD_URL, UPLOAD_RASTER_URL,
  UPLOAD_RASTER_ZIP_URL, UPLOAD_URL, useApp,
} from './wms'

export const ACCEPT = '.zip,.gpkg,.geojson,.json,.kml,.gml,.tif,.tiff,.las,.laz'
const RASTER_ACCEPT = '.tif,.tiff,.zip'
const RASTER_NAME_RE = /\.tiff?$/i
const POINTCLOUD_ACCEPT = '.las,.laz'
const POINTCLOUD_NAME_RE = /\.la[sz]$/i

interface DbTable {
  schema: string
  table: string
  geometry_column: string
  type: string
  srid: number
  registered: boolean
}

function FilePanel({ onDone, pendingFile }: { onDone: (msg: string) => void; pendingFile: File | null }) {
  const load = useApp((s) => s.load)
  const setLayerColumns = useApp((s) => s.setLayerColumns)
  const [file, setFile] = useState<File | null>(null)
  const [title, setTitle] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Set once the backend reports a file has more than one spatial layer
  // (upload-api/app.py's needs_layer_choice) — the file itself stays on the
  // server under this token rather than being re-sent, since it can be up
  // to 2 GB.
  const [layerChoice, setLayerChoice] = useState<string[] | null>(null)
  const [chosenLayer, setChosenLayer] = useState<string | null>(null)
  const [uploadToken, setUploadToken] = useState<string | null>(null)

  // A file dropped onto the map (App.tsx's drop zone) arrives here pre-
  // selected, same as if it had been picked via the FileInput below.
  useEffect(() => {
    if (pendingFile) setFile(pendingFile)
  }, [pendingFile])

  function reset() {
    setFile(null)
    setTitle('')
    setLayerChoice(null)
    setChosenLayer(null)
    setUploadToken(null)
  }

  function backOut() {
    setLayerChoice(null)
    setChosenLayer(null)
    setUploadToken(null)
  }

  async function submit() {
    if (!uploadToken && !file) return
    setLoading(true)
    setError(null)

    const form = new FormData()
    // Sent either way (not just as a fallback for the backend): once a
    // layer choice is pending the file itself is no longer part of the
    // request, so the filename-derived title has to travel some other way.
    const derivedTitle = title.trim() || file?.name.replace(/\.[^.]+$/, '') || ''
    if (derivedTitle) form.append('title', derivedTitle)
    if (uploadToken) {
      form.append('upload_token', uploadToken)
      form.append('layer', chosenLayer ?? '')
    } else if (file) {
      form.append('file', file)
    }

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

      if (body.needs_layer_choice) {
        setLayerChoice(body.layers)
        setChosenLayer(body.layers[0] ?? null)
        setUploadToken(body.uploadToken)
        return
      }

      onDone(`"${body.title}" geladen (${body.feature_count} Objekte, ${body.geometry_type.toLowerCase()})`)
      if (body.columns) setLayerColumns(body.layer, body.columns)
      reset()
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

      {layerChoice ? (
        <>
          <Text size="xs">
            <strong>{file?.name}</strong> enthält mehrere Layer. Welcher soll importiert werden?
          </Text>
          <Select
            label="Layer"
            data={layerChoice}
            value={chosenLayer}
            onChange={setChosenLayer}
            allowDeselect={false}
            comboboxProps={{ withinPortal: false }}
          />
        </>
      ) : (
        <TourTarget id="upload-file-input">
          <FileInput label="Datei" placeholder="Datei auswählen" accept={ACCEPT} value={file} onChange={setFile} clearable />
        </TourTarget>
      )}

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
        {layerChoice && (
          <Button variant="subtle" color="gray" onClick={backOut}>Zurück</Button>
        )}
        <TourTarget id="upload-submit-btn">
          <Button
            leftSection={<IconUpload size={16} />}
            loading={loading}
            disabled={layerChoice ? !chosenLayer : !file}
            onClick={submit}
          >
            {layerChoice ? 'Layer importieren' : 'Hochladen'}
          </Button>
        </TourTarget>
      </Group>
    </Stack>
  )
}

function RasterPanel({ onDone, pendingFile }: { onDone: (msg: string) => void; pendingFile: File | null }) {
  const load = useApp((s) => s.load)
  const [file, setFile] = useState<File | null>(null)
  const [title, setTitle] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (pendingFile) setFile(pendingFile)
  }, [pendingFile])

  function reset() {
    setFile(null)
    setTitle('')
  }

  async function submit() {
    if (!file) return
    setLoading(true)
    setError(null)

    const isZip = file.name.toLowerCase().endsWith('.zip')
    const form = new FormData()
    form.append('file', file)
    // For a GeoTIFF this names the one layer; for a zip it names the whole
    // batch (shown as one collapsible group in the layer panel) rather than
    // any single band — either way it falls back to the filename.
    const derivedTitle = title.trim() || file.name.replace(/\.[^.]+$/, '')
    if (derivedTitle) form.append('title', derivedTitle)

    try {
      const res = await fetch(isZip ? UPLOAD_RASTER_ZIP_URL : UPLOAD_RASTER_URL, { method: 'POST', body: form })
      const body = await res.json().catch(() => null)
      if (!res.ok) {
        if (!body?.detail && res.status === 413) throw new Error('Datei zu gross (Limit: 2 GB)')
        throw new Error(body?.detail ?? `Upload fehlgeschlagen: HTTP ${res.status}`)
      }

      if (isZip) {
        const n = body.published?.length ?? 0
        const failedList = (body.failed ?? []) as { input: string; error: string }[]
        onDone(
          failedList.length
            ? `${n} Bänder veröffentlicht, ${failedList.length} fehlgeschlagen: ${failedList.map((f) => f.error).join('; ')}`
            : `${n} Bänder veröffentlicht`,
        )
      } else {
        onDone(`"${body.title}" geladen (${body.bands} Band(er), ${body.width}×${body.height})`)
      }
      reset()
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
        GeoTIFF, oder ein Zip mit mehreren Bändern (z.B. ein Sentinel-Produkt — jedes
        Band wird als eigener Layer veröffentlicht). Wird nach EPSG:4326 umprojiziert,
        gekachelt und mit Übersichtsstufen versehen. Ein RGB-Komposit aus veröffentlichten
        Bändern lässt sich anschliessend im Layerbaum zusammenstellen.
      </Text>

      <FileInput label="Datei" placeholder="Datei auswählen" accept={RASTER_ACCEPT} value={file} onChange={setFile} clearable />

      <TextInput
        label={file?.name.toLowerCase().endsWith('.zip') ? 'Titel der Gruppe (optional)' : 'Titel (optional)'}
        placeholder={file?.name.replace(/\.[^.]+$/, '') ?? 'wird aus dem Dateinamen abgeleitet'}
        value={title}
        onChange={(e) => setTitle(e.currentTarget.value)}
      />

      {error && (
        <Alert color="red" variant="light" icon={<IconAlertCircle size={16} />}>{error}</Alert>
      )}

      <Group justify="flex-end">
        <Button leftSection={<IconPhoto size={16} />} loading={loading} disabled={!file} onClick={submit}>
          Hochladen
        </Button>
      </Group>
    </Stack>
  )
}

function PointCloudPanel({ onDone, pendingFile }: { onDone: (msg: string) => void; pendingFile: File | null }) {
  const load = useApp((s) => s.load)
  const [file, setFile] = useState<File | null>(null)
  const [title, setTitle] = useState('')
  const [srs, setSrs] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (pendingFile) setFile(pendingFile)
  }, [pendingFile])

  function reset() {
    setFile(null)
    setTitle('')
    setSrs('')
  }

  async function submit() {
    if (!file) return
    setLoading(true)
    setError(null)

    const form = new FormData()
    form.append('file', file)
    const derivedTitle = title.trim() || file.name.replace(/\.[^.]+$/, '')
    if (derivedTitle) form.append('title', derivedTitle)
    // Only sent when actually filled in: upload-api prefers the LAS header's
    // own CRS and only falls back to this, so an empty field must not
    // override a file that already knows where it is.
    if (srs.trim()) form.append('srs', srs.trim())

    try {
      const res = await fetch(UPLOAD_POINTCLOUD_URL, { method: 'POST', body: form })
      const body = await res.json().catch(() => null)
      if (!res.ok) {
        if (!body?.detail && res.status === 413) throw new Error('Datei zu gross (Limit: 2 GB)')
        throw new Error(body?.detail ?? `Upload fehlgeschlagen: HTTP ${res.status}`)
      }
      onDone(`"${body.title}" geladen (${body.point_count.toLocaleString('de-DE')} Punkte)`)
      reset()
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
        LAS- oder LAZ-Punktwolke (z.B. ein LiDAR-Scan). Wird serverseitig nach Cesium
        3D Tiles konvertiert und direkt im Globus dargestellt — kein WMS-Layer, keine
        PostGIS-Tabelle. Die Konvertierung läuft während des Uploads und kann bei
        grossen Dateien einige Minuten dauern.
      </Text>

      <FileInput label="Datei" placeholder="Datei auswählen" accept={POINTCLOUD_ACCEPT} value={file} onChange={setFile} clearable />

      <TextInput
        label="Titel (optional)"
        placeholder={file?.name.replace(/\.[^.]+$/, '') ?? 'wird aus dem Dateinamen abgeleitet'}
        value={title}
        onChange={(e) => setTitle(e.currentTarget.value)}
      />

      <TextInput
        label="EPSG-Code (optional)"
        description="Nur nötig, wenn die Datei kein Koordinatensystem enthält — z.B. 25832"
        placeholder="aus der Datei gelesen"
        value={srs}
        onChange={(e) => setSrs(e.currentTarget.value)}
      />

      {error && (
        <Alert color="red" variant="light" icon={<IconAlertCircle size={16} />}>{error}</Alert>
      )}

      <Group justify="flex-end">
        <Button leftSection={<IconChartDots3 size={16} />} loading={loading} disabled={!file} onClick={submit}>
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

type UploadMode = 'file' | 'raster' | 'pointcloud' | 'table'

export default function UploadLayer() {
  const opened = useUpload((s) => s.opened)
  const pendingFile = useUpload((s) => s.pendingFile)
  const closeUpload = useUpload((s) => s.close)
  const [mode, setMode] = useState<UploadMode>('file')
  const [success, setSuccess] = useState<string | null>(null)

  // A file dropped onto the map always means "upload a file", regardless of
  // whichever mode the modal was last left in — routed to the raster panel
  // when it's a GeoTIFF, the point-cloud panel for a LAS/LAZ, the vector
  // panel otherwise.
  useEffect(() => {
    if (!pendingFile) return
    if (RASTER_NAME_RE.test(pendingFile.name)) setMode('raster')
    else if (POINTCLOUD_NAME_RE.test(pendingFile.name)) setMode('pointcloud')
    else setMode('file')
  }, [pendingFile])

  function close() {
    closeUpload()
    setSuccess(null)
  }

  return (
    <Modal opened={opened} onClose={close} title="Layer hinzufügen" centered>
      <Stack gap="sm">
        <SegmentedControl
          fullWidth
          value={mode}
          onChange={(v) => { setMode(v as UploadMode); setSuccess(null) }}
          // Shortened from "Datei hochladen"/"Raster hochladen"/"Aus
          // Datenbank-Tabelle": a fourth full-width segment leaves no room
          // for the longer labels, and the panel below each one already
          // explains itself.
          data={[
            { label: 'Datei', value: 'file' },
            { label: 'Raster', value: 'raster' },
            { label: 'Punktwolke', value: 'pointcloud' },
            { label: 'Tabelle', value: 'table' },
          ]}
        />

        {mode === 'file' && <FilePanel onDone={setSuccess} pendingFile={pendingFile} />}
        {mode === 'raster' && <RasterPanel onDone={setSuccess} pendingFile={pendingFile} />}
        {mode === 'pointcloud' && <PointCloudPanel onDone={setSuccess} pendingFile={pendingFile} />}
        {mode === 'table' && <TablePanel opened={opened} onDone={setSuccess} />}

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
