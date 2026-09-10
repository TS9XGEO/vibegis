# VibeGIS

Docker stack serving a 3D map: PostGIS → MapServer/QGIS Server → nginx gateway →
React + Cesium frontend. Everything runs in containers; there is nothing to install
on the host. Keep this folder inside WSL — bind mounts across `/mnt/c` are slow
enough to hurt PostGIS.

## Request path

Everything reaches the browser through nginx on `:8080`, one origin, no CORS.

```
:8080/            → frontend      React, Resium, Mantine. Vite dev server by
                                  default; the built bundle under the production
                                  overlay — see "Development vs production" below
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
     /analytics   → superset      Apache Superset: saved BI dashboards, ad-hoc
                                  charts, SQL Lab (admin/editor only). No login
                                  of its own — see "Superset" below
     /terrain/    → static        baked quantized-mesh from terrain/tiles/
     /3dtiles/    → static        frontend-app/public/3dtiles/
     /pointclouds/→ static        published point-cloud tilesets from pointclouds/
     /upload /upload-raster /upload-raster-zip /upload-pointcloud
     /raster-composite /tables /layers
     /layer-config /distinct-values /column-stats /column-breaks /register-table
     /geoprocess
     /login /logout /auth/me /users /etl/ /cms /groups /layer-grants
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
                                  schemas" below. /groups and /layer-grants are
                                  the per-layer ACL — see "Roles and tiers" below.
                                  There is no self-service signup, guest session or
                                  billing endpoint: an admin creates every account.
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
boolean — plus the AI agent's encrypted BYO-key columns). One-time migrations from
the old `raw`/`staging`/`gis` layout, the old `premium` boolean, and the removal of
self-service billing: `bin/migrate-schemas.sql`, `bin/migrate-tiers.sql`,
`bin/migrate-remove-self-service.sql` (which drops `userdb.subscriptions` and the
seeded `guests` group). `bin/migrate-roles.sql` adds the read-only
`vibegis_render` role to an existing volume.
`postgis/initdb/*.sql` creates the new layout directly, so these only matter on an
existing volume. `ai_agent.py`'s `AI_READABLE_SCHEMAS` deliberately excludes
`userdb` — the read-only AI role never has that schema granted at all, rather than a
schema-wide grant with one table revoked back out.

## Roles and tiers

Two orthogonal axes on `userdb.users`: `role` (`admin`/`editor`/`viewer`) and
`subscription_tier` (`free`/`pro`/`premium`, ranked in `upload-api/app.py`'s
`TIER_RANK` — `require_tier(min)` is the gate, `require_etl_access` is now just
`require_tier("premium")` by another name). Premium covers three things:
the Dagster ETL trigger, the AI agent, and the QGIS features (`/qgis-process/*`
algorithms and `/qgis-print` PDF export). Pro covers uploads (`/upload`,
`/upload-raster`, `/upload-raster-zip`, `/upload-pointcloud`,
`/raster-composite`), `/geoprocess`, `DELETE /layers`, the write side of
`/layer-config`, and the `/column-groupby`//`table-count` aggregates.
`/tables` and `/register-table` are `require_privileged` (admin or editor)
rather than a tier gate — publishing an arbitrary existing table is
administration, not analysis.

**There is no self-service signup, no guest session and no billing.** The
tier is an internal capability grant that the customer's own admin sets in
`UserAdmin.tsx` or with `bin/add-user.sh`; nothing on the public surface can
create an account or change a tier. `/register`, `/guest-session`,
`/subscription/*` and `/paypal/webhook` were removed outright — see
`bin/migrate-remove-self-service.sql` for the database side.

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
user/privilege management, so editor keeps that. A CMS page can additionally be
flagged `admin_only` (`configdb.pages`), which hides it from `/cms`'s list and
404s a direct fetch/edit/delete for anyone but `role == "admin"` literally — the
one place a page-level check *does* use the strict admin check rather than
`require_privileged`, since this gates operational/internal content rather than
general editing. The seeded `architecture` page (a technical reference, unlike the
always-visible `handbook`) is the reason this exists; `Pages.tsx`'s create/edit
form has a matching "Nur für Admins sichtbar" switch, admin-only itself, and shows
a lock icon next to a hidden page in the list.

**Per-layer visibility is a separate concern from tier**, chosen deliberately over
"tier N sees layer set N": `visible_layers_for()` in `app.py` — admin sees
everything; everyone else sees what's granted to their user id
or to any group they belong to, unioned with whatever they *own*
(`configdb.layer_owners`, written by `record_layer_owner()` at the tail of every
publish path — a Pro user has to see a layer the moment they publish it, not only
once an admin grants it back). Managed from the app itself via `AccessAdmin.tsx`
(admin-only, `/groups` + `/layer-grants`).

**The ACL now covers the raw OGC routes too, and that took one design
decision worth knowing.** `visible_layers_for()` used to control only what
`/layers` *offers* — the layer panel, search, attribute table entry points —
while `/mapserver`, `/tiles/`, `/features`, `/qgis` and `/pointclouds/` were
gated by `auth_request` alone, which only asked "is there a valid session". Any
logged-in user who guessed a private layer's name could fetch its tiles.

It is closed without turning those routes into a Python proxy (the latency cost
that made it "deliberately not built yet" before). Instead every gated location
forwards `proxy_set_header X-Original-URI $request_uri;` and `/auth/verify`
authorizes the *original* URI in one place — `authorize_gateway_request()` in
`app.py`. All the layer-name parsing lives in that one Python function rather
than being spread across nginx `map` blocks, because the names arrive in four
different shapes (`?LAYERS=a,b`, `/tiles/<layer>/<grid>/…`,
`/features/collections/<schema.table>/items`, `/pointclouds/<layer>/…`) and it
has to fail closed on anything it cannot parse.

**The caching there is not optional.** `auth_request` fires once per tile and
upload-api runs a single uvicorn worker, so an uncached database round-trip per
tile would freeze the map for everyone. `visible_layer_index()` caches the
per-user visible set for `VISIBILITY_TTL_SECONDS` (30s), and the
`drop_visibility_cache_on_acl_write` middleware invalidates it immediately on any
write to `/groups`, `/layer-grants`, `/layers`, `/users` or `/layer-config`, so a
revoked grant takes effect at once rather than 30 seconds later. Measured cost
with the cache warm: ~18 ms per tile, unchanged from before the gate existed.

Layers in the hand-authored mapfiles (`vibegis.map`, `osm-layers.map`) are
treated as public — they are the base map, and `hand_authored_layers()` lists
them explicitly rather than letting "not in the grant table" mean "denied" for
layers that were never in it.

**"Editing own data" (Pro)**: `require_owner_or_admin()` — admin always passes;
anyone else must both meet the route's tier gate *and* own the specific layer
(`configdb.layer_owners`). Used by `PATCH`/`DELETE /layer-config` and
`DELETE /layers`.

## Superset (reporting & BI)

Added **alongside** `SelectionDashboard.tsx`, never in place of it: that panel's
numbers come from the live Cesium selection and camera extent, and clicking a
chart segment highlights features back on the globe. Superset can see neither,
so it covers the other half — saved dashboards, ad-hoc charts and (later)
scheduled report email over the `dwh` tables.

**No second login.** `/analytics` is gated by `auth_request /auth/superset`
(a separate target from `/auth/verify`, which parses layer names out of the URI
and would fail closed on every Superset URL). upload-api answers with
`X-Vibegis-User`, nginx forwards it as `X-Remote-User`, and
`superset/vibegis_security.py` turns that into a Superset account.

**The ACL is not reimplemented.** At login the security manager calls
`GET /internal/superset/acl`, which runs the same `visible_layers_for()` every
tile and feature request already obeys, and rebuilds a per-user Superset role
(`vg_user_<name>`) holding exactly those datasets. Role mapping: admin →
`Admin`, editor → `Alpha` + `sql_lab`, everyone else → `Gamma` + that per-user
role. **SQL Lab is admin/editor only on purpose** — no dataset permission can
restrict arbitrary SQL, and those two already see every layer by design.
The outer wall is Postgres: Superset connects as `superset_reader`, which has
SELECT on `dwh`/`public`/`reporting` and no grant at all on `configdb` or
`userdb` (`postgis/initdb/08-superset.sql`, `bin/migrate-superset.sql`).

**Datasets follow layers.** Every publish path registers one via
`upload-api/superset_client.py`, deliberately best-effort so a Superset outage
can never fail an upload — with Dagster's nightly `superset_sync` job
(`POST /internal/superset/reconcile`) as the backstop that makes that safe.
**Demo dashboards are seeded on request, never automatically.**
`bash bin/seed-superset-demo.sh` builds two presentable dashboards
(`vibegis-demo-demographics`, `vibegis-demo-transport`) over whatever of
`upload_admin_units` / `upload_bahntrassen` /
`upload_ffentliche_verkehrsmittel` is published, and skips a dashboard whose
datasets are missing. Idempotent by chart/dashboard name, so re-running updates
in place. It is not in the entrypoint on purpose: a customer install with its
own layers should not acquire demo content silently. The seeded charts get the
dataset's own `perm`/`schema_perm`, so they obey the same per-layer ACL as
everything else — verified: a Gamma user granted only `upload_admin_units` sees
the demographics dashboard and is denied the transport one.

**It wears the app's palette.** `superset/superset_config.py`'s
`THEME_OVERRIDES` carries the teal primary and amber secondary from
`frontend-app/src/colorScheme.ts`, plus the app's font stack and Mantine's
`md` radius, and `EXTRA_CATEGORICAL_COLOR_SCHEMES` adds a default `vibegis`
chart palette built from the same two accents (the theme does not reach series
colours; those come from a named scheme). Status colours are left at
Superset's defaults on purpose — a warning that matches the brand stops
reading as a warning. **Dark mode is the limit**: 4.1.3 ships one light theme
and no dark counterpart, so the app in its default dark scheme still opens a
light Superset. Closing that would mean injecting CSS, which is not done here.

Superset's own metadata lives in a separate `superset` database in the same
cluster; `bin/backup.sh` dumps it separately, since the main dump misses it.

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
exporter.py`) polls `/containers/{id}/stats` and exposes it as Prometheus metrics
labeled `service` — the same Compose service name promtail already relabels its log
streams with. **Neither collector mounts `/var/run/docker.sock` any more**: both
talk to the `docker-socket-proxy` service (`tecnativa/docker-socket-proxy`) over
TCP, which is an HAProxy ACL allowing only the endpoints they need. A `:ro` bind of
the socket does not make the *API* read-only — anything holding it can read every
other container's environment, which is where `PGPASSWORD`, `AUTH_JWT_SECRET` and
`AI_KEY_ENCRYPTION_SECRET` live in plaintext. `DOCKER_HOST` points both at the
proxy; promtail needs `NETWORKS: "1"` on it or it fails computing network labels.
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
| `nginx/locations.conf`, `nginx/server-settings.conf`, `nginx/security-headers.conf`, `nginx/nginx.conf` | `restart gateway`. The routes live in `locations.conf`, not `nginx.conf` — see the split below |
| `frontend-app/**` for a **production** check | `docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d --build frontend`; plain `up -d frontend` puts the dev server back |
| `upload-api/app.py` | `up -d --build upload-api` — it's `build:`-based, not bind-mounted, so a plain `restart` keeps running the old image and silently ignores the edit |
| `dagster/defs/**` | "Reload definitions" in the Dagster UI |
| `docker-compose.yml`, `.env` | `docker compose up -d` |
| `postgis/initdb/*.sql` | only ever runs on a **fresh** volume, i.e. after `down -v` |
| `.env` (`AUTH_JWT_SECRET`) | `docker compose up -d` (recreates upload-api) — invalidates every existing session immediately |
| `prometheus/prometheus.yml` | `restart prometheus` — no live-reload endpoint enabled |
| `grafana/provisioning/dashboards/*.json` | nothing — Grafana's file provider polls every 10s (`dashboards.yaml`'s `updateIntervalSeconds`) |
| `docker-stats-exporter/exporter.py` | `up -d --build docker-stats-exporter` — `build:`-based like upload-api, not bind-mounted |
| `qgis-processing/worker.py`, `qgis-processing/Dockerfile` | `up -d --build qgis-processing` — `build:`-based like upload-api, so a plain `restart` silently runs the old image |
| `upload-api/qgis_catalog.py`, `upload-api/superset_client.py` | `up -d --build upload-api` (both are COPYed into that image) |
| `superset/superset_config.py`, `superset/vibegis_security.py` | `up -d --build superset` — COPYed into the image, so a plain `restart` silently runs the old copy |
| `superset/demo_dashboards.py` | `bash bin/seed-superset-demo.sh` — piped into the container over stdin, so no rebuild, unlike the two files above |

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

bash bin/add-user.sh <user> <pass> admin         # the only way an account is created
bash bin/seed-superset-demo.sh                   # two demo dashboards into Superset (idempotent)
bash bin/backup.sh                               # pg_dump -Fc + a tar of the file state
bash bin/restore.sh backups/<stamp>              # and back again
bash bin/fix-ownership.sh                        # once, when moving to non-root containers

# the production stack: TLS + the built SPA instead of the dev server
docker compose -f docker-compose.yml -f docker-compose.tls.yml \
               -f docker-compose.prod.yml up -d --build
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
- **Superset 4.1 has no app-root setting, so serving it at `/analytics` takes
  five separate things and each covers URLs the others miss.** There is no
  `SUPERSET_APP_ROOT` or `APPLICATION_ROOT` in its `config.py` — checked in the
  running image, not assumed. ProxyFix (`ENABLE_PROXY_FIX` + `x_prefix`, fed by
  nginx's `X-Forwarded-Prefix`) covers everything built with `url_for()`;
  `STATIC_ASSETS_PREFIX` covers the asset URLs its Jinja templates build as
  `{{ assets_prefix }}/static/...`, which never see `SCRIPT_NAME`; nginx's
  `proxy_redirect ~^/(?!analytics/)(.*)$` fixes the hardcoded redirect strings
  (the index view answers `Location: /superset/welcome/`); and a root
  `location /static/` catches the webpack bundle URLs, which come from
  Superset's asset manifest and no prefix setting reaches. Miss any one and
  Superset renders blank or half-styled with **no error anywhere** — the
  missing pieces are answered by the SPA catch-all with `index.html` at HTTP
  200. `LOGO_TARGET_PATH` is hardcoded the same way and is set for the same
  reason.
- **The fifth piece is the one that only shows up once there is a dashboard to
  open: Superset's React bundle calls the origin root.** Its XHRs and in-app
  links are built as `/api/v1/...`, `/superset/log/`, `/explore/`, with no idea
  the app is served under `/analytics` — 4.1.3 has no `APPLICATION_ROOT`, and the
  bundle carries neither an `appRoot` client setting nor a react-router
  `basename` (grepped in the running image). The four fixes above all correct
  URLs the *server* builds, so none of them touch these. The symptom is a
  dashboard that renders empty while toasts stack up with **"An error occurred
  while fetching dashboard info: Not found"**, which reads like a missing
  dashboard rather than a missing route: the request falls through to the
  catch-all, and Vite's history fallback only rewrites to `index.html` for a
  client that asked for `text/html`, so an XHR sending
  `Accept: application/json` gets a bare 404 instead of the usual misleading
  200. The regex `location` after `/static/` in `nginx/locations.conf` routes
  Superset's root prefixes to it. It is an allowlist on purpose — `/login`,
  `/logout`, `/users` and `/health` exist in both applications and stay
  VibeGIS's — and it is only safe because the frontend has no client-side
  router; check that again before adding a VibeGIS route named `/chart`,
  `/dashboard`, `/dataset`, `/report` or `/alert`.
- **`absolute_redirect off` in the `/analytics/` block is load-bearing, and the
  failure looks nothing like the cause.** Superset's own redirects are all
  relative — verified by asking it directly, bypassing nginx. But nginx expands
  a path-only `proxy_redirect` replacement into an *absolute* URL built from
  `$host` and the port it is **listening** on, which is 80 inside the container
  while the browser came in on the published 8080. The browser was sent to
  `http://localhost/` and got `ERR_CONNECTION_REFUSED` — nothing in any log
  looks wrong, because from nginx's side the redirect was served fine. The same
  applies to the `= /analytics` no-slash redirect. `Host $http_host` (not
  `$host`) is set alongside it so the port also survives into anything Superset
  builds itself, and so its CSRF Referer check matches the browser's origin.
- **`apache/superset` ships no Postgres driver.** 4.1.3 has `redis`, `celery`
  and `gunicorn` but not `psycopg2`, so the container dies on its first
  `superset db upgrade` — with both its metadata store and the geodata it
  charts being Postgres. `superset/Dockerfile` installs it explicitly.
- **`http.cookiejar` silently drops cookies from a dotless host.** Every
  service here is addressed by its Compose name (`superset`, `upload-api`), and
  cookiejar's default policy refuses to store a cookie whose domain contains no
  dot. Superset's REST API binds its CSRF token to a session cookie, so every
  write failed with "The CSRF session token is missing" while login and the
  token fetch both looked fine. `upload-api/superset_client.py` tracks cookies
  by hand for exactly this reason — don't "simplify" it back to a cookie jar.
- **Every upload-api route needs its own nginx `location`.** The gateway proxies them
  one by one; anything unlisted falls through to `/` and returns the React
  `index.html`, so a missing route looks like a *successful* HTML response rather than
  a 404. `/health` was unreachable for exactly this reason.
- **Visual checks belong to Thomas.** For anything that has to be *looked at*, hand
  over http://localhost:8080/ rather than driving a headless browser.
- **Real accounts, JWT-in-a-cookie, `role` × `subscription_tier`.** `userdb.users`
  (username, bcrypt password hash, `role`, `subscription_tier`) lives in Postgres,
  created by upload-api on startup — not via `postgis/initdb`, since that only runs
  on a fresh volume and this DB already has data. `POST /login` issues an httpOnly
  `vibegis_session` cookie (10h, signed with `AUTH_JWT_SECRET`) carrying both; there
  is still no server-side revocation, so a leaked cookie — or a role/tier change made
  after it was issued — stays as it was until the cookie expires.
  `require_login`/`require_role("admin")`/`require_privileged`/`require_tier()` in
  `upload-api/app.py` gate its own routes in-process; mapserver, mapproxy,
  pg_featureserv and qgis-server have no app code of their own, so nginx gates them
  instead via `auth_request` against upload-api's `/auth/verify` — which now
  authorizes the *specific layers* the request names, not just the session (see
  "Roles and tiers"). `/` is deliberately ungated — the SPA shell has to load
  unauthenticated so the login screen can render.
  First-time setup, and the only way an account is ever created:
  `bash bin/add-user.sh <user> <pass> admin`, since the in-app "Benutzer verwalten"
  screen needs an admin session to reach in the first place. The script takes an
  optional 4th tier argument (`free`/`pro`/`premium`).
- **`dagster/requirements.txt` is pinned now, and it has to stay that way.** A routine
  image rebuild used to pull a newer Dagster that silently broke
  `dagster/defs/__init__.py` on the next reload. It happened once this way: `ScheduleDefinition`'s
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
- **nginx partials belong in `/etc/nginx/vibegis/`, never `conf.d/`.** The
  official nginx image's `nginx.conf` does `include /etc/nginx/conf.d/*.conf`
  at *http* level, so a partial full of bare `location` blocks mounted there
  fails with `"location" directive is not allowed here` and the gateway will not
  start. Only the server block itself goes in `conf.d/default.conf`;
  `server-settings.conf`, `locations.conf` and `security-headers.conf` are
  mounted under `/etc/nginx/vibegis/` and included by path.
- **`add_header` in an inner block discards every inherited header.** nginx's
  `add_header` does not accumulate down the hierarchy — a `location` that sets
  one of its own drops all the ones from the enclosing `server`. That is why
  `security-headers.conf` is included *again* inside the
  `~ ^/terrain/(.*\.terrain)$` location, which sets its own content headers.
- **A busybox healthcheck must use `127.0.0.1`, not `localhost`.** busybox
  `wget` tries the `::1` entry in `/etc/hosts` first, and neither nginx nor Vite
  listens on IPv6 here, so `http://localhost/...` fails with "Connection
  refused" while the service is perfectly healthy — for hours, with nothing else
  wrong. `curl` retries the next address and is unaffected; the two `wget`
  checks in `docker-compose.yml` are the ones that matter.
- **The non-root switch is a one-time volume migration, not just a rebuild.**
  Docker applies the image's ownership to a named volume only the first time it
  creates that volume, so an existing `qgis-work`/`mapproxy-cache`/`dagster-home`
  stays root-owned and the new uid-1001 process cannot write it. `bin/
  fix-ownership.sh` chowns them from inside a throwaway container. It asks
  Compose for each volume's real name rather than gluing `<project>_` onto the
  key — `docker run -v <name>:/v` silently *creates* a volume that does not
  exist, so a wrong guess chowns a brand-new empty one and reports success.
  (This stack has volumes left over from when the project was called `webgis`,
  which is exactly how that was found.)

## Development vs production

`docker-compose.yml` on its own is the **development** stack: HTTP on `:8080`,
the SPA served by the Vite dev server with HMR, `pgadmin` available behind a
profile. That is the daily loop and it should not need a flag.

A customer install is the same file plus two overlays:

```bash
docker compose -f docker-compose.yml \
               -f docker-compose.tls.yml \
               -f docker-compose.prod.yml up -d --build
```

- `docker-compose.tls.yml` swaps `nginx/nginx.conf` for `nginx/nginx-tls.conf`
  (443 + HSTS, `:80` redirecting to it) and mounts `nginx/tls/`. `COOKIE_SECURE`
  stays at its default `true`, so the session cookie is TLS-only.
- `docker-compose.prod.yml` swaps the frontend image for
  `frontend-app/Dockerfile.prod` — `npm ci` + `vite build`, served as static
  files by nginx. It listens on 5173, the same port as the dev server, so the
  gateway's `location /` is byte-identical either way and the two cannot drift.
  It carries its own image tag (`vibegis-frontend-prod`) so a later
  `docker compose up -d` without `--build` cannot silently run the wrong one.

The nginx config is split into four files so the HTTP and HTTPS gateways share
the parts that matter: `nginx.conf` and `nginx-tls.conf` are just server blocks
that both `include /etc/nginx/vibegis/server-settings.conf` and
`locations.conf`, with `security-headers.conf` included from
`server-settings.conf`. **The partials must be mounted at
`/etc/nginx/vibegis/`, not `conf.d/`** — the nginx image includes `conf.d/*.conf`
at http level, where a bare `location` is a syntax error.

## Production hardening — what is done

Every item here was verified against a running stack, not assumed.

**Authorization.** `/distinct-values`, `/column-stats`, `/column-groupby`,
`/table-count`, `/register-table` and both `/geoprocess` inputs used to take a
raw `schema`/`table` from the query string, check it against a bare identifier
regex, and never consult the ACL —
`?schema=userdb&table=users&column=password_hash` returned bcrypt hashes to any
logged-in viewer. They all go through `authorize_table()` now: `dwh` only
(`QUERYABLE_SCHEMAS`), and a `visible_layers_for()` match unless the caller is
privileged. `/tables` and `/layer-config`'s GETs are ACL-filtered the same way,
and the tile/feature gap is closed as described under "Roles and tiers".

**QGIS processing.** A parameter's kind now comes from the algorithm catalog,
not from the shape it arrived in. Before, anything that was not
`{"layer": "<name>"}` fell through to a scalar and was appended verbatim to the
`qgis_process` argv, so `{"OVERLAY": "PG:host=postgis … tables=layer_grants|…"}`
gave arbitrary GDAL datasource control with the worker's own database
credential — and the same slot took `/vsicurl/http://…`, i.e. local file read
and SSRF. `reject_datasource_scalar()` in *both* `app.py` and
`qgis-processing/worker.py` rejects `PG:`, `/vsi`, `http://`, `https://` and
leading `/` as a second line, and every parameter key is validated against the
algorithm's own descriptor, advanced algorithms included, with `OUTPUT` kept
server-owned throughout.

**Least privilege in Postgres.** `mapserver`, `qgis-server`, `qgis-processing`
and `featureserv` connect as `vibegis_render`, which has SELECT on `dwh` and
nothing else — no DDL, no `configdb`, no `userdb`. Created by
`postgis/initdb/07-roles.sql` on a fresh volume, `bin/migrate-roles.sql` on an
existing one. The AI agent's `ai_readonly` role no longer gets `configdb` at
all, and `run_select_query()` checks the relations the planner actually reads
(`EXPLAIN (FORMAT JSON, VERBOSE true)` — `VERBOSE` is required or every relation
comes back attributed to `public`) against the caller's visible layers.

**Non-root containers.** `upload-api`, `qgis-processing`, `dagster`, `mapproxy`
and `docker-stats-exporter` run as uid `APP_UID`:`APP_GID` (default 1001, the
checkout's owner), set both as a build arg and as compose's `user:` so a
different host uid can be fixed without a rebuild. Every service has
`security_opt: [no-new-privileges:true]`, and the eleven that can consume real
resources have `mem_limit`/`cpus`. Switching an existing install over needs
`bash bin/fix-ownership.sh` once — the named volumes were created while those
services still ran as root, and Docker only applies image ownership the first
time a volume is created. The nginx containers (`gateway`, and the frontend
under the production overlay) are the deliberate exception: nginx's master
process is root by design and forks unprivileged workers itself.

**Secrets.** `check_secrets()` runs at import time in `app.py` and refuses to
boot if `AUTH_JWT_SECRET`, `AI_KEY_ENCRYPTION_SECRET`, `AI_READONLY_PG_PASSWORD`
or `PGPASSWORD` is empty, still a `change_me` placeholder, or too short — naming
the `.env` key in the error. Compose uses `${GRAFANA_ADMIN_PASSWORD:?…}` for the
same reason. Mapfile and QGIS `CONNECTION` strings carry neither `user=` nor
`password=`; both come from the reading container's `PGUSER`/`PGPASSWORD`.

**The gateway.** TLS overlay with HSTS; `X-Content-Type-Options`,
`X-Frame-Options: DENY`, `Referrer-Policy` and `server_tokens off` on every
response; `limit_req` on `/login` (10r/m) and `/ai/` (30r/m) and `limit_conn` on
the four upload routes; `MS_MAP_NO_PATH=1` plus an nginx `map=` rejection on
`/mapserver` and a `MAP=` pattern check on `/qgis`, so neither renderer takes a
client-controlled path (`/proc/self/environ` in those containers holds
`PGPASSWORD`). The wildcard `Access-Control-Allow-Origin: *` is gone from the
four static routes — they sit behind session auth and are same-origin.

**Operations.** Every image is pinned in `.env.example` (by digest where there
is no version tag), `dagster/requirements.txt` is fully pinned, seven services
have healthchecks, and `bin/backup.sh` / `bin/restore.sh` cover `pg_dump -Fc`
plus the file-backed state (`pointclouds/`, `mapserver/rasters/`, the
machine-written `uploads.map` and `mapproxy.yaml`).

## Still open before a real install

**CSP is `Content-Security-Policy-Report-Only`, on purpose.** Cesium needs
workers and blob URLs and the policy has not been validated against a real
session yet. Watch the browser console on the production overlay, then flip it
to enforcing.

**Compliance is not started, deliberately.** The scope above is technical only.
Once it is complete, the compliance track is the next piece of work: GDPR/DSGVO
posture, a DPA with every subprocessor, retention and deletion policy, personal
data in the Loki log store, account export and deletion, and ISO 27001 / TISAX
readiness if a customer asks. None of it is built and none of it should be
claimed.

**Known-deferred technical items**, judged not to block a first install:

- The 2 GB upload cap lives as five separate literals (four in
  `nginx/locations.conf`, `MAX_BYTES` in `app.py`). Make it one env var, then
  lower it.
- Zip bombs: `read_vector()` and `extract_raster_zip()` reject zip-slip paths but
  cap no *uncompressed* total. Needs a cumulative-bytes ceiling and a ratio check
  before `extractall()`.
- No statement timeouts on the query endpoints (`ai_agent.py` already sets one
  for the agent and is the model).
- No semaphore around the four upload handlers, each of which reads the whole
  file into memory.
- Raw driver exception strings still reach the client from two paths, leaking
  internal schema and table names.
- No session revocation: JWT-in-a-cookie with no server-side invalidation, so a
  demotion or deletion takes up to 10h. A `token_version` column on
  `userdb.users` checked in `require_login` is the cheap version.
- `cqlCondition()` (`filter.ts`) interpolates a column name into CQL unquoted.
  The XML path escapes it; only CQL is affected, and it is reachable in practice
  only through the AI agent's `filter_layer` tool, whose `column` is not
  validated against the layer's real columns the way the human UI is.
- Dagster's GraphQL API has no authentication of its own and is reachable from
  every container on the `vibegis` network. `/etl/run` itself is well-gated; the
  exposure is lateral movement only.
- pgAdmin runs with `PGADMIN_CONFIG_SERVER_MODE: "False"`, which disables its
  login. It is loopback-bound behind the `tools` profile — never run that profile
  on a shared host.
- One uvicorn worker, with in-memory job state (`_watch_qgis_job`, ETL polling)
  as the reason it cannot simply be scaled out. Moving that state to Postgres is
  the prerequisite.
- No CI, no tests, no linter. `npm run typecheck` is still the only check and it
  is run by hand.
- Single host, no HA — every deploy and every crash is downtime.

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
`UploadLayer.tsx`'s raster mode), point clustering (a per-layer toggle in
`LayerPanel.tsx`, see `frontend-app/CLAUDE.md`'s `PointCluster.tsx` entry), and
the selection-driven dashboard (counts/sums/charts over whatever
`useSelection` holds — see `SelectionDashboard.tsx`) have all since shipped.
Not yet built:

- **A shareable map-state permalink.** Encode camera position, visible
  layers and active filters into the URL so a link reproduces the exact view
  someone is looking at, instead of walking someone through the same clicks.
  Worth resolving first: whether a permalink can name a layer the recipient
  isn't authorized to see (it would need to fail the same way a direct tile
  request already does under the per-layer ACL, not silently succeed) and
  whether an active filter's column/value belongs in a URL at all for a
  sensitive layer.

Deeper notes load with the directory: `frontend-app/CLAUDE.md`, `upload-api/CLAUDE.md`,
`mapserver/CLAUDE.md`. Onboarding and first-run live in `README.md`;
`docs/classification.md` covers where a classification rule belongs.
