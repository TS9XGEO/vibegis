"""
Turns geodata into a first-class WMS layer, several ways:
  - POST /upload         read a file (shapefile zip, GeoPackage, GeoJSON, KML,
                         GML) with geopandas/GDAL, reproject to EPSG:4326 and
                         load it into PostGIS schema "dwh" — the same schema
                         and reprojection convention the nightly Dagster asset
                         (dagster/defs/__init__.py: raw_vectors) uses for
                         files dropped into mapserver/data
  - POST /register-table point a layer directly at an existing PostGIS table,
                         no data movement — for data that's already in the DB
  - POST /upload-raster  read a GeoTIFF with the GDAL CLI, reproject to
                         EPSG:4326, tile and add overviews, and drop the
                         normalized file into mapserver/rasters — a TYPE
                         RASTER layer, not a table
  - POST /upload-raster-zip  same as /upload-raster, but for a zip of several
                         single-band rasters (e.g. a Sentinel-2 product) —
                         every band gets published as its own layer immediately
  - POST /raster-composite  combine three already-published single-band
                         raster layers into one RGB layer, "on the fly": a
                         small VRT referencing the three files directly, not
                         a new reprojection/resample pass (every published
                         raster is already EPSG:4326, so they already share
                         one CRS/can be stacked as-is)

Either way, the result is a LAYER block appended to mapfiles/uploads.map
(included from vibegis.map), so it shows up in GetCapabilities — and therefore
the frontend's layer panel — on the very next request (MapServer re-parses
its mapfile per request; see frontend-app/src/wms.ts).

DELETE /layers/{name} reverses any of the three: it always removes the LAYER
block, and optionally drops the underlying table (vector) or deletes the
underlying file (raster). Only layers that live in uploads.map (i.e. ones
created through this API) can be named here — the static layers in
vibegis.map/osm-layers.map are never touched.
"""
import contextvars
import fcntl
import hmac
import json
import logging
import math
import os
import re
import shutil
import subprocess
import tempfile
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
import zipfile
from pathlib import Path
from typing import Annotated, Any, Literal, Union

import bcrypt
import geopandas as gpd
import jwt
import laspy
import numpy as np
import pandas as pd
import pyproj
import yaml
from fastapi import Depends, FastAPI, File, Form, HTTPException, Request, Response, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field
from pythonjsonlogger import jsonlogger
from sqlalchemy import create_engine, text

import ai_agent
import qgis_catalog
import superset_client

# ---------------------------------------------------------------- logging
# JSON to stdout — read with `docker compose logs upload-api` — with a
# request id on every line, so one request's log lines can be grepped
# together even though uvicorn handles requests concurrently. (There is no
# log aggregator any more; a Loki/Promtail/Grafana tier existed and was
# removed as not earning its keep at this scale. This format is aggregator-
# ready if one ever comes back.) The id is also echoed back
# as X-Request-Id and, on a request that arrived through the gateway,
# matches the id nginx already generated for it (see nginx.conf's
# log_format) — one id traces a request gateway-to-backend.
request_id_ctx: contextvars.ContextVar[str] = contextvars.ContextVar("request_id", default="-")


class _RequestIdFilter(logging.Filter):
    def filter(self, record: logging.LogRecord) -> bool:
        record.request_id = request_id_ctx.get()
        return True


def _configure_logging() -> logging.Logger:
    handler = logging.StreamHandler()
    handler.setFormatter(jsonlogger.JsonFormatter("%(asctime)s %(levelname)s %(name)s %(request_id)s %(message)s"))
    handler.addFilter(_RequestIdFilter())
    root = logging.getLogger()
    root.handlers = [handler]
    root.setLevel(logging.INFO)
    return logging.getLogger("upload-api")


log = _configure_logging()

# ------------------------------------------------------------ secret guard
#
# .env.example ships `change_me_please...` placeholders for every secret, and
# nothing used to check them. An operator who copies the example and misses one
# line gets a stack that boots and looks healthy while anyone who has seen this
# repo can forge an admin session cookie. Refusing to start is the only failure
# mode that cannot be missed.
#
# Only the secrets this process actually sees are checked here. pgAdmin's own
# admin password lives in its container's environment; it is loopback-bound
# and behind the `tools` profile, and .env.example calls it out.
_PLACEHOLDER_MARKERS = ("change_me", "change-me", "changeme", "please_use_a_long_random_string")

# env var -> (the .env key an operator actually edits, minimum length).
# 32 for anything cryptographic — .env.example documents `openssl rand -hex 32`
# for all three. The database password is a password, not a key, so it gets a
# password-shaped floor instead.
_REQUIRED_SECRETS = {
    "AUTH_JWT_SECRET": ("AUTH_JWT_SECRET", 32),
    "AI_KEY_ENCRYPTION_SECRET": ("AI_KEY_ENCRYPTION_SECRET", 32),
    "AI_READONLY_PG_PASSWORD": ("AI_READONLY_PG_PASSWORD", 32),
    "PGPASSWORD": ("POSTGRES_PASSWORD", 12),
}


def check_secrets() -> None:
    problems = []
    for var, (env_key, min_len) in _REQUIRED_SECRETS.items():
        value = os.environ.get(var, "")
        lowered = value.lower()
        if not value:
            problems.append(f"{env_key} is not set")
        elif any(marker in lowered for marker in _PLACEHOLDER_MARKERS):
            problems.append(f"{env_key} is still the placeholder from .env.example")
        elif len(value) < min_len:
            problems.append(f"{env_key} is {len(value)} characters, needs at least {min_len}")
    if problems:
        raise RuntimeError(
            "Refusing to start — insecure secrets in .env:\n  - "
            + "\n  - ".join(problems)
            + "\n\nGenerate each one with: openssl rand -hex 32"
        )


check_secrets()


app = FastAPI()
app.add_middleware(
    CORSMiddleware,
    allow_origins=[f"http://localhost:{os.environ.get('GATEWAY_PORT', '8080')}"],
    allow_credentials=True,
    allow_methods=["GET", "POST", "PATCH", "DELETE"],
    allow_headers=["Content-Type"],
)


@app.middleware("http")
async def request_id_middleware(request: Request, call_next):
    rid = request.headers.get("x-request-id") or str(uuid.uuid4())
    token = request_id_ctx.set(rid)
    try:
        response = await call_next(request)
        response.headers["X-Request-Id"] = rid
        # Must stay inside the try: the reset below clears the context var
        # that _RequestIdFilter reads, so logging after it recorded
        # "request_id": "-" on every single access line — the one line per
        # request that exists to be correlated.
        log.info(
            "request",
            extra={"http_method": request.method, "http_path": request.url.path, "http_status": response.status_code},
        )
        return response
    finally:
        request_id_ctx.reset(token)

ALLOWED_EXT = {".zip", ".gpkg", ".geojson", ".json", ".kml", ".gml"}
MAX_BYTES = 2048 * 1024 * 1024  # 2 GB — matches nginx's client_max_body_size for /upload

# NOTE: every upload route here is a plain `def`, never `async def`, and reads
# its UploadFile through the synchronous `file.file` handle rather than
# `await file.read()`. That is deliberate and load-bearing.
#
# These handlers do seconds-to-minutes of *blocking* work — geopandas/OGR
# reads, gdalwarp/gdaladdo, py3dtiles (up to POINTCLOUD_CONVERT_TIMEOUT). In an
# `async def` that work runs directly on the event loop, so uvicorn (one worker
# here, no --workers) can serve nothing else until it finishes — including
# GET /auth/verify, which nginx calls on *every* gated request for mapserver,
# mapproxy, pg_featureserv, qgis, /terrain, /3dtiles and /pointclouds. A single
# large point-cloud upload would therefore freeze the whole map for every user
# for the duration of the conversion.
#
# Declared sync, Starlette runs the handler in its threadpool instead and the
# event loop stays free. Do not "modernize" these back to `async def`.

RASTER_ALLOWED_EXT = {".tif", ".tiff"}
# Not /data/rasters: /data is itself a read-only mount here (and read-only in
# mapserver too), and a nested bind mount can't be created under an
# already-read-only parent — see docker-compose.yml.
RASTERS_DIR = Path("/rasters")

POINTCLOUD_ALLOWED_EXT = {".las", ".laz"}
# One directory per published layer, named for the layer itself. Served
# straight off disk by nginx at /pointclouds/ — MapServer is not involved at
# any point, since it cannot render 3D Tiles. See read_pointcloud_layers().
POINTCLOUDS_DIR = Path("/pointclouds")
# py3dtiles lives in its own virtualenv (see upload-api/Dockerfile) because it
# pins numpy<2.4 and pulls numba, which will not co-resolve with the
# geopandas stack /upload needs. Called by absolute path, never imported.
PY3DTILES_BIN = "/opt/py3dtiles/bin/py3dtiles"
# Cesium 3D Tiles are positioned by an ECEF root transform, so the tileset
# has to be written in EPSG:4978 regardless of what the source LAS uses.
POINTCLOUD_SRS_OUT = "4978"
# Slightly under nginx's 600s proxy_read_timeout for /upload-pointcloud, so a
# conversion that runs long fails with this route's own actionable message
# rather than as a bare gateway timeout with nothing to act on.
POINTCLOUD_CONVERT_TIMEOUT = 570

# Uploaded files awaiting a layer choice (see list_spatial_layers()) live
# here between the initial /upload call and the follow-up one that names the
# chosen layer — keyed by a uuid4 token so a 2GB file never has to be sent
# twice. UPLOAD_TOKEN_MAX_AGE bounds how long an abandoned choice lingers;
# swept inline on every /upload call rather than via a scheduled job, which
# is plenty for a low-traffic internal tool.
UPLOAD_TMP_DIR = Path(tempfile.gettempdir()) / "vibegis-uploads"
UPLOAD_TOKEN_MAX_AGE = 60 * 60  # 1h

MAPFILE_DIR = Path("/mapfiles")
UPLOADS_MAP = MAPFILE_DIR / "uploads.map"

# MapProxy's tile cache, mounted here so a styling change can drop the tiles it
# invalidates. See purge_layer_cache(); absent mount = nothing cached yet.
MAPPROXY_CACHE_DIR = Path("/mapproxy-cache")

# mapproxy/ on the host, mounted read-write here and read-only into mapproxy
# itself. See generate_mapproxy_config().
MAPPROXY_CONFIG_DIR = Path("/mapproxy-config")
MAPPROXY_YAML = MAPPROXY_CONFIG_DIR / "mapproxy.yaml"

# Sentinel for "is the mapfile volume actually mounted?". vibegis.map is the root
# mapfile, ships with the repo and is never written by this service, so it is
# present whenever the bind mount is live.
#
# This exists because a bind mount can die while still looking healthy: Docker
# keeps reporting the right Source, but the container sees an empty directory.
# Without this check every write here still "succeeds" — append_layer_block()
# creates uploads.map from scratch in the void, the API returns 200, and the
# layer never reaches MapServer, which reads the real directory. Reads are just
# as bad: /layers answers 200 with an empty list, indistinguishable from having
# no layers. Fail loudly instead; the fix is
# `docker compose up -d --force-recreate upload-api`.
MOUNT_SENTINEL = MAPFILE_DIR / "vibegis.map"

# Same reasoning as MOUNT_SENTINEL, for the separate mapserver/rasters bind
# mount POST /upload-raster writes into: .gitkeep ships with the repo and is
# never written by this service, so its absence proves the mount is dead
# rather than merely empty.
RASTER_MOUNT_SENTINEL = RASTERS_DIR / ".gitkeep"

# Same reasoning again for the pointclouds/ bind mount. This one matters even
# more than the raster case: a point-cloud layer's only proof of existence on
# disk is its tileset directory, and the gateway serves that directory
# read-only from its own mount of the same host path — so a dead mount here
# means a published layer whose tiles 404 for every user.
POINTCLOUD_MOUNT_SENTINEL = POINTCLOUDS_DIR / ".gitkeep"


def check_mapfile_volume() -> None:
    if not MOUNT_SENTINEL.exists():
        raise HTTPException(
            503,
            f"Mapfile volume not mounted: {MOUNT_SENTINEL} is missing, so nothing "
            "written here would reach MapServer. Recreate the container: "
            "docker compose up -d --force-recreate upload-api",
        )


def check_raster_volume() -> None:
    if not RASTER_MOUNT_SENTINEL.exists():
        raise HTTPException(
            503,
            f"Raster volume not mounted: {RASTER_MOUNT_SENTINEL} is missing, so nothing "
            "written here would reach MapServer. Recreate the container: "
            "docker compose up -d --force-recreate upload-api",
        )


def check_pointcloud_volume() -> None:
    if not POINTCLOUD_MOUNT_SENTINEL.exists():
        raise HTTPException(
            503,
            f"Point cloud volume not mounted: {POINTCLOUD_MOUNT_SENTINEL} is missing, so "
            "nothing written here would be served by the gateway. Recreate the container: "
            "docker compose up -d --force-recreate upload-api",
        )

HEADER = (
    "# Appended to by upload-api (see /vibegis/upload-api/app.py) — every upload\n"
    "# or table registration adds one LAYER block here. Do not hand-edit while\n"
    "# the service is running; it locks the file, but a concurrent manual edit\n"
    "# could still race.\n"
)

GEOM_FAMILY = {
    "Point": "POINT", "MultiPoint": "POINT",
    "LineString": "LINE", "MultiLineString": "LINE",
    "Polygon": "POLYGON", "MultiPolygon": "POLYGON",
}
ST_GEOM_FAMILY = {
    "ST_Point": "POINT", "ST_MultiPoint": "POINT",
    "ST_LineString": "LINE", "ST_MultiLineString": "LINE",
    "ST_Polygon": "POLYGON", "ST_MultiPolygon": "POLYGON",
}

DEFAULT_STYLE = {
    "POINT": '    STYLE\n      SYMBOL "circle"\n      SIZE 9\n      COLOR 255 196 40\n'
             "      OUTLINECOLOR 40 30 10\n      WIDTH 1.5\n    END\n",
    "LINE": "    STYLE\n      COLOR 255 110 60\n      WIDTH 2.4\n      LINECAP ROUND\n    END\n",
    # POLYGON is built by default_style() instead: its outline width is
    # per-layer configurable, so it cannot be a constant.
}

POLYGON_FILL = "90 170 230"

# Every polygon layer gets a real border around each feature unless a layer
# says otherwise — adjacent polygons in the same class are indistinguishable
# without one. 0 turns it off for a layer.
DEFAULT_POLYGON_OUTLINE_WIDTH = 0.6
MAX_POLYGON_OUTLINE_WIDTH = 10.0

# The outline is a darkened version of the fill rather than a fixed colour, so
# it reads as that class's own border in a categorized/graduated layer instead
# of a grid of black lines over everything. legend.ts's darkenHex() applies the
# identical factor — the mapfile and SLD renderers have to agree, or turning on
# an attribute filter visibly restyles the layer.
POLYGON_OUTLINE_DARKEN = 0.55

HEX_RE = re.compile(r"#[0-9a-fA-F]{6}")


def hex_to_rgb(color: str) -> str:
    """'#e07a5f' -> '224 122 95', the triple MapServer's COLOR wants. Validates
    rather than trusting the request: ClassDef.color is a free-form str."""
    if not HEX_RE.fullmatch(color or ""):
        raise HTTPException(400, f"Invalid colour: '{color}' (expected #rrggbb)")
    n = int(color[1:], 16)
    return f"{(n >> 16) & 255} {(n >> 8) & 255} {n & 255}"


def fmt_num(x: float) -> str:
    """50.0 -> '50'. Keeps generated break labels identical to the ones the
    classification editor shows, which formats plain JS numbers."""
    return str(int(x)) if float(x).is_integer() else str(x)


def darken_rgb(rgb: str, factor: float = POLYGON_OUTLINE_DARKEN) -> str:
    """'90 170 230' -> '49 93 126'. Mirrors legend.ts's darkenHex()."""
    r, g, b = (int(v) for v in rgb.split())
    return f"{int(r * factor)} {int(g * factor)} {int(b * factor)}"


def polygon_outline(rgb: str, outline_width: float | None) -> str:
    """The OUTLINECOLOR/WIDTH fragment of a polygon STYLE.

    Returns "" for a width of 0: MapServer draws no outline when OUTLINECOLOR
    is absent, whereas WIDTH 0 with a colour still renders a hairline.
    """
    width = DEFAULT_POLYGON_OUTLINE_WIDTH if outline_width is None else float(outline_width)
    if width <= 0:
        return ""
    return f"  OUTLINECOLOR {darken_rgb(rgb)}  WIDTH {fmt_num(width)}"


def default_style(ms_type: str, outline_width: float | None = None) -> str:
    """The STYLE for an *unclassified* layer. Only polygons vary (their outline
    width is per-layer configurable), so points and lines still come straight
    from the DEFAULT_STYLE constant."""
    if ms_type != "POLYGON":
        return DEFAULT_STYLE[ms_type]
    lines = ["    STYLE", f"      COLOR {POLYGON_FILL}", "      OPACITY 55"]
    width = DEFAULT_POLYGON_OUTLINE_WIDTH if outline_width is None else float(outline_width)
    if width > 0:
        lines += [f"      OUTLINECOLOR {darken_rgb(POLYGON_FILL)}", f"      WIDTH {fmt_num(width)}"]
    lines.append("    END")
    return "\n".join(lines) + "\n"


def classified_style(ms_type: str, color: str, size: float | None = None,
                     outline_width: float | None = None) -> str:
    """
    The STYLE for one class of a user classification.

    These numbers deliberately mirror symbolizerFor() in
    frontend-app/src/legend.ts, because the same classification is rendered two
    ways: from these CLASS blocks on the cached path, and from an SLD when an
    attribute filter is active (MapServer rejects FILTER together with
    SLD_BODY, so a filter has to go through the SLD). If the two drift, adding
    a filter visibly restyles the layer. DEFAULT_STYLE above is a different
    thing — the look of an *unclassified* layer, which has no SLD counterpart.

    `size` is the user-configurable point size / line width from the
    classification editor (None = the same defaults this always used —
    matches symbolizerFor()'s `size ?? 10` / `size ?? 2.2`). Meaningless for
    polygons, which have no size control — they take `outline_width`
    instead, the per-layer border thickness (None = DEFAULT_POLYGON_OUTLINE_WIDTH,
    0 = no border).
    """
    rgb = hex_to_rgb(color)
    if ms_type == "POLYGON":
        # The outline used to be OUTLINECOLOR {rgb} — the fill colour, i.e.
        # invisible. It is a darkened shade at a per-layer width now, so
        # neighbouring polygons in the same class can be told apart.
        return f"    STYLE  COLOR {rgb}{polygon_outline(rgb, outline_width)}  END\n"
    if ms_type == "LINE":
        width = size if size is not None else 2.2
        return f"    STYLE  COLOR {rgb}  WIDTH {width}  LINECAP ROUND  END\n"
    point_size = size if size is not None else 10
    return f'    STYLE  SYMBOL "circle"  SIZE {point_size}  COLOR {rgb}  OUTLINECOLOR 255 255 255  WIDTH 1  END\n'


def build_class_blocks(classification: dict | None, ms_type: str, title: str,
                       outline_width: float | None = None) -> str:
    """
    Compiles a stored classification into MapServer CLASSITEM + CLASS blocks —
    the heart of making a classified layer cacheable. A classification used to
    exist only in layer_config.json and reach the map as a per-request
    SLD_BODY, which MapProxy cannot cache (it pins one fixed request per
    layer). Emitted here it becomes the layer's own default styling, so the
    cached path renders it like any other layer.

    Indentation is load-bearing: parse_layers() ends a block at an END in
    column 0, so every END below must stay indented or the next
    remove_layer_block() truncates the file mid-layer.
    """
    if not classification:
        return ("  CLASS\n" f'    NAME "{mapfile_escape(title)}"\n'
                f"{default_style(ms_type, outline_width)}" "  END\n")

    mode = classification.get("mode")
    size = classification.get("size")
    if mode == "single":
        return (
            "  CLASS\n"
            f'    NAME "{mapfile_escape(title)}"\n'
            f"{classified_style(ms_type, classification.get('color'), size, outline_width)}"
            "  END\n"
        )

    column = check_identifier(classification.get("column") or "", "classification column")
    out = f'  CLASSITEM   "{column}"\n'

    if mode == "categorized":
        for c in classification.get("classes", []):
            value = str(c.get("value", ""))
            label = (c.get("label") or "").strip() or value
            out += (
                "  CLASS\n"
                f'    NAME "{mapfile_escape(label)}"\n'
                # Quoted-string form only. A user-supplied value must never
                # reach the regex (/.../) form, where it would be a pattern.
                f'    EXPRESSION "{mapfile_escape(value)}"\n'
                f"{classified_style(ms_type, c.get('color'), size, outline_width)}"
                "  END\n"
            )
        return out

    if mode == "graduated":
        for b in classification.get("breaks", []):
            lo, hi = fmt_num(b.get("min", 0)), fmt_num(b.get("max", 0))
            label = (b.get("label") or "").strip() or f"{lo} – {hi}"
            out += (
                "  CLASS\n"
                f'    NAME "{mapfile_escape(label)}"\n'
                # Numeric comparison needs bare [brackets]; "[quoted]" would
                # compare as strings — see docs/classification.md.
                f"    EXPRESSION ([{column}] >= {lo} AND [{column}] < {hi})\n"
                f"{classified_style(ms_type, b.get('color'), size, outline_width)}"
                "  END\n"
            )
        return out

    raise HTTPException(400, f"Unknown classification mode: '{mode}'")

NUMERIC_SQL_TYPES = {
    "smallint", "integer", "bigint", "decimal", "numeric",
    "real", "double precision", "smallserial", "serial", "bigserial",
}

IDENT_RE = re.compile(r"[a-zA-Z_][a-zA-Z0-9_]*")
LAYER_RE = re.compile(r"LAYER\n(.*?)\nEND\n", re.DOTALL)
NAME_RE = re.compile(r'NAME\s+"([^"]*)"')
TYPE_RE = re.compile(r"^\s*TYPE\s+(\w+)", re.MULTILINE)
OWS_TITLE_RE = re.compile(r'"ows_title"\s+"((?:[^"\\]|\\.)*)"')
DATA_RE = re.compile(r'DATA\s+"(\w+)\s+FROM\s+(\w+)\.(\w+)\s+USING\s+UNIQUE\s+(\w+)\s+USING\s+SRID=(\d+)"')
# A raster LAYER's DATA line is just a file path, not the POSTGIS shape above.
DATA_RASTER_RE = re.compile(r'DATA\s+"([^"]+)"')
OWS_KEYWORDLIST_RE = re.compile(r'"ows_keywordlist"\s+"([^"]*)"')


def keyword_value(block: str, prefix: str) -> str | None:
    """Backend-side mirror of wms.ts's keywordValue() — reads a value back
    out of a LAYER block's own ows_keywordlist, e.g. "bands:3" out of
    "geomtype:raster,bands:3". Nothing on the backend needed to read its own
    keywordlist back until /raster-composite needed to check a candidate
    layer's band count without re-probing its file."""
    m = OWS_KEYWORDLIST_RE.search(block)
    if not m:
        return None
    for part in m.group(1).split(","):
        part = part.strip()
        if part.startswith(f"{prefix}:"):
            return part[len(prefix) + 1:] or None
    return None


def pg_env() -> dict:
    return {
        "host": os.environ.get("PGHOST", "postgis"),
        "dbname": os.environ["PGDATABASE"],
        "user": os.environ["PGUSER"],
        "password": os.environ["PGPASSWORD"],
    }


def engine():
    e = pg_env()
    url = f"postgresql+psycopg://{e['user']}:{e['password']}@{e['host']}:5432/{e['dbname']}"
    return create_engine(url)


# ------------------------------------------------------------------ auth
#
# JWT-in-a-cookie: stateless, no sessions table. Accepted trade-off: a leaked
# token stays valid until it expires (JWT_EXPIRY_SECONDS), since there is no
# server-side revocation — fine for a small internal tool, not for one that
# needs "log out everywhere" or an admin kill-switch on a single session.
# SameSite=Lax doubles as the CSRF defense: a cross-site page's fetch()/XHR
# never carries the cookie, only a top-level navigation would.

JWT_SECRET = os.environ["AUTH_JWT_SECRET"]
JWT_ALG = "HS256"
JWT_EXPIRY_SECONDS = 60 * 60 * 10  # 10h
COOKIE_NAME = "vibegis_session"

# Marks the session cookie Secure, so the browser never sends it over plain
# HTTP. Defaults to on: an install that forgets to set it should fail closed
# (the cookie simply is not sent) rather than leak sessions in the clear. Set
# COOKIE_SECURE=false only for a local plain-HTTP dev stack reached by IP —
# http://localhost is exempt from the Secure rule in every current browser, so
# the default works for local development as it is.
COOKIE_SECURE = os.environ.get("COOKIE_SECURE", "true").strip().lower() not in ("0", "false", "no")


