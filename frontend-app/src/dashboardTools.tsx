/**
 * The two pieces of the selection dashboard that DataViewBand.tsx needs
 * *without* the dashboard itself: the "which layers can the dashboard show"
 * derivation, and the select-tool button row it renders in its own tab-strip
 * header.
 *
 * They used to live in SelectionDashboard.tsx and be imported from there.
 * That made the dashboard impossible to code-split: DataViewBand always
 * imports both, `useDashboardLayerNames()` is a hook (React.lazy only takes
 * components) and `SelectToolsRow` renders unconditionally in the header, so
 * the named imports pulled the whole 1.5k-line module — and @mantine/charts
 * with it — into the initial bundle no matter what. Split out here, the
 * dashboard panel itself is lazy and this stays eager, which is the right
 * split: this is small and always on screen, that is large and only rendered
 * once its tab is opened.
 *
 * Nothing here imports charts. Keep it that way.
 */
import { useMemo } from 'react'
import { ActionIcon, Badge, Group, Tooltip } from '@mantine/core'
import { IconCircle, IconClick, IconLasso, IconX } from '@tabler/icons-react'
import { useTranslation } from 'react-i18next'

import { useSelection } from './selection'
import { useTools } from './tools'
import { useSelectCandidates } from './ToolboxControls'
import { collectionFor, useApp } from './wms'

/**
 * The layer names the dashboard is currently able to show, in the order it
 * lists them: the layers a real selection spans, or — with nothing selected —
 * every visible layer whose collection can be resolved ("everything selected"
 * overview mode).
 *
 * Shared because DataViewBand.tsx needs the same answer to decide whether its
 * "auswerten" button can actually do anything for a given layer. Keeping that
 * one derivation in a single place means the button can never offer a layer
 * the dashboard would then silently refuse to select.
 */
export function useDashboardLayerNames(): string[] {
  const selected = useSelection((s) => s.selected)
  const layers = useApp((s) => s.layers)
  const dynamicCollections = useApp((s) => s.dynamicCollections)
  return useMemo(() => {
    const fromSelection: string[] = []
    selected.forEach((entry) => {
      if (!fromSelection.includes(entry.layer)) fromSelection.push(entry.layer)
    })
    if (fromSelection.length > 0) return fromSelection
    return layers
      .filter((l) => l.visible && !!(l.source ?? collectionFor(l.name, dynamicCollections)))
      .map((l) => l.name)
  }, [selected, layers, dynamicCollections])
}

/**
 * Point/circle/polygon select + the selected-count badge + clear. Rendered by
 * DataViewBand.tsx in its tab-strip header row (next to the maximize button),
 * so it's visible right in the band's header instead of taking up space
 * inside the dashboard's own scrollable body — and so selecting features
 * works the same from a plain attribute-table tab as from the dashboard.
 *
 * Reuses ToolboxControls.tsx's exact button block and shares its state, so
 * this copy and the floating toolbox's copy can never disagree.
 */
export function SelectToolsRow() {
  const { t } = useTranslation()
  const { setIdentify, setMeasure } = useTools()
  const selectMode = useSelection((s) => s.mode)
  const setSelectMode = useSelection((s) => s.setMode)
  const selectScope = useSelection((s) => s.scope)
  const selected = useSelection((s) => s.selected)
  const clearSelection = useSelection((s) => s.clearSelection)
  const selectCandidates = useSelectCandidates()

  return (
    <Group gap={6} wrap="nowrap">
      {(['point', 'circle', 'polygon'] as const).map((m) => {
        const icon = m === 'point' ? <IconClick size={15} /> : m === 'circle' ? <IconCircle size={15} /> : <IconLasso size={15} />
        const label = m === 'point' ? t('selectionDashboard.selectPoint') : m === 'circle' ? t('selectionDashboard.selectCircle') : t('selectionDashboard.selectPolygon')
        const disabledReason = selectScope === 'active'
          ? t('selectionDashboard.selectFirstOpenTable')
          : t('selectionDashboard.selectFirstVisibleLayer')
        return (
          <Tooltip key={m} label={selectCandidates.length > 0 ? t('selectionDashboard.selectThis', { label }) : disabledReason} withArrow>
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
            {t('selectionDashboard.selectedCount', { count: selected.size })}
          </Badge>
          <Tooltip label={t('selectionDashboard.clearSelection')} withArrow>
            <ActionIcon variant="subtle" size="sm" color="gray" onClick={clearSelection}>
              <IconX size={13} />
            </ActionIcon>
          </Tooltip>
        </>
      )}
    </Group>
  )
}
