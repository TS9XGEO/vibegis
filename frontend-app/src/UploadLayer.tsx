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
import { useTranslation } from 'react-i18next'

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
  const { t } = useTranslation()
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
        if (!body?.detail && res.status === 413) throw new Error(t('uploadLayer.tooLarge'))
        throw new Error(body?.detail ?? t('uploadLayer.uploadFailed', { status: res.status }))
      }

      if (body.needs_layer_choice) {
        setLayerChoice(body.layers)
        setChosenLayer(body.layers[0] ?? null)
        setUploadToken(body.uploadToken)
        return
      }

      onDone(t('uploadLayer.fileSuccess', {
        title: body.title, count: body.feature_count, geometryType: body.geometry_type.toLowerCase(),
      }))
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
        {t('uploadLayer.fileIntro')}
      </Text>

      {layerChoice ? (
        <>
          <Text size="xs">
            <strong>{file?.name}</strong> {t('uploadLayer.multiLayerFile')}
          </Text>
          <Select
            label={t('uploadLayer.layerLabel')}
            data={layerChoice}
            value={chosenLayer}
            onChange={setChosenLayer}
            allowDeselect={false}
            comboboxProps={{ withinPortal: false }}
          />
        </>
      ) : (
        <TourTarget id="upload-file-input">
          <FileInput label={t('uploadLayer.fileLabel')} placeholder={t('uploadLayer.filePlaceholder')} accept={ACCEPT} value={file} onChange={setFile} clearable />
        </TourTarget>
      )}

      <TextInput
        label={t('uploadLayer.titleLabel')}
        placeholder={file?.name.replace(/\.[^.]+$/, '') ?? t('uploadLayer.titleFromFilename')}
        value={title}
        onChange={(e) => setTitle(e.currentTarget.value)}
      />

      {error && (
        <Alert color="red" variant="light" icon={<IconAlertCircle size={16} />}>{error}</Alert>
      )}

      <Group justify="flex-end">
        {layerChoice && (
          <Button variant="subtle" color="gray" onClick={backOut}>{t('uploadLayer.back')}</Button>
        )}
        <TourTarget id="upload-submit-btn">
          <Button
            leftSection={<IconUpload size={16} />}
            loading={loading}
            disabled={layerChoice ? !chosenLayer : !file}
            onClick={submit}
          >
            {layerChoice ? t('uploadLayer.importLayer') : t('uploadLayer.upload')}
          </Button>
        </TourTarget>
      </Group>
    </Stack>
  )
}

function RasterPanel({ onDone, pendingFile }: { onDone: (msg: string) => void; pendingFile: File | null }) {
  const { t } = useTranslation()
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
        if (!body?.detail && res.status === 413) throw new Error(t('uploadLayer.tooLarge'))
        throw new Error(body?.detail ?? t('uploadLayer.uploadFailed', { status: res.status }))
      }

      if (isZip) {
        const n = body.published?.length ?? 0
        const failedList = (body.failed ?? []) as { input: string; error: string }[]
        onDone(
          failedList.length
            ? t('uploadLayer.rasterBandsPublishedWithFailures', {
              count: n, failedCount: failedList.length, errors: failedList.map((f) => f.error).join('; '),
            })
            : t('uploadLayer.rasterBandsPublished', { count: n }),
        )
      } else {
        onDone(t('uploadLayer.rasterSuccess', { title: body.title, bands: body.bands, width: body.width, height: body.height }))
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
        {t('uploadLayer.rasterIntro')}
      </Text>

      <FileInput label={t('uploadLayer.fileLabel')} placeholder={t('uploadLayer.filePlaceholder')} accept={RASTER_ACCEPT} value={file} onChange={setFile} clearable />

      <TextInput
        label={file?.name.toLowerCase().endsWith('.zip') ? t('uploadLayer.titleOfGroup') : t('uploadLayer.titleLabel')}
        placeholder={file?.name.replace(/\.[^.]+$/, '') ?? t('uploadLayer.titleFromFilename')}
        value={title}
        onChange={(e) => setTitle(e.currentTarget.value)}
      />

      {error && (
        <Alert color="red" variant="light" icon={<IconAlertCircle size={16} />}>{error}</Alert>
      )}

      <Group justify="flex-end">
        <Button leftSection={<IconPhoto size={16} />} loading={loading} disabled={!file} onClick={submit}>
          {t('uploadLayer.upload')}
        </Button>
      </Group>
    </Stack>
  )
}

