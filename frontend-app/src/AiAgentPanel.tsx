/**
 * The AI Agent chat window — a Drawer rather than a Modal (unlike
 * Geoprocessing.tsx) so the user can watch the map react live to the
 * agent's own zoom/visibility/filter actions while still chatting.
 */
import { useEffect, useRef, useState } from 'react'
import {
  ActionIcon, Alert, Button, Group, Loader, Paper, ScrollArea, Stack, Text, Textarea, Tooltip,
  useComputedColorScheme,
} from '@mantine/core'
import { IconAlertCircle, IconRobot, IconSend2, IconSettings } from '@tabler/icons-react'

import AiSettings from './AiSettings'
import { useAiAgent } from './aiAgent'
import { DASHBOARD_HIGHLIGHT_COLOR, panelBg, panelBorder } from './colorScheme'

export default function AiAgentPanel() {
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

  if (!open) return null

  return (
    <Paper
      shadow="md"
      withBorder
      style={{
        position: 'fixed',
        top: 12,
        right: 12,
        bottom: 12,
        width: 360,
        zIndex: 300,
        display: 'flex',
        flexDirection: 'column',
        backgroundColor: panelBg(scheme),
        borderColor: panelBorder(scheme),
      }}
    >
      <Group justify="space-between" p="sm" style={{ borderBottom: `1px solid ${panelBorder(scheme)}` }}>
        <Group gap={6}>
          <IconRobot size={18} />
          <Text fw={600} size="sm">KI-Assistent</Text>
        </Group>
        <Group gap={4}>
          <Tooltip label="KI-Einstellungen">
            <ActionIcon variant="subtle" color="gray" onClick={() => setSettingsOpen(true)}>
              <IconSettings size={16} />
            </ActionIcon>
          </Tooltip>
          <ActionIcon variant="subtle" color="gray" aria-label="Schliessen" onClick={toggle}>
            ✕
          </ActionIcon>
        </Group>
      </Group>

      <ScrollArea style={{ flex: 1, minHeight: 0 }} p="sm" viewportRef={viewportRef}>
        <Stack gap="xs">
          {messages.length === 0 && (
            <Text size="xs" c="dimmed">
              Frag etwas zu den Daten, oder bitte den Assistenten, die Karte zu steuern
              (z. B. „zoome auf Layer X“, „blende Y aus“, „filtere Z nach …“).
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
              <Text size="sm" fw={600} mb={4}>Aktion bestätigen</Text>
              <Text size="sm" mb={8}>{pendingAction.summary}</Text>
              <Group gap="xs">
                <Button size="xs" loading={confirming} onClick={() => void confirmPendingAction()}>
                  Ausführen
                </Button>
                <Button size="xs" variant="subtle" color="gray" disabled={confirming} onClick={dismissPendingAction}>
                  Abbrechen
                </Button>
              </Group>
            </Paper>
          )}

          {sending && (
            <Group gap={6}>
              <Loader size="xs" />
              <Text size="xs" c="dimmed">denkt nach…</Text>
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
          placeholder="Frage stellen…"
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
        <ActionIcon size={36} disabled={!draft.trim() || sending} onClick={submit} aria-label="Senden">
          <IconSend2 size={16} />
        </ActionIcon>
      </Group>

      <AiSettings opened={settingsOpen} onClose={() => setSettingsOpen(false)} />
    </Paper>
  )
}
