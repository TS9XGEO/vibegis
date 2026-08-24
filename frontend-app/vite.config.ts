import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import cesium from 'vite-plugin-cesium'

// The app is served by Vite on :5173 during development. All OGC endpoints are
// proxied to the nginx gateway container so the browser sees a single origin
// and there is no CORS to configure — same arrangement as production.
export default defineConfig({
  plugins: [react(), cesium()],
  server: {
    host: '0.0.0.0',
    port: 5173,
    strictPort: true,
    // The app is reached through nginx on :8080, so the HMR websocket must be
    // told to connect there rather than to Vite's own port.
    hmr: {
      clientPort: Number(process.env.VITE_HMR_PORT ?? 8080),
    },
    watch: {
      // bind mounts from WSL do not always deliver inotify events reliably
      usePolling: process.env.VITE_USE_POLLING === '1',
      interval: 300,
    },
    proxy: {
      '/mapserver': { target: 'http://gateway', changeOrigin: true },
      '/tiles':     { target: 'http://gateway', changeOrigin: true },
      '/features':  { target: 'http://gateway', changeOrigin: true },
      '/qgis':      { target: 'http://gateway', changeOrigin: true },
      '/terrain':   { target: 'http://gateway', changeOrigin: true },
      '/3dtiles':   { target: 'http://gateway', changeOrigin: true },
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: true,
  },
})
