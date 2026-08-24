# WebGIS

Docker stack serving a 3D map: PostGIS → MapServer/QGIS Server → nginx gateway →
React + Cesium frontend. Everything runs in containers; there is nothing to install
on the host. Keep this folder inside WSL — bind mounts across `/mnt/c` are slow
enough to hurt PostGIS.

## Request path

Everything reaches the browser through nginx on `:8080`, one origin, no CORS.

```
:8080/            → frontend      Vite dev server (React, Resium, Mantine)
     /mapserver   → mapserver     WMS/WMTS/OGC-API, live render from PostGIS
     /tiles/      → mapproxy      same layer names, served from disk cache
     /features    → featureserv   OGC API Features (GeoJSON); powers the search box
     /qgis        → qgis-server   ?MAP=/io/data/<project>.qgs
     /terrain/    → static        baked quantized-mesh from terrain/tiles/
     /3dtiles/    → static        frontend-app/public/3dtiles/
     /upload /tables /layers /layer-config /distinct-values /column-stats
                  → upload-api    file → PostGIS table → LAYER block (see upload-api/)
```

Dagster (`:3000`, ETL assets) and PostGIS (`:5432`) bind to `127.0.0.1` only.

## Edit X → do Y

| Edited | To see it |
|---|---|
| `frontend-app/src/**` | nothing, Vite HMR. Not picked up? set `VITE_USE_POLLING=1` |
| `mapserver/mapfiles/*.map` | nothing — MapServer re-reads the mapfile per request. If a change won't show, `restart mapserver` |
| `mapproxy/mapproxy.yaml` | `restart mapproxy`; if styling changed, also `docker volume rm webgis_mapproxy-cache` or tiles stay stale |
| `nginx/nginx.conf` | `restart gateway` |
| `upload-api/app.py` | `restart upload-api` — uvicorn runs without `--reload` |
| `dagster/defs/**` | "Reload definitions" in the Dagster UI |
| `docker-compose.yml`, `.env` | `docker compose up -d` |
| `postgis/initdb/*.sql` | only ever runs on a **fresh** volume, i.e. after `down -v` |

Adding a layer to the mapfile does **not** add it to the cache — add it to
`mapproxy/mapproxy.yaml` too, and to `CACHED_LAYERS` in `frontend-app/src/wms.ts`.

## Commands

```bash
docker compose up -d
docker compose exec frontend npm run typecheck   # the only check that exists: no tests, no linter
docker compose exec postgis psql -U gis -d gis
docker compose logs -f mapserver
docker compose --profile terrain run --rm ctb    # bake terrain from terrain/dem/dem.tif
docker compose --profile tiles3d run --rm pg2b3dm
docker compose down        # keep data   |   down -v = DELETE the database
```

## Things that will bite you

- **No password in the mapfiles.** `CONNECTION` deliberately omits `password=`; libpq
  takes it from `PGPASSWORD`, which compose sets on the container. The mapfiles are in
  git — never paste a password back in.
- **Draw order is state, not imperative calls.** The zustand store in
  `frontend-app/src/wms.ts` holds `layers[]` top-first and `Scene` renders it reversed.
  There is no `raiseToTop` anywhere and there should not be.
- **`APACHE_LIMIT_REQUEST_LINE` is 2 MB on purpose** (`docker-compose.yml:64`). A
  `GetMap` carrying an `SLD_BODY` for a many-class classification is enormous; the
  default 8190 and even 65536 truncate it.
- **`mapserver/mapfiles/uploads.map` and `layer_config.json` are machine-written** by
  upload-api at runtime. A dirty diff there is normal, not a bug to fix. Don't
  hand-edit while the stack is up.
- **Visual checks belong to Thomas.** For anything that has to be *looked at*, hand
  over http://localhost:8080/ rather than driving a headless browser.

Deeper notes load with the directory: `frontend-app/CLAUDE.md`, `upload-api/CLAUDE.md`,
`mapserver/CLAUDE.md`. Onboarding and first-run live in `README.md`;
`docs/classification.md` covers where a classification rule belongs.
