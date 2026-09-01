/**
 * Text/SVG legend, replacing MapServer's GetLegendGraphic image: each class
 * renders as a shape matching its geometry (box/line/point) plus its name,
 * and clicking the shape opens a color picker that recolors the class both
 * here and on the map (see Scene.tsx / legend.ts for the SLD_BODY wiring).
 *
 * Beyond the attribute filter's own pruning (reachableClasses), a class also
 * drops out of the list when it provably can't be drawing anything right
 * now: the whole layer is toggled off, its value never occurs anywhere in
 * the table (fetchDistinctValues — exact, no cap), or it just has no
 * feature within the current map extent (fetchFeaturesInBbox — capped the
 * same way MapTools' own viewport queries are, so a very dense view can
 * rarely under-report a rare class rather than block the legend on a huge
 * query). Both checks only run while the legend is actually open (`active`)
 * — this component stays mounted (inside a Collapse) even when collapsed,
 * so gating on `active` is what stops every layer's legend from polling the
 * camera forever in the background.
 */
import { useEffect, useState } from 'react'
import { ActionIcon, Group, Popover, ColorPicker, Stack, Text, Tooltip } from '@mantine/core'
import { IconRefresh, IconX } from '@tabler/icons-react'

import { fetchDistinctValues } from './columns'
import { fetchFeaturesInBbox } from './features'
import { classSatisfiedBy, reachableClasses, resolveLegend, rgbToHex, type LegendClass, type GeometryKind } from './legend'
import { visibleGroundBbox } from './spatial'
import { collectionFor, useApp } from './wms'

function Swatch({ geometry, color }: { geometry: GeometryKind; color: string }) {
  const size = 16
  if (geometry === 'line') {
    return (
      <svg width={size} height={size} viewBox="0 0 16 16">
        <line x1={1} y1={13} x2={15} y2={3} stroke={color} strokeWidth={2.5} strokeLinecap="round" />
      </svg>
    )
  }
  if (geometry === 'point') {
    return (
      <svg width={size} height={size} viewBox="0 0 16 16">
        <circle cx={8} cy={8} r={6} fill={color} stroke="rgba(255,255,255,.6)" strokeWidth={1} />
      </svg>
    )
  }
  return (
    <svg width={size} height={size} viewBox="0 0 16 16">
      <rect x={1.5} y={1.5} width={13} height={13} rx={2} fill={color} stroke="rgba(255,255,255,.35)" strokeWidth={1} />
    </svg>
  )
}

function ClassRow({ layerName, geometry, cls }: { layerName: string; geometry: GeometryKind; cls: LegendClass }) {
  const override = useApp((s) => s.styleOverrides[layerName]?.[cls.name])
  const setClassColor = useApp((s) => s.setClassColor)
  const resetClassColor = useApp((s) => s.resetClassColor)
  const color = override ?? rgbToHex(cls.color)
  const [opened, setOpened] = useState(false)

  return (
    <Group gap={6} wrap="nowrap">
      <Popover opened={opened} onChange={setOpened} position="right-start" withArrow shadow="md">
        <Popover.Target>
          <ActionIcon
            variant="subtle"
            size="sm"
            aria-label={`Farbe fuer ${cls.name} aendern`}
            onClick={() => setOpened((o) => !o)}
          >
            <Swatch geometry={geometry} color={color} />
          </ActionIcon>
        </Popover.Target>
        <Popover.Dropdown>
          <Stack gap={6}>
            <Group justify="flex-end">
              <ActionIcon variant="subtle" color="gray" size="sm" aria-label="Schliessen" onClick={() => setOpened(false)}>
                <IconX size={14} />
              </ActionIcon>
            </Group>
            <ColorPicker format="hex" value={color} onChange={(hex) => setClassColor(layerName, cls.name, hex)} />
            {override && (
              <Tooltip label="Auf Standardfarbe zuruecksetzen" withArrow>
                <ActionIcon
                  variant="subtle"
                  color="gray"
                  size="sm"
                  onClick={() => resetClassColor(layerName, cls.name)}
                >
                  <IconRefresh size={14} />
                </ActionIcon>
              </Tooltip>
            )}
          </Stack>
        </Popover.Dropdown>
      </Popover>
      <Text size="xs" c="dimmed" style={{ flex: 1, minWidth: 0 }} truncate>
        {cls.name}
      </Text>
    </Group>
  )
}

