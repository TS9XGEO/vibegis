# WebGIS Docker Stack

PostGIS · MapServer · QGIS Server · Dagster · CesiumJS

```
Browser ──► nginx :8080 ──┬──► /            Cesium frontend
                          ├──► /mapserver   MapServer (WMS/WMTS/OGC API)
                          ├──► /qgis        QGIS Server (headless WMS/WFS)
                          └──► /terrain     baked quantized-mesh tiles
                                   │
Dagster :3000 ──► ETL assets ──► PostGIS :5432 ◄── MapServer / QGIS Server
```

---

## 1. First run

```powershell
cd webgis
copy .env.example .env      # then edit the passwords
docker compose pull         # verify image tags resolve (see note below)
docker compose build        # builds the Dagster/GDAL image
docker compose up -d
```

| What | Where |
|---|---|
| Cesium frontend | http://localhost:8080/ |
| MapServer capabilities | http://localhost:8080/mapserver?SERVICE=WMS&REQUEST=GetCapabilities |
| QGIS Server | http://localhost:8080/qgis?MAP=/io/data/demo.qgs&SERVICE=WMS&REQUEST=GetCapabilities |
| Dagster UI | http://localhost:3000/ |
| PostGIS | `localhost:5432` (db `gis`) |
| pgAdmin (optional) | `docker compose --profile tools up -d` → http://localhost:5050/ |

> **Image tags:** the tags in `.env.example` are sensible defaults but were not
> verified against the registry. If `docker compose pull` reports a missing
> tag, check Docker Hub and update the corresponding `*_IMAGE` line in `.env`.
> Nothing else needs to change.

## 2. Terrain

MapServer cannot generate quantized-mesh, so terrain is baked once:

```powershell
# put a GeoTIFF DEM at terrain/dem/dem.tif, then
docker compose --profile terrain run --rm ctb
```

Details and DEM sources: `terrain/README.md`.

## 3. Loading data

Drop vector files (`.gpkg`, `.shp`, `.geojson`, …) into `mapserver/data/`,
then in the Dagster UI materialize the `raw_vectors` asset. It loads
everything into schema `raw`, reprojects to EPSG:4326, and builds GIST
indexes.

Publish a layer by adding a `LAYER` block to `mapserver/mapfiles/webgis.map`
pointing at the table, then `docker compose restart mapserver`.

## 4. Where things live

```
webgis/
├─ docker-compose.yml
├─ .env                       ← passwords + image tags (not in git)
├─ postgis/initdb/            ← runs once on first DB creation
├─ mapserver/
│  ├─ mapfiles/webgis.map     ← layer definitions
│  └─ data/                   ← rasters + drop-zone for the ETL
├─ qgis-server/projects/      ← .qgs / .qgz files
├─ dagster/
│  ├─ Dockerfile              ← GDAL base + Dagster + GeoPandas
│  └─ defs/__init__.py        ← the ETL assets
├─ terrain/
│  ├─ dem/                    ← your source DEM
│  ├─ tiles/                  ← generated quantized-mesh
│  └─ build-terrain.sh
├─ nginx/nginx.conf           ← single-origin reverse proxy
└─ frontend/index.html        ← Cesium client
```

## 5. The 3D behaviour

`frontend/index.html` switches level of detail by camera height:

| Height | Mode |
|---|---|
| > 300 km | flat ellipsoid globe (cheap, fast rotation) |
| 15–300 km | quantized-mesh terrain from `/terrain` |
| < 15 km | terrain + 3D Tiles buildings (if present) |

Thresholds are the `H_TERRAIN` / `H_3DTILES` constants near the top of the
script. Both heavy providers load lazily and fall back gracefully if the
tiles do not exist yet.

3D buildings are optional and come from **pg2b3dm**, which generates 3D Tiles
from PostGIS polygons with a height attribute. Output goes to
`frontend/3dtiles/`.

## 6. Windows / WSL notes

- Keep this folder **inside WSL** (`\\wsl$\Ubuntu\home\<you>\webgis`), not
  under `C:\Users\`. Bind mounts across the boundary are slow enough to hurt
  with PostGIS.
- Give Docker enough RAM via `C:\Users\Thomas\.wslconfig` — see
  `wslconfig-example.txt`. Apply with `wsl --shutdown`.
- PostGIS and Dagster ports are bound to `127.0.0.1` only, so nothing is
  exposed on your network. The gateway on 8080 is bound to all interfaces;
  change it in `docker-compose.yml` if you want it local-only too.

## 7. Useful commands

```powershell
docker compose logs -f mapserver      # follow one service
docker compose restart mapserver      # after editing the mapfile
docker compose exec postgis psql -U gis -d gis
docker compose down                   # stop, keep data
docker compose down -v                # stop and DELETE the database volume
```
