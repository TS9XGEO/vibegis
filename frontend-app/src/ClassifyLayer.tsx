/**
 * Lets the user define how any layer is styled — saved server-side via
 * upload-api's /layer-config (see wms.ts's saveClassification), so it's
 * shared by everyone using the app rather than a personal browser setting.
 * Once saved it becomes the layer's legend (see legend.ts's resolveLegend),
 * taking over from any hand-authored LEGENDS entry.
 *
 * Three top-level styles:
 *   - single symbol: one color for the whole layer, no column
 *   - categorized: classes with freely-chosen colors — either matching a
 *     column's distinct values, or (numeric columns only) manually-defined
 *     numeric ranges
 *   - graduated: numeric column split into ranges, colored as shades of one
 *     hue (a real gradient) so the ramp itself communicates magnitude
 *
 * Categorized-by-range and graduated both produce the same underlying shape
 * server-side (mode "graduated": column + breaks) — the only difference is
 * which colors the editor seeds new breaks with (freely-chosen palette vs a
 * generated monochrome ramp); once created, every break's color is editable
 * either way.
 */
import { useEffect, useState } from 'react'
import {
  ActionIcon, Alert, Button, ColorPicker, Group, Modal, NumberInput, Popover,
  ScrollArea, SegmentedControl, Select, Stack, Text, TextInput, Tooltip,
} from '@mantine/core'
import { IconAlertCircle, IconTags, IconTrash } from '@tabler/icons-react'

import { fetchColumns, fetchColumnStats, fetchDistinctValues, type Column } from './columns'
import {
  hexToRgb, isValidHex, rgbToHex, type ClassDef, type Classification,
  type GraduatedBreak, type Rgb,
} from './legend'
import { useApp } from './wms'

type Mode = 'single' | 'categorized' | 'graduated'
type CategorizedStyle = 'values' | 'ranges'

// A small, visually distinct qualitative palette — used to seed categorized
// classes (by value or by manually-defined range) with freely-chosen colors,
// so the user only has to tweak the ones they care about.
const PALETTE = [
  '#e07a5f', '#3d9970', '#5b8dd6', '#e0b03d', '#a06cd5',
  '#4fb0c6', '#d65f8a', '#7a9e3d', '#c67d4f', '#6a6ed6',
]

// One Rule per class gets sent as a GetMap SLD_BODY, and MapServer's own
// Apache/mod_fcgid has a hard, non-configurable ~32KB limit on that single
// query parameter. Binary-searched empirically against a real point layer
// with short category names: 67 classes (31.6KB) worked, 68 (32.1KB) failed
// outright — ~465 bytes/class there. Polygon/line symbolizers and longer
// value strings cost more per class, so this stays well under that measured
// cliff rather than sitting right on it.
const SAFE_CLASS_LIMIT = 50

const DEFAULT_RAMP_COLOR = '#3d7fc4'

function lerpColor(a: Rgb, b: Rgb, t: number): Rgb {
  return [0, 1, 2].map((i) => Math.round(a[i] + (b[i] - a[i]) * t)) as Rgb
}

function round2(n: number): number {
  return Math.round(n * 100) / 100
}

/** Grades of one hue — a light tint of `base` through to a dark shade of it, not a second color. */
function monochromeRamp(base: Rgb, n: number): Rgb[] {
  const light = lerpColor(base, [255, 255, 255], 0.75)
  const dark = lerpColor(base, [0, 0, 0], 0.55)
  return Array.from({ length: n }, (_, i) => lerpColor(light, dark, n === 1 ? 0 : i / (n - 1)))
}

function equalIntervalBounds(min: number, max: number, n: number): [number, number][] {
  const step = (max - min) / n
  return Array.from({ length: n }, (_, i) => [
    round2(min + step * i),
    i === n - 1 ? round2(max) : round2(min + step * (i + 1)),
  ])
}

