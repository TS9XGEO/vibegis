/**
 * Layer panel: visibility, opacity, drag-to-reorder, legend, zoom-to-extent.
 *
 * Reordering is pure state — dnd-kit hands back an index pair, the store
 * swaps the array, and the Scene re-renders in the new order. Nothing touches
 * Cesium directly.
 */
import { useMemo, useState } from 'react'
import {
  ActionIcon,
  Alert,
  Badge,
  Box,
  Button,
  Checkbox,
  Collapse,
  Group,
  Loader,
  Paper,
  Popover,
  ScrollArea,
  Select,
  Slider,
  Stack,
  Switch,
  Text,
  TextInput,
  Tooltip,
  useComputedColorScheme,
  useMantineColorScheme,
} from '@mantine/core'
import { useDisclosure } from '@mantine/hooks'
import {
  IconChevronDown,
  IconChevronRight,
  IconChevronUp,
  IconColorSwatch,
  IconCurrentLocation,
  IconDotsVertical,
  IconEyeOff,
  IconGripVertical,
  IconList,
  IconPencil,
  IconSearch,
  IconStack2,
  IconTable,
  IconMoonStars,
  IconSun,
  IconTags,
  IconTrash,
  IconUpload,
  IconUsers,
  IconX,
} from '@tabler/icons-react'
import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
} from '@dnd-kit/core'
import { restrictToVerticalAxis } from '@dnd-kit/modifiers'
import {
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { Rectangle } from 'cesium'

import AttributeFilterButton from './AttributeFilter'
import ClassifyLayer from './ClassifyLayer'
import LegendSymbols from './Legend'
import UploadLayer from './UploadLayer'
import UserAdmin from './UserAdmin'
import { useAuth } from './auth'
import { accentEdge, panelBg, panelBorder } from './colorScheme'
import { usePanels } from './panels'
import { useSelection } from './selection'
import { useUpload } from './uploadState'
import type { LayerState } from './wms'
import { LAYERS_URL, RASTER_COMPOSITE_URL, collectionFor, isManaged, useApp } from './wms'

function DeleteLayerButton({ layer }: { layer: LayerState }) {
  const load = useApp((s) => s.load)
  const layerConfigs = useApp((s) => s.layerConfigs)
  const displayTitle = layerConfigs[layer.name]?.title || layer.title
  const [opened, setOpened] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const isRaster = layer.geomType === 'raster'

  async function doDelete(dropTable: boolean) {
    setBusy(true)
    setError(null)
    try {
      const res = await fetch(`${LAYERS_URL}/${encodeURIComponent(layer.name)}?drop_table=${dropTable}`, {
        method: 'DELETE',
      })
      const body = await res.json().catch(() => null)
      if (!res.ok) throw new Error(body?.detail ?? `Löschen fehlgeschlagen: HTTP ${res.status}`)
      setOpened(false)
      await load()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Popover opened={opened} onChange={setOpened} position="bottom-end" withArrow shadow="md">
      <Popover.Target>
        <Tooltip label="Layer löschen" withArrow>
          <ActionIcon
            variant="subtle"
            color="gray"
            size="sm"
            aria-label="Layer löschen"
            onClick={() => setOpened((o) => !o)}
          >
            <IconTrash size={13} />
          </ActionIcon>
        </Tooltip>
      </Popover.Target>
      <Popover.Dropdown>
        <Stack gap={6} miw={230}>
          <Group justify="space-between" wrap="nowrap" gap={4}>
            <Text size="xs" fw={600} truncate>"{displayTitle}" löschen</Text>
            <ActionIcon variant="subtle" color="gray" size="sm" aria-label="Schliessen" onClick={() => setOpened(false)}>
              <IconX size={14} />
            </ActionIcon>
          </Group>
          {error && <Text size="xs" c="red">{error}</Text>}
          <Button size="xs" color="red" loading={busy} onClick={() => doDelete(true)}>
            {isRaster ? 'Layer + Datei löschen' : 'Layer + Datenbanktabelle löschen'}
          </Button>
          <Button size="xs" variant="default" loading={busy} onClick={() => doDelete(false)}>
            {isRaster ? 'Nur Layer löschen (Datei bleibt)' : 'Nur Layer löschen (Tabelle bleibt)'}
          </Button>
        </Stack>
      </Popover.Dropdown>
    </Popover>
  )
}

type Channel = 'red' | 'green' | 'blue'
const CHANNEL_LABEL: Record<Channel, string> = { red: 'Rot', green: 'Grün', blue: 'Blau' }

type TreeItem =
  | { kind: 'single'; layer: LayerState }
  | { kind: 'batch'; batch: string; title: string; layers: LayerState[] }

function LayerRow({
  layer, onOpenTable, channel,
}: {
  layer: LayerState
  onOpenTable: (layer: LayerState, collection: string) => void
  /** Only set for a band inside an expanded BatchGroupRow — lets this row
   * assign itself to a composite channel inline, next to its own name. */
  channel?: { value: Channel | null; onChange: (v: Channel | null) => void }
}) {
  const toggle = useApp((s) => s.toggle)
  const toggleClustered = useApp((s) => s.toggleClustered)
  const clusterTruncated = useApp((s) => s.clusterTruncated[layer.name])
  const setOpacity = useApp((s) => s.setOpacity)
  const move = useApp((s) => s.move)
  const camera = useApp((s) => s.camera)
  const layerConfigs = useApp((s) => s.layerConfigs)
  const saveTitle = useApp((s) => s.saveTitle)
  const displayTitle = layerConfigs[layer.name]?.title || layer.title
  const [legendOpen, setLegendOpen] = useState(false)
  const [classifyOpen, setClassifyOpen] = useState(false)
  const [editingTitle, setEditingTitle] = useState(false)
  const [titleDraft, setTitleDraft] = useState('')
  const [actionsOpen, setActionsOpen] = useState(false)
  const dynamicCollections = useApp((s) => s.dynamicCollections)
  const managedLayers = useApp((s) => s.managedLayers)
  const isTableOpen = useSelection((s) => s.openLayers.some((o) => o.name === layer.name))
  const collection = collectionFor(layer.name, dynamicCollections)
  // Uploaded and registered layers are the same thing as far as the UI is
  // concerned: both have a block in uploads.map, so both get the full set.
  // This reads the group out of capabilities, so it survives upload-api being
  // down — deleting only ever needed the layer name.
  const deletable = isManaged(layer, managedLayers)

  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: layer.name,
  })

  const flyTo = () => {
    if (!camera || !layer.bbox) return
    const { west, south, east, north } = layer.bbox
    camera.flyTo({
      destination: Rectangle.fromDegrees(west, south, east, north),
      duration: 1.2,
    })
  }

  function startEditingTitle() {
    setTitleDraft(displayTitle)
    setEditingTitle(true)
  }

  function commitTitle() {
    setEditingTitle(false)
    if (titleDraft.trim() !== displayTitle) void saveTitle(layer.name, titleDraft)
  }

  // Turning a layer on is also the moment its options (classify, filter,
  // attribute table…) become relevant, so surface them right away rather
  // than making that a separate click — and turning it back off is the
  // moment they stop being relevant, so the menu follows the layer's state
  // symmetrically in both directions. Same reasoning is why the attribute
  // table itself opens automatically here too, not just its action row —
  // no `collection` (a raster, or one collectionFor() can't resolve) means
  // there's nothing to open, same guard the table button itself uses.
  function toggleVisible() {
    const activating = !layer.visible
    toggle(layer.name)
    setActionsOpen(activating)
    if (activating && collection) onOpenTable(layer, collection)
  }

  return (
    <Box
      ref={setNodeRef}
      style={{
        transform: CSS.Transform.toString(transform),
        transition,
        opacity: isDragging ? 0.45 : 1,
        position: 'relative',
        zIndex: isDragging ? 5 : 'auto',
      }}
      px={4}
      py={2}
    >
      <Group gap={4} wrap="nowrap">
        <ActionIcon
          variant="subtle"
          color="gray"
          size="sm"
          // touchAction:none is REQUIRED by dnd-kit's PointerSensor. Without it
          // the browser claims the gesture for scrolling and no drag starts.
          style={{ cursor: 'grab', touchAction: 'none' }}
          {...attributes}
          {...listeners}
        >
          <IconGripVertical size={14} />
        </ActionIcon>

        <Checkbox size="xs" checked={layer.visible} onChange={toggleVisible} />

        {editingTitle ? (
          <TextInput
            size="xs"
            autoFocus
            value={titleDraft}
            onChange={(e) => setTitleDraft(e.currentTarget.value)}
            onBlur={commitTitle}
            onKeyDown={(e) => {
              if (e.key === 'Enter') e.currentTarget.blur()
              if (e.key === 'Escape') setEditingTitle(false)
            }}
            style={{ flex: 1, minWidth: 0 }}
          />
        ) : (
          <Tooltip label={layer.name} openDelay={500} withArrow>
            <Text
              size="sm"
              c={layer.visible ? undefined : 'dimmed'}
              style={{ flex: 1, minWidth: 0, cursor: 'pointer' }}
              truncate
              onClick={toggleVisible}
            >
              {displayTitle}
            </Text>
          </Tooltip>
        )}

        {channel && (
          <Select
            size="xs"
            w={64}
            placeholder="–"
            data={(['red', 'green', 'blue'] as Channel[]).map((c) => ({ value: c, label: CHANNEL_LABEL[c] }))}
            value={channel.value}
            onChange={(v) => channel.onChange(v as Channel | null)}
            clearable
            comboboxProps={{ withinPortal: false }}
            aria-label="Komposit-Kanal"
          />
        )}

        <Tooltip label="Weitere Optionen" withArrow>
          <ActionIcon
            variant="subtle"
            color={actionsOpen ? 'teal' : 'gray'}
            size="sm"
            aria-label="Weitere Optionen"
            onClick={() => setActionsOpen((o) => !o)}
          >
            <IconDotsVertical size={13} />
          </ActionIcon>
        </Tooltip>

        {collection && (
          <ClassifyLayer
            opened={classifyOpen}
            onClose={() => setClassifyOpen(false)}
            layerName={layer.name}
            collection={collection}
          />
        )}
      </Group>

      <Collapse in={actionsOpen}>
        <Group gap={4} wrap="nowrap" pl={30} pt={2}>
          <Tooltip label="Umbenennen" withArrow>
            <ActionIcon
              variant="subtle"
              color="gray"
              size="sm"
              aria-label="Layer umbenennen"
              onClick={startEditingTitle}
            >
              <IconPencil size={13} />
            </ActionIcon>
          </Tooltip>

          {layer.geomType !== 'raster' && (
            <Tooltip label="Legende" withArrow>
              <ActionIcon
                variant="subtle"
                color={legendOpen ? 'teal' : 'gray'}
                size="sm"
                onClick={() => setLegendOpen((o) => !o)}
              >
                <IconList size={13} />
              </ActionIcon>
            </Tooltip>
          )}

          {layer.geomType === 'point' && collection && (
            <Tooltip label="Punkte gruppieren" withArrow>
              <ActionIcon
                variant="subtle"
                color={layer.clustered ? 'teal' : 'gray'}
                size="sm"
                aria-label="Punkte gruppieren"
                onClick={() => toggleClustered(layer.name)}
              >
                <IconStack2 size={13} />
              </ActionIcon>
            </Tooltip>
          )}

          {collection && (
            <Tooltip label="Sachdaten anzeigen" withArrow>
              <ActionIcon
                variant="subtle"
                color={isTableOpen ? 'teal' : 'gray'}
                size="sm"
                aria-label="Sachdaten anzeigen"
                onClick={() => onOpenTable(layer, collection)}
              >
                <IconTable size={13} />
              </ActionIcon>
            </Tooltip>
          )}

          {collection && <AttributeFilterButton layerName={layer.name} collection={collection} />}

          {collection && (
            <Tooltip label="Klassifizierung" withArrow>
              <ActionIcon
                variant="subtle"
                color="gray"
                size="sm"
                aria-label="Klassifizierung"
                onClick={() => setClassifyOpen(true)}
              >
                <IconTags size={13} />
              </ActionIcon>
            </Tooltip>
          )}

          {layer.bbox && (
            <Tooltip label="Auf Layer zoomen" withArrow>
              <ActionIcon variant="subtle" color="gray" size="sm" onClick={flyTo}>
                <IconCurrentLocation size={13} />
              </ActionIcon>
            </Tooltip>
          )}

          {deletable && <DeleteLayerButton layer={layer} />}

          <ActionIcon variant="subtle" color="gray" size="sm" onClick={() => move(layer.name, -1)}>
            <IconChevronUp size={13} />
          </ActionIcon>
          <ActionIcon variant="subtle" color="gray" size="sm" onClick={() => move(layer.name, 1)}>
            <IconChevronDown size={13} />
          </ActionIcon>
        </Group>
      </Collapse>

      {layer.clustered && clusterTruncated && (
        <Text size="xs" c="dimmed" pl={30} pt={2}>
          Zeigt nur einen Ausschnitt – zum Anzeigen aller Punkte weiter einzoomen.
        </Text>
      )}

      {layer.visible && (
        <Group gap={8} pl={30} pr={4} pt={2} wrap="nowrap">
          <Slider
            size="xs"
            style={{ flex: 1 }}
            min={0}
            max={100}
            value={Math.round(layer.opacity * 100)}
            onChange={(v) => setOpacity(layer.name, v / 100)}
            label={null}
          />
          <Text size="10px" c="dimmed" w={30} ta="right">
            {Math.round(layer.opacity * 100)}%
          </Text>
        </Group>
      )}

      <Collapse in={legendOpen}>
        <Box pl={30} pr={4} pt={4} pb={2}>
          <LegendSymbols layerName={layer.name} active={legendOpen} />
        </Box>
      </Collapse>
    </Box>
  )
}

