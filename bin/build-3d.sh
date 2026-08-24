#!/usr/bin/env bash
# Build 3D building tiles end to end, with progress and timings.
#
#   bash bin/build-3d.sh
#
# Every step announces what it is doing, what it expects to take, and how long
# it actually took.
set -euo pipefail

cd "$(dirname "$0")/.."

BLUE=$'\e[36m'; GREEN=$'\e[32m'; YELLOW=$'\e[33m'; RED=$'\e[31m'; OFF=$'\e[0m'

step()  { printf '\n%s==> %s%s\n' "$BLUE" "$1" "$OFF"; }
info()  { printf '    %s\n' "$1"; }
ok()    { printf '%s    ✓ %s%s\n' "$GREEN" "$1" "$OFF"; }
warn()  { printf '%s    ! %s%s\n' "$YELLOW" "$1" "$OFF"; }
die()   { printf '%s    ✗ %s%s\n' "$RED" "$1" "$OFF"; exit 1; }

timed() {                      # timed "label" command...
    local label="$1"; shift
    local t0 t1
    t0=$(date +%s)
    "$@"
    t1=$(date +%s)
    ok "$label — $((t1 - t0))s"
}

TOTAL_START=$(date +%s)

# ---------------------------------------------------------------- preflight
step "Preflight (expect: instant)"

command -v docker >/dev/null || die "docker not found"
[ -f .env ] || die ".env missing — copy .env.example and set the password"

# shellcheck disable=SC1091
set -a; . ./.env; set +a
info "database : ${POSTGRES_DB} as ${POSTGRES_USER}"

docker compose ps --status running --format '{{.Service}}' | grep -qx postgis \
    || die "postgis container is not running — 'docker compose up -d' first"
ok "postgis is up"

BUILDINGS=$(docker compose exec -T postgis psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" \
              -tAc "SELECT count(*) FROM gis.buildings" 2>/dev/null || echo 0)
[ "$BUILDINGS" -gt 0 ] || die "gis.buildings is empty — run the OSM import first"
info "gis.buildings holds ${BUILDINGS} footprints"

# ------------------------------------------------------------------ extrude
step "Extruding footprints into 3D volumes"
info "expect: a few seconds for the default 400-building test scope,"
info "        several minutes if you widened it to all of Munich."
info "progress is printed per batch by the SQL itself."

timed "extrusion" docker compose exec -T postgis \
    psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -v ON_ERROR_STOP=1 \
    -f - < postgis/initdb/06-buildings3d.sql

VOLUMES=$(docker compose exec -T postgis psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" \
            -tAc "SELECT count(*) FROM gis.buildings3d")
[ "$VOLUMES" -gt 0 ] || die "no volumes were produced — check the output above"
info "gis.buildings3d holds ${VOLUMES} volumes"

# ---------------------------------------------------------------- 3D Tiles
step "Generating 3D Tiles with pg2b3dm"
info "expect: ~10-60s for 400 buildings; proportionally longer for more."
info "the image prints its own progress; the krb5 warning is harmless."

mkdir -p frontend-app/public/3dtiles
timed "pg2b3dm" docker compose --profile tiles3d run --rm pg2b3dm

# ------------------------------------------------------------------ verify
step "Verifying output (expect: instant)"

if [ -f frontend-app/public/3dtiles/tileset.json ]; then
    SIZE=$(du -sh frontend-app/public/3dtiles | cut -f1)
    TILES=$(find frontend-app/public/3dtiles -name '*.b3dm' | wc -l)
    ok "tileset.json written — ${TILES} b3dm tiles, ${SIZE} total"
else
    die "tileset.json missing — pg2b3dm did not write output"
fi

CODE=$(curl -s -o /dev/null -w '%{http_code}' http://localhost:8080/3dtiles/tileset.json || echo 000)
if [ "$CODE" = "200" ]; then
    ok "served at http://localhost:8080/3dtiles/tileset.json"
else
    warn "gateway returned HTTP ${CODE} — try: docker compose up -d --force-recreate gateway"
fi

printf '\n%s==> Done in %ss%s\n' "$GREEN" "$(( $(date +%s) - TOTAL_START ))" "$OFF"
printf '    Hard-refresh the app, tick "3D-Gebaeude", fly to Marienplatz.\n'
printf '    Tilt the camera (middle-drag or right-drag) to see the extrusions.\n\n'
