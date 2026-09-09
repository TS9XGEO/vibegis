-- 3D buildings for pg2b3dm, plus a search function for pg_featureserv.
--   docker compose exec -T postgis psql -U gis -d gis < postgis/initdb/05-3d-and-search.sql

-- Explicit SCHEMA public here on purpose: this file runs as the "gis" role,
-- whose search_path puts an app schema first, so an unqualified CREATE
-- EXTENSION lands there instead of public — and DROP SCHEMA ... CASCADE on
-- that app schema (e.g. during the dwh/configdb/userdb migration) then
-- silently takes the extension down with it. Keep extensions in public.
CREATE EXTENSION IF NOT EXISTS postgis_sfcgal SCHEMA public;   -- ST_Extrude
CREATE EXTENSION IF NOT EXISTS hstore SCHEMA public;           -- read GDAL's other_tags
CREATE EXTENSION IF NOT EXISTS pg_trgm SCHEMA public;          -- fuzzy name search
CREATE EXTENSION IF NOT EXISTS unaccent SCHEMA public;

-- ==================================================== 3D building volumes ==
--
-- pg2b3dm requires MultiPolygon Z. We build it by:
--   1. reading height / building:levels out of OSM's other_tags hstore
--   2. reprojecting to UTM 32N so extrusion happens in real metres
--      (extruding by 8 in EPSG:4326 would make buildings eight DEGREES tall)
--   3. ST_Extrude -> PolyhedralSurface Z, dumped to faces and re-collected
--      as MultiPolygon Z
--   4. transforming back to 4326; PostGIS transforms XY and leaves Z alone,
--      which is exactly what 3D Tiles wants: lon/lat plus metres.

DROP TABLE IF EXISTS dwh.buildings3d;

CREATE TABLE dwh.buildings3d AS
WITH tagged AS (
    SELECT
        b.gid,
        b.kind,
        b.name,
        b.geom,
        CASE
            WHEN r.other_tags IS NULL OR r.other_tags = '' THEN ''::hstore
            ELSE r.other_tags::hstore
        END AS tags
    FROM dwh.buildings b
    LEFT JOIN dwh.osm_buildings r USING (gid)
),
heights AS (
    SELECT
        gid, kind, name, geom,
        LEAST(GREATEST(COALESCE(
            -- explicit height in metres
            NULLIF(regexp_replace(tags -> 'height', '[^0-9.]', '', 'g'), '')::double precision,
            -- storeys * typical floor height
            NULLIF(regexp_replace(tags -> 'building:levels', '[^0-9.]', '', 'g'), '')::double precision * 3.2,
            -- fall back on the use class
            CASE kind
                WHEN 'sakral'         THEN 22
                WHEN 'oeffentlich'    THEN 14
                WHEN 'gewerbe'        THEN 11
                WHEN 'industrie'      THEN 10
                WHEN 'grossbau'       THEN 12
                WHEN 'landwirtschaft' THEN 7
                WHEN 'nebengebaeude'  THEN 3
                ELSE 9
            END
        ), 2.0), 180.0) AS height          -- clamp out absurd OSM values
    FROM tagged
),
faces AS (
    SELECT
        h.gid, h.kind, h.name, h.height,
        (ST_Dump(
            ST_Extrude(
                ST_Force3D(poly.geom),     -- one polygon at a time: ST_Extrude
                0, 0, h.height             -- does not accept multipolygons
            )
        )).geom AS face
    FROM heights h,
         LATERAL (SELECT (ST_Dump(ST_Transform(h.geom, 25832))).geom AS geom) poly
)
SELECT
    gid,
    kind,
    name,
    height,
    ST_Transform(ST_Collect(face), 4326)::geometry(MultiPolygonZ, 4326) AS geom3d
FROM faces
GROUP BY gid, kind, name, height;

ALTER TABLE dwh.buildings3d ADD PRIMARY KEY (gid);
CREATE INDEX buildings3d_geom_idx ON dwh.buildings3d USING GIST (geom3d);
ANALYZE dwh.buildings3d;

-- ============================================================== search =====
--
-- One searchable index over everything with a name, exposed to the frontend
-- as a pg_featureserv function endpoint.

DROP MATERIALIZED VIEW IF EXISTS dwh.search_index;