function Swatch({ color, onChange }: { color: string; onChange: (hex: string) => void }) {
  return (
    <Popover position="right-start" withArrow shadow="md">
      <Popover.Target>
        <ActionIcon variant="subtle" size="sm" aria-label="Farbe aendern">
          <div style={{ width: 16, height: 16, borderRadius: 4, background: color, border: '1px solid rgba(255,255,255,.35)' }} />
        </ActionIcon>
      </Popover.Target>
      <Popover.Dropdown>
        <ColorPicker format="hex" value={color} onChange={onChange} />
      </Popover.Dropdown>
    </Popover>
  )
}

function BreaksEditor({
  breaks, onChange,
}: {
  breaks: GraduatedBreak[]
  onChange: (breaks: GraduatedBreak[]) => void
}) {
  return (
    <ScrollArea.Autosize mah={280}>
      <Stack gap={4}>
        {breaks.map((b, i) => (
          <Group key={i} gap={6} wrap="nowrap" align="flex-end">
            <Swatch
              color={isValidHex(b.color) ? b.color : '#888888'}
              onChange={(hex) => onChange(breaks.map((x, j) => (j === i ? { ...x, color: hex } : x)))}
            />
            <NumberInput
              size="xs"
              value={b.min}
              onChange={(v) => onChange(breaks.map((x, j) => (j === i ? { ...x, min: Number(v) } : x)))}
              style={{ flex: 1, minWidth: 0 }}
            />
            <Text size="xs" c="dimmed">–</Text>
            <NumberInput
              size="xs"
              value={b.max}
              onChange={(v) => onChange(breaks.map((x, j) => (j === i ? { ...x, max: Number(v) } : x)))}
              style={{ flex: 1, minWidth: 0 }}
            />
          </Group>
        ))}
      </Stack>
    </ScrollArea.Autosize>
  )
}

