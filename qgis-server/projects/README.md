# QGIS Server projects

Drop `.qgs` / `.qgz` project files here. They are mounted read-only into the
container at `/io/data`.

Request a project by path:

```
http://localhost:8080/qgis?MAP=/io/data/demo.qgs&SERVICE=WMS&VERSION=1.3.0&REQUEST=GetCapabilities
```

## Workflow

1. Build the project in QGIS Desktop on Windows.
2. Point its layers at the PostGIS container: host `localhost`, port `5432`,
   database `gis` (the port is published to 127.0.0.1 by compose).
3. Project Properties → QGIS Server → tick **Service capabilities**, set title
   and the published layer list.
4. Save the `.qgz` into this folder. QGIS Server picks it up on the next
   request — no restart needed.

## Gotcha

Inside the container the database host is `postgis`, not `localhost`. Either
save the project with `host=postgis`, or add a PostgreSQL service definition
file so the connection name resolves differently per environment.