def ensure_users_table() -> None:
    with engine().begin() as conn:
        conn.execute(text(
            "CREATE TABLE IF NOT EXISTS userdb.users ("
            "id serial PRIMARY KEY, username text NOT NULL UNIQUE, "
            "password_hash text NOT NULL, "
            "role text NOT NULL CHECK (role IN ('admin', 'editor', 'viewer')), "
            "created_at timestamptz NOT NULL DEFAULT now())"
        ))
        # Widens an existing two-value CHECK for any environment that hasn't
        # run bin/migrate-editor-role.sql by hand yet. 'editor': full
        # analysis/editing capability (bypasses subscription_tier and layer-
        # ownership checks, same as admin — see require_tier()/
        # require_owner_or_admin()) but still blocked from the strictly-
        # admin-only routes (user accounts, groups/grants), which check
        # role == "admin" directly and are unaffected by this.
        conn.execute(text("ALTER TABLE userdb.users DROP CONSTRAINT IF EXISTS users_role_check"))
        conn.execute(text(
            "ALTER TABLE userdb.users ADD CONSTRAINT users_role_check CHECK (role IN ('admin', 'editor', 'viewer'))"
        ))
        # Self-healing on startup for any environment that hasn't run
        # bin/migrate-tiers.sql by hand yet — same idempotent-DDL-on-a-live-
        # database pattern this function already used for the old `premium`
        # column. subscription_tier replaces it outright (four tiers, not a
        # boolean); an existing `premium=true` row becomes 'premium' before
        # the column is dropped, so nobody silently loses paid access.
        conn.execute(text(
            "ALTER TABLE userdb.users ADD COLUMN IF NOT EXISTS subscription_tier text "
            "NOT NULL DEFAULT 'free' CHECK (subscription_tier IN ('free', 'pro', 'premium'))"
        ))
        conn.execute(text("ALTER TABLE userdb.users ADD COLUMN IF NOT EXISTS email text"))
        if conn.execute(text(
            "SELECT 1 FROM information_schema.columns "
            "WHERE table_schema = 'userdb' AND table_name = 'users' AND column_name = 'premium'"
        )).first():
            conn.execute(text("UPDATE userdb.users SET subscription_tier = 'premium' WHERE premium"))
            conn.execute(text("ALTER TABLE userdb.users DROP COLUMN premium"))
        conn.execute(text(
            "CREATE TABLE IF NOT EXISTS configdb.layer_owners ("
            "layer_name text PRIMARY KEY, "
            "owner_user_id bigint NOT NULL REFERENCES userdb.users(id) ON DELETE CASCADE, "
            "created_at timestamptz NOT NULL DEFAULT now())"
        ))
        conn.execute(text(
            "CREATE TABLE IF NOT EXISTS configdb.groups (id bigserial PRIMARY KEY, name text UNIQUE NOT NULL)"
        ))
        conn.execute(text(
            "CREATE TABLE IF NOT EXISTS configdb.group_members ("
            "group_id bigint NOT NULL REFERENCES configdb.groups(id) ON DELETE CASCADE, "
            "user_id bigint NOT NULL REFERENCES userdb.users(id) ON DELETE CASCADE, "
            "PRIMARY KEY (group_id, user_id))"
        ))
        conn.execute(text(
            "CREATE TABLE IF NOT EXISTS configdb.layer_grants ("
            "id bigserial PRIMARY KEY, layer_name text NOT NULL, "
            "principal_type text NOT NULL CHECK (principal_type IN ('user', 'group')), "
            "principal_id bigint NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), "
            "UNIQUE (layer_name, principal_type, principal_id))"
        ))


def ensure_pointcloud_table() -> None:
    """The registry of published point-cloud layers.

    A point cloud is the one published layer with no MapServer LAYER block —
    MapServer cannot render 3D Tiles — so read_layers() cannot see it and this
    table is its only record. In configdb rather than a JSON sidecar next to
    the tileset for two reasons: this repo has been moving the other way for a
    while (layer_config.json -> configdb.layer_config), and /layers already
    has to hit Postgres for the ACL regardless, so a sidecar would only add an
    N-file read per call.

    The tileset directory is always POINTCLOUDS_DIR / layer_name, derived from
    the primary key — never a stored free-form path, so a row can never point
    the delete path at something outside the mount.
    """
    with engine().begin() as conn:
        conn.execute(text("CREATE SCHEMA IF NOT EXISTS configdb"))
        conn.execute(text(
            "CREATE TABLE IF NOT EXISTS configdb.point_clouds ("
            "layer_name text PRIMARY KEY, "
            "title text NOT NULL, "
            "point_count bigint, "
            "srs_in text, "
            "west double precision, south double precision, "
            "east double precision, north double precision, "
            "has_color boolean NOT NULL DEFAULT false, "
            "has_classification boolean NOT NULL DEFAULT false, "
            "created_at timestamptz NOT NULL DEFAULT now())"
        ))


class LoginBody(BaseModel):
    username: str
    password: str


class CreateUserBody(BaseModel):
    username: str
    password: str
    role: Literal["admin", "editor", "viewer"]
    subscription_tier: Literal["free", "pro", "premium"] = "free"


# Ranked so require_tier() can do a single numeric comparison. There is no
# 'guest' rank any more — self-service signup and anonymous guest sessions
# were removed for the per-customer deployment model, so every session now
# belongs to a real userdb.users row. An old cookie carrying tier 'guest'
# falls through require_tier()'s `.get(..., -1)` and is denied, which is the
# behaviour we want while those cookies expire.
TIER_RANK = {"free": 1, "pro": 2, "premium": 3}


def issue_token(user_id: int | str, username: str, role: str, tier: str) -> str:
    payload = {
        "sub": str(user_id), "username": username, "role": role, "tier": tier,
        "exp": int(time.time()) + JWT_EXPIRY_SECONDS,
    }
    return jwt.encode(payload, JWT_SECRET, algorithm=JWT_ALG)


def require_login(request: Request) -> dict:
    token = request.cookies.get(COOKIE_NAME)
    if not token:
        raise HTTPException(401, "Nicht angemeldet")
    try:
        return jwt.decode(token, JWT_SECRET, algorithms=[JWT_ALG])
    except jwt.PyJWTError:
        raise HTTPException(401, "Sitzung ungültig oder abgelaufen")


def require_role(role: str):
    def _dep(user: dict = Depends(require_login)) -> dict:
        if user.get("role") != role:
            raise HTTPException(403, f"Erfordert Rolle '{role}'")
        return user
    return _dep


def is_privileged_role(user: dict) -> bool:
    """Admin and editor both bypass subscription_tier and layer-ownership
    checks — 'editor' is full analysis/editing capability without paying for
    a tier, deliberately NOT a bypass of require_role("admin") itself, which
    is what still blocks it from the strictly-admin-only routes (user
    accounts, groups/grants — see those routes' own Depends)."""
    return user.get("role") in ("admin", "editor")


def require_tier(min_tier: str):
    """Admin/editor always pass regardless of tier; everyone else needs
    TIER_RANK[their tier] >= TIER_RANK[min_tier]. An unknown tier ranks -1
    and is therefore denied."""
    def _dep(user: dict = Depends(require_login)) -> dict:
        if is_privileged_role(user):
            return user
        if TIER_RANK.get(user.get("tier"), -1) < TIER_RANK[min_tier]:
            raise HTTPException(403, f"Erfordert mindestens Tarif '{min_tier}'")
        return user
    return _dep


# Was its own bespoke check; now just the 'premium' tier by another name —
# every existing `Depends(require_etl_access)` call site is unchanged.
require_etl_access = require_tier("premium")


def require_privileged(user: dict = Depends(require_login)) -> dict:
    """Admin or editor — full analysis/editing/content capability, but NOT
    the strictly-admin-only routes (user accounts, groups/grants), which use
    require_role("admin") directly instead and are unaffected by this."""
    if not is_privileged_role(user):
        raise HTTPException(403, "Erfordert Admin- oder Editor-Rolle")
    return user


@app.post("/login")
def login(body: LoginBody, response: Response):
    with engine().begin() as conn:
        row = conn.execute(
            text(
                "SELECT id, username, password_hash, role, subscription_tier "
                "FROM userdb.users WHERE username = :u"
            ),
            {"u": body.username},
        ).first()
    if not row or not bcrypt.checkpw(body.password.encode(), row.password_hash.encode()):
        raise HTTPException(401, "Ungültiger Benutzername oder Passwort")
    response.set_cookie(
        COOKIE_NAME, issue_token(row.id, row.username, row.role, row.subscription_tier),
        httponly=True, secure=COOKIE_SECURE, samesite="lax", path="/", max_age=JWT_EXPIRY_SECONDS,
    )
    return {"username": row.username, "role": row.role, "tier": row.subscription_tier}


@app.post("/logout")
def logout(response: Response):
    response.delete_cookie(COOKIE_NAME, path="/")
    return {"ok": True}


# ------------------------------------------- per-layer gateway authorization
#
# nginx's auth_request used to ask only "is there a valid session", which meant
# /mapserver, /tiles/, /features and /pointclouds/ served any layer to anyone
# logged in — visible_layers_for() governed what /layers *offered*, not what
# those backends would hand over to a caller who already knew a layer's name.
# The gateway now forwards the original request URI (nginx.conf sets
# X-Original-URI on the subrequest) and everything below decides, in one place,
# which layers it names and whether this user may have them.
#
# Doing the parsing here rather than in nginx is deliberate: the layer arrives
# in four different shapes across those four routes, and that is nginx rewrite
# rules versus a readable Python function.

_LAYER_QUERY_KEYS = {"layers", "layer", "query_layers", "typename", "typenames"}

# Mapfiles that ship with the repo rather than being written by upload-api.
# A layer defined in one of these has no layer_grants record and never can —
# it is installer-curated base data (basemaps, reference layers), so it is
# available to any session, which is exactly its status today. Both files are
# currently free of LAYER blocks, so the set is empty and the check below is
# strict; it exists so that adding a hand-authored base layer later does not
# silently become a 403 nobody can explain.
HAND_AUTHORED_MAPFILES = ("vibegis.map", "osm-layers.map")

_LAYER_KEYWORD_RE = re.compile(r"^\s*LAYER\s*$", re.I)
_LAYER_NAME_RE = re.compile(r'^NAME\s+"([^"]+)"', re.I)


def _layer_names_in(mapfile_text: str) -> set[str]:
    """The first NAME inside each LAYER block. Not a full mapfile parse — a
    LAYER's own NAME always precedes its CLASSes, which is all this needs."""
    names: set[str] = set()
    in_layer = False
    for line in mapfile_text.splitlines():
        stripped = line.strip()
        if _LAYER_KEYWORD_RE.match(stripped):
            in_layer = True
            continue
        if in_layer:
            m = _LAYER_NAME_RE.match(stripped)
            if m:
                names.add(m.group(1))
                in_layer = False
    return names


def hand_authored_layers() -> set[str]:
    out: set[str] = set()
    for filename in HAND_AUTHORED_MAPFILES:
        path = MAPFILE_DIR / filename
        try:
            out |= _layer_names_in(path.read_text())
        except OSError:
            continue
    return out


# One auth_request fires per tile, and this process runs a single uvicorn
# worker (see the note above the upload routes) — resolving the ACL from
# Postgres and the mapfile on every one of those would make the map slower than
# it was before it was secure. Short TTL rather than a long one plus perfect
# invalidation: 30s of stale visibility after an admin changes a grant is
# acceptable, silently serving a revoked layer for an hour is not.
VISIBILITY_TTL_SECONDS = 30
_visibility_cache: dict[str, tuple[float, set[str], set[tuple[str, str]]]] = {}
_visibility_lock = threading.Lock()


def invalidate_visibility_cache() -> None:
    with _visibility_lock:
        _visibility_cache.clear()


def visible_layer_index(user: dict) -> tuple[set[str], set[tuple[str, str]]]:
    """(layer names, {(schema, table)}) this user may see, memoized briefly.

    The table set is what /features needs: pg_featureserv addresses a
    collection as `schema.table`, not by layer name.
    """
    key = f"{user.get('sub')}|{user.get('role')}|{user.get('tier')}"
    now = time.monotonic()
    with _visibility_lock:
        hit = _visibility_cache.get(key)
        if hit is not None and hit[0] > now:
            return hit[1], hit[2]

    visible = visible_layers_for(user, all_layers())
    names = {l["name"] for l in visible} | hand_authored_layers()
    tables = {
        (l["schema"], l["table"]) for l in visible if l.get("schema") and l.get("table")
    }
    with _visibility_lock:
        _visibility_cache[key] = (now + VISIBILITY_TTL_SECONDS, names, tables)
    return names, tables


def _query_layer_names(query_string: str) -> set[str]:
    """Layer names named by a WMS/WFS query string — LAYERS/LAYER/QUERY_LAYERS
    for WMS and WMTS, TYPENAME(S) for WFS, each comma-separated. Parameter
    names are case-insensitive in OGC services, so match them lowercased."""
    out: set[str] = set()
    for key, values in urllib.parse.parse_qs(query_string, keep_blank_values=True).items():
        if key.lower() not in _LAYER_QUERY_KEYS:
            continue
        for value in values:
            for part in value.split(","):
                part = part.strip()
                if part:
                    out.add(part)
    return out


def authorize_gateway_request(original_uri: str, user: dict) -> None:
    """403 unless every layer the original request names is one this user may
    see. Silent (returns None) when the request names no layer at all.

    Deliberately allowed through without naming a layer:
      * GetCapabilities — the frontend builds its layer list from it. It still
        lists every layer's *name*; the frontend intersects that with /layers,
        and the data itself is now gated, so what leaks is a name, not content.
        Filtering the capabilities XML per user would mean rewriting the
        response body in this process on every call.
      * /terrain/ and /3dtiles/ — single installation-wide assets with no
        per-layer identity to check.
      * /features/collections (the listing) and /features/functions/... (the
        search function) — neither addresses a layer's data.
    """
    if not original_uri:
        return
    path, _, query_string = original_uri.partition("?")

    if path.startswith("/features"):
        # /features/collections/<schema.table>/items -> the table behind it.
        parts = [p for p in path.split("/") if p]
        if len(parts) >= 3 and parts[1] == "collections":
            collection = urllib.parse.unquote(parts[2])
            schema, _, table = collection.partition(".")
            if schema and table:
                _, tables = visible_layer_index(user)
                if (schema, table) not in tables:
                    raise HTTPException(403, f"Kein Zugriff auf {collection}")
        return

    if path.startswith("/pointclouds/"):
        parts = [p for p in path.split("/") if p]
        if len(parts) >= 2:
            layer = urllib.parse.unquote(parts[1])
            names, _ = visible_layer_index(user)
            if layer not in names:
                raise HTTPException(403, f"Kein Zugriff auf {layer}")
        return

    requested = _query_layer_names(query_string)
    if not requested:
        return
    names, _ = visible_layer_index(user)
    denied = sorted(requested - names)
    if denied:
        # A MapServer GROUP name lands here too: it is not a layer in
        # all_layers(), so asking for LAYERS=uploads — which would render every
        # uploaded layer at once — is denied rather than quietly honoured.
        raise HTTPException(403, f"Kein Zugriff auf {', '.join(denied)}")


# Any successful write to the ACL, the user table or the layer list can change
# who may see what, so it drops the memoized visibility (see
# visible_layer_index) rather than leaving the gateway to serve a revoked layer
# until the TTL runs out. One middleware rather than a call at the end of seven
# handlers: a route added later is covered without anyone remembering to.
_ACL_MUTATING_PREFIXES = ("/groups", "/layer-grants", "/layers", "/users", "/layer-config")


@app.middleware("http")
async def drop_visibility_cache_on_acl_write(request: Request, call_next):
    response = await call_next(request)
    if request.method in ("POST", "PATCH", "PUT", "DELETE") and response.status_code < 400:
        if request.url.path.startswith(_ACL_MUTATING_PREFIXES):
            invalidate_visibility_cache()
    return response


@app.get("/auth/verify")
def auth_verify(request: Request, user: dict = Depends(require_login)):
    """nginx's auth_request target. 200 means "gateway may proxy the original
    request"; 401 means no session; 403 means the session is fine but this
    user may not have the layer it asked for.

    The layer check reads X-Original-URI, which nginx sets on the subrequest
    from $request_uri — the client cannot supply it, since proxy_set_header
    overwrites anything that arrived, and this location is `internal`."""
    authorize_gateway_request(request.headers.get("X-Original-URI", ""), user)
    return Response(status_code=200)


@app.get("/auth/me")
def auth_me(user: dict = Depends(require_login)):
    return {"username": user["username"], "role": user["role"], "tier": user.get("tier", "free")}


# --------------------------------------------------------------- superset ---
# Superset has no login of its own: the gateway authenticates every /analytics
# request here first and passes the username on (nginx/locations.conf's
# /auth/superset + /analytics/ blocks), and Superset's security manager
# (superset/vibegis_security.py) turns that into an account.

SUPERSET_INTERNAL_TOKEN = os.environ.get("SUPERSET_INTERNAL_TOKEN", "")


@app.get("/auth/superset")
def auth_superset(user: dict = Depends(require_login)):
    """nginx's auth_request target for /analytics. 200 plus the identity the
    gateway forwards as X-Remote-User; 401 with no session.

    Separate from /auth/verify because that one runs
    authorize_gateway_request(), which fails closed on a URI that names no
    layer — which every Superset URI does. Per-layer authorization still
    happens, just inside Superset: the security manager maps this user's
    grants onto Superset roles (see /internal/superset/acl below)."""
    return Response(status_code=200, headers={
        "X-Vibegis-User": user["username"],
        "X-Vibegis-Role": user.get("role", "viewer"),
    })


def require_internal_token(request: Request) -> None:
    """Service-to-service guard for the /internal/* routes.

    These are already unreachable from outside — nginx proxies only the routes
    it lists, and an unlisted one falls through to the SPA — so this is the
    second lock, for anything that lands on the compose network. 404 rather
    than 403 so it does not confirm the route exists."""
    supplied = request.headers.get("X-Internal-Token", "")
    if not SUPERSET_INTERNAL_TOKEN or not hmac.compare_digest(supplied, SUPERSET_INTERNAL_TOKEN):
        raise HTTPException(404, "Nicht gefunden")


@app.get("/internal/superset/acl")
def internal_superset_acl(username: str, request: Request):
    """What Superset needs to know about a user: their role, and the tables
    behind the layers they may see.

    This exists so that visible_layers_for() stays the only implementation of
    the ACL. Superset could query configdb.layer_grants itself, but a second
    implementation of an access rule is a second implementation that can drift
    from the first, and drift in an ACL is a security bug — so it asks."""
    require_internal_token(request)
    with engine().begin() as conn:
        row = conn.execute(
            text(
                "SELECT id, username, role, subscription_tier "
                "FROM userdb.users WHERE username = :u"
            ),
            {"u": username},
        ).first()
    if not row:
        raise HTTPException(404, "Unbekannter Benutzer")

    user = {
        "sub": str(row.id), "username": row.username,
        "role": row.role, "tier": row.subscription_tier,
    }
    # Same 30s-memoized index the tile gateway uses, so a Superset login costs
    # no more than a map tile does.
    _, tables = visible_layer_index(user)
    return {
        "username": row.username,
        "role": row.role,
        "tier": row.subscription_tier,
        "tables": sorted([schema, table] for schema, table in tables),
    }


@app.post("/internal/superset/reconcile")
def internal_superset_reconcile(request: Request):
    """Bring Superset's dataset list back in line with what is published.

    Registration happens inline on publish and is deliberately best-effort, so
    that a Superset outage can never fail an upload — which only works if
    something notices afterwards. This is that something; Dagster runs it
    nightly."""
    require_internal_token(request)
    tables = sorted({
        (l["schema"], l["table"])
        for l in all_layers()
        if l.get("schema") and l.get("table")
    })
    return superset_client.reconcile_datasets(tables)


# -------------------------------------------------------------- /users
# Admin-only account management, backing the in-app admin screen. POST is an
# upsert (same semantics as bin/add-user.sh) so resubmitting the form for an
# existing username resets its password/role instead of erroring.

@app.get("/users")
def list_users(user: dict = Depends(require_role("admin"))):
    with engine().begin() as conn:
        rows = conn.execute(text(
            "SELECT id, username, role, subscription_tier, created_at FROM userdb.users ORDER BY username"
        )).mappings().all()
    return list(rows)


@app.post("/users")
def upsert_user(body: CreateUserBody, user: dict = Depends(require_role("admin"))):
    pw_hash = bcrypt.hashpw(body.password.encode(), bcrypt.gensalt()).decode()
    with engine().begin() as conn:
        conn.execute(text(
            "INSERT INTO userdb.users (username, password_hash, role, subscription_tier) "
            "VALUES (:u, :p, :r, :t) "
            "ON CONFLICT (username) DO UPDATE SET "
            "password_hash = EXCLUDED.password_hash, role = EXCLUDED.role, "
            "subscription_tier = EXCLUDED.subscription_tier"
        ), {"u": body.username, "p": pw_hash, "r": body.role, "t": body.subscription_tier})
    return {"username": body.username, "role": body.role, "tier": body.subscription_tier}


@app.delete("/users/{username}")
def delete_user(username: str, user: dict = Depends(require_role("admin"))):
    with engine().begin() as conn:
        target = conn.execute(text("SELECT role FROM userdb.users WHERE username = :u"), {"u": username}).first()
        if not target:
            raise HTTPException(404, "Unbekannter Benutzer")
        if target.role == "admin":
            remaining = conn.execute(text(
                "SELECT count(*) FROM userdb.users WHERE role = 'admin' AND username != :u"
            ), {"u": username}).scalar()
            if remaining == 0:
                raise HTTPException(400, "Der letzte Admin kann nicht gelöscht werden")
        conn.execute(text("DELETE FROM userdb.users WHERE username = :u"), {"u": username})
    return {"ok": True}


# ---------------------------------------------------------------- /etl/run
#
# Triggers one of the named Dagster jobs defined in dagster/defs/__init__.py
# (ETL_JOBS below is the frontend-facing whitelist/label list — must stay in
# sync with the job names defined there). upload-api and dagster are separate
# images/venvs — no in-process import path — so this reaches Dagster's
# GraphQL API over the "vibegis" Docker network at its service name.
# Dagster's own port is published as 127.0.0.1:<port> on the host
# (host-only), but that restriction doesn't apply to container-to-container
# traffic on the compose network at all.

DAGSTER_GRAPHQL_URL = "http://dagster:3000/graphql"
ETL_JOB_NAME = "refresh_all"

# The selectable tasks in the frontend's ETL picker (Sideband.tsx) — must
# match the job names defined in dagster/defs/__init__.py. Kept as a
# whitelist here rather than trusting whatever job name a request sends,
# since it's threaded straight into a GraphQL selector.
ETL_JOBS = [
    {"name": "refresh_all", "label": "Vollständiger Refresh (alle Assets)"},
    {"name": "reload_data", "label": "Vektordaten neu laden"},
    {"name": "publish_layers", "label": "Layer neu indizieren"},
    {"name": "add_test_column", "label": "Test-Spalte hinzufügen"},
    {"name": "superset_sync", "label": "Superset-Datensätze abgleichen"},
]
ETL_JOB_NAMES = {j["name"] for j in ETL_JOBS}


def dagster_graphql(query: str, variables: dict) -> dict:
    body = json.dumps({"query": query, "variables": variables}).encode()
    req = urllib.request.Request(
        DAGSTER_GRAPHQL_URL, data=body, headers={"Content-Type": "application/json"}
    )
    try:
        with urllib.request.urlopen(req, timeout=15) as res:
            return json.loads(res.read().decode())
    except urllib.error.URLError as e:
        raise HTTPException(502, f"Dagster nicht erreichbar: {e}")


@app.get("/etl/jobs")
def list_etl_jobs(user: dict = Depends(require_etl_access)):
    return {"jobs": ETL_JOBS}


class EtlRunBody(BaseModel):
    job_name: str = ETL_JOB_NAME


@app.post("/etl/run")
def run_etl(body: EtlRunBody = EtlRunBody(), user: dict = Depends(require_etl_access)):
    if body.job_name not in ETL_JOB_NAMES:
        raise HTTPException(400, f"Unbekannter ETL-Job: {body.job_name}")
    return _execute_etl_run(user, body.job_name)


