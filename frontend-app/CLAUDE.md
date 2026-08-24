# frontend-app

React 18 + TypeScript + Resium (Cesium) + Mantine, served by Vite. No tests and no
linter — `npm run typecheck` is the whole safety net.

## Modules

```
main.tsx            Mantine provider, dark theme
App.tsx        49   composes Scene + LayerPanel; UI inside <Scene> can use useCesium()
Scene.tsx     205   the globe: imagery layers, terrain, 3D tiles
wms.ts        498   ★ zustand store `useApp`, GetCapabilities parsing, all endpoint URLs
LayerPanel.tsx 464  layer tree, opacity, dnd-kit reordering, terrain/3D toggles
ClassifyLayer.tsx 415  categorized + graduated classification editor
legend.ts     359   ★ legend types and `buildSld()` — SLD generation lives here
MapTools.tsx  359   search, identify, measure (uses /features)
UploadLayer.tsx 230 file upload + registering an existing PostGIS table
AttributeFilter.tsx 208 / filter.ts 77   OGC Filter XML builder
AttributeTable.tsx 168 / columns.ts 64   attribute grid
tools.ts      168   `useTools` store: search hits, identify, measure modes
Legend.tsx 94  ZoomBar.tsx 65  StatusHud.tsx 62
```

★ = start here. `wms.ts` and `legend.ts` hold the contracts everything else consumes.

## Rules that are load-bearing

- **Draw order is array order.** The store keeps `layers[]` top-first; `Scene` renders
  it reversed because Cesium draws the last-added imagery layer on top. Reordering a
  row reorders the array, and React does the rest. Never reach for `raiseToTop`.
- **`terrainProvider` goes on `<Globe>`, not `<Viewer>`.** Resium applies Viewer's only
  once at construction; Globe's has a working setter (`Scene.tsx:168`).
- **UI that needs the camera must render inside `<Scene>`** to use `useCesium()`.
  `LayerPanel` sits outside and reaches the camera through the store, which `Scene`
  stashes it in (`App.tsx:44`).
- **The layer list comes from GetCapabilities**, never a hardcoded list. Add a `LAYER`
  to the mapfile and it appears on reload. Per-layer extras live in module-level maps
  in `wms.ts`: `CACHED_LAYERS` (which layers go through MapProxy),
  `FEATURE_COLLECTIONS` (WMS layer → OGC API collection), `isDeletable()`.
- UI strings are German. Match that when adding any.

## Requests

Vite proxies `/mapserver`, `/tiles`, `/features`, `/qgis`, `/terrain`, `/3dtiles` to
the `gateway` container (`vite.config.ts`), so the browser sees a single origin — the
same shape as production. HMR websocket is told to use `VITE_HMR_PORT` (8080), because
the app is reached through nginx, not Vite's own port.

## Commands

```bash
docker compose exec frontend npm run typecheck
docker compose exec frontend npm run build          # → dist/
docker compose build --no-cache frontend            # after changing package.json
```

Dependencies are ranges, not pins. On a peer-dependency conflict:
`docker compose exec frontend npm install --legacy-peer-deps`.
