FROM python:3.12-slim
WORKDIR /app
RUN pip install --no-cache-dir docker==7.1.0 prometheus_client==0.21.0
COPY exporter.py .
# ---------------------------------------------------------------- non-root
# Nothing here needs root, and this container
# talks to the Docker API (through the socket proxy).
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

CMD ["python", "exporter.py"]