def _execute_etl_run(user: dict, job_name: str = ETL_JOB_NAME) -> dict:
    # Both the manual /etl/run route above and the AI agent's confirmed
    # /ai/execute-action route (see the end of this file) call this same
    # function — exactly one implementation of "launch the ETL job".
    #
    # Repository location/name aren't hardcoded: they come from however
    # workspace.yaml's python_module entry gets named internally, so this
    # looks them up rather than guessing — cheap, and it also doubles as a
    # check that the job we're about to launch is actually there.
    workspace = dagster_graphql(
        "{ workspaceOrError { __typename "
        "... on Workspace { locationEntries { name locationOrLoadError { __typename "
        "... on RepositoryLocation { name repositories { name pipelines { name } } } "
        "... on PythonError { message } } } } "
        "... on PythonError { message } } }",
        {},
    )
    ws = workspace.get("data", {}).get("workspaceOrError", {})
    if ws.get("__typename") != "Workspace":
        raise HTTPException(502, f"Dagster workspace nicht ladbar: {ws.get('message', workspace)}")

    location_name = repository_name = None
    for entry in ws["locationEntries"]:
        loc = entry["locationOrLoadError"]
        if loc.get("__typename") != "RepositoryLocation":
            continue
        for repo in loc["repositories"]:
            if any(p["name"] == job_name for p in repo["pipelines"]):
                location_name, repository_name = loc["name"], repo["name"]
                break
    if not location_name:
        raise HTTPException(502, f"Dagster-Job '{job_name}' nicht gefunden")

    result = dagster_graphql(
        "mutation Launch($selector: JobOrPipelineSelector!, $runConfigData: RunConfigData) { "
        "launchRun(executionParams: {selector: $selector, runConfigData: $runConfigData}) { "
        "__typename "
        "... on LaunchRunSuccess { run { runId status } } "
        "... on PythonError { message } "
        "... on PipelineNotFoundError { message } "
        "... on RunConfigValidationInvalid { errors { message } } "
        "... on InvalidSubsetError { message } "
        "... on ConflictingExecutionParamsError { message } "
        "... on NoModeProvidedError { message } "
        "... on PresetNotFoundError { message } "
        "... on RunConflict { message } "
        "... on UnauthorizedError { message } "
        "} }",
        {
            "selector": {
                "repositoryLocationName": location_name,
                "repositoryName": repository_name,
                "jobName": job_name,
            },
            "runConfigData": {},
        },
    )
    launch = result.get("data", {}).get("launchRun", {})
    if launch.get("__typename") == "LaunchRunSuccess":
        run = launch["run"]
        return {"ok": True, "runId": run["runId"], "status": run["status"]}
    raise HTTPException(502, launch.get("message") or f"ETL-Start fehlgeschlagen: {launch}")


@app.get("/etl/run/{run_id}")
def etl_run_status(run_id: str, user: dict = Depends(require_etl_access)):
    result = dagster_graphql(
        "query($id: ID!) { runOrError(runId: $id) { __typename "
        "... on Run { status stepKeysToExecute stepStats { stepKey status } } "
        "... on RunNotFoundError { message } "
        "... on PythonError { message } } }",
        {"id": run_id},
    )
    run = result.get("data", {}).get("runOrError", {})
    if run.get("__typename") == "Run":
        # Dagster has no single "percent done" field — approximate it as
        # steps that have reached a terminal state (not necessarily
        # successful; a failed step is still "resolved") over steps planned.
        total = len(run.get("stepKeysToExecute") or [])
        done = sum(
            1 for s in (run.get("stepStats") or []) if s["status"] in ("SUCCESS", "FAILURE", "SKIPPED")
        )
        progress = round(done / total * 100) if total else 0
        return {"status": run["status"], "progress": progress}
    raise HTTPException(404, run.get("message") or f"Lauf nicht gefunden: {run}")


@app.on_event("startup")
def create_users_table_if_missing() -> None:
    try:
        ensure_users_table()
    except Exception as e:
        log.error("could not ensure users table", extra={"error": str(e)})
    try:
        ai_agent.ensure_ai_schema(engine)
    except Exception as e:
        log.error("could not ensure AI agent schema/role", extra={"error": str(e)})
    try:
        ensure_pointcloud_table()
    except Exception as e:
        log.error("could not ensure point cloud table", extra={"error": str(e)})


def slugify(name: str) -> str:
    s = re.sub(r"[^a-z0-9]+", "_", name.strip().lower()).strip("_")
    return (s or "layer")[:40]


def check_identifier(name: str, what: str) -> str:
    if not IDENT_RE.fullmatch(name):
        raise HTTPException(400, f"Invalid {what}: '{name}'")
    return name


# Mirrors filter.ts's FilterOp: every op that isn't LIKE maps straight to SQL.
FILTER_SQL_OP = {"eq": "=", "neq": "<>", "gt": ">", "lt": "<", "gte": ">=", "lte": "<="}


def parse_layer_filter(raw: str | None) -> dict | None:
    """
    Decodes the `filter` query param — the frontend's LayerFilter shape
    ({logic, conditions}) JSON-encoded into one string, the simplest way to
    pass a small structured value through a GET query string without
    switching these routes to POST. Used by /table-count, /column-groupby
    and /column-stats to scope the dashboard's "everything selected"
    overview to whatever attribute filter is active on that layer.
    """
    if not raw:
        return None
    try:
        parsed = json.loads(raw)
    except json.JSONDecodeError:
        raise HTTPException(400, "Invalid filter: not valid JSON")
    if not isinstance(parsed, dict) or "conditions" not in parsed:
        raise HTTPException(400, "Invalid filter: expected {logic, conditions}")
    return parsed


def build_filter_where(layer_filter: dict | None, params: dict) -> str:
    """
    Turns a LayerFilter into a parameterized SQL fragment, e.g.
    '("col1" = :filt0 AND "col2" LIKE :filt1)'. Every column name goes
    through check_identifier(); every value is bound into `params` under a
    unique key, never interpolated. Mirrors filter.ts's buildCql()/
    cqlCondition() operator set and AND/OR join; a value that looks numeric
    is coerced to float, matching buildCql()'s own cqlLiteral() heuristic —
    otherwise a bound string parameter compared against a numeric column can
    fail to match. Returns "" when there's nothing usable to filter on.
    """
    if not layer_filter:
        return ""
    conditions = layer_filter.get("conditions") or []
    usable = [c for c in conditions if c.get("column") and str(c.get("value", "")).strip() != ""]
    if not usable:
        return ""

    parts = []
    for c in usable:
        column = check_identifier(c["column"], "filter column name")
        key = f"filt{len(params)}"
        value = c["value"]
        try:
            bound = float(value)
        except (TypeError, ValueError):
            bound = value
        if c["op"] == "like":
            params[key] = f"%{value}%"
            parts.append(f'"{column}" LIKE :{key}')
        elif c["op"] in FILTER_SQL_OP:
            params[key] = bound
            parts.append(f'"{column}" {FILTER_SQL_OP[c["op"]]} :{key}')
        else:
            raise HTTPException(400, f"Invalid filter operator: '{c['op']}'")

    logic = " OR " if layer_filter.get("logic") == "or" else " AND "
    return "(" + logic.join(parts) + ")"


def mapfile_escape(s: str) -> str:
    return s.replace("\\", "\\\\").replace('"', '\\"').replace("\n", " ").replace("\r", " ")


def gdf_attribute_columns(gdf: gpd.GeoDataFrame, geom_col: str) -> list[dict]:
    """
    Column list straight from the just-loaded GeoDataFrame — returned to the
    frontend so its filter builder doesn't have to ask pg_featureserv, which
    can take a while to notice a table that didn't exist a moment ago.
    """
    return [
        {"key": col, "numeric": bool(pd.api.types.is_numeric_dtype(gdf[col]))}
        for col in gdf.columns if col != geom_col
    ]


def table_attribute_columns(schema: str, table: str, geom_col: str) -> list[dict]:
    with engine().begin() as conn:
        rows = conn.execute(
            text(
                "SELECT column_name, data_type FROM information_schema.columns "
                "WHERE table_schema = :s AND table_name = :t"
            ),
            {"s": schema, "t": table},
        ).all()
    return [{"key": r[0], "numeric": r[1] in NUMERIC_SQL_TYPES} for r in rows if r[0] != geom_col]


# ------------------------------------------------------------ uploads.map

def parse_layers(content: str) -> list[dict]:
    out = []
    for m in LAYER_RE.finditer(content):
        inner = m.group(1)
        name_m = NAME_RE.search(inner)
        if not name_m:
            continue
        type_m = TYPE_RE.search(inner)
        title_m = OWS_TITLE_RE.search(inner)
        block = "LAYER\n" + inner + "\nEND\n"

        if type_m and type_m.group(1) == "RASTER":
            data_m = DATA_RASTER_RE.search(inner)
            if not data_m:
                continue
            bands_kw = keyword_value(inner, "bands")
            out.append({
                "name": name_m.group(1),
                "geom_col": None,
                "schema": None,
                "table": None,
                "unique_col": None,
                "srid": None,
                "path": data_m.group(1),
                "geometry_type": "RASTER",
                "title": title_m.group(1) if title_m else None,
                "bands": int(bands_kw) if bands_kw else None,
                "block": block,
            })
            continue

        data_m = DATA_RE.search(inner)
        if not data_m:
            continue
        out.append({
            "name": name_m.group(1),
            "geom_col": data_m.group(1),
            "schema": data_m.group(2),
            "table": data_m.group(3),
            "unique_col": data_m.group(4),
            "srid": int(data_m.group(5)),
            "path": None,
            "geometry_type": type_m.group(1) if type_m else None,
            # Needed to rebuild the block on a restyle without losing the
            # layer's display title — it lives only in this metadata entry.
            "title": title_m.group(1) if title_m else None,
            "bands": None,
            "block": block,
        })
    return out


def read_layers() -> list[dict]:
    check_mapfile_volume()
    if not UPLOADS_MAP.exists():
        return []
    with open(UPLOADS_MAP, "r") as f:
        fcntl.flock(f, fcntl.LOCK_SH)
        try:
            return parse_layers(f.read())
        finally:
            fcntl.flock(f, fcntl.LOCK_UN)


def read_pointcloud_layers() -> list[dict]:
    """The point-cloud half of the layer list, from configdb.point_clouds.

    Every dict carries the same key set parse_layers() produces, for exactly
    the reason parse_layers() gives for filling in None on a raster entry:
    downstream code should never have to ask which fields exist. `block` is
    None because there is no mapfile block — that absence is what
    read_layers()' consumers rely on, see all_layers().

    Best-effort: a dead database must not take /layers down for the mapfile
    layers too, which is the same degradation contract the frontend already
    assumes about this endpoint.
    """
    try:
        with engine().begin() as conn:
            rows = conn.execute(text(
                "SELECT layer_name, title, point_count, srs_in, west, south, east, north, "
                "has_color, has_classification FROM configdb.point_clouds ORDER BY created_at"
            )).mappings().all()
    except Exception as e:
        log.warning("could not read point cloud layers", extra={"error": str(e)})
        return []
    out = []
    for r in rows:
        bbox = None
        if None not in (r["west"], r["south"], r["east"], r["north"]):
            bbox = {"west": r["west"], "south": r["south"], "east": r["east"], "north": r["north"]}
        out.append({
            "name": r["layer_name"],
            "geom_col": None,
            "schema": None,
            "table": None,
            "unique_col": None,
            "srid": None,
            "path": str(POINTCLOUDS_DIR / r["layer_name"]),
            "geometry_type": "POINTCLOUD",
            "title": r["title"],
            "bands": None,
            "block": None,
            # Point-cloud-only extras. The frontend reads tileset_url straight
            # off this rather than rebuilding the path client-side, so where
            # the files live stays one decision made in one place.
            "tileset_url": f"/pointclouds/{r['layer_name']}/tileset.json",
            "bbox": bbox,
            "point_count": r["point_count"],
            "srs_in": r["srs_in"],
            "has_color": r["has_color"],
            "has_classification": r["has_classification"],
        })
    return out


def all_layers() -> list[dict]:
    """Every published layer, from both sources.

    read_layers() stays mapfile-only on purpose and must not learn about point
    clouds: generate_mapproxy_config() would emit a cache/source pair pointing
    at a MapServer layer that does not exist, and materialize_saved_styles()
    would try to seed a CLASS-based style for something that has no block to
    style. Both iterate read_layers() directly. Unioning here instead means
    /layers and the name-collision checks see everything while those two keep
    seeing only what they can actually act on.
    """
    return read_layers() + read_pointcloud_layers()


def record_layer_owner(layer_name: str, user: dict) -> None:
    """Called once, right after a layer publishes successfully, from every
    publish path (/upload, /upload-raster[-zip], /raster-composite,
    /register-table, /geoprocess) — the one thing PATCH /layer-config and
    DELETE /layers' ownership check (require_owner_or_admin()) reads.
    Recorded for admin publishes too (harmless, and keeps "who published
    this" available consistently regardless of who did it)."""
    user_id = user.get("sub")
    if user_id is None:
        return
    with engine().begin() as conn:
        conn.execute(text(
            "INSERT INTO configdb.layer_owners (layer_name, owner_user_id) VALUES (:n, :u) "
            "ON CONFLICT (layer_name) DO UPDATE SET owner_user_id = EXCLUDED.owner_user_id"
        ), {"n": layer_name, "u": int(user_id)})
    invalidate_visibility_cache()


# ------------------------------------------------------ search box indexing
#
# dwh.search_index (postgis/initdb/05-3d-and-search.sql) is a materialized
# view over a fixed set of seeded tables — its query is fixed at creation
# time, so it can never grow to include a layer published later. This is the
# dynamic counterpart: a plain table this service maintains directly, one
# row per feature, for any vector layer whose table has a name-like column.
# postgisftw.search() (what the frontend's search box calls) unions both
# sources, so a hit from either reaches the UI the same way.

SEARCH_NAME_COLUMNS = ("name", "title", "bezeichnung", "label", "shapename")


def pick_search_name_column(schema: str, table: str) -> str | None:
    """An exact match against SEARCH_NAME_COLUMNS first; failing that, the
    shortest text column whose name merely contains "name" (LAU_NAME,
    ADM2_NAME, shapeName — real-world admin/boundary data almost never uses
    a bare "name" column). Never a wider guess than that: picking an
    arbitrary text column would as easily surface a description or a note
    as an actual name."""
    with engine().begin() as conn:
        cols = {
            r[0].lower(): r[0]
            for r in conn.execute(
                text(
                    "SELECT column_name FROM information_schema.columns "
                    "WHERE table_schema = :s AND table_name = :t "
                    "AND data_type IN ('text', 'character varying', 'character')"
                ),
                {"s": schema, "t": table},
            ).all()
        }
    for candidate in SEARCH_NAME_COLUMNS:
        if candidate in cols:
            return cols[candidate]
    contains_name = sorted((real for lower, real in cols.items() if "name" in lower), key=len)
    return contains_name[0] if contains_name else None


def index_layer_for_search(schema: str, table: str, layer_name: str, title: str) -> None:
    """Best-effort, called right after record_layer_owner() from every
    vector publish path: a layer with no obvious name column, or any DB
    error here, must never fail the publish itself — search is a
    convenience layered on top, not part of the publish contract."""
    try:
        name_col = pick_search_name_column(schema, table)
        if not name_col:
            return
        geom_col, _ = find_geometry_column(schema, table)
        with engine().begin() as conn:
            conn.execute(
                text("DELETE FROM dwh.search_index_uploads WHERE layer_name = :l"),
                {"l": layer_name},
            )
            conn.execute(
                text(
                    f'INSERT INTO dwh.search_index_uploads (layer_name, name, category, geom) '
                    f'SELECT :l, "{name_col}"::text, :cat, ST_PointOnSurface(ST_Force2D("{geom_col}")) '
                    f'FROM "{schema}"."{table}" WHERE "{name_col}" IS NOT NULL'
                ),
                {"l": layer_name, "cat": title},
            )
    except Exception as e:
        log.warning("search index refresh failed", extra={"layer": layer_name, "error": str(e)})


def remove_search_index_for_layer(layer_name: str) -> None:
    """Called from DELETE /layers — a no-op if the layer was never indexed
    (raster/point-cloud layers, or a vector layer with no name-like column),
    same best-effort contract as index_layer_for_search()."""
    try:
        with engine().begin() as conn:
            conn.execute(
                text("DELETE FROM dwh.search_index_uploads WHERE layer_name = :l"),
                {"l": layer_name},
            )
    except Exception as e:
        log.warning("search index cleanup failed", extra={"layer": layer_name, "error": str(e)})


def visible_layers_for(user: dict, all_layers: list[dict]) -> list[dict]:
    """Admin/editor see everything — can't analyze or edit what you can't
    see. Everyone else sees what's granted directly to their user id,
    unioned with whatever's granted to any group they belong to, unioned
    with whatever they own
    (configdb.layer_owners — a Pro user obviously needs to see a layer the
    moment they publish it, not only once an admin grants it back to them).
    Reused by GET /layers and by the grants-admin screen's own listing."""
    if is_privileged_role(user):
        return all_layers
    names = {l["name"] for l in all_layers}
    with engine().begin() as conn:
        granted = conn.execute(
            text(
                "SELECT layer_name FROM configdb.layer_grants "
                "WHERE principal_type = 'user' AND principal_id = :uid "
                "UNION "
                "SELECT g.layer_name FROM configdb.layer_grants g "
                "JOIN configdb.group_members gm "
                "ON gm.group_id = g.principal_id AND g.principal_type = 'group' "
                "WHERE gm.user_id = :uid "
                "UNION "
                "SELECT layer_name FROM configdb.layer_owners WHERE owner_user_id = :uid"
            ),
            {"uid": int(user["sub"])},
        ).scalars().all()
    granted_set = set(granted) & names
    return [l for l in all_layers if l["name"] in granted_set]


# The only schema a request is ever allowed to name. Everything a user can
# legitimately query lives in dwh; configdb (the ACL itself, layer config, CMS)
# and userdb (accounts, password hashes, AI key ciphertext) are reachable only
# through their own routes, which do their own checks. Without this, an
# endpoint taking a schema/table pair is a read primitive over the whole
# database — which is exactly what /distinct-values and /column-stats were.
QUERYABLE_SCHEMAS = {"dwh"}


def authorize_table(schema: str, table: str, user: dict) -> tuple[str, str]:
    """Validate a client-supplied schema/table pair *and* check the caller may
    actually read it. Returns the pair so call sites can use the result
    directly and cannot accidentally keep using the unchecked input.

    check_identifier() alone only proves a name is well-formed — it says
    nothing about whose data it is. Every endpoint that takes a raw
    schema/table pair must come through here instead, or it is a way to read
    any table in the database with nothing but a session.

    Authorization is "does this pair back a layer this user can see", resolved
    through the same visible_layers_for() that governs the layer panel, so
    there is one ACL rather than two that can drift. Admin/editor keep the
    wider access they have everywhere else (is_privileged_role) — including
    tables in dwh that back no layer yet, e.g. fresh ETL output.

    resolve_layer_source() is the same check from the other direction, for
    routes whose client already sends a layer *name* (the QGIS routes). Both
    exist on purpose: this one keeps the schema/table wire contract the
    filter/classify/dashboard endpoints have always had, so closing the hole
    needed no frontend change and no new failure mode in those paths.
    """
    schema = check_identifier(schema, "schema name")
    table = check_identifier(table, "table name")
    if schema not in QUERYABLE_SCHEMAS:
        raise HTTPException(403, f"Schema nicht abfragbar: {schema}")
    if is_privileged_role(user):
        return schema, table
    if not any(
        l.get("schema") == schema and l.get("table") == table
        for l in visible_layers_for(user, all_layers())
    ):
        raise HTTPException(403, f"Kein Zugriff auf {schema}.{table}")
    return schema, table


def require_owner_or_admin(layer_name: str, user: dict) -> None:
    """Admin/editor always pass. Otherwise the caller must be pro+ (checked
    by the route's own require_tier dependency already) *and* own this
    specific layer — a free user never reaches here at all since they can't
    pass require_tier("pro") in the first place."""
    if is_privileged_role(user):
        return
    with engine().begin() as conn:
        row = conn.execute(
            text("SELECT owner_user_id FROM configdb.layer_owners WHERE layer_name = :n"), {"n": layer_name}
        ).first()
    if not row or str(row.owner_user_id) != str(user.get("sub")):
        raise HTTPException(403, "Nur der Ersteller oder ein Admin darf diesen Layer bearbeiten")


def append_layer_block(block: str) -> None:
    check_mapfile_volume()
    MAPFILE_DIR.mkdir(parents=True, exist_ok=True)
    if not UPLOADS_MAP.exists():
        UPLOADS_MAP.write_text(HEADER)
    with open(UPLOADS_MAP, "a+") as f:
        fcntl.flock(f, fcntl.LOCK_EX)
        try:
            f.write(block)
            f.flush()
        finally:
            fcntl.flock(f, fcntl.LOCK_UN)


def remove_layer_block(name: str) -> dict:
    """Removes the LAYER block named `name`. Returns its parsed info (for the
    caller to optionally drop the underlying table). 404s if not found."""
    check_mapfile_volume()
    MAPFILE_DIR.mkdir(parents=True, exist_ok=True)
    if not UPLOADS_MAP.exists():
        UPLOADS_MAP.write_text(HEADER)
    with open(UPLOADS_MAP, "r+") as f:
        fcntl.flock(f, fcntl.LOCK_EX)
        try:
            layers = parse_layers(f.read())
            match = next((l for l in layers if l["name"] == name), None)
            if not match:
                raise HTTPException(
                    404, f"Layer '{name}' not found (only layers created via upload or "
                         "table registration can be deleted)"
                )
            kept = [l for l in layers if l["name"] != name]
            new_content = HEADER + "\n" + "".join(l["block"] + "\n" for l in kept)
            f.seek(0)
            f.write(new_content)
            f.truncate()
            return match
        finally:
            fcntl.flock(f, fcntl.LOCK_UN)


def replace_layer_block(name: str, new_block: str) -> bool:
    """
    Swaps the LAYER block named `name` for `new_block`, keeping layer order.

    Returns False when there is no such block instead of raising: unlike
    remove_layer_block(), callers here come from /layer-config, which accepts
    any layer name — including static ones this service does not own, and
    entries left behind for layers that no longer exist. A missing block must
    not fail the config write that triggered it.
    """
    check_mapfile_volume()
    if not UPLOADS_MAP.exists():
        return False
    with open(UPLOADS_MAP, "r+") as f:
        fcntl.flock(f, fcntl.LOCK_EX)
        try:
            layers = parse_layers(f.read())
            if not any(l["name"] == name for l in layers):
                return False
            new_content = HEADER + "\n" + "".join(
                (new_block if l["name"] == name else l["block"]) + "\n" for l in layers
            )
            f.seek(0)
            f.write(new_content)
            f.truncate()
            return True
        finally:
            fcntl.flock(f, fcntl.LOCK_UN)


def build_layer_block(
    name, title, ms_type, schema, table, geom_col, unique_col, srid,
    classification=None, max_scale_denom=None, outline_width=None,
) -> str:
    e = pg_env()
    # Scale cap: without one, a zoomed-out view draws every row in the table.
    # Measured on this stack, one 256px tile of a 1.68M-row polygon layer took
    # 6.8s at country zoom and 0.4s close in.
    scale = f"  MAXSCALEDENOM {int(max_scale_denom)}\n" if max_scale_denom else ""
    return (
        "LAYER\n"
        f'  NAME        "{name}"\n'
        '  GROUP       "uploads"\n'
        f"  TYPE        {ms_type}\n"
        "  STATUS      ON\n"
        f"{scale}"
        "  CONNECTIONTYPE POSTGIS\n"
        # Neither password= nor user= here, on purpose. The mapfile is
        # committed to git, so the password has always come from PGPASSWORD on
        # whichever container reads it; the *user* is omitted for a second
        # reason — this file is written by upload-api, which connects as the
        # owner, but it is read by mapserver, which connects as the read-only
        # vibegis_render role. Naming a user here would pin every layer to
        # whoever generated the block and undo that split. libpq takes both
        # from the reading container's PGUSER/PGPASSWORD.
        f'  CONNECTION  "host={e["host"]} dbname={e["dbname"]} port=5432"\n'
        f'  DATA        "{geom_col} FROM {schema}.{table} USING UNIQUE {unique_col} USING SRID={srid}"\n'
        '  PROCESSING  "CLOSE_CONNECTION=DEFER"\n'
        "  PROJECTION\n"
        f'    "init=epsg:{srid}"\n'
        "  END\n"
        "  METADATA\n"
        f'    "ows_title"         "{mapfile_escape(title)}"\n'
        '    "ows_group_title"   "Eigene Uploads"\n'
        '    "ows_srs"           "EPSG:4326 EPSG:3857 CRS:84"\n'
        '    "gml_include_items" "all"\n'
        # Published by MapServer as <KeywordList> on the layer, so the frontend
        # learns which table backs this layer straight from GetCapabilities
        # instead of having to ask /layers. Identical for uploads and
        # registered tables — the two must stay indistinguishable downstream.
        f'    "ows_keywordlist"   "source:{schema}.{table},geomtype:{ms_type.lower()}"\n'
        "  END\n"
        f"{build_class_blocks(classification, ms_type, title, outline_width)}"
        "END\n"
    )


