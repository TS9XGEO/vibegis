-- ===========================================================================
-- 3D building volumes for pg2b3dm — batched, verbose, no SFCGAL.
--
--   docker compose exec -T postgis psql -U gis -d gis -f - < postgis/initdb/06-buildings3d.sql
--   (or simply: bash bin/build-3d.sh)
--
-- Why not ST_Extrude: SFCGAL insists on strict ring orientation and rejects a
-- large share of real OSM footprints ("interior ring oriented in the same
-- direction as exterior ring"). Building the solid by hand avoids the whole
-- question: a floor, a roof translated up by the height, and one quad per
-- wall segment. Plain PostGIS, no validity negotiation, and faster.
-- ===========================================================================

\timing on
\set ON_ERROR_STOP on

-- ---- scope ---------------------------------------------------------------
\set centre_lon 11.5755
\set centre_lat 48.1374
\set radius_m   600
\set max_rows   400
\set batch_size 100

\echo ''
\echo '=========================================================='
\echo ' 3D BUILDINGS  —  step 1/5: extensions'
\echo '=========================================================='

CREATE EXTENSION IF NOT EXISTS hstore;

\echo ''
\echo ' step 2/5: manual extrusion function'
\echo '   floor + roof + one quad per wall segment -> MultiPolygonZ'

DROP FUNCTION IF EXISTS gis.extrude_safe(geometry, double precision);
DROP FUNCTION IF EXISTS gis.extrude_manual(geometry, double precision);

CREATE FUNCTION gis.extrude_manual(g geometry, h double precision)
RETURNS geometry
LANGUAGE sql IMMUTABLE AS $fn$
    WITH polys AS (
        SELECT (d).path[1] AS pid, (d).geom AS p
        FROM (SELECT ST_Dump(g) AS d) x
    ),
    rings AS (
        SELECT pid, 0 AS rid, ST_ExteriorRing(p) AS r FROM polys
        UNION ALL
        SELECT pid, n, ST_InteriorRingN(p, n)
        FROM polys, generate_series(1, ST_NumInteriorRings(p)) AS n
    ),
    pts AS (
        SELECT rings.pid, rings.rid, (dp).path[1] AS i, (dp).geom AS pt
        FROM rings, LATERAL (SELECT ST_DumpPoints(r) AS dp) d
    ),
    walls AS (
        -- ST_MakePoint yields SRID 0; the caps below carry the input SRID.
        -- ST_Collect refuses to mix them, so stamp the SRID on here.
        SELECT ST_SetSRID(
                   ST_MakePolygon(ST_MakeLine(ARRAY[
                       ST_MakePoint(ST_X(a.pt), ST_Y(a.pt), 0),
                       ST_MakePoint(ST_X(b.pt), ST_Y(b.pt), 0),
                       ST_MakePoint(ST_X(b.pt), ST_Y(b.pt), h),
                       ST_MakePoint(ST_X(a.pt), ST_Y(a.pt), h),
                       ST_MakePoint(ST_X(a.pt), ST_Y(a.pt), 0)
                   ])),
                   ST_SRID(g)
               ) AS geom
        FROM pts a
        JOIN pts b ON b.pid = a.pid AND b.rid = a.rid AND b.i = a.i + 1
        WHERE ST_X(a.pt) <> ST_X(b.pt) OR ST_Y(a.pt) <> ST_Y(b.pt)
    ),
    caps AS (
        SELECT ST_Force3D(p) AS geom FROM polys              -- floor at z = 0
        UNION ALL
        SELECT ST_Translate(ST_Force3D(p), 0, 0, h) FROM polys   -- roof
    )
    SELECT ST_SetSRID(ST_Collect(geom), ST_SRID(g))
    FROM (SELECT geom FROM walls UNION ALL SELECT geom FROM caps) s;
$fn$;

\echo ''
\echo ' step 3/5: selecting and sanitising footprints'

DROP TABLE IF EXISTS gis._prep3d;

CREATE UNLOGGED TABLE gis._prep3d AS
SELECT
    row_number() OVER (ORDER BY ST_Area(t.geom) DESC) AS rn,
    t.gid, t.kind, t.name,
    ST_MakeValid(ST_RemoveRepeatedPoints(ST_Transform(t.geom, 25832), 0.05)) AS geom_m,
    LEAST(GREATEST(COALESCE(
        NULLIF(regexp_replace(t.tags -> 'height', '[^0-9.]', '', 'g'), '')::double precision,
        NULLIF(regexp_replace(t.tags -> 'building:levels', '[^0-9.]', '', 'g'), '')::double precision * 3.2,
        CASE t.kind
            WHEN 'sakral'         THEN 22
            WHEN 'oeffentlich'    THEN 14
            WHEN 'gewerbe'        THEN 11
            WHEN 'industrie'      THEN 10
            WHEN 'grossbau'       THEN 12
            WHEN 'landwirtschaft' THEN 7
            ELSE 9
        END
    ), 2.0), 180.0) AS height
FROM (
    SELECT b.gid, b.kind, b.name, b.geom,
           CASE WHEN r.other_tags IS NULL OR r.other_tags = ''
                THEN ''::hstore ELSE r.other_tags::hstore END AS tags
    FROM gis.buildings b
    LEFT JOIN raw.osm_buildings r USING (gid)
    WHERE b.kind <> 'nebengebaeude'
      AND ST_DWithin(
            b.geom::geography,
            ST_SetSRID(ST_MakePoint(:centre_lon, :centre_lat), 4326)::geography,
            :radius_m
          )
    ORDER BY ST_Area(b.geom) DESC
    LIMIT :max_rows
) t;

CREATE INDEX ON gis._prep3d (rn);

\echo ''
\echo '   footprints selected:'
SELECT count(*) AS footprints,
       count(*) FILTER (WHERE ST_IsValid(geom_m)) AS valid,
       round(avg(height)) AS avg_h,
       round(max(height)) AS max_h
FROM gis._prep3d;

\echo ''
\echo ' step 4/5: extruding  —  per-batch progress below'
\echo '   guide: several thousand per second; 400 is nearly instant,'
\echo '          1.7M would be a few minutes'
\echo ''

DROP TABLE IF EXISTS gis.buildings3d;

CREATE TABLE gis.buildings3d (
    gid     bigint PRIMARY KEY,
    kind    text,
    name    text,
    height  double precision,
    geom3d  geometry(MultiPolygonZ, 4326)
);

-- psql does NOT interpolate :variables inside dollar-quoted blocks, so the
-- batch size is handed to the DO block through a session setting instead.
SELECT set_config('webgis.batch_size', :'batch_size', false);

DO $do$
DECLARE
    total    bigint;
    batch    int := current_setting('webgis.batch_size')::int;
    done     bigint := 0;
    inserted bigint := 0;
    lo       bigint := 1;
    t0       timestamptz := clock_timestamp();
    elapsed  double precision;
    rate     double precision;
    eta_s    double precision;
    n        bigint;
BEGIN
    SELECT count(*) INTO total FROM gis._prep3d;
    RAISE NOTICE '--> % Bauwerke zu extrudieren, Batchgroesse %', total, batch;

    WHILE lo <= total LOOP
        BEGIN
            INSERT INTO gis.buildings3d (gid, kind, name, height, geom3d)
            SELECT p.gid, p.kind, p.name, p.height,
                   ST_Transform(
                       ST_CollectionExtract(gis.extrude_manual(p.geom_m, p.height), 3),
                       4326
                   )::geometry(MultiPolygonZ, 4326)
            FROM gis._prep3d p
            WHERE p.rn >= lo AND p.rn < lo + batch
              AND p.geom_m IS NOT NULL
              AND ST_IsValid(p.geom_m)
              AND GeometryType(p.geom_m) IN ('POLYGON', 'MULTIPOLYGON');

            GET DIAGNOSTICS n = ROW_COUNT;
            inserted := inserted + n;
        EXCEPTION WHEN OTHERS THEN
            RAISE NOTICE '    ! Batch ab % uebersprungen: %', lo, SQLERRM;
        END;

        done    := LEAST(lo + batch - 1, total);
        elapsed := EXTRACT(EPOCH FROM (clock_timestamp() - t0));
        rate    := CASE WHEN elapsed > 0 THEN done / elapsed ELSE 0 END;
        eta_s   := CASE WHEN rate > 0 THEN (total - done) / rate ELSE 0 END;

        RAISE NOTICE '    % / %  (% %%)  |  % Volumen  |  %/s  |  % s vergangen, ca. % s verbleibend',
            done, total, round(100.0 * done / total), inserted,
            round(rate::numeric, 1),
            round(elapsed::numeric, 1), round(eta_s::numeric, 1);

        lo := lo + batch;
    END LOOP;

    RAISE NOTICE '--> fertig: % Volumen in % s (% ohne Ergebnis)',
        inserted,
        round(EXTRACT(EPOCH FROM (clock_timestamp() - t0))::numeric, 1),
        total - inserted;
END
$do$;

\echo ''
\echo ' step 5/5: indexing'

CREATE INDEX buildings3d_geom_idx ON gis.buildings3d USING GIST (geom3d);
ANALYZE gis.buildings3d;
DROP TABLE gis._prep3d;

\echo ''
\echo '=========================================================='
\echo ' RESULT'
\echo '=========================================================='

SELECT kind, count(*) AS n, round(avg(height)) AS avg_h
FROM gis.buildings3d GROUP BY kind ORDER BY n DESC;

SELECT count(*) AS volumes,
       count(*) FILTER (WHERE ST_NDims(geom3d) = 3) AS with_z,
       pg_size_pretty(pg_total_relation_size('gis.buildings3d')) AS size
FROM gis.buildings3d;

\echo ''
\echo ' Naechster Schritt (ca. 10-60 s):'
\echo '   docker compose --profile tiles3d run --rm pg2b3dm'
\echo ''
