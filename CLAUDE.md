# VibeGIS

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
     /upload /upload-raster /upload-raster-zip /raster-composite /tables /layers
     /layer-config /distinct-values /column-stats /register-table /geoprocess
     /login /logout /auth/me /users /etl/
                  → upload-api    file → PostGIS table → LAYER block (see upload-api/);
                                  /upload-raster instead publishes a GeoTIFF as a
                                  TYPE RASTER layer, no PostGIS table involved;
                                  /upload-raster-zip unzips a multi-band raster
                                  (e.g. a Sentinel-2 product) and publishes every band
                                  as its own layer immediately; /raster-composite then
                                  combines three published single-band raster layers
                                  into one RGB layer on the fly (a VRT, not a new
                                  reprojection pass), picked from the layer panel;
                                  also login/session/account-management routes,
                                  /etl/run (admin/premium-gated Dagster trigger, see below),
                                  and /geoprocess (admin-only buffer/dissolve/intersect/join).
                                  /auth/verify is nginx-internal only (auth_request target)
```

Dagster (`:3000`, ETL assets) and PostGIS (`:5432`) bind to `127.0.0.1` only.

## Edit X → do Y

| Edited | To see it |
|---|---|
| `frontend-app/src/**` | nothing, Vite HMR. Not picked up? set `VITE_USE_POLLING=1` |
| `mapserver/mapfiles/*.map` | nothing — MapServer re-reads the mapfile per request. If a change won't show, `up -d --force-recreate mapserver` (see stale mounts below) |
| `mapproxy/mapproxy.yaml` | nothing — MapProxy's reloader watches the file's mtime. Machine-written by upload-api now (see below); a hand edit works but is overwritten on the next layer change |
| `nginx/nginx.conf` | `restart gateway` |
| `upload-api/app.py` | `up -d --build upload-api` — it's `build:`-based, not bind-mounted, so a plain `restart` keeps running the old image and silently ignores the edit |
| `dagster/defs/**` | "Reload definitions" in the Dagster UI |
| `docker-compose.yml`, `.env` | `docker compose up -d` |
| `postgis/initdb/*.sql` | only ever runs on a **fresh** volume, i.e. after `down -v` |
| `.env` (`AUTH_JWT_SECRET`) | `docker compose up -d` (recreates upload-api) — invalidates every existing session immediately |

A layer created through upload-api (`uploads.map`) is cached automatically — its
`generate_mapproxy_config()` gives every such layer its own entry in
`mapproxy/mapproxy.yaml`, machine-written like `uploads.map` and `layer_config.json`
(dirty diffs there are expected). A layer added by hand to `vibegis.map`/
`osm-layers.map` still needs manual wiring: add it to `mapproxy/mapproxy.yaml` and to
`HAND_AUTHORED_CACHED_LAYERS` in `frontend-app/src/wms.ts`.

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
  classification no longer needs an `SLD_BODY` at all (it's compiled into the mapfile
  — see `frontend-app/CLAUDE.md`), but an attribute filter still does, and a `GetMap`
  carrying one for a many-class layer is enormous; the default 8190 and even 65536
  truncate it.
- **`mapserver/mapfiles/uploads.map`, `layer_config.json`, and `mapproxy/mapproxy.yaml`
  are machine-written** by upload-api at runtime. A dirty diff there is normal, not a
  bug to fix. Don't hand-edit while the stack is up.
- **Bind mounts go stale on this setup, and `restart` will not fix it.** Docker
  resolves a bind mount when the container is *created*, so a mount can end up
  pointing at nothing while `docker inspect` still reports the correct `Source`. The
  giveaway is a container that cannot see files that plainly exist on the host —
  e.g. `msLoadMap(): Unable to access file (/etc/mapserver/vibegis.map)` with the
  mapfile sitting right there, 644. Confirm with
  `docker compose exec <svc> ls -la <mountpoint>`; if it is empty,
  `docker compose up -d --force-recreate <svc>`. Only if that fails is it the sharing
  layer itself: `wsl --shutdown`, then restart Docker Desktop.
- **Every upload-api route needs its own nginx `location`.** The gateway proxies them
  one by one; anything unlisted falls through to `/` and returns the React
  `index.html`, so a missing route looks like a *successful* HTML response rather than
  a 404. `/health` was unreachable for exactly this reason.
- **Visual checks belong to Thomas.** For anything that has to be *looked at*, hand
  over http://localhost:8080/ rather than driving a headless browser.
- **Real accounts, JWT-in-a-cookie, admin vs viewer vs premium.** `users` (username,
  bcrypt password hash, role, `premium` boolean) lives in Postgres, created by
  upload-api on startup — not via `postgis/initdb`, since that only runs on a fresh
  volume and this DB already has data. `premium` is additive to `role`, not a third
  role value: an admin never loses anything a premium grant would add, and "viewer +
  premium" is a real, intended combination. `POST /login` issues an httpOnly
  `vibegis_session` cookie (10h, signed with `AUTH_JWT_SECRET`) carrying `role` and
  `premium`; there is no server-side revocation, so a leaked cookie — or a role/premium
  change made after it was issued — stays as it was until the cookie expires.
  `require_login`/`require_role("admin")`/`require_etl_access` (admin or premium) in
  `upload-api/app.py` gate its own routes in-process; mapserver, mapproxy,
  pg_featureserv and qgis-server have no app code of their own, so nginx gates them
  instead via `auth_request` against upload-api's `/auth/verify`. `/` is deliberately
  ungated — the SPA shell has to load unauthenticated so the login screen can render.
  First-time setup (and only then): `bash bin/add-user.sh <user> <pass> admin` to
  create the first admin, since the in-app "Benutzer verwalten" screen needs an
  admin session to reach in the first place. The same script takes an optional 4th
  `premium` argument for creating a premium test account.
- **`dagster` is an unpinned dependency** (`dagster/requirements.txt`) — a routine
  image rebuild can pull a newer Dagster that silently breaks `dagster/defs/__init__.py`
  on the next reload. It already happened once this way: `ScheduleDefinition`'s
  `default_status_is_running` argument was removed upstream in favor of
  `default_status=DefaultScheduleStatus.STOPPED`, and the failure only showed up as
  the whole workspace refusing to load (every asset/job gone, not just the schedule).
  Reload via Dagit's "Reload definitions" button, or the `reloadWorkspace` GraphQL
  mutation against `http://localhost:3000/graphql` — either picks up a fix immediately,
  no container restart needed.
- **Flex children need explicit `minWidth: 0` / `minHeight: 0`** wherever wide or tall
  content (an attribute table, the map itself) sits inside one of this app's flex
  layouts. Without it, a flex item's default automatic minimum size is its content's
  *natural* size, and the browser refuses to shrink it below that no matter what the
  surrounding flexbox math says — a wide attribute table once forced its whole column
  wider than intended, which pushed the docked layer panel completely off the visible
  viewport (clipped invisible by `index.html`'s `overflow: hidden` on `#root`, not
  removed — easy to mistake for a state bug instead of a layout one).

## Ideas not yet built

The geoprocessing panel (buffer/dissolve/intersect/join — `POST /geoprocess`,
see `upload-api/CLAUDE.md`, frontend in `Geoprocessing.tsx`), raster
ingestion (`POST /upload-raster`, see `upload-api/CLAUDE.md`, frontend in
`UploadLayer.tsx`'s raster mode), and point clustering (a per-layer toggle in
`LayerPanel.tsx`, see `frontend-app/CLAUDE.md`'s `PointCluster.tsx` entry)
have all since shipped; these were discussed at the same time and are still
deliberately deferred:

- **A selection-driven dashboard.** Counts, sums and simple charts computed
  over whatever `useSelection`'s current selection holds, reusing the
  multi-layer, layer-tagged selection system already built.

Deeper notes load with the directory: `frontend-app/CLAUDE.md`, `upload-api/CLAUDE.md`,
`mapserver/CLAUDE.md`. Onboarding and first-run live in `README.md`;
`docs/classification.md` covers where a classification rule belongs.
