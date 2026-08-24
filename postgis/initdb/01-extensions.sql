-- Runs once, on first creation of the data volume.
CREATE EXTENSION IF NOT EXISTS postgis;
CREATE EXTENSION IF NOT EXISTS postgis_raster;
CREATE EXTENSION IF NOT EXISTS postgis_topology;
CREATE EXTENSION IF NOT EXISTS fuzzystrmatch;
CREATE EXTENSION IF NOT EXISTS postgis_tiger_geocoder;
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- Schemas: raw = as-ingested, staging = ETL work area, gis = published layers
CREATE SCHEMA IF NOT EXISTS raw;
CREATE SCHEMA IF NOT EXISTS staging;
CREATE SCHEMA IF NOT EXISTS gis;

-- Example published layer so MapServer has something to draw on day one.
CREATE TABLE IF NOT EXISTS gis.poi (
    id     bigserial PRIMARY KEY,
    name   text NOT NULL,
    kind   text,
    geom   geometry(Point, 4326) NOT NULL
);
CREATE INDEX IF NOT EXISTS poi_geom_idx ON gis.poi USING GIST (geom);

INSERT INTO gis.poi (name, kind, geom) VALUES
    ('Brandenburger Tor', 'landmark', ST_SetSRID(ST_MakePoint(13.3777, 52.5163), 4326)),
    ('Zugspitze',         'summit',   ST_SetSRID(ST_MakePoint(10.9853, 47.4211), 4326)),
    ('Koelner Dom',       'landmark', ST_SetSRID(ST_MakePoint( 6.9583, 50.9413), 4326))
ON CONFLICT DO NOTHING;
