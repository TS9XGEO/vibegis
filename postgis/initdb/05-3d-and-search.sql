-- 3D buildings for pg2b3dm, plus a search function for pg_featureserv.
--   docker compose exec -T postgis psql -U gis -d gis < postgis/initdb/05-3d-and-search.sql

CREATE EXTENSION IF NOT EXISTS postgis_sfcgal;   -- ST_Extrude
CREATE EXTENSION IF NOT EXISTS hstore;           -- read GDAL's other_tags
CREATE EXTENSION IF NOT EXISTS pg_trgm;          -- fuzzy name search
CREATE EXTENSION IF NOT EXISTS unaccent;

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

DROP TABLE IF EXISTS gis.buildings3d;

CREATE TABLE gis.buildings3d AS
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
    FROM gis.buildings b
    LEFT JOIN raw.osm_buildings r USING (gid)
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

ALTER TABLE gis.buildings3d ADD PRIMARY KEY (gid);
CREATE INDEX buildings3d_geom_idx ON gis.buildings3d USING GIST (geom3d);
ANALYZE gis.buildings3d;

-- ============================================================== search =====
--
-- One searchable index over everything with a name, exposed to the frontend
-- as a pg_featureserv function endpoint.

DROP MATERIALIZED VIEW IF EXISTS gis.search_index;

CREATE MATERIALIZED VIEW gis.search_index AS
SELECT row_number() OVER () AS sid, *
FROM (
    SELECT shapename AS name, 'Verwaltungseinheit' AS category,
           ST_PointOnSurface(geom) AS geom
    FROM gis.adm2_simple WHERE shapename IS NOT NULL
    UNION ALL
    SELECT name, 'Gebaeude', ST_PointOnSurface(geom)
    FROM gis.buildings WHERE name IS NOT NULL
    UNION ALL
    SELECT name, 'Strasse', ST_PointOnSurface(ST_CollectionExtract(geom, 2))
    FROM gis.roads WHERE name IS NOT NULL
    UNION ALL
    SELECT name, 'Landbedeckung', ST_PointOnSurface(geom)
    FROM gis.landcover WHERE name IS NOT NULL
) s;

CREATE INDEX search_name_trgm ON gis.search_index USING GIN (name gin_trgm_ops);
CREATE INDEX search_geom_idx  ON gis.search_index USING GIST (geom);
CREATE UNIQUE INDEX search_sid_idx ON gis.search_index (sid);
ANALYZE gis.search_index;

-- pg_featureserv publishes functions in the "postgisftw" schema.
CREATE SCHEMA IF NOT EXISTS postgisftw;

DROP FUNCTION IF EXISTS postgisftw.search(text, integer);

CREATE FUNCTION postgisftw.search(q text DEFAULT '', maxrows integer DEFAULT 15)
RETURNS TABLE (name text, category text, score real, geom geometry)
AS $$
    SELECT s.name,
           s.category,
           similarity(unaccent(s.name), unaccent(q)) AS score,
           s.geom
    FROM gis.search_index s
    WHERE q <> ''
      AND (unaccent(s.name) ILIKE '%' || unaccent(q) || '%'
           OR unaccent(s.name) % unaccent(q))
    ORDER BY (unaccent(s.name) ILIKE unaccent(q) || '%') DESC,
             similarity(unaccent(s.name), unaccent(q)) DESC,
             length(s.name) ASC
    LIMIT LEAST(GREATEST(maxrows, 1), 50);
$$ LANGUAGE sql STABLE PARALLEL SAFE;

COMMENT ON FUNCTION postgisftw.search IS
    'Namenssuche ueber Verwaltungseinheiten, Gebaeude, Strassen und Landbedeckung.';

-- =============================================================== report ====
SELECT 'buildings3d' AS what, count(*)::text AS n FROM gis.buildings3d
UNION ALL
SELECT 'avg height m', round(avg(height))::text FROM gis.buildings3d
UNION ALL
SELECT 'search rows', count(*)::text FROM gis.search_index;
