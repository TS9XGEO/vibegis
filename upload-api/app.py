"""
Turns geodata into a first-class WMS layer, two ways:
  - POST /upload         read a file (shapefile zip, GeoPackage, GeoJSON, KML,
                         GML) with geopandas/GDAL, reproject to EPSG:4326 and
                         load it into PostGIS schema "raw" — the same schema
                         and reprojection convention the nightly Dagster asset
                         (dagster/defs/__init__.py: raw_vectors) uses for
                         files dropped into mapserver/data
  - POST /register-table point a layer directly at an existing PostGIS table,
                         no data movement — for data that's already in the DB

Either way, the result is a LAYER block appended to mapfiles/uploads.map
(included from webgis.map), so it shows up in GetCapabilities — and therefore
the frontend's layer panel — on the very next request (MapServer re-parses
its mapfile per request; see frontend-app/src/wms.ts).

DELETE /layers/{name} reverses either path: it always removes the LAYER
block, and optionally drops the underlying table. Only layers that live in
uploads.map (i.e. ones created through this API) can be named here — the
static layers in webgis.map/osm-layers.map are never touched.
"""
import fcntl
import json
import os
import re
import tempfile
import zipfile
from pathlib import Path
from typing import Annotated, Literal, Union

import geopandas as gpd
import pandas as pd
from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field
from sqlalchemy import create_engine, text

app = FastAPI()
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])

ALLOWED_EXT = {".zip", ".gpkg", ".geojson", ".json", ".kml", ".gml"}
MAX_BYTES = 2048 * 1024 * 1024  # 2 GB — matches nginx's client_max_body_size for /upload

MAPFILE_DIR = Path("/mapfiles")
UPLOADS_MAP = MAPFILE_DIR / "uploads.map"
LAYER_CONFIG_PATH = MAPFILE_DIR / "layer_config.json"

