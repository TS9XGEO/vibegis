/**
 * Layer panel: visibility, opacity, drag-to-reorder, legend, zoom-to-extent.
 *
 * Reordering is pure state — dnd-kit hands back an index pair, the store
 * swaps the array, and the Scene re-renders in the new order. Nothing touches
 * Cesium directly.
 */
import { useState } from 'react'
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
  Slider,
  Stack,
  Switch,
  Text,
  TextInput,
  Tooltip,
} from '@mantine/core'
import { useDisclosure } from '@mantine/hooks'
import {
  IconChevronDown,
  IconChevronRight,
  IconChevronUp,
  IconCurrentLocation,
  IconGripVertical,
  IconList,
  IconSearch,
  IconTable,
  IconTags,
  IconTrash,
  IconUpload,
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
import AttributeTable from './AttributeTable'
import ClassifyLayer from './ClassifyLayer'
import LegendSymbols from './Legend'
import UploadLayer from './UploadLayer'
import type { LayerState } from './wms'
import { LAYERS_URL, collectionFor, isManaged, useApp } from './wms'

function DeleteLayerButton({ layer }: { layer: LayerState }) {
  const load = useApp((s) => s.load)
  const [opened, setOpened] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

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
          <Text size="xs" fw={600} truncate>"{layer.title}" löschen</Text>
          {error && <Text size="xs" c="red">{error}</Text>}
          <Button size="xs" color="red" loading={busy} onClick={() => doDelete(true)}>
            Layer + Datenbanktabelle löschen
          </Button>
          <Button size="xs" variant="default" loading={busy} onClick={() => doDelete(false)}>
            Nur Layer löschen (Tabelle bleibt)
          </Button>
        </Stack>
      </Popover.Dropdown>
    </Popover>
  )
}

function LayerRow({ layer, onOpenTable }: { layer: LayerState; onOpenTable: (layer: LayerState) => void }) {
  const toggle = useApp((s) => s.toggle)
  const setOpacity = useApp((s) => s.setOpacity)
  const move = useApp((s) => s.move)
  const camera = useApp((s) => s.camera)
  const [legendOpen, setLegendOpen] = useState(false)
  const [classifyOpen, setClassifyOpen] = useState(false)
  const dynamicCollections = useApp((s) => s.dynamicCollections)
  const managedLayers = useApp((s) => s.managedLayers)
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

        <Checkbox size="xs" checked={layer.visible} onChange={() => toggle(layer.name)} />

        <Tooltip label={layer.name} openDelay={500} withArrow>
          <Text size="sm" style={{ flex: 1, minWidth: 0 }} truncate>
            {layer.title}
          </Text>
        </Tooltip>

        <Tooltip label="Legende" withArrow>
          <ActionIcon
            variant="subtle"
            color={legendOpen ? 'blue' : 'gray'}
            size="sm"
            onClick={() => setLegendOpen((o) => !o)}
          >
            <IconList size={13} />
          </ActionIcon>
        </Tooltip>

        {collection && (
          <Tooltip label="Sachdaten anzeigen" withArrow>
            <ActionIcon
              variant="subtle"
              color="gray"
              size="sm"
              aria-label="Sachdaten anzeigen"
              onClick={() => onOpenTable(layer)}
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
        {collection && (
          <ClassifyLayer
            opened={classifyOpen}
            onClose={() => setClassifyOpen(false)}
            layerName={layer.name}
            collection={collection}
          />
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
          <LegendSymbols layerName={layer.name} />
        </Box>
      </Collapse>
    </Box>
  )
}

export default function LayerPanel() {
  const layers = useApp((s) => s.layers)
  const loading = useApp((s) => s.loading)
  const error = useApp((s) => s.error)
  const layersServiceDown = useApp((s) => s.layersServiceDown)
  const reorder = useApp((s) => s.reorder)
  const [opened, { toggle: toggleOpen }] = useDisclosure(true)

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

  const [tableLayer, setTableLayer] = useState<LayerState | null>(null)
  const [uploadOpen, setUploadOpen] = useState(false)
  const [search, setSearch] = useState('')

  const filteredLayers = search.trim()
    ? layers.filter((l) => `${l.title} ${l.name}`.toLowerCase().includes(search.trim().toLowerCase()))
    : layers

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
    <Paper
      radius={0}
      style={{
        width: 320,
        flex: '0 0 320px',
        height: '100%',
        display: 'flex',
        flexDirection: 'column',
        backgroundColor: 'rgba(20,22,28,0.96)',
        borderLeft: '1px solid rgba(255,255,255,.1)',
      }}
    >
      <Group
        justify="space-between"
        px="sm"
        py={8}
        onClick={toggleOpen}
        style={{ cursor: 'pointer', borderBottom: '1px solid rgba(255,255,255,.1)', flexShrink: 0 }}
      >
        <Group gap={6}>
          {opened ? <IconChevronDown size={14} /> : <IconChevronRight size={14} />}
          <Text fw={600} size="sm">Layer</Text>
        </Group>
        <Group gap={4}>
          {!loading && <Badge size="xs" variant="light">{layers.length}</Badge>}
          <Tooltip label="Layer hochladen" withArrow>
            <ActionIcon
              variant="subtle"
              color="gray"
              size="sm"
              aria-label="Layer hochladen"
              onClick={(e) => { e.stopPropagation(); setUploadOpen(true) }}
            >
              <IconUpload size={14} />
            </ActionIcon>
          </Tooltip>
        </Group>
      </Group>

      <UploadLayer opened={uploadOpen} onClose={() => setUploadOpen(false)} />

      <Collapse in={opened} style={{ flex: 1, minHeight: 0, display: 'flex' }}>
        <ScrollArea style={{ flex: 1 }}>
          <Stack gap="xs" p="xs">
            <Box>
              <Text size="10px" fw={700} c="dimmed" tt="uppercase" mb={4}>Daten</Text>

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
                    Upload-Dienst nicht erreichbar — Filter und Klassifizierung stehen
                    derzeit nicht zur Verfügung. Sachdatentabelle und Löschen
                    funktionieren weiterhin.
                  </Text>
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
                <Text size="xs" c="dimmed" ta="center" mt={4}>Keine Treffer</Text>
              )}

              {!loading && !error && filteredLayers.length > 0 && (
                <DndContext
                  sensors={sensors}
                  collisionDetection={closestCenter}
                  onDragEnd={onDragEnd}
                  modifiers={[restrictToVerticalAxis]}
                >
                  <SortableContext
                    items={filteredLayers.map((l) => l.name)}
                    strategy={verticalListSortingStrategy}
                  >
                    {filteredLayers.map((l) => (
                      <LayerRow key={l.name} layer={l} onOpenTable={setTableLayer} />
                    ))}
                  </SortableContext>
                </DndContext>
              )}

              <Text size="10px" c="dimmed" mt={6}>
                Oben = wird zuerst gezeichnet. Ziehen oder Pfeile benutzen.
              </Text>
            </Box>

            <Box>
              <Text size="10px" fw={700} c="dimmed" tt="uppercase" mb={4}>3D</Text>
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
              <Text size="10px" fw={700} c="dimmed" tt="uppercase" mb={4}>Hintergrund</Text>
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

      <AttributeTable layer={tableLayer} onClose={() => setTableLayer(null)} />
    </Paper>
  )
}
