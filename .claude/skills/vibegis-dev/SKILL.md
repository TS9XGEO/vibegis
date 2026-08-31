---
name: vibegis-dev
description: Start, restart and verify the VibeGIS docker stack (PostGIS, MapServer, QGIS Server, MapProxy, pg_featureserv, Dagster, upload-api, Vite frontend behind an nginx gateway). Use when asked to run, start, boot, or restart the app, when checking whether a change works in the real stack, or when diagnosing a blank globe, empty GetCapabilities, stale tiles or dead hot-reload.
---

# Running the VibeGIS stack

## Boot

```bash
cd /vibegis
docker compose up -d
docker compose ps          # everything should be Up; postgis must be (healthy)
```

`postgis` has a healthcheck and `mapserver`, `qgis-server`, `dagster`, `upload-api`
and `featureserv` all wait on it, so the first start takes ~30s. `gateway` comes up
last (it depends on `mapserver`, `qgis-server`, `frontend`, `upload-api`).

Then hand the user **http://localhost:8080/**. Visual confirmation is theirs — do not
drive a headless browser for it.

| | |
|---|---|
| App | http://localhost:8080/ |
| Dagster UI | http://localhost:3000/ |
| MapProxy demo | http://localhost:8080/tiles/demo/ |
| Features | http://localhost:8080/features/collections |
| pgAdmin | `--profile tools`, then http://localhost:5050/ |

## Smoke test without a browser

Real accounts now gate everything (see CLAUDE.md): mapserver/tiles/features/qgis/
terrain/3dtiles via nginx's `auth_request`, upload-api's own routes in-process. There
are no fixed credentials in `.env` — log in with a disposable account created for
this check:

```bash
cd /vibegis
PW=$(openssl rand -hex 12)
bash bin/add-user.sh smoketest "$PW" viewer
# Add `premium` as a 4th arg to test the ETL-trigger button's gating
# (admin or premium can launch /etl/run; a plain viewer gets 403).
JAR=$(mktemp)
curl -s -c "$JAR" -X POST http://localhost:8080/login \
  -H 'Content-Type: application/json' -d "{\"username\":\"smoketest\",\"password\":\"$PW\"}"

curl -s -b "$JAR" -o /dev/null -w "app %{http_code}\n"  http://localhost:8080/
curl -s -b "$JAR" "http://localhost:8080/mapserver?SERVICE=WMS&VERSION=1.3.0&REQUEST=GetCapabilities" | grep -o '<Name>[^<]*</Name>' | head
curl -s -b "$JAR" -o /dev/null -w "terrain %{http_code}\n" http://localhost:8080/terrain/layer.json
curl -s -b "$JAR" -o /dev/null -w "features %{http_code}\n" http://localhost:8080/features/collections
curl -s -b "$JAR" http://localhost:8080/health          # upload-api; mapfile_volume must be true
docker compose exec frontend npm run typecheck
```

No admin account yet? `bash bin/add-user.sh <user> <pass> admin` creates the first
one — needed once, ever, since the in-app "Benutzer verwalten" screen requires an
admin session to reach in the first place.

A `GetMap` is the real test of a PostGIS layer — capabilities only prove the mapfile
parsed, not that it can reach the database:

```bash
curl -s -b "$JAR" -o /dev/null -w "%{http_code}\n" "http://localhost:8080/mapserver?SERVICE=WMS&VERSION=1.3.0&REQUEST=GetMap&LAYERS=osm_landcover&STYLES=&CRS=EPSG:4326&BBOX=47.9,11.3,48.3,11.8&WIDTH=256&HEIGHT=256&FORMAT=image/png"
```

## One-shot jobs

```bash
docker compose --profile terrain run --rm ctb        # DEM at terrain/dem/dem.tif → terrain/tiles/
docker compose --profile tiles3d run --rm pg2b3dm    # gis.buildings3d → frontend-app/public/3dtiles/
docker compose --profile tools   up -d               # pgAdmin
```

## Symptom → cause

| Symptom | Look at |
|---|---|
| Globe blank, no layers in the panel | `GetCapabilities` failing. `docker compose logs mapserver` — usually a mapfile syntax error or PostGIS not healthy yet |
| `msLoadMap(): Unable to access file` while the mapfile plainly exists on the host | The bind mount went stale. `docker compose exec mapserver ls -la /etc/mapserver/` — if empty, `docker compose up -d --force-recreate mapserver`. A plain `restart` reuses the broken mount and will not help |
| Layer panel says "Kein &lt;Capability&gt;-Element gefunden" | MapServer returned an error page with HTTP 200. Open `/mapserver?SERVICE=WMS&REQUEST=GetCapabilities` directly and read it — the frontend now quotes the message, but the raw response is still fastest |
| Layer listed but tiles are blank/broken | `GetMap` returns a MapServer error image. Curl it (above) and read the body; typically a bad `DATA` clause or a missing `PGPASSWORD` |
| Edits to `src/` don't reload | HMR websocket. Check nginx passes `Upgrade`/`Connection` on `location /`, then set `VITE_USE_POLLING=1` in compose — inotify is unreliable on WSL bind mounts |
| Style change doesn't appear on a cached layer | MapProxy is serving old tiles: `docker compose down mapproxy && docker volume rm vibegis_mapproxy-cache && docker compose up -d mapproxy` |
| New layer missing from the cache | It has to be added to `mapproxy/mapproxy.yaml` and `HAND_AUTHORED_CACHED_LAYERS` in `frontend-app/src/wms.ts` — the mapfile alone isn't enough |
| Terrain toggle does nothing | `terrain/tiles/layer.json` missing — the bake hasn't run |
| `initdb` SQL changes had no effect | It only runs on a fresh volume. Requires `docker compose down -v`, which **deletes the database** — confirm with the user first |
| ETL job won't launch / Dagster workspace failing to load | `dagster` is unpinned (`dagster/requirements.txt`) — a version bump can silently break `dagster/defs/__init__.py` (this happened once: `ScheduleDefinition`'s `default_status_is_running` was removed upstream). Check via `curl -s -X POST http://localhost:3000/graphql -d '{"query":"{ workspaceOrError { __typename } }"}'` — a `PythonError` there means the defs module is broken, not that the trigger endpoint is. Fix the defs, then reload via Dagit's "Reload definitions" or the `reloadWorkspace` mutation, no restart needed |

## Never without asking

`docker compose down -v` and `docker volume rm webgis_postgis-data` destroy the
database. Uploaded layers live only there and in `mapserver/mapfiles/uploads.map`.
