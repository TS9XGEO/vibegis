# upload-api

FastAPI service (single file, `app.py`, ~3400 lines) that turns an uploaded vector
file, a GeoTIFF (or a zip of several single-band rasters), a LAS/LAZ point cloud,
or an existing PostGIS table into a published layer, and also owns accounts/auth
and the ETL-trigger bridge to Dagster. Everything but the point cloud becomes a
MapServer layer; a point cloud becomes Cesium 3D Tiles instead (see below). Built on the GDAL image so GeoPandas/OGR can read
shapefiles, GeoPackages, GeoJSON, KML and GML — and so the GDAL CLI tools
(`gdalinfo`, `gdalwarp`, `gdaladdo`, `gdalbuildvrt`, `gdal_translate`) are available
for `/upload-raster` and `/upload-raster-zip`, shelled out via `subprocess` rather
than a Python binding.

Reached through the gateway — nginx proxies each route individually, so **a new
endpoint needs a matching `location` block in `nginx/nginx.conf`** or it 404s.

**Three Postgres schemas, not one.** `dwh` (all geodata — uploaded/registered/
geoprocessed tables, what Dagster's `raw_vectors` asset writes into), `configdb`
(`layer_config`, `pages` — any number of admin-managed content pages, see the `/cms`
endpoints below), `userdb` (just `users`). See the root CLAUDE.md and
`bin/migrate-schemas.sql`. `ai_agent.py`'s `AI_READABLE_SCHEMAS` deliberately omits
`userdb`.

**Structured JSON logging to stdout**, shipped to Loki by the `promtail` service and
viewable in Grafana (`http://127.0.0.1:3001`, 127.0.0.1-only like Dagster/PostGIS —
see `docker-compose.yml`). Every request gets an id (`request_id_ctx`, near the top of
`app.py`) — read from an incoming `X-Request-Id` header if the gateway already set one
(nginx generates one per request, see `nginx.conf`'s `log_format`), otherwise
generated fresh — echoed back on the response and attached to every log line emitted
while handling that request, so one request's logs can be found together even though
uvicorn handles requests concurrently.

## Endpoints

The gate column is the actual `Depends(...)` on the route, not a line number —
line numbers go stale on every edit and the gate is what you need to know.
`require_privileged` is admin *or* editor; `require_tier(x)` is bypassed
entirely by `is_privileged_role()`.

| Route | Gate | Does |
|---|---|---|
| `POST /upload` | `require_tier("pro")` | file → table in schema `dwh` → `LAYER` block appended. Accepts either a `file`, or `upload_token` + `layer` to finish a pending multi-layer choice (see below) |
| `POST /upload-raster` | `require_tier("pro")` | GeoTIFF → reprojected/tiled/overviewed via GDAL CLI → `TYPE RASTER` `LAYER` block, no PostGIS table involved |
| `POST /upload-raster-zip` | `require_tier("pro")` | zip of single-band rasters (e.g. a Sentinel-2 product) → every readable band published as its own layer immediately, no picker; `title` names the whole batch (falls back to the zip's filename), not any one band. Each band's own title/layer-name comes from `band_label()` — GDAL's band description or a handful of common band-identifying metadata keys (e.g. `BANDNAME`) — falling back to that band file's own name when GDAL reports neither; `/upload-raster` uses the same `band_label()` fallback ahead of the filename when no `title` is given |
| `POST /raster-composite` | `require_tier("pro")` | combine three already-published single-band raster layers into one RGB layer — a VRT, not a new reprojection pass |
| `POST /upload-pointcloud` | `require_tier("pro")` | LAS/LAZ → Cesium 3D Tiles via py3dtiles → a row in `configdb.point_clouds`. No PostGIS table *and* no MapServer layer — see the point-cloud contract below |
| `POST /register-table` | `require_privileged` | publish a table that already exists |
| `POST /geoprocess` | `require_tier("pro")` | buffer/dissolve/intersect/join against published layers, publishes the result as a new layer via `publish_derived_table()` |
| `GET /tables` | `require_privileged` | tables available to register |
| `GET /layers`, `DELETE /layers/{name}?drop_table=` | GET `require_login`, DELETE `require_tier("pro")` + `require_owner_or_admin()` | list / unpublish — for a raster layer, `drop_table=true` deletes the underlying `.tif` instead of dropping a table |
| `GET /distinct-values` | `require_login` | value list for the filter and categorized editor (caps at 500) |
| `GET /column-stats` | `require_login` | min/max/sum/avg/count of a numeric column — min/max seed the graduated editor, the rest back the dashboard's "everything selected" overview |
| `GET /column-groupby` | `require_tier("pro")` | value+count per distinct value, capped like `/distinct-values` plus an exact `totalCount` — the dashboard overview's server-side group-by, no in-memory features to aggregate over client-side there |
| `GET /table-count` | `require_tier("pro")` | plain row count for a schema.table — the overview's headline number per layer |
| `GET|PATCH|DELETE /layer-config[/{name}]` | GET `require_login`, writes `require_tier("pro")` + `require_owner_or_admin()` | per-layer classification state — now backed by `configdb.layer_config` (see below), not a JSON file, but the external contract is unchanged |
| `GET /cms` | `require_login` | every page's `{slug, title_de, title_en, updated_at, admin_only}` (no body — kept light for the picker list in `Pages.tsx`); a row flagged `admin_only` is omitted unless `role == "admin"` |
| `POST /cms` | `require_privileged` | create a new page — `slug` validated by `check_slug()` (lowercase/digits/`_`/`-`, ≤64 chars), 409 if it already exists; body may set `admin_only` |
| `GET /cms/{slug}` | `require_login` + `_cms_row_or_404` | one page's full content from `configdb.pages` — a `admin_only` page 404s for anyone but `role == "admin"`, same as an unknown slug |
| `PATCH /cms/{slug}` | `require_privileged` + `_cms_row_or_404` | `Pages.tsx`'s editor writes here; also 404s on a hidden page for a non-admin, so knowing the slug isn't enough to bypass the list filter |
| `DELETE /cms/{slug}` | `require_privileged` + `_cms_row_or_404` | remove a page — same hidden-page 404 |
| `GET /qgis-process/algorithms` | `require_tier("premium")` | curated catalog, `?advanced=true` appends the full introspected one |
| `GET /qgis-process/algorithms/{id}` | `require_tier("premium")` | one algorithm's parameters, curated or translated from `qgis_process help --json` into the same shape |
| `POST /qgis-process/run` | `require_tier("premium")` | validates, inserts a `configdb.qgis_jobs` row, starts a watcher thread, returns `{jobId, status}` |
| `GET /qgis-process/run/{job_id}` | `require_tier("premium")` | poll one job — 404s someone else's unless `is_privileged_role()` |
| `GET /qgis-process/health` | `require_tier("premium")` | the worker's `/healthz` (providers, algorithm count, plugin state) plus the shared-volume check |
| `GET /qgis-print/templates` | `require_tier("premium")` | the server-owned page templates |
| `POST /qgis-print` | `require_tier("premium")` | builds a project via the worker, proxies QGIS Server's GetPrint, streams back `application/pdf` |
| `GET /health` | `require_login` | session-gated liveness; has an nginx location |
| `GET /healthz` | none | unauthenticated liveness for the Docker healthcheck. Deliberately has **no** nginx location — it is container-internal only, so it is not a probe anyone off-host can hit |
| `POST /login`, `POST /logout` | `none` | issue/clear the `vibegis_session` cookie |
| `GET /auth/verify` | `require_login` | 200/401/403 only — nginx's `auth_request` target, not for direct use. Also authorizes the **specific layers** the original request names, via the `X-Original-URI` header nginx forwards — see the gateway-authorization contract below |
| `GET /auth/me` | `require_login` | current user's `{username, role, tier}` |
| `GET/POST/DELETE /groups`, `/groups/{id}/members/{user_id}` | `require_role("admin")` | the group side of the per-layer ACL; `AccessAdmin.tsx` drives it |
| `GET/POST/DELETE /layer-grants` | `require_role("admin")` | the grants themselves — a layer becomes visible to a user or a group |
| `GET/POST /users`, `DELETE /users/{username}` | `require_role("admin")` | admin-only account management; `POST` body/response includes `subscription_tier` alongside `role` |
| `GET /etl/jobs` | `require_etl_access` | the selectable ETL tasks (`ETL_JOBS`), `{name, label}` each — must stay in sync with the jobs defined in `dagster/defs/__init__.py` |
| `POST /etl/run` | `require_etl_access` | launches a named Dagster job (body `{job_name}`, defaults to `refresh_all`, validated against `ETL_JOBS`), returns `{runId, status}` |
| `GET /etl/run/{run_id}` | `require_etl_access` | poll a launched run's `{status, progress}` (progress = resolved steps / planned steps) |
| `GET/POST/DELETE /ai/settings/key` | `require_etl_access` | `require_etl_access`; bring-your-own Anthropic/OpenAI API key, encrypted at rest (see ai_agent.py). Write-only: never returns the plaintext, only `{configured, provider, last4}` |
| `POST /ai/chat` | `require_etl_access` | `require_etl_access`; runs one full tool-calling turn (read-only DB tools + map-control actions + geoprocess/ETL proposals) server-side, returns `{reply, actions[], pendingAction}` |
| `POST /ai/execute-action` | `require_etl_access` | `require_etl_access`; the only path that actually runs a geoprocess/ETL action the agent proposed — takes a single-use, short-lived, user-scoped confirmation token from `/ai/chat`'s `pendingAction`, never reachable by the model's own tool loop |

## Contracts

- **A client never names a schema and table. It names a *layer*.**
  `authorize_table(schema, table, user)` (defined just above
  `require_owner_or_admin`) is the one place that turns a client-supplied pair
  into something safe to query: both identifiers through `check_identifier()`,
  the schema rejected unless it is in `QUERYABLE_SCHEMAS` (`{"dwh"}`), and then —
  unless `is_privileged_role(user)` — a match required in
  `visible_layers_for(user, all_layers())`. `/distinct-values`, `/column-stats`,
  `/column-groupby`, `/table-count`, `/register-table` and *both* `/geoprocess`
  input pairs go through it.

  It exists because they used to take the pair straight from the query string
  with nothing but an identifier regex behind it:
  `?schema=userdb&table=users&column=password_hash` returned up to 500 bcrypt
  hashes to any logged-in viewer, and `column=ai_key_ciphertext` returned the
  encrypted AI keys, defeating the Fernet-at-rest design in `ai_agent.py`. It was
  never SQL injection — identifiers were regex-checked and values were bound. It
  was a missing authorization check, which is a different bug and much easier to
  read past.

- **`/auth/verify` authorizes the request nginx was asked for, not the
  subrequest.** Each gated location sends `proxy_set_header X-Original-URI
  $request_uri;`, and `authorize_gateway_request(original_uri, user)` does all the
  parsing in Python rather than in nginx `map` blocks, because layer names arrive
  in four different shapes: `?LAYERS=a,b` (WMS/WFS, also `LAYER`, `TYPENAME`,
  `QUERY_LAYERS` — `_LAYER_QUERY_KEYS`), `/tiles/<layer>/<grid>/…`,
  `/features/collections/<schema>.<table>/items`, and `/pointclouds/<layer>/…`.
  Every layer a request names must be authorized; anything unparseable fails
  closed. GetCapabilities, `/terrain` and `/3dtiles` are allowed through — they
  carry no layer identity, and capabilities is already filtered elsewhere. Layers
  from the hand-authored mapfiles (`HAND_AUTHORED_MAPFILES` — `vibegis.map`,
  `osm-layers.map`, parsed by `_layer_names_in()`) count as public base map.

  **The cache is load-bearing, not an optimization.** `auth_request` fires once
  per tile and this service runs a single uvicorn worker (no `--workers` in the
  Dockerfile), so an uncached query per tile would serialize the whole map behind
  it. `visible_layer_index(user)` memoizes `(names, tables)` for
  `VISIBILITY_TTL_SECONDS` (30) under `_visibility_lock`, and the
  `drop_visibility_cache_on_acl_write` middleware calls
  `invalidate_visibility_cache()` after any POST/PATCH/PUT/DELETE under
  `_ACL_MUTATING_PREFIXES`, so a revoked grant takes effect immediately instead
  of up to 30s later.

- **A QGIS parameter's kind comes from the catalog, never from its wire shape.**
  `qgis_algorithm_params(alg_id)` returns the algorithm's descriptor — the
  curated entry from `qgis_catalog.py` if there is one, otherwise the worker's
  introspection of `qgis_process help --json` — and `/qgis-process/run` decides
  per key from `known[key].kind == "layer"`. A `layer` parameter must arrive as
  `{"layer": "<name>"}` and is resolved through `resolve_layer_source()`;
  anything else in that slot is a 400.

  The old code resolved *only* when the value happened to be a dict, so a plain
  string fell through to a scalar and was appended verbatim to the
  `qgis_process` argv. `{"OVERLAY": "PG:host=postgis … tables=layer_grants|…"}`
  therefore got the worker to connect with its own database credential and read
  any table, and the same slot accepted `/vsicurl/http://…` (SSRF and local file
  read). No shell was involved — it was arbitrary GDAL datasource control.
  `reject_datasource_scalar()` rejects `PG:`, `/vsi`, `http://`, `https://` and a
  leading `/` as a belt-and-braces second check, and it lives in **both**
  `app.py` and `qgis-processing/worker.py` on purpose: the worker must not trust
  its caller either. `OUTPUT` stays server-owned for every algorithm, curated or
  not.

- **`check_secrets()` runs at import time and can refuse to start the process.**
  It is called immediately after `_configure_logging()`, before anything else, and
  raises `RuntimeError` naming the `.env` key if `AUTH_JWT_SECRET`,
  `AI_KEY_ENCRYPTION_SECRET`, `AI_READONLY_PG_PASSWORD` or `PGPASSWORD` is empty,
  contains a `change_me`-style placeholder marker, or is under its minimum length.
  Failing at import rather than on first request is the point — an install that
  missed a line in `.env` should not come up looking healthy while every session
  is forgeable.

- **Removed: self-service.** `/register`, `/guest-session`,
  `/subscription/upgrade`, `/subscription/cancel`, `/paypal/webhook` and
  `upload-api/paypal.py` no longer exist, and there is no `guest` tier — every
  tier check starts at `free`. `subscription_tier` and the whole
  `TIER_RANK`/`require_tier` machinery stayed: it is how a customer's own admin
  grants capability internally. Database side: `bin/migrate-remove-self-service.sql`.

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
- **A polygon layer's border is one per-layer value, not a per-class one.**
  `layer_config`'s `outlineWidth` feeds `polygon_outline()`, which every polygon
  `STYLE` goes through — the unclassified default (`default_style()`) and each
  class of a classification (`classified_style()`) alike. `0` emits no
  `OUTLINECOLOR` at all rather than `WIDTH 0`, because MapServer still draws a
  hairline for the latter. It is in `STYLE_KEYS`, so a write rebuilds the LAYER
  block, purges that layer's tiles and bumps `styleVersion` like any other
  styling change. Range is validated on the Pydantic model (`0..10`), so a bad
  value is a 422 rather than a corrupt mapfile.
  The outline colour is deliberately *not* configurable: it is derived from each
  class's own fill via `darken_rgb()`, which keeps a categorized layer readable
  without a second colour picker. `legend.ts`'s `darkenHex()` must stay identical
  — see the root CLAUDE.md.
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
- **A point cloud is the one published layer with no `LAYER` block at all.**
  MapServer cannot render 3D Tiles, so `/upload-pointcloud` registers it in
  `configdb.point_clouds` (created by `ensure_pointcloud_table()` on startup,
  same idempotent-DDL pattern as `ensure_users_table()`) and writes the tileset
  to `/pointclouds/<layer>/`, which nginx serves directly. Consequences worth
  knowing before touching any of it:
  - **`read_layers()` must stay mapfile-only.** Its other callers are
    `generate_mapproxy_config()` (would emit a cache/source pair aimed at a
    MapServer layer that does not exist) and `materialize_saved_styles()` (would
    try to seed a `CLASS` style for a block that does not exist). `all_layers()`
    unions the two sources and is used by `GET /layers` and the name-collision
    checks only. Verified live: after publishing a point cloud, `mapproxy.yaml`
    and `uploads.map` both stay free of it and a restart logs no style errors.
  - **`DELETE /layers/{name}` checks the point-cloud registry *before*
    `remove_layer_block()`**, which 404s on a name it cannot find — checking
    after would make a point cloud undeletable.
  - The layer name is `pointcloud_`-prefixed, never `upload_`: `collectionFor()`
    in `wms.ts` resolves `upload_*` to `dwh.<name>`, which would offer an
    attribute table against a table that does not exist.
- **py3dtiles lives in its own venv, `/opt/py3dtiles`, pinned to 12.1.1.** It
  pins `numpy<2.4` and pulls `numba`, which will not co-resolve with the
  geopandas stack `/upload` needs — so it is shelled out to by absolute path
  (`run_py3dtiles()`, the `run_gdal()` idiom with a longer timeout), never
  imported. `laspy[lazrs]` *is* in the main `requirements.txt`, because
  `probe_pointcloud()` reads headers in-process; `lazrs` is a prebuilt Rust
  wheel, so LAZ needs no apt-level `liblaszip`. Verified CLI:
  `convert <file> --out <dir> --srs_in <epsg> --srs_out 4978 --overwrite --jobs 2
  --disable-processpool`. `--srs_out 4978` (ECEF) is what puts the tileset's root
  transform on the globe; the default `--spec-version 1.0` is what emits `.pnts`
  rather than glTF. `--disable-processpool` is for Docker's 64 MB `/dev/shm`.
- **The input CRS is required, never guessed** — a wrong one drops the cloud in
  the ocean or underground, which is far worse than refusing the upload. Header
  first (`laspy` `parse_crs()`), then the `srs` form field, else a German 400
  naming the fix. The WGS84 bbox goes through
  `pyproj.Transformer.from_crs(..., always_xy=True)`; **without `always_xy` the
  bbox comes out transposed**, since EPSG:4326 declares latitude first.
- **Classification only survives conversion for LAS point formats 6+, and
  `probe_pointcloud()` checks for exactly that.** py3dtiles builds its
  `--extra-fields` list from the point format's *dtype* field names; in formats
  0–5 the classification is packed into a shared byte exposed as
  `raw_classification`, so asking for `classification` there makes py3dtiles warn
  and write a column of zeros rather than fail — a layer that colours every point
  identically and looks broken. So `has_classification` is only true when the
  format exposes it standalone *and* the values vary, and `--extra-fields` is
  only passed then. Confirmed by reading the generated `.pnts` batch table
  directly, which is also where the frontend's `${classification}` style variable
  name (lowercase) comes from. Note it lands as a *JSON* batch table, which puts
  Cesium on its CPU styling path — fine here, a real cost on a very large cloud.
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
  published layer (`dwh.adm2`) rather than only against fresh test tables.
- **`qgis_worker()` is the second cross-container HTTP client in this file**, the
  same plain-urllib shape as `dagster_graphql()` and for the same reason: the
  `qgis-processing` worker is a separate image with no in-process import path. It has
  no auth and no nginx `location` — like Dagster, it is reachable only on the
  `vibegis` network, and every tier/ACL check happens here before the call.
- **`ingest_geodataframe()` is the shared tail of `POST /upload` and the QGIS
  finalizer.** An in-memory GeoDataFrame becomes a `dwh` table and a published layer.
  Its `require_crs` flag is the only behavioural difference between the callers: an
  uploaded file with no CRS is assumed to be 4326 (a reasonable guess for a file a
  person picked), while an algorithm result with no CRS is a hard error — silently
  assuming 4326 for the output of a reprojection would put the layer somewhere
  entirely wrong with nothing on screen to hint at it.
- **It calls `ensure_unique_column()` instead of hardcoding `ADD COLUMN gid`.** A
  QGIS result copies its source table's columns verbatim, and every layer this app
  publishes already has a `gid`, so the old unconditional `ADD COLUMN gid SERIAL
  PRIMARY KEY` collided on *every* QGIS run. That is the same trap
  `ensure_unique_column()` already existed for on the `/geoprocess` path (it falls
  back to `gid_2`, `gid_3`, …), so it is reused rather than answered twice. `/upload`
  is unaffected: a plain uploaded file has no `gid`, so it still gets `gid`.
- **QGIS jobs are tracked in `configdb.qgis_jobs`, not in the worker.** The job does
  not end when `qgis_process` exits — reading the GeoPackage, loading it into `dwh`
  and publishing can only happen here, so a registry in the worker could only ever
  disagree with this one. `ensure_qgis_jobs_table()` also fails any row still marked
  `running` at startup: such a row belongs to a process that is gone, and without the
  sweep a rebuild mid-run leaves a notification spinning forever in the browser. It is
  safe because it runs before uvicorn accepts requests.
- **The watcher is a plain daemon thread started at submit time, not work done in the
  poll handler.** An ingest can take tens of seconds while the client polls every two
  seconds; doing it in the handler would need a lock and would still lose the run when
  the user closed the tab. **This assumes uvicorn stays single-process** — it does
  (no `--workers` in the Dockerfile's CMD). Adding workers later would give one
  watcher per process per job; the fix then is a `pg_advisory_xact_lock` in the poll
  handler, not a rewrite.
- **QGIS layer inputs resolve through `visible_layers_for()`, unlike `/geoprocess`.**
  `resolve_layer_source()` takes a *layer name*, checks it against what this user may
  actually see, and derives schema/table from the layer's own record. `/geoprocess`
  still takes a raw schema/table pair validated only by `check_identifier()`, which
  lets anyone past its tier gate read any table in `dwh` including one behind a
  `layer_grants` ACL. The new routes deliberately do not copy that; it is a candidate
  retrofit for `/geoprocess`.
- **A GeoPackage result is read with geopandas, so it needs a size ceiling**
  (`QGIS_MAX_OUTPUT_BYTES`, 512 MB) that a streaming `ogr2ogr -f PostgreSQL` would
  not. `ogr2ogr` is the escape hatch if that ever bites, but it bypasses the geometry
  family check and the 4326 normalization every downstream consumer assumes.
- **`POST /qgis-print` is synchronous, unlike the processing routes** — a PDF is a
  download, and making it a job would mean inventing a download-token dance for a few
  seconds' work. DPI (≤300) and page size (≤A3) are capped so that stays true. It
  proxies the GetPrint rather than handing the browser a `/qgis?MAP=…` URL, which
  keeps generated project paths out of the client. **QGIS Server answers a failed
  GetPrint with HTTP 200 and an XML `ServiceExceptionReport`**, so the status code
  proves nothing — the response's content type is what distinguishes a real PDF.
- **The print layer list is rebuilt from `visible_layers_for()`, never trusted from
  the request.** QGIS Server has no per-user concept at all, so without that the print
  route would be a broader read than `/layers` is.
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
  transaction. **`userdb` (accounts, AI key ciphertext) is never granted to
  `ai_readonly` in the first place** — the DB is split into three schemas
  (`dwh` geodata, `configdb` app/layer config, `userdb` accounts; see
  `bin/migrate-schemas.sql` and the root CLAUDE.md), and `AI_READABLE_SCHEMAS`
  in `ai_agent.py` simply omits `userdb`, rather than granting schema-wide
  `SELECT` and then revoking one sensitive table back out (the previous
  approach, from when accounts lived inside the `gis` schema alongside real
  geodata). Any future non-geodata schema needs the same omission.
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