function PointCloudPanel({ onDone, pendingFile }: { onDone: (msg: string) => void; pendingFile: File | null }) {
  const { t } = useTranslation()
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
        if (!body?.detail && res.status === 413) throw new Error(t('uploadLayer.tooLarge'))
        throw new Error(body?.detail ?? t('uploadLayer.uploadFailed', { status: res.status }))
      }
      onDone(t('uploadLayer.pointcloudSuccess', { title: body.title, count: body.point_count.toLocaleString('de-DE') }))
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
        {t('uploadLayer.pointcloudIntro')}
      </Text>

      <FileInput label={t('uploadLayer.fileLabel')} placeholder={t('uploadLayer.filePlaceholder')} accept={POINTCLOUD_ACCEPT} value={file} onChange={setFile} clearable />

      <TextInput
        label={t('uploadLayer.titleLabel')}
        placeholder={file?.name.replace(/\.[^.]+$/, '') ?? t('uploadLayer.titleFromFilename')}
        value={title}
        onChange={(e) => setTitle(e.currentTarget.value)}
      />

      <TextInput
        label={t('uploadLayer.epsgCode')}
        description={t('uploadLayer.epsgHint')}
        placeholder={t('uploadLayer.epsgPlaceholder')}
        value={srs}
        onChange={(e) => setSrs(e.currentTarget.value)}
      />

      {error && (
        <Alert color="red" variant="light" icon={<IconAlertCircle size={16} />}>{error}</Alert>
      )}

      <Group justify="flex-end">
        <Button leftSection={<IconChartDots3 size={16} />} loading={loading} disabled={!file} onClick={submit}>
          {t('uploadLayer.upload')}
        </Button>
      </Group>
    </Stack>
  )
}

function TablePanel({ opened, onDone }: { opened: boolean; onDone: (msg: string) => void }) {
  const { t } = useTranslation()
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
        if (!res.ok) throw new Error(t('uploadLayer.tableListFailed', { status: res.status }))
        return res.json()
      })
      .then((body) => setTables(body.tables ?? []))
      .catch((e) => setTablesError(e instanceof Error ? e.message : String(e)))
      .finally(() => setTablesLoading(false))
  }, [opened])

  const options = tables.map((tbl) => ({
    value: `${tbl.schema}.${tbl.table}`,
    label: `${tbl.schema}.${tbl.table}  ·  ${tbl.type}${tbl.registered ? `  ·  ${t('uploadLayer.alreadyRegistered')}` : ''}`,
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
      if (!res.ok) throw new Error(body?.detail ?? t('uploadLayer.registerFailed', { status: res.status }))

      onDone(t('uploadLayer.tableSuccess', { title: body.title, geometryType: body.geometry_type.toLowerCase() }))
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
        {t('uploadLayer.tableIntro')}
      </Text>

      <Select
        label={t('uploadLayer.tableLabel')}
        placeholder={tablesLoading ? t('common.loading') : t('uploadLayer.tablePlaceholder')}
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
        label={t('uploadLayer.titleLabel')}
        placeholder={selected ?? t('uploadLayer.titleFromTableName')}
        value={title}
        onChange={(e) => setTitle(e.currentTarget.value)}
      />

      {error && (
        <Alert color="red" variant="light" icon={<IconAlertCircle size={16} />}>{error}</Alert>
      )}

      <Group justify="flex-end">
        <Button leftSection={<IconDatabase size={16} />} loading={loading} disabled={!selected} onClick={submit}>
          {t('uploadLayer.register')}
        </Button>
      </Group>
    </Stack>
  )
}

type UploadMode = 'file' | 'raster' | 'pointcloud' | 'table'

export default function UploadLayer() {
  const { t } = useTranslation()
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
    <Modal opened={opened} onClose={close} title={t('uploadLayer.modalTitle')} centered>
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
            { label: t('uploadLayer.modeFile'), value: 'file' },
            { label: t('uploadLayer.modeRaster'), value: 'raster' },
            { label: t('uploadLayer.modePointcloud'), value: 'pointcloud' },
            { label: t('uploadLayer.modeTable'), value: 'table' },
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
          <Button variant="subtle" color="gray" onClick={close}>{t('common.close')}</Button>
        </Group>
      </Stack>
    </Modal>
  )
}