export default function LegendSymbols({ layerName, active }: { layerName: string; active: boolean }) {
  const layer = useApp((s) => s.layers.find((l) => l.name === layerName))
  const classification = useApp((s) => s.layerConfigs[layerName]?.classification)
  const geometryType = useApp((s) => s.dynamicGeometry[layerName])
  const layerFilter = useApp((s) => s.attributeFilters[layerName])
  const dynamicCollections = useApp((s) => s.dynamicCollections)
  const camera = useApp((s) => s.camera)
  const scene = useApp((s) => s.scene)
  const legend = resolveLegend(layerName, classification, geometryType)
  const collection = collectionFor(layerName, dynamicCollections)
  const classItem = legend?.classItem ?? null

  const [tableValues, setTableValues] = useState<Set<string> | null>(null)
  const [viewValues, setViewValues] = useState<Set<string> | null>(null)
  const [viewTruncated, setViewTruncated] = useState(false)

  // Exact, whole-table check — a class whose value never occurs anywhere in
  // the data is dead regardless of the current view, and this is cheap and
  // uncapped (one indexed SELECT DISTINCT) unlike the viewport check below.
  useEffect(() => {
    if (!active || !collection || classItem === null) return
    let cancelled = false
    const [schema, table] = collection.split(/\.(.+)/)
    fetchDistinctValues(schema, table, classItem)
      .then((r) => { if (!cancelled) setTableValues(new Set(r.values)) })
      .catch(() => { /* fail open: a network hiccup shouldn't hide real classes */ })
    return () => { cancelled = true }
  }, [active, collection, classItem])

  // Live, viewport-scoped check — same camera.changed/percentageChanged
  // idiom AttributeTable.tsx's "Kartenansicht" mode already uses, but the
  // bbox itself comes from spatial.ts's visibleGroundBbox() rather than
  // Camera.computeViewRectangle(): at any real camera tilt (this is a 3D
  // globe, not a flat map) that method has to account for ground near the
  // horizon, which can be far from the camera, so it can return a rectangle
  // many times larger than what's actually on screen — the legend ended up
  // listing classes nowhere near the current view.
  useEffect(() => {
    if (!active || !collection || classItem === null || !camera || !scene) return
    let cancelled = false
    const update = () => {
      const bbox = visibleGroundBbox(camera, scene)
      if (!bbox) return
      fetchFeaturesInBbox(collection, bbox).then((r) => {
        if (cancelled) return
        const values = new Set<string>()
        for (const f of r.features) {
          const v = f.properties[classItem]
          if (v !== null && v !== undefined) values.add(String(v))
        }
        setViewValues(values)
        setViewTruncated(r.truncated)
      }).catch(() => { /* keep the last known set rather than blank the legend on a hiccup */ })
    }
    update()
    camera.percentageChanged = 0.1
    const remove = camera.changed.addEventListener(update)
    return () => { cancelled = true; remove() }
  }, [active, collection, classItem, camera, scene])

  if (!layer?.visible) {
    return (
      <Text size="xs" c="dimmed" fs="italic">
        Layer ausgeblendet
      </Text>
    )
  }

  if (!legend) {
    return (
      <Text size="xs" c="dimmed" fs="italic">
        Keine Legende verfuegbar
      </Text>
    )
  }

  // Only list classes the active attribute filter can still draw (same
  // pruning buildSld() applies to the map itself), that have at least one
  // matching feature anywhere in the data, and that have one within the
  // current map extent.
  const { classes: filterReachable } = reachableClasses(legend, layerFilter?.conditions ?? [], layerFilter?.logic ?? 'and')
  const classes = filterReachable.filter((cls) => {
    if (tableValues && !classSatisfiedBy(cls.match, tableValues)) return false
    if (viewValues && !classSatisfiedBy(cls.match, viewValues)) return false
    return true
  })

  return (
    <Stack gap={2}>
      {classes.length === 0 ? (
        <Text size="xs" c="dimmed" fs="italic">
          Keine sichtbaren Klassen im aktuellen Kartenausschnitt
        </Text>
      ) : (
        classes.map((cls) => (
          <ClassRow key={cls.name} layerName={layerName} geometry={legend.geometry} cls={cls} />
        ))
      )}
      {viewTruncated && (
        <Text size="xs" c="dimmed">
          Zeigt nur einen Ausschnitt der Klassen – weiter einzoomen für Vollständigkeit.
        </Text>
      )}
    </Stack>
  )
}
