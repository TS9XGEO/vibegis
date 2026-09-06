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
     /qgis        → qgis-server   ?MAP=/io/data/<project>.qgs (hand-authored projects;
                                  generated print projects live in the qgis-projects
                                  volume at /io/generated, see below)
     /qgis-process/ /qgis-print
                  → upload-api    QGIS algorithms and PDF map export, both premium.
                                  /qgis-process/algorithms is the curated catalog
                                  (?advanced=true adds the full introspected one),
                                  POST /qgis-process/run starts a job and
                                  GET /qgis-process/run/<id> polls it; /qgis-print
                                  streams a GetPrint PDF back. NOTE these are
                                  upload-api routes despite the /qgis prefix —
                                  see "Things that will bite you"
     /terrain/    → static        baked quantized-mesh from terrain/tiles/
     /3dtiles/    → static        frontend-app/public/3dtiles/
     /pointclouds/→ static        published point-cloud tilesets from pointclouds/
     /upload /upload-raster /upload-raster-zip /upload-pointcloud
     /raster-composite /tables /layers
     /layer-config /distinct-values /column-stats /register-table /geoprocess
     /login /logout /auth/me /users /etl/ /cms /guest-session /register
     /subscription/ /paypal/webhook /groups /layer-grants
                  → upload-api    file → PostGIS table → LAYER block (see upload-api/);
                                  /upload-raster instead publishes a GeoTIFF as a
                                  TYPE RASTER layer, no PostGIS table involved;
                                  /upload-raster-zip unzips a multi-band raster
                                  (e.g. a Sentinel-2 product) and publishes every band
                                  as its own layer immediately; /raster-composite then
                                  combines three published single-band raster layers
                                  into one RGB layer on the fly (a VRT, not a new
                                  reprojection pass), picked from the layer panel;
                                  /upload-pointcloud converts a LAS/LAZ scan to Cesium
                                  3D Tiles (py3dtiles) — no PostGIS table AND no
                                  MapServer layer, see the bullet below;
                                  also login/session/account-management routes,
                                  /etl/run (pro+ Dagster trigger, see below),
                                  and /geoprocess (pro+ buffer/dissolve/intersect/join).
                                  /auth/verify is nginx-internal only (auth_request target).
                                  /cms serves an admin-managed set of named content
                                  pages (configdb.pages — the in-app Handbook is just
                                  one page, "handbook", not special beyond being the
                                  one a fresh install seeds) — see "Three Postgres
                                  schemas" below. /guest-session, /register,
                                  /subscription/*, /paypal/webhook, /groups and
                                  /layer-grants are the tiers/guest/billing system —
                                  see "Roles, tiers, guests and billing" below
```

Dagster (`:3000`, ETL assets), PostGIS (`:5432`) and Grafana (`:3001`, log viewer —
see "Logging" below) bind to `127.0.0.1` only.

## Three Postgres schemas

`dwh` (all geodata — uploaded/registered/geoprocessed tables, what Dagster's
`raw_vectors` asset writes into), `configdb` (`layer_config` — per-layer
classification state, replacing what used to be `layer_config.json`; `pages` —
any number of named, admin-editable content pages, DE/EN each, reachable in the app
via Sideband's content button — `Pages.tsx`; the in-app Handbook is just the one page,
`handbook`, every fresh install is seeded with; `layer_owners`, `groups`,
`group_members`, `layer_grants` — the per-user/group ACL, see below; `qgis_jobs` — one
row per QGIS processing run, see below), `userdb`
(`users`: accounts, `subscription_tier` — replacing what used to be a plain `premium`
boolean — plus the AI agent's encrypted BYO-key columns; `subscriptions`: PayPal
billing history). One-time migrations from the old `raw`/`staging`/`gis` layout and
the old `premium` boolean: `bin/migrate-schemas.sql`, `bin/migrate-tiers.sql`.
`postgis/initdb/*.sql` creates the new layout directly, so these only matter on an
existing volume. `ai_agent.py`'s `AI_READABLE_SCHEMAS` deliberately excludes
`userdb` — the read-only AI role never has that schema granted at all, rather than a
schema-wide grant with one table revoked back out.

## Roles, tiers, guests and billing

Two orthogonal axes on `userdb.users`: `role` (`admin`/`editor`/`viewer`) and
`subscription_tier` (`free`/`pro`/`premium`, ranked in `upload-api/app.py`'s
`TIER_RANK` — `require_tier(min)` is the gate, `require_etl_access` is now just
`require_tier("premium")` by another name). Premium now covers three things:
the Dagster ETL trigger, the AI agent, and the QGIS features (`/qgis-process/*`
algorithms and `/qgis-print` PDF export). **Guest is not a tier value on a user
row** — `POST /guest-session` issues a JWT with a synthetic identity and
`tier: "guest"` baked in directly, no `userdb.users` row at all; every tier check
treats `guest` as the floor, below `free`.

**`editor` is full analysis/editing capability without a subscription** —
`is_privileged_role()` (`app.py`) treats admin and editor identically everywhere
*except* the strictly-admin-only routes: both bypass `require_tier()` (any tier gate,
same as admin), `require_owner_or_admin()` (edit/delete any layer, not just owned),
and `visible_layers_for()` (see everything, no grant needed). What editor does
**not** get is `role == "admin"` itself — `/users`, `/groups` and `/layer-grants`
check that literally, so editor is blocked from account and privilege management by
construction, not by a separate check that could drift out of sync. Frontend mirrors
this exactly: `auth.ts`'s `isPrivileged()`/`hasFullAccess()` for the feature gates
(Dashboard, Upload, Geoprocessing, ETL, AI — same "visible but disabled, upsell
tooltip" pattern throughout `Sideband.tsx`/`LayerPanel.tsx`), plain
`role === 'admin'` for the two admin-only screens (`UserAdmin.tsx`, `AccessAdmin.tsx`).
CMS write routes (`POST`/`PATCH`/`DELETE /cms`) use the softer `require_privileged`
(admin or editor) instead of `require_role("admin")` — content editing, not
user/privilege management, so editor keeps that.

**Per-layer visibility is a separate concern from tier**, chosen deliberately over
"tier N sees layer set N": `visible_layers_for()` in `app.py` — admin sees
everything; a guest session sees only what's granted to the implicit `guests` group
(seeded by `ensure_users_table()`); everyone else sees what's granted to their user id
or to any group they belong to, unioned with whatever they *own*
(`configdb.layer_owners`, written by `record_layer_owner()` at the tail of every
publish path — a Pro user has to see a layer the moment they publish it, not only
once an admin grants it back). Managed from the app itself via `AccessAdmin.tsx`
(admin-only, `/groups` + `/layer-grants`).

**The one enforcement gap, on purpose, documented rather than silently left**:
`visible_layers_for()` controls what `/layers` *offers* — the layer panel, search,
attribute table entry points. It does not touch `/mapserver`/`/tiles/`/`/features`
themselves — `nginx.conf`'s `auth_request` only checks "is there a valid session," and
MapServer has no per-user concept at all. A logged-in user who already knows or
guesses another private layer's exact name can still fetch its tiles directly. Closing
this for real means turning those three routes into an authorizing proxy through
upload-api instead of nginx routing straight to `mapserver`/`mapproxy`/`featureserv` —
real added latency and complexity, deliberately not built yet.

**"Editing own data" (Pro)**: `require_owner_or_admin()` — admin always passes;
anyone else must both meet the route's tier gate *and* own the specific layer
(`configdb.layer_owners`). Used by `PATCH`/`DELETE /layer-config` and
`DELETE /layers`.

**Self-service signup and PayPal** (`upload-api/paypal.py`, sandbox/test mode — see
`.env.example`'s `PAYPAL_*` vars and `bin/paypal-seed.sh`, run once by hand): `POST
/register` always creates a `viewer` account; `free` activates immediately, `pro`/
`premium` stay `free` in enforcement terms until `POST /paypal/webhook` (signature-
verified via PayPal's own endpoint, never trusted on the redirect alone) confirms the
subscription actually activated — nothing paid is ever granted on the client's own
say-so, and a PayPal failure during signup rolls the just-created account back rather
than leaving it stranded on `free`. `POST /subscription/upgrade` is the same flow for
an *existing* account (the recurring upsell nag's call-to-action —
`frontend-app/src/upsell/`); `POST /subscription/cancel` asks PayPal to cancel, same
"webhook is the only path that changes tier" rule.

## Localization (DE/EN)

`react-i18next`, one file: `frontend-app/src/i18n/translations.ts` holds every UI
string, keyed and namespaced, `{ de, en }` side by side — no per-locale file split,
no per-component fragments. `frontend-app/src/i18n/index.ts` reshapes it into
i18next's resources at startup. A language toggle lives in `Sideband.tsx`, persisted
to `localStorage` (a deliberate, called-out exception to the "ephemeral session
state, never persisted" rule below — a language choice is a standing preference, not
layout state — `frontend-app/src/uiScale.ts`'s Klein/Standard/Groß display-size
picker, next to it in the band, is the only other one). Converting a component: add
its strings to `translations.ts`, replace the literal with `t('namespace.key')`. Most of the app (LayerPanel, SelectionDashboard,
ClassifyLayer, AttributeTable/Filter, MapTools, Geoprocessing, the AI agent panel,
UploadLayer) is still hardcoded German text, not yet converted — the login flow,
welcome/goodbye splash, Sideband, UserAdmin and Pages are.

## Logging & Monitoring

Structured JSON to stdout in `upload-api` (`app.py`'s `log`/`request_id_ctx`, near the
top of the file) — every request gets an id, forwarded as `X-Request-Id` and attached
to every log line from handling it. nginx generates that id first when one didn't
already arrive (`nginx.conf`'s `log_format`), so a request traces gateway-to-backend.
Shipped to Loki (`loki`/`promtail`/`grafana` services in `docker-compose.yml`) and
viewable at `http://127.0.0.1:3001` (Grafana; Loki datasource auto-provisioned, see
`grafana/provisioning/`). Promtail talks to the Docker Engine API over the socket
mount to collect every container's logs — not the Loki Docker logging-driver plugin,
which needs `docker plugin install` on the host and would break this repo's "nothing
to install on the host" principle. Dagster/MapServer/MapProxy needed no logging
changes — they already log to stdout/stderr, which Promtail already picks up.

Per-container resource usage (CPU/memory/network/disk) is a separate pipeline:
`docker-stats-exporter` (own small `build:`-based service, `docker-stats-exporter/
exporter.py`) polls `/containers/{id}/stats` over the same read-only Docker socket
mount promtail already uses, and exposes it as Prometheus metrics labeled `service`
— the same Compose service name promtail already relabels its log streams with.
**Not cAdvisor**, deliberately: cAdvisor needs direct cgroup/overlay2 filesystem
access to the daemon, and this stack runs on Docker Desktop, whose engine lives in
its own isolated VM that a sibling container's bind mounts can't reach — confirmed
live (cAdvisor only ever saw empty host cgroup slices, never the real containers).
The Docker socket itself is the one channel proven to work across that boundary.
The `prometheus` service scrapes and stores the exporter's metrics
(`prometheus/prometheus.yml`), and Grafana gets a second auto-provisioned datasource
for it (`grafana/provisioning/datasources/prometheus.yaml`), 127.0.0.1-only on
`:9090` like every other admin UI here. Both pipelines converge in one
pre-provisioned dashboard, **"VibeGIS — Services"**
(`grafana/provisioning/dashboards/vibegis-overview.json` + its `dashboards.yaml`
provider) — open Grafana and it's already there, no manual import. A `$service`
picker filters both the resource graphs and the log panel together, since they
share the one label name across Prometheus and Loki.

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
| `prometheus/prometheus.yml` | `restart prometheus` — no live-reload endpoint enabled |
| `grafana/provisioning/dashboards/*.json` | nothing — Grafana's file provider polls every 10s (`dashboards.yaml`'s `updateIntervalSeconds`) |
| `docker-stats-exporter/exporter.py` | `up -d --build docker-stats-exporter` — `build:`-based like upload-api, not bind-mounted |
| `qgis-processing/worker.py`, `qgis-processing/Dockerfile` | `up -d --build qgis-processing` — `build:`-based like upload-api, so a plain `restart` silently runs the old image |
| `upload-api/qgis_catalog.py` | `up -d --build upload-api` (it is COPYed into that image) |

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
- **Polygon layers carry a per-layer outline, and both renderers have to agree
  on it.** `configdb.layer_config`'s `outlineWidth` (px, `0` = no border, absent =
  `DEFAULT_POLYGON_OUTLINE_WIDTH` 0.6) is compiled into every polygon `CLASS`'s
  `OUTLINECOLOR`/`WIDTH` by `app.py`'s `polygon_outline()`, and mirrored in the SLD
  by `legend.ts`'s `symbolizerFor()`. The outline colour is a *darkened shade of
  that class's own fill* (`darken_rgb()` / `darkenHex()`, factor 0.55, identical
  truncation on both sides — verified byte-for-byte) rather than one fixed colour,
  so a categorized layer keeps its class identity instead of turning into a grid of
  black lines. Measured: with borders off the two renderers are pixel-identical;
  with a 0.6px border ~0.9% of pixels differ, essentially all of them hairline
  antialiasing along the strokes, with the colours and widths themselves identical.
  A hand-authored `LEGENDS` entry in `legend.ts` deliberately leaves `outlineWidth`
  undefined and keeps its own tuned outline colour at the original 0.5 — those
  layers' mapfile blocks are not generated here, so their SLD must not drift.
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
- **`/qgis-process/` and `/qgis-print` are upload-api routes, not qgis-server ones,
  and the `/qgis` block would swallow them.** `location /qgis` in `nginx.conf` is a
  *prefix* match, so without their own blocks these URIs get proxied to qgis-server,
  which answers with an XML `ServiceExceptionReport`. That is a different symptom
  from the usual "an unlisted route falls through to the SPA and returns
  `index.html`" below — and a more confusing one, since it looks like a QGIS problem
  rather than a routing one. nginx picks the longest matching prefix, so the two
  blocks fix it; just never delete them thinking the `/qgis` block covers them.
- **`qgis_process` cannot use QGIS's native postgres provider; it needs an OGR
  `PG:` DSN.** Passing a `dbname=... table="dwh"."x" (geom)` provider URI as INPUT
  fails with "Could not load source layer" — the postgres provider is not registered
  in the CLI's registry, even with `QGIS_PREFIX_PATH` set. In-process PyQGIS *can*
  use it, which makes this easy to "simplify" back into a bug. The working form is
  `PG:host=... dbname=... user=... schemas=<s> tables=<t>|layername=<t>`, built by
  `pg_dsn()` in `qgis-processing/worker.py`.
- **The QGIS DSN carries no password, for the same reason the mapfiles don't.**
  libpq reads `PGPASSWORD` from the worker's environment. This matters more here than
  in a mapfile: `qgis_process` echoes every INPUT parameter it was given straight to
  stdout, which promtail ships to Loki, so an inline password would end up in the log
  store. The worker — not upload-api — is what composes the DSN, so upload-api cannot
  leak one even by mistake; it only ever sends `{"type": "pgtable", schema, table}`.
- **The QGIS processing plugin needs two apt packages that the base image lacks.**
  `camptocamp/qgis-server:3.40` ships `qgis_process`, but importing the `processing`
  plugin fails on missing `yaml` and then `psycopg2`, and the failure is quiet — you
  just get 248 `native:` algorithms instead of an error. Adding `python3-yaml` and
  `python3-psycopg2` (see `qgis-processing/Dockerfile`) loads it cleanly and takes the
  catalog to 343 (248 `native:` + 57 `gdal:` + 38 `qgis:`). Two curated algorithms
  (`qgis:linestopolygons`, `qgis:minimumboundinggeometry`) only exist in that larger
  set. `GET /qgis-process/health` reports `processing_plugin` and the per-provider
  counts, so a regression here is visible rather than silent.
- **Generated print projects are not in `qgis-server/projects/`.** That directory is
  hand-authored and git-tracked and stays `:ro` at `/io/data`. Machine-generated
  `.qgs` files go to the `qgis-projects` named volume, mounted `/io/generated` (rw in
  qgis-processing, ro in qgis-server), and are deleted right after their PDF is
  streamed, with an hourly sweep as the backstop. `QgsProject.write()` also emits a
  `<name>_attachments.zip` sidecar whether or not the project has attachments, so
  deleting only the `.qgs` slowly fills the volume with orphaned zips.
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
- **A point-cloud layer has no MapServer `LAYER` block and can never appear in
  `GetCapabilities`.** MapServer cannot render 3D Tiles, so `/upload-pointcloud`
  registers the layer in `configdb.point_clouds` and writes its tileset to
  `pointclouds/<layer>/`, served straight off disk. The frontend therefore builds
  `layers[]` from *two disjoint sources* — capabilities for every WMS layer,
  `/layers` for point clouds — concatenated, never joined. Backend-side the
  mirror of this is that **`read_layers()` stays mapfile-only**: it feeds
  `generate_mapproxy_config()` and `materialize_saved_styles()`, which would
  otherwise build a MapProxy cache pointing at a nonexistent MapServer layer and
  try to style a block that does not exist. `all_layers()` is where the two are
  unioned, and only `/layers` and the name-collision checks use it.
- **Flex children need explicit `minWidth: 0` / `minHeight: 0`** wherever wide or tall
  content (an attribute table, the map itself) sits inside one of this app's flex
  layouts. Without it, a flex item's default automatic minimum size is its content's
  *natural* size, and the browser refuses to shrink it below that no matter what the
  surrounding flexbox math says — a wide attribute table once forced its whole column
  wider than intended, which pushed the docked layer panel completely off the visible
  viewport (clipped invisible by `index.html`'s `overflow: hidden` on `#root`, not
  removed — easy to mistake for a state bug instead of a layout one).

## Not production ready yet

This runs as a development stack. What's missing, roughly in the order worth
fixing — every item below was checked against the config, not assumed.

**Blockers**

- **The SPA is served by the Vite dev server.** `nginx.conf`'s `location /`
  proxies to `frontend:5173`, HMR websocket headers and all. `npm run build`
  exists; nothing ever serves `dist/`. Needs a build step plus either an nginx
  `root` or a static-serving container.
- **No TLS, and the gateway is the only thing exposed off-loopback.** nginx is
  `listen 80;`; the session cookie is set `secure=False` (`app.py`'s
  `set_cookie`), so credentials and sessions travel in plaintext. Every admin
  UI is correctly `127.0.0.1`-bound already — only `"${GATEWAY_PORT}:80"` is
  not.
- **No login rate limiting or lockout** in `app.py`, and no `limit_req`
  anywhere in `nginx.conf`.
- **No session revocation** — a JWT cookie with no server-side invalidation, so
  deleting or demoting a user only takes effect when it expires (10h).
- **No backups.** Nothing in `bin/` touches PostGIS, and `postgis-data` is a
  bare named volume. The same goes for the state that isn't in Postgres:
  `pointclouds/`, `mapserver/rasters/`, and the machine-written
  `uploads.map`/`mapproxy.yaml`.

**Operational**

- **No CI** (no `.github/workflows`) on a repo with no tests and no linter —
  `npm run typecheck` is the only check and it is run by hand.
- **Unpinned images**: `:latest` for GDAL, ctb, pgAdmin, pg_featureserv and
  pg2b3dm, plus unpinned `dagster` — which has already silently broken the
  Dagster workspace once (see "Things that will bite you").
- **One healthcheck across fifteen services** (only `postgis`), so `depends_on`
  mostly cannot wait for real readiness.
- **Single host, no HA** — every deploy and every crash is downtime.
- **Default secrets boot silently.** `.env.example` ships
  `AUTH_JWT_SECRET=change_me_please...`; nothing refuses to start if it is left
  that way, which would make every session forgeable. A startup guard is cheap.
- **No security headers** — no CSP, HSTS, `X-Frame-Options`,
  `X-Content-Type-Options`.
- **PayPal is in sandbox** (`PAYPAL_MODE=sandbox`): live credentials and a
  re-registered webhook are needed before taking real money.

**Already documented above, restated here because they are release-blocking**

- The `/mapserver` `/tiles/` `/features` authorization gap — session-gated
  only, so any logged-in user who guesses a private layer's name can fetch its
  tiles. `/pointclouds/` inherits exactly the same gap by construction.

## Ideas not yet built

QGIS Server is no longer just a container with an empty projects directory: the
`qgis-processing` worker runs QGIS algorithms against published layers
(`QgisProcessing.tsx`) and QGIS Server renders the PDF map export
(`PrintExportButton.tsx`). Note the deliberate overlap with `/geoprocess`: buffer,
dissolve and clip/intersect now exist twice, once as hand-written PostGIS SQL and
once as a QGIS algorithm. That is on purpose, not an oversight to consolidate —
the PostGIS buffer works in metres (`ST_Buffer` over `geography`) while
`native:buffer` works in the layer's own units, which for this app's
uniformly-EPSG:4326 data means degrees. The QGIS entry says so in its own note
field; don't quietly merge the two.

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
