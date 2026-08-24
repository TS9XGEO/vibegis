#!/usr/bin/env bash
# Bake Cesium quantized-mesh terrain from a DEM.
#
# Usage:  put a GeoTIFF DEM at ./terrain/dem/dem.tif  then run
#           docker compose --profile terrain run --rm ctb
#
# Output: ./terrain/tiles/{layer.json, z/x/y.terrain}  -> served at /terrain/
set -euo pipefail

DEM_DIR=/work/dem
OUT_DIR=/work/tiles
SRC="${DEM_SOURCE:-$DEM_DIR/dem.tif}"
MAX_ZOOM="${MAX_ZOOM:-14}"
MIN_ZOOM="${MIN_ZOOM:-0}"

if [ ! -f "$SRC" ]; then
  echo "ERROR: no DEM found at $SRC"
  echo "Place a GeoTIFF there, e.g. Copernicus GLO-30 or a national DGM."
  exit 1
fi

echo "==> Source DEM"
gdalinfo "$SRC" | head -n 25

WORK="$DEM_DIR/_prepared.tif"

echo "==> Reprojecting to EPSG:4326 and filling nodata"
gdalwarp -t_srs EPSG:4326 -r bilinear -dstnodata -32768 \
         -co TILED=YES -co COMPRESS=DEFLATE -overwrite \
         "$SRC" "$WORK"

mkdir -p "$OUT_DIR"

echo "==> Building terrain tiles (zoom $MIN_ZOOM..$MAX_ZOOM)"
ctb-tile -f Mesh -C -N -o "$OUT_DIR" -s "$MAX_ZOOM" -e "$MIN_ZOOM" "$WORK"

echo "==> Writing layer.json"
ctb-tile -f Mesh -C -N -l -o "$OUT_DIR" -s "$MAX_ZOOM" -e "$MIN_ZOOM" "$WORK"

echo "==> Done. Tiles in ./terrain/tiles"
find "$OUT_DIR" -maxdepth 1 -mindepth 1 | head
