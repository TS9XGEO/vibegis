# frontend-app

React 18 + TypeScript + Resium (Cesium) + Mantine, served by Vite. No tests and no
linter — `npm run typecheck` is the whole safety net.

## Modules

```
main.tsx        42   Mantine provider, teal/amber theme, <Notifications/>
App.tsx        237   composes Scene + Sideband + LayerPanel + AiAgentPanel + DataViewBand,
                     gated on auth. The top-level flex row is map, sideband, layer panel,
                     agent — the last two are docked columns, not overlays
Scene.tsx      484   the globe: imagery, terrain, 3D tiles. A clustered point layer renders
                     through PointCluster.tsx and a point cloud through PointCloudLayer.tsx,
                     each instead of an ImageryLayer
wms.ts        1039   ★ zustand store `useApp` — GetCapabilities parsing, every endpoint URL,
                     layer state and draw order. Also stashes `camera` and `scene` for the
                     components that live outside the Resium <Viewer> tree
legend.ts      500   ★ legend types, resolveLegend(), buildSld(), reachableClasses()
selection.ts   260   ★ zustand `useSelection` — open data-view tabs, select scope, the
                     layer-tagged selection map, and localStorage-persisted bookmarks

LayerPanel.tsx      1202  layer tree, opacity, dnd-kit reordering, terrain/3D toggles, point
                          clustering, per-polygon outline width, RGB composite builder,
                          BatchGroupRow for a zip upload's bands
Legend.tsx           218  per-class swatches + colour picker; prunes classes the filter,
                          the data or the current extent rule out (only while `active`)
ClassifyLayer.tsx    554  single / categorized / graduated classification editor, incl. the
                          break-method picker (equal / percentile / Jenks / manual)
UploadLayer.tsx      521  file upload, register-a-table, multi-layer picker, raster + raster-zip
uploadState.ts        31  zustand `useUpload` — the upload modal's open/pending-file state,
                          plus ACCEPT (here, not in UploadLayer, so App.tsx's drop zone can
                          read it without pinning that module into the entry chunk)
PointCluster.tsx     132  one point layer as real Cesium entities with EntityCluster grouping
PointCloudLayer.tsx  132  one LiDAR cloud as a Cesium3DTileset; size + colour mode from
                          LayerState.pointCloud

AttributeTable.tsx   507  one data-view tab: paging, Kartenansicht/Alle Zeilen, sort-by-
                          selection, column rename, CSV export
DataViewBand.tsx     293  the tab strip + resizable band hosting every open table plus the
                          pinned Dashboard tab; owns maximize/restore and lazy-loads the
                          dashboard panel
SelectionDashboard.tsx 1452  the Dashboard tab's content. Two modes: a real selection, or —
                          with nothing selected — a per-visible-layer "everything selected"
                          overview (Kartenansicht = live bbox fetch, Alle Zeilen = SQL
                          aggregates, so a millions-of-rows layer is never pulled into the
                          browser). Aggregates, group-by breakdown with an unfoldable
                          "Andere" bucket, swappable bar/pie/donut chart, drill-through,
                          CSV export, bookmarks. Clicking a row or chart segment sets the
                          separate amber preview highlight; only drill-through touches the
                          real selection
dashboardTools.tsx   117  SelectToolsRow + useDashboardLayerNames, split out of the above so
                          DataViewBand can import them without the charts — read its header
                          before merging them back
AttributeFilter.tsx  324 / filter.ts 112   OGC Filter XML + CQL builder; "Auswählen" selects
                          matches instead of restyling
sqlFilter.ts 195 / SqlFilterModal.tsx 194  raw-SQL filter mode

columns.ts 158  features.ts 144  spatial.ts 376  shared column / feature-fetch / geometry
                          helpers. columns.ts: fetchColumns, fetchDistinctValues,
                          fetchColumnStats, fetchColumnGroupBy, fetchTableCount,
                          fetchColumnBreaks. features.ts: paged / bbox / filtered / all-rows
                          fetches, all under SELECTION_FETCH_CAP. spatial.ts: turf predicates
                          for the select tools, plus visibleGroundBbox() — see the rules below
freshLayerRetry.ts    70  retryFreshLayer() + FRESH_LAYER_WAIT_MESSAGE. pg_featureserv's
                          per-collection catalog lookup never refreshes on its own (only
                          GET /collections forces it), so a freshly published table can 404
                          indefinitely; this warms the catalog on every 404 before retrying
mapHighlight.ts 88 / SelectionHighlight.tsx 39 / DashboardHighlight.tsx 38 / dashboardHighlight.ts 29
                          per-geometry-type entity drawing, parameterized by colour so the
                          real selection (blue) and the dashboard's preview (amber) share it

MapTools.tsx   530  the floating toolbox: Cesium click handlers for search-flyTo, identify,
                     measure and select (point/circle/polygon)
ToolboxControls.tsx 296  its contents, plus useSelectCandidates() — the one layer-candidate
                     derivation every select entry point shares
tools.ts       168  zustand `useTools` — search hits, identify, measure modes

auth.ts        105  zustand `useAuth`; isPrivileged()/hasFullAccess() are the feature gates
LoginScreen.tsx 115  AuthSplash.tsx 81  ConnectedGlobe.tsx 30   login + welcome/goodbye
UserAdmin.tsx  178  AccessAdmin.tsx 305   admin-only: accounts (role × tier), groups + grants

Sideband.tsx   870  the docked icon band. A generic RAIL array drives panels.ts booleans;
                     things that don't fit that shape get their own button (CompassButton,
                     EtlButton, AiAgentButton, the modals, the Auswahl-Dashboard toggle)
ExtraMenu.tsx  353  7x5 grid of relocated controls, freely draggable, localStorage-persisted
Analytics.tsx  171  Superset dashboards in a modal — list from its REST API, dashboard as a
                     `?standalone=3` iframe, same origin, same session. warmUpSession()
                     walks Superset's login redirect once on a 401; don't remove it
Pages.tsx      348  CMS content browser (/cms, configdb.pages); the Handbook is just one page
Geoprocessing.tsx 232  buffer/dissolve/intersect/join modal (Pro), publishes a new layer
QgisProcessing.tsx 213 / qgisParams.tsx 150 / qgis.ts 208 / PrintExportButton.tsx 101
                     QGIS algorithms (Premium) and one-click PDF export. qgisParams.tsx is
                     the ONE generic parameter renderer for both catalogs — see the rules
aiAgent.ts 124 / AiAgentPanel.tsx 179 / AiSettings.tsx 142   the chat panel; applies returned
                     map-control actions into useApp, never touches Cesium directly. The
                     BYO API key is write-only end to end

i18n/          798  react-i18next. translations.ts is the single source of every UI string,
                     DE+EN side by side, namespaced. index.ts reshapes it at startup and
                     exposes setLocale(). Still hardcoded German: LayerPanel's row-level
                     controls, DataViewBand, MapTools/ToolboxControls, Legend, PointCluster,
                     SqlFilterModal, strays in App/UserAdmin
tour/          419  guided tour (react-joyride), two tours, role-aware. Each step's `before`
                     hook drives the real UI through the existing stores, never the DOM
tips/          141  one-shot "did you know" notifications, localStorage-tracked per tip,
                     suppressed entirely while a tour runs

uiScale.ts      89  global UI size (Klein/Standard/Groß) — see the rules on real CSS lengths
panels.ts       28  zustand `usePanels` — open/closed for the floating boxes
useDraggable.ts 51  useResizeHeight.ts 72  useOnceOpened.ts 23   drag / resize / lazy-modal gate
StatusHud.tsx 65  ZoomBar.tsx 76  CompassButton.tsx 80   HUD stack and compass
colorScheme.ts 105  the shared teal+amber palette, app and login screen alike
webgl.ts        64  WebGL2/1 capability probe — feeds Viewer's contextOptions
csv.ts          26  downloadCsv()
```

