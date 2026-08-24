/**
 * Client-side mirror of the CLASS/STYLE blocks in the MapServer mapfiles
 * (mapserver/mapfiles/webgis.map, osm-layers.map). There is no API that
 * exposes per-class geometry type and color to a WMS client, so this list is
 * kept in sync by hand — the same convention FEATURE_COLLECTIONS and
 * CACHED_LAYERS already use in wms.ts. Update it whenever a CLASS is added,
 * removed, or recolored in the mapfiles.
 */
import { buildConditionsXml, type FilterCondition, type FilterLogic } from './filter'

export type GeometryKind = 'polygon' | 'line' | 'point'

export type Rgb = [number, number, number]

/** An exact value, a numeric [min,max) range, or null (matches every feature — a single unconditional CLASS). */
export type ClassMatch = string | { min: number; max: number } | null

export interface LegendClass {
  name: string
  match: ClassMatch
  color: Rgb
  outlineColor?: Rgb
  /** Line layers only: the wider casing stroke drawn under the main color. */
  casingColor?: Rgb
  fillOpacity?: number
}

export interface LegendLayer {
  geometry: GeometryKind
  /** Mapfile CLASSITEM for this layer, or null when classes have no EXPRESSION (match all). */
  classItem: string | null
  classes: LegendClass[]
}

// ------------------------------------------------------- user classification
//
// What upload-api's /layer-config stores/returns for a layer's
// "classification" key. Three modes, matching what makes sense per column
// type: a numeric column can be split into ranges (graduated) as well as by
// exact value (categorized); a text column only makes sense categorized;
// either can just be flattened to one color (single) with no column at all.

export interface ClassDef {
  value: string
  label?: string
  color: string
}

export interface GraduatedBreak {
  min: number
  max: number
  label?: string
  color: string
}

export interface SingleSymbol {
  mode: 'single'
  color: string
}

export interface CategorizedClassification {
  mode: 'categorized'
  column: string
  classes: ClassDef[]
}

export interface GraduatedClassification {
  mode: 'graduated'
  column: string
  breaks: GraduatedBreak[]
}

export type Classification = SingleSymbol | CategorizedClassification | GraduatedClassification

export const LEGENDS: Record<string, LegendLayer> = {
  poi: {
    geometry: 'point',
    classItem: null,
    classes: [{ name: 'POI', match: null, color: [220, 60, 40], outlineColor: [255, 255, 255] }],
  },

  adm2_overview: {
    geometry: 'polygon',
    classItem: null,
    classes: [{ name: 'ADM2', match: null, color: [70, 105, 145], outlineColor: [150, 190, 235], fillOpacity: 0.25 }],
  },

  adm2_detail: {
    geometry: 'polygon',
    classItem: null,
    classes: [{ name: 'ADM2', match: null, color: [70, 105, 145], outlineColor: [170, 205, 245], fillOpacity: 0.25 }],
  },

  osm_landcover: {
    geometry: 'polygon',
    classItem: 'kind',
    classes: [
      { name: 'Wasser', match: 'water', color: [52, 96, 148], outlineColor: [76, 126, 180] },
      { name: 'Feuchtgebiet', match: 'wetland', color: [58, 116, 116] },
      { name: 'Wald', match: 'forest', color: [38, 82, 48] },
      { name: 'Gebuesch / Heide', match: 'scrub', color: [62, 100, 58] },
      { name: 'Gruenland', match: 'grassland', color: [78, 116, 62] },
      { name: 'Park / Schutzgebiet', match: 'park', color: [50, 104, 60] },
      { name: 'Ackerland', match: 'farmland', color: [108, 116, 58] },
      { name: 'Dauerkultur (Wein / Obst)', match: 'permanent_crop', color: [128, 132, 54] },
      { name: 'Kleingaerten', match: 'allotments', color: [92, 124, 68] },
      { name: 'Sportflaeche', match: 'sport', color: [66, 118, 88] },
      { name: 'Friedhof', match: 'cemetery', color: [70, 100, 78] },
      { name: 'Siedlungsflaeche', match: 'urban_fabric', color: [150, 74, 68], outlineColor: [172, 96, 88] },
      { name: 'Handel / Dienstleistung', match: 'commercial', color: [172, 96, 58] },
      { name: 'Industrie', match: 'industrial', color: [118, 74, 148] },
      { name: 'Abbau / Deponie', match: 'extraction', color: [132, 92, 140] },
      { name: 'Baustelle', match: 'construction', color: [140, 118, 78] },
      { name: 'Militaer', match: 'military', color: [122, 84, 84] },
      { name: 'Verkehrsflaeche', match: 'transport', color: [96, 92, 104] },
      { name: 'Gletscher', match: 'glacier', color: [186, 202, 216] },
      { name: 'Fels / Geroell', match: 'bare', color: [118, 120, 126] },
    ],
  },

  osm_roads: {
    geometry: 'line',
    classItem: 'cls',
    classes: [
      { name: 'Autobahn', match: '1', color: [240, 150, 72], casingColor: [168, 82, 40] },
      { name: 'Schnellstrasse', match: '2', color: [224, 132, 70], casingColor: [150, 74, 44] },
      { name: 'Bundesstrasse', match: '3', color: [208, 178, 92], casingColor: [132, 108, 52] },
      { name: 'Landstrasse', match: '4', color: [186, 184, 168], casingColor: [96, 96, 88] },
      { name: 'Kreisstrasse', match: '5', color: [164, 162, 152], casingColor: [88, 88, 84] },
      { name: 'Wohnstrasse', match: '6', color: [142, 142, 138], casingColor: [78, 78, 76] },
      { name: 'Wirtschaftsweg', match: '7', color: [112, 110, 104] },
    ],
  },

  osm_buildings: {
    geometry: 'polygon',
    classItem: 'kind',
    classes: [
      { name: 'Sakralbau', match: 'sakral', color: [146, 116, 176], outlineColor: [186, 158, 212] },
      { name: 'Industrie', match: 'industrie', color: [120, 82, 148], outlineColor: [152, 112, 180] },
      { name: 'Gewerbe', match: 'gewerbe', color: [176, 104, 62], outlineColor: [206, 138, 92] },
      { name: 'Oeffentlich', match: 'oeffentlich', color: [74, 118, 168], outlineColor: [110, 152, 200] },
      { name: 'Landwirtschaft', match: 'landwirtschaft', color: [128, 122, 74], outlineColor: [158, 152, 104] },
      { name: 'Grossbau', match: 'grossbau', color: [150, 96, 92], outlineColor: [184, 128, 122] },
      { name: 'Nebengebaeude', match: 'nebengebaeude', color: [104, 100, 104] },
      { name: 'Wohngebaeude', match: 'wohnen', color: [138, 96, 92], outlineColor: [170, 126, 120] },
    ],
  },
}