def purge_layer_cache(name: str) -> None:
    """
    Drops every cached tile for `name`, across all grids.

    MapProxy has no invalidation endpoint — its services are only `demo` and
    `wms` — so this is a filesystem delete. One cache_dir leaf holds exactly
    one cache's per-grid directories, so removing the leaf clears CRS84 and
    EPSG3857 together and touches nothing else; the shared locks/ and
    tile_locks/ sit beside the leaves, never inside them.

    Safe at runtime with MapProxy serving: a read falls back to os.path.exists()
    and refetches, and a write recreates the tree. No restart, and all gunicorn
    workers see it immediately (FileCache holds only the path string). A rmtree
    landing between an in-flight tile's ensure_directory() and its open() makes
    that one request fail; it self-heals on Cesium's retry, which is why this
    doesn't try to lock against it.

    A missing directory is normal, not an error: the layer may never have been
    requested, or the cache volume may not be mounted at all.
    """
    if not MAPPROXY_CACHE_DIR.is_dir():
        return
    shutil.rmtree(MAPPROXY_CACHE_DIR / name, ignore_errors=True)


# Parts of mapproxy.yaml that never depend on which layers exist — same
# values as the file this replaced. See generate_mapproxy_config().
MAPPROXY_STATIC_CONFIG = {
    "services": {
        "demo": None,
        "wms": {
            # Cesium's WebMapServiceImageryProvider requests WMS 1.3.0 tiles in
            # CRS:84 by default — must be advertised explicitly, EPSG:4326
            # alone does not cover it.
            "srs": ["EPSG:4326", "EPSG:3857", "CRS:84"],
            "image_formats": ["image/png"],
            "md": {"title": "WebGIS Cache", "abstract": "Cached MapServer layers"},
        },
    },
    "grids": {
        "webmercator": {"base": "GLOBAL_WEBMERCATOR"},
        "geodetic": {
            # Explicit CRS:84, not the GLOBAL_GEODETIC default of EPSG:4326:
            # MapProxy's per-grid SRS routing matches on exact SRS identity,
            # not axis-order-equivalent CRSes, so EPSG:4326 here would never
            # actually get hit and CRS:84 requests would KeyError.
            "base": "GLOBAL_GEODETIC",
            "srs": "CRS:84",
            "bbox": [-180, -90, 180, 90],
        },
    },
    "globals": {
        "cache": {
            "base_dir": "/mapproxy/cache_data",
            "lock_dir": "/mapproxy/cache_data/locks",
            "tile_lock_dir": "/mapproxy/cache_data/tile_locks",
        },
        "image": {"resampling_method": "bilinear", "paletted": False},
        "http": {"client_timeout": 120},
    },
}

MAPPROXY_YAML_HEADER = (
    "# Generated by upload-api (generate_mapproxy_config() in app.py) — one\n"
    "# layer/cache/source triple per layer in uploads.map, so every published\n"
    "# layer is cacheable, not just a hand-picked few. Do not hand-edit while\n"
    "# the stack is up; it will be overwritten on the next layer change.\n"
)


def generate_mapproxy_config() -> None:
    """
    Rewrites mapproxy.yaml so MapProxy has a cache for every layer currently in
    uploads.map. Previously this list was hand-maintained and named six OSM
    layers that no longer exist (deleted in 7ba8429) — every real layer this
    service publishes was silently uncached. Every real layer gets one here
    automatically, and one that's deleted (see /layers DELETE) drops out on
    the next regeneration too.

    Each cache's cache_dir leaf is the layer's own WMS name — deliberately,
    so purge_layer_cache(name) never needs a name-translation table between a
    layer and its cache directory (the old file used arbitrary short names
    like "buildings" for "osm_buildings", which is exactly what made cleaning
    up its stale tiles need spelunking rather than a lookup).

    No-ops if the config mount isn't present. Written atomically (temp file +
    os.replace) so MapProxy's reloader — which watches this file's mtime —
    never observes a half-written config.
    """
    if not MAPPROXY_CONFIG_DIR.is_dir():
        return
    names = [l["name"] for l in read_layers()]

    layers, caches, sources = [], {}, {}
    for name in names:
        layers.append({"name": name, "title": name, "sources": [f"cache_{name}"]})
        caches[f"cache_{name}"] = {
            "grids": ["webmercator", "geodetic"],
            "sources": [f"src_{name}"],
            "format": "image/png",
            "cache_dir": f"/mapproxy/cache_data/{name}",
            "cache": {"type": "file"},
        }
        sources[f"src_{name}"] = {
            "type": "wms",
            "req": {"url": "http://mapserver/", "layers": name, "transparent": True},
            "supported_srs": ["EPSG:4326", "EPSG:3857"],
            "wms_opts": {"version": "1.3.0"},
        }

    config = {**MAPPROXY_STATIC_CONFIG, "layers": layers, "caches": caches, "sources": sources}
    tmp = MAPPROXY_CONFIG_DIR / "mapproxy.yaml.tmp"
    tmp.write_text(MAPPROXY_YAML_HEADER + "\n" + yaml.safe_dump(config, sort_keys=False))
    os.replace(tmp, MAPPROXY_YAML)


def apply_layer_style(name: str) -> bool:
    """
    Rewrites `name`'s LAYER block so its stored classification and scale cap
    are the layer's *own* styling, then drops the tiles that rewrite
    invalidates.

    This is what makes a classified layer cacheable. A classification lives in
    layer_config.json, and used to reach the map only as a per-request
    SLD_BODY — which MapProxy cannot serve from cache, because it pins one
    fixed upstream request per layer. Compiled into CLASS blocks it is just the
    layer's default rendering, so the cached path applies it like any other
    styling. Scene.tsx therefore no longer treats a classification as a reason
    to bypass the cache.

    No-ops for a name with no block here (a static layer, or a config entry
    whose layer is gone).
    """
    match = next((l for l in read_layers() if l["name"] == name), None)
    # A raster layer has no CLASS/STYLE-based classification to seed — and
    # build_layer_block() below is vector-only, so calling it with a raster's
    # schema=None/table=None would corrupt the layer's own block.
    if not match or not match["geometry_type"] or match["geometry_type"] == "RASTER":
        return False
    cfg = read_layer_config().get(name, {})
    block = build_layer_block(
        name=name,
        title=match["title"] or name,
        ms_type=match["geometry_type"],
        schema=match["schema"],
        table=match["table"],
        geom_col=match["geom_col"],
        unique_col=match["unique_col"],
        srid=match["srid"],
        classification=cfg.get("classification"),
        max_scale_denom=cfg.get("maxScaleDenom"),
        outline_width=cfg.get("outlineWidth"),
    )
    # No-op when the block is already what it should be. Matters on startup,
    # which runs this for every layer: an unconditional purge there would throw
    # the whole tile cache away on every restart.
    if block == match["block"]:
        return True
    if not replace_layer_block(name, block):
        return False
    purge_layer_cache(name)
    return True


# Past this many rows, drawing the whole table at once is slow enough that a
# default scale cap is kinder than a map that stalls for seconds. Below it,
# capping would only make a cheap layer disappear for no gain.
SCALE_CAP_ROW_THRESHOLD = 100_000

# Matches what the hand-authored layers used before they were deleted (see
# `git show 7ba8429^:mapserver/mapfiles/osm-layers.map`): buildings 1:50000,
# roads 1:2000000. Points stay uncapped — they cost far less to draw, and a
# vanishing point layer is more surprising than a slow one.
DEFAULT_SCALE_CAP = {"POLYGON": 50_000, "LINE": 2_000_000, "POINT": None}


def default_scale_cap(ms_type: str, schema: str, table: str) -> int | None:
    """
    Seed value for a new layer's scale cap, from geometry type and size. Only a
    starting point — it is stored in layer_config.json like any other styling,
    so it can be raised, lowered or cleared per layer afterwards.
    """
    cap = DEFAULT_SCALE_CAP.get(ms_type)
    if cap is None:
        return None
    try:
        with engine().begin() as conn:
            rows = conn.execute(text(f'SELECT count(*) FROM "{schema}"."{table}"')).scalar()
    except Exception:
        # Never block publishing a layer over a heuristic.
        return None
    return cap if (rows or 0) >= SCALE_CAP_ROW_THRESHOLD else None


def seed_layer_style(name: str, ms_type: str, schema: str, table: str) -> None:
    """
    Gives a just-published layer its starting scale cap, and re-applies any
    config that already exists under this name (re-registering a table that was
    deleted and re-added keeps its classification).
    """
    config = read_layer_config()
    entry = dict(config.get(name, {}))
    if "maxScaleDenom" not in entry:
        cap = default_scale_cap(ms_type, schema, table)
        if cap is not None:
            entry["maxScaleDenom"] = cap
    if entry != config.get(name):
        config[name] = entry
        write_layer_config(config)
    apply_layer_style(name)


# --------------------------------------------------------------- /upload

def unique_table_name(base: str) -> str:
    with engine().begin() as conn:
        existing = {
            r[0] for r in conn.execute(
                text("SELECT table_name FROM information_schema.tables WHERE table_schema = 'dwh'")
            ).all()
        }
    name = f"upload_{base}"
    n = 2
    while name in existing:
        name = f"upload_{base}_{n}"
        n += 1
    return name


def primary_source(path: Path, suffix: str) -> str:
    """The path form GDAL can (usually) open directly — what both
    read_vector() and list_spatial_layers() try first. A zip that this can't
    open (e.g. nested folders) falls back, inside read_vector(), to
    extracting it and reading the .shp directly instead — inherently
    single-layer, so list_spatial_layers() never needs to follow it there."""
    return f"/vsizip/{path}" if suffix == ".zip" else str(path)


def list_spatial_layers(path: Path, suffix: str) -> list[str] | None:
    """Names of layers that actually carry geometry (a non-spatial lookup
    table isn't something MapServer can publish). None means "couldn't tell"
    — e.g. a zip that only the shapefile-extraction fallback can open —
    which callers should treat as "proceed as a single, unnamed layer".
    """
    try:
        layers = gpd.list_layers(primary_source(path, suffix))
    except Exception:
        return None
    return [row.name for row in layers.itertuples() if not pd.isna(row.geometry_type)]


def read_vector(path: Path, suffix: str, layer: str | None = None) -> gpd.GeoDataFrame:
    if suffix == ".zip":
        try:
            return gpd.read_file(primary_source(path, suffix), layer=layer)
        except Exception:
            pass
        # Fall back to a controlled extract for zips GDAL's direct /vsizip/
        # reader can't open (e.g. nested folders) — reject traversal attempts
        # explicitly rather than trusting arbitrary entry paths in the zip.
        with tempfile.TemporaryDirectory() as tmpdir:
            with zipfile.ZipFile(path) as zf:
                for entry in zf.namelist():
                    if entry.startswith("/") or ".." in Path(entry).parts:
                        raise HTTPException(400, f"Unsafe path in zip: {entry}")
                zf.extractall(tmpdir)
            shp = next(Path(tmpdir).rglob("*.shp"), None)
            if not shp:
                raise HTTPException(400, "Zip does not contain a .shp file")
            return gpd.read_file(shp)
    return gpd.read_file(path, layer=layer)


def sweep_upload_tmp_dir() -> None:
    """Deletes anything left over from an abandoned layer choice — the user
    got a needs_layer_choice response and never came back with a `layer`.
    Inline on every /upload call rather than a scheduled job: simple, and
    plenty for how rarely this actually happens."""
    if not UPLOAD_TMP_DIR.exists():
        return
    cutoff = time.time() - UPLOAD_TOKEN_MAX_AGE
    for f in UPLOAD_TMP_DIR.iterdir():
        try:
            if f.stat().st_mtime < cutoff:
                # A raster-zip handshake leaves a whole extraction directory
                # here, not just a file — unlink() would raise
                # IsADirectoryError (an OSError, silently swallowed below),
                # leaking it forever.
                if f.is_dir():
                    shutil.rmtree(f)
                else:
                    f.unlink()
        except OSError:
            pass  # already gone, or a race with another request — fine either way


@app.post("/upload")
def upload(
    file: UploadFile | None = File(None),
    title: str | None = Form(None),
    layer: str | None = Form(None),
    upload_token: str | None = Form(None),
    user: dict = Depends(require_tier("pro")),
):
    sweep_upload_tmp_dir()
    UPLOAD_TMP_DIR.mkdir(parents=True, exist_ok=True)

    if bool(file) == bool(upload_token):
        raise HTTPException(400, "Provide exactly one of file or upload_token")

    if upload_token:
        # Continuing a pending layer choice — the file is already on disk
        # from the initial call, named `<token><suffix>` so the suffix (and
        # therefore file type) survives without a separate lookup table.
        if not re.fullmatch(r"[0-9a-f]{32}", upload_token):
            raise HTTPException(400, "Invalid upload_token")
        found = next(UPLOAD_TMP_DIR.glob(f"{upload_token}.*"), None)
        if not found:
            raise HTTPException(404, "Upload expired or already completed — please re-upload")
        tmp_path = found
        suffix = tmp_path.suffix
        original_name = None
    else:
        assert file is not None
        suffix = Path(file.filename or "").suffix.lower()
        if suffix not in ALLOWED_EXT:
            raise HTTPException(400, f"Unsupported file type '{suffix}'. Allowed: {', '.join(sorted(ALLOWED_EXT))}")

        tmp_path = UPLOAD_TMP_DIR / f"{uuid.uuid4().hex}{suffix}"
        size = 0
        with open(tmp_path, "wb") as tmp:
            while chunk := file.file.read(1024 * 1024):
                size += len(chunk)
                if size > MAX_BYTES:
                    tmp_path.unlink(missing_ok=True)
                    raise HTTPException(413, f"File exceeds the {MAX_BYTES // (1024*1024)} MB limit")
                tmp.write(chunk)
        original_name = file.filename

    if layer is None:
        spatial_layers = list_spatial_layers(tmp_path, suffix)
        if spatial_layers is not None and len(spatial_layers) == 0:
            tmp_path.unlink(missing_ok=True)
            raise HTTPException(400, "File has no spatial layers")
        if spatial_layers is not None and len(spatial_layers) > 1:
            # Deliberately not deleting tmp_path — the follow-up call with
            # `layer` set needs it, cleaned up either then or by the sweep.
            return {"needs_layer_choice": True, "layers": spatial_layers, "uploadToken": tmp_path.stem}
        if spatial_layers:
            layer = spatial_layers[0]

    try:
        gdf = read_vector(tmp_path, suffix, layer)
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(400, f"Could not read file as geodata: {e}")
    finally:
        tmp_path.unlink(missing_ok=True)

    base_name = title or (Path(original_name).stem if original_name else layer) or tmp_path.stem
    return ingest_geodataframe(gdf, base_name, user)


def ingest_geodataframe(gdf, base_name: str, user: dict | None, *, require_crs: bool = False) -> dict:
    """The shared tail of POST /upload and the QGIS-processing finalizer: an
    in-memory GeoDataFrame becomes a dwh table and a published layer.

    `require_crs` is the one real difference between the two callers. For a
    user's uploaded file a missing CRS is assumed to be 4326 — a pragmatic
    guess for a file someone hand-picked. For an algorithm result it is an
    error instead: quietly assuming 4326 for the output of, say, a
    reprojection would put the layer somewhere entirely wrong with nothing on
    screen to suggest it.
    """
    if gdf.empty:
        raise HTTPException(400, "File contains no features")
    if gdf.geometry.isna().all():
        raise HTTPException(400, "File has no geometry column")

    families = {GEOM_FAMILY.get(g, "OTHER") for g in gdf.geom_type.unique()}
    if len(families) != 1 or "OTHER" in families:
        raise HTTPException(400, f"Unsupported or mixed geometry types: {sorted(gdf.geom_type.unique())}")
    ms_type = families.pop()

    if gdf.crs is None:
        if require_crs:
            raise HTTPException(400, "Ergebnis hat kein Koordinatenbezugssystem")
        gdf = gdf.set_crs(4326)
    else:
        gdf = gdf.to_crs(4326)

    slug = slugify(base_name)
    table = unique_table_name(slug)
    geom_col = gdf.geometry.name

    eng = engine()
    try:
        gdf.to_postgis(table, eng, schema="dwh", if_exists="fail", index=False)
        # ensure_unique_column() rather than a hardcoded "ADD COLUMN gid": a
        # QGIS algorithm result copies its source table's columns verbatim, and
        # every layer this app publishes already has a "gid", so adding one
        # unconditionally collides every single time. That is the same trap
        # ensure_unique_column() was written for on the /geoprocess path — it
        # falls back to gid_2, gid_3, ... — so reuse it instead of growing a
        # second answer to the same question. An uploaded file normally has no
        # gid, so /upload still gets a plain "gid" exactly as before.
        unique_col = ensure_unique_column("dwh", table)
        with eng.begin() as conn:
            conn.execute(text(f'CREATE INDEX "{table}_geom_gist" ON "dwh"."{table}" USING GIST ("{geom_col}")'))
            conn.execute(text(f'ANALYZE "dwh"."{table}"'))
    except Exception as e:
        with eng.begin() as conn:
            conn.execute(text(f'DROP TABLE IF EXISTS "dwh"."{table}"'))
        raise HTTPException(500, f"Failed to load into PostGIS: {e}")

    append_layer_block(build_layer_block(table, base_name, ms_type, "dwh", table, geom_col, unique_col, 4326))
    seed_layer_style(table, ms_type, "dwh", table)
    generate_mapproxy_config()
    if user is not None:
        record_layer_owner(table, user)
    index_layer_for_search("dwh", table, table, base_name)
    superset_client.register_dataset("dwh", table)

    return {
        "layer": table,
        "title": base_name,
        "geometry_type": ms_type,
        "feature_count": len(gdf),
        "columns": gdf_attribute_columns(gdf, geom_col),
    }


# ----------------------------------------------------------- /upload-raster

def run_gdal(cmd: list[str]) -> None:
    """Runs a GDAL CLI tool, raising a 400 with its own stderr on failure.
    Shelled out rather than a Python binding (no rasterio/osgeo.gdal in
    requirements.txt) — the CLI tools are already in this image, the same
    way GeoPandas's OGR readers already depend on it for /upload."""
    try:
        subprocess.run(cmd, check=True, capture_output=True, text=True, timeout=300)
    except subprocess.CalledProcessError as e:
        raise HTTPException(400, f"{cmd[0]} failed: {e.stderr.strip()[-2000:]}")
    except subprocess.TimeoutExpired:
        raise HTTPException(400, f"{cmd[0]} timed out")


def probe_raster(path: Path) -> dict:
    """gdalinfo -json sniff, run on the original upload before any
    reprojection so a bad file fails fast. Also the defense against
    extension spoofing: a non-GeoTIFF renamed to .tif fails the driver
    check here rather than silently producing a broken layer."""
    try:
        result = subprocess.run(
            ["gdalinfo", "-json", str(path)],
            check=True, capture_output=True, text=True, timeout=60,
        )
    except subprocess.CalledProcessError as e:
        raise HTTPException(400, f"Could not read file as raster: {e.stderr.strip()[-2000:]}")
    except subprocess.TimeoutExpired:
        raise HTTPException(400, "gdalinfo timed out")
    info = json.loads(result.stdout)
    if info.get("driverShortName") != "GTiff":
        raise HTTPException(400, f"Expected a GeoTIFF, got driver '{info.get('driverShortName')}'")
    if not info.get("bands"):
        raise HTTPException(400, "File has no raster bands")
    return info


def normalize_raster(src: Path, dst: Path) -> None:
    """Reprojects to EPSG:4326 and forces the tiled+compressed layout
    MapServer and gdaladdo both want. Same gdalwarp idiom as
    terrain/build-terrain.sh, minus the DEM-specific bilinear resampling and
    nodata fill — an arbitrary upload shouldn't assume continuous elevation
    data, so this keeps gdalwarp's default nearest-neighbour resampling."""
    run_gdal([
        "gdalwarp", "-t_srs", "EPSG:4326",
        "-co", "TILED=YES", "-co", "COMPRESS=DEFLATE", "-co", "BIGTIFF=IF_SAFER",
        "-overwrite", str(src), str(dst),
    ])


def build_raster_overviews(path: Path) -> None:
    """Internal overviews (GTiff stores them in the same file, no .ovr
    sidecar) so the mapfile's PROCESSING "RESAMPLE=AVERAGE" has something to
    draw from at low zoom."""
    run_gdal(["gdaladdo", "-r", "average", str(path), "2", "4", "8", "16"])


def unique_raster_name(base: str) -> str:
    """Same collision-avoidance shape as publish_derived_table()'s inline
    dbtable_ loop, checked against all_layers() — there is no PostGIS table
    to check unique_table_name()-style against for a raster, and the name has
    to be unique against point clouds too, which live outside the mapfile."""
    existing = {l["name"] for l in all_layers()}
    name = f"raster_{base}"
    n = 2
    while name in existing:
        name = f"raster_{base}_{n}"
        n += 1
    return name


def build_raster_layer_block(
    name: str, title: str, path: Path, bands: int, batch: str | None = None, batch_title: str | None = None,
) -> str:
    # Keywordlist values are comma-split everywhere they're read (see
    # keywordValue() in wms.ts and keyword_value() below), so a raw
    # user-entered batch title could break parsing the moment it contains a
    # comma — quote() sidesteps that entirely rather than merely stripping
    # commas, which would silently mangle the title instead.
    batch_kw = f",batch:{batch},batch_title:{urllib.parse.quote(batch_title or '')}" if batch else ""
    return (
        "LAYER\n"
        f'  NAME        "{name}"\n'
        '  GROUP       "uploads"\n'
        "  TYPE        RASTER\n"
        "  STATUS      ON\n"
        f'  DATA        "{path}"\n'
        '  PROCESSING  "RESAMPLE=AVERAGE"\n'
        # Without this, any non-8-bit source (every Sentinel-2 band is
        # UInt16 reflectance, typically 0-~10000) renders as flat black —
        # MapServer draws raw pixel values with no stretch otherwise. A
        # no-op for ordinary 8-bit imagery.
        '  PROCESSING  "SCALE=AUTO"\n'
        "  PROJECTION\n"
        '    "init=epsg:4326"\n'
        "  END\n"
        "  METADATA\n"
        f'    "ows_title"         "{mapfile_escape(title)}"\n'
        '    "ows_group_title"   "Eigene Uploads"\n'
        '    "ows_srs"           "EPSG:4326 EPSG:3857 CRS:84"\n'
        # Deliberately no "source:" keyword — there is no schema.table behind
        # a raster layer. This is what keeps LayerState.source (wms.ts) null
        # for raster layers, which is what excludes them from every
        # .source-gated vector feature (attribute table, filter, classify,
        # geoprocess) without any new gating logic on the frontend. bands:
        # is what lets /raster-composite (and the layer panel's R/G/B
        # picker) tell a single-band layer apart from a composite without
        # re-probing the file. batch:/batch_title: (only set for a band
        # published from /upload-raster-zip) are what let the layer panel
        # collapse one zip upload's bands under one named group — MapServer's
        # own GROUP is a flat opaque string with no hierarchy (confirmed by
        # direct testing), so this grouping is a frontend-only concept
        # riding on the same keywordlist channel, independent of GROUP
        # "uploads" membership above.
        f'    "ows_keywordlist"   "geomtype:raster,bands:{bands}{batch_kw}"\n'
        "  END\n"
        "END\n"
    )


def publish_raster_layer(
    name: str, title: str, path: Path, bands: int, batch: str | None = None, batch_title: str | None = None,
    user: dict | None = None,
) -> dict:
    """The raster analogue of publish_derived_table()'s tail. No
    seed_layer_style() call — a continuous/RGB raster has no CLASS-based
    classification to seed, and apply_layer_style() no-ops for TYPE RASTER
    anyway."""
    append_layer_block(build_raster_layer_block(name, title, path, bands, batch, batch_title))
    generate_mapproxy_config()
    if user is not None:
        record_layer_owner(name, user)
    return {"layer": name, "title": title, "geometry_type": "RASTER"}


def normalize_tile_and_publish(
    src: Path, base_title: str, *, bands: int, width: int, height: int, data_type: str | None,
    batch: str | None = None, batch_title: str | None = None, user: dict | None = None,
) -> dict:
    """Shared tail of every raster-publish path: reproject+tile, build
    overviews, land it in RASTERS_DIR under a unique name, append the LAYER
    block. Used by /upload-raster directly and by /upload-raster-zip's
    per-band loop alike, so this logic exists once. batch/batch_title are
    only ever passed by the latter, tagging every band from one zip with the
    same batch id so the layer panel can collapse them together."""
    normalized_path = UPLOAD_TMP_DIR / f"{uuid.uuid4().hex}.tif"
    final_path: Path | None = None
    try:
        normalize_raster(src, normalized_path)
        build_raster_overviews(normalized_path)

        name = unique_raster_name(slugify(base_title))
        final_path = RASTERS_DIR / f"{name}.tif"
        # shutil.move(), not os.replace(): the upload temp dir and the
        # RASTERS_DIR bind mount are not guaranteed to be the same
        # filesystem, and os.replace() can't cross devices.
        shutil.move(str(normalized_path), str(final_path))

        result = publish_raster_layer(name, base_title, final_path, bands, batch, batch_title, user)
    except Exception:
        if final_path is not None:
            final_path.unlink(missing_ok=True)
        raise
    finally:
        normalized_path.unlink(missing_ok=True)  # no-op once moved

    result.update({"bands": bands, "width": width, "height": height, "data_type": data_type})
    return result


