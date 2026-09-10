-- Runs once, on first creation of the data volume.
CREATE EXTENSION IF NOT EXISTS postgis;
CREATE EXTENSION IF NOT EXISTS postgis_raster;
CREATE EXTENSION IF NOT EXISTS postgis_topology;
-- fuzzystrmatch was only ever here as a prerequisite of
-- postgis_tiger_geocoder, which is no longer created (US Census address
-- geocoding, 34 tables in schema `tiger`, never used by this app — see
-- bin/migrate-drop-tiger.sql for the removal on an existing volume). Kept
-- because it is harmless and something may yet want levenshtein().
CREATE EXTENSION IF NOT EXISTS fuzzystrmatch;
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- Schemas: dwh = all geodata (uploaded, registered, ETL/geoprocess output),
-- configdb = app/layer config + CMS content, userdb = accounts/auth.
CREATE SCHEMA IF NOT EXISTS dwh;
CREATE SCHEMA IF NOT EXISTS configdb;
CREATE SCHEMA IF NOT EXISTS userdb;

-- Example published layer so MapServer has something to draw on day one.
CREATE TABLE IF NOT EXISTS dwh.poi (
    id     bigserial PRIMARY KEY,
    name   text NOT NULL,
    kind   text,
    geom   geometry(Point, 4326) NOT NULL
);
CREATE INDEX IF NOT EXISTS poi_geom_idx ON dwh.poi USING GIST (geom);

INSERT INTO dwh.poi (name, kind, geom) VALUES
    ('Brandenburger Tor', 'landmark', ST_SetSRID(ST_MakePoint(13.3777, 52.5163), 4326)),
    ('Zugspitze',         'summit',   ST_SetSRID(ST_MakePoint(10.9853, 47.4211), 4326)),
    ('Koelner Dom',       'landmark', ST_SetSRID(ST_MakePoint( 6.9583, 50.9413), 4326))
ON CONFLICT DO NOTHING;

-- users lives in userdb explicitly (upload-api's ensure_users_table() used to
-- rely on the connecting role's default search_path putting an app schema
-- first — undocumented outside this repo. Now explicit.)
CREATE TABLE IF NOT EXISTS userdb.users (
    id                 bigserial PRIMARY KEY,
    username           text UNIQUE NOT NULL,
    password_hash      text NOT NULL,
    role               text NOT NULL CHECK (role IN ('admin', 'editor', 'viewer')),
    created_at         timestamptz NOT NULL DEFAULT now(),
    subscription_tier  text NOT NULL DEFAULT 'free' CHECK (subscription_tier IN ('free', 'pro', 'premium')),
    email              text,
    ai_provider        text,
    ai_key_ciphertext  text,
    ai_key_last4       text,
    ai_key_updated_at  timestamptz
);

CREATE TABLE IF NOT EXISTS configdb.layer_config (
    layer_name text PRIMARY KEY,
    config     jsonb NOT NULL,
    updated_at timestamptz NOT NULL DEFAULT now()
);

-- "editing own data" — Pro can edit/delete layers they published themselves.
CREATE TABLE IF NOT EXISTS configdb.layer_owners (
    layer_name     text PRIMARY KEY,
    owner_user_id  bigint NOT NULL REFERENCES userdb.users(id) ON DELETE CASCADE,
    created_at     timestamptz NOT NULL DEFAULT now()
);

-- Per-user/group layer visibility grants — see visible_layers_for() in
-- upload-api/app.py.
CREATE TABLE IF NOT EXISTS configdb.groups (
    id   bigserial PRIMARY KEY,
    name text UNIQUE NOT NULL
);
CREATE TABLE IF NOT EXISTS configdb.group_members (
    group_id bigint NOT NULL REFERENCES configdb.groups(id) ON DELETE CASCADE,
    user_id  bigint NOT NULL REFERENCES userdb.users(id) ON DELETE CASCADE,
    PRIMARY KEY (group_id, user_id)
);
CREATE TABLE IF NOT EXISTS configdb.layer_grants (
    id             bigserial PRIMARY KEY,
    layer_name     text NOT NULL,
    principal_type text NOT NULL CHECK (principal_type IN ('user', 'group')),
    principal_id   bigint NOT NULL,
    created_at     timestamptz NOT NULL DEFAULT now(),
    UNIQUE (layer_name, principal_type, principal_id)
);

CREATE TABLE IF NOT EXISTS configdb.pages (
    slug       text PRIMARY KEY,
    title_de   text NOT NULL DEFAULT '',
    title_en   text NOT NULL DEFAULT '',
    body_de    text NOT NULL DEFAULT '',
    body_en    text NOT NULL DEFAULT '',
    -- hides the page from anyone but role == 'admin' — see app.py's /cms routes
    admin_only boolean NOT NULL DEFAULT false,
    updated_at timestamptz NOT NULL DEFAULT now(),
    updated_by text
);
INSERT INTO configdb.pages (slug) VALUES ('handbook') ON CONFLICT DO NOTHING;
INSERT INTO configdb.pages (slug, admin_only) VALUES ('architecture', true) ON CONFLICT DO NOTHING;