CREATE MATERIALIZED VIEW dwh.search_index AS
SELECT row_number() OVER () AS sid, *
FROM (
    SELECT shapename AS name, 'Verwaltungseinheit' AS category,
           ST_PointOnSurface(geom) AS geom
    FROM dwh.adm2_simple WHERE shapename IS NOT NULL
    UNION ALL
    SELECT name, 'Gebaeude', ST_PointOnSurface(geom)
    FROM dwh.buildings WHERE name IS NOT NULL
    UNION ALL
    SELECT name, 'Strasse', ST_PointOnSurface(ST_CollectionExtract(geom, 2))
    FROM dwh.roads WHERE name IS NOT NULL
    UNION ALL
    SELECT name, 'Landbedeckung', ST_PointOnSurface(geom)
    FROM dwh.landcover WHERE name IS NOT NULL
) s;

CREATE INDEX search_name_trgm ON dwh.search_index USING GIN (name gin_trgm_ops);
CREATE INDEX search_geom_idx  ON dwh.search_index USING GIST (geom);
CREATE UNIQUE INDEX search_sid_idx ON dwh.search_index (sid);
ANALYZE dwh.search_index;

-- Dynamic counterpart to the materialized view above: a materialized
-- view's query is fixed at creation time, so it can never grow to include a
-- layer published after this file ran. upload-api maintains this table
-- directly instead — one row per feature, for any vector layer publish
-- (upload, table registration, geoprocess result) whose table has a
-- name-like column (see app.py's pick_search_name_column()) — refreshed on
-- every publish and swept on layer delete. postgisftw.search() below unions
-- both sources so the frontend's search box never has to know which one a
-- hit came from.
CREATE TABLE IF NOT EXISTS dwh.search_index_uploads (
    sid        bigserial PRIMARY KEY,
    layer_name text NOT NULL,
    name       text NOT NULL,
    category   text NOT NULL,
    geom       geometry(Point, 4326) NOT NULL
);
CREATE INDEX search_uploads_name_trgm ON dwh.search_index_uploads USING GIN (name gin_trgm_ops);
CREATE INDEX search_uploads_geom_idx  ON dwh.search_index_uploads USING GIST (geom);
CREATE INDEX search_uploads_layer_idx ON dwh.search_index_uploads (layer_name);

-- pg_featureserv publishes functions in the "postgisftw" schema.
CREATE SCHEMA IF NOT EXISTS postgisftw;

DROP FUNCTION IF EXISTS postgisftw.search(text, integer);

CREATE FUNCTION postgisftw.search(q text DEFAULT '', maxrows integer DEFAULT 15)
RETURNS TABLE (name text, category text, score real, geom geometry)
AS $$
    SELECT name, category, score, geom FROM (
        SELECT s.name,
               s.category,
               similarity(unaccent(s.name), unaccent(q)) AS score,
               s.geom
        FROM dwh.search_index s
        WHERE q <> ''
          AND (unaccent(s.name) ILIKE '%' || unaccent(q) || '%'
               OR unaccent(s.name) % unaccent(q))
        UNION ALL
        SELECT u.name,
               u.category,
               similarity(unaccent(u.name), unaccent(q)) AS score,
               u.geom
        FROM dwh.search_index_uploads u
        WHERE q <> ''
          AND (unaccent(u.name) ILIKE '%' || unaccent(q) || '%'
               OR unaccent(u.name) % unaccent(q))
    ) combined
    ORDER BY (unaccent(name) ILIKE unaccent(q) || '%') DESC,
             score DESC,
             length(name) ASC
    LIMIT LEAST(GREATEST(maxrows, 1), 50);
$$ LANGUAGE sql STABLE PARALLEL SAFE;

COMMENT ON FUNCTION postgisftw.search IS
    'Namenssuche ueber Verwaltungseinheiten, Gebaeude, Strassen, Landbedeckung sowie hochgeladene/registrierte Ebenen mit einer namensartigen Spalte.';

-- =============================================================== report ====
SELECT 'buildings3d' AS what, count(*)::text AS n FROM dwh.buildings3d
UNION ALL
SELECT 'avg height m', round(avg(height))::text FROM dwh.buildings3d
UNION ALL
SELECT 'search rows', count(*)::text FROM dwh.search_index;