/**
 * The legend actually in effect for a layer: a user-defined classification
 * (see upload-api's /layer-config) takes priority when one's set, otherwise
 * the hand-authored LEGENDS entry above. A classification needs a geometry
 * kind to know what shape/symbolizer to draw — for a layer with no LEGENDS
 * entry (uploads, registered tables) that has to come from upload-api's
 * /layers (its mapfile TYPE), since we have no other way to know it.
 */
export function resolveLegend(
  layerName: string,
  classification: Classification | undefined,
  geometryType: string | null | undefined,
): LegendLayer | undefined {
  if (classification) {
    const geometry = (geometryType?.toLowerCase() as GeometryKind | undefined) ?? LEGENDS[layerName]?.geometry
    if (!geometry) return undefined

    if (classification.mode === 'single') {
      return {
        geometry,
        classItem: null,
        classes: [{ name: 'Alle', match: null, color: hexToRgb(classification.color) }],
      }
    }
    if (classification.mode === 'categorized') {
      return {
        geometry,
        classItem: classification.column,
        classes: classification.classes.map((c) => ({
          name: c.label?.trim() || c.value,
          match: c.value,
          color: hexToRgb(c.color),
        })),
      }
    }
    // graduated
    return {
      geometry,
      classItem: classification.column,
      classes: classification.breaks.map((b) => ({
        name: b.label?.trim() || `${b.min} – ${b.max}`,
        match: { min: b.min, max: b.max },
        color: hexToRgb(b.color),
      })),
    }
  }
  return LEGENDS[layerName]
}

// --------------------------------------------------------------- colors

export function rgbToHex([r, g, b]: Rgb): string {
  return '#' + [r, g, b].map((c) => c.toString(16).padStart(2, '0')).join('')
}

const HEX_RE = /^#[0-9a-fA-F]{6}$/

export function isValidHex(s: string): boolean {
  return HEX_RE.test(s)
}

export function hexToRgb(hex: string): Rgb {
  const n = parseInt(hex.slice(1), 16)
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
}

function colorOf(cls: LegendClass, override: string | undefined): string {
  if (override && isValidHex(override)) return override
  return rgbToHex(cls.color)
}

// ----------------------------------------------------------------- SLD
//
// MapServer draws GetMap requests entirely from mapfile CLASS/STYLE blocks
// unless the request carries an SLD_BODY, in which case the SLD replaces
// styling for every class in the layer — so once any class is overridden we
// must emit a full ruleset, not just the changed class, or the untouched
// classes would stop rendering.

