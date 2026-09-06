import React, { useMemo } from 'react'
import ReactDOM from 'react-dom/client'
import { MantineProvider, createTheme } from '@mantine/core'
import { Notifications } from '@mantine/notifications'
import '@mantine/core/styles.css'
import '@mantine/notifications/styles.css'
import '@mantine/charts/styles.css'
import 'cesium/Build/Cesium/Widgets/widgets.css'
import './i18n'

import App from './App'
import { UI_SCALE_FACTORS, useUiScale } from './uiScale'

const BASE_THEME = {
  primaryColor: 'teal',
  fontFamily: 'system-ui, -apple-system, Segoe UI, sans-serif',
  defaultRadius: 'md',
}

/**
 * Rebuilds the theme whenever the sideband's display-size picker changes
 * (uiScale.ts). `scale` is Mantine's own knob: every size it emits is
 * `calc(Xrem * var(--mantine-scale))`, so this one number moves all of them
 * together, portals included. Re-rendering the whole tree on a change is fine
 * — it happens only when someone deliberately picks a different size.
 */
function Root() {
  const factor = useUiScale((s) => UI_SCALE_FACTORS[s.scale])
  const theme = useMemo(() => createTheme({ ...BASE_THEME, scale: factor }), [factor])
  return (
    <MantineProvider theme={theme} defaultColorScheme="dark">
      <Notifications position="bottom-right" />
      <App />
    </MantineProvider>
  )
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <Root />
  </React.StrictMode>,
)
