# upload-api

FastAPI service (single file, `app.py`, ~640 lines) that turns an uploaded vector file
or an existing PostGIS table into a published MapServer layer. Built on the GDAL image
so GeoPandas/OGR can read shapefiles, GeoPackages, GeoJSON, KML and GML.

Reached through the gateway — nginx proxies each route individually, so **a new
endpoint needs a matching `location` block in `nginx/nginx.conf`** or it 404s.

## Endpoints

| Route | Line | Does |
|---|---|---|
| `POST /upload` | 281 | file → table in schema `raw` → `LAYER` block appended |
| `POST /register-table` | 481 | publish a table that already exists |
| `GET /tables` | 454 | tables available to register |
| `GET /layers`, `DELETE /layers/{name}?drop_table=` | 513, 518 | list / unpublish |
| `GET /distinct-values` | 410 | value list for the filter and categorized editor (caps at 500) |
| `GET /column-stats` | 437 | min/max for the graduated editor |
| `GET|PATCH|DELETE /layer-config[/{name}]` | 609-631 | per-layer classification state |
| `GET /health` | 638 | |

## Contracts

- **Every read and write of `/mapfiles` goes through `check_mapfile_volume()` first.**
  It tests for `webgis.map`, which ships with the repo and is never written here, so
  its absence means the bind mount is dead. That failure is otherwise completely
  silent: the container sees an empty directory, `append_layer_block()` creates
  `uploads.map` from scratch inside it, the API returns 200, and the layer never
  reaches MapServer — which reads the real directory. `/layers` was equally bad,
  answering 200 with an empty list. Now every such path 503s with the fix
  (`docker compose up -d --force-recreate upload-api`) and `/health` reports
  `mapfile_volume`.
- **It owns `/mapfiles/uploads.map` and `/mapfiles/layer_config.json`** (bind-mounted
  from `mapserver/mapfiles/`). All reads and writes go through `read_layers()`,
  `append_layer_block()` and `remove_layer_block()`, which take an `fcntl.flock`.
  Never write those files another way, and don't hand-edit them while the stack is up.
- **MapServer re-parses its mapfile per request**, which is why an append is enough —
  no restart, and a new layer is in `GetCapabilities` immediately.
- **`check_identifier()` (line 106) is the SQL-identifier guard.** Every schema, table
  and column name coming from a request goes through it before touching a query.
  Reuse it; do not hand-roll a second check.
- **`mapfile_escape()` (line 112) for anything user-supplied that lands in a mapfile**
  string — titles especially.
- **Every generated block carries `ows_keywordlist` with `source:<schema>.<table>`**
  and `geomtype:`. MapServer republishes it as `<KeywordList>`, which is how the
  frontend maps a WMS layer to its table without calling `/layers`. Keep it identical
  for `/upload` and `/register-table`: the two must stay indistinguishable downstream.
- **`build_layer_block()` (line 213) writes no `password=`.** libpq gets it from
  `PGPASSWORD` on the mapserver container. The mapfiles are in git — keep it that way.
- `pg_env()` still returns the password because `engine()` needs it for the SQLAlchemy
  URL. That's the only legitimate consumer.

## Running

uvicorn runs **without** `--reload`, so `docker compose restart upload-api` after every
edit. Logs: `docker compose logs -f upload-api`.