/**
 * `extra` is the attribute filter's inner condition XML (see filter.ts's
 * buildConditionsXml) — spliced in here rather than sent as WMS's own FILTER
 * parameter because MapServer rejects FILTER combined with SLD/SLD_BODY.
 */
function filterFor(classItem: string | null, match: ClassMatch, extra: string | null): string {
  let classCond: string | null = null
  if (classItem !== null && match !== null) {
    classCond = typeof match === 'string'
      ? `<ogc:PropertyIsEqualTo><ogc:PropertyName>${classItem}</ogc:PropertyName><ogc:Literal>${match}</ogc:Literal></ogc:PropertyIsEqualTo>`
      : `<ogc:PropertyIsBetween><ogc:PropertyName>${classItem}</ogc:PropertyName>` +
        `<ogc:LowerBoundary><ogc:Literal>${match.min}</ogc:Literal></ogc:LowerBoundary>` +
        `<ogc:UpperBoundary><ogc:Literal>${match.max}</ogc:Literal></ogc:UpperBoundary></ogc:PropertyIsBetween>`
  }

  const parts = [classCond, extra].filter((p): p is string => p !== null)
  if (parts.length === 0) return ''
  const body = parts.length === 1 ? parts[0] : `<ogc:And>${parts.join('')}</ogc:And>`
  return `<ogc:Filter>${body}</ogc:Filter>`
}

function symbolizerFor(
  geometry: GeometryKind,
  cls: LegendClass,
  color: string,
): string {
  const opacity = cls.fillOpacity ?? 1

  if (geometry === 'polygon') {
    const outline = cls.outlineColor ? rgbToHex(cls.outlineColor) : color
    return (
      `<PolygonSymbolizer>` +
      `<Fill><CssParameter name="fill">${color}</CssParameter><CssParameter name="fill-opacity">${opacity}</CssParameter></Fill>` +
      `<Stroke><CssParameter name="stroke">${outline}</CssParameter><CssParameter name="stroke-width">0.5</CssParameter></Stroke>` +
      `</PolygonSymbolizer>`
    )
  }

  if (geometry === 'line') {
    const casing = cls.casingColor
      ? `<LineSymbolizer><Stroke><CssParameter name="stroke">${rgbToHex(cls.casingColor)}</CssParameter>` +
        `<CssParameter name="stroke-width">4</CssParameter><CssParameter name="stroke-linecap">round</CssParameter></Stroke></LineSymbolizer>`
      : ''
    return (
      casing +
      `<LineSymbolizer><Stroke><CssParameter name="stroke">${color}</CssParameter>` +
      `<CssParameter name="stroke-width">2.2</CssParameter><CssParameter name="stroke-linecap">round</CssParameter></Stroke></LineSymbolizer>`
    )
  }

  // point
  const outline = cls.outlineColor ? rgbToHex(cls.outlineColor) : '#ffffff'
  return (
    `<PointSymbolizer><Graphic><Mark><WellKnownName>circle</WellKnownName>` +
    `<Fill><CssParameter name="fill">${color}</CssParameter></Fill>` +
    `<Stroke><CssParameter name="stroke">${outline}</CssParameter><CssParameter name="stroke-width">2</CssParameter></Stroke>` +
    `</Mark><Size>10</Size></Graphic></PointSymbolizer>`
  )
}

/**
 * Builds an SLD 1.0.0 document that reproduces `layer`, applying `overrides`
 * (className -> hex) over the mapfile defaults. `extraConditionsXml` (see
 * filter.ts's buildConditionsXml) gets AND-ed into every rule's own filter,
 * so an attribute filter still applies even when recoloring is also active —
 * MapServer doesn't allow sending both a FILTER param and an SLD_BODY.
 */
/**
 * True when `match` can never satisfy `conditions` — e.g. a class matching
 * kind='wohnen' can never be true alongside a filter requiring kind='gewerbe'
 * on the very same column. Only sound for AND-ed equality/range conditions:
 * one contradicting condition makes the whole (AND-ed) filter false for that
 * class regardless of the others, so the rule can be dropped outright. OR-ed
 * filters aren't pruned — a class could still satisfy some other branch of
 * the OR, so every rule has to stay in that case.
 */
/**
 * Which classes can still draw under an attribute filter, and whether narrowing
 * them made the filter itself redundant.
 *
 * AND is the easy direction: a class is unreachable as soon as *one* condition
 * contradicts it. OR needs the opposite test — a class survives if it satisfies
 * *any* condition — which classUnreachable() cannot express, so this used to
 * skip pruning entirely under OR and emit every class. Correct, but it meant a
 * two-value filter over a 45-class legend produced 45 rules, 43 of which could
 * never match.
 *
 * OR is only decidable here when every condition is an `eq` on the class column;
 * anything else (a different column, a range, a LIKE) could still match any
 * class, so every class is kept. Pruning must never drop a class that could draw.
 */