@app.post("/upload-raster")
def upload_raster(
    file: UploadFile = File(...),
    title: str | None = Form(None),
    user: dict = Depends(require_tier("pro")),
):
    check_raster_volume()
    UPLOAD_TMP_DIR.mkdir(parents=True, exist_ok=True)

    suffix = Path(file.filename or "").suffix.lower()
    if suffix not in RASTER_ALLOWED_EXT:
        raise HTTPException(400, f"Unsupported file type '{suffix}'. Allowed: {', '.join(sorted(RASTER_ALLOWED_EXT))}")

    tmp_path = UPLOAD_TMP_DIR / f"{uuid.uuid4().hex}{suffix}"
    size = 0
    with open(tmp_path, "wb") as tmp:
        while chunk := file.file.read(1024 * 1024):
            size += len(chunk)
            if size > MAX_BYTES:
                tmp_path.unlink(missing_ok=True)
                raise HTTPException(413, f"File exceeds the {MAX_BYTES // (1024*1024)} MB limit")
            tmp.write(chunk)

    try:
        info = probe_raster(tmp_path)
        base_name = title or band_label(info) or Path(file.filename or "").stem or "raster"
        band = info["bands"][0]
        result = normalize_tile_and_publish(
            tmp_path, base_name,
            bands=len(info["bands"]), width=info["size"][0], height=info["size"][1],
            data_type=band.get("type"), user=user,
        )
    finally:
        tmp_path.unlink(missing_ok=True)

    return result


# ------------------------------------------------------- /upload-raster-zip

RASTER_ZIP_MEMBER_EXT = {".tif", ".tiff", ".jp2"}


def band_label(info: dict) -> str | None:
    """Best-effort band identifier straight from GDAL's own metadata, so a
    Sentinel-2-style band keeps its real name (e.g. "B04") instead of an
    opaque filename stem. Tries, in order: the raster band's own
    description (GDAL's SetDescription()/GetDescription(), the most direct
    channel for this), then a handful of common band-identifying metadata
    keys at band and dataset level. None if nothing usable is found —
    callers fall back to the file's own name, exactly as before this
    existed."""
    band = info["bands"][0]
    label = (band.get("description") or "").strip()
    if label:
        return label
    candidate_keys = ("BANDNAME", "BAND_NAME", "BAND_ID", "BAND")
    for domain in (band.get("metadata", {}).get("", {}), info.get("metadata", {}).get("", {})):
        for key in candidate_keys:
            value = (domain.get(key) or "").strip()
            if value:
                return value
    return None


def probe_raster_lenient(path: Path) -> dict | None:
    """Like probe_raster(), but for scanning an extracted zip's arbitrary
    members: no GTiff-only driver check (a Sentinel-2 band is natively
    JP2OpenJPEG, not GeoTIFF), and any failure/timeout returns None instead
    of raising — a zip's non-raster members (metadata XML, thumbnails, the
    .SAFE manifest) are expected to fail this, and that failure is the
    discovery filter itself, not an error. probe_raster() stays untouched:
    its strict GTiff check is still exactly right for /upload-raster's own
    extension-spoofing defense."""
    try:
        result = subprocess.run(
            ["gdalinfo", "-json", str(path)],
            check=True, capture_output=True, text=True, timeout=60,
        )
    except (subprocess.CalledProcessError, subprocess.TimeoutExpired):
        return None
    info = json.loads(result.stdout)
    return info if info.get("bands") else None


def extract_raster_zip(zip_path: Path, dest: Path) -> list[dict]:
    """Extracts a raster zip (e.g. a Sentinel-2 product) and probes every
    member, mirroring read_vector()'s zip-slip guard for shapefile zips.
    Returns a manifest of every member GDAL can actually open as a raster;
    anything else inside the zip is silently skipped."""
    with zipfile.ZipFile(zip_path) as zf:
        for entry in zf.namelist():
            if entry.startswith("/") or ".." in Path(entry).parts:
                raise HTTPException(400, f"Unsafe path in zip: {entry}")
        zf.extractall(dest)

    manifest = []
    for path in sorted(dest.rglob("*")):
        if not path.is_file() or path.suffix.lower() not in RASTER_ZIP_MEMBER_EXT:
            continue
        info = probe_raster_lenient(path)
        if not info:
            continue
        band = info["bands"][0]
        manifest.append({
            "path": str(path.relative_to(dest)),
            "bands": len(info["bands"]),
            "width": info["size"][0],
            "height": info["size"][1],
            "data_type": band.get("type"),
            "driver": info.get("driverShortName"),
            "band_label": band_label(info),
        })
    if not manifest:
        raise HTTPException(400, "Zip contains no files GDAL can read as a raster")
    return manifest


@app.post("/upload-raster-zip")
def upload_raster_zip(
    file: UploadFile = File(...),
    title: str | None = Form(None),
    user: dict = Depends(require_tier("pro")),
):
    """Every raster-readable member of the zip gets published immediately,
    each as its own single-band layer — no per-band choice at upload time
    (see /raster-composite for building an RGB layer from published bands).
    `title` names the *batch* (shown as one collapsible group in the layer
    panel), not any single band — falls back to the zip's own filename when
    blank, same convention /upload-raster uses for a single file. One
    request, no handshake: the extraction directory only needs to live for
    this request's duration, so a plain tempfile.TemporaryDirectory() (same
    idiom read_vector() already uses for its own zip-extraction fallback)
    is enough."""
    check_raster_volume()
    UPLOAD_TMP_DIR.mkdir(parents=True, exist_ok=True)

    suffix = Path(file.filename or "").suffix.lower()
    if suffix != ".zip":
        raise HTTPException(400, "Expected a .zip file")

    zip_path = UPLOAD_TMP_DIR / f"{uuid.uuid4().hex}.zip"
    size = 0
    with open(zip_path, "wb") as tmp:
        while chunk := file.file.read(1024 * 1024):
            size += len(chunk)
            if size > MAX_BYTES:
                zip_path.unlink(missing_ok=True)
                raise HTTPException(413, f"File exceeds the {MAX_BYTES // (1024*1024)} MB limit")
            tmp.write(chunk)

    batch_title = title or Path(file.filename or "").stem or "raster"
    # A short opaque id, not a display name — never collides, and (unlike a
    # human-facing name) needs no unique_raster_name()-style dedup.
    batch = uuid.uuid4().hex[:12]

    published: list[dict] = []
    failed: list[dict] = []
    try:
        with tempfile.TemporaryDirectory(dir=UPLOAD_TMP_DIR) as tmpdir:
            manifest = extract_raster_zip(zip_path, Path(tmpdir))
            # Each band is independent — one bad one shouldn't sink the
            # other eleven — so failures are collected, not raised.
            for m in manifest:
                try:
                    # A band's own name/number from GDAL's metadata (e.g.
                    # "B04") beats the filename stem when GDAL actually
                    # reports one — falls back to the file's own name
                    # otherwise, same as before this existed.
                    published.append(normalize_tile_and_publish(
                        Path(tmpdir) / m["path"], m["band_label"] or Path(m["path"]).stem,
                        bands=m["bands"], width=m["width"], height=m["height"], data_type=m["data_type"],
                        batch=batch, batch_title=batch_title, user=user,
                    ))
                except HTTPException as e:
                    failed.append({"input": m["path"], "error": e.detail})
    finally:
        zip_path.unlink(missing_ok=True)

    return {"published": published, "failed": failed}


# ------------------------------------------------------------ /raster-composite

class RasterCompositeBody(BaseModel):
    red: str
    green: str
    blue: str
    title: str | None = None


def raster_layer_or_400(layers_by_name: dict[str, dict], name: str, role: str) -> dict:
    layer = layers_by_name.get(name)
    if not layer or layer["geometry_type"] != "RASTER":
        raise HTTPException(400, f"{role}: not a published raster layer: {name}")
    if layer.get("bands") != 1:
        raise HTTPException(400, f"{role}: not a single-band raster layer: {name}")
    return layer


@app.post("/raster-composite")
def raster_composite(body: RasterCompositeBody, user: dict = Depends(require_tier("pro"))):
    """Composes three already-published single-band raster layers into one
    RGB layer — "on the fly" in the literal sense: every raster this app
    publishes is already reprojected to EPSG:4326 at its own publish time
    (normalize_raster), so three of them are already in the same CRS, and
    combining them is just a VRT (a small XML file referencing the three
    existing files directly) rather than a new reprojection/resample pass
    over real pixel data."""
    check_raster_volume()
    layers_by_name = {l["name"]: l for l in read_layers()}
    red = raster_layer_or_400(layers_by_name, body.red, "red")
    green = raster_layer_or_400(layers_by_name, body.green, "green")
    blue = raster_layer_or_400(layers_by_name, body.blue, "blue")

    base_title = body.title or f"{red['title']}+{green['title']}+{blue['title']}"
    name = unique_raster_name(slugify(base_title))
    dst = RASTERS_DIR / f"{name}.vrt"
    # -resolution highest reconciles any resolution difference between the
    # three sources (e.g. a 10m band next to a 60m one) by resampling to
    # the finest, the same way a Sentinel-2 scene's own bands differ.
    run_gdal([
        "gdalbuildvrt", "-separate", "-resolution", "highest", "-r", "bilinear",
        str(dst), red["path"], green["path"], blue["path"],
    ])
    # VRT can't hold overviews internally, hence the external .vrt.ovr
    # sidecar — build_raster_overviews() is already generic enough to not
    # care which of the two shapes it's building for.
    build_raster_overviews(dst)
    return publish_raster_layer(name, base_title, dst, bands=3, user=user)


# ------------------------------------------------------- /upload-pointcloud

# LAS point formats that carry red/green/blue dimensions. Anything else has
# no per-point color at all, which is why the frontend defaults such a layer
# to a flat single color — an uncolored cloud renders white and, against the
# globe's white base color, looks like a failed upload rather than a working
# layer with no color data.
POINTCLOUD_RGB_FORMATS = {2, 3, 5, 7, 8, 10}

# How many points probe_pointcloud() looks at to decide whether the file has
# meaningful classification. A LAS where everything is class 0/1 (never
# classified / unassigned) gets no "colour by classification" option, and
# finding that out must not mean reading two gigabytes to answer a question
# about a dropdown.
POINTCLOUD_CLASS_SAMPLE = 2_000_000


def run_py3dtiles(cmd: list[str], timeout: int) -> None:
    """py3dtiles' analogue of run_gdal(): shell out, surface the tool's own
    stderr on failure, bound the runtime. Separate from run_gdal() only for
    the timeout — 300s is right for a gdalwarp pass and far too short for a
    point-cloud conversion, which is the slow part of this whole route."""
    try:
        subprocess.run(cmd, check=True, capture_output=True, text=True, timeout=timeout)
    except subprocess.CalledProcessError as e:
        raise HTTPException(400, f"py3dtiles failed: {e.stderr.strip()[-2000:]}")
    except subprocess.TimeoutExpired:
        raise HTTPException(
            400,
            "Die Konvertierung hat zu lange gedauert. Die Datei ist zu gross für den "
            "synchronen Upload — bitte in kleinere Kacheln aufteilen.",
        )


def probe_pointcloud(path: Path) -> dict:
    """laspy header sniff, run before any conversion so a bad file fails fast.

    Also the defense against extension spoofing, exactly as probe_raster() is
    for GeoTIFFs: anything that is not really a LAS/LAZ fails the header parse
    here and 400s with laspy's own message, rather than being handed to
    py3dtiles and producing a confusing failure several minutes later.
    """
    try:
        with laspy.open(str(path)) as f:
            header = f.header
            crs = header.parse_crs()
            point_format = header.point_format.id
            point_count = header.point_count
            mins, maxs = header.mins, header.maxs

            # py3dtiles builds its --extra-fields list from the point format's
            # *dtype* field names, not laspy's logical dimension names. In
            # point formats 0-5 the classification is packed into a shared
            # byte exposed as "raw_classification", so "classification" is not
            # a dtype field there and py3dtiles silently writes a column of
            # zeros instead of refusing — a layer that colours every point the
            # same and looks broken. Verified directly against both shapes;
            # only formats 6+ expose it standalone.
            classification_convertible = "classification" in header.point_format.dtype().fields

            has_classification = False
            if point_count and classification_convertible:
                # Chunked, and capped: this is only deciding whether to offer
                # a dropdown entry, so a partial answer on a huge file is the
                # right trade. Classes 0 and 1 both mean "not classified".
                seen = 0
                for chunk in f.chunk_iterator(1_000_000):
                    if set(np.unique(chunk.classification)) - {0, 1}:
                        has_classification = True
                        break
                    seen += len(chunk.classification)
                    if seen >= POINTCLOUD_CLASS_SAMPLE:
                        break
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(400, f"Datei konnte nicht als LAS/LAZ gelesen werden: {e}")

    return {
        "point_count": int(point_count),
        "epsg": crs.to_epsg() if crs is not None else None,
        "point_format": point_format,
        "has_color": point_format in POINTCLOUD_RGB_FORMATS,
        "has_classification": has_classification,
        "mins": list(mins),
        "maxs": list(maxs),
    }


def pointcloud_bbox_wgs84(epsg: int, mins: list, maxs: list) -> dict | None:
    """Source-CRS corner coordinates -> the WGS84 bbox the layer panel's
    zoom-to-extent needs.

    always_xy=True is load-bearing, not decoration: EPSG:4326 declares
    latitude first, so without it pyproj returns (lat, lon) here and the bbox
    comes out silently transposed — a layer that zooms to the wrong hemisphere
    rather than failing.
    """
    try:
        tf = pyproj.Transformer.from_crs(f"EPSG:{epsg}", "EPSG:4326", always_xy=True)
        xs, ys = tf.transform([mins[0], maxs[0]], [mins[1], maxs[1]])
    except Exception as e:
        log.warning("could not project point cloud bbox", extra={"error": str(e)})
        return None
    if not all(map(math.isfinite, (*xs, *ys))):
        return None
    return {"west": min(xs), "south": min(ys), "east": max(xs), "north": max(ys)}


def unique_pointcloud_name(base: str) -> str:
    """Same collision-avoidance shape as unique_raster_name(), but checked
    against all_layers() so a point cloud can never take a name a mapfile
    layer already holds (or the reverse — the raster and vector paths check
    the same combined set).

    The prefix must not be `upload_`: collectionFor() in wms.ts falls back to
    dwh.<name> for anything named that way, which would offer an attribute
    table against a PostGIS table that does not exist.
    """
    existing = {l["name"] for l in all_layers()}
    name = f"pointcloud_{base}"
    n = 2
    while name in existing:
        name = f"pointcloud_{base}_{n}"
        n += 1
    return name


def publish_pointcloud_layer(name: str, title: str, probe: dict, srs_in: int, user: dict | None) -> dict:
    """The point-cloud analogue of publish_raster_layer()'s tail — and much
    shorter, because none of the mapfile machinery applies. No
    append_layer_block() (there is no block), no generate_mapproxy_config()
    (nothing to cache — the tileset is served straight off disk), and no
    seed_layer_style() (no CLASS-based styling for a 3D Tiles tileset).
    """
    bbox = pointcloud_bbox_wgs84(srs_in, probe["mins"], probe["maxs"])
    with engine().begin() as conn:
        conn.execute(text(
            "INSERT INTO configdb.point_clouds "
            "(layer_name, title, point_count, srs_in, west, south, east, north, "
            " has_color, has_classification) "
            "VALUES (:n, :t, :pc, :srs, :w, :s, :e, :no, :hc, :hcl)"
        ), {
            "n": name, "t": title, "pc": probe["point_count"], "srs": str(srs_in),
            "w": bbox["west"] if bbox else None, "s": bbox["south"] if bbox else None,
            "e": bbox["east"] if bbox else None, "no": bbox["north"] if bbox else None,
            "hc": probe["has_color"], "hcl": probe["has_classification"],
        })
    if user is not None:
        record_layer_owner(name, user)
    return {
        "layer": name,
        "title": title,
        "geometry_type": "POINTCLOUD",
        "tileset_url": f"/pointclouds/{name}/tileset.json",
        "point_count": probe["point_count"],
        "bbox": bbox,
        "has_color": probe["has_color"],
        "has_classification": probe["has_classification"],
    }


def delete_pointcloud_layer(name: str, delete_files: bool) -> bool:
    """Unpublishes a point cloud, or reports that `name` is not one.

    Returns False for a name with no registry row, which is what lets DELETE
    /layers fall through to its normal mapfile path — the caller has already
    done the ownership check, so this is only ever deciding which kind of
    layer it is holding.
    """
    with engine().begin() as conn:
        deleted = conn.execute(
            text("DELETE FROM configdb.point_clouds WHERE layer_name = :n RETURNING layer_name"),
            {"n": name},
        ).first()
    if deleted is None:
        return False
    if delete_files:
        # Reconstructed from the name the registry just confirmed, never from
        # a stored path — the same reasoning the raster branch below gives.
        shutil.rmtree(POINTCLOUDS_DIR / name, ignore_errors=True)
    return True


@app.post("/upload-pointcloud")
def upload_pointcloud(
    file: UploadFile = File(...),
    title: str | None = Form(None),
    srs: str | None = Form(None),
    user: dict = Depends(require_tier("pro")),
):
    check_pointcloud_volume()
    UPLOAD_TMP_DIR.mkdir(parents=True, exist_ok=True)

    suffix = Path(file.filename or "").suffix.lower()
    if suffix not in POINTCLOUD_ALLOWED_EXT:
        raise HTTPException(
            400,
            f"Unsupported file type '{suffix}'. Allowed: {', '.join(sorted(POINTCLOUD_ALLOWED_EXT))}",
        )

    tmp_path = UPLOAD_TMP_DIR / f"{uuid.uuid4().hex}{suffix}"
    size = 0
    with open(tmp_path, "wb") as tmp:
        while chunk := file.file.read(1024 * 1024):
            size += len(chunk)
            if size > MAX_BYTES:
                tmp_path.unlink(missing_ok=True)
                raise HTTPException(413, f"File exceeds the {MAX_BYTES // (1024*1024)} MB limit")
            tmp.write(chunk)

    work_dir = UPLOAD_TMP_DIR / uuid.uuid4().hex
    final_dir: Path | None = None
    try:
        probe = probe_pointcloud(tmp_path)

        # The input CRS is required, never guessed: putting a cloud on the
        # globe with the wrong one silently drops it in the ocean or
        # underground, which is far worse than refusing the upload. The
        # header is preferred, the form field is the fallback, and if there
        # is neither the error says exactly what to supply.
        srs_in = probe["epsg"]
        if srs:
            try:
                srs_in = int(str(srs).strip().upper().removeprefix("EPSG:"))
            except ValueError:
                raise HTTPException(400, f"Ungültiger EPSG-Code: '{srs}'")
        if srs_in is None:
            raise HTTPException(
                400,
                "Die Datei enthält kein Koordinatensystem — bitte EPSG-Code angeben, z.B. 25832.",
            )

        base_title = title or Path(file.filename or "").stem or "punktwolke"
        name = unique_pointcloud_name(slugify(base_title))

        # Only asked for when probe_pointcloud() proved it will actually
        # arrive: py3dtiles warns but still succeeds when the field is
        # missing, writing zeros, so passing it unconditionally would produce
        # a "colour by classification" option that greys the whole cloud out.
        extra_fields = ["--extra-fields", "classification"] if probe["has_classification"] else []

        run_py3dtiles([
            PY3DTILES_BIN, "convert", str(tmp_path),
            "--out", str(work_dir),
            "--srs_in", str(srs_in),
            "--srs_out", POINTCLOUD_SRS_OUT,
            "--overwrite",
            *extra_fields,
            # Bounded rather than the CPU-count default: this runs inside a
            # request on a box that is also serving the rest of the stack.
            "--jobs", "2",
            # Docker gives a container 64MB of /dev/shm by default, which is
            # exactly the "environment lacking shared memory" this flag
            # exists for. Cheaper than raising shm_size on the service.
            "--disable-processpool",
        ], timeout=POINTCLOUD_CONVERT_TIMEOUT)

        # py3dtiles can exit 0 having written nothing usable, so the presence
        # of the tileset is checked rather than assumed — publishing a row for
        # an empty directory would produce a layer that 404s for everyone.
        if not (work_dir / "tileset.json").exists():
            raise HTTPException(400, "Die Konvertierung hat kein tileset.json erzeugt.")

        final_dir = POINTCLOUDS_DIR / name
        # shutil.move(), not os.replace(): the upload temp dir and the
        # POINTCLOUDS_DIR bind mount are not guaranteed to be the same
        # filesystem, same as normalize_tile_and_publish() documents.
        shutil.move(str(work_dir), str(final_dir))

        result = publish_pointcloud_layer(name, base_title, probe, srs_in, user)
    except Exception:
        if final_dir is not None:
            shutil.rmtree(final_dir, ignore_errors=True)
        raise
    finally:
        tmp_path.unlink(missing_ok=True)
        shutil.rmtree(work_dir, ignore_errors=True)  # no-op once moved

    return result


# --------------------------------------------------------- /register-table

class RegisterTableBody(BaseModel):
    schema_name: str
    table: str
    title: str | None = None


def find_geometry_column(schema: str, table: str) -> tuple[str, int]:
    with engine().begin() as conn:
        row = conn.execute(
            text(
                "SELECT f_geometry_column, srid FROM geometry_columns "
                "WHERE f_table_schema = :s AND f_table_name = :t LIMIT 1"
            ),
            {"s": schema, "t": table},
        ).first()
    if not row:
        raise HTTPException(404, f"No geometry column found for {schema}.{table}")
    geom_col, srid = row
    return geom_col, (srid or 4326)


def geometry_family_for_table(schema: str, table: str, geom_col: str) -> str:
    with engine().begin() as conn:
        rows = conn.execute(
            text(
                f'SELECT DISTINCT ST_GeometryType("{geom_col}") FROM "{schema}"."{table}" '
                f'WHERE "{geom_col}" IS NOT NULL LIMIT 2000'
            )
        ).all()
    st_types = {r[0] for r in rows}
    families = {ST_GEOM_FAMILY.get(t, "OTHER") for t in st_types}
    if len(families) != 1 or "OTHER" in families:
        raise HTTPException(400, f"Unsupported or mixed geometry types: {sorted(st_types)}")
    return families.pop()


def non_geometry_columns(schema: str, table: str, geom_col: str) -> list[str]:
    """Postgres has no `SELECT * REPLACE`, unlike BigQuery — this is how
    geoprocess() builds an explicit column list wherever it needs every
    column except the one it's replacing with a computed geometry."""
    with engine().begin() as conn:
        rows = conn.execute(
            text(
                "SELECT column_name FROM information_schema.columns "
                "WHERE table_schema = :s AND table_name = :t AND column_name != :g "
                "ORDER BY ordinal_position"
            ),
            {"s": schema, "t": table, "g": geom_col},
        ).all()
    return [r[0] for r in rows]


def publish_derived_table(schema: str, table: str, title: str | None, user: dict | None = None) -> dict:
    """The shared tail of /register-table and /geoprocess: a table that
    already exists in PostGIS, published as a new LAYER block."""
    geom_col, srid = find_geometry_column(schema, table)
    ms_type = geometry_family_for_table(schema, table, geom_col)
    unique_col = ensure_unique_column(schema, table)

    resolved_title = title or table
    base = slugify(f"{schema}_{table}")
    # all_layers(), not read_layers(): a published name has to be unique
    # across both sources, since point clouds are not in the mapfile.
    existing_names = {l["name"] for l in all_layers()}
    name = f"dbtable_{base}"
    n = 2
    while name in existing_names:
        name = f"dbtable_{base}_{n}"
        n += 1

    append_layer_block(build_layer_block(name, resolved_title, ms_type, schema, table, geom_col, unique_col, srid))
    seed_layer_style(name, ms_type, schema, table)
    generate_mapproxy_config()
    if user is not None:
        record_layer_owner(name, user)
    index_layer_for_search(schema, table, name, resolved_title)
    superset_client.register_dataset(schema, table)

    return {
        "layer": name,
        "title": resolved_title,
        "geometry_type": ms_type,
        "schema": schema,
        "table": table,
        "columns": table_attribute_columns(schema, table, geom_col),
    }


def find_unique_int_column(schema: str, table: str) -> str | None:
    with engine().begin() as conn:
        row = conn.execute(
            text(
                "SELECT a.attname FROM pg_index i "
                "JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey) "
                "WHERE i.indrelid = (:qualified)::regclass AND i.indisprimary "
                "AND cardinality(i.indkey) = 1"
            ),
            {"qualified": f'"{schema}"."{table}"'},
        ).first()
    return row[0] if row else None


