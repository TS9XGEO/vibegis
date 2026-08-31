/**
 * The search/identify/measure/select UI, shared between the floating
 * toolbox panel (MapTools.tsx, which also owns the actual Cesium click
 * handlers) and its embedded copy inside SelectionDashboard.tsx's docked
 * tab. Both mounts read the same useTools()/useSelection() stores, so
 * either copy drives the exact same map interaction — MapTools.tsx stays
 * mounted unconditionally (only its own Paper is hidden when its panel is
 * closed), so its identify/measure/select effects keep running no matter
 * which copy of these controls the user actually clicked. This component is
 * pure UI plus the search-flyTo behavior.
 *
 * flyToHit reads `camera` from wms.ts's useApp store rather than Resium's
 * useCesium() — the same pattern LayerPanel.tsx/AttributeTable.tsx already
 * use for UI outside <Scene>'s Viewer tree. This component's embedded copy
 * renders inside SelectionDashboard.tsx's docked panel, which lives in
 * DataViewBand (a sibling of <Scene> in App.tsx, not a descendant), so
 * useCesium() would have no Viewer context there; MapTools.tsx's own copy
 * still renders inside <Scene>, but Scene.tsx keeps the store's `camera`
 * field populated regardless of who reads it, so nothing changes for it.
 */
import { useEffect, useMemo, useState } from 'react'
import {
  ActionIcon, Alert, Badge, Box, Group, Loader, ScrollArea, SegmentedControl, Stack, Table, Text, TextInput, Tooltip,
} from '@mantine/core'
import {
  IconCircle, IconClick, IconInfoCircle, IconLasso, IconLine, IconPolygon, IconSearch, IconX,
} from '@tabler/icons-react'
import { Cartesian3 } from 'cesium'

import { columnLabel } from './columns'
import { useTools } from './tools'
import { useSelection } from './selection'
import { collectionFor, useApp } from './wms'

/** Every visible/active layer selection can currently target, derived the
 * same way for the buttons' disabled state (here) and for the Cesium click
 * handlers that actually query features (MapTools.tsx) — a single source so
 * the two never drift apart. */
export function useSelectCandidates() {
  const layers = useApp((s) => s.layers)
  const dynamicCollections = useApp((s) => s.dynamicCollections)
  const selectScope = useSelection((s) => s.scope)
  const openLayers = useSelection((s) => s.openLayers)
  const activeLayerName = useSelection((s) => s.activeLayer)
  const activeOpenLayer = openLayers.find((o) => o.name === activeLayerName) ?? null

  const visibleSelectableLayers = useMemo(
    () =>
      layers
        .filter((l) => l.visible)
        .map((l) => ({ name: l.name, collection: collectionFor(l.name, dynamicCollections) }))
        .filter((l): l is { name: string; collection: string } => !!l.collection),
    [layers, dynamicCollections],
  )

  return selectScope === 'active' ? (activeOpenLayer ? [activeOpenLayer] : []) : visibleSelectableLayers
}

