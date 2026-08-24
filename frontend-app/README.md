# WebGIS Frontend (React + TypeScript + Resium + Mantine)

Runs as its own container with hot module reload.

## Start

```bash
cd /webgis
docker compose up -d --build frontend
docker compose logs -f frontend      # wait for "ready in ... ms"
```

Then open **http://localhost:8080/**. Vite's own port is not published — the
container only `expose`s 5173 on the internal network and the nginx gateway proxies
to it, so `localhost:5173` will not answer.

Edit anything under `frontend-app/src/` and the browser updates within a
second. No copying files, no hard refresh.

## How the pieces fit

`CLAUDE.md` in this directory has the full module map. The short version:

```
src/
  main.tsx        Mantine provider, dark theme, mounts App
  App.tsx         composes Scene + LayerPanel
  Scene.tsx       the Cesium globe (Resium components)
  LayerPanel.tsx  layer tree, opacity, drag-to-reorder, terrain/3D toggles
  wms.ts          capabilities parsing, endpoint URLs, the zustand store
  legend.ts       legend types and SLD generation
```

**Draw order is state, not imperative calls.** The store holds `layers[]`
top-first. `Scene` renders them reversed, because Cesium draws the last-added
imagery layer on top. Dragging a row reorders the array and React does the
rest — there is no `raiseToTop` anywhere. That is the whole reason for moving
to a framework: the ordering bug that plagued the vanilla version cannot be
expressed here.

**The layer list still comes from GetCapabilities.** Add a `LAYER` to
`webgis.map`, restart MapServer, reload — it appears.

## Requests

Vite proxies `/mapserver`, `/qgis`, `/terrain` and `/3dtiles` to the `gateway`
container, so the browser sees one origin and there is no CORS setup. Same
shape as production.

## Production build

```bash
docker compose exec frontend npm run build
```

Output lands in `frontend-app/dist/`. Point nginx at it when you want to stop
running the dev server.

## If npm install fails on peer dependencies

The versions in `package.json` are ranges, not pins. If a resolution conflict
appears:

```bash
docker compose exec frontend npm install --legacy-peer-deps
```

or bump the offending package and rebuild:

```bash
docker compose build --no-cache frontend
```

## Typecheck

```bash
docker compose exec frontend npm run typecheck
```
