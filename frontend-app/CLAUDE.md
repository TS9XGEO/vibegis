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
- **Never construct the Viewer without `contextOptions` from `webgl.ts`.** Cesium asks
  for a WebGL2 context by default and *throws* rather than falling back: it tests
  `typeof WebGL2RenderingContext !== "undefined"`, which is true in every current
  browser, then dies if `getContext("webgl2")` returns null. Firefox returns null
  whenever WebGL2 is off or the driver is blocklisted (`AllowWebgl2:false restricts
  context creation on this system`), so the globe silently failed to construct there
  while Chrome was fine. `webgl.ts` probes for real and sets `requestWebgl1` only when
  needed. Cesium's changelog claims an automatic fallback — it only covers browsers
  that don't define the constructor at all, which is not this case.
  On WebGL1, billboards and labels need `ANGLE_instanced_arrays`, and voxels are
  unavailable — neither is used here.
- **UI that needs the camera must render inside `<Scene>`** to use `useCesium()`.
  `LayerPanel` sits outside and reaches the camera through the store, which `Scene`
  stashes it in (`App.tsx:44`).
- **Never gate an existing control on a signal that can come back empty.** A layer
  uploaded from a file and one registered from an existing table are the same thing:
  both get a block in `uploads.map`, so both should offer delete, attribute table,
  filter and classification. `isManaged()` unions three signals and subtracts none —
  the `GROUP "uploads"` that capabilities carry (primary, travels with the layer),
  membership in upload-api's `/layers`, and the `upload_`/`dbtable_` name prefix as a
  floor. Deleting needs only the layer name, so it must keep working when upload-api
  is unreachable. Gating it on `/layers` alone once made a working delete button
  vanish silently. When `/layers` *is* down, the panel says so
  (`layersServiceDown`) instead of quietly rendering fewer buttons — a control that
  disappears without explanation is worse than one that errors when pressed. That flag
  also trips when `/layers` answers 200 with an *empty* list while capabilities show
  layers in the uploads group: the mismatch proves a fault, and it is exactly how a
  stale bind mount presents.
- **A layer's source table arrives in capabilities.** upload-api writes
  `"ows_keywordlist" "source:<schema>.<table>,geomtype:<kind>"` into every block it
  generates, MapServer publishes it as `<KeywordList>`, and `flattenLeaves()` lifts it
  into `LayerState.source` / `.geomType`. So the attribute table resolves its
  collection with no second request and keeps working when upload-api is down. Filter
  and classification cannot — they need `/distinct-values`, `/column-stats` and
  `/layer-config`, which only upload-api serves.
- **A user classification only exists in `layer_config.json`.** The mapfile still holds
  the single default `CLASS` the layer was created with, so the classification reaches
  the map only as an `SLD_BODY` on the GetMap request. `Scene.tsx` must therefore treat
  a saved classification as a trigger for building the SLD, alongside colour overrides
  and attribute filters — `departsFromMapfile`. Omitting it made a saved classification
  do nothing on its own, then appear the moment a filter or recolor was added and
  vanish again when it was removed, which reads as three unrelated bugs.
  MapServer rejects `FILTER` together with `SLD_BODY`, so when an SLD is in play the
  filter is spliced into every Rule by `filterFor()` instead of being sent separately.
- **The layer list comes from GetCapabilities**, never a hardcoded list. Add a `LAYER`
  to the mapfile and it appears on reload. Per-layer extras live in module-level maps
  in `wms.ts`: `CACHED_LAYERS` (which layers go through MapProxy),
  `FEATURE_COLLECTIONS` (WMS layer → OGC API collection), `MANAGED_GROUP`.
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
