/**
 * Admin-only account management: list, add and delete users. Reachable only
 * from LayerPanel's "Benutzer verwalten" button, itself gated on
 * role === 'admin' — the real security boundary is upload-api's
 * require_role("admin") on every /users route, this UI just fronts it.
 */
import { useEffect, useState } from 'react'
import {
  ActionIcon, Alert, Button, Checkbox, Group, Modal, PasswordInput, Select, Stack, Table, Text, TextInput,
} from '@mantine/core'
import { IconAlertCircle, IconTrash, IconUserPlus } from '@tabler/icons-react'

import { USERS_URL, useAuth } from './auth'

interface UserRow {
  id: number
  username: string
  role: 'admin' | 'viewer'
  premium: boolean
  created_at: string
}

export default function UserAdmin({ opened, onClose }: { opened: boolean; onClose: () => void }) {
  const currentUser = useAuth((s) => s.user)
  const [users, setUsers] = useState<UserRow[]>([])
  const [loading, setLoading] = useState(false)
  const [listError, setListError] = useState<string | null>(null)

  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [role, setRole] = useState<'admin' | 'viewer'>('viewer')
  const [premium, setPremium] = useState(false)
  const [saving, setSaving] = useState(false)
  const [formError, setFormError] = useState<string | null>(null)

  async function reload() {
    setLoading(true)
    setListError(null)
    try {
      const res = await fetch(USERS_URL)
      if (!res.ok) throw new Error(`Benutzerliste: HTTP ${res.status}`)
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
        body: JSON.stringify({ username: username.trim(), password, role, premium }),
      })
      const body = await res.json().catch(() => null)
      if (!res.ok) throw new Error(body?.detail ?? `Speichern fehlgeschlagen: HTTP ${res.status}`)
      setUsername('')
      setPassword('')
      setRole('viewer')
      setPremium(false)
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
      if (!res.ok) throw new Error(body?.detail ?? `Löschen fehlgeschlagen: HTTP ${res.status}`)
      await reload()
    } catch (e) {
      setListError(e instanceof Error ? e.message : String(e))
    }
  }

  return (
    <Modal opened={opened} onClose={onClose} title="Benutzer verwalten" centered size="md">
      <Stack gap="sm">
        {listError && (
          <Alert color="red" variant="light" icon={<IconAlertCircle size={16} />}>{listError}</Alert>
        )}

        <Table striped highlightOnHover>
          <Table.Thead>
            <Table.Tr>
              <Table.Th>Benutzername</Table.Th>
              <Table.Th>Rolle</Table.Th>
              <Table.Th>Premium</Table.Th>
              <Table.Th />
            </Table.Tr>
          </Table.Thead>
          <Table.Tbody>
            {users.map((u) => (
              <Table.Tr key={u.id}>
                <Table.Td>{u.username}</Table.Td>
                <Table.Td>{u.role}</Table.Td>
                <Table.Td>{u.premium ? 'ja' : '–'}</Table.Td>
                <Table.Td>
                  <ActionIcon
                    variant="subtle"
                    color="red"
                    aria-label={`${u.username} löschen`}
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
                <Table.Td colSpan={4}><Text c="dimmed" size="sm">Keine Benutzer</Text></Table.Td>
              </Table.Tr>
            )}
          </Table.Tbody>
        </Table>

        <Text fw={600} size="sm" mt="sm">Benutzer hinzufügen / Passwort zurücksetzen</Text>
        <TextInput label="Benutzername" value={username} onChange={(e) => setUsername(e.currentTarget.value)} />
        <PasswordInput label="Passwort" value={password} onChange={(e) => setPassword(e.currentTarget.value)} />
        <Select
          label="Rolle"
          data={[{ value: 'admin', label: 'admin' }, { value: 'viewer', label: 'viewer' }]}
          value={role}
          onChange={(v) => setRole((v as 'admin' | 'viewer') ?? 'viewer')}
          comboboxProps={{ withinPortal: false }}
        />
        <Checkbox
          label="Premium-Zugang (ETL-Tasks)"
          checked={premium}
          onChange={(e) => setPremium(e.currentTarget.checked)}
        />
        {formError && (
          <Alert color="red" variant="light" icon={<IconAlertCircle size={16} />}>{formError}</Alert>
        )}

        <Group justify="flex-end">
          <Button variant="subtle" color="gray" onClick={onClose}>Schliessen</Button>
          <Button
            leftSection={<IconUserPlus size={16} />}
            loading={saving}
            disabled={!username.trim() || !password}
            onClick={addUser}
          >
            Speichern
          </Button>
        </Group>
      </Stack>
    </Modal>
  )
}
