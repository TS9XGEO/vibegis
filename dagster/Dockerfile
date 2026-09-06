# Pinned fallback, matching .env.example. `ubuntu-small-latest` used to be
# the default here and it tracks a nightly build — two rebuilds a day apart
# could ship different GDAL versions into production with nothing recording
# which one. Bump deliberately.
ARG GDAL_IMAGE=ghcr.io/osgeo/gdal:ubuntu-small-3.13.0
FROM ${GDAL_IMAGE}

ENV DEBIAN_FRONTEND=noninteractive \
    PIP_NO_CACHE_DIR=1 \
    DAGSTER_HOME=/opt/dagster/home \
    PYTHONUNBUFFERED=1

RUN apt-get update && apt-get install -y --no-install-recommends \
        python3-pip python3-venv python3-dev libpq-dev build-essential \
    && rm -rf /var/lib/apt/lists/*

RUN python3 -m venv /opt/venv
ENV PATH="/opt/venv/bin:${PATH}"

COPY requirements.txt /tmp/requirements.txt
RUN pip install --upgrade pip && pip install -r /tmp/requirements.txt

RUN mkdir -p /opt/dagster/home /opt/dagster/app
WORKDIR /opt/dagster/app

# ---------------------------------------------------------------- non-root
# Nothing here needs root, and this container
# runs ETL code against the warehouse.
# UID/GID default to 1001 because that is what this repo's bind mounts are
# owned by on the development host; an install whose host user differs sets
# APP_UID/APP_GID in .env, which docker-compose.yml passes both as build args
# and as the runtime `user:` (so an existing image does not need rebuilding).
# -o on both: some base images already ship a user at this id, and a clash
# should not fail the build.
ARG APP_UID=1001
ARG APP_GID=1001
RUN groupadd -o -g ${APP_GID} app \
 && useradd -o -u ${APP_UID} -g ${APP_GID} -m -d /home/app -s /usr/sbin/nologin app \
 && chown -R ${APP_UID}:${APP_GID} /opt/dagster
ENV HOME=/home/app
USER app

EXPOSE 3000
CMD ["dagster", "dev", "-h", "0.0.0.0", "-p", "3000", "-w", "workspace.yaml"]
