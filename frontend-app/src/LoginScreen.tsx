import { useState } from 'react'
import {
  Alert, Box, Button, Group, Paper, PasswordInput, Stack, Text, TextInput, Title, useComputedColorScheme,
} from '@mantine/core'
import { IconAlertCircle } from '@tabler/icons-react'
import { useTranslation } from 'react-i18next'

import { useAuth } from './auth'
import ConnectedGlobe from './ConnectedGlobe'
import LoginTip from './LoginTip'
import { AUTH_FONT, authAccent, authBorder, authGlow, authGradient, authGradientColors, authTextGlow } from './colorScheme'

export default function LoginScreen() {
  const { t } = useTranslation()
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
          position: 'relative',
          zIndex: 1,
          width: '100%',
          height: '100%',
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          gap: 16,
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
              {t('login.heading')}
            </Text>
          </Stack>
          <Stack gap="sm">
            <TextInput
              label={t('login.username')}
              value={username}
              onChange={(e) => setUsername(e.currentTarget.value)}
              onKeyDown={(e) => e.key === 'Enter' && submit()}
              autoFocus
            />
            <PasswordInput
              label={t('login.password')}
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
              {t('login.submit')}
            </Button>
          </Stack>
        </Paper>

        <LoginTip />
      </Box>
    </Box>
  )
}
