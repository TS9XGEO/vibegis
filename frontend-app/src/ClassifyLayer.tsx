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
 * either way. Both therefore also share the "Klassifizierungsmethode" picker
 * (equal interval / percentile / natural breaks / manual) that decides where
 * those ranges fall — see regenerate() below.
 */
import { useEffect, useRef, useState } from 'react'
import {
  ActionIcon, Alert, Button, ColorPicker, Group, Modal, NumberInput, Popover,
  ScrollArea, SegmentedControl, Select, Stack, Text, TextInput, Tooltip,
} from '@mantine/core'
import { IconAlertCircle, IconTags, IconTrash, IconX } from '@tabler/icons-react'
import { useTranslation } from 'react-i18next'

import {
  columnLabel, fetchColumnBreaks, fetchColumns, fetchColumnStats, fetchDistinctValues,
  type BreakMethod, type Column,
} from './columns'
import { FRESH_LAYER_WAIT_MESSAGE, isFreshLayerWait } from './freshLayerRetry'
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

/**
 * The k+1 edges /column-breaks returns, paired up into the k [min, max]
 * ranges the breaks editor works in. Rounded exactly the way
 * equalIntervalBounds() rounds its own, so a percentile or Jenks break is
 * not shown to more decimal places than an equal-interval one.
 */
function edgesToBounds(edges: number[]): [number, number][] {
  return edges.slice(0, -1).map((lo, i) => [round2(lo), round2(edges[i + 1])])
}

function Swatch({ color, onChange }: { color: string; onChange: (hex: string) => void }) {
  const { t } = useTranslation()
  const [opened, setOpened] = useState(false)
  return (
    <Popover opened={opened} onChange={setOpened} position="right-start" withArrow shadow="md">
      <Popover.Target>
        <ActionIcon variant="subtle" size="sm" aria-label={t('classifyLayer.changeColorAriaLabel')} onClick={() => setOpened((o) => !o)}>
          <div style={{ width: 16, height: 16, borderRadius: 4, background: color, border: '1px solid rgba(255,255,255,.35)' }} />
        </ActionIcon>
      </Popover.Target>
      <Popover.Dropdown>
        <Group justify="flex-end" mb={4}>
          <ActionIcon variant="subtle" color="gray" size="sm" aria-label={t('common.close')} onClick={() => setOpened(false)}>
            <IconX size={14} />
          </ActionIcon>
        </Group>
        <ColorPicker format="hex" value={color} onChange={onChange} />
      </Popover.Dropdown>
    </Popover>
  )
}

/**
 * `onChange` is a color edit, `onEditBounds` a change to one of the numbers —
 * kept apart so that typing a bound can flip the method picker to "manual"
 * (the numbers are the user's now) while recoloring a class, which says
 * nothing about where the ranges fall, leaves the method alone.
 */
