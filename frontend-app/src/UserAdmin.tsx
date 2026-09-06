/**
 * Admin-only account management: list, add and delete users. Reachable only
 * from LayerPanel's "Benutzer verwalten" button, itself gated on
 * role === 'admin' — the real security boundary is upload-api's
 * require_role("admin") on every /users route, this UI just fronts it.
 */
import { useEffect, useState } from 'react'
import {
  ActionIcon, Alert, Button, Group, Modal, PasswordInput, Select, Stack, Table, Text, TextInput,
} from '@mantine/core'
import { IconAlertCircle, IconTrash, IconUserPlus } from '@tabler/icons-react'
import { useTranslation } from 'react-i18next'

import { USERS_URL, useAuth, type Role, type Tier } from './auth'

interface UserRow {
  id: number
  username: string
  role: Role
  subscription_tier: Tier
  created_at: string
}

export default function UserAdmin({ opened, onClose }: { opened: boolean; onClose: () => void }) {
  const { t } = useTranslation()
  const currentUser = useAuth((s) => s.user)
  const [users, setUsers] = useState<UserRow[]>([])
  const [loading, setLoading] = useState(false)
  const [listError, setListError] = useState<string | null>(null)

  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [role, setRole] = useState<Role>('viewer')
  const [tier, setTier] = useState<'free' | 'pro' | 'premium'>('free')
  const [saving, setSaving] = useState(false)
  const [formError, setFormError] = useState<string | null>(null)

  async function reload() {
    setLoading(true)
    setListError(null)
    try {
      const res = await fetch(USERS_URL)
      if (!res.ok) throw new Error(`${t('userAdmin.listLoadError')}: HTTP ${res.status}`)
      setUsers(await res.json())
    } catch (e) {
      setListError(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    if (opened) reload()
  }, [opened])

  async function addUser() {
    if (!username.trim() || !password) return
    setSaving(true)
    setFormError(null)
    try {
      const res = await fetch(USERS_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: username.trim(), password, role, subscription_tier: tier }),
      })
      const body = await res.json().catch(() => null)
      if (!res.ok) throw new Error(body?.detail ?? `${t('userAdmin.saveError')}: HTTP ${res.status}`)
      setUsername('')
      setPassword('')
      setRole('viewer')
      setTier('free')
      await reload()
    } catch (e) {
      setFormError(e instanceof Error ? e.message : String(e))
    } finally {
      setSaving(false)
    }
  }

  async function deleteUser(name: string) {
    setListError(null)
    try {
      const res = await fetch(`${USERS_URL}/${encodeURIComponent(name)}`, { method: 'DELETE' })
      const body = await res.json().catch(() => null)
      if (!res.ok) throw new Error(body?.detail ?? `${t('userAdmin.deleteError')}: HTTP ${res.status}`)
      await reload()
    } catch (e) {
      setListError(e instanceof Error ? e.message : String(e))
    }
  }

  return (
    <Modal opened={opened} onClose={onClose} title={t('userAdmin.modalTitle')} centered size="md">
      <Stack gap="sm">
        {listError && (
          <Alert color="red" variant="light" icon={<IconAlertCircle size={16} />}>{listError}</Alert>
        )}

        <Table striped highlightOnHover>
          <Table.Thead>
            <Table.Tr>
              <Table.Th>{t('userAdmin.username')}</Table.Th>
              <Table.Th>{t('userAdmin.role')}</Table.Th>
              <Table.Th>{t('userAdmin.tier')}</Table.Th>
              <Table.Th />
            </Table.Tr>
          </Table.Thead>
          <Table.Tbody>
            {users.map((u) => (
              <Table.Tr key={u.id}>
                <Table.Td>{u.username}</Table.Td>
                <Table.Td>{u.role}</Table.Td>
                <Table.Td>{u.subscription_tier}</Table.Td>
                <Table.Td>
                  <ActionIcon
                    variant="subtle"
                    color="red"
                    aria-label={t('userAdmin.deleteAriaLabel', { username: u.username })}
                    disabled={u.username === currentUser?.username}
                    onClick={() => deleteUser(u.username)}
                  >
                    <IconTrash size={14} />
                  </ActionIcon>
                </Table.Td>
              </Table.Tr>
            ))}
            {!loading && users.length === 0 && (
              <Table.Tr>
                <Table.Td colSpan={4}><Text c="dimmed" size="sm">{t('userAdmin.empty')}</Text></Table.Td>
              </Table.Tr>
            )}
          </Table.Tbody>
        </Table>

        <Text fw={600} size="sm" mt="sm">{t('userAdmin.addSectionTitle')}</Text>
        <TextInput label={t('userAdmin.username')} value={username} onChange={(e) => setUsername(e.currentTarget.value)} />
        <PasswordInput label={t('login.password')} value={password} onChange={(e) => setPassword(e.currentTarget.value)} />
        <Select
          label={t('userAdmin.role')}
          data={[
            { value: 'admin', label: 'admin' },
            { value: 'editor', label: 'editor' },
            { value: 'viewer', label: 'viewer' },
          ]}
          value={role}
          onChange={(v) => setRole((v as Role) ?? 'viewer')}
          comboboxProps={{ withinPortal: false }}
        />
        <Select
          label={t('userAdmin.tier')}
          data={[
            { value: 'free', label: 'Free' },
            { value: 'pro', label: 'Pro' },
            { value: 'premium', label: 'Premium' },
          ]}
          value={tier}
          onChange={(v) => setTier((v as 'free' | 'pro' | 'premium') ?? 'free')}
          comboboxProps={{ withinPortal: false }}
        />
        {formError && (
          <Alert color="red" variant="light" icon={<IconAlertCircle size={16} />}>{formError}</Alert>
        )}

        <Group justify="flex-end">
          <Button variant="subtle" color="gray" onClick={onClose}>{t('common.close')}</Button>
          <Button
            leftSection={<IconUserPlus size={16} />}
            loading={saving}
            disabled={!username.trim() || !password}
            onClick={addUser}
          >
            {t('common.save')}
          </Button>
        </Group>
      </Stack>
    </Modal>
  )
}