★ = start here. `wms.ts`, `legend.ts` and `selection.ts` hold the contracts everything
else consumes.

## Rules that are load-bearing

- **`@mantine/charts` needs its own `styles.css` import, separate from
  `@mantine/core`'s.** `main.tsx` imports `@mantine/core/styles.css` and
  `@mantine/notifications/styles.css` but not `@mantine/charts/styles.css`
  — easy to miss since nothing errors, and `BarChart` even looks fine
  without it (its size comes from inline `h`/`w` props). `PieChart`/
  `DonutChart` size themselves entirely through a `--chart-size` CSS
  variable that only exists in that missing stylesheet, so without it they
  silently render at zero size — "the chart just isn't there" the moment
  `SelectionDashboard.tsx`'s chart-type switch leaves 'bar'. Fixed by adding
  the import; if a future `@mantine/charts` component looks blank while
  everything else about it is correct, check this first.
- **"What's on screen" is `spatial.ts`'s `visibleGroundBbox()`, never
  `camera.computeViewRectangle()`.** This is a 3D globe, and Cesium's method
  answers with a lon/lat rectangle that has to contain everything the camera
  could see — at any real tilt it reaches to the horizon, and zoomed out it
  simply returns the whole world. Every "Kartenansicht" mode that used it was
  therefore showing essentially every row while claiming to be scoped to the
  view (AttributeTable.tsx, SelectionDashboard.tsx's `LayerOverviewCard`), and
  the symptom reads as a broken filter rather than a wrong extent.
  `visibleGroundBbox()` ray-casts a 7x7 grid of screen points against the
  ellipsoid instead and, for each sample that missed while a neighbour hit,
  bisects between them to land on the globe's silhouette — without that limb
  step a globe that doesn't fill the screen has only its centre sample hitting
  and the box collapses to a point (which is what made Legend.tsx's class list
  go empty and flicker in a zoomed-out view). Two cases deliberately widen to
  the whole world, because a `bbox=` query cannot express either: a view
  spanning 180°+ of longitude, and one crossing the antimeridian — **a bbox
  with west > east is not an option**, since pg_featureserv does not implement
  that part of OGC API Features and returns the complement instead (verified
  live: `170,-20,-170,20` gives the same rows as `-170,-20,170,20`).
  `bboxWorldFraction()` / `WIDE_VIEW_FRACTION` exist so those callers can say
  "this view covers nearly everything" out loud rather than leaving a
  full-looking result unexplained. **`PointCluster.tsx` is the one deliberate
  holdout** — it over-fetches on purpose so cluster markers are already loaded
  just beyond the screen edge instead of popping in; a tighter box would be a
  regression there, not a fix.
- **Draw order is array order.** The store keeps `layers[]` top-first; `Scene` renders
  it reversed because Cesium draws the last-added imagery layer on top. Reordering a
  row reorders the array, and React does the rest. Never reach for `raiseToTop`.
- **A layer renders one of three ways.** `LayerState.pointCloud` is checked
  first: non-null means the layer is a LiDAR point cloud and draws through
  `PointCloudLayer.tsx`'s `Cesium3DTileset` — a scene primitive, not imagery, so
  draw order and opacity-as-alpha work differently and none of the WMS machinery
  applies. Three traps found the hard way there, all of the silently-does-nothing
  kind:
  - **resium does not expose `pointCloudShading` as a prop** — it is in neither
    `cesiumProps` nor `cesiumReadonlyProps` in its `Cesium3DTileset.d.ts`, so
    passing it is dropped with no error. Set it imperatively in `onReady`.
  - **A style `pointSize` and `pointCloudShading.attenuation` are mutually
    exclusive**: Cesium's `PointCloudStylingStageVS.glsl` is
    `#ifdef HAS_POINT_CLOUD_POINT_SIZE_STYLE … #elif defined(HAS_POINT_CLOUD_ATTENUATION)`,
    so a style `pointSize` wins outright and a size slider layered on top of
    enabled attenuation would appear dead. Pick one; this app uses the style.
  - **Only `${COLOR}`, `${POSITION}`, `${POSITION_ABSOLUTE}` and `${NORMAL}` are
    built in.** `${classification}` works only because upload-api asked py3dtiles
    to carry that field, and only reports `hasClassification` when it verified
    the field would really arrive — see upload-api/CLAUDE.md.
  - **Every colour in a point-cloud style must be `rgba()`, never `color('#hex')`
    and never a bare `vec4(...)`.** A point cloud's style is compiled to GLSL, so
    anything the expression parser reads as a *string literal* throws "Error
    generating style shader: String literals are not supported" — which crashes
    the viewer the moment the layer is switched on. That rules out
    `color('#hex')` and, far less obviously, **any multi-character swizzle**:
    `${COLOR}.rgb` and `${COLOR}.xyz` are parsed as strings and fail identically,
    while `.r`/`.g`/`.b` individually are fine. Of the forms that do compile,
    only `rgba()` sets `shaderState.translucent`, which is what actually enables
    alpha blending — a bare `vec4()` puts alpha in the shader but leaves the
    render state opaque, so the opacity slider would move and change nothing.
    All of this was established by generating the shader for each candidate form
    against the installed Cesium; do the same before changing these expressions.
  Otherwise a layer defaults to `WmsLayer` — MapServer bakes its `CLASS`/`STYLE` into a
  server-rendered PNG tile, and Cesium never sees individual coordinates.
  Turning clustering on for a point layer (`LayerPanel.tsx`'s "Punkte
  gruppieren" toggle, point layers only) swaps that one layer to
  `PointCluster.tsx`'s `ClusteredPointLayer` instead: real Cesium entities in
  a `CustomDataSource`, refetched from `/features` on `camera.changed` and
  capped the same way `SelectionHighlight`'s bbox fetches already are
  (`features.ts`'s `SELECTION_FETCH_CAP`), with Cesium's own `EntityCluster`
  grouping overlapping ones. This only exists because MapServer has no
  server-side point aggregation (no `CLUSTER` object in any mapfile) — the
  WMS path stays every other layer's default, and clustering is strictly
  opt-in per point layer, never a change to the working path.
- **The camera's tilt floor (`Scene.tsx`'s `MIN_TILT_DEG`) is conditional, and
  a point cloud releases it automatically.** The limit keeps a 2.5D map of
  draped imagery from being dragged into a near-horizontal smear; that argument
  does not hold for a point cloud, which is real 3D geometry and can only be
  read from the side. The store's `tiltLimited` is what both the manual switch
  (LayerPanel's 3D section, phrased as "Freier Blickwinkel" so *on* is the more
  capable state — it writes the inverse) and the automation drive. The
  automation fires on the **transition** in "is any point cloud visible", never
  on the derived value itself: driving it directly would silently revert the
  manual switch on the next render instead of leaving it usable in between.
  When the limit is switched back on while the camera is already tilted past
  it, the clamp has no valid frame to restore, so it tilts back up to exactly
  the limit rather than recording the out-of-bounds camera as "last good".
- **`terrainProvider` goes on `<Globe>`, not `<Viewer>`.** Resium applies Viewer's only
  once at construction; Globe's has a working setter (`Scene.tsx:168`).
- **Never construct the Viewer without `contextOptions` from `webgl.ts`.** Cesium asks
  for a WebGL2 context by default and *throws* rather than falling back: it tests
  `typeof WebGL2RenderingContext !== "undefined"`, which is true in every current
  browser, then dies if `getContext("webgl2")` returns null. Firefox returns null
  whenever WebGL2 is off or the driver is blocklisted (`AllowWebgl2:false restricts
  context creation on this system`), so the globe silently failed to construct there
  while Chrome was fine. `webgl.ts` probes for real and sets `requestWebgl1` only when
  needed. Cesium's changelog claims an automatic fallback — it only covers browsers
  that don't define the constructor at all, which is not this case.
  On WebGL1, billboards and labels need `ANGLE_instanced_arrays`, and voxels are
  unavailable — neither is used here.
- **UI that needs the camera must render inside `<Scene>`** to use `useCesium()`.
  `LayerPanel` sits outside and reaches the camera through the store, which `Scene`
  stashes it in (`App.tsx`).
- **Never gate an existing control on a signal that can come back empty.** A layer
  uploaded from a file and one registered from an existing table are the same thing:
  both get a block in `uploads.map`, so both should offer delete, attribute table,
  filter and classification. `isManaged()` unions three signals and subtracts none —
  the `GROUP "uploads"` that capabilities carry (primary, travels with the layer),
  membership in upload-api's `/layers`, and the `upload_`/`dbtable_`/`raster_` name
  prefix as a floor. Deleting needs only the layer name, so it must keep working when upload-api
  is unreachable. Gating it on `/layers` alone once made a working delete button
  vanish silently. When `/layers` *is* down, the panel says so
  (`layersServiceDown`) instead of quietly rendering fewer buttons — a control that
  disappears without explanation is worse than one that errors when pressed. That flag
  also trips when `/layers` answers 200 with an *empty* list while capabilities show
  layers in the uploads group: the mismatch proves a fault, and it is exactly how a
  stale bind mount presents.
- **A layer's source table arrives in capabilities.** upload-api writes
  `"ows_keywordlist" "source:<schema>.<table>,geomtype:<kind>"` into every block it
  generates, MapServer publishes it as `<KeywordList>`, and `flattenLeaves()` lifts it
  into `LayerState.source` / `.geomType`. So the attribute table resolves its
  collection with no second request and keeps working when upload-api is down. Filter
  and classification cannot — they need `/distinct-values`, `/column-stats` and
  `/layer-config`, which only upload-api serves. A raster layer's keywordlist has no
  `source:` at all (`geomtype:raster,bands:<n>` instead) by design — there's no
  `schema.table` behind it — which is what makes `.source` stay `null` for it and is
  the entire reason attribute table/filter/classify/geoprocess correctly never offer
  themselves for a raster layer, with no separate exclusion check anywhere. `bands:`
  is what both RGB composite pickers (the header's `RasterCompositeButton` and
  `BatchGroupRow`'s inline per-band dropdown) filter on — only a single-band raster
  layer can unambiguously be one channel of a new composite, so `LayerState.bands
  !== 1` layers (including an existing composite) never appear as a channel choice.
  A band published from `/upload-raster-zip` additionally carries `batch:`/
  `batch_title:`, lifted into `LayerState.batch`/`.batchTitle` — every band from one
  zip shares the same `batch`, which is how `LayerPanel.tsx` groups them into one
  collapsible `BatchGroupRow` instead of flat top-level rows. This is a frontend-only
  grouping, unrelated to `GROUP "uploads"` membership above: MapServer's own `GROUP`
  is a flat opaque string with no hierarchy (confirmed by direct testing), so it
  cannot express "these bands nest under the uploads group" itself.
- **`loadDynamicLayerInfo()` must not synthesize a collection id from absent
  fields.** `/layers`' response has `schema: null, table: null` for a raster entry;
  building `` `${l.schema}.${l.table}` `` unconditionally would produce the literal
  truthy string `"null.null"`, and since `load()` spreads `dynamicInfo.collections`
  *after* the correct (empty) signal from capabilities, that string would win and
  make `collectionFor()` report a fake collection for a raster layer — exactly the
  "signal that can come back garbage" class of bug the bullet above already warns
  about for a signal that comes back *empty*. Only set the entry when both `schema`
  and `table` are present.
- **A polygon layer's outline width is server-side style, not session state.**
  `LayerPanel.tsx`'s `OutlineWidthSlider` sits right under the opacity slider and
  looks like its twin, but the two are nothing alike underneath: opacity is
  ephemeral client state (`LayerState.opacity`), while outline width PATCHes
  `/layer-config`, rewrites the mapfile and purges that layer's tiles. That is why
  it commits on `onChangeEnd` and only tracks locally during the drag — committing
  per pixel of travel would rebuild the mapfile dozens of times in one gesture.
  It is offered only for `geomType === 'polygon'` layers that `isManaged()`
  accepts, since a hand-authored layer's block is not upload-api's to rewrite.
- **A user classification is compiled into real `CLASS` blocks in `uploads.map`**,
  not sent as a per-request `SLD_BODY` — that used to be the only way it could reach
  the map (the mapfile held only the single default `CLASS`), but a per-request style
  is exactly what MapProxy cannot cache, since it pins one fixed upstream request per
  layer. upload-api's `apply_layer_style()` rewrites the layer's block on every save
  (`PATCH /layer-config`) and purges that layer's cached tiles; `Scene.tsx` deliberately
  does **not** treat `classification` as a reason to build an SLD any more —
  re-adding it to `departsFromMapfile` would silently make every classified layer
  uncacheable again. `styleVersion` (bumped on the same write) rides along as a cache
  buster on the tile URL, since a restyle changes no other request parameter.
  An attribute filter is still genuinely per-user and ephemeral, so it's the one thing
  left that forces the SLD/uncached path — see the next bullet. The two renderers
  (mapfile `CLASS`/`STYLE` in `upload-api/app.py`'s `classified_style()`, and the SLD in
  `legend.ts`'s `symbolizerFor()`) must stay visually identical, or applying a filter
  visibly restyles the layer.
- **An attribute filter on a classified layer goes into the SLD, not the `FILTER`
  parameter** — MapServer rejects the two together, so `filterFor()` splices the filter
  into every Rule as `And(classItem = <class>, <filter>)`. `reachableClasses()` narrows
  the rules first: under AND a class dies if any condition contradicts it; under OR a
  class survives if it matches any, decidable only when every condition is an `eq` on
  the class column. Getting this wrong is expensive rather than merely untidy — two
  values over a 45-class legend emitted 45 rules and ~33KB of SLD per tile, now 2 rules
  and 1.2KB. Pruning must never drop a class that could still draw. **There is no test
  covering this** — an earlier version of this note claimed there was; the repo has no
  test files at all. The two cases to check by hand after touching it are a filter on a
  column other than the class column, and a non-`eq` operator.
  `reachableClasses()` is also reused directly by `Legend.tsx` to hide a filtered-out
  class from the legend list itself, not just from the SLD sent to the map.
- **The layer list comes from GetCapabilities**, never a hardcoded list. Add a `LAYER`
  to the mapfile and it appears on reload. The one exception is point clouds, which
  have no MapServer layer at all and so can never be in capabilities: `load()`
  concatenates them from `/layers` as a **disjoint second source** — never joined
  or reconciled, since a point cloud is never in capabilities and a WMS layer is
  never in `configdb.point_clouds`. That disjointness is what keeps the existing
  degradation contract intact: with `/layers` down, point clouds vanish and every
  WMS layer still works. It also forced a fix to `layersServiceDown`, which counts
  `managedMapfile` rather than `managed` — a point cloud is in the latter but can
  never be in capabilities, so counting it would let one published cloud satisfy
  the stale-bind-mount check and mask the very fault it exists to catch. Per-layer extras live in module-level maps
  in `wms.ts`: `FEATURE_COLLECTIONS` (WMS layer → OGC API collection), `MANAGED_GROUP`.
  Which layers are cached is *not* one of these hardcoded maps any more — every
  upload-api-managed layer gets a cache automatically (`renderUrlFor()` derives it from
  `isManaged`-style name/group checks; `HAND_AUTHORED_CACHED_LAYERS` is only an escape
  hatch for a future hand-authored layer outside that group).
- **Selection is layer-tagged, not id-keyed.** `selection.ts`'s `selected` map is keyed
  by `` `${layer}:${featureId}` ``, not the bare feature id — two different layers can
  (and do) reuse the same id scheme (e.g. both have a `gid`), so a selection spanning
  several layers (see MapTools.tsx's "alle sichtbaren Layer" scope) would silently
  collide entries from different layers if it were keyed by id alone. Anything reading
  `selected` needs the entry's `.layer` alongside its `.feature`, not just the feature.
- **Ephemeral, session-only UI state lives in its own tiny zustand store, and is never
  persisted.** Drag position (`useDraggable.ts`), a box's open/closed state
  (`panels.ts`), a resizable panel's height (`useResizeHeight.ts`), a pending upload
  (`uploadState.ts`) — all reset to a fixed default on reload or a new session, on
  purpose, the same way `useSelection`'s selection and open tabs do. Don't reach for
  `localStorage` for this class of state; the intent is that reloading the page always
  hands back a clean, predictable layout. The two deliberate exceptions are the
  language toggle (`i18n/index.ts`) and the UI size (`uiScale.ts`) — both are standing
  preferences about the person using the app, not layout state about this session.
- **The UI size setting scales real CSS lengths — never a container `zoom` or
  `transform`.** `uiScale.ts` drives two things: `main.tsx` rebuilds the Mantine theme
  with `scale: 1 | 1.25 | 1.5` (Mantine emits every size as
  `calc(Xrem * var(--mantine-scale))`, so one number moves all of its fonts, paddings,
  control heights and radii at once, portals included), and `index.html` has one rule —
  `svg.tabler-icon, svg[data-ui-icon] { scale: var(--ui-scale) }` — for the icons, whose
  size is a px prop no theme can reach. The CSS `scale` property rather than `transform`
  so it composes with the transforms some icons already carry instead of overwriting
  them; a 16px icon at 1.5 still fits its 28px button, so nothing has to be re-laid-out.
  This app's own hardcoded pixel chrome does not follow either mechanism automatically —
  where it should, write it with Mantine's `rem()` (Sideband.tsx's rail and
  CompassButton.tsx are the ones that matter) so it rides on `--mantine-scale` too.
  **A `zoom` or a `transform: scale()` on a container is the obvious one-line version of
  this, and both are wrong here** — both were tried and reverted. They re-lay-out the
  boxes correctly but leave `getBoundingClientRect()` and hit-testing in a different
  coordinate space from the px values components write back, so anything that measures
  itself lands wrong: `zoom` put every clickable element somewhere other than where it
  was painted, and under `transform` Mantine's SegmentedControl indicator (its
  `FloatingIndicator` takes `targetRect.left - parentRect.left` and writes it straight
  back as a px transform) sat beside its own segment. dnd-kit's layer reordering and
  Cesium's click-to-pick measure the same way and go the same way.
- **One shared accent palette, including the login screen.** `main.tsx`'s
  `primaryColor: 'teal'` plus `colorScheme.ts`'s `accentEdge()` / `panelBorder()` and
  its `auth*()` helpers all draw from the same teal/amber pair now. The login and
  welcome/goodbye screens used to have their own separate cyan/violet identity,
  deliberately kept apart from the rest of the app — that's no longer the design;
  don't reintroduce a second palette there.
- **The Cesium logo watermark is hidden on purpose**, via a plain
  `.cesium-credit-logoContainer { display: none; }` rule in `index.html`. This app uses
  no Cesium ion-hosted assets (self-hosted imagery/terrain throughout), which is the
  one case Cesium's terms actually require keeping it on screen — the data-source
  credit text next to it (OSM/terrain attribution) is left alone, since that's a
  different license's requirement, not Cesium's.
- **The QGIS parameter renderer must stay catalog-agnostic.** `qgisParams.tsx` is
  the single `<ParamField>` for both the curated and the advanced (introspected)
  QGIS catalogs, because upload-api normalizes both into one `QgisParam` shape
  before they leave the backend. If a parameter needs different handling, give it
  a different `kind` server-side — do not branch on `curated` here.
- **A layer-valued QGIS parameter is sent as `{layer: <name>}`, never as
  schema/table.** upload-api resolves it through `visible_layers_for()`, so a
  second input layer is subject to the same per-layer ACL the layer panel is.
  Sending schema/table (the way `Geoprocessing.tsx` does for `/geoprocess`) would
  bypass that.
- UI strings are German. Match that when adding any.

## Requests

Vite proxies `/mapserver`, `/tiles`, `/features`, `/qgis`, `/terrain`, `/3dtiles` to
the `gateway` container (`vite.config.ts`), so the browser sees a single origin — the
same shape as production. HMR websocket is told to use `VITE_HMR_PORT` (8080), because
the app is reached through nginx, not Vite's own port.

## Commands

```bash
docker compose exec frontend npm run typecheck
docker compose exec frontend npm run build          # → dist/
docker compose exec frontend npm install            # after changing package.json
```

**`npm install` inside the running container, not a rebuild.** `node_modules` is a
named volume (`frontend-node-modules`), not part of the image — Docker only
populates a named volume from the image on its *first* creation, so a container
recreated from a freshly built image still mounts the old volume underneath,
silently hiding whatever the image's own `npm install` just produced. `docker
compose build --no-cache frontend` therefore looks like it worked (image builds
clean, packages resolve) while the running container's `node_modules` never
changes — `npm run typecheck` then fails on the "new" package as if it were never
added. Installing directly in the running container writes into that same volume,
which is what actually takes effect.

Dependencies are ranges, not pins. On a peer-dependency conflict:
`docker compose exec frontend npm install --legacy-peer-deps`.