/**
 * Collapses every band from one /upload-raster-zip upload under one named
 * group (see LayerState.batch/.batchTitle) — purely a display grouping,
 * independent of GROUP "uploads" membership, since MapServer's own GROUP
 * has no hierarchy to nest under. Each band row gets an inline Rot/Grün/Blau
 * channel picker (LayerRow's optional `channel` prop); once all three are
 * assigned, an inline title+"Erstellen" control publishes the composite via
 * the same /raster-composite endpoint the header's RasterCompositeButton
 * uses — that button stays too, for combining bands across batches, which
 * this per-batch draft can't reach.
 */
function BatchGroupRow({
  title, layers, onOpenTable,
}: {
  title: string
  layers: LayerState[]
  onOpenTable: (layer: LayerState, collection: string) => void
}) {
  const load = useApp((s) => s.load)
  const toggle = useApp((s) => s.toggle)
  const [expanded, setExpanded] = useState(true)
  const [draft, setDraft] = useState<Record<Channel, string | null>>({ red: null, green: null, blue: null })
  const [compositeTitle, setCompositeTitle] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [deleteOpen, setDeleteOpen] = useState(false)
  const [deleteBusy, setDeleteBusy] = useState(false)
  const [deleteError, setDeleteError] = useState<string | null>(null)

  const CHANNELS: Channel[] = ['red', 'green', 'blue']

  async function deleteGroup() {
    setDeleteBusy(true)
    setDeleteError(null)
    try {
      for (const l of layers) {
        const res = await fetch(`${LAYERS_URL}/${encodeURIComponent(l.name)}?drop_table=true`, {
          method: 'DELETE',
        })
        if (!res.ok) {
          const body = await res.json().catch(() => null)
          throw new Error(body?.detail ?? `Löschen von "${l.name}" fehlgeschlagen: HTTP ${res.status}`)
        }
      }
      setDeleteOpen(false)
      await load()
    } catch (e) {
      setDeleteError(e instanceof Error ? e.message : String(e))
    } finally {
      setDeleteBusy(false)
    }
  }

  function setChannel(layerName: string, value: Channel | null) {
    setDraft((d) => {
      // At most one band per channel: clear whichever band currently holds
      // the target channel (or this same band's old channel) before setting.
      const next: Record<Channel, string | null> = { red: null, green: null, blue: null }
      for (const c of CHANNELS) next[c] = d[c] === layerName ? null : d[c]
      if (value) next[value] = layerName
      return next
    })
  }

  function channelOf(layerName: string): Channel | null {
    return CHANNELS.find((c) => draft[c] === layerName) ?? null
  }

  function hideAll() {
    for (const l of layers) if (l.visible) toggle(l.name)
  }

  const ready = !!(draft.red && draft.green && draft.blue)

  async function submit() {
    if (!ready) return
    setBusy(true)
    setError(null)
    try {
      const res = await fetch(RASTER_COMPOSITE_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          red: draft.red, green: draft.green, blue: draft.blue,
          title: compositeTitle.trim() || undefined,
        }),
      })
      const body = await res.json().catch(() => null)
      if (!res.ok) throw new Error(body?.detail ?? `Komposit fehlgeschlagen: HTTP ${res.status}`)
      setDraft({ red: null, green: null, blue: null })
      setCompositeTitle('')
      await load()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Box px={4} py={2}>
      <Group gap={6} wrap="nowrap">
        <Group gap={6} wrap="nowrap" style={{ flex: 1, minWidth: 0, cursor: 'pointer' }} onClick={() => setExpanded((o) => !o)}>
          {expanded ? <IconChevronDown size={14} /> : <IconChevronRight size={14} />}
          <Text size="sm" fw={500} style={{ flex: 1, minWidth: 0 }} truncate>{title}</Text>
          <Badge size="xs" variant="light" color="gray">{layers.length}</Badge>
        </Group>
        <Tooltip label="Alle Layer der Gruppe ausblenden" withArrow>
          <ActionIcon
            variant="subtle"
            color="gray"
            size="sm"
            aria-label="Alle Layer der Gruppe ausblenden"
            disabled={!layers.some((l) => l.visible)}
            onClick={(e) => {
              e.stopPropagation()
              hideAll()
            }}
          >
            <IconEyeOff size={13} />
          </ActionIcon>
        </Tooltip>
        <Popover opened={deleteOpen} onChange={setDeleteOpen} position="bottom-end" withArrow shadow="md">
          <Popover.Target>
            <Tooltip label="Gruppe löschen" withArrow>
              <ActionIcon
                variant="subtle"
                color="gray"
                size="sm"
                aria-label="Gruppe löschen"
                onClick={(e) => {
                  e.stopPropagation()
                  setDeleteOpen((o) => !o)
                }}
              >
                <IconTrash size={13} />
              </ActionIcon>
            </Tooltip>
          </Popover.Target>
          <Popover.Dropdown onClick={(e) => e.stopPropagation()}>
            <Stack gap={6} miw={230}>
              <Group justify="space-between" wrap="nowrap" gap={4}>
                <Text size="xs" fw={600} truncate>"{title}" löschen</Text>
                <ActionIcon variant="subtle" color="gray" size="sm" aria-label="Schliessen" onClick={() => setDeleteOpen(false)}>
                  <IconX size={14} />
                </ActionIcon>
              </Group>
              <Text size="xs" c="dimmed">Löscht alle {layers.length} Bänder dieser Gruppe samt Dateien.</Text>
              {deleteError && <Text size="xs" c="red">{deleteError}</Text>}
              <Button size="xs" color="red" loading={deleteBusy} onClick={deleteGroup}>
                Gruppe + Dateien löschen
              </Button>
            </Stack>
          </Popover.Dropdown>
        </Popover>
      </Group>

      <Collapse in={expanded}>
        <Box pl={14}>
          {layers.map((l) => (
            <LayerRow
              key={l.name}
              layer={l}
              onOpenTable={onOpenTable}
              channel={{ value: channelOf(l.name), onChange: (v) => setChannel(l.name, v) }}
            />
          ))}

          {ready && (
            <Group gap={4} wrap="nowrap" pl={30} pt={2} pb={4}>
              <TextInput
                size="xs"
                placeholder="Titel des Komposits"
                value={compositeTitle}
                onChange={(e) => setCompositeTitle(e.currentTarget.value)}
                style={{ flex: 1, minWidth: 0 }}
              />
              <Button size="xs" loading={busy} onClick={submit}>Erstellen</Button>
            </Group>
          )}
          {error && <Text size="xs" c="red" pl={30} pb={4}>{error}</Text>}
        </Box>
      </Collapse>
    </Box>
  )
}

