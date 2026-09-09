/**
 * Bring-your-own-key settings for the AI agent — provider pick + API key.
 * The key is write-only end to end: this component sends it once on save
 * and immediately drops its own local copy; upload-api never echoes the
 * plaintext back, only {provider, last4} (see upload-api/ai_agent.py).
 */
import { useEffect, useState } from 'react'
import { Alert, Button, Group, Modal, PasswordInput, Select, Stack, Text } from '@mantine/core'
import { IconAlertCircle, IconCheck, IconKey } from '@tabler/icons-react'
import { useTranslation } from 'react-i18next'

import { AI_SETTINGS_KEY_URL } from './aiAgent'

type Provider = 'anthropic' | 'openai'

const PROVIDER_OPTIONS: { value: Provider; label: string }[] = [
  { value: 'anthropic', label: 'Anthropic (Claude)' },
  { value: 'openai', label: 'OpenAI (GPT)' },
]

export default function AiSettings({ opened, onClose }: { opened: boolean; onClose: () => void }) {
  const { t } = useTranslation()
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
      setSuccess(t('aiSettings.saved'))
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
      setSuccess(t('aiSettings.removed'))
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }

  return (
    <Modal opened={opened} onClose={onClose} title={t('aiSettings.title')} centered>
      <Stack gap="sm">
        <Text size="xs" c="dimmed">
          {t('aiSettings.intro')}
        </Text>

        {configured && (
          <Alert color="teal" variant="light" icon={<IconKey size={16} />}>
            {PROVIDER_OPTIONS.find((p) => p.value === configured.provider)?.label ?? configured.provider}
            {' '}{t('aiSettings.configuredSuffix', { last4: configured.last4 })}
          </Alert>
        )}

        <Select
          label={t('aiSettings.providerLabel')}
          data={PROVIDER_OPTIONS}
          value={provider}
          onChange={(v) => setProvider((v as Provider) ?? 'anthropic')}
          comboboxProps={{ withinPortal: false }}
        />

        <PasswordInput
          label={configured ? t('aiSettings.newKeyLabel') : t('aiSettings.keyLabel')}
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
              {t('aiSettings.removeKey')}
            </Button>
          ) : (
            <span />
          )}
          <Group>
            <Button variant="subtle" color="gray" onClick={onClose}>{t('common.close')}</Button>
            <Button leftSection={<IconKey size={16} />} loading={loading} disabled={!apiKey.trim()} onClick={save}>
              {t('common.save')}
            </Button>
          </Group>
        </Group>
      </Stack>
    </Modal>
  )
}
