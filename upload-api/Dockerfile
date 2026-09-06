# Same base as dagster/Dockerfile: GDAL/OGR + geopandas, so uploaded vector
# files (shapefile zips, GeoPackage, GeoJSON, KML, GML) read the same way
# the nightly ETL asset (dagster/defs/__init__.py: raw_vectors) reads them.
# Pinned fallback, matching .env.example. `ubuntu-small-latest` used to be
# the default here and it tracks a nightly build — two rebuilds a day apart
# could ship different GDAL versions into production with nothing recording
# which one. Bump deliberately.
ARG GDAL_IMAGE=ghcr.io/osgeo/gdal:ubuntu-small-3.13.0
FROM ${GDAL_IMAGE}

ENV DEBIAN_FRONTEND=noninteractive \
    PIP_NO_CACHE_DIR=1 \
    PYTHONUNBUFFERED=1

RUN apt-get update && apt-get install -y --no-install-recommends \
        python3-pip python3-venv python3-dev libpq-dev build-essential \
    && rm -rf /var/lib/apt/lists/*

RUN python3 -m venv /opt/venv
ENV PATH="/opt/venv/bin:${PATH}"

COPY requirements.txt /tmp/requirements.txt
RUN pip install --upgrade pip && pip install -r /tmp/requirements.txt

# py3dtiles gets its own venv, deliberately not /opt/venv: it pins
# numpy<2.4 and pulls numba, which is a real resolver conflict against the
# geopandas/shapely stack /upload depends on. app.py only ever shells out to
# /opt/py3dtiles/bin/py3dtiles by absolute path — the same "call a CLI that's
# already in the image" idiom run_gdal() uses — so a py3dtiles upgrade cannot
# touch the app's own dependency graph. Pinned for the reason the root
# CLAUDE.md records about unpinned dagster: a routine rebuild silently
# pulling a new major that changes CLI flags would break uploads, not the build.
RUN python3 -m venv /opt/py3dtiles \
    && /opt/py3dtiles/bin/pip install --upgrade pip \
    && /opt/py3dtiles/bin/pip install "py3dtiles[las]==12.1.1" "laspy[lazrs]"

WORKDIR /app
COPY app.py ai_agent.py qgis_catalog.py /app/

# ---------------------------------------------------------------- non-root
# Nothing here needs root, and this container
# handles uploaded files from the network.
# UID/GID default to 1001 because that is what this repo's bind mounts are
# owned by on the development host; an install whose host user differs sets
# APP_UID/APP_GID in .env, which docker-compose.yml passes both as build args
# and as the runtime `user:` (so an existing image does not need rebuilding).
# -o on both: some base images already ship a user at this id, and a clash
# should not fail the build.
ARG APP_UID=1001
ARG APP_GID=1001
RUN groupadd -o -g ${APP_GID} app \
 && useradd -o -u ${APP_UID} -g ${APP_GID} -m -d /home/app -s /usr/sbin/nologin app
ENV HOME=/home/app
USER app

EXPOSE 8000
CMD ["uvicorn", "app:app", "--host", "0.0.0.0", "--port", "8000"]