/**
 * Combines three already-published single-band raster layers into one RGB
 * layer, via /raster-composite — a small VRT referencing the three files
 * directly (every published raster is already reprojected to EPSG:4326 at
 * its own publish time, so no new reprojection pass is needed here), not a
 * step in the upload flow: the picker lists whatever single-band raster
 * layers happen to be in the tree right now, from any upload.
 */
function RasterCompositeButton() {
  const layers = useApp((s) => s.layers)
  const layerConfigs = useApp((s) => s.layerConfigs)
  const load = useApp((s) => s.load)
  const [opened, setOpened] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [title, setTitle] = useState('')
  const [red, setRed] = useState<string | null>(null)
  const [green, setGreen] = useState<string | null>(null)
  const [blue, setBlue] = useState<string | null>(null)

  const bandOptions = layers
    .filter((l) => l.geomType === 'raster' && l.bands === 1)
    .map((l) => ({ value: l.name, label: layerConfigs[l.name]?.title || l.title }))

  function reset() {
    setTitle('')
    setRed(null)
    setGreen(null)
    setBlue(null)
    setError(null)
  }

  async function submit() {
    if (!red || !green || !blue) return
    setBusy(true)
    setError(null)
    try {
      const res = await fetch(RASTER_COMPOSITE_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ red, green, blue, title: title.trim() || undefined }),
      })
      const body = await res.json().catch(() => null)
      if (!res.ok) throw new Error(body?.detail ?? `Komposit fehlgeschlagen: HTTP ${res.status}`)
      setOpened(false)
      reset()
      await load()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Popover opened={opened} onChange={setOpened} position="bottom-end" withArrow shadow="md">
      <Popover.Target>
        <Tooltip label="RGB-Komposit erstellen" withArrow>
          <ActionIcon
            variant="subtle"
            color="gray"
            size="sm"
            aria-label="RGB-Komposit erstellen"
            onClick={(e) => { e.stopPropagation(); setOpened((o) => !o) }}
          >
            <IconColorSwatch size={14} />
          </ActionIcon>
        </Tooltip>
      </Popover.Target>
      <Popover.Dropdown onClick={(e) => e.stopPropagation()}>
        <Stack gap={6} miw={230}>
          <Group justify="space-between" wrap="nowrap" gap={4}>
            <Text size="xs" fw={600}>RGB-Komposit erstellen</Text>
            <ActionIcon variant="subtle" color="gray" size="sm" aria-label="Schliessen" onClick={() => setOpened(false)}>
              <IconX size={14} />
            </ActionIcon>
          </Group>
          {bandOptions.length < 1 ? (
            <Text size="xs" c="dimmed">Keine einbändigen Raster-Layer vorhanden.</Text>
          ) : (
            <>
              <TextInput
                size="xs"
                label="Titel (optional)"
                value={title}
                onChange={(e) => setTitle(e.currentTarget.value)}
              />
              <Select size="xs" label="Rot" data={bandOptions} value={red} onChange={setRed} comboboxProps={{ withinPortal: false }} />
              <Select size="xs" label="Grün" data={bandOptions} value={green} onChange={setGreen} comboboxProps={{ withinPortal: false }} />
              <Select size="xs" label="Blau" data={bandOptions} value={blue} onChange={setBlue} comboboxProps={{ withinPortal: false }} />
              {error && <Text size="xs" c="red">{error}</Text>}
              <Button size="xs" loading={busy} disabled={!red || !green || !blue} onClick={submit}>
                Erstellen
              </Button>
            </>
          )}
        </Stack>
      </Popover.Dropdown>
    </Popover>
  )
}

