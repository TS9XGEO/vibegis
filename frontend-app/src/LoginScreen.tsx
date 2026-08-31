import { useState } from 'react'
import {
  Alert, Box, Button, Group, Paper, PasswordInput, Stack, Text, TextInput, Title, useComputedColorScheme,
} from '@mantine/core'
import { IconAlertCircle } from '@tabler/icons-react'

import { useAuth } from './auth'
import ConnectedGlobe from './ConnectedGlobe'
import { AUTH_FONT, authAccent, authBorder, authGlow, authGradient, authGradientColors, authGrid, authTextGlow } from './colorScheme'

export default function LoginScreen() {
  const login = useAuth((s) => s.login)
  const error = useAuth((s) => s.error)
  const scheme = useComputedColorScheme('dark')
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [loading, setLoading] = useState(false)

  async function submit() {
    if (!username || !password) return
    setLoading(true)
    try {
      await login(username, password)
    } finally {
      setLoading(false)
    }
  }

  return (
    <Box
      style={{
        position: 'relative',
        width: '100%',
        height: '100%',
        overflow: 'hidden',
        background: authGradient(scheme),
        backgroundSize: '200% 200%',
        animation: 'authGradientShift 8s ease infinite',
      }}
    >
      <Box
        style={{
          position: 'absolute',
          inset: 0,
          backgroundImage: authGrid(scheme),
          backgroundSize: '42px 42px',
          animation: 'authGridDrift 6s linear infinite',
          pointerEvents: 'none',
        }}
      />

      <Box
        style={{
          position: 'relative',
          zIndex: 1,
          width: '100%',
          height: '100%',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        <Paper
          radius="md"
          p="xl"
          withBorder
          style={{
            width: 340,
            animation: 'authFadeUp 0.5s ease',
            boxShadow: authGlow(scheme),
            borderColor: authBorder(scheme),
          }}
        >
          <Stack gap={2} align="center" mb="sm">
            <Group gap={8} style={{ animation: 'authPop 0.6s ease' }}>
              <span style={{ color: authAccent(scheme), display: 'flex' }}>
                <ConnectedGlobe size={28} />
              </span>
              <Title order={3} style={{ fontFamily: AUTH_FONT, letterSpacing: 1, textShadow: authTextGlow(scheme) }}>
                VIBEGIS
              </Title>
            </Group>
            <Text size="xs" c="dimmed" style={{ fontFamily: AUTH_FONT, letterSpacing: 2 }}>
              ANMELDUNG
            </Text>
          </Stack>
          <Stack gap="sm">
            <TextInput
              label="Benutzername"
              value={username}
              onChange={(e) => setUsername(e.currentTarget.value)}
              onKeyDown={(e) => e.key === 'Enter' && submit()}
              autoFocus
            />
            <PasswordInput
              label="Passwort"
              value={password}
              onChange={(e) => setPassword(e.currentTarget.value)}
              onKeyDown={(e) => e.key === 'Enter' && submit()}
            />
            {error && (
              <Alert color="red" variant="light" icon={<IconAlertCircle size={16} />}>{error}</Alert>
            )}
            <Button
              variant="gradient"
              gradient={{ ...authGradientColors(scheme), deg: 45 }}
              loading={loading}
              disabled={!username || !password}
              onClick={submit}
              fullWidth
            >
              Anmelden
            </Button>
          </Stack>
        </Paper>
      </Box>
    </Box>
  )
}