function reachableClasses(
  layer: LegendLayer,
  conditions: FilterCondition[],
  logic: FilterLogic,
): { classes: LegendClass[]; filterRedundant: boolean } {
  if (conditions.length === 0) return { classes: layer.classes, filterRedundant: false }

  if (logic === 'and') {
    return {
      classes: layer.classes.filter((cls) => !classUnreachable(layer.classItem, cls.match, conditions)),
      filterRedundant: false,
    }
  }

  const classItem = layer.classItem
  const decidable =
    classItem !== null && conditions.every((c) => c.column === classItem && c.op === 'eq')
  if (!decidable) return { classes: layer.classes, filterRedundant: false }

  const wanted = new Set(conditions.map((c) => c.value))
  const classes = layer.classes.filter((cls) => {
    const match = cls.match
    if (match === null) return true // catch-all class: can always draw
    if (typeof match === 'string') return wanted.has(match)
    return [...wanted].some((v) => Number(v) >= match.min && Number(v) < match.max)
  })
  // Every surviving class matches one of the wanted values, so `classItem = <class>`
  // already implies the OR — but only for string matches, where the equality is
  // exact. A range class is wider than the value that selected it, so the filter
  // still has to be carried.
  const allExact = classes.every((cls) => cls.match === null || typeof cls.match === 'string')
  return { classes, filterRedundant: allExact && classes.every((cls) => cls.match !== null) }
}

function classUnreachable(classItem: string | null, match: ClassMatch, conditions: FilterCondition[]): boolean {
  if (classItem === null || match === null) return false
  return conditions.some((c) => {
    if (c.column !== classItem || c.op !== 'eq') return false
    return typeof match === 'string'
      ? match !== c.value
      : Number(c.value) < match.min || Number(c.value) >= match.max
  })
}

/**
 * Builds an SLD 1.0.0 document that reproduces `layer`, applying `overrides`
 * (className -> hex) over the mapfile defaults. `extraConditions` (the
 * attribute filter's own conditions — see filter.ts) get AND/OR-ed into
 * every surviving rule's own filter, so the filter still applies even when
 * recoloring is also active — MapServer doesn't allow sending both a FILTER
 * param and an SLD_BODY. Classes that `extraConditions` provably rules out
 * are dropped rather than emitted-but-unreachable: a classification with
 * many classes (one Rule each) can otherwise produce an SLD_BODY north of
 * mod_fcgid's ~32KB per-environment-variable limit — a hard limit in the
 * MapServer image with no config knob, not something raisable like
 * nginx/Apache's own request-size settings.
 */
export function buildSld(
  layerName: string,
  layer: LegendLayer,
  overrides: Record<string, string>,
  extraConditions: FilterCondition[] | null = null,
  extraLogic: FilterLogic = 'and',
): string {
  const conditions = extraConditions ?? []
  const { classes: reachable, filterRedundant } = reachableClasses(layer, conditions, extraLogic)

  // Pruned to nothing means the filter genuinely cannot match anything. Emitting
  // no rules would be an empty, invalid FeatureTypeStyle, and re-emitting every
  // class (what this used to do) produces dozens of impossible rules and a huge
  // request for a layer that will draw nothing either way. One rule carrying the
  // filter is valid, matches nothing, and stays small.
  const classes = reachable.length > 0 ? reachable : layer.classes.slice(0, 1)

  // Once the classes have been narrowed to exactly those the filter selects, the
  // class predicate already encodes the filter and repeating it in every rule is
  // pure duplication — that is what turned a two-value filter over a 45-class
  // legend into ~33KB of SLD on every single tile request.
  const extraXml = filterRedundant || conditions.length === 0
    ? null
    : buildConditionsXml(conditions, extraLogic)
  const rules = classes
    .map((cls) => {
      const color = colorOf(cls, overrides[cls.name])
      return (
        `<Rule>` +
        filterFor(layer.classItem, cls.match, extraXml) +
        symbolizerFor(layer.geometry, cls, color) +
        `</Rule>`
      )
    })
    .join('')

  return (
    `<?xml version="1.0" encoding="UTF-8"?>` +
    `<StyledLayerDescriptor version="1.0.0" xmlns="http://www.opengis.net/sld" xmlns:ogc="http://www.opengis.net/ogc">` +
    `<NamedLayer><Name>${layerName}</Name><UserStyle><FeatureTypeStyle>${rules}</FeatureTypeStyle></UserStyle></NamedLayer>` +
    `</StyledLayerDescriptor>`
  )
}