def ensure_unique_column(schema: str, table: str) -> str:
    col = find_unique_int_column(schema, table)
    if col:
        return col
    with engine().begin() as conn:
        # A table can already have a plain (non-PK) column named "gid" — most
        # commonly one carried over verbatim from a source table by geoprocess()'s
        # CREATE TABLE AS SELECT, since "gid" is this very function's own default
        # name for a synthetic PK on an originally-imported layer. Blindly adding
        # "gid" would collide with it, so check first.
        existing = {
            r[0]
            for r in conn.execute(
                text("SELECT column_name FROM information_schema.columns WHERE table_schema = :s AND table_name = :t"),
                {"s": schema, "t": table},
            ).all()
        }
        name = "gid"
        n = 2
        while name in existing:
            name = f"gid_{n}"
            n += 1
        conn.execute(text(f'ALTER TABLE "{schema}"."{table}" ADD COLUMN "{name}" SERIAL PRIMARY KEY'))
    return name


DISTINCT_VALUES_LIMIT = 500


@app.get("/distinct-values")
def distinct_values(schema: str, table: str, column: str, user: dict = Depends(require_login)):
    """
    Backs the filter builder's value dropdown for text columns: a real
    SELECT DISTINCT server-side, not a client-side sample, so it's correct
    and fast regardless of table size. Capped at DISTINCT_VALUES_LIMIT —
    `truncated` tells the frontend there may be more.
    """
    schema, table = authorize_table(schema, table, user)
    column = check_identifier(column, "column name")

    with engine().begin() as conn:
        rows = conn.execute(
            text(
                f'SELECT DISTINCT "{column}" FROM "{schema}"."{table}" '
                f'WHERE "{column}" IS NOT NULL ORDER BY "{column}" LIMIT :limit'
            ),
            {"limit": DISTINCT_VALUES_LIMIT + 1},
        ).all()

    return {
        "values": [str(r[0]) for r in rows[:DISTINCT_VALUES_LIMIT]],
        "truncated": len(rows) > DISTINCT_VALUES_LIMIT,
    }


@app.get("/column-stats")
def column_stats(
    schema: str, table: str, column: str, filter: str | None = None, user: dict = Depends(require_login)
):
    """
    Min/max/sum/avg/count of a numeric column — min/max seed the graduated
    classification editor's default breaks; sum/avg/count back the
    dashboard's "everything selected" overview (SelectionDashboard.tsx's
    LayerOverviewCard), which has no in-memory features to aggregate over
    client-side the way a real selection does. `filter`, when given, scopes
    all of this to that layer's active attribute filter instead of the whole
    table — see build_filter_where().
    """
    schema, table = authorize_table(schema, table, user)
    column = check_identifier(column, "column name")

    params: dict = {}
    extra_where = build_filter_where(parse_layer_filter(filter), params)
    if extra_where:
        extra_where = f"AND {extra_where}"

    with engine().begin() as conn:
        row = conn.execute(
            text(
                f'SELECT MIN("{column}"), MAX("{column}"), SUM("{column}"), AVG("{column}"), COUNT("{column}") '
                f'FROM "{schema}"."{table}" WHERE "{column}" IS NOT NULL {extra_where}'
            ),
            params,
        ).first()

    if row is None or row[0] is None:
        raise HTTPException(404, f"No values found for {schema}.{table}.{column}")
    return {
        "min": float(row[0]),
        "max": float(row[1]),
        "sum": float(row[2]),
        "avg": float(row[3]),
        "count": int(row[4]),
    }


BREAK_METHODS = {"equal", "quantile", "jenks"}
MAX_BREAK_CLASSES = 12
# Jenks is an O(k·n²) dynamic program. It runs on a deterministic even-stride
# sample rather than the whole column so a million-row table costs the same as
# a thousand-row one; at this cap the cost matrix is ~11 MB and the whole solve
# well under a second. A class *boundary* only ever needs to land in about the
# right place, so a 1200-point picture of the distribution is plenty — the two
# outer edges are replaced with the table's true MIN/MAX afterwards either way.
JENKS_SAMPLE_CAP = 1200


def jenks_edges(sample: "np.ndarray", k: int) -> list[float]:
    """
    Fisher-Jenks natural breaks: the partition of `sample` into k contiguous
    classes minimising the total within-class sum of squared deviations.

    Exact (the classic DP, not a k-means approximation), vectorised over the
    split point so each of the k passes is one numpy reduction over an n×n
    cost matrix instead of a Python loop. Returns k+1 edges, lowest first.
    """
    v = np.sort(sample)
    n = v.size
    if n <= k:
        # Fewer sample points than classes — nothing to optimise; hand back
        # the points themselves so the caller still gets k+1 monotonic edges.
        edges = list(np.linspace(v[0], v[-1], k + 1))
        return [float(e) for e in edges]

    s1 = np.concatenate(([0.0], np.cumsum(v)))
    s2 = np.concatenate(([0.0], np.cumsum(v * v)))
    idx = np.arange(n)
    # cost[a, b] = within-class SSE of v[a..b] (inclusive), +inf where b < a.
    count = (idx[None, :] - idx[:, None] + 1).astype(float)
    sum1 = s1[1:][None, :] - s1[:n][:, None]
    sum2 = s2[1:][None, :] - s2[:n][:, None]
    with np.errstate(divide="ignore", invalid="ignore"):
        cost = sum2 - sum1 * sum1 / count
    cost[count <= 0] = np.inf
    np.clip(cost, 0.0, None, out=cost)

    best = cost[0].copy()               # one class covering v[0..b]
    splits = np.zeros((k + 1, n), dtype=np.int64)
    for c in range(2, k + 1):
        # cand[m - 1, b] = best-with-(c-1)-classes up to m-1, plus v[m..b].
        cand = best[: n - 1][:, None] + cost[1:]
        take = np.argmin(cand, axis=0)
        splits[c] = take + 1
        best = cand[take, idx]

    edges = [float(v[-1])]
    b = n - 1
    for c in range(k, 1, -1):
        m = int(splits[c][b])
        edges.append(float(v[m - 1]))   # top of the class below the split
        b = m - 1
    edges.append(float(v[0]))
    return list(reversed(edges))


@app.get("/column-breaks")
def column_breaks(
    schema: str, table: str, column: str, method: str = "equal", classes: int = 5,
    filter: str | None = None, user: dict = Depends(require_login),
):
    """
    The class boundaries behind ClassifyLayer.tsx's "Klassifizierungsmethode"
    picker: k+1 edges, lowest first, for a numeric column split `classes`
    ways. Same `filter` scoping and same ACL as /column-stats, which this
    sits next to and shares its MIN/MAX with.

    Server-side for the same reason /distinct-values is: quantiles and Jenks
    both describe the *distribution*, so computing them from whatever subset
    of rows a browser happened to fetch would quietly give a different answer
    on a large layer than on a small one. `quantile` is Postgres's own
    percentile_cont, exact over every row; `jenks` samples (see
    JENKS_SAMPLE_CAP). `equal` needs nothing but MIN/MAX and the frontend
    computes it locally to keep the class-count spinner instant — it is
    served here too so all three methods have one definition to check
    against.
    """
    schema, table = authorize_table(schema, table, user)
    column = check_identifier(column, "column name")
    if method not in BREAK_METHODS:
        raise HTTPException(400, f"method must be one of {sorted(BREAK_METHODS)}")
    if not 2 <= classes <= MAX_BREAK_CLASSES:
        raise HTTPException(400, f"classes must be between 2 and {MAX_BREAK_CLASSES}")

    params: dict = {}
    extra_where = build_filter_where(parse_layer_filter(filter), params)
    if extra_where:
        extra_where = f"AND {extra_where}"
    where = f'WHERE "{column}" IS NOT NULL {extra_where}'

    with engine().begin() as conn:
        row = conn.execute(
            text(f'SELECT MIN("{column}"), MAX("{column}"), COUNT("{column}") FROM "{schema}"."{table}" {where}'),
            params,
        ).first()
        if row is None or row[0] is None:
            raise HTTPException(404, f"No values found for {schema}.{table}.{column}")
        lo, hi, total = float(row[0]), float(row[1]), int(row[2])

        if method == "quantile":
            fractions = [i / classes for i in range(1, classes)]
            inner = conn.execute(
                text(
                    f'SELECT percentile_cont(CAST(:fracs AS double precision[])) WITHIN GROUP (ORDER BY "{column}"::double precision) '
                    f'FROM "{schema}"."{table}" {where}'
                ),
                {**params, "fracs": fractions},
            ).scalar()
            edges = [lo, *[float(x) for x in (inner or [])], hi]
        elif method == "jenks":
            # Even-stride sample via row_number(), not TABLESAMPLE/random():
            # the same table and filter must give the same breaks every time,
            # or re-opening the editor would silently redraw the map.
            stride = max(1, math.ceil(total / JENKS_SAMPLE_CAP))
            rows = conn.execute(
                text(
                    f'SELECT v FROM (SELECT "{column}"::double precision AS v, '
                    f'row_number() OVER (ORDER BY "{column}") AS rn '
                    f'FROM "{schema}"."{table}" {where}) s WHERE mod(rn - 1, :stride) = 0'
                ),
                {**params, "stride": stride},
            ).scalars().all()
            edges = jenks_edges(np.asarray(rows, dtype=float), classes)
            edges[0], edges[-1] = lo, hi
        else:
            step = (hi - lo) / classes
            edges = [lo + step * i for i in range(classes)] + [hi]

    # Ties (a heavily repeated value, or a constant column) can make two edges
    # equal — an empty class, not an error. What must never happen is an edge
    # going *backwards*, which would render as a range with min > max.
    for i in range(1, len(edges)):
        edges[i] = max(edges[i], edges[i - 1])
    return {"edges": edges, "min": lo, "max": hi, "count": total}


GROUPBY_LABEL_SEP = " / "
GROUPBY_AGGS = {"count", "sum", "avg", "min", "max"}


def column_is_numeric(schema: str, table: str, column: str) -> bool:
    with engine().begin() as conn:
        data_type = conn.execute(
            text(
                "SELECT data_type FROM information_schema.columns "
                "WHERE table_schema = :s AND table_name = :t AND column_name = :c"
            ),
            {"s": schema, "t": table, "c": column},
        ).scalar()
    return data_type in (
        "smallint", "integer", "bigint", "decimal", "numeric", "real", "double precision",
    )


@app.get("/column-groupby")
def column_groupby(
    schema: str, table: str, column: str, filter: str | None = None,
    value_column: str | None = None, agg: str = "count",
    user: dict = Depends(require_tier("pro")),
):
    """
    Value + count per distinct value (or, for `column` given as a
    comma-separated list, per distinct *combination* of values — premium
    only, see below), ordered by count descending — the server-side
    equivalent of the client-side group-by SelectionDashboard.tsx does over
    a real selection's in-memory features, for the "everything selected"
    overview where there are none. Capped like /distinct-values;
    `totalCount` is an exact count across every value (not just the capped
    ones returned), so the frontend can compute an exact "Andere" remainder
    even beyond the cap. `filter`, when given, scopes both queries to that
    layer's active attribute filter — see build_filter_where().

    `value_column`/`agg` are optional — when given, each bucket also carries
    `sum`/`min`/`max` alongside `count` (now COUNT(value_column), not
    COUNT(*)), and `agg` picks which of those four orders the result (still
    capped/returned as all four either way, cheap in the same GROUP BY — the
    frontend picks which one to display and needs the others anyway to
    reconstruct an exact "Andere" bucket for count/sum/avg; see
    SelectionDashboard.tsx's bucketTopNByAgg()). `sum` (and therefore `avg`,
    which the frontend derives from sum/count rather than a fifth number)
    only ever applies to a numeric column — checked via information_schema
    here rather than trusting the frontend, since a raw SUM() on a text
    column is a Postgres error, not a 0.
    """
    schema, table = authorize_table(schema, table, user)
    columns = [check_identifier(c.strip(), "column name") for c in column.split(",") if c.strip()]
    if not columns:
        raise HTTPException(400, "column is required")
    # Grouping by more than one column at once is the premium-tier feature
    # here — a single column stays available at the existing pro+ gate
    # (this route's own Depends above), unchanged.
    if len(columns) > 1 and not (is_privileged_role(user) or user.get("tier") == "premium"):
        raise HTTPException(403, "Gruppierung nach mehreren Spalten erfordert Tarif 'premium'")

    if agg not in GROUPBY_AGGS:
        raise HTTPException(400, f"agg must be one of {sorted(GROUPBY_AGGS)}")
    value_col = check_identifier(value_column, "value column") if value_column else None
    if value_col and agg in ("sum", "avg") and not column_is_numeric(schema, table, value_col):
        raise HTTPException(400, f"'{value_col}' is not numeric — sum/avg require a numeric value column")

    select_cols = ", ".join(f'"{c}"' for c in columns)
    not_null = " AND ".join(f'"{c}" IS NOT NULL' for c in columns)

    agg_select = ", COUNT(*) AS agg_count"
    order_expr = "agg_count"
    if value_col:
        sum_select = f', SUM("{value_col}") AS agg_sum' if agg in ("sum", "avg") else ""
        agg_select = f' , COUNT("{value_col}") AS agg_count, MIN("{value_col}") AS agg_min, MAX("{value_col}") AS agg_max{sum_select}'
        order_expr = {"count": "agg_count", "min": "agg_min", "max": "agg_max", "sum": "agg_sum", "avg": "agg_sum"}[agg]

    layer_filter = parse_layer_filter(filter)
    params: dict = {"limit": DISTINCT_VALUES_LIMIT + 1}
    extra_where = build_filter_where(layer_filter, params)
    if extra_where:
        extra_where = f"AND {extra_where}"

    with engine().begin() as conn:
        rows = conn.execute(
            text(
                f'SELECT {select_cols}{agg_select} FROM "{schema}"."{table}" '
                f'WHERE {not_null} {extra_where} GROUP BY {select_cols} ORDER BY {order_expr} DESC NULLS LAST LIMIT :limit'
            ),
            params,
        ).mappings().all()
        total_params: dict = {}
        total_where = build_filter_where(layer_filter, total_params)
        if total_where:
            total_where = f"AND {total_where}"
        total = conn.execute(
            text(f'SELECT COUNT(*) FROM "{schema}"."{table}" WHERE {not_null} {total_where}'),
            total_params,
        ).scalar()

    def bucket(r: dict) -> dict:
        label = GROUPBY_LABEL_SEP.join(str(r[c]) for c in columns)
        b = {"value": label, "count": r["agg_count"]}
        if value_col:
            b["min"] = r.get("agg_min")
            b["max"] = r.get("agg_max")
            if "agg_sum" in r:
                b["sum"] = r["agg_sum"]
        return b

    return {
        "buckets": [bucket(r) for r in rows[:DISTINCT_VALUES_LIMIT]],
        "totalCount": total,
        "truncated": len(rows) > DISTINCT_VALUES_LIMIT,
    }


@app.get("/table-count")
def table_count(schema: str, table: str, filter: str | None = None, user: dict = Depends(require_tier("pro"))):
    """
    Plain row count for a whole table — the dashboard overview card's
    headline number (the "everything selected" equivalent of a real
    selection's entries.length) and, summed across every visible layer, the
    denominator for that mode's "share of everything visible" ring. `filter`,
    when given, scopes the count to that layer's active attribute filter —
    see build_filter_where().
    """
    schema, table = authorize_table(schema, table, user)

    params: dict = {}
    where = build_filter_where(parse_layer_filter(filter), params)
    where_clause = f"WHERE {where}" if where else ""

    with engine().begin() as conn:
        count = conn.execute(text(f'SELECT COUNT(*) FROM "{schema}"."{table}" {where_clause}'), params).scalar()

    return {"count": count}


@app.get("/tables")
def list_tables(user: dict = Depends(require_privileged)):
    """Every registerable table in the database — admin/editor only, for the
    same reason POST /register-table is: this enumerates the whole instance,
    including tables behind someone else's grants, and it is the picker for
    a route only they can call."""
    with engine().begin() as conn:
        rows = conn.execute(
            text(
                "SELECT f_table_schema, f_table_name, f_geometry_column, type, srid "
                "FROM geometry_columns "
                "WHERE f_table_schema NOT IN ('tiger', 'tiger_data', 'topology') "
                # This service's own search-index support tables, not real data —
                # see index_layer_for_search() — would otherwise clutter this
                # picker as if they were registerable layers.
                "AND NOT (f_table_schema = 'dwh' AND f_table_name IN ('search_index', 'search_index_uploads')) "
                "ORDER BY f_table_schema, f_table_name"
            )
        ).all()
    registered = {(l["schema"], l["table"]) for l in read_layers()}
    return {
        "tables": [
            {
                "schema": r[0],
                "table": r[1],
                "geometry_column": r[2],
                "type": r[3],
                "srid": r[4],
                "registered": (r[0], r[1]) in registered,
            }
            for r in rows
        ]
    }


@app.post("/register-table")
def register_table(body: RegisterTableBody, user: dict = Depends(require_privileged)):
    """Publish a table that is already in the database.

    require_privileged (admin/editor), not require_tier("pro"): the table
    named here is by definition not yet a layer, so there is no grant to
    check it against — authorize_table() has nothing to resolve. Anyone who
    could call this could publish any table in dwh as a layer visible to
    themselves, which is the same ACL bypass /geoprocess had. Publishing
    *your own* upload is unaffected: /upload owns that path end to end and
    still only needs pro.
    """
    schema = check_identifier(body.schema_name, "schema name")
    table = check_identifier(body.table, "table name")
    if schema not in QUERYABLE_SCHEMAS:
        raise HTTPException(403, f"Schema nicht abfragbar: {schema}")
    return publish_derived_table(schema, table, body.title, user)


# ----------------------------------------------------------- /geoprocess

class GeoprocessBody(BaseModel):
    operation: Literal["buffer", "dissolve", "intersect", "join"]
    title: str | None = None
    schema_a: str
    table_a: str
    schema_b: str | None = None      # intersect, join
    table_b: str | None = None
    distance: float | None = None    # buffer, metres
    group_column: str | None = None  # dissolve; None dissolves the whole layer into one feature
    join_columns: list[str] | None = None  # join: which of B's columns to bring in


@app.post("/geoprocess")
def geoprocess(body: GeoprocessBody, user: dict = Depends(require_tier("pro"))):
    return _execute_geoprocess(body, user)


def _execute_geoprocess(body: GeoprocessBody, user: dict) -> dict:
    """
    Runs one of four PostGIS operations against already-published tables and
    publishes the result as a new layer via publish_derived_table() — the
    same "an existing table becomes a layer" path /register-table uses,
    since that's exactly what a geoprocessing result is once CREATE TABLE AS
    has run.

    The manual /geoprocess route above and the AI agent's confirmed
    /ai/execute-action route (see the end of this file) both call this same
    function, so there is exactly one implementation of "run a geoprocess
    operation" regardless of which entry point triggered it.
    """
    # Both inputs go through authorize_table(), not bare check_identifier():
    # this route used to accept any well-formed schema/table pair, which let
    # anyone past its tier gate read a table behind someone else's
    # layer_grants ACL — or a table in configdb entirely.
    schema_a, table_a = authorize_table(body.schema_a, body.table_a, user)
    geom_a, _ = find_geometry_column(schema_a, table_a)
    family_a = geometry_family_for_table(schema_a, table_a, geom_a)

    schema_b = table_b = geom_b = None
    if body.operation in ("intersect", "join"):
        if not body.schema_b or not body.table_b:
            raise HTTPException(400, "schema_b/table_b required for this operation")
        schema_b, table_b = authorize_table(body.schema_b, body.table_b, user)
        geom_b, _ = find_geometry_column(schema_b, table_b)
        family_b = geometry_family_for_table(schema_b, table_b, geom_b)
        if body.operation == "intersect" and family_a != family_b:
            raise HTTPException(400, f"Geometry types differ: {family_a} vs {family_b}")

    new_table = unique_table_name(slugify(f"{body.operation}_{table_a}"))
    eng = engine()

    try:
        with eng.begin() as conn:
            if body.operation == "buffer":
                if body.distance is None:
                    raise HTTPException(400, "distance is required for buffer")
                other_cols = ", ".join(f'"{c}"' for c in non_geometry_columns(schema_a, table_a, geom_a))
                sep = ", " if other_cols else ""
                conn.execute(
                    text(
                        f'CREATE TABLE "dwh"."{new_table}" AS '
                        f'SELECT {other_cols}{sep}ST_Buffer(geography("{geom_a}"), :distance)::geometry AS "{geom_a}" '
                        f'FROM "{schema_a}"."{table_a}"'
                    ),
                    {"distance": body.distance},
                )

            elif body.operation == "dissolve":
                group_col = check_identifier(body.group_column, "group column") if body.group_column else None
                group_select = f'"{group_col}", ' if group_col else ""
                group_by = f'GROUP BY "{group_col}"' if group_col else ""
                conn.execute(
                    text(
                        f'CREATE TABLE "dwh"."{new_table}" AS '
                        f'SELECT {group_select}ST_Union("{geom_a}") AS "{geom_a}" '
                        f'FROM "{schema_a}"."{table_a}" {group_by}'
                    )
                )

            elif body.operation == "intersect":
                other_cols = ", ".join(f'a."{c}"' for c in non_geometry_columns(schema_a, table_a, geom_a))
                sep = ", " if other_cols else ""
                # Intersecting two polygons can yield a GeometryCollection at
                # the edges (slivers) — CollectionExtract forces it back to
                # a single family (3 = polygon, matches family_a here since
                # intersect requires both inputs share a family).
                conn.execute(
                    text(
                        f'CREATE TABLE "dwh"."{new_table}" AS '
                        f'SELECT {other_cols}{sep}ST_CollectionExtract('
                        f'ST_Intersection(a."{geom_a}", b."{geom_b}"), 3) AS "{geom_a}" '
                        f'FROM "{schema_a}"."{table_a}" a '
                        f'JOIN "{schema_b}"."{table_b}" b ON ST_Intersects(a."{geom_a}", b."{geom_b}") '
                        f'WHERE NOT ST_IsEmpty(ST_Intersection(a."{geom_a}", b."{geom_b}"))'
                    )
                )

            else:  # join — attribute transfer, A's geometry kept
                join_cols = [check_identifier(c, "column name") for c in (body.join_columns or [])]
                if not join_cols:
                    raise HTTPException(400, "join_columns is required for join")
                # DISTINCT ON needs a real unique column on A so a single A
                # feature touching several B features doesn't multiply rows.
                unique_a = ensure_unique_column(schema_a, table_a)
                b_cols = ", ".join(f'b."{c}" AS "joined_{c}"' for c in join_cols)
                conn.execute(
                    text(
                        f'CREATE TABLE "dwh"."{new_table}" AS '
                        f'SELECT DISTINCT ON (a."{unique_a}") a.*, {b_cols} '
                        f'FROM "{schema_a}"."{table_a}" a '
                        f'LEFT JOIN "{schema_b}"."{table_b}" b ON ST_Intersects(a."{geom_a}", b."{geom_b}") '
                        f'ORDER BY a."{unique_a}"'
                    )
                )

            # A bare CREATE TABLE AS gives the geometry column no fixed
            # type/SRID typmod. The generic "Geometry" typmod (SRID-only,
            # no subtype) is used rather than guessing Polygon vs
            # MultiPolygon — geometry_family_for_table() inspects actual
            # per-row types via ST_GeometryType anyway, not the column's
            # declared subtype, so this is enough for the rest of the app
            # to recognize the column correctly.
            conn.execute(
                text(
                    f'ALTER TABLE "dwh"."{new_table}" ALTER COLUMN "{geom_a}" '
                    f'TYPE geometry(Geometry, 4326) USING "{geom_a}"'
                )
            )
    except HTTPException:
        with eng.begin() as conn:
            conn.execute(text(f'DROP TABLE IF EXISTS "dwh"."{new_table}"'))
        raise
    except Exception as e:
        with eng.begin() as conn:
            conn.execute(text(f'DROP TABLE IF EXISTS "dwh"."{new_table}"'))
        raise HTTPException(500, f"Geoprocessing failed: {e}")

    return publish_derived_table("dwh", new_table, body.title, user)


# -------------------------------------------------------------- /layers

@app.get("/layers")
def list_layers(user: dict = Depends(require_login)):
    layers = [{k: v for k, v in l.items() if k != "block"} for l in all_layers()]
    return {"layers": visible_layers_for(user, layers)}