HEADER = (
    "# Appended to by upload-api (see /webgis/upload-api/app.py) — every upload\n"
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

NUMERIC_SQL_TYPES = {
    "smallint", "integer", "bigint", "decimal", "numeric",
    "real", "double precision", "smallserial", "serial", "bigserial",
}

IDENT_RE = re.compile(r"[a-zA-Z_][a-zA-Z0-9_]*")
LAYER_RE = re.compile(r"LAYER\n(.*?)\nEND\n", re.DOTALL)
NAME_RE = re.compile(r'NAME\s+"([^"]*)"')
TYPE_RE = re.compile(r"^\s*TYPE\s+(\w+)", re.MULTILINE)
DATA_RE = re.compile(r'DATA\s+"(\w+)\s+FROM\s+(\w+)\.(\w+)\s+USING\s+UNIQUE\s+(\w+)\s+USING\s+SRID=(\d+)"')


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


def slugify(name: str) -> str:
    s = re.sub(r"[^a-z0-9]+", "_", name.strip().lower()).strip("_")
    return (s or "layer")[:40]


def check_identifier(name: str, what: str) -> str:
    if not IDENT_RE.fullmatch(name):
        raise HTTPException(400, f"Invalid {what}: '{name}'")
    return name


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
        name_m, data_m = NAME_RE.search(inner), DATA_RE.search(inner)
        if not name_m or not data_m:
            continue
        type_m = TYPE_RE.search(inner)
        out.append({
            "name": name_m.group(1),
            "geom_col": data_m.group(1),
            "schema": data_m.group(2),
            "table": data_m.group(3),
            "unique_col": data_m.group(4),
            "srid": int(data_m.group(5)),
            "geometry_type": type_m.group(1) if type_m else None,
            "block": "LAYER\n" + inner + "\nEND\n",
        })
    return out


def read_layers() -> list[dict]:
    if not UPLOADS_MAP.exists():
        return []
    with open(UPLOADS_MAP, "r") as f:
        fcntl.flock(f, fcntl.LOCK_SH)
        try:
            return parse_layers(f.read())
        finally:
            fcntl.flock(f, fcntl.LOCK_UN)


def append_layer_block(block: str) -> None:
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


def build_layer_block(name, title, ms_type, schema, table, geom_col, unique_col, srid) -> str:
    e = pg_env()
    return (
        "LAYER\n"
        f'  NAME        "{name}"\n'
        '  GROUP       "uploads"\n'
        f"  TYPE        {ms_type}\n"
        "  STATUS      ON\n"
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
        "  END\n"
        "  CLASS\n"
        f'    NAME "{mapfile_escape(title)}"\n'
        f"{DEFAULT_STYLE[ms_type]}"
        "  END\n"
        "END\n"
    )


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


def read_vector(path: Path, suffix: str) -> gpd.GeoDataFrame:
    if suffix == ".zip":
        try:
            return gpd.read_file(f"/vsizip/{path}")
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
    return gpd.read_file(path)


@app.post("/upload")
async def upload(file: UploadFile = File(...), title: str | None = Form(None)):
    suffix = Path(file.filename or "").suffix.lower()
    if suffix not in ALLOWED_EXT:
        raise HTTPException(400, f"Unsupported file type '{suffix}'. Allowed: {', '.join(sorted(ALLOWED_EXT))}")

    with tempfile.NamedTemporaryFile(suffix=suffix, delete=False) as tmp:
        tmp_path = Path(tmp.name)
        size = 0
        while chunk := await file.read(1024 * 1024):
            size += len(chunk)
            if size > MAX_BYTES:
                tmp_path.unlink(missing_ok=True)
                raise HTTPException(413, f"File exceeds the {MAX_BYTES // (1024*1024)} MB limit")
            tmp.write(chunk)

    try:
        gdf = read_vector(tmp_path, suffix)
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

    base_name = title or Path(file.filename or "layer").stem
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

    return {
        "layer": table,
        "title": base_name,
        "geometry_type": ms_type,
        "feature_count": len(gdf),
        "columns": gdf_attribute_columns(gdf, geom_col),
    }


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
        conn.execute(text(f'ALTER TABLE "{schema}"."{table}" ADD COLUMN gid SERIAL PRIMARY KEY'))
    return "gid"


DISTINCT_VALUES_LIMIT = 500


@app.get("/distinct-values")
def distinct_values(schema: str, table: str, column: str):
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
def column_stats(schema: str, table: str, column: str):
    """Min/max of a numeric column — seeds the graduated classification editor's default breaks."""
    schema = check_identifier(schema, "schema name")
    table = check_identifier(table, "table name")
    column = check_identifier(column, "column name")

    with engine().begin() as conn:
        row = conn.execute(
            text(f'SELECT MIN("{column}"), MAX("{column}") FROM "{schema}"."{table}" WHERE "{column}" IS NOT NULL')
        ).first()

    if row is None or row[0] is None:
        raise HTTPException(404, f"No values found for {schema}.{table}.{column}")
    return {"min": float(row[0]), "max": float(row[1])}


@app.get("/tables")
def list_tables():
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
def register_table(body: RegisterTableBody):
    schema = check_identifier(body.schema_name, "schema name")
    table = check_identifier(body.table, "table name")

    geom_col, srid = find_geometry_column(schema, table)
    ms_type = geometry_family_for_table(schema, table, geom_col)
    unique_col = ensure_unique_column(schema, table)

    title = body.title or table
    base = slugify(f"{schema}_{table}")
    existing_names = {l["name"] for l in read_layers()}
    name = f"dbtable_{base}"
    n = 2
    while name in existing_names:
        name = f"dbtable_{base}_{n}"
        n += 1

    append_layer_block(build_layer_block(name, title, ms_type, schema, table, geom_col, unique_col, srid))

    return {
        "layer": name,
        "title": title,
        "geometry_type": ms_type,
        "schema": schema,
        "table": table,
        "columns": table_attribute_columns(schema, table, geom_col),
    }


# -------------------------------------------------------------- /layers

@app.get("/layers")
def list_layers():
    return {"layers": [{k: v for k, v in l.items() if k != "block"} for l in read_layers()]}


@app.delete("/layers/{name}")
def delete_layer(name: str, drop_table: bool = False):
    removed = remove_layer_block(name)
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


class CategorizedClassification(BaseModel):
    """One color per distinct value of `column` — text or numeric columns both work."""
    mode: Literal["categorized"] = "categorized"
    column: str
    classes: list[ClassDef]


class GraduatedClassification(BaseModel):
    """Numeric `column` split into ranges, each with its own color."""
    mode: Literal["graduated"] = "graduated"
    column: str
    breaks: list[GraduatedBreak]


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


def read_layer_config() -> dict:
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
def get_all_layer_configs():
    """Every layer's config in one call, so the frontend doesn't fetch per-layer on every load()."""
    return read_layer_config()


@app.get("/layer-config/{name}")
def get_layer_config(name: str):
    return read_layer_config().get(name, {})


@app.patch("/layer-config/{name}")
def patch_layer_config(name: str, patch: LayerConfigPatch):
    config = read_layer_config()
    updates = patch.model_dump(exclude_unset=True, exclude_none=True)
    merged = {**config.get(name, {}), **updates}
    config[name] = merged
    write_layer_config(config)
    return merged


@app.delete("/layer-config/{name}")
def delete_layer_config(name: str):
    config = read_layer_config()
    config.pop(name, None)
    write_layer_config(config)
    return {"ok": True}


@app.get("/health")
def health():
    return {"ok": True}
