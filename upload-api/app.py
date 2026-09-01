"""
Turns geodata into a first-class WMS layer, several ways:
  - POST /upload         read a file (shapefile zip, GeoPackage, GeoJSON, KML,
                         GML) with geopandas/GDAL, reproject to EPSG:4326 and
                         load it into PostGIS schema "raw" — the same schema
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
import fcntl
import json
import os
import re
import shutil
import subprocess
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
import zipfile
from pathlib import Path
from typing import Annotated, Literal, Union

import bcrypt
import geopandas as gpd
import jwt
import pandas as pd
import yaml
from fastapi import Depends, FastAPI, File, Form, HTTPException, Request, Response, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field
from sqlalchemy import create_engine, text

import ai_agent

app = FastAPI()
app.add_middleware(
    CORSMiddleware,
    allow_origins=[f"http://localhost:{os.environ.get('GATEWAY_PORT', '8080')}"],
    allow_credentials=True,
    allow_methods=["GET", "POST", "PATCH", "DELETE"],
    allow_headers=["Content-Type"],
)

ALLOWED_EXT = {".zip", ".gpkg", ".geojson", ".json", ".kml", ".gml"}
MAX_BYTES = 2048 * 1024 * 1024  # 2 GB — matches nginx's client_max_body_size for /upload

RASTER_ALLOWED_EXT = {".tif", ".tiff"}
# Not /data/rasters: /data is itself a read-only mount here (and read-only in
# mapserver too), and a nested bind mount can't be created under an
# already-read-only parent — see docker-compose.yml.
RASTERS_DIR = Path("/rasters")

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
LAYER_CONFIG_PATH = MAPFILE_DIR / "layer_config.json"

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
    "POLYGON": "    STYLE\n      COLOR 90 170 230\n      OPACITY 55\n"
               "      OUTLINECOLOR 130 200 255\n      WIDTH 0.6\n    END\n",
}

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


def classified_style(ms_type: str, color: str, size: float | None = None) -> str:
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
    polygons, which have no size control.
    """
    rgb = hex_to_rgb(color)
    if ms_type == "POLYGON":
        return f"    STYLE  COLOR {rgb}  OUTLINECOLOR {rgb}  WIDTH 0.5  END\n"
    if ms_type == "LINE":
        width = size if size is not None else 2.2
        return f"    STYLE  COLOR {rgb}  WIDTH {width}  LINECAP ROUND  END\n"
    point_size = size if size is not None else 10
    return f'    STYLE  SYMBOL "circle"  SIZE {point_size}  COLOR {rgb}  OUTLINECOLOR 255 255 255  WIDTH 1  END\n'


