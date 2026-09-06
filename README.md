# VibeGIS Docker Stack

PostGIS · MapServer · QGIS Server · MapProxy · pg_featureserv · Dagster · React + CesiumJS

```
Browser ──► nginx :8080 ──┬──► /            React frontend (Resium, Mantine)
   (:443 with TLS)        │                 Vite dev server, or the built bundle
                          ├──► /mapserver   MapServer (WMS/WMTS/OGC API)
                          ├──► /tiles/      MapProxy (disk-cached tiles)
                          ├──► /features    pg_featureserv (OGC API Features)
                          ├──► /qgis        QGIS Server (headless WMS/WFS)
                          ├──► /terrain/    baked quantized-mesh tiles
                          ├──► /3dtiles/    pg2b3dm output
                          ├──► /pointclouds/ py3dtiles output
                          └──► /upload …    upload-api (publish a layer, auth,
                                            geoprocess, QGIS, AI, CMS, ACL)
                                   │
Dagster :3000 ──► ETL assets ──► PostGIS :5432 ◄── MapServer / QGIS Server / featureserv
```

---

## 1. First run

```bash
cd vibegis
cp .env.example .env
# generate every secret — the stack refuses to start on a placeholder (see below)
for k in AUTH_JWT_SECRET AI_KEY_ENCRYPTION_SECRET AI_READONLY_PG_PASSWORD \
         POSTGRES_PASSWORD RENDER_PG_PASSWORD GRAFANA_ADMIN_PASSWORD \
         PGADMIN_DEFAULT_PASSWORD; do
  sed -i "s|^$k=.*|$k=$(openssl rand -hex 32)|" .env
done
sed -i "s|^APP_UID=.*|APP_UID=$(id -u)|; s|^APP_GID=.*|APP_GID=$(id -g)|" .env

docker compose pull          # verify image tags resolve (see note below)
docker compose build         # builds the Dagster/GDAL, upload-api, mapproxy and frontend images
docker compose up -d
bash bin/add-user.sh <user> <pass> admin   # every route needs a login — this is the only way in
```

> **`upload-api` refuses to boot on a default secret.** `check_secrets()` runs at
> import time and raises, naming the `.env` key, if `AUTH_JWT_SECRET`,
> `AI_KEY_ENCRYPTION_SECRET`, `AI_READONLY_PG_PASSWORD` or `POSTGRES_PASSWORD` is
> empty, still contains a `change_me` placeholder, or is too short. If the
> container restart-loops on first run, `docker compose logs upload-api` names
> the variable. This is deliberate: an install that missed a line in `.env` would
> otherwise come up looking healthy with every session forgeable.

> **`APP_UID`/`APP_GID` must own the checkout.** `upload-api`, `qgis-processing`,
> `dagster`, `mapproxy` and `docker-stats-exporter` run as that uid, and they
> write to `mapserver/mapfiles`, `mapserver/rasters`, `pointclouds` and
> `mapproxy`. On a *fresh* install the `sed` above is enough. On an install that
> already ran as root, run `bash bin/fix-ownership.sh` once — Docker applies image
> ownership to a named volume only when it first creates it, so a rebuild alone
> leaves the old volumes unwritable.

| What | Where |
|---|---|
| The app | http://localhost:8080/ |
| MapServer capabilities | http://localhost:8080/mapserver?SERVICE=WMS&REQUEST=GetCapabilities |
| MapProxy demo | http://localhost:8080/tiles/demo/ |
| OGC API Features | http://localhost:8080/features/collections |
| QGIS Server | http://localhost:8080/qgis?MAP=/io/data/demo.qgs&SERVICE=WMS&REQUEST=GetCapabilities |
| Dagster UI | http://localhost:3000/ |
| PostGIS | `localhost:5432` (db `gis`) |
| pgAdmin (optional) | `docker compose --profile tools up -d` → http://localhost:5050/ |

> **Image tags:** the tags in `.env.example` are sensible defaults but were not
> verified against the registry. If `docker compose pull` reports a missing
> tag, check Docker Hub and update the corresponding `*_IMAGE` line in `.env`.
> Nothing else needs to change.

