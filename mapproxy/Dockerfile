# MapProxy built from PyPI rather than a third-party image, so the version is
# explicit and reproducible.
FROM python:3.12-slim

ENV PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1

RUN apt-get update && apt-get install -y --no-install-recommends \
        libgeos-dev libgdal-dev gdal-bin proj-bin libproj-dev \
        build-essential \
    && rm -rf /var/lib/apt/lists/*

RUN pip install --upgrade pip && \
    pip install MapProxy Pillow PyYAML pyproj gunicorn requests

WORKDIR /mapproxy
RUN mkdir -p /mapproxy/cache_data

# The config lives at /mapproxy/config (a directory mount, not a single-file
# one) so upload-api can regenerate mapproxy.yaml there too — it needs write
# access to add a layer/cache/source for every layer it publishes, which a
# single-file :ro bind mount from this service alone couldn't allow. This
# file just wires MapProxy into WSGI; reloader=True re-reads on the config's
# mtime, so a regenerated file takes effect without restarting this service.
RUN printf '%s\n' \
    "from mapproxy.wsgiapp import make_wsgi_app" \
    "application = make_wsgi_app('/mapproxy/config/mapproxy.yaml', reloader=True)" \
    > /mapproxy/wsgi.py

EXPOSE 8080

CMD ["gunicorn", "-w", "4", "-b", "0.0.0.0:8080", \
     "--timeout", "120", "--access-logfile", "-", "wsgi:application"]
