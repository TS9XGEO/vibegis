# upload-api

FastAPI service (single file, `app.py`, ~2100 lines) that turns an uploaded vector
file, a GeoTIFF (or a zip of several single-band rasters), or an existing PostGIS
table into a published MapServer layer, and also owns accounts/auth and the
ETL-trigger bridge to Dagster. Built on the GDAL image so GeoPandas/OGR can read
shapefiles, GeoPackages, GeoJSON, KML and GML — and so the GDAL CLI tools
(`gdalinfo`, `gdalwarp`, `gdaladdo`, `gdalbuildvrt`, `gdal_translate`) are available
for `/upload-raster` and `/upload-raster-zip`, shelled out via `subprocess` rather
than a Python binding.

Reached through the gateway — nginx proxies each route individually, so **a new
endpoint needs a matching `location` block in `nginx/nginx.conf`** or it 404s.

## Endpoints

| Route | Line | Does |
|---|---|---|
| `POST /upload` | 1010 | file → table in schema `raw` → `LAYER` block appended. Accepts either a `file`, or `upload_token` + `layer` to finish a pending multi-layer choice (see below) |
| `POST /upload-raster` | admin-only | GeoTIFF → reprojected/tiled/overviewed via GDAL CLI → `TYPE RASTER` `LAYER` block, no PostGIS table involved |
| `POST /upload-raster-zip` | admin-only | zip of single-band rasters (e.g. a Sentinel-2 product) → every readable band published as its own layer immediately, no picker; `title` names the whole batch (falls back to the zip's filename), not any one band. Each band's own title/layer-name comes from `band_label()` — GDAL's band description or a handful of common band-identifying metadata keys (e.g. `BANDNAME`) — falling back to that band file's own name when GDAL reports neither; `/upload-raster` uses the same `band_label()` fallback ahead of the filename when no `title` is given |
| `POST /raster-composite` | admin-only | combine three already-published single-band raster layers into one RGB layer — a VRT, not a new reprojection pass |
| `POST /register-table` | 1251 | publish a table that already exists |
| `POST /geoprocess` | admin-only | buffer/dissolve/intersect/join against published layers, publishes the result as a new layer via `publish_derived_table()` |
| `GET /tables` | 1224 | tables available to register |
| `GET /layers`, `DELETE /layers/{name}?drop_table=` | 1285, 1290 | list / unpublish — for a raster layer, `drop_table=true` deletes the underlying `.tif` instead of dropping a table |
| `GET /distinct-values` | 1736 | value list for the filter and categorized editor (caps at 500) |
| `GET /column-stats` | 1763 | min/max/sum/avg/count of a numeric column — min/max seed the graduated editor, the rest back the dashboard's "everything selected" overview |
| `GET /column-groupby` | 1795 | value+count per distinct value, capped like `/distinct-values` plus an exact `totalCount` — the dashboard overview's server-side group-by, no in-memory features to aggregate over client-side there |
| `GET /table-count` | 1829 | plain row count for a schema.table — the overview's headline number per layer |
| `GET|PATCH|DELETE /layer-config[/{name}]` | 1404-1452 | per-layer classification state |
| `GET /health` | 1471 | |
| `POST /login`, `POST /logout` | 341, 357 | issue/clear the `vibegis_session` cookie |
| `GET /auth/verify` | 363 | 200/401 only — nginx's `auth_request` target, not for direct use |
| `GET /auth/me` | 370 | current user's `{username, role, premium}` |
| `GET/POST /users`, `DELETE /users/{username}` | 380, 389, 401 | admin-only account management; `POST` body/response includes `premium` alongside `role` |
| `GET /etl/jobs` | 522 | admin-or-`premium`-gated: the selectable ETL tasks (`ETL_JOBS`), `{name, label}` each — must stay in sync with the jobs defined in `dagster/defs/__init__.py` |
| `POST /etl/run` | 530 | admin-or-`premium`-gated (`require_etl_access`): launches a named Dagster job (body `{job_name}`, defaults to `refresh_all`, validated against `ETL_JOBS`), returns `{runId, status}` |
| `GET /etl/run/{run_id}` | 503 | poll a launched run's `{status, progress}` (progress = resolved steps / planned steps) |
| `GET/POST/DELETE /ai/settings/key` | end of file | `require_etl_access`; bring-your-own Anthropic/OpenAI API key, encrypted at rest (see ai_agent.py). Write-only: never returns the plaintext, only `{configured, provider, last4}` |
| `POST /ai/chat` | end of file | `require_etl_access`; runs one full tool-calling turn (read-only DB tools + map-control actions + geoprocess/ETL proposals) server-side, returns `{reply, actions[], pendingAction}` |
| `POST /ai/execute-action` | end of file | `require_etl_access`; the only path that actually runs a geoprocess/ETL action the agent proposed — takes a single-use, short-lived, user-scoped confirmation token from `/ai/chat`'s `pendingAction`, never reachable by the model's own tool loop |

## Contracts

- **Every read and write of `/mapfiles` goes through `check_mapfile_volume()` first.**
  It tests for `vibegis.map`, which ships with the repo and is never written here, so
  its absence means the bind mount is dead. That failure is otherwise completely
  silent: the container sees an empty directory, `append_layer_block()` creates
  `uploads.map` from scratch inside it, the API returns 200, and the layer never
  reaches MapServer — which reads the real directory. `/layers` was equally bad,
  answering 200 with an empty list. Now every such path 503s with the fix
  (`docker compose up -d --force-recreate upload-api`) and `/health` reports
  `mapfile_volume`.
- **`/table-count`, `/column-groupby` and `/column-stats` all take an optional
  `filter` query param** — the frontend's `LayerFilter` shape ({logic, conditions}
  from wms.ts), JSON-encoded into one string (simplest way through a `GET` query
  string without switching these to `POST`). `parse_layer_filter()` decodes it;
  `build_filter_where()` (both next to `check_identifier`) turns it into a
  parameterized SQL fragment — same `eq/neq/gt/lt/gte/lte/like` operator set as
  filter.ts's `buildCql()`/`cqlCondition()`, every column still through
  `check_identifier`, every value a bound parameter, never interpolated. This is
  what lets SelectionDashboard.tsx's `LayerOverviewCard` scope its "everything
  selected" overview to a layer's active attribute filter instead of the whole
  table — see frontend-app/CLAUDE.md's SelectionDashboard.tsx entry.