> **The database credentials never appear in a mapfile.** `CONNECTION` omits both
> `user=` and `password=` on purpose; libpq reads them from `PGUSER`/`PGPASSWORD`,
> which compose sets on each reading container from `.env`. The mapfiles are in git
> — don't paste either back in. The renderers connect as `vibegis_render`, a
> SELECT-on-`dwh`-only role, not as the database owner.

## 1a. Installing for a customer

The commands above give you the development stack: HTTP on `:8080`, the SPA served
by the Vite dev server. A real install adds two overlays.

**Certificate.** Put a full chain and its key at `nginx/tls/fullchain.pem` and
`nginx/tls/privkey.pem` (`nginx/tls/` is gitignored). Either the customer supplies
them, or generate with Let's Encrypt on the host:

```bash
sudo certbot certonly --standalone -d gis.example.com
sudo cp /etc/letsencrypt/live/gis.example.com/{fullchain,privkey}.pem nginx/tls/
```

A self-signed pair is fine for an internal trial — the browser warning is the only
difference:

```bash
openssl req -x509 -newkey rsa:2048 -nodes -days 365 \
  -keyout nginx/tls/privkey.pem -out nginx/tls/fullchain.pem -subj "/CN=gis.example.com"
```

**Then bring it up with both overlays:**

```bash
docker compose -f docker-compose.yml \
               -f docker-compose.tls.yml \
               -f docker-compose.prod.yml up -d --build
```

`docker-compose.tls.yml` moves the gateway to 443 with HSTS and redirects `:80`;
`docker-compose.prod.yml` swaps the Vite dev server for the built bundle
(`npm ci` + `vite build`, served by nginx). Leave `COOKIE_SECURE` at its default
`true` — the session cookie is then TLS-only. Set `COOKIE_SECURE=false` **only**
for a plain-HTTP development stack, never for an install.

**Backups.** Nothing is backed up automatically. `bin/backup.sh` writes a
`pg_dump -Fc` of the database plus a tar of the state that is not in Postgres
(`pointclouds/`, `mapserver/rasters/`, the machine-written `uploads.map` and
`mapproxy.yaml`) into `backups/<timestamp>/`; `bin/restore.sh backups/<timestamp>`
puts it back. Put `bin/backup.sh` in the host's cron, and **test the restore once
on the install** — an untested backup is not a backup.

**What is deliberately not covered:** compliance. The hardening in this repo is
technical only. GDPR/DSGVO posture, a DPA with each subprocessor, retention and
deletion policy, personal data in the Loki log store, account export and deletion,
and ISO 27001 / TISAX readiness are all unstarted and must not be claimed. See
`CLAUDE.md`'s "Still open before a real install".

## 2. Loading data

Three ways in, in increasing order of effort:

**From the browser.** Drag a shapefile, GeoPackage, GeoJSON, KML or GML straight onto
the map (or use the upload panel's own file picker). `upload-api` loads it into schema
`dwh`, appends a `LAYER` block to `mapserver/mapfiles/uploads.map`, and it appears in
the layer list on reload — no restart, because MapServer re-reads its mapfile on every
request. A file with more than one layer (a GeoPackage, GML or KML) prompts you to pick
which one before importing. The same panel can publish a table that is already in the
database.

**Via the ETL.** Drop vector files into `mapserver/data/` and materialize the
`raw_vectors` asset in the Dagster UI, or trigger the whole `refresh_all` job from the
app itself — the icon-band button on the map (premium, or an admin/editor
account). Either way it loads everything into schema `dwh`, reprojects to
EPSG:4326 and builds GIST indexes.

**By hand.** Add a `LAYER` block to `mapserver/mapfiles/vibegis.map` (or
`osm-layers.map`) pointing at the table. See `mapserver/CLAUDE.md` for the
conventions and `docs/classification.md` for where a classification rule belongs.

To serve a layer from the tile cache instead of rendering it live, add it to
`mapproxy/mapproxy.yaml` **and** to `HAND_AUTHORED_CACHED_LAYERS` in
`frontend-app/src/wms.ts` (only needed for a hand-authored layer — anything published
through the upload panel gets a cache automatically).

## 3. Terrain and 3D buildings

MapServer cannot generate quantized-mesh, so terrain is baked once:

```bash
# put a GeoTIFF DEM at terrain/dem/dem.tif, then
docker compose --profile terrain run --rm ctb
```

3D buildings come from **pg2b3dm**, which generates 3D Tiles from PostGIS polygons
with a height attribute (table `gis.buildings3d`):

```bash
docker compose --profile tiles3d run --rm pg2b3dm
```

Both are optional. Terrain and 3D tiles are toggles in the layer panel, and the
frontend falls back gracefully when the tiles do not exist yet. Details and DEM
sources: `terrain/README.md`.

## 4. Where things live

```
vibegis/
├─ docker-compose.yml
├─ .env                       ← passwords + image tags (not in git)
├─ CLAUDE.md                  ← operational notes (also read by Claude Code)
├─ postgis/initdb/            ← runs once, on first DB creation only
├─ mapserver/
│  ├─ mapfiles/vibegis.map    ← root mapfile; INCLUDEs the two below
│  ├─ mapfiles/osm-layers.map ← hand-written OSM layers
│  ├─ mapfiles/uploads.map    ← generated by upload-api
│  └─ data/                   ← rasters + drop-zone for the ETL
├─ mapproxy/mapproxy.yaml     ← which layers get cached, and how
├─ qgis-server/projects/      ← .qgs / .qgz files
├─ upload-api/app.py          ← file → PostGIS table → published layer
├─ dagster/
│  ├─ Dockerfile              ← GDAL base + Dagster + GeoPandas
│  └─ defs/__init__.py        ← the ETL assets
├─ terrain/
│  ├─ dem/ tiles/             ← source DEM, generated quantized-mesh
│  └─ build-terrain.sh
├─ bin/build-3d.sh            ← helper around the 3D Tiles build
├─ nginx/
│  ├─ nginx.conf              ← HTTP server block (dev)
│  ├─ nginx-tls.conf          ← HTTPS server block (docker-compose.tls.yml)
│  ├─ locations.conf          ← every route — shared by both of the above
│  ├─ server-settings.conf    ← body limits, gzip, server_tokens
│  └─ security-headers.conf   ← nosniff, DENY, Referrer-Policy, CSP (Report-Only)
├─ bin/backup.sh restore.sh   ← pg_dump -Fc + the file-backed state
├─ bin/fix-ownership.sh       ← one-time chown for the non-root containers
└─ frontend-app/              ← React client (see frontend-app/README.md)
```

## 5. The frontend

React + TypeScript + Resium + Mantine, running as its own container with hot module
reload. Edit anything under `frontend-app/src/` and the browser updates within a
second — no copying files, no hard refresh. The layer list is built from
`GetCapabilities`, so a new mapfile layer shows up on reload without touching the
frontend. See `frontend-app/README.md`.

## 6. Windows / WSL notes

- Keep this folder **inside WSL** (`\\wsl$\Ubuntu\home\<you>\vibegis`), not under
  `C:\Users\`. Bind mounts across the boundary are slow enough to hurt with PostGIS.
- Give Docker enough RAM via `C:\Users\<you>\.wslconfig` — see `wslconfig-example.txt`.
  Apply with `wsl --shutdown`.
- If edits stop triggering hot reload, set `VITE_USE_POLLING=1` on the `frontend`
  service — inotify is unreliable over WSL bind mounts.
- PostGIS and Dagster ports bind to `127.0.0.1` only, so nothing is exposed on your
  network. The gateway on 8080 binds to all interfaces; change it in
  `docker-compose.yml` if you want it local-only too.

## 7. Useful commands

```bash
docker compose logs -f mapserver      # follow one service
docker compose up -d --force-recreate mapserver   # if the container can't see the mapfile
docker compose restart mapserver      # rarely needed; the mapfile is re-read per request
docker compose exec postgis psql -U gis -d gis
docker compose exec frontend npm run typecheck
docker compose down                   # stop, keep data
docker compose down -v                # stop and DELETE the database volume
```
