/**
 * Docked below the map (see App.tsx) — a resizable panel holding one tab per
 * layer whose data view is open, plus one pinned tab for the Auswahl-
 * Dashboard (selection.ts's `dashboardTabOpen`/`dashboardTabActive`, toggled
 * from Sideband.tsx). The "Data View Band" is the tab strip itself; only the
 * focused tab's content is visible, but every open tab stays mounted
 * underneath so switching back doesn't lose its scroll/paging/expansion
 * state (see AttributeTablePanel.tsx's and SelectionDashboardPanel's
 * `isActive` handling).
 *
 * While the dashboard is focused, the individual layer tabs collapse into a
 * single "Datenansicht" pill instead of staying listed alongside the
 * dashboard tab — showing every layer tab AND the full dashboard at once
 * felt cluttered, and nothing is lost: clicking the pill
 * (selection.ts's `focusDataView()`) or any layer row in LayerPanel.tsx
 * (`openLayerTab()`) switches straight back to the normal tab strip.
 * SelectionDashboard.tsx's `SelectToolsRow` (point/circle/polygon select +
 * count + clear) sits in the header next to the maximize button, shown
 * regardless of which tab is focused — selecting features is just as useful
 * from a plain attribute-table tab as from the dashboard. The header's own
 * X closes both the whole data view AND the dashboard tab at once
 * (`closeAllLayerTabs()` +
 * `closeDashboardTab()`) — always shown, since the band itself only renders
 * when at least one of the two is actually open.
 */
import { ActionIcon, Box, Group, Text, Tooltip, useComputedColorScheme } from '@mantine/core'
import { IconChartBar, IconChevronsDown, IconChevronsUp, IconX } from '@tabler/icons-react'

import AttributeTablePanel from './AttributeTable'
import { accentEdge, panelBg, panelBorder } from './colorScheme'
import SelectionDashboardPanel, { SelectToolsRow } from './SelectionDashboard'
import { useResizeHeight } from './useResizeHeight'
import { useSelection } from './selection'
import { useApp } from './wms'

const DEFAULT_HEIGHT = 380
const MIN_HEIGHT = 160
const MAX_HEIGHT = 800