export default function ClassifyLayer({
  opened, onClose, layerName, collection,
}: {
  opened: boolean
  onClose: () => void
  layerName: string
  collection: string
}) {
  const [schema, table] = collection.split(/\.(.+)/)
  const existing = useApp((s) => s.layerConfigs[layerName]?.classification)
  const cachedColumns = useApp((s) => s.layerColumns[layerName])
  const saveClassification = useApp((s) => s.saveClassification)
  const clearClassification = useApp((s) => s.clearClassification)

  const [columns, setColumns] = useState<Column[]>([])
  const [column, setColumn] = useState<string | null>(
    existing?.mode === 'categorized' || existing?.mode === 'graduated' ? existing.column : null,
  )
  const [mode, setMode] = useState<Mode>(existing?.mode ?? 'categorized')
  const [categorizedStyle, setCategorizedStyle] = useState<CategorizedStyle>('values')

  const [singleColor, setSingleColor] = useState(existing?.mode === 'single' ? existing.color : PALETTE[0])
  const [classes, setClasses] = useState<ClassDef[]>(existing?.mode === 'categorized' ? existing.classes : [])
  const [breaks, setBreaks] = useState<GraduatedBreak[]>(existing?.mode === 'graduated' ? existing.breaks : [])
  const [numClasses, setNumClasses] = useState(existing?.mode === 'graduated' ? existing.breaks.length : 5)
  const [rampColor, setRampColor] = useState(DEFAULT_RAMP_COLOR)
  const [stats, setStats] = useState<{ min: number; max: number } | null>(null)

  const [truncated, setTruncated] = useState(false)
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const numeric = columns.find((c) => c.key === column)?.numeric ?? false
  const usesRanges = mode === 'graduated' || (mode === 'categorized' && categorizedStyle === 'ranges')

  useEffect(() => {
    if (!opened) return
    setError(null)
    if (cachedColumns) { setColumns(cachedColumns); return }
    fetchColumns(collection).then(setColumns).catch((e) => setError(e instanceof Error ? e.message : String(e)))
  }, [opened, collection, cachedColumns])

  // A column that turns out not to be numeric can't stay graduated/ranges.
  useEffect(() => {
    if (!numeric) {
      if (mode === 'graduated') setMode('categorized')
      setCategorizedStyle('values')
    }
  }, [numeric, mode])

  // Categorized-by-value: seed a palette color for any value not already
  // classified, so switching columns doesn't start from a blank list.
  useEffect(() => {
    if (!opened || !column || mode !== 'categorized' || categorizedStyle !== 'values') return
    setLoading(true)
    setError(null)
    fetchDistinctValues(schema, table, column)
      .then(({ values, truncated: t }) => {
        setTruncated(t)
        setClasses((prev) => {
          const byValue = new Map(prev.map((c) => [c.value, c]))
          return values.map((v, i) => byValue.get(v) ?? { value: v, label: v, color: PALETTE[i % PALETTE.length] })
        })
      })
      .catch((e) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setLoading(false))
  }, [opened, column, schema, table, mode, categorizedStyle])

  // Ranges (graduated, or categorized-by-range): fetch min/max once per
  // column and generate default breaks — unless the saved classification
  // already has breaks for this exact column, which are kept as-is.
  useEffect(() => {
    if (!opened || !column || !usesRanges) return
    if (existing?.mode === 'graduated' && existing.column === column && breaks.length > 0) {
      setStats(null) // unknown until the user changes the class count
      return
    }
    setLoading(true)
    setError(null)
    fetchColumnStats(schema, table, column)
      .then(({ min, max }) => {
        setStats({ min, max })
        const bounds = equalIntervalBounds(min, max, numClasses)
        const colors = mode === 'graduated'
          ? monochromeRamp(hexToRgb(rampColor), numClasses).map(rgbToHex)
          : Array.from({ length: numClasses }, (_, i) => PALETTE[i % PALETTE.length])
        setBreaks(bounds.map(([lo, hi], i) => ({ min: lo, max: hi, color: colors[i] })))
      })
      .catch((e) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setLoading(false))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [opened, column, schema, table, usesRanges])

  function regenerateWithCount(n: number) {
    setNumClasses(n)
    if (!stats) return
    const bounds = equalIntervalBounds(stats.min, stats.max, n)
    const colors = mode === 'graduated'
      ? monochromeRamp(hexToRgb(rampColor), n).map(rgbToHex)
      : Array.from({ length: n }, (_, i) => PALETTE[i % PALETTE.length])
    setBreaks(bounds.map(([lo, hi], i) => ({ min: lo, max: hi, color: colors[i] })))
  }

  function recolorRamp(hex: string) {
    setRampColor(hex)
    if (breaks.length === 0) return
    const colors = monochromeRamp(hexToRgb(hex), breaks.length).map(rgbToHex)
    setBreaks((bs) => bs.map((b, i) => ({ ...b, color: colors[i] })))
  }

  function buildClassification(): Classification | null {
    if (mode === 'single') return { mode: 'single', color: singleColor }
    if (!column) return null
    if (mode === 'categorized' && categorizedStyle === 'values') {
      return classes.length ? { mode: 'categorized', column, classes } : null
    }
    return breaks.length ? { mode: 'graduated', column, breaks } : null
  }

  const draft = buildClassification()

  async function save() {
    if (!draft) return
    setSaving(true)
    setError(null)
    try {
      await saveClassification(layerName, draft)
      onClose()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setSaving(false)
    }
  }

  async function remove() {
    setSaving(true)
    try {
      await clearClassification(layerName)
      onClose()
    } finally {
      setSaving(false)
    }
  }

  const modeOptions = [
    { label: 'Einzelsymbol', value: 'single' },
    { label: 'Kategorisiert', value: 'categorized' },
    ...(numeric ? [{ label: 'Graduiert', value: 'graduated' }] : []),
  ]

  // closeOnClickOutside=false: the color swatches below open their own
  // Popover (for the ColorPicker), which portals to document.body by default
  // — without this, clicking to pick a color would register as a click
  // outside this Modal and dismiss the whole editor mid-edit.
  return (
    <Modal opened={opened} onClose={onClose} title="Klassifizierung" centered size="sm" closeOnClickOutside={false}>
      <Stack gap="sm">
        <Text size="xs" c="dimmed">
          Legt fest, wie dieser Layer dargestellt wird — für alle gespeichert, ersetzt
          die Standard-Legende.
        </Text>

        {mode !== 'single' && (
          <Select
            label="Spalte"
            placeholder="Spalte auswählen"
            data={columns.map((c) => c.key)}
            value={column}
            onChange={setColumn}
            searchable
            comboboxProps={{ withinPortal: false }}
          />
        )}

        <SegmentedControl
          fullWidth
          size="xs"
          value={mode}
          onChange={(v) => setMode(v as Mode)}
          data={modeOptions}
        />

        {mode === 'categorized' && numeric && (
          <SegmentedControl
            fullWidth
            size="xs"
            value={categorizedStyle}
            onChange={(v) => setCategorizedStyle(v as CategorizedStyle)}
            data={[
              { label: 'Eindeutige Werte', value: 'values' },
              { label: 'Nummerische Bereiche', value: 'ranges' },
            ]}
          />
        )}

        {error && (
          <Alert color="red" variant="light" icon={<IconAlertCircle size={16} />}>{error}</Alert>
        )}

        {loading && <Text size="xs" c="dimmed">lade…</Text>}

        {mode === 'single' && (
          <Group gap={6}>
            <Swatch color={isValidHex(singleColor) ? singleColor : '#888888'} onChange={setSingleColor} />
            <Text size="xs" c="dimmed">Farbe für alle Objekte</Text>
          </Group>
        )}

        {mode === 'categorized' && categorizedStyle === 'values' && (
          <>
            {truncated && (
              <Text size="xs" c="dimmed">Nur die ersten {classes.length} Werte werden angezeigt.</Text>
            )}
            {classes.length > SAFE_CLASS_LIMIT && (
              <Alert color="yellow" variant="light" icon={<IconAlertCircle size={16} />}>
                {classes.length} Klassen — MapServer kann bei so vielen Klassen die Anfrage ablehnen.
                Einen Filter auf diese Spalte zu setzen reduziert das Risiko.
              </Alert>
            )}
            {classes.length > 0 && (
              <ScrollArea.Autosize mah={280}>
                <Stack gap={4}>
                  {classes.map((c, i) => (
                    <Group key={c.value} gap={6} wrap="nowrap">
                      <Swatch
                        color={isValidHex(c.color) ? c.color : '#888888'}
                        onChange={(hex) => setClasses((cs) => cs.map((x, j) => (j === i ? { ...x, color: hex } : x)))}
                      />
                      <Tooltip label={c.value} openDelay={400} withArrow>
                        <TextInput
                          size="xs"
                          value={c.label ?? c.value}
                          onChange={(e) => setClasses((cs) => cs.map((x, j) => (j === i ? { ...x, label: e.currentTarget.value } : x)))}
                          style={{ flex: 1, minWidth: 0 }}
                        />
                      </Tooltip>
                    </Group>
                  ))}
                </Stack>
              </ScrollArea.Autosize>
            )}
          </>
        )}

        {usesRanges && (
          <>
            <Group grow>
              <NumberInput
                size="xs"
                label="Anzahl Klassen"
                min={2}
                max={12}
                value={numClasses}
                onChange={(v) => { if (typeof v === 'number') regenerateWithCount(v) }}
              />
              {mode === 'graduated' && (
                <Stack gap={2}>
                  <Text size="xs" c="dimmed">Farbverlauf</Text>
                  <Swatch color={rampColor} onChange={recolorRamp} />
                </Stack>
              )}
            </Group>
            {breaks.length > 0 && <BreaksEditor breaks={breaks} onChange={setBreaks} />}
          </>
        )}

        <Group justify="space-between" mt={4}>
          {existing ? (
            <Button size="xs" color="red" variant="subtle" leftSection={<IconTrash size={14} />} loading={saving} onClick={remove}>
              Entfernen
            </Button>
          ) : <div />}
          <Group gap={6}>
            <Button size="xs" variant="subtle" color="gray" onClick={onClose}>Schliessen</Button>
            <Button size="xs" leftSection={<IconTags size={14} />} loading={saving} disabled={!draft} onClick={save}>
              Speichern
            </Button>
          </Group>
        </Group>
      </Stack>
    </Modal>
  )
}