def build_class_blocks(classification: dict | None, ms_type: str, title: str) -> str:
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
        return "  CLASS\n" f'    NAME "{mapfile_escape(title)}"\n' f"{DEFAULT_STYLE[ms_type]}" "  END\n"

    mode = classification.get("mode")
    size = classification.get("size")
    if mode == "single":
        return (
            "  CLASS\n"
            f'    NAME "{mapfile_escape(title)}"\n'
            f"{classified_style(ms_type, classification.get('color'), size)}"
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
                f"{classified_style(ms_type, c.get('color'), size)}"
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
                f"{classified_style(ms_type, b.get('color'), size)}"
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


def ensure_users_table() -> None:
    with engine().begin() as conn:
        conn.execute(text(
            "CREATE TABLE IF NOT EXISTS users ("
            "id serial PRIMARY KEY, username text NOT NULL UNIQUE, "
            "password_hash text NOT NULL, "
            "role text NOT NULL CHECK (role IN ('admin', 'viewer')), "
            "created_at timestamptz NOT NULL DEFAULT now())"
        ))
        # Additive to role, not a third role value: an admin should never
        # lose ETL access, and "viewer + premium" is a real combination.
        # ALTER ... ADD COLUMN IF NOT EXISTS is needed (not just the CREATE
        # TABLE above) because this table already exists in the live DB.
        conn.execute(text(
            "ALTER TABLE users ADD COLUMN IF NOT EXISTS premium boolean NOT NULL DEFAULT false"
        ))


class LoginBody(BaseModel):
    username: str
    password: str


class CreateUserBody(BaseModel):
    username: str
    password: str
    role: Literal["admin", "viewer"]
    premium: bool = False


def issue_token(user_id: int, username: str, role: str, premium: bool) -> str:
    payload = {
        "sub": str(user_id), "username": username, "role": role, "premium": premium,
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


def require_etl_access(user: dict = Depends(require_login)) -> dict:
    if user.get("role") != "admin" and not user.get("premium"):
        raise HTTPException(403, "Premium access required")
    return user


@app.post("/login")
def login(body: LoginBody, response: Response):
    with engine().begin() as conn:
        row = conn.execute(
            text("SELECT id, username, password_hash, role, premium FROM users WHERE username = :u"),
            {"u": body.username},
        ).first()
    if not row or not bcrypt.checkpw(body.password.encode(), row.password_hash.encode()):
        raise HTTPException(401, "Ungültiger Benutzername oder Passwort")
    response.set_cookie(
        COOKIE_NAME, issue_token(row.id, row.username, row.role, row.premium),
        httponly=True, secure=False, samesite="lax", path="/", max_age=JWT_EXPIRY_SECONDS,
    )
    return {"username": row.username, "role": row.role, "premium": row.premium}


@app.post("/logout")
def logout(response: Response):
    response.delete_cookie(COOKIE_NAME, path="/")
    return {"ok": True}


@app.get("/auth/verify")
def auth_verify(user: dict = Depends(require_login)):
    # nginx's auth_request only cares about the status code — 200 here means
    # "gateway may proxy the original request".
    return Response(status_code=200)


@app.get("/auth/me")
def auth_me(user: dict = Depends(require_login)):
    return {"username": user["username"], "role": user["role"], "premium": bool(user.get("premium"))}


# -------------------------------------------------------------- /users
# Admin-only account management, backing the in-app admin screen. POST is an
# upsert (same semantics as bin/add-user.sh) so resubmitting the form for an
# existing username resets its password/role instead of erroring.

@app.get("/users")
def list_users(user: dict = Depends(require_role("admin"))):
    with engine().begin() as conn:
        rows = conn.execute(text(
            "SELECT id, username, role, premium, created_at FROM users ORDER BY username"
        )).mappings().all()
    return list(rows)


@app.post("/users")
def upsert_user(body: CreateUserBody, user: dict = Depends(require_role("admin"))):
    pw_hash = bcrypt.hashpw(body.password.encode(), bcrypt.gensalt()).decode()
    with engine().begin() as conn:
        conn.execute(text(
            "INSERT INTO users (username, password_hash, role, premium) VALUES (:u, :p, :r, :pr) "
            "ON CONFLICT (username) DO UPDATE SET "
            "password_hash = EXCLUDED.password_hash, role = EXCLUDED.role, premium = EXCLUDED.premium"
        ), {"u": body.username, "p": pw_hash, "r": body.role, "pr": body.premium})
    return {"username": body.username, "role": body.role, "premium": body.premium}


@app.delete("/users/{username}")
def delete_user(username: str, user: dict = Depends(require_role("admin"))):
    with engine().begin() as conn:
        target = conn.execute(text("SELECT role FROM users WHERE username = :u"), {"u": username}).first()
        if not target:
            raise HTTPException(404, "Unbekannter Benutzer")
        if target.role == "admin":
            remaining = conn.execute(text(
                "SELECT count(*) FROM users WHERE role = 'admin' AND username != :u"
            ), {"u": username}).scalar()
            if remaining == 0:
                raise HTTPException(400, "Der letzte Admin kann nicht gelöscht werden")
        conn.execute(text("DELETE FROM users WHERE username = :u"), {"u": username})
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
        print(f"[startup] could not ensure users table: {e}", flush=True)
    try:
        ai_agent.ensure_ai_schema(engine)
    except Exception as e:
        print(f"[startup] could not ensure AI agent schema/role: {e}", flush=True)


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
    classification=None, max_scale_denom=None,
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
        # No password= here on purpose: the mapfile is committed to git, and
        # libpq fills the password in from PGPASSWORD, which compose already
        # sets on the mapserver container.
        f'  CONNECTION  "host={e["host"]} dbname={e["dbname"]} user={e["user"]} port=5432"\n'
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
        f"{build_class_blocks(classification, ms_type, title)}"
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
                text("SELECT table_name FROM information_schema.tables WHERE table_schema = 'raw'")
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
async def upload(
    file: UploadFile | None = File(None),
    title: str | None = Form(None),
    layer: str | None = Form(None),
    upload_token: str | None = Form(None),
    user: dict = Depends(require_role("admin")),
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
            while chunk := await file.read(1024 * 1024):
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

    if gdf.empty:
        raise HTTPException(400, "File contains no features")
    if gdf.geometry.isna().all():
        raise HTTPException(400, "File has no geometry column")

    families = {GEOM_FAMILY.get(g, "OTHER") for g in gdf.geom_type.unique()}
    if len(families) != 1 or "OTHER" in families:
        raise HTTPException(400, f"Unsupported or mixed geometry types: {sorted(gdf.geom_type.unique())}")
    ms_type = families.pop()

    gdf = gdf.set_crs(4326) if gdf.crs is None else gdf.to_crs(4326)

    base_name = title or (Path(original_name).stem if original_name else layer) or tmp_path.stem
    slug = slugify(base_name)
    table = unique_table_name(slug)
    geom_col = gdf.geometry.name

    eng = engine()
    try:
        gdf.to_postgis(table, eng, schema="raw", if_exists="fail", index=False)
        with eng.begin() as conn:
            conn.execute(text(f'ALTER TABLE "raw"."{table}" ADD COLUMN gid SERIAL PRIMARY KEY'))
            conn.execute(text(f'CREATE INDEX "{table}_geom_gist" ON "raw"."{table}" USING GIST ("{geom_col}")'))
            conn.execute(text(f'ANALYZE "raw"."{table}"'))
    except Exception as e:
        with eng.begin() as conn:
            conn.execute(text(f'DROP TABLE IF EXISTS "raw"."{table}"'))
        raise HTTPException(500, f"Failed to load into PostGIS: {e}")

    append_layer_block(build_layer_block(table, base_name, ms_type, "raw", table, geom_col, "gid", 4326))
    seed_layer_style(table, ms_type, "raw", table)
    generate_mapproxy_config()

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
    dbtable_ loop, checked against read_layers() — there is no PostGIS table
    to check unique_table_name()-style against for a raster."""
    existing = {l["name"] for l in read_layers()}
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
) -> dict:
    """The raster analogue of publish_derived_table()'s tail. No
    seed_layer_style() call — a continuous/RGB raster has no CLASS-based
    classification to seed, and apply_layer_style() no-ops for TYPE RASTER
    anyway."""
    append_layer_block(build_raster_layer_block(name, title, path, bands, batch, batch_title))
    generate_mapproxy_config()
    return {"layer": name, "title": title, "geometry_type": "RASTER"}


def normalize_tile_and_publish(
    src: Path, base_title: str, *, bands: int, width: int, height: int, data_type: str | None,
    batch: str | None = None, batch_title: str | None = None,
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

        result = publish_raster_layer(name, base_title, final_path, bands, batch, batch_title)
    except Exception:
        if final_path is not None:
            final_path.unlink(missing_ok=True)
        raise
    finally:
        normalized_path.unlink(missing_ok=True)  # no-op once moved

    result.update({"bands": bands, "width": width, "height": height, "data_type": data_type})
    return result


@app.post("/upload-raster")
async def upload_raster(
    file: UploadFile = File(...),
    title: str | None = Form(None),
    user: dict = Depends(require_role("admin")),
):
    check_raster_volume()
    UPLOAD_TMP_DIR.mkdir(parents=True, exist_ok=True)

    suffix = Path(file.filename or "").suffix.lower()
    if suffix not in RASTER_ALLOWED_EXT:
        raise HTTPException(400, f"Unsupported file type '{suffix}'. Allowed: {', '.join(sorted(RASTER_ALLOWED_EXT))}")

    tmp_path = UPLOAD_TMP_DIR / f"{uuid.uuid4().hex}{suffix}"
    size = 0
    with open(tmp_path, "wb") as tmp:
        while chunk := await file.read(1024 * 1024):
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
            data_type=band.get("type"),
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
async def upload_raster_zip(
    file: UploadFile = File(...),
    title: str | None = Form(None),
    user: dict = Depends(require_role("admin")),
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
        while chunk := await file.read(1024 * 1024):
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
                        batch=batch, batch_title=batch_title,
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
def raster_composite(body: RasterCompositeBody, user: dict = Depends(require_role("admin"))):
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
    return publish_raster_layer(name, base_title, dst, bands=3)


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


def publish_derived_table(schema: str, table: str, title: str | None) -> dict:
    """The shared tail of /register-table and /geoprocess: a table that
    already exists in PostGIS, published as a new LAYER block."""
    geom_col, srid = find_geometry_column(schema, table)
    ms_type = geometry_family_for_table(schema, table, geom_col)
    unique_col = ensure_unique_column(schema, table)

    resolved_title = title or table
    base = slugify(f"{schema}_{table}")
    existing_names = {l["name"] for l in read_layers()}
    name = f"dbtable_{base}"
    n = 2
    while name in existing_names:
        name = f"dbtable_{base}_{n}"
        n += 1

    append_layer_block(build_layer_block(name, resolved_title, ms_type, schema, table, geom_col, unique_col, srid))
    seed_layer_style(name, ms_type, schema, table)
    generate_mapproxy_config()

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
    schema = check_identifier(schema, "schema name")
    table = check_identifier(table, "table name")
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
    schema = check_identifier(schema, "schema name")
    table = check_identifier(table, "table name")
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


@app.get("/column-groupby")
def column_groupby(
    schema: str, table: str, column: str, filter: str | None = None, user: dict = Depends(require_login)
):
    """
    Value + count per distinct value, ordered by count descending — the
    server-side equivalent of the client-side group-by SelectionDashboard.tsx
    does over a real selection's in-memory features, for the "everything
    selected" overview where there are none. Capped like /distinct-values;
    `totalCount` is an exact count across every value (not just the capped
    ones returned), so the frontend can compute an exact "Andere" remainder
    even beyond the cap. `filter`, when given, scopes both queries to that
    layer's active attribute filter — see build_filter_where().
    """
    schema = check_identifier(schema, "schema name")
    table = check_identifier(table, "table name")
    column = check_identifier(column, "column name")

    layer_filter = parse_layer_filter(filter)
    params: dict = {"limit": DISTINCT_VALUES_LIMIT + 1}
    extra_where = build_filter_where(layer_filter, params)
    if extra_where:
        extra_where = f"AND {extra_where}"

    with engine().begin() as conn:
        rows = conn.execute(
            text(
                f'SELECT "{column}", COUNT(*) FROM "{schema}"."{table}" '
                f'WHERE "{column}" IS NOT NULL {extra_where} GROUP BY "{column}" ORDER BY COUNT(*) DESC LIMIT :limit'
            ),
            params,
        ).all()
        total_params: dict = {}
        total_where = build_filter_where(layer_filter, total_params)
        if total_where:
            total_where = f"AND {total_where}"
        total = conn.execute(
            text(f'SELECT COUNT(*) FROM "{schema}"."{table}" WHERE "{column}" IS NOT NULL {total_where}'),
            total_params,
        ).scalar()

    return {
        "buckets": [{"value": str(r[0]), "count": r[1]} for r in rows[:DISTINCT_VALUES_LIMIT]],
        "totalCount": total,
        "truncated": len(rows) > DISTINCT_VALUES_LIMIT,
    }


@app.get("/table-count")
def table_count(schema: str, table: str, filter: str | None = None, user: dict = Depends(require_login)):
    """
    Plain row count for a whole table — the dashboard overview card's
    headline number (the "everything selected" equivalent of a real
    selection's entries.length) and, summed across every visible layer, the
    denominator for that mode's "share of everything visible" ring. `filter`,
    when given, scopes the count to that layer's active attribute filter —
    see build_filter_where().
    """
    schema = check_identifier(schema, "schema name")
    table = check_identifier(table, "table name")

    params: dict = {}
    where = build_filter_where(parse_layer_filter(filter), params)
    where_clause = f"WHERE {where}" if where else ""

    with engine().begin() as conn:
        count = conn.execute(text(f'SELECT COUNT(*) FROM "{schema}"."{table}" {where_clause}'), params).scalar()

    return {"count": count}


@app.get("/tables")
def list_tables(user: dict = Depends(require_login)):
    with engine().begin() as conn:
        rows = conn.execute(
            text(
                "SELECT f_table_schema, f_table_name, f_geometry_column, type, srid "
                "FROM geometry_columns "
                "WHERE f_table_schema NOT IN ('tiger', 'tiger_data', 'topology') "
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
def register_table(body: RegisterTableBody, user: dict = Depends(require_role("admin"))):
    schema = check_identifier(body.schema_name, "schema name")
    table = check_identifier(body.table, "table name")
    return publish_derived_table(schema, table, body.title)


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
def geoprocess(body: GeoprocessBody, user: dict = Depends(require_role("admin"))):
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
    schema_a = check_identifier(body.schema_a, "schema name")
    table_a = check_identifier(body.table_a, "table name")
    geom_a, _ = find_geometry_column(schema_a, table_a)
    family_a = geometry_family_for_table(schema_a, table_a, geom_a)

    schema_b = table_b = geom_b = None
    if body.operation in ("intersect", "join"):
        if not body.schema_b or not body.table_b:
            raise HTTPException(400, "schema_b/table_b required for this operation")
        schema_b = check_identifier(body.schema_b, "schema name")
        table_b = check_identifier(body.table_b, "table name")
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
                        f'CREATE TABLE "raw"."{new_table}" AS '
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
                        f'CREATE TABLE "raw"."{new_table}" AS '
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
                        f'CREATE TABLE "raw"."{new_table}" AS '
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
                        f'CREATE TABLE "raw"."{new_table}" AS '
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
                    f'ALTER TABLE "raw"."{new_table}" ALTER COLUMN "{geom_a}" '
                    f'TYPE geometry(Geometry, 4326) USING "{geom_a}"'
                )
            )
    except HTTPException:
        with eng.begin() as conn:
            conn.execute(text(f'DROP TABLE IF EXISTS "raw"."{new_table}"'))
        raise
    except Exception as e:
        with eng.begin() as conn:
            conn.execute(text(f'DROP TABLE IF EXISTS "raw"."{new_table}"'))
        raise HTTPException(500, f"Geoprocessing failed: {e}")

    return publish_derived_table("raw", new_table, body.title)


# -------------------------------------------------------------- /layers

@app.get("/layers")
def list_layers(user: dict = Depends(require_login)):
    return {"layers": [{k: v for k, v in l.items() if k != "block"} for l in read_layers()]}


@app.delete("/layers/{name}")
def delete_layer(name: str, drop_table: bool = False, user: dict = Depends(require_role("admin"))):
    removed = remove_layer_block(name)
    # Otherwise a layer later re-registered under the same name would be served
    # the deleted one's tiles.
    purge_layer_cache(name)
    generate_mapproxy_config()
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


# Keys whose value changes what MapServer draws, so a write to any of them has
# to rebuild the LAYER block, drop the layer's cached tiles, and bump
# styleVersion so the browser stops painting the tiles it already holds.
STYLE_KEYS = {"classification", "maxScaleDenom", "title"}


def read_layer_config() -> dict:
    check_mapfile_volume()
    if not LAYER_CONFIG_PATH.exists():
        return {}
    with open(LAYER_CONFIG_PATH, "r") as f:
        fcntl.flock(f, fcntl.LOCK_SH)
        try:
            raw = f.read()
            return json.loads(raw) if raw.strip() else {}
        finally:
            fcntl.flock(f, fcntl.LOCK_UN)


def write_layer_config(config: dict) -> None:
    check_mapfile_volume()
    MAPFILE_DIR.mkdir(parents=True, exist_ok=True)
    with open(LAYER_CONFIG_PATH, "a+") as f:
        fcntl.flock(f, fcntl.LOCK_EX)
        try:
            f.seek(0)
            f.truncate()
            f.write(json.dumps(config, indent=2))
            f.flush()
        finally:
            fcntl.flock(f, fcntl.LOCK_UN)


@app.get("/layer-config")
def get_all_layer_configs(user: dict = Depends(require_login)):
    """Every layer's config in one call, so the frontend doesn't fetch per-layer on every load()."""
    return read_layer_config()


@app.get("/layer-config/{name}")
def get_layer_config(name: str, user: dict = Depends(require_login)):
    return read_layer_config().get(name, {})


@app.patch("/layer-config/{name}")
def patch_layer_config(name: str, patch: LayerConfigPatch, user: dict = Depends(require_role("admin"))):
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
def delete_layer_config(name: str, user: dict = Depends(require_role("admin"))):
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
def delete_layer_config_key(name: str, key: str, user: dict = Depends(require_role("admin"))):
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


@app.get("/health")
def health(user: dict = Depends(require_login)):
    # Reports the mount explicitly rather than a bare ok: a dead bind mount is
    # the one failure that leaves this service running and answering normally.
    return {"ok": MOUNT_SENTINEL.exists(), "mapfile_volume": MOUNT_SENTINEL.exists()}


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
        print(f"[startup] skipping style materialization: {e}", flush=True)
        return
    for l in layers:
        try:
            # seed_layer_style rather than apply_layer_style so layers that
            # predate scale caps get one too. It only fills a cap that was
            # never set, so a deliberately cleared one is not resurrected.
            seed_layer_style(l["name"], l["geometry_type"], l["schema"], l["table"])
        except Exception as e:
            print(f"[startup] could not apply style for {l['name']}: {e}", flush=True)
    try:
        generate_mapproxy_config()
    except Exception as e:
        print(f"[startup] could not generate mapproxy.yaml: {e}", flush=True)


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
            text("SELECT ai_provider, ai_key_ciphertext FROM users WHERE id = :id"),
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
            text("SELECT ai_provider, ai_key_last4 FROM users WHERE id = :id"),
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
            "UPDATE users SET ai_provider = :p, ai_key_ciphertext = :c, ai_key_last4 = :l4, "
            "ai_key_updated_at = now() WHERE id = :id"
        ), {"p": body.provider, "c": ciphertext, "l4": last4, "id": int(user["sub"])})
    return {"provider": body.provider, "last4": last4}


@app.delete("/ai/settings/key")
def delete_ai_key(user: dict = Depends(require_etl_access)):
    with engine().begin() as conn:
        conn.execute(text(
            "UPDATE users SET ai_provider = NULL, ai_key_ciphertext = NULL, ai_key_last4 = NULL, "
            "ai_key_updated_at = NULL WHERE id = :id"
        ), {"id": int(user["sub"])})
    return {"ok": True}


@app.post("/ai/chat")
def ai_chat(body: AiChatBody, user: dict = Depends(require_etl_access)):
    provider, ciphertext = _load_user_ai_key(user)
    api_key = ai_agent.decrypt_key(ciphertext)
    # The only app.py internals a tool call needs — kept to this one
    # identifier-sanitizer rather than handing ai_agent.py the full-access
    # engine(), since every DB read tool uses its own ai_readonly_engine().
    tool_context = {"check_identifier": check_identifier}
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