- **It owns `/mapfiles/uploads.map` and `/mapfiles/layer_config.json`** (bind-mounted
  from `mapserver/mapfiles/`). All reads and writes go through `read_layers()`,
  `append_layer_block()` and `remove_layer_block()`, which take an `fcntl.flock`.
  Never write those files another way, and don't hand-edit them while the stack is up.
- **MapServer re-parses its mapfile per request**, which is why an append is enough —
  no restart, and a new layer is in `GetCapabilities` immediately.
- **`check_identifier()` (line 539) is the SQL-identifier guard.** Every schema, table
  and column name coming from a request goes through it before touching a query.
  Reuse it; do not hand-roll a second check.
- **`mapfile_escape()` (line 545) for anything user-supplied that lands in a mapfile**
  string — titles especially.
- **Every generated block carries `ows_keywordlist` with `source:<schema>.<table>`**
  and `geomtype:`. MapServer republishes it as `<KeywordList>`, which is how the
  frontend maps a WMS layer to its table without calling `/layers`. Keep it identical
  for `/upload` and `/register-table`: the two must stay indistinguishable downstream.
  A raster layer (`build_raster_layer_block()`) is the deliberate exception: its
  keywordlist is `geomtype:raster,bands:{n}[,batch:{id},batch_title:{title}]`
  with **no `source:` at all**, since there's no `schema.table` behind it —
  that absence is what keeps the frontend's `LayerState.source` `null` for a
  raster layer, excluding it from every `.source`-gated vector feature
  (attribute table, filter, classify, geoprocess) with no extra gating code
  needed. `bands:` is what lets `/raster-composite` (and the layer panel's
  R/G/B picker) tell a single-band layer apart from a composite without
  re-probing the file — read back server-side via the new `keyword_value()`
  helper, a backend-side mirror of `wms.ts`'s `keywordValue()`. `batch:`/
  `batch_title:` are only set for a band published from `/upload-raster-zip`
  (its `title` field names the *batch*, not any one band — falls back to the
  zip's own filename when blank) — every band from one zip shares the same
  opaque `batch` id, which `LayerPanel.tsx` uses to collapse them under one
  named group. This is a frontend-only grouping concept riding the same
  keywordlist channel, independent of `GROUP "uploads"` membership: verified
  by direct `mapserv` testing that MapServer's own `GROUP` is a flat opaque
  string with no hierarchy, so `GROUP "uploads/x"` cannot be used to nest a
  batch under the uploads group in `GetCapabilities`. `batch_title` is
  `urllib.parse.quote()`-encoded before embedding (and `decodeURIComponent`-
  decoded on the way out) since keywordlist values are comma-split
  everywhere they're read — a raw user-entered title could otherwise break
  parsing the moment it contains a comma.
- **`check_raster_volume()` guards `POST /upload-raster`** the same way
  `check_mapfile_volume()` guards everything touching `uploads.map`:
  `mapserver/rasters/.gitkeep` ships with the repo, so its absence proves the
  `/rasters` bind mount (read-write into upload-api, read-only into mapserver)
  is dead rather than merely empty. Deliberately not nested under `/data`
  (mapserver's existing mount of `mapserver/data`) — Docker can't create a
  mountpoint for a second bind mount inside a parent mount that's already
  read-only, which is exactly the shape `/data/rasters` would have been.
- **`/upload-raster-zip` is a single request, not a handshake** — every
  band GDAL can read out of the zip is published immediately, one layer
  each, with no user choice at upload time (compositing happens later, from
  the layer panel; see `/raster-composite` below). The zip is extracted into
  a plain `tempfile.TemporaryDirectory()` — the same idiom `read_vector()`
  already uses for its own shapefile-zip fallback — since nothing needs to
  survive past this one request. Each band is published independently via
  `normalize_tile_and_publish()`, and a failure on one doesn't sink the
  others: the response is `{"published": [...], "failed": [...]}`, one
  entry per band either way.
- **`probe_raster()` and `probe_raster_lenient()` are deliberately two
  different functions.** `probe_raster()` gates `/upload-raster` itself and
  hard-rejects anything whose driver isn't `GTiff` — the anti-spoofing check
  for a renamed non-raster file. `probe_raster_lenient()` gates
  `/upload-raster-zip`'s member discovery instead, where the whole point is
  scanning a zip's arbitrary contents (metadata XML, thumbnails, and — for a
  real Sentinel-2 product — bands that are natively `JP2OpenJPEG`, not
  GeoTIFF at all) and treating "doesn't probe as a raster" as the filter
  itself, not an error to surface.
- **`/raster-composite` builds an RGB layer from three already-published
  single-band raster layers with a plain `gdalbuildvrt -separate`** —
  deliberately not a new reprojection/resample pass. Every raster this app
  ever publishes goes through `normalize_raster` (reproject to EPSG:4326) at
  its own publish time, so any three of them are already in the same CRS;
  the VRT is a few-KB XML file referencing the three existing files
  directly, and `gdaladdo` on it produces an external `.vrt.ovr` overview
  sidecar (a VRT can't hold overviews internally the way a GeoTIFF can) —
  `build_raster_overviews()` needed no changes to support this, it already
  works on any GDAL-openable path. `-resolution highest` is what reconciles
  a resolution difference between the three sources (e.g. a 10m band next
  to a 60m one) by resampling to the finest, same as Sentinel-2's own bands
  would need. `DELETE /layers/{name}` had to change from unlinking a
  hardcoded `{name}.tif` to globbing `{name}.*`, since a composite's files
  are `{name}.vrt` + `{name}.vrt.ovr`, not a `.tif` at all.
- **Every raster `LAYER` block carries `PROCESSING "SCALE=AUTO"`** (added
  alongside the existing `RESAMPLE=AVERAGE`) since a non-8-bit source — any
  Sentinel-2 band is UInt16 reflectance, typically 0–~10000 — renders as flat
  black without a stretch; MapServer draws raw pixel values otherwise. A
  no-op for already-8-bit imagery, so this applies to every raster layer,
  not just ones from `/upload-raster-zip`.
- **`normalize_tile_and_publish()` is the shared tail of `/upload-raster`
  and `/upload-raster-zip`'s per-band loop** — `normalize_raster` →
  `build_raster_overviews` → `unique_raster_name` → move into `RASTERS_DIR`
  → `publish_raster_layer`. Extracted so this logic exists once instead of
  twice. `/raster-composite` does *not* use it — a composite's file is
  already in `RASTERS_DIR` the moment `gdalbuildvrt` writes it (no temp
  file, no move, no reprojection needed), so it calls `publish_raster_layer`
  directly instead.
- **`parse_layers()` recognizes two `DATA` shapes.** A vector `LAYER`'s `DATA` is
  `"{col} FROM {schema}.{table} USING UNIQUE {col} USING SRID={n}"` (`DATA_RE`); a
  raster `LAYER`'s is just a file path (`DATA_RASTER_RE`). The parser branches on
  `TYPE` before choosing which regex to apply, and every parsed dict carries the
  same key set either way (`schema`/`table`/`geom_col`/`unique_col`/`srid` are
  `None` on a raster entry, `path` is `None` on a vector one) so downstream code
  never needs to special-case which fields exist. `apply_layer_style()` explicitly
  no-ops for `geometry_type == "RASTER"` for the same reason `build_layer_block()`
  can't be called with `schema=None` — there's no CLASS-based styling to seed for
  a continuous/RGB raster.
- **`build_layer_block()` (line 683) writes no `password=`.** libpq gets it from
  `PGPASSWORD` on the mapserver container. The mapfiles are in git — keep it that way.
- `pg_env()` still returns the password because `engine()` needs it for the SQLAlchemy
  URL. That's the only legitimate consumer.
- **Every route except `/login` needs `Depends(require_login)`,
  `Depends(require_role("admin"))`, or `Depends(require_etl_access)`.** These decode
  the `vibegis_session` JWT cookie; there's no other auth path into this service.
  `require_role("admin")` gates anything that writes (`/upload`, `/register-table`,
  `DELETE /layers`, `/layer-config` writes, `/users` writes); `require_etl_access`
  (`role == "admin" or premium`) gates `/etl/*` only; `require_login` alone is enough
  for reads. A new route needs one of the three, or it's reachable by anyone.
- **Multi-layer uploads are a two-request handshake, not a bigger single request.**
  A GeoPackage/GML/KML can hold several layers; `list_spatial_layers()` (line 959)
  detects that via `geopandas.list_layers()` and, if there's more than one, saves the
  upload under `UPLOAD_TMP_DIR` (line 64, keyed by a `uuid4` token in the filename
  itself) and responds `{needs_layer_choice, layers, uploadToken}` instead of
  processing it — deliberately not deleting the temp file in that branch. The
  follow-up `POST /upload` with `upload_token` + `layer` picks that file back up and
  finishes the import. A file is never re-sent for this (uploads run up to 2 GB);
  anything abandoned gets swept after an hour on the next `/upload` call.
- **`ensure_unique_column()` picks a synthetic PK name that avoids existing
  columns, not just existing PKs.** It only skips adding one when a real PK
  already exists (`find_unique_int_column()`); otherwise it used to always
  add a column literally named `gid`, which collides the moment the table
  already has a plain, non-PK `gid` column. That's not a corner case for
  `/geoprocess`: buffer/dissolve/intersect copy the source table's columns
  verbatim via `CREATE TABLE AS SELECT`, which drops constraints but keeps
  names, so a source layer with an ordinary `gid` column (the same name this
  very function gives an originally-uploaded layer) reliably hits it. Fixed
  by checking `information_schema.columns` first and falling back to
  `gid_2`, `gid_3`, … Found by actually running `/geoprocess` against a real
  published layer (`raw.adm2`) rather than only against fresh test tables.
- **`dagster_graphql()` (line 430) is the whole bridge to Dagster** — upload-api and
  Dagster are separate Python images/venvs with no in-process import path, so this
  is a plain HTTP POST to `http://dagster:3000/graphql` over the `vibegis` Docker
  network (Dagster's own port publish is host-loopback-only, which doesn't affect
  container-to-container traffic at all). `/etl/run` looks up the real repository
  location/name via a `workspaceOrError` query rather than hardcoding them, since
  they depend on how `workspace.yaml`'s `python_module` entry gets named internally.
- **The AI agent's DB reads never use `engine()`.** `ai_agent.py` (imported as
  `ai_agent`, not merged into this file — the tool loop, provider adapters, SQL
  guardrails and key encryption are substantial and orthogonal to everything else
  here) opens its own connection as the unprivileged `ai_readonly` Postgres role
  (`ensure_ai_schema()`, called from this file's startup hook alongside
  `ensure_users_table()` — same idempotent-DDL-on-a-live-database pattern that added
  `premium`). Defense in depth on top of that role having no write grants:
  `validate_select_sql()` forces a single `SELECT`/`WITH` statement with no mutating
  keywords, and the query additionally runs inside a Postgres `READ ONLY`
  transaction. **`gis.users` is explicitly revoked from `ai_readonly`** even though
  it's granted schema-wide `SELECT` on `gis` for the real geodata tables that live
  alongside it (`AI_UNREADABLE_TABLES` in ai_agent.py) — without that, the agent
  (and so indirectly a premium/admin user's chat) could read every bcrypt
  `password_hash` and every other user's encrypted AI key ciphertext. Any future
  non-geodata table added to `raw`/`staging`/`gis`/`public` needs the same
  exclusion.
- **A geoprocess/ETL action the AI agent proposes never runs itself.** `/geoprocess`
  and `/etl/run`'s bodies are `_execute_geoprocess()`/`_execute_etl_run()` — plain
  functions the routes call, so there is exactly one implementation of each
  regardless of entry point. The agent's `propose_geoprocess`/`propose_etl_run`
  tools only stage a `PendingAction` (ai_agent.py) and hand the model back an
  opaque, single-use, short-lived, user-scoped token — the model has no way to mark
  it confirmed. `POST /ai/execute-action` is the only thing that ever calls the
  `_execute_*` functions from a proposal, and only after a real button click in the
  frontend sends that exact token back. Note it's gated `require_etl_access`
  (admin-or-premium) like every other `/ai/*` route, not `require_role("admin")`
  like the manual `/geoprocess` route — a deliberate, confirmed choice: a premium
  (non-admin) user can trigger a geoprocess run through the AI chat's confirmation
  flow even though they can't open the manual `Geoprocessing.tsx` modal.

## Running

uvicorn runs **without** `--reload`, and it's `build:`-based in `docker-compose.yml`,
not bind-mounted — so a plain `docker compose restart upload-api` re-launches the
*old* image and silently ignores any edit. After changing `app.py`, always
`docker compose up -d --build upload-api`. Logs: `docker compose logs -f upload-api`.
