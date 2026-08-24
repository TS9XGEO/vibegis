# Terrain

Cesium needs **quantized-mesh** tiles; MapServer cannot produce them, so they
are baked once with `ctb-quantized-mesh` and then served as static files.

## 1. Get a DEM

Good open sources:

| Source | Resolution | Coverage |
|---|---|---|
| Copernicus DEM GLO-30 | 30 m | global |
| SRTM 1 Arc-Second | 30 m | 60N–56S |
| DGM1 / DGM5 (state open-data portals) | 1–5 m | per German state |

Save it as `terrain/dem/dem.tif` (any GDAL-readable raster; it gets
reprojected to EPSG:4326 automatically).

## 2. Bake

```bash
docker compose --profile terrain run --rm ctb
```

Override the zoom range if the default is too slow:

```bash
docker compose --profile terrain run --rm -e MAX_ZOOM=12 ctb
```

Expect this to take minutes to hours depending on extent and max zoom.

## 3. Verify

`terrain/tiles/layer.json` must exist. Then:

```
curl -I http://localhost:8080/terrain/layer.json
```

Cesium loads it via `CesiumTerrainProvider.fromUrl('/terrain')`.

## Notes

- CTB writes gzip-compressed `.terrain` files; nginx serves them with
  `Content-Encoding: gzip`, which is what Cesium expects. Do not re-gzip.
- 404s outside your DEM extent are normal — Cesium falls back to ellipsoid.