export default function ToolboxControls() {
  const camera = useApp((s) => s.camera)
  const layerConfigs = useApp((s) => s.layerConfigs)

  const {
    query, hits, searching, searchError,
    setQuery, runSearch, clearSearch,
    identifyOn, identifyBusy, results, setIdentify,
    measure, measureValue, setMeasure,
  } = useTools()

  const [debounced, setDebounced] = useState('')

  const selectMode = useSelection((s) => s.mode)
  const setSelectMode = useSelection((s) => s.setMode)
  const selectScope = useSelection((s) => s.scope)
  const setSelectScope = useSelection((s) => s.setScope)
  const selected = useSelection((s) => s.selected)
  const selectTruncated = useSelection((s) => s.truncated)
  const clearSelection = useSelection((s) => s.clearSelection)

  const selectCandidates = useSelectCandidates()

  useEffect(() => {
    const t = setTimeout(() => setDebounced(query), 300)
    return () => clearTimeout(t)
  }, [query])

  useEffect(() => {
    if (debounced.trim().length >= 2) runSearch(debounced)
  }, [debounced, runSearch])

  function flyToHit(lon: number, lat: number) {
    camera?.flyTo({
      destination: Cartesian3.fromDegrees(lon, lat, 2500),
      duration: 1.5,
    })
  }

  return (
    <>
      <Box p="xs" pt={0}>
        <TextInput
          size="xs"
          placeholder="Suchen: Ort, Strasse, Gebaeude…"
          value={query}
          onChange={(e) => setQuery(e.currentTarget.value)}
          leftSection={searching ? <Loader size={12} /> : <IconSearch size={14} />}
          rightSection={
            query ? (
              <ActionIcon variant="subtle" size="sm" color="gray" onClick={clearSearch}>
                <IconX size={13} />
              </ActionIcon>
            ) : null
          }
        />

        {searchError && (
          <Alert color="red" variant="light" p={6} mt={6}>
            <Text size="xs">{searchError}</Text>
          </Alert>
        )}

        {hits.length > 0 && (
          <ScrollArea.Autosize mah={220} mt={6}>
            <Stack gap={2}>
              {hits.map((h, i) => (
                <Group
                  key={`${h.name}-${i}`}
                  gap={6}
                  wrap="nowrap"
                  p={4}
                  style={{ borderRadius: 4, cursor: 'pointer' }}
                  onClick={() => flyToHit(h.lon, h.lat)}
                >
                  <Text size="xs" style={{ flex: 1, minWidth: 0 }} truncate>
                    {h.name}
                  </Text>
                  <Badge size="xs" variant="light" color="gray">
                    {h.category}
                  </Badge>
                </Group>
              ))}
            </Stack>
          </ScrollArea.Autosize>
        )}

        <Group gap={6} mt={8}>
          <Tooltip label="Objekte abfragen (Klick auf die Karte)" withArrow>
            <ActionIcon
              variant={identifyOn ? 'filled' : 'subtle'}
              color={identifyOn ? 'teal' : 'gray'}
              size="sm"
              onClick={() => { setMeasure('off'); setSelectMode('off'); setIdentify(!identifyOn) }}
            >
              <IconInfoCircle size={15} />
            </ActionIcon>
          </Tooltip>

          <Tooltip label="Strecke messen (Rechtsklick beendet)" withArrow>
            <ActionIcon
              variant={measure === 'distance' ? 'filled' : 'subtle'}
              color={measure === 'distance' ? 'teal' : 'gray'}
              size="sm"
              onClick={() => {
                setIdentify(false)
                setSelectMode('off')
                setMeasure(measure === 'distance' ? 'off' : 'distance')
              }}
            >
              <IconLine size={15} />
            </ActionIcon>
          </Tooltip>

          <Tooltip label="Flaeche messen (Rechtsklick beendet)" withArrow>
            <ActionIcon
              variant={measure === 'area' ? 'filled' : 'subtle'}
              color={measure === 'area' ? 'teal' : 'gray'}
              size="sm"
              onClick={() => {
                setIdentify(false)
                setSelectMode('off')
                setMeasure(measure === 'area' ? 'off' : 'area')
              }}
            >
              <IconPolygon size={15} />
            </ActionIcon>
          </Tooltip>

          {measureValue && (
            <Badge size="sm" variant="light" color="teal" ml="auto">
              {measureValue}
            </Badge>
          )}
          {identifyBusy && <Loader size={12} ml="auto" />}
        </Group>

        <SegmentedControl
          size="xs"
          mt={6}
          fullWidth
          value={selectScope}
          onChange={(v) => setSelectScope(v as 'active' | 'allVisible')}
          data={[
            { label: 'Nur aktiver Layer', value: 'active' },
            { label: 'Alle sichtbaren Layer', value: 'allVisible' },
          ]}
        />

        <Group gap={6} mt={6}>
          {(['point', 'circle', 'polygon'] as const).map((m) => {
            const icon = m === 'point' ? <IconClick size={15} /> : m === 'circle' ? <IconCircle size={15} /> : <IconLasso size={15} />
            const label = m === 'point' ? 'Punkt' : m === 'circle' ? 'Kreis' : 'Polygon'
            const disabledReason = selectScope === 'active'
              ? 'Zuerst eine Sachdatentabelle öffnen'
              : 'Mindestens einen Layer sichtbar schalten'
            return (
              <Tooltip key={m} label={selectCandidates.length > 0 ? `${label} auswählen` : disabledReason} withArrow>
                <ActionIcon
                  variant={selectMode === m ? 'filled' : 'subtle'}
                  color={selectMode === m ? 'yellow' : 'gray'}
                  size="sm"
                  disabled={selectCandidates.length === 0}
                  onClick={() => {
                    setIdentify(false)
                    setMeasure('off')
                    setSelectMode(selectMode === m ? 'off' : m)
                  }}
                >
                  {icon}
                </ActionIcon>
              </Tooltip>
            )
          })}

          {selected.size > 0 && (
            <>
              <Badge size="sm" variant="light" color="yellow">
                {selected.size} ausgewählt
              </Badge>
              <Tooltip label="Auswahl aufheben" withArrow>
                <ActionIcon variant="subtle" size="sm" color="gray" onClick={clearSelection}>
                  <IconX size={13} />
                </ActionIcon>
              </Tooltip>
            </>
          )}
        </Group>

        {(identifyOn || measure !== 'off') && (
          <Text size="10px" c="dimmed" mt={4}>
            {measure !== 'off'
              ? 'Punkte klicken, Rechtsklick beendet die Messung.'
              : 'Auf ein Objekt in der Karte klicken.'}
          </Text>
        )}
        {selectMode !== 'off' && (
          <Text size="10px" c={selectTruncated ? 'yellow' : 'dimmed'} mt={4}>
            {selectTruncated
              ? 'Zu viele Treffer in diesem Bereich — kleiner zeichnen.'
              : selectMode === 'point'
                ? 'Auf ein Objekt klicken, um es aus- oder abzuwählen.'
                : selectMode === 'circle'
                  ? 'Klicken, halten und ziehen, um einen Kreis zu zeichnen.'
                  : 'Punkte klicken, Rechtsklick beendet die Auswahl.'}
          </Text>
        )}
      </Box>

      {results.length > 0 && (
        <ScrollArea.Autosize mah="calc(100vh - 320px)">
          <Box px="xs" pb="xs">
            {results.map((r, i) => (
              <Box key={i} mb={8}>
                <Badge size="xs" variant="light" mb={2}>{layerConfigs[r.layer]?.title || r.layer}</Badge>
                <Table withRowBorders={false} verticalSpacing={1} fz="11px">
                  <Table.Tbody>
                    {Object.entries(r.properties)
                      .filter(([, v]) => v !== null && v !== '')
                      .slice(0, 14)
                      .map(([k, v]) => (
                        <Table.Tr key={k}>
                          <Table.Td c="dimmed" style={{ width: '40%' }}>
                            {columnLabel(layerConfigs[r.layer]?.columnAliases, k)}
                          </Table.Td>
                          <Table.Td>{String(v)}</Table.Td>
                        </Table.Tr>
                      ))}
                  </Table.Tbody>
                </Table>
              </Box>
            ))}
          </Box>
        </ScrollArea.Autosize>
      )}
    </>
  )
}
