/**
 * Text/SVG legend, replacing MapServer's GetLegendGraphic image: each class
 * renders as a shape matching its geometry (box/line/point) plus its name,
 * and clicking the shape opens a color picker that recolors the class both
 * here and on the map (see Scene.tsx / legend.ts for the SLD_BODY wiring).
 */
import { ActionIcon, Group, Popover, ColorPicker, Stack, Text, Tooltip } from '@mantine/core'
import { IconRefresh } from '@tabler/icons-react'

import { resolveLegend, rgbToHex, type LegendClass, type GeometryKind } from './legend'
import { useApp } from './wms'

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

  return (
    <Group gap={6} wrap="nowrap">
      <Popover position="right-start" withArrow shadow="md">
        <Popover.Target>
          <ActionIcon variant="subtle" size="sm" aria-label={`Farbe fuer ${cls.name} aendern`}>
            <Swatch geometry={geometry} color={color} />
          </ActionIcon>
        </Popover.Target>
        <Popover.Dropdown>
          <Stack gap={6}>
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

export default function LegendSymbols({ layerName }: { layerName: string }) {
  const classification = useApp((s) => s.layerConfigs[layerName]?.classification)
  const geometryType = useApp((s) => s.dynamicGeometry[layerName])
  const legend = resolveLegend(layerName, classification, geometryType)
  if (!legend) {
    return (
      <Text size="xs" c="dimmed" fs="italic">
        Keine Legende verfuegbar
      </Text>
    )
  }

  return (
    <Stack gap={2}>
      {legend.classes.map((cls) => (
        <ClassRow key={cls.name} layerName={layerName} geometry={legend.geometry} cls={cls} />
      ))}
    </Stack>
  )
}