export default function LayerPanel() {
  const layers = useApp((s) => s.layers)
  const layerConfigs = useApp((s) => s.layerConfigs)
  const loading = useApp((s) => s.loading)
  const error = useApp((s) => s.error)
  const layersServiceDown = useApp((s) => s.layersServiceDown)
  const layersServiceError = useApp((s) => s.layersServiceError)
  const reorder = useApp((s) => s.reorder)
  const [opened, { toggle: toggleOpen }] = useDisclosure(true)
  const panelOpen = usePanels((s) => s.open.layerPanel)
  const hidePanel = usePanels((s) => s.hide)

  const osmVisible = useApp((s) => s.osmVisible)
  const setOsm = useApp((s) => s.setOsm)
  const terrainOn = useApp((s) => s.terrainOn)
  const setTerrain = useApp((s) => s.setTerrain)
  const terrainAvailable = useApp((s) => s.terrainAvailable)
  const tilesOn = useApp((s) => s.tilesOn)
  const setTiles = useApp((s) => s.setTiles)
  const tilesAvailable = useApp((s) => s.tilesAvailable)
  const lighting = useApp((s) => s.lighting)
  const setLighting = useApp((s) => s.setLighting)

  const isAdmin = useAuth((s) => s.user?.role === 'admin')
  const scheme = useComputedColorScheme('dark')
  const { setColorScheme } = useMantineColorScheme()

  const openLayerTab = useSelection((s) => s.openLayerTab)
  const openUpload = useUpload((s) => s.open)
  const [userAdminOpen, setUserAdminOpen] = useState(false)
  const [search, setSearch] = useState('')

  const filteredLayers = search.trim()
    ? layers.filter((l) =>
        `${layerConfigs[l.name]?.title || l.title} ${l.name}`.toLowerCase().includes(search.trim().toLowerCase()),
      )
    : layers

  // Every layer sharing a `batch` collapses into one BatchGroupRow item,
  // positioned at that batch's first occurrence; everything else (including
  // a lone GeoTIFF or a /raster-composite result — both batch: null) stays
  // a flat item exactly as today.
  const treeItems = useMemo(() => {
    const items: TreeItem[] = []
    const batchIndex = new Map<string, number>()
    for (const l of filteredLayers) {
      if (l.batch) {
        let idx = batchIndex.get(l.batch)
        if (idx === undefined) {
          idx = items.length
          batchIndex.set(l.batch, idx)
          items.push({ kind: 'batch', batch: l.batch, title: l.batchTitle || l.batch, layers: [] })
        }
        const item = items[idx]
        if (item.kind === 'batch') item.layers.push(l)
      } else {
        items.push({ kind: 'single', layer: l })
      }
    }
    return items
  }, [filteredLayers])

  // A batch's bands aren't individually draggable (see BatchGroupRow's
  // doc comment) — only ordinary top-level rows participate in reordering.
  const sortableIds = treeItems.flatMap((i) => (i.kind === 'single' ? [i.layer.name] : []))

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 3 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  )

  function onDragEnd(e: DragEndEvent) {
    const { active, over } = e
    if (!over || active.id === over.id) return
    const from = layers.findIndex((l) => l.name === active.id)
    const to = layers.findIndex((l) => l.name === over.id)
    if (from >= 0 && to >= 0) reorder(from, to)
  }

  return (
    <Box
      style={{
        width: panelOpen ? 320 : 0,
        flex: panelOpen ? '0 0 320px' : '0 0 0px',
        height: '100%',
        overflow: 'hidden',
        opacity: panelOpen ? 1 : 0,
        transition: 'width 200ms ease, flex-basis 200ms ease, opacity 150ms ease',
      }}
    >
    <Paper
      radius={0}
      style={{
        width: 320,
        flex: '0 0 320px',
        height: '100%',
        display: 'flex',
        flexDirection: 'column',
        backgroundColor: panelBg(scheme, 0.96),
        borderLeft: `1px solid ${panelBorder(scheme)}`,
      }}
    >
      {/* Same accent strip as MapTools' tools panel and the HUD stack's drag
          handle (colorScheme.ts's accentEdge) — ties this docked panel into
          the same small "splash of color" motif instead of being the one
          box without it. */}
      <Box style={{ height: 2, flexShrink: 0, background: accentEdge(scheme) }} />
      <Group
        justify="space-between"
        px="sm"
        py={8}
        onClick={toggleOpen}
        style={{ cursor: 'pointer', borderBottom: `1px solid ${panelBorder(scheme)}`, flexShrink: 0 }}
      >
        <Group gap={6}>
          {opened ? <IconChevronDown size={14} /> : <IconChevronRight size={14} />}
          <Text fw={600} size="sm">Layer</Text>
        </Group>
        <Group gap={4}>
          {!loading && <Badge size="xs" variant="light" color="yellow">{layers.length}</Badge>}
          <Tooltip label="Layer hochladen" withArrow>
            <ActionIcon
              variant="subtle"
              color="gray"
              size="sm"
              aria-label="Layer hochladen"
              onClick={(e) => { e.stopPropagation(); openUpload() }}
            >
              <IconUpload size={14} />
            </ActionIcon>
          </Tooltip>
          <RasterCompositeButton />
          {isAdmin && (
            <Tooltip label="Benutzer verwalten" withArrow>
              <ActionIcon
                variant="subtle"
                color="gray"
                size="sm"
                aria-label="Benutzer verwalten"
                onClick={(e) => { e.stopPropagation(); setUserAdminOpen(true) }}
              >
                <IconUsers size={14} />
              </ActionIcon>
            </Tooltip>
          )}
          <Tooltip label={scheme === 'dark' ? 'Helles Design' : 'Dunkles Design'} withArrow>
            <ActionIcon
              variant="subtle"
              color="gray"
              size="sm"
              aria-label="Design wechseln"
              onClick={(e) => { e.stopPropagation(); setColorScheme(scheme === 'dark' ? 'light' : 'dark') }}
            >
              {scheme === 'dark' ? <IconSun size={14} /> : <IconMoonStars size={14} />}
            </ActionIcon>
          </Tooltip>
          <Tooltip label="Layerliste ausblenden" withArrow>
            <ActionIcon
              variant="subtle"
              color="gray"
              size="sm"
              aria-label="Layerliste ausblenden"
              onClick={(e) => { e.stopPropagation(); hidePanel('layerPanel') }}
            >
              <IconX size={14} />
            </ActionIcon>
          </Tooltip>
        </Group>
      </Group>

      <UploadLayer />
      {isAdmin && <UserAdmin opened={userAdminOpen} onClose={() => setUserAdminOpen(false)} />}

      <Collapse in={opened} style={{ flex: 1, minHeight: 0, display: 'flex' }}>
        <ScrollArea style={{ flex: 1 }}>
          <Stack gap="xs" p="xs">
            <Box>
              <Text size="10px" fw={700} c={scheme === 'dark' ? 'teal.6' : 'teal.8'} tt="uppercase" mb={4}>Daten</Text>

              {loading && (
                <Group gap={8}><Loader size="xs" /><Text size="xs" c="dimmed">lade…</Text></Group>
              )}

              {error && (
                <Alert color="red" variant="light" p="xs">
                  <Text size="xs">{error}</Text>
                </Alert>
              )}

              {/* Said out loud rather than expressed as missing buttons.
                  Filter and classification go through upload-api's
                  /distinct-values, /column-stats and /layer-config, so there is
                  no substitute for it being up. The table and delete survive
                  because both now work off GetCapabilities alone. */}
              {!loading && layersServiceDown && (
                <Alert color="yellow" variant="light" p="xs">
                  <Text size="xs">
                    Upload-Dienst nicht verfügbar — Hochladen, Registrieren, Filter und
                    Klassifizierung funktionieren derzeit nicht. Sachdatentabelle und
                    Löschen funktionieren weiterhin.
                  </Text>
                  {layersServiceError && (
                    <Text size="xs" c="dimmed" mt={4} style={{ wordBreak: 'break-word' }}>
                      {layersServiceError}
                    </Text>
                  )}
                </Alert>
              )}

              {!loading && !error && (
                <TextInput
                  size="xs"
                  placeholder="Layer suchen…"
                  leftSection={<IconSearch size={13} />}
                  rightSection={search ? (
                    <ActionIcon size="xs" variant="subtle" color="gray" onClick={() => setSearch('')}>
                      <IconX size={12} />
                    </ActionIcon>
                  ) : null}
                  value={search}
                  onChange={(e) => setSearch(e.currentTarget.value)}
                  mb={6}
                />
              )}

              {!loading && !error && filteredLayers.length === 0 && (
                <Text size="xs" c="dimmed" ta="center" mt={4}>
                  {layers.length === 0
                    ? 'Keine Layer veröffentlicht'
                    : 'Keine Treffer'}
                </Text>
              )}

              {!loading && !error && filteredLayers.length > 0 && (
                <DndContext
                  sensors={sensors}
                  collisionDetection={closestCenter}
                  onDragEnd={onDragEnd}
                  modifiers={[restrictToVerticalAxis]}
                >
                  <SortableContext items={sortableIds} strategy={verticalListSortingStrategy}>
                    {treeItems.map((item) =>
                      item.kind === 'batch' ? (
                        <BatchGroupRow
                          key={item.batch}
                          title={item.title}
                          layers={item.layers}
                          onOpenTable={(layer, collection) => openLayerTab({ name: layer.name, collection })}
                        />
                      ) : (
                        <LayerRow
                          key={item.layer.name}
                          layer={item.layer}
                          onOpenTable={(layer, collection) => openLayerTab({ name: layer.name, collection })}
                        />
                      ),
                    )}
                  </SortableContext>
                </DndContext>
              )}

              <Text size="10px" c="dimmed" mt={6}>
                Oben = wird zuerst gezeichnet. Ziehen oder Pfeile benutzen.
              </Text>
            </Box>

            <Box>
              <Text size="10px" fw={700} c={scheme === 'dark' ? 'teal.6' : 'teal.8'} tt="uppercase" mb={4}>3D</Text>
              <Stack gap={6}>
                <Switch
                  size="xs"
                  label="Gelände (quantized-mesh)"
                  checked={terrainOn}
                  disabled={terrainAvailable === false}
                  onChange={(e) => setTerrain(e.currentTarget.checked)}
                />
                <Switch
                  size="xs"
                  label="3D-Gebäude"
                  checked={tilesOn}
                  disabled={tilesAvailable === false}
                  onChange={(e) => setTiles(e.currentTarget.checked)}
                />
                <Switch
                  size="xs"
                  label="Beleuchtung"
                  checked={lighting}
                  onChange={(e) => setLighting(e.currentTarget.checked)}
                />
              </Stack>
              {terrainAvailable === false && (
                <Text size="10px" c="dimmed" mt={4}>
                  Keine Kacheln unter /terrain — ctb-Profil noch nicht gelaufen.
                </Text>
              )}
            </Box>

            <Box>
              <Text size="10px" fw={700} c={scheme === 'dark' ? 'teal.6' : 'teal.8'} tt="uppercase" mb={4}>Hintergrund</Text>
              <Switch
                size="xs"
                label="OpenStreetMap (extern)"
                checked={osmVisible}
                onChange={(e) => setOsm(e.currentTarget.checked)}
              />
            </Box>
          </Stack>
        </ScrollArea>
      </Collapse>
    </Paper>
    </Box>
  )
}