@app.delete("/layers/{name}")
def delete_layer(name: str, drop_table: bool = False, user: dict = Depends(require_tier("pro"))):
    require_owner_or_admin(name, user)

    # Point clouds first: they have no LAYER block, and remove_layer_block()
    # 404s on a name it cannot find — so checking after it would make a point
    # cloud undeletable. Nothing below this branch applies to one either;
    # there is no tile cache to purge and no mapproxy entry to regenerate,
    # because generate_mapproxy_config() reads read_layers() and so has never
    # seen this layer at all.
    if delete_pointcloud_layer(name, drop_table):
        return {
            "deleted": name, "table_dropped": False, "file_deleted": drop_table,
            "schema": None, "table": None,
        }

    removed = remove_layer_block(name)
    # Otherwise a layer later re-registered under the same name would be served
    # the deleted one's tiles.
    purge_layer_cache(name)
    generate_mapproxy_config()
    remove_search_index_for_layer(name)
    if removed["geometry_type"] == "RASTER":
        if drop_table:
            # `name` has just been proven, by remove_layer_block()'s own
            # lookup, to match a real LAYER block — safe to reconstruct the
            # file path from it directly rather than trusting a path parsed
            # back out of the mapfile. Glob rather than a hardcoded .tif:
            # a plain upload/band is "{name}.tif", but a /raster-composite
            # layer is "{name}.vrt" plus its "{name}.vrt.ovr" overview
            # sidecar — this covers both shapes.
            for f in RASTERS_DIR.glob(f"{name}.*"):
                f.unlink(missing_ok=True)
        return {"deleted": name, "table_dropped": False, "file_deleted": drop_table, "schema": None, "table": None}
    # Unconditional, not gated on drop_table: the layer is unpublished either
    # way, and a Superset dataset for a layer nobody can see any more is a
    # chart waiting to break. The nightly reconcile converges to the same set.
    superset_client.remove_dataset(removed["schema"], removed["table"])
    if drop_table:
        with engine().begin() as conn:
            conn.execute(text(f'DROP TABLE IF EXISTS "{removed["schema"]}"."{removed["table"]}"'))
    return {"deleted": name, "table_dropped": drop_table, "schema": removed["schema"], "table": removed["table"]}


# --------------------------------------------------------- /layer-config
#
# Free-form per-layer configuration — classification today, with column
# aliases/default table view/symbol size/zoom range meant to land here too
# as the same kind of top-level key. Applies to every layer (static
# mapfile layers included, keyed by their WMS layer name), not just ones
# created through this API — a static layer just has no LAYER block for
# this to live in, so it's kept separately here instead.

class ClassDef(BaseModel):
    value: str
    label: str | None = None
    color: str


class GraduatedBreak(BaseModel):
    min: float
    max: float
    label: str | None = None
    color: str


class SingleSymbol(BaseModel):
    """One color for the whole layer — no column involved."""
    mode: Literal["single"] = "single"
    color: str
    # Point size / line width for the whole layer. None = classified_style()'s
    # own default. Meaningless for polygons, which have no size control.
    size: float | None = None


class CategorizedClassification(BaseModel):
    """One color per distinct value of `column` — text or numeric columns both work."""
    mode: Literal["categorized"] = "categorized"
    column: str
    classes: list[ClassDef]
    size: float | None = None


class GraduatedClassification(BaseModel):
    """Numeric `column` split into ranges, each with its own color."""
    mode: Literal["graduated"] = "graduated"
    column: str
    breaks: list[GraduatedBreak]
    size: float | None = None
    # Which /column-breaks method produced `breaks`. Purely a note to the
    # editor — MapServer only ever sees the numbers — so that reopening
    # ClassifyLayer.tsx shows the method that was actually used instead of
    # falling back to "manual" for every saved classification.
    method: Literal["equal", "quantile", "jenks", "manual"] | None = None


Classification = Annotated[
    Union[SingleSymbol, CategorizedClassification, GraduatedClassification],
    Field(discriminator="mode"),
]


class LayerConfigPatch(BaseModel):
    """
    Every field optional: a PATCH only touches the keys it sends, so later
    features (column aliases, default table view, ...) can each PATCH their
    own key without clobbering what another feature already saved.
    """
    classification: Classification | None = None
    columnAliases: dict[str, str] | None = None
    title: str | None = None
    # Layer hidden above this scale denominator. Null/absent = no cap.
    # Clearing one goes through DELETE /layer-config/{name}/maxScaleDenom,
    # since exclude_none drops an explicit null from a PATCH.
    maxScaleDenom: int | None = None
    # Border thickness around each polygon, in pixels. Absent = the default
    # (DEFAULT_POLYGON_OUTLINE_WIDTH); 0 = no border. Polygon layers only —
    # points and lines carry their own size in the classification instead.
    outlineWidth: float | None = Field(default=None, ge=0, le=MAX_POLYGON_OUTLINE_WIDTH)


# Keys whose value changes what MapServer draws, so a write to any of them has
# to rebuild the LAYER block, drop the layer's cached tiles, and bump
# styleVersion so the browser stops painting the tiles it already holds.
STYLE_KEYS = {"classification", "maxScaleDenom", "title", "outlineWidth"}


def read_layer_config() -> dict:
    """
    Every layer's config, keyed by layer name — same shape the old
    layer_config.json file held, now backed by configdb.layer_config so it
    lives alongside the rest of the app's config instead of a machine-written
    file (see bin/migrate-schemas.sql). Every caller here predates this and
    is unaffected: the dict-in, dict-out contract didn't change.
    """
    with engine().begin() as conn:
        rows = conn.execute(text("SELECT layer_name, config FROM configdb.layer_config")).all()
    return {r[0]: r[1] for r in rows}


def write_layer_config(config: dict) -> None:
    with engine().begin() as conn:
        conn.execute(text("DELETE FROM configdb.layer_config"))
        for layer_name, entry in config.items():
            conn.execute(
                text(
                    "INSERT INTO configdb.layer_config (layer_name, config, updated_at) "
                    "VALUES (:n, CAST(:c AS jsonb), now())"
                ),
                {"n": layer_name, "c": json.dumps(entry)},
            )


@app.get("/layer-config")
def get_all_layer_configs(user: dict = Depends(require_login)):
    """Every *visible* layer's config in one call, so the frontend doesn't
    fetch per-layer on every load().

    Filtered through visible_layers_for() like /layers is. Unfiltered, this
    handed any logged-in user the classification state of every layer in the
    instance — the styling column names, break values and titles that
    /layers deliberately withholds for a layer they were never granted."""
    config = read_layer_config()
    visible = {l["name"] for l in visible_layers_for(user, all_layers())}
    return {name: entry for name, entry in config.items() if name in visible}


@app.get("/layer-config/{name}")
def get_layer_config(name: str, user: dict = Depends(require_login)):
    if not any(l["name"] == name for l in visible_layers_for(user, all_layers())):
        raise HTTPException(404, f"Layer nicht gefunden oder nicht freigegeben: {name}")
    return read_layer_config().get(name, {})


@app.patch("/layer-config/{name}")
def patch_layer_config(name: str, patch: LayerConfigPatch, user: dict = Depends(require_tier("pro"))):
    require_owner_or_admin(name, user)
    config = read_layer_config()
    # exclude_unset only, deliberately not exclude_none: an explicit null has
    # to survive, because that is how "no scale cap, on purpose" is recorded.
    # Dropping it would make the key merely absent, which seed_layer_style()
    # reads as "never set" and would helpfully re-seed on the next restart.
    updates = patch.model_dump(exclude_unset=True)
    merged = {**config.get(name, {}), **updates}
    restyled = bool(STYLE_KEYS & updates.keys())
    if restyled:
        merged["styleVersion"] = int(merged.get("styleVersion", 0)) + 1
    config[name] = merged
    write_layer_config(config)
    if restyled:
        apply_layer_style(name)
    return merged


@app.delete("/layer-config/{name}")
def delete_layer_config(name: str, user: dict = Depends(require_tier("pro"))):
    require_owner_or_admin(name, user)
    config = read_layer_config()
    previous = config.pop(name, None)
    # styleVersion survives the wipe, still incremented: dropping it would
    # restart the count at 0, and a browser still holding v1 tiles would
    # consider them current again. Only worth keeping for a layer that still
    # exists, though — otherwise it is litter for something that can never
    # serve a tile again.
    live = any(l["name"] == name for l in read_layers())
    if previous and live:
        config[name] = {"styleVersion": int(previous.get("styleVersion", 0)) + 1}
    write_layer_config(config)
    # Back to the mapfile default: no classification, no scale cap.
    apply_layer_style(name)
    return {"ok": True}


@app.delete("/layer-config/{name}/{key}")
def delete_layer_config_key(name: str, key: str, user: dict = Depends(require_tier("pro"))):
    require_owner_or_admin(name, user)
    config = read_layer_config()
    entry = config.get(name)
    if entry and key in entry:
        entry.pop(key)
        if key in STYLE_KEYS:
            entry["styleVersion"] = int(entry.get("styleVersion", 0)) + 1
        if entry:
            config[name] = entry
        else:
            config.pop(name, None)
        write_layer_config(config)
        # Inside the branch on purpose: nothing changed if the key wasn't there.
        if key in STYLE_KEYS:
            apply_layer_style(name)
    return config.get(name, {})


# ----------------------------------------------------- /groups, /layer-grants
# The per-user/group ACL backing visible_layers_for(). Admin-only, plain CRUD
# over configdb.groups/group_members/layer_grants — same check_identifier-
# style validation and engine()/text() idiom as everywhere else in this file.

class GroupBody(BaseModel):
    name: str


class LayerGrantBody(BaseModel):
    layer_name: str
    principal_type: Literal["user", "group"]
    principal_id: int


@app.get("/groups")
def list_groups(user: dict = Depends(require_role("admin"))):
    with engine().begin() as conn:
        groups = conn.execute(text("SELECT id, name FROM configdb.groups ORDER BY name")).mappings().all()
        members = conn.execute(text(
            "SELECT gm.group_id, u.id AS user_id, u.username "
            "FROM configdb.group_members gm JOIN userdb.users u ON u.id = gm.user_id "
            "ORDER BY u.username"
        )).mappings().all()
    by_group: dict[int, list[dict]] = {}
    for m in members:
        by_group.setdefault(m["group_id"], []).append({"id": m["user_id"], "username": m["username"]})
    return [{"id": g["id"], "name": g["name"], "members": by_group.get(g["id"], [])} for g in groups]


@app.post("/groups")
def create_group(body: GroupBody, user: dict = Depends(require_role("admin"))):
    with engine().begin() as conn:
        existing = conn.execute(text("SELECT 1 FROM configdb.groups WHERE name = :n"), {"n": body.name}).first()
        if existing:
            raise HTTPException(409, "Gruppe existiert bereits")
        group_id = conn.execute(
            text("INSERT INTO configdb.groups (name) VALUES (:n) RETURNING id"), {"n": body.name}
        ).scalar_one()
    return {"id": group_id, "name": body.name, "members": []}


@app.delete("/groups/{group_id}")
def delete_group(group_id: int, user: dict = Depends(require_role("admin"))):
    with engine().begin() as conn:
        row = conn.execute(text("DELETE FROM configdb.groups WHERE id = :g RETURNING name"), {"g": group_id}).first()
    if not row:
        raise HTTPException(404, "Unbekannte Gruppe")
    return {"deleted": row.name}


@app.post("/groups/{group_id}/members/{user_id}")
def add_group_member(group_id: int, user_id: int, user: dict = Depends(require_role("admin"))):
    with engine().begin() as conn:
        conn.execute(
            text("INSERT INTO configdb.group_members (group_id, user_id) VALUES (:g, :u) ON CONFLICT DO NOTHING"),
            {"g": group_id, "u": user_id},
        )
    return {"ok": True}


@app.delete("/groups/{group_id}/members/{user_id}")
def remove_group_member(group_id: int, user_id: int, user: dict = Depends(require_role("admin"))):
    with engine().begin() as conn:
        conn.execute(
            text("DELETE FROM configdb.group_members WHERE group_id = :g AND user_id = :u"),
            {"g": group_id, "u": user_id},
        )
    return {"ok": True}


@app.get("/layer-grants")
def list_layer_grants(layer_name: str | None = None, user: dict = Depends(require_role("admin"))):
    query = (
        "SELECT lg.id, lg.layer_name, lg.principal_type, lg.principal_id, "
        "CASE WHEN lg.principal_type = 'user' THEN u.username ELSE g.name END AS principal_name "
        "FROM configdb.layer_grants lg "
        "LEFT JOIN userdb.users u ON lg.principal_type = 'user' AND u.id = lg.principal_id "
        "LEFT JOIN configdb.groups g ON lg.principal_type = 'group' AND g.id = lg.principal_id"
    )
    params: dict = {}
    if layer_name is not None:
        query += " WHERE lg.layer_name = :n"
        params["n"] = layer_name
    query += " ORDER BY lg.layer_name, principal_name"
    with engine().begin() as conn:
        rows = conn.execute(text(query), params).mappings().all()
    return list(rows)


@app.post("/layer-grants")
def create_layer_grant(body: LayerGrantBody, user: dict = Depends(require_role("admin"))):
    with engine().begin() as conn:
        grant_id = conn.execute(
            text(
                "INSERT INTO configdb.layer_grants (layer_name, principal_type, principal_id) "
                "VALUES (:n, :pt, :pid) ON CONFLICT (layer_name, principal_type, principal_id) DO NOTHING "
                "RETURNING id"
            ),
            {"n": body.layer_name, "pt": body.principal_type, "pid": body.principal_id},
        ).first()
    return {"id": grant_id[0] if grant_id else None, **body.model_dump()}


@app.delete("/layer-grants/{grant_id}")
def delete_layer_grant(grant_id: int, user: dict = Depends(require_role("admin"))):
    with engine().begin() as conn:
        row = conn.execute(text("DELETE FROM configdb.layer_grants WHERE id = :g RETURNING id"), {"g": grant_id}).first()
    if not row:
        raise HTTPException(404, "Unbekannte Berechtigung")
    return {"deleted": grant_id}


# -------------------------------------------------------------- /cms
# General-purpose CMS: any number of named pages in configdb.pages, DE/EN
# side by side (not translation "keys" in the i18n sense — genuine
# admin-authored copy, so a DB row per locale rather than the frontend's
# single static translations.ts file). The in-app Handbook is just the one
# page ("handbook") every fresh install is seeded with — see
# postgis/initdb/01-extensions.sql / bin/migrate-schemas.sql — not special
# beyond that; an admin can create/delete any number of others.
#
# `admin_only` hides a page from anyone but role == "admin" — deliberately
# the strict admin check, not is_privileged_role()/require_privileged(), the
# same way /users and /groups are: this is for internal/operational content
# (the "architecture" page), not general content editing, so editor does not
# get a pass here the way it does elsewhere. Enforced in every read AND
# write route, not just filtered out of the list — otherwise an editor who
# already knows or guesses a hidden slug could still PATCH/DELETE/fetch it
# directly. A non-admin request for a hidden page 404s exactly like an
# unknown slug would, rather than 403ing, so its existence isn't disclosed.

SLUG_RE = re.compile(r"^[a-z0-9][a-z0-9_-]{0,63}$")


def check_slug(slug: str) -> str:
    if not SLUG_RE.match(slug):
        raise HTTPException(
            status_code=400,
            detail="Seiten-Kennung: nur Kleinbuchstaben, Ziffern, '_' und '-', max. 64 Zeichen",
        )
    return slug


class CmsPageCreate(BaseModel):
    slug: str
    title_de: str = ""
    title_en: str = ""
    body_de: str = ""
    body_en: str = ""
    admin_only: bool = False


class CmsContentPatch(BaseModel):
    title_de: str | None = None
    title_en: str | None = None
    body_de: str | None = None
    body_en: str | None = None
    admin_only: bool | None = None


@app.get("/cms")
def list_cms_pages(user: dict = Depends(require_login)):
    """Every page's metadata (no body — kept light for a picker list), newest-edited
    first. A page flagged admin_only is omitted entirely for anyone but an admin."""
    with engine().begin() as conn:
        rows = conn.execute(
            text(
                "SELECT slug, title_de, title_en, updated_at, admin_only "
                "FROM configdb.pages WHERE admin_only = false OR :is_admin "
                "ORDER BY updated_at DESC"
            ),
            {"is_admin": user.get("role") == "admin"},
        ).mappings().all()
    return [dict(r) for r in rows]


@app.post("/cms")
def create_cms_page(body: CmsPageCreate, user: dict = Depends(require_privileged)):
    slug = check_slug(body.slug)
    with engine().begin() as conn:
        exists = conn.execute(
            text("SELECT 1 FROM configdb.pages WHERE slug = :s"), {"s": slug}
        ).first()
        if exists:
            raise HTTPException(status_code=409, detail="Seite existiert bereits")
        row = conn.execute(
            text(
                "INSERT INTO configdb.pages (slug, title_de, title_en, body_de, body_en, admin_only, updated_by) "
                "VALUES (:s, :td, :te, :bd, :be, :ao, :by) "
                "RETURNING slug, title_de, title_en, body_de, body_en, admin_only, updated_at"
            ),
            {
                "s": slug, "td": body.title_de, "te": body.title_en,
                "bd": body.body_de, "be": body.body_en, "ao": body.admin_only, "by": user["username"],
            },
        ).mappings().first()
    return dict(row)


def _cms_row_or_404(conn, slug: str, user: dict):
    row = conn.execute(
        text(
            "SELECT slug, title_de, title_en, body_de, body_en, admin_only, updated_at "
            "FROM configdb.pages WHERE slug = :s"
        ),
        {"s": slug},
    ).mappings().first()
    if not row or (row["admin_only"] and user.get("role") != "admin"):
        raise HTTPException(status_code=404, detail="Unbekannte Seite")
    return row


@app.get("/cms/{slug}")
def get_cms_content(slug: str, user: dict = Depends(require_login)):
    with engine().begin() as conn:
        row = _cms_row_or_404(conn, slug, user)
    return dict(row)


@app.patch("/cms/{slug}")
def patch_cms_content(slug: str, patch: CmsContentPatch, user: dict = Depends(require_privileged)):
    updates = patch.model_dump(exclude_unset=True)
    with engine().begin() as conn:
        existing = _cms_row_or_404(conn, slug, user)
        if not updates:
            return dict(existing)
        set_clause = ", ".join(f"{k} = :{k}" for k in updates)
        row = conn.execute(
            text(
                f"UPDATE configdb.pages SET {set_clause}, updated_at = now(), updated_by = :by "
                "WHERE slug = :s "
                "RETURNING slug, title_de, title_en, body_de, body_en, admin_only, updated_at"
            ),
            {**updates, "by": user["username"], "s": slug},
        ).mappings().first()
    return dict(row)


@app.delete("/cms/{slug}")
def delete_cms_page(slug: str, user: dict = Depends(require_privileged)):
    with engine().begin() as conn:
        _cms_row_or_404(conn, slug, user)
        row = conn.execute(
            text("DELETE FROM configdb.pages WHERE slug = :s RETURNING slug"), {"s": slug}
        ).first()
    return {"deleted": row[0]}


@app.get("/healthz")
def healthz():
    """Liveness only, for the container healthcheck — deliberately
    unauthenticated and deliberately empty of detail.

    /health below reports the mapfile mount and other internals and needs a
    session for it; a Docker healthcheck has no cookie, so it needs its own
    endpoint. There is no nginx `location` for this one, so it is reachable
    only from inside the container (a healthcheck runs there), and even if it
    were exposed it says nothing an attacker does not already know from the
    fact that the site answered."""
    return {"ok": True}


@app.get("/health")
def health(user: dict = Depends(require_login)):
    # Reports the mount explicitly rather than a bare ok: a dead bind mount is
    # the one failure that leaves this service running and answering normally.
    return {
        "ok": MOUNT_SENTINEL.exists(),
        "mapfile_volume": MOUNT_SENTINEL.exists(),
        "qgis_work_volume": QGIS_WORK_SENTINEL.exists(),
    }


@app.on_event("startup")
def materialize_saved_styles() -> None:
    """
    Brings every LAYER block in line with its stored config on boot.

    Classifications saved before styling moved into the mapfile exist only in
    layer_config.json, and would otherwise keep rendering as the layer's plain
    default until someone edited them again. Idempotent, so it is also the
    repair path if a block and its config ever drift.

    Deliberately best-effort: a bad config entry must not stop the service from
    starting, or a single unparseable classification would take the whole API
    down and with it the only UI able to fix it.
    """
    try:
        layers = read_layers()
    except Exception as e:  # dead mapfile volume, unreadable file
        log.warning("skipping style materialization", extra={"error": str(e)})
        return
    for l in layers:
        try:
            # seed_layer_style rather than apply_layer_style so layers that
            # predate scale caps get one too. It only fills a cap that was
            # never set, so a deliberately cleared one is not resurrected.
            seed_layer_style(l["name"], l["geometry_type"], l["schema"], l["table"])
        except Exception as e:
            log.error("could not apply style", extra={"layer": l['name'], "error": str(e)})
    try:
        generate_mapproxy_config()
    except Exception as e:
        log.error("could not generate mapproxy.yaml", extra={"error": str(e)})


# --------------------------------------------------------------------- /ai
#
# Bring-your-own-key AI agent: chat with read-only DB access, map-control
# actions, and (via a confirmation token) the existing geoprocess/ETL
# actions. See ai_agent.py for the tool loop, SQL guardrails, encrypted key
# storage and the pending-action mechanism — this section only wires HTTP
# routes and auth around it. Every route is gated require_etl_access
# (admin or premium), same as /etl/*.

class SetAiKeyBody(BaseModel):
    provider: Literal["anthropic", "openai"]
    api_key: str


class AiChatMessage(BaseModel):
    role: Literal["user", "assistant"]
    content: str


class AiChatBody(BaseModel):
    messages: list[AiChatMessage]
    model: str | None = None
    # The frontend's current layer list (name/title/source/geomType), passed
    # in on every request so the model can address a layer by its exact WMS
    # name with no extra round trip. This is the live, complete list —
    # including hand-authored layers from vibegis.map/osm-layers.map, which
    # read_layers() below only knows about for upload-api-managed ones —
    # straight from wms.ts's own store.
    layers: list[dict] = Field(default_factory=list)


class AiExecuteActionBody(BaseModel):
    token: str


def _load_user_ai_key(user: dict) -> tuple[str, str]:
    with engine().begin() as conn:
        row = conn.execute(
            text("SELECT ai_provider, ai_key_ciphertext FROM userdb.users WHERE id = :id"),
            {"id": int(user["sub"])},
        ).first()
    if not row or not row.ai_key_ciphertext:
        raise HTTPException(400, "Kein API-Schlüssel hinterlegt — bitte in den KI-Einstellungen speichern")
    return row.ai_provider, row.ai_key_ciphertext


@app.get("/ai/settings/key")
def get_ai_key(user: dict = Depends(require_etl_access)):
    # Write-only from the client's perspective: the plaintext key is never
    # returned here or anywhere else, only a masked last4 indicator.
    with engine().begin() as conn:
        row = conn.execute(
            text("SELECT ai_provider, ai_key_last4 FROM userdb.users WHERE id = :id"),
            {"id": int(user["sub"])},
        ).first()
    configured = bool(row and row.ai_key_last4)
    return {
        "configured": configured,
        "provider": row.ai_provider if row else None,
        "last4": row.ai_key_last4 if row else None,
    }


@app.post("/ai/settings/key")
def set_ai_key(body: SetAiKeyBody, user: dict = Depends(require_etl_access)):
    key = body.api_key.strip()
    if not key:
        raise HTTPException(400, "API-Schlüssel darf nicht leer sein")
    ciphertext = ai_agent.encrypt_key(key)
    last4 = ai_agent.mask(key)
    with engine().begin() as conn:
        conn.execute(text(
            "UPDATE userdb.users SET ai_provider = :p, ai_key_ciphertext = :c, ai_key_last4 = :l4, "
            "ai_key_updated_at = now() WHERE id = :id"
        ), {"p": body.provider, "c": ciphertext, "l4": last4, "id": int(user["sub"])})
    return {"provider": body.provider, "last4": last4}


@app.delete("/ai/settings/key")
def delete_ai_key(user: dict = Depends(require_etl_access)):
    with engine().begin() as conn:
        conn.execute(text(
            "UPDATE userdb.users SET ai_provider = NULL, ai_key_ciphertext = NULL, ai_key_last4 = NULL, "
            "ai_key_updated_at = NULL WHERE id = :id"
        ), {"id": int(user["sub"])})
    return {"ok": True}


@app.post("/ai/chat")
def ai_chat(body: AiChatBody, user: dict = Depends(require_etl_access)):
    provider, ciphertext = _load_user_ai_key(user)
    api_key = ai_agent.decrypt_key(ciphertext)
    # The only app.py internals a tool call needs — the identifier sanitizer
    # and this caller's layer ACL. Deliberately not the full-access engine():
    # every DB read tool uses its own ai_readonly_engine().
    #
    # None means "no restriction" for admin/editor, matching what
    # is_privileged_role() means everywhere else. For everyone else the agent's
    # reads are narrowed to the tables behind the layers they were granted —
    # the ai_readonly role holds SELECT on all of dwh, which is coarser than
    # the ACL every other read path enforces.
    tool_context = {
        "check_identifier": check_identifier,
        "allowed_tables": None if is_privileged_role(user) else visible_layer_index(user)[1],
    }
    return ai_agent.run_agent_turn(
        provider=provider,
        api_key=api_key,
        model=body.model,
        messages=[m.model_dump() for m in body.messages],
        layers_context=body.layers,
        user=user,
        tool_context=tool_context,
    )