export default function DataViewBand() {
  const scheme = useComputedColorScheme('dark')
  const openLayers = useSelection((s) => s.openLayers)
  const activeLayer = useSelection((s) => s.activeLayer)
  const setActiveLayer = useSelection((s) => s.setActiveLayer)
  const closeLayerTab = useSelection((s) => s.closeLayerTab)
  const closeAllLayerTabs = useSelection((s) => s.closeAllLayerTabs)
  const dashboardTabOpen = useSelection((s) => s.dashboardTabOpen)
  const dashboardTabActive = useSelection((s) => s.dashboardTabActive)
  const focusDashboardTab = useSelection((s) => s.focusDashboardTab)
  const closeDashboardTab = useSelection((s) => s.closeDashboardTab)
  const focusDataView = useSelection((s) => s.focusDataView)
  const layers = useApp((s) => s.layers)
  const layerConfigs = useApp((s) => s.layerConfigs)
  const { height, handleProps: resizeHandleProps, maximized, toggleMaximize } =
    useResizeHeight(DEFAULT_HEIGHT, MIN_HEIGHT, MAX_HEIGHT)

  if (openLayers.length === 0 && !dashboardTabOpen) return null

  return (
    <Box
      style={{
        // Maximized overrides the drag-resized pixel height entirely: a much
        // higher flex-grow than the map viewport's own `flex: 1` (Scene's
        // wrapping Box in App.tsx) makes this band absorb essentially all
        // available height, squeezing the map down to its `minHeight: 0`
        // floor instead of computing an exact pixel value.
        flex: maximized ? '10000 1 0px' : `0 0 ${height}px`,
        height: maximized ? undefined : height,
        minWidth: 0,
        display: 'flex',
        flexDirection: 'column',
        backgroundColor: panelBg(scheme, 0.98),
        borderTop: `1px solid ${panelBorder(scheme)}`,
      }}
    >
      {/* Same accent strip as the other floating/docked panels (colorScheme.ts's
          accentEdge) — doubles as the resize handle, same as it doubles as
          the drag handle elsewhere. */}
      <Box
        {...resizeHandleProps}
        style={{
          ...resizeHandleProps.style,
          height: 6,
          flexShrink: 0,
          cursor: 'row-resize',
          background: accentEdge(scheme),
        }}
      />

      {/* The Data View Band: one tab per open layer, plus a big "close all"
          X at the top right — separate from each tab's own small close, this
          one drops the whole band at once. */}
      <Group
        gap={4}
        px="xs"
        py={4}
        justify="space-between"
        wrap="nowrap"
        style={{ borderBottom: `1px solid ${panelBorder(scheme)}`, flexShrink: 0 }}
      >
        <Group gap={4} wrap="nowrap" style={{ minWidth: 0, overflow: 'hidden' }}>
          {dashboardTabOpen && (
            <Group
              gap={4}
              wrap="nowrap"
              onClick={focusDashboardTab}
              style={{
                cursor: 'pointer',
                padding: '4px 6px',
                borderRadius: 6,
                flexShrink: 0,
                backgroundColor: dashboardTabActive ? 'var(--mantine-color-teal-light)' : undefined,
              }}
            >
              <IconChartBar size={13} color={dashboardTabActive ? 'var(--mantine-color-teal-6)' : 'var(--mantine-color-dimmed)'} />
              <Text size="xs" fw={dashboardTabActive ? 600 : 400} c={dashboardTabActive ? 'teal' : undefined}>
                Dashboard
              </Text>
              <Box
                component="span"
                role="button"
                aria-label="Auswahl-Dashboard schliessen"
                onClick={(e) => { e.stopPropagation(); closeDashboardTab() }}
                style={{ display: 'flex', color: 'var(--mantine-color-dimmed)' }}
              >
                <IconX size={12} />
              </Box>
            </Group>
          )}
          {dashboardTabActive ? (
            openLayers.length > 0 && (
              <Group
                gap={4}
                wrap="nowrap"
                onClick={focusDataView}
                style={{ cursor: 'pointer', padding: '4px 6px', borderRadius: 6, flexShrink: 0 }}
              >
                <Text size="xs" c="dimmed">Datenansicht ({openLayers.length})</Text>
              </Group>
            )
          ) : (
            openLayers.map((ol) => {
              const layer = layers.find((l) => l.name === ol.name)
              const title = layerConfigs[ol.name]?.title || layer?.title || ol.name
              const isActive = ol.name === activeLayer
              return (
                <Group
                  key={ol.name}
                  gap={4}
                  wrap="nowrap"
                  onClick={() => setActiveLayer(ol.name)}
                  style={{
                    cursor: 'pointer',
                    padding: '4px 6px',
                    borderRadius: 6,
                    maxWidth: 200,
                    flexShrink: 0,
                    backgroundColor: isActive ? 'var(--mantine-color-teal-light)' : undefined,
                  }}
                >
                  <Text size="xs" fw={isActive ? 600 : 400} c={isActive ? 'teal' : undefined} truncate style={{ minWidth: 0 }}>
                    {title}
                  </Text>
                  <Box
                    component="span"
                    role="button"
                    aria-label={`${title} schliessen`}
                    onClick={(e) => { e.stopPropagation(); closeLayerTab(ol.name) }}
                    style={{ display: 'flex', color: 'var(--mantine-color-dimmed)' }}
                  >
                    <IconX size={12} />
                  </Box>
                </Group>
              )
            })
          )}
        </Group>

        <Group gap={4} wrap="nowrap" style={{ flexShrink: 0 }}>
          {/* Point/circle/polygon select + count + clear — defined in
              SelectionDashboard.tsx (that's still where the component
              itself lives), but shown here in the band's own header
              regardless of which tab is focused, so selecting features
              works the same from a plain attribute-table tab as it does
              from the dashboard — no reason to make it dashboard-only when
              the underlying select tools never were. */}
          <SelectToolsRow />
          <Tooltip label={maximized ? 'Wiederherstellen' : 'Ganz nach oben ausdehnen'} withArrow>
            <ActionIcon
              variant="subtle"
              color="gray"
              size="md"
              aria-label={maximized ? 'Wiederherstellen' : 'Ganz nach oben ausdehnen'}
              onClick={toggleMaximize}
            >
              {maximized ? <IconChevronsDown size={16} /> : <IconChevronsUp size={16} />}
            </ActionIcon>
          </Tooltip>
          {/* Used to be "close all layer tabs", hidden while the dashboard
              was focused since it only ever closed the layer tabs, not the
              dashboard itself. Now closes both at once — always shown,
              since the band only renders at all when at least one of the
              two is actually open (see the early return above), so there's
              always something for it to do. */}
          <Tooltip label="Datenansicht und Dashboard schliessen" withArrow>
            <ActionIcon
              variant="subtle"
              color="gray"
              size="md"
              aria-label="Datenansicht und Dashboard schliessen"
              onClick={() => { closeAllLayerTabs(); closeDashboardTab() }}
            >
              <IconX size={18} />
            </ActionIcon>
          </Tooltip>
        </Group>
      </Group>

      <Box p="xs" style={{ flex: 1, minHeight: 0, minWidth: 0, display: 'flex', flexDirection: 'column' }}>
        {dashboardTabOpen && <SelectionDashboardPanel isActive={dashboardTabActive} />}
        {openLayers.map((ol) => {
          const layer = layers.find((l) => l.name === ol.name)
          if (!layer) return null
          return (
            <AttributeTablePanel
              key={ol.name}
              layer={layer}
              collection={ol.collection}
              isActive={!dashboardTabActive && ol.name === activeLayer}
            />
          )
        })}
      </Box>
    </Box>
  )
}
