/**
 * Bring-your-own-key settings for the AI agent — provider pick + API key.
 * The key is write-only end to end: this component sends it once on save
 * and immediately drops its own local copy; upload-api never echoes the
 * plaintext back, only {provider, last4} (see upload-api/ai_agent.py).
 */
import { useEffect, useState } from 'react'
import { Alert, Button, Group, Modal, PasswordInput, Select, Stack, Text } from '@mantine/core'
import { IconAlertCircle, IconCheck, IconKey } from '@tabler/icons-react'

import { AI_SETTINGS_KEY_URL } from './aiAgent'

type Provider = 'anthropic' | 'openai'

const PROVIDER_OPTIONS: { value: Provider; label: string }[] = [
  { value: 'anthropic', label: 'Anthropic (Claude)' },
  { value: 'openai', label: 'OpenAI (GPT)' },
]

export default function AiSettings({ opened, onClose }: { opened: boolean; onClose: () => void }) {
  const [provider, setProvider] = useState<Provider>('anthropic')
  const [apiKey, setApiKey] = useState('')
  const [configured, setConfigured] = useState<{ provider: Provider; last4: string } | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [success, setSuccess] = useState<string | null>(null)

  useEffect(() => {
    if (!opened) return
    setError(null)
    setSuccess(null)
    fetch(AI_SETTINGS_KEY_URL)
      .then((res) => (res.ok ? res.json() : null))
      .then((body) => {
        if (body?.configured) {
          setConfigured({ provider: body.provider, last4: body.last4 })
          setProvider(body.provider)
        } else {
          setConfigured(null)
        }
      })
      .catch(() => setConfigured(null))
  }, [opened])

  async function save() {
    if (!apiKey.trim()) return
    setLoading(true)
    setError(null)
    setSuccess(null)
    try {
      const res = await fetch(AI_SETTINGS_KEY_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ provider, api_key: apiKey.trim() }),
      })
      const body = await res.json().catch(() => null)
      if (!res.ok) throw new Error(body?.detail ?? `HTTP ${res.status}`)
      setConfigured({ provider: body.provider, last4: body.last4 })
      setSuccess('API-Schlüssel gespeichert.')
      // Never hold the plaintext key any longer than this one request.
      setApiKey('')
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }

  async function remove() {
    setLoading(true)
    setError(null)
    setSuccess(null)
    try {
      const res = await fetch(AI_SETTINGS_KEY_URL, { method: 'DELETE' })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      setConfigured(null)
      setApiKey('')
      setSuccess('API-Schlüssel entfernt.')
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }

  return (
    <Modal opened={opened} onClose={onClose} title="KI-Einstellungen" centered>
      <Stack gap="sm">
        <Text size="xs" c="dimmed">
          Der KI-Agent nutzt deinen eigenen API-Schlüssel — Kosten laufen über dein eigenes
          Konto beim gewählten Anbieter. Der Schlüssel wird verschlüsselt gespeichert und nie
          wieder im Klartext angezeigt.
        </Text>

        {configured && (
          <Alert color="teal" variant="light" icon={<IconKey size={16} />}>
            {PROVIDER_OPTIONS.find((p) => p.value === configured.provider)?.label ?? configured.provider}
            {' '}konfiguriert (…{configured.last4})
          </Alert>
        )}

        <Select
          label="Anbieter"
          data={PROVIDER_OPTIONS}
          value={provider}
          onChange={(v) => setProvider((v as Provider) ?? 'anthropic')}
          comboboxProps={{ withinPortal: false }}
        />

        <PasswordInput
          label={configured ? 'Neuen API-Schlüssel hinterlegen' : 'API-Schlüssel'}
          placeholder="sk-..."
          value={apiKey}
          onChange={(e) => setApiKey(e.currentTarget.value)}
        />

        {error && (
          <Alert color="red" variant="light" icon={<IconAlertCircle size={16} />}>{error}</Alert>
        )}
        {success && (
          <Alert color="green" variant="light" icon={<IconCheck size={16} />}>{success}</Alert>
        )}

        <Group justify="space-between">
          {configured ? (
            <Button variant="subtle" color="red" onClick={remove} loading={loading}>
              Schlüssel entfernen
            </Button>
          ) : (
            <span />
          )}
          <Group>
            <Button variant="subtle" color="gray" onClick={onClose}>Schliessen</Button>
            <Button leftSection={<IconKey size={16} />} loading={loading} disabled={!apiKey.trim()} onClick={save}>
              Speichern
            </Button>
          </Group>
        </Group>
      </Stack>
    </Modal>
  )
}
