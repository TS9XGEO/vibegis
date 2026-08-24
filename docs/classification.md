# Klassifizierung — die drei Ebenen

Eine Klassifizierung kann an drei Stellen entstehen. Welche du wählst, hängt
davon ab, ob die Regel **Daten**, **Darstellung** oder **Interaktion** ist.

| Ebene | Wo | Wofür |
|---|---|---|
| PostGIS | SQL, abgeleitete Spalte | Regeln, die auf Werten beruhen: Größe, Dichte, Distanz, Kombination mehrerer Tags |
| MapServer | `CLASS` im Mapfile | Wie eine Klasse aussieht: Farbe, Breite, Symbol, ab welchem Maßstab |
| Frontend | Layer-Panel | Was der Nutzer ein- und ausschaltet |

Faustregel: **berechnen in SQL, färben im Mapfile.** Ein `CLASS` mit einer
komplizierten `EXPRESSION` ist fast immer ein Hinweis darauf, dass die Regel in
die Datenbank gehört — dort ist sie indizierbar und wird einmal statt bei jeder
Kachelanfrage ausgewertet.

---

## 1. Neue Spalte in PostGIS

Beispiel: Gebäude nach Nutzung **und** Grundfläche klassifizieren.

```sql
ALTER TABLE gis.buildings ADD COLUMN IF NOT EXISTS kind text;
ALTER TABLE gis.buildings ADD COLUMN IF NOT EXISTS area_m2 double precision;

UPDATE gis.buildings SET area_m2 = ST_Area(geom::geography);

UPDATE gis.buildings SET kind =
  CASE
    WHEN building IN ('church','cathedral','chapel','mosque','synagogue') THEN 'sakral'
    WHEN building IN ('industrial','warehouse','factory')                 THEN 'industrie'
    WHEN building IN ('retail','commercial','office')                     THEN 'gewerbe'
    WHEN building IN ('school','university','hospital','public','civic')  THEN 'oeffentlich'
    WHEN area_m2 > 5000                                                   THEN 'grossbau'
    ELSE 'wohnen'
  END;

CREATE INDEX IF NOT EXISTS buildings_kind_idx ON gis.buildings (kind);
ANALYZE gis.buildings;

SELECT kind, count(*), round(avg(area_m2)) AS avg_m2
FROM gis.buildings GROUP BY kind ORDER BY 2 DESC;
```

Weitere nützliche Muster:

```sql
-- Quantile (gleich große Klassen) statt fester Schwellen
SELECT gid, ntile(5) OVER (ORDER BY area_m2) AS quintil FROM gis.buildings;

-- Distanz zu etwas anderem
ALTER TABLE gis.buildings ADD COLUMN dist_road double precision;
UPDATE gis.buildings b SET dist_road = (
  SELECT min(ST_Distance(b.geom::geography, r.geom::geography))
  FROM gis.roads r WHERE r.cls <= 3
    AND ST_DWithin(b.geom::geography, r.geom::geography, 2000)
);

-- Dichte je Verwaltungseinheit (Choropleth-Grundlage)
CREATE TABLE gis.adm2_density AS
SELECT a.gid, a.shapename, count(b.gid) AS n,
       count(b.gid) / NULLIF(ST_Area(a.geom::geography) / 1e6, 0) AS per_km2
FROM gis.adm2_simple a
LEFT JOIN gis.buildings b ON ST_Intersects(a.geom, b.geom)
GROUP BY a.gid, a.shapename, a.geom;
```

---

## 2. CLASS im Mapfile

`CLASSITEM` nennt die Spalte, `EXPRESSION` den Wert. Die erste passende Klasse
gewinnt — Reihenfolge ist also relevant.

```
LAYER
  NAME "buildings"
  CLASSITEM "kind"
  ...
  CLASS
    NAME       "Sakralbau"          # <- Text in der Legende
    EXPRESSION "sakral"             # exakter Zeichenkettenvergleich
    STYLE  COLOR 150 120 180  OUTLINECOLOR 190 165 215  WIDTH 0.5  END
  END
  CLASS
    NAME       "Wohnen"
    EXPRESSION "wohnen"
    MAXSCALEDENOM 40000             # nur nah dran zeichnen
    STYLE  COLOR 122 118 126  END
  END
  CLASS                              # ohne EXPRESSION = alles Übrige
    NAME  "Sonstige"
    STYLE COLOR 90 90 95 END
  END
END
```

Drei Arten von `EXPRESSION`:

| Form | Beispiel | Bedeutung |
|---|---|---|
| Zeichenkette | `EXPRESSION "wohnen"` | `kind` ist exakt `wohnen` |
| Regulärer Ausdruck | `EXPRESSION /^wohn/` | `kind` beginnt mit `wohn` |
| Logisch | `EXPRESSION ([area_m2] > 5000 AND "[kind]" = "gewerbe")` | beliebige Attribute, `CLASSITEM` entfällt |

Bei der logischen Form stehen Zahlen in `[eckigen Klammern]`, Zeichenketten in
`"[eckigen Klammern in Anführungszeichen]"`. Das ist die häufigste Fehlerquelle.

Abgestufte Farben (Choropleth) über numerische Bereiche:

```
CLASSITEM "per_km2"
CLASS  EXPRESSION ([per_km2] < 50)                        STYLE COLOR 237 248 251 END END
CLASS  EXPRESSION ([per_km2] >= 50  AND [per_km2] < 200)  STYLE COLOR 178 226 226 END END
CLASS  EXPRESSION ([per_km2] >= 200 AND [per_km2] < 800)  STYLE COLOR 102 194 164 END END
CLASS  EXPRESSION ([per_km2] >= 800)                      STYLE COLOR 35 139 69  END END
```

Nach jeder Mapfile-Änderung:

```bash
docker compose stop -t 1 mapserver && docker compose up -d mapserver
```

---

## 3. Legende im Frontend

Ist bereits eingebaut: das Listen-Symbol in jeder Layer-Zeile klappt die
Legende auf. Sie kommt direkt von MapServer:

```
/mapserver?service=WMS&version=1.3.0&request=GetLegendGraphic&layer=<name>&format=image/png
```

Das heißt: **jede neue `CLASS` erscheint automatisch in der Legende**, sobald
sie ein `NAME`-Attribut hat. Klassen ohne `NAME` werden nicht aufgeführt — der
häufigste Grund für eine unvollständige Legende.

Aussehen lässt sich im Mapfile steuern:

```
LEGEND
  KEYSIZE  18 12
  KEYSPACING 5 5
  LABEL
    TYPE TRUETYPE
    FONT "sans"
    SIZE 9
    COLOR 230 235 240
  END
END
```

Der `LEGEND`-Block gehört auf oberste Mapfile-Ebene, nicht in einen `LAYER`.
