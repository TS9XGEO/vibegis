# Same base as dagster/Dockerfile: GDAL/OGR + geopandas, so uploaded vector
# files (shapefile zips, GeoPackage, GeoJSON, KML, GML) read the same way
# the nightly ETL asset (dagster/defs/__init__.py: raw_vectors) reads them.
ARG GDAL_IMAGE=ghcr.io/osgeo/gdal:ubuntu-small-latest
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

WORKDIR /app
COPY app.py ai_agent.py /app/

EXPOSE 8000
CMD ["uvicorn", "app:app", "--host", "0.0.0.0", "--port", "8000"]
