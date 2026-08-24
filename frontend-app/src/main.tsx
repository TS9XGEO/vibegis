import React from 'react'
import ReactDOM from 'react-dom/client'
import { MantineProvider, createTheme } from '@mantine/core'
import '@mantine/core/styles.css'
import 'cesium/Build/Cesium/Widgets/widgets.css'

import App from './App'

const theme = createTheme({
  primaryColor: 'blue',
  fontFamily: 'system-ui, -apple-system, Segoe UI, sans-serif',
  defaultRadius: 'md',
})

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <MantineProvider theme={theme} defaultColorScheme="dark" forceColorScheme="dark">
      <App />
    </MantineProvider>
  </React.StrictMode>,
)