@app.post("/ai/execute-action")
def ai_execute_action(body: AiExecuteActionBody, user: dict = Depends(require_etl_access)):
    """
    The one and only path that actually runs a geoprocess/ETL action the
    agent proposed. Not reachable by the model's own tool loop — only a real
    button click in the frontend calls this, with a token that's opaque,
    single-use, short-lived, and tied to the user who requested it.
    """
    action = ai_agent.consume_pending_action(body.token, user["sub"])
    if action.kind == "geoprocess":
        p = action.params
        geoprocess_body = GeoprocessBody(
            operation=p["operation"], title=p.get("title"),
            schema_a=p["schema_a"], table_a=p["table_a"],
            schema_b=p.get("schema_b"), table_b=p.get("table_b"),
            distance=p.get("distance"), group_column=p.get("group_column"),
            join_columns=p.get("join_columns"),
        )
        return _execute_geoprocess(geoprocess_body, user)
    if action.kind == "etl_run":
        return _execute_etl_run(user)
    raise HTTPException(400, f"Unbekannte Aktion: {action.kind}")


# ======================================================================
#                      QGIS processing + print export
# ======================================================================
#
# Two capabilities that MapServer/PostGIS cannot provide on their own, both
# served by the `qgis-processing` worker (see qgis-processing/worker.py):
#
#   * running QGIS algorithms against a published layer, and
#   * rendering a real composed map to PDF through QGIS Server's GetPrint.
#
# The worker has no auth and no gateway route — it is reachable only inside
# the compose network, exactly like Dagster. Everything user-facing (tier
# gates, layer visibility, job ownership) is enforced here, and every dwh and
# mapfile write stays in this service, which already owns both.

QGIS_WORKER_URL = os.getenv("QGIS_WORKER_URL", "http://qgis-processing:8000")
QGIS_SERVER_URL = os.getenv("QGIS_SERVER_URL", "http://qgis-server/")
QGIS_WORK_DIR = Path("/qgis-work")
# Written by the worker at startup, not shipped in git like the other volume
# sentinels. That makes this a strictly stronger check than the ones above: it
# proves not merely "this mount is alive" but "both containers are on the same
# volume", which is the failure a compose edit can actually introduce here.
QGIS_WORK_SENTINEL = QGIS_WORK_DIR / ".volume-ok"

# A result GeoPackage is read with geopandas, which materializes the whole
# thing in memory, so it needs a ceiling that a streaming ogr2ogr would not.
QGIS_MAX_OUTPUT_BYTES = int(os.getenv("QGIS_MAX_OUTPUT_BYTES", str(512 * 1024 * 1024)))
QGIS_ALG_ID_RE = re.compile(r"^[a-z0-9_]+:[a-zA-Z0-9_]+$")

PRINT_TEMPLATES = [
    {"key": "a4-landscape", "label_de": "A4 quer", "label_en": "A4 landscape", "width_mm": 297, "height_mm": 210},
    {"key": "a4-portrait", "label_de": "A4 hoch", "label_en": "A4 portrait", "width_mm": 210, "height_mm": 297},
    {"key": "a3-landscape", "label_de": "A3 quer", "label_en": "A3 landscape", "width_mm": 420, "height_mm": 297},
]
PRINT_TEMPLATES_BY_KEY = {t["key"]: t for t in PRINT_TEMPLATES}
# Bounded so one export cannot sit on a worker slot and the gateway timeout
# for minutes: DPI and page area are the two things that actually drive
# GetPrint's cost.
QGIS_PRINT_MAX_DPI = 300


def check_qgis_work_volume() -> None:
    if not QGIS_WORK_SENTINEL.exists():
        raise HTTPException(
            503,
            f"QGIS work volume not shared: {QGIS_WORK_SENTINEL} is missing, so a "
            "GeoPackage written by qgis-processing would be invisible here. "
            "Recreate both: docker compose up -d --force-recreate "
            "qgis-processing upload-api",
        )


def check_algorithm_id(alg_id: str) -> str:
    """The algorithm id is threaded into a subprocess argv on the worker, so it
    gets the same treatment check_identifier() gives a SQL identifier."""
    if not QGIS_ALG_ID_RE.match(alg_id or ""):
        raise HTTPException(400, f"Ungültige Algorithmus-ID: {alg_id!r}")
    return alg_id


def qgis_worker(method: str, path: str, payload: dict | None = None, timeout: int = 30):
    """The second cross-container HTTP client in this file, alongside
    dagster_graphql() — same plain-urllib shape and the same reason: separate
    images with no shared in-process import path."""
    url = f"{QGIS_WORKER_URL}{path}"
    data = json.dumps(payload).encode() if payload is not None else None
    req = urllib.request.Request(
        url, data=data, method=method,
        headers={"Content-Type": "application/json"} if data else {},
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout) as res:
            body = res.read().decode()
            return json.loads(body) if body else {}
    except urllib.error.HTTPError as e:
        detail = e.read().decode()[:400]
        raise HTTPException(502, f"QGIS-Worker meldet einen Fehler: {detail}")
    except urllib.error.URLError as e:
        raise HTTPException(502, f"QGIS-Worker nicht erreichbar: {e}")


def ensure_qgis_jobs_table() -> None:
    with engine().begin() as conn:
        conn.execute(text("CREATE SCHEMA IF NOT EXISTS configdb"))
        conn.execute(text(
            "CREATE TABLE IF NOT EXISTS configdb.qgis_jobs ("
            "  job_id text PRIMARY KEY,"
            # text rather than an int FK to userdb.users: this predates the
            # removal of guest sessions and there is no reason to migrate it.
            "  user_id text NOT NULL,"
            "  algorithm text NOT NULL,"
            "  status text NOT NULL,"
            "  message text,"
            "  layer_name text,"
            "  layer_title text,"
            "  created_at timestamptz NOT NULL DEFAULT now(),"
            "  updated_at timestamptz NOT NULL DEFAULT now())"
        ))
        # A job only lives as long as the thread watching it, so any row still
        # claiming to be running at startup belongs to a process that is gone —
        # otherwise a rebuild mid-run leaves a notification spinning forever in
        # the browser. Safe here because this runs before uvicorn accepts
        # requests, so no live job can be caught by it.
        conn.execute(text(
            "UPDATE configdb.qgis_jobs SET status = 'failed', updated_at = now(), "
            "message = 'upload-api wurde neu gestartet, während der Job lief' "
            "WHERE status IN ('queued', 'running', 'ingesting')"
        ))


@app.on_event("startup")
def create_qgis_jobs_table_if_missing() -> None:
    try:
        ensure_qgis_jobs_table()
    except Exception as e:
        log.error("could not ensure configdb.qgis_jobs", extra={"error": str(e)})


def _qgis_job_set(job_id: str, **fields) -> None:
    if not fields:
        return
    assigns = ", ".join(f"{k} = :{k}" for k in fields)
    with engine().begin() as conn:
        conn.execute(
            text(f"UPDATE configdb.qgis_jobs SET {assigns}, updated_at = now() WHERE job_id = :job_id"),
            {**fields, "job_id": job_id},
        )


def _qgis_job_row(job_id: str) -> dict | None:
    with engine().begin() as conn:
        row = conn.execute(
            text("SELECT job_id, user_id, algorithm, status, message, layer_name, layer_title "
                 "FROM configdb.qgis_jobs WHERE job_id = :job_id"),
            {"job_id": job_id},
        ).mappings().first()
    return dict(row) if row else None


def resolve_layer_source(layer_name: str, user: dict) -> tuple[str, str]:
    """Turn a layer name the client sent into the (schema, table) behind it,
    for a layer this user is actually allowed to see.

    Deliberately stricter than /geoprocess, which takes a raw schema/table pair
    and validates only that they are well-formed identifiers — that lets any
    caller who passes the tier gate read any table in dwh, including one behind
    a layer_grants ACL. Resolving through visible_layers_for() instead means
    the ACL that governs the layer panel governs this too, and the frontend
    gets simpler as well (it already has layer names). Worth retrofitting onto
    /geoprocess later.
    """
    visible = visible_layers_for(user, all_layers())
    match = next((l for l in visible if l["name"] == layer_name), None)
    if match is None:
        raise HTTPException(404, f"Layer nicht gefunden oder nicht freigegeben: {layer_name}")
    if not match.get("schema") or not match.get("table"):
        raise HTTPException(400, f"Layer {layer_name} hat keine Tabelle (Raster oder Punktwolke)")
    # Defense in depth: these came from the mapfile, not from the request, but
    # they are about to be interpolated into a DSN on the worker.
    return check_identifier(match["schema"], "schema name"), check_identifier(match["table"], "table name")


class QgisRunBody(BaseModel):
    algorithm: str
    layer: str
    title: str | None = None
    params: dict[str, Any] = Field(default_factory=dict)


@app.get("/qgis-process/algorithms")
def qgis_algorithms(advanced: bool = False, user: dict = Depends(require_tier("premium"))):
    """The curated catalog, optionally plus everything else the worker reports.

    The curated entries are cross-checked against the worker's live catalog and
    marked `available: false` rather than silently offered when missing — a
    typo or a QGIS version bump then shows up as a greyed entry instead of a
    job that fails at submit time.
    """
    try:
        live = qgis_worker("GET", "/algorithms", timeout=60).get("algorithms", [])
    except HTTPException:
        live = []
    live_ids = {a["id"] for a in live}

    out = []
    for alg in qgis_catalog.CURATED:
        entry = alg.as_json()
        entry["params"] = [p.as_json() for p in qgis_catalog.curated_params(alg)]
        entry["available"] = (not live_ids) or alg.id in live_ids
        if not entry["available"]:
            log.error("curated qgis algorithm unavailable", extra={"algorithm": alg.id})
        out.append(entry)

    if advanced:
        for alg in live:
            if alg["id"] in qgis_catalog.CURATED_BY_ID:
                continue
            out.append({
                "id": alg["id"],
                "label": {"de": alg["label"], "en": alg["label"]},
                "group": alg.get("group") or alg.get("provider"),
                "geometry": None,
                "note": {"de": None, "en": None},
                "curated": False,
                "available": True,
                # Advanced entries are resolved lazily: introspecting all 300+
                # would mean one qgis_process invocation each.
                "params": None,
            })
    return {"algorithms": out, "advancedAvailable": bool(live_ids)}


@app.get("/qgis-process/algorithms/{alg_id:path}")
def qgis_algorithm_detail(alg_id: str, user: dict = Depends(require_tier("premium"))):
    """One algorithm's parameters, in the same shape the curated catalog uses —
    so the frontend has exactly one parameter renderer and never has to know
    which catalog an entry came from."""
    check_algorithm_id(alg_id)
    curated = qgis_catalog.CURATED_BY_ID.get(alg_id)
    if curated is not None:
        entry = curated.as_json()
        entry["params"] = [p.as_json() for p in qgis_catalog.curated_params(curated)]
        entry["supported"] = True
        return entry

    detail = qgis_worker("GET", f"/algorithms/{alg_id}", timeout=60)
    supported = qgis_catalog.supports_algorithm(detail)
    params = qgis_catalog.advanced_params(detail) if supported else []
    name = (detail.get("algorithm_details") or {}).get("name") or alg_id
    return {
        "id": alg_id,
        "label": {"de": name, "en": name},
        "group": (detail.get("algorithm_details") or {}).get("group"),
        "geometry": None,
        "note": {"de": None, "en": None},
        "curated": False,
        "available": True,
        "supported": supported,
        "params": [p.as_json() for p in params],
    }


# A scalar parameter is appended verbatim to the qgis_process argv on the
# worker, and qgis_process hands anything that looks like a datasource to
# GDAL/OGR. So a bare string in a parameter slot could be a `PG:` DSN (read any
# table the worker's own credential can reach, straight past layer_grants), a
# local path, or a /vsicurl/ URL (local file read and SSRF from inside the
# network). Layer-typed parameters are resolved from a layer *name* instead and
# never reach the argv, so this only has to catch a scalar pretending to be one.
_DATASOURCE_PREFIXES = (
    "pg:", "/vsi", "http://", "https://", "ftp://", "file://", "gdal:", "ogr:",
    "wfs:", "wms:", "mysql:", "oci:", "odbc:", "mongodb", "postgresql:",
)


def reject_datasource_scalar(key: str, value) -> None:
    """A scalar parameter must not be a datasource string. Applied to strings
    inside lists too, since the worker joins a list with commas into one
    argv element."""
    values = value if isinstance(value, list) else [value]
    for v in values:
        if not isinstance(v, str):
            continue
        probe = v.strip().lower()
        if probe.startswith(_DATASOURCE_PREFIXES) or probe.startswith("/"):
            raise HTTPException(400, f"Parameter {key}: Datenquellen-Angaben sind nicht erlaubt")


def qgis_algorithm_params(alg_id: str) -> dict[str, qgis_catalog.Param]:
    """Every parameter this algorithm actually accepts, keyed by name — the
    same list the frontend renders its form from, so the two cannot disagree.

    Curated algorithms answer from the in-process catalog; anything else is
    introspected from the worker. Introspection already drops destination
    parameters (param_from_introspection() returns None for them), which is
    what keeps OUTPUT server-owned in both branches.

    This is the allowlist. Previously only *curated* algorithms had their
    parameter keys checked, so for the ~300 advanced ones every key a client
    sent was passed through untouched.
    """
    curated = qgis_catalog.CURATED_BY_ID.get(alg_id)
    if curated is not None:
        return {p.key: p for p in qgis_catalog.curated_params(curated)}
    detail = qgis_worker("GET", f"/algorithms/{alg_id}", timeout=60)
    if not qgis_catalog.supports_algorithm(detail):
        raise HTTPException(400, f"Algorithmus wird nicht unterstützt: {alg_id}")
    return {p.key: p for p in qgis_catalog.advanced_params(detail)}


@app.post("/qgis-process/run")
def qgis_run(body: QgisRunBody, user: dict = Depends(require_tier("premium"))):
    check_qgis_work_volume()
    check_algorithm_id(body.algorithm)

    known = qgis_algorithm_params(body.algorithm)
    unknown = set(body.params) - set(known)
    if unknown:
        raise HTTPException(400, f"Unbekannte Parameter: {sorted(unknown)}")

    schema_a, table_a = resolve_layer_source(body.layer, user)

    # A parameter's kind comes from the catalog, never from the shape the
    # client happened to send. That distinction is the whole fix: this loop
    # used to treat anything that was not a {"layer": name} dict as a scalar,
    # so sending a plain string in a layer slot skipped resolve_layer_source()
    # entirely and handed the worker a datasource string to open with its own
    # credential — every layer_grants ACL bypassed in one request.
    worker_params: dict[str, dict] = {
        "INPUT": {"type": "pgtable", "schema_name": schema_a, "table": table_a}
    }
    for key, value in body.params.items():
        if known[key].kind == "layer":
            if not isinstance(value, dict) or "layer" not in value:
                raise HTTPException(400, f"Parameter {key} erwartet einen Layer-Namen")
            schema_b, table_b = resolve_layer_source(value["layer"], user)
            worker_params[key] = {"type": "pgtable", "schema_name": schema_b, "table": table_b}
        else:
            if isinstance(value, dict):
                raise HTTPException(400, f"Parameter {key} erwartet keinen Layer")
            reject_datasource_scalar(key, value)
            worker_params[key] = {"type": "scalar", "value": value}

    job_id = uuid.uuid4().hex
    title = (body.title or "").strip() or f"{body.algorithm.split(':')[-1]} {body.layer}"
    with engine().begin() as conn:
        conn.execute(
            text("INSERT INTO configdb.qgis_jobs (job_id, user_id, algorithm, status, layer_title) "
                 "VALUES (:job_id, :user_id, :algorithm, 'running', :title)"),
            {"job_id": job_id, "user_id": str(user.get("sub")), "algorithm": body.algorithm, "title": title},
        )

    payload = {"job_id": job_id, "algorithm": body.algorithm, "params": worker_params}
    request_id = request_id_ctx.get()
    threading.Thread(
        target=_watch_qgis_job, args=(job_id, payload, title, user, request_id), daemon=True
    ).start()
    return {"jobId": job_id, "status": "running"}


def _watch_qgis_job(job_id: str, payload: dict, title: str, user: dict, request_id: str) -> None:
    """Runs the algorithm and publishes its result, off the request thread.

    The work deliberately does not live in the polling handler: an ingest can
    take tens of seconds while the client polls every two seconds, so doing it
    there would need a lock and would still lose the run the moment the user
    closed the tab. Started at submit time instead, exactly like the ETL
    trigger's own progress model.

    This assumes uvicorn runs as a single process — it does (no --workers in
    the Dockerfile's CMD). Adding workers later would give one watcher per
    worker process per job; the fix then is a pg advisory lock, not a rewrite.
    """
    request_id_ctx.set(request_id)
    try:
        # No urllib timeout short of the worker's own: the worker caps the
        # algorithm itself (QGIS_RUN_TIMEOUT) and returns 504 on overrun, which
        # is a better error than a truncated connection here.
        result = qgis_worker("POST", "/run", payload, timeout=1000)
    except HTTPException as e:
        _qgis_job_set(job_id, status="failed", message=str(e.detail)[:2000])
        return
    except Exception as e:  # noqa: BLE001
        _qgis_job_set(job_id, status="failed", message=f"QGIS-Lauf fehlgeschlagen: {e}"[:2000])
        return

    if not result.get("ok") or not result.get("output"):
        message = (result.get("stderr_tail") or result.get("stdout_tail")
                   or "Algorithmus lieferte kein Ergebnis")
        _qgis_job_set(job_id, status="failed", message=str(message)[-2000:])
        return

    output = Path(result["output"])
    _qgis_job_set(job_id, status="ingesting")
    try:
        if not output.exists():
            raise HTTPException(500, "Ergebnisdatei ist hier nicht sichtbar (geteiltes Volume?)")
        size = output.stat().st_size
        if size > QGIS_MAX_OUTPUT_BYTES:
            raise HTTPException(
                413,
                f"Ergebnis ist {size // (1024 * 1024)} MB groß und überschreitet das Limit "
                f"von {QGIS_MAX_OUTPUT_BYTES // (1024 * 1024)} MB",
            )
        layers = gpd.list_layers(output)
        if len(layers) != 1:
            raise HTTPException(400, f"Ergebnis enthält {len(layers)} Layer, erwartet wurde genau einer")
        gdf = gpd.read_file(output)
        published = ingest_geodataframe(gdf, title, user, require_crs=True)
    except HTTPException as e:
        _qgis_job_set(job_id, status="failed", message=str(e.detail)[:2000])
        return
    except Exception as e:  # noqa: BLE001
        _qgis_job_set(job_id, status="failed", message=f"Ergebnis konnte nicht geladen werden: {e}"[:2000])
        return
    finally:
        try:
            qgis_worker("DELETE", f"/run/{job_id}", timeout=15)
        except Exception:  # noqa: BLE001 - cleanup is best-effort, the worker sweeps too
            pass

    _qgis_job_set(job_id, status="published", layer_name=published["layer"],
                  layer_title=published["title"], message=None)
    log.info("qgis job published", extra={"job_id": job_id, "layer": published["layer"]})


@app.get("/qgis-process/run/{job_id}")
def qgis_run_status(job_id: str, user: dict = Depends(require_tier("premium"))):
    row = _qgis_job_row(job_id)
    if row is None:
        raise HTTPException(404, "Job nicht gefunden")
    if row["user_id"] != str(user.get("sub")) and not is_privileged_role(user):
        raise HTTPException(404, "Job nicht gefunden")
    return {
        "jobId": row["job_id"],
        "status": row["status"],
        "message": row["message"],
        "layer": row["layer_name"],
        "title": row["layer_title"],
        "algorithm": row["algorithm"],
    }


@app.get("/qgis-process/health")
def qgis_worker_health(user: dict = Depends(require_tier("premium"))):
    health = qgis_worker("GET", "/healthz", timeout=30)
    health["shared_volume"] = QGIS_WORK_SENTINEL.exists()
    return health


# ------------------------------------------------------------ print export

class QgisPrintBody(BaseModel):
    layers: list[str] = Field(default_factory=list)
    west: float
    south: float
    east: float
    north: float
    template: str = "a4-landscape"
    title: str | None = None
    subtitle: str | None = None
    basemap: bool = True
    legend: bool = True
    scalebar: bool = True
    dpi: int = 150


@app.get("/qgis-print/templates")
def qgis_print_templates(user: dict = Depends(require_tier("premium"))):
    return {"templates": PRINT_TEMPLATES}


@app.post("/qgis-print")
def qgis_print(body: QgisPrintBody, user: dict = Depends(require_tier("premium"))):
    """Renders the given layers at the given extent to a PDF via QGIS Server.

    Synchronous, unlike the processing routes, and deliberately so: a PDF is a
    download, and making it a job would mean inventing a download-token dance
    for what is a handful of seconds' work. DPI and page size are capped so
    that stays true.

    upload-api proxies the GetPrint rather than handing the browser a
    `/qgis?MAP=...` URL: it keeps generated project paths out of the client
    (nobody can craft an arbitrary MAP=), and it makes the whole export one
    request from one button.
    """
    template = PRINT_TEMPLATES_BY_KEY.get(body.template)
    if template is None:
        raise HTTPException(400, f"Unbekannte Vorlage: {body.template}")
    if body.east <= body.west or body.north <= body.south:
        raise HTTPException(400, "Ungültiger Kartenausschnitt")

    # The layer list is rebuilt from what this user may see rather than trusted
    # from the request. Without this the print route would be a broader read
    # than /layers is, since QGIS Server itself has no per-user concept.
    visible = {l["name"]: l for l in visible_layers_for(user, all_layers())}
    requested = [n for n in body.layers if n in visible]
    printable = [
        {"name": n, "title": visible[n].get("title") or n, "opacity": 1.0}
        for n in requested
        # A point cloud has no MapServer layer at all and can never be in a WMS
        # request; skipping it here is why the caller may pass its whole
        # visible-layer list without filtering.
        if visible[n].get("geometry_type") != "POINTCLOUD"
    ]
    if not printable and not body.basemap:
        raise HTTPException(400, "Keine druckbaren Layer ausgewählt")

    project = qgis_worker("POST", "/print/project", {
        "layers": printable,
        "extent": {"west": body.west, "south": body.south, "east": body.east, "north": body.north},
        "basemap": body.basemap,
        "title": body.title or "",
        "subtitle": body.subtitle or "",
        "legend": body.legend,
        "scalebar": body.scalebar,
        "width_mm": template["width_mm"],
        "height_mm": template["height_mm"],
    }, timeout=180)

    project_path = project["project"]
    project_id = Path(project_path).stem
    extent = _print_extent_3857(body)
    query = urllib.parse.urlencode({
        "MAP": project_path,
        "SERVICE": "WMS",
        "VERSION": "1.3.0",
        "REQUEST": "GetPrint",
        "TEMPLATE": project.get("template", "vibegis"),
        "FORMAT": "pdf",
        "DPI": str(min(max(body.dpi, 72), QGIS_PRINT_MAX_DPI)),
        "CRS": "EPSG:3857",
        "map0:EXTENT": extent,
    })
    url = f"{QGIS_SERVER_URL}?{query}"
    try:
        with urllib.request.urlopen(url, timeout=180) as res:
            content_type = res.headers.get("Content-Type", "")
            payload = res.read()
    except urllib.error.URLError as e:
        raise HTTPException(502, f"QGIS Server nicht erreichbar: {e}")
    finally:
        try:
            qgis_worker("DELETE", f"/print/project/{project_id}", timeout=15)
        except Exception:  # noqa: BLE001 - the worker's own sweep is the backstop
            pass

    # QGIS Server answers a failed GetPrint with 200 and an XML
    # ServiceExceptionReport, so the status code proves nothing — the content
    # type is what distinguishes a real PDF from an error document.
    if "pdf" not in content_type.lower():
        detail = payload.decode("utf-8", "replace")[:600]
        raise HTTPException(502, f"QGIS Server lieferte kein PDF: {detail}")

    filename = f"vibegis-karte-{time.strftime('%Y%m%d-%H%M%S')}.pdf"
    return Response(
        content=payload,
        media_type="application/pdf",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


def _print_extent_3857(body: QgisPrintBody) -> str:
    """map0:EXTENT has to be in the layout map's own CRS (EPSG:3857), while the
    frontend reports the visible ground area in WGS84 degrees."""
    tr = pyproj.Transformer.from_crs("EPSG:4326", "EPSG:3857", always_xy=True)
    minx, miny = tr.transform(body.west, body.south)
    maxx, maxy = tr.transform(body.east, body.north)
    return f"{minx},{miny},{maxx},{maxy}"
