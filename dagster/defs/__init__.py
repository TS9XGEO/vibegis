"""Dagster definitions for the WebGIS ETL.

Asset-oriented, matching Dagster's model: each asset is a dataset that
lands somewhere concrete (a PostGIS table, a GeoTIFF on disk), not a task.
"""
import os

from dagster import (
    AssetExecutionContext,
    Definitions,
    MaterializeResult,
    MetadataValue,
    asset,
    define_asset_job,
    ScheduleDefinition,
)
from sqlalchemy import create_engine, text


def pg_url() -> str:
    return (
        f"postgresql+psycopg://{os.environ['POSTGRES_USER']}:"
        f"{os.environ['POSTGRES_PASSWORD']}@"
        f"{os.environ.get('POSTGRES_HOST', 'postgis')}:5432/"
        f"{os.environ['POSTGRES_DB']}"
    )


@asset(group_name="infrastructure", description="Verify PostGIS is reachable and extensions are present.")
def postgis_ready(context: AssetExecutionContext) -> MaterializeResult:
    engine = create_engine(pg_url())
    with engine.connect() as conn:
        version = conn.execute(text("SELECT postgis_full_version()")).scalar_one()
    context.log.info(version)
    return MaterializeResult(metadata={"postgis_version": MetadataValue.text(version)})


@asset(
    group_name="ingest",
    deps=[postgis_ready],
    description="Load every vector file dropped into ./mapserver/data into schema raw.",
)
def raw_vectors(context: AssetExecutionContext) -> MaterializeResult:
    import geopandas as gpd

    src = "/data/raster"          # mounted from ./mapserver/data
    engine = create_engine(pg_url())
    loaded: dict[str, int] = {}

    exts = (".gpkg", ".shp", ".geojson", ".json", ".gml", ".kml")
    for fname in sorted(os.listdir(src)):
        if not fname.lower().endswith(exts):
            continue
        path = os.path.join(src, fname)
        table = os.path.splitext(fname)[0].lower().replace("-", "_").replace(" ", "_")
        gdf = gpd.read_file(path)
        if gdf.crs is None:
            context.log.warning(f"{fname} has no CRS, assuming EPSG:4326")
            gdf = gdf.set_crs(4326)
        gdf = gdf.to_crs(4326)
        gdf.to_postgis(table, engine, schema="raw", if_exists="replace", index=False)
        loaded[table] = len(gdf)
        context.log.info(f"loaded {fname} -> raw.{table} ({len(gdf)} features)")

    return MaterializeResult(
        metadata={
            "tables": MetadataValue.json(loaded),
            "table_count": MetadataValue.int(len(loaded)),
        }
    )


@asset(
    group_name="publish",
    deps=[raw_vectors],
    description="Reindex and analyse published layers so MapServer stays fast.",
)
def published_layers(context: AssetExecutionContext) -> MaterializeResult:
    engine = create_engine(pg_url())
    with engine.begin() as conn:
        tables = conn.execute(
            text(
                "SELECT f_table_schema, f_table_name, f_geometry_column "
                "FROM geometry_columns WHERE f_table_schema IN ('gis','raw')"
            )
        ).all()
        for schema, table, geom in tables:
            idx = f"{table}_{geom}_gist"
            conn.execute(
                text(f'CREATE INDEX IF NOT EXISTS "{idx}" ON "{schema}"."{table}" USING GIST ("{geom}")')
            )
            conn.execute(text(f'ANALYZE "{schema}"."{table}"'))
            context.log.info(f"indexed {schema}.{table}")

    return MaterializeResult(metadata={"layers": MetadataValue.int(len(tables))})


refresh_job = define_asset_job("refresh_all", selection="*")

defs = Definitions(
    assets=[postgis_ready, raw_vectors, published_layers],
    jobs=[refresh_job],
    schedules=[
        ScheduleDefinition(
            job=refresh_job,
            cron_schedule="0 3 * * *",   # nightly 03:00
            default_status_is_running=False,
        )
    ],
)
