/**
 * Full-screen splash bookending a session — a welcome after login, a goodbye
 * after logout. Purely cosmetic (App.tsx decides when to show it) and
 * auto-dismisses itself via onDone after `duration`.
 */
import { useEffect } from 'react'
import { Box, Text, Title, useComputedColorScheme } from '@mantine/core'

import { AUTH_FONT, authAccent, authGradient, authGrid, authTextGlow } from './colorScheme'

export default function AuthSplash({
  icon,
  title,
  subtitle,
  duration = 1400,
  onDone,
}: {
  icon: React.ReactNode
  title: string
  subtitle: string
  duration?: number
  onDone: () => void
}) {
  const scheme = useComputedColorScheme('dark')

  useEffect(() => {
    const t = setTimeout(onDone, duration)
    return () => clearTimeout(t)
  }, [onDone, duration])

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
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          gap: 16,
        }}
      >
        <div
          style={{
            color: authAccent(scheme),
            filter: `drop-shadow(0 0 6px ${authAccent(scheme)}90)`,
            animation: 'authPop 0.6s ease',
          }}
        >
          {icon}
        </div>
        <div style={{ textAlign: 'center', animation: 'authFadeUp 0.6s ease 0.15s both' }}>
          <Title
            order={2}
            style={{ fontFamily: AUTH_FONT, letterSpacing: 1, textShadow: authTextGlow(scheme) }}
          >
            {title}
          </Title>
          <Text c="dimmed" size="sm" mt={4}>{subtitle}</Text>
        </div>
      </Box>
    </Box>
  )
}