function BreaksEditor({
  breaks, onChange, onEditBounds,
}: {
  breaks: GraduatedBreak[]
  onChange: (breaks: GraduatedBreak[]) => void
  onEditBounds: (breaks: GraduatedBreak[]) => void
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
              onChange={(v) => onEditBounds(breaks.map((x, j) => (j === i ? { ...x, min: Number(v) } : x)))}
              style={{ flex: 1, minWidth: 0 }}
            />
            <Text size="xs" c="dimmed">–</Text>
            <NumberInput
              size="xs"
              value={b.max}
              onChange={(v) => onEditBounds(breaks.map((x, j) => (j === i ? { ...x, max: Number(v) } : x)))}
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
  const { t } = useTranslation()
  const [schema, table] = collection.split(/\.(.+)/)
  const existing = useApp((s) => s.layerConfigs[layerName]?.classification)
  const aliases = useApp((s) => s.layerConfigs[layerName]?.columnAliases)
  const cachedColumns = useApp((s) => s.layerColumns[layerName])
  // The range a graduated/numeric-ranges classification gets seeded with
  // should reflect what's actually visible right now, not the whole
  // unfiltered table — same reasoning AttributeTable.tsx's Kartenansicht
  // and SelectionDashboard.tsx's overview already scope to a layer's active
  // filter for.
  const activeFilter = useApp((s) => s.attributeFilters[layerName])
  const saveClassification = useApp((s) => s.saveClassification)
  const clearClassification = useApp((s) => s.clearClassification)
  // Same field Scene.tsx reads for WMS rendering — the size control only
  // makes sense for point/line geometries, not polygons.
  const geomType = useApp((s) => s.dynamicGeometry[layerName])?.toLowerCase()

  const [columns, setColumns] = useState<Column[]>([])
  const [column, setColumn] = useState<string | null>(
    existing?.mode === 'categorized' || existing?.mode === 'graduated' ? existing.column : null,
  )
  const [mode, setMode] = useState<Mode>(existing?.mode ?? 'categorized')
  const [categorizedStyle, setCategorizedStyle] = useState<CategorizedStyle>('values')

  const [singleColor, setSingleColor] = useState(existing?.mode === 'single' ? existing.color : PALETTE[0])
  const [classes, setClasses] = useState<ClassDef[]>(existing?.mode === 'categorized' ? existing.classes : [])
  const [breaks, setBreaks] = useState<GraduatedBreak[]>(existing?.mode === 'graduated' ? existing.breaks : [])
  const [size, setSize] = useState<number | undefined>(existing?.size)
  const [numClasses, setNumClasses] = useState(existing?.mode === 'graduated' ? existing.breaks.length : 5)
  const [rampColor, setRampColor] = useState(DEFAULT_RAMP_COLOR)
  const [stats, setStats] = useState<{ min: number; max: number } | null>(null)
  // A saved classification from before this picker existed carries no
  // `method`, and its numbers are whatever someone left there — "manual" is
  // the honest reading of that, not a guess at how they were produced.
  const [method, setMethod] = useState<BreakMethod>(
    existing?.mode === 'graduated' ? existing.method ?? 'manual' : 'equal',
  )
  // Percentile/Jenks each cost a round trip, and the class-count spinner can
  // fire several in a row. Only the newest one is allowed to write breaks —
  // otherwise a slow 5-class answer lands after a fast 7-class one.
  const breakRequest = useRef(0)

  const [truncated, setTruncated] = useState(false)
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const numeric = columns.find((c) => c.key === column)?.numeric ?? false
  const usesRanges = mode === 'graduated' || (mode === 'categorized' && categorizedStyle === 'ranges')

  /**
   * Graduated seeds a monochrome ramp so the shades themselves read as
   * magnitude; categorized-by-range seeds the qualitative palette instead.
   * Either way every color stays individually editable afterwards.
   */
  function seedColors(n: number): string[] {
    return mode === 'graduated'
      ? monochromeRamp(hexToRgb(rampColor), n).map(rgbToHex)
      : Array.from({ length: n }, (_, i) => PALETTE[i % PALETTE.length])
  }

  function breaksFrom(bounds: [number, number][]): GraduatedBreak[] {
    const colors = seedColors(bounds.length)
    return bounds.map(([lo, hi], i) => ({ min: lo, max: hi, color: colors[i] }))
  }

  useEffect(() => {
    if (!opened) return
    setError(null)
    if (cachedColumns) { setColumns(cachedColumns); return }
    fetchColumns(collection, () => setError(FRESH_LAYER_WAIT_MESSAGE))
      .then((cols) => { setColumns(cols); setError(null) })
      .catch((e) => setError(e instanceof Error ? e.message : String(e)))
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
    // min/max is fetched even when the saved breaks are kept, so that
    // switching to "Gleiche Intervalle" or changing the class count works
    // straight away on an already-classified layer instead of silently
    // doing nothing for want of a range to divide.
    const keepSaved = existing?.mode === 'graduated' && existing.column === column && breaks.length > 0
    setLoading(true)
    setError(null)
    fetchColumnStats(schema, table, column, activeFilter)
      .then(({ min, max }) => {
        setStats({ min, max })
        if (keepSaved) return
        setBreaks(breaksFrom(equalIntervalBounds(min, max, numClasses)))
        setMethod('equal')
      })
      .catch((e) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setLoading(false))
    // numClasses/mode/rampColor deliberately excluded — this only re-seeds
    // when the column, table, or active filter changes, not on every knob
    // tweak (those go through regenerate()/recolorRamp() instead, which
    // reuse the already-fetched `stats` or ask /column-breaks directly).
  }, [opened, column, schema, table, usesRanges, activeFilter])

  /**
   * Recomputes every break for `nextMethod` at `n` classes and writes the
   * numbers straight into the (still editable) boxes.
   *
   * "Manuell" is the one method that computes nothing — except when the
   * class count changes, where there is no way to produce n boxes out of
   * thin air; equal intervals fill them in and the method stays manual,
   * since those numbers are still the user's to overwrite.
   */
  async function regenerate(nextMethod: BreakMethod, n: number, countChanged = false) {
    if (nextMethod === 'equal' || (nextMethod === 'manual' && countChanged)) {
      if (!stats) return
      setBreaks(breaksFrom(equalIntervalBounds(stats.min, stats.max, n)))
      return
    }
    if (nextMethod === 'manual' || !column) return

    const request = ++breakRequest.current
    setLoading(true)
    setError(null)
    try {
      const edges = await fetchColumnBreaks(schema, table, column, nextMethod, n, activeFilter)
      if (request !== breakRequest.current) return
      setBreaks(breaksFrom(edgesToBounds(edges)))
    } catch (e) {
      if (request === breakRequest.current) setError(e instanceof Error ? e.message : String(e))
    } finally {
      if (request === breakRequest.current) setLoading(false)
    }
  }

  function chooseMethod(next: BreakMethod) {
    setMethod(next)
    void regenerate(next, numClasses)
  }

  function chooseCount(n: number) {
    setNumClasses(n)
    void regenerate(method, n, true)
  }

  function recolorRamp(hex: string) {
    setRampColor(hex)
    if (breaks.length === 0) return
    const colors = monochromeRamp(hexToRgb(hex), breaks.length).map(rgbToHex)
    setBreaks((bs) => bs.map((b, i) => ({ ...b, color: colors[i] })))
  }

  function buildClassification(): Classification | null {
    const sizeField = size !== undefined ? { size } : {}
    if (mode === 'single') return { mode: 'single', color: singleColor, ...sizeField }
    if (!column) return null
    if (mode === 'categorized' && categorizedStyle === 'values') {
      return classes.length ? { mode: 'categorized', column, classes, ...sizeField } : null
    }
    return breaks.length ? { mode: 'graduated', column, breaks, method, ...sizeField } : null
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
    { label: t('classifyLayer.modeSingle'), value: 'single' },
    { label: t('classifyLayer.modeCategorized'), value: 'categorized' },
    ...(numeric ? [{ label: t('classifyLayer.modeGraduated'), value: 'graduated' }] : []),
  ]

  // closeOnClickOutside=false: the color swatches below open their own
  // Popover (for the ColorPicker), which portals to document.body by default
  // — without this, clicking to pick a color would register as a click
  // outside this Modal and dismiss the whole editor mid-edit.
  return (
    <Modal opened={opened} onClose={onClose} title={t('classifyLayer.title')} centered size="sm" closeOnClickOutside={false}>
      <Stack gap="sm">
        <Text size="xs" c="dimmed">
          {t('classifyLayer.intro')}
        </Text>

        {mode !== 'single' && (
          <Select
            label={t('classifyLayer.columnLabel')}
            placeholder={t('classifyLayer.columnPlaceholder')}
            data={columns.map((c) => ({ value: c.key, label: columnLabel(aliases, c.key) }))}
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

        {(geomType === 'point' || geomType === 'line') && (
          <NumberInput
            size="xs"
            label={geomType === 'point' ? t('classifyLayer.pointSizeLabel') : t('classifyLayer.lineWidthLabel')}
            placeholder={geomType === 'point' ? '10' : '2.2'}
            min={0.5}
            step={geomType === 'point' ? 1 : 0.5}
            decimalScale={1}
            value={size ?? ''}
            onChange={(v) => setSize(typeof v === 'number' ? v : undefined)}
          />
        )}

        {mode === 'categorized' && numeric && (
          <SegmentedControl
            fullWidth
            size="xs"
            value={categorizedStyle}
            onChange={(v) => setCategorizedStyle(v as CategorizedStyle)}
            data={[
              { label: t('classifyLayer.styleValues'), value: 'values' },
              { label: t('classifyLayer.styleRanges'), value: 'ranges' },
            ]}
          />
        )}

        {error && (
          <Alert color={isFreshLayerWait(error) ? 'yellow' : 'red'} variant="light" icon={<IconAlertCircle size={16} />}>
            {error}
          </Alert>
        )}

        {loading && <Text size="xs" c="dimmed">{t('common.loading')}</Text>}

        {mode === 'single' && (
          <Group gap={6}>
            <Swatch color={isValidHex(singleColor) ? singleColor : '#888888'} onChange={setSingleColor} />
            <Text size="xs" c="dimmed">{t('classifyLayer.colorForAll')}</Text>
          </Group>
        )}

        {mode === 'categorized' && categorizedStyle === 'values' && (
          <>
            {truncated && (
              <Text size="xs" c="dimmed">{t('classifyLayer.truncatedValues', { count: classes.length })}</Text>
            )}
            {classes.length > SAFE_CLASS_LIMIT && (
              <Alert color="yellow" variant="light" icon={<IconAlertCircle size={16} />}>
                {t('classifyLayer.tooManyClasses', { count: classes.length })}
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
            <Select
              size="xs"
              label={t('classifyLayer.methodLabel')}
              data={[
                { value: 'equal', label: t('classifyLayer.methodEqual') },
                { value: 'quantile', label: t('classifyLayer.methodQuantile') },
                { value: 'jenks', label: t('classifyLayer.methodJenks') },
                { value: 'manual', label: t('classifyLayer.methodManual') },
              ]}
              value={method}
              onChange={(v) => { if (v) chooseMethod(v as BreakMethod) }}
              allowDeselect={false}
              comboboxProps={{ withinPortal: false }}
            />
            <Text size="xs" c="dimmed">{t(`classifyLayer.methodHint.${method}`)}</Text>
            <Group grow>
              <NumberInput
                size="xs"
                label={t('classifyLayer.numClasses')}
                min={2}
                max={12}
                value={numClasses}
                onChange={(v) => { if (typeof v === 'number') chooseCount(v) }}
              />
              {mode === 'graduated' && (
                <Stack gap={2}>
                  <Text size="xs" c="dimmed">{t('classifyLayer.colorRamp')}</Text>
                  <Swatch color={rampColor} onChange={recolorRamp} />
                </Stack>
              )}
            </Group>
            {breaks.length > 0 && (
              <BreaksEditor
                breaks={breaks}
                onChange={setBreaks}
                onEditBounds={(bs) => { setBreaks(bs); setMethod('manual') }}
              />
            )}
          </>
        )}

        <Group justify="space-between" mt={4}>
          {existing ? (
            <Button size="xs" color="red" variant="subtle" leftSection={<IconTrash size={14} />} loading={saving} onClick={remove}>
              {t('classifyLayer.remove')}
            </Button>
          ) : <div />}
          <Group gap={6}>
            <Button size="xs" variant="subtle" color="gray" onClick={onClose}>{t('common.close')}</Button>
            <Button size="xs" leftSection={<IconTags size={14} />} loading={saving} disabled={!draft} onClick={save}>
              {t('common.save')}
            </Button>
          </Group>
        </Group>
      </Stack>
    </Modal>
  )
}
