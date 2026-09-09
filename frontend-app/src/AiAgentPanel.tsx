/**
 * The AI Agent chat window — never a Modal (unlike Geoprocessing.tsx), so
 * the user can watch the map react live to the agent's own
 * zoom/visibility/filter actions while still chatting.
 *
 * It is a *docked column*, not a floating overlay: App.tsx renders it as the
 * last flex sibling in the row, so the order left-to-right is map, sideband,
 * layer panel, agent. It used to be `position: fixed` against the right
 * edge, which laid it straight over both the sideband's icon rail and the
 * layer panel — exactly the two things you need while telling the agent
 * which layer to work on. Opening it now shrinks the map instead, the same
 * way the layer panel does, and the width/opacity transition below is
 * LayerPanel.tsx's so the two columns behave identically.
 */
import { useEffect, useRef, useState } from 'react'
import {
  ActionIcon, Alert, Box, Button, Group, Loader, Paper, ScrollArea, Stack, Text, Textarea, Tooltip,
  useComputedColorScheme,
} from '@mantine/core'
import { IconAlertCircle, IconRobot, IconSend2, IconSettings } from '@tabler/icons-react'
import { useTranslation } from 'react-i18next'

import AiSettings from './AiSettings'
import { useAiAgent } from './aiAgent'
import { accentEdge, DASHBOARD_HIGHLIGHT_COLOR, panelBg, panelBorder } from './colorScheme'

export default function AiAgentPanel() {
  const { t } = useTranslation()
  const open = useAiAgent((s) => s.open)
  const toggle = useAiAgent((s) => s.toggle)
  const messages = useAiAgent((s) => s.messages)
  const pendingAction = useAiAgent((s) => s.pendingAction)
  const sending = useAiAgent((s) => s.sending)
  const confirming = useAiAgent((s) => s.confirming)
  const error = useAiAgent((s) => s.error)
  const sendMessage = useAiAgent((s) => s.sendMessage)
  const confirmPendingAction = useAiAgent((s) => s.confirmPendingAction)
  const dismissPendingAction = useAiAgent((s) => s.dismissPendingAction)

  const [draft, setDraft] = useState('')
  const [settingsOpen, setSettingsOpen] = useState(false)
  const viewportRef = useRef<HTMLDivElement>(null)
  const scheme = useComputedColorScheme('dark')

  useEffect(() => {
    viewportRef.current?.scrollTo({ top: viewportRef.current.scrollHeight, behavior: 'smooth' })
  }, [messages, pendingAction])

  function submit() {
    const text = draft.trim()
    if (!text || sending) return
    setDraft('')
    void sendMessage(text)
  }

  return (
    <Box
      style={{
        width: open ? 360 : 0,
        flex: open ? '0 0 360px' : '0 0 0px',
        height: '100%',
        overflow: 'hidden',
        opacity: open ? 1 : 0,
        transition: 'width 200ms ease, flex-basis 200ms ease, opacity 150ms ease',
      }}
    >
    <Paper
      radius={0}
      style={{
        width: 360,
        flex: '0 0 360px',
        height: '100%',
        display: 'flex',
        flexDirection: 'column',
        backgroundColor: panelBg(scheme),
        borderLeft: `1px solid ${panelBorder(scheme)}`,
      }}
    >
      {/* Carries LayerPanel.tsx's accent strip across this column too — the
          two are neighbours in the docked row now, so stopping the band at
          the layer panel's right edge left it looking cut off. Reversed, so
          it picks up on the amber the layer panel's strip ends on rather
          than restarting from teal at the seam. */}
      <Box style={{ height: 2, flexShrink: 0, background: accentEdge(scheme, true) }} />
      <Group justify="space-between" p="sm" style={{ borderBottom: `1px solid ${panelBorder(scheme)}` }}>
        <Group gap={6}>
          <IconRobot size={18} />
          <Text fw={600} size="sm">{t('aiAgent.panelTitle')}</Text>
        </Group>
        <Group gap={4}>
          <Tooltip label={t('aiAgent.settingsTooltip')}>
            <ActionIcon variant="subtle" color="gray" onClick={() => setSettingsOpen(true)}>
              <IconSettings size={16} />
            </ActionIcon>
          </Tooltip>
          <ActionIcon variant="subtle" color="gray" aria-label={t('common.close')} onClick={toggle}>
            ✕
          </ActionIcon>
        </Group>
      </Group>

      <ScrollArea style={{ flex: 1, minHeight: 0 }} p="sm" viewportRef={viewportRef}>
        <Stack gap="xs">
          {messages.length === 0 && (
            <Text size="xs" c="dimmed">
              {t('aiAgent.emptyHint')}
            </Text>
          )}
          {messages.map((m, i) => (
            <Paper
              key={i}
              p="xs"
              radius="sm"
              withBorder
              style={{
                alignSelf: m.role === 'user' ? 'flex-end' : 'flex-start',
                maxWidth: '85%',
                backgroundColor:
                  m.role === 'user' ? 'var(--mantine-color-teal-light)' : 'var(--mantine-color-default)',
              }}
            >
              <Text size="sm" style={{ whiteSpace: 'pre-wrap' }}>{m.content}</Text>
            </Paper>
          ))}

          {pendingAction && (
            <Paper p="xs" radius="sm" withBorder style={{ borderColor: DASHBOARD_HIGHLIGHT_COLOR }}>
              <Text size="sm" fw={600} mb={4}>{t('aiAgent.confirmTitle')}</Text>
              <Text size="sm" mb={8}>{pendingAction.summary}</Text>
              <Group gap="xs">
                <Button size="xs" loading={confirming} onClick={() => void confirmPendingAction()}>
                  {t('aiAgent.confirmRun')}
                </Button>
                <Button size="xs" variant="subtle" color="gray" disabled={confirming} onClick={dismissPendingAction}>
                  {t('common.cancel')}
                </Button>
              </Group>
            </Paper>
          )}

          {sending && (
            <Group gap={6}>
              <Loader size="xs" />
              <Text size="xs" c="dimmed">{t('aiAgent.thinking')}</Text>
            </Group>
          )}

          {error && (
            <Alert color="red" variant="light" icon={<IconAlertCircle size={16} />}>{error}</Alert>
          )}
        </Stack>
      </ScrollArea>

      <Group p="sm" gap="xs" style={{ borderTop: `1px solid ${panelBorder(scheme)}` }} align="flex-end">
        <Textarea
          style={{ flex: 1 }}
          placeholder={t('aiAgent.askPlaceholder')}
          autosize
          minRows={1}
          maxRows={4}
          value={draft}
          onChange={(e) => setDraft(e.currentTarget.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault()
              submit()
            }
          }}
        />
        <ActionIcon size={36} disabled={!draft.trim() || sending} onClick={submit} aria-label={t('aiAgent.sendAriaLabel')}>
          <IconSend2 size={16} />
        </ActionIcon>
      </Group>

      <AiSettings opened={settingsOpen} onClose={() => setSettingsOpen(false)} />
    </Paper>
    </Box>
  )
}
