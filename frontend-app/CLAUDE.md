# frontend-app

React 18 + TypeScript + Resium (Cesium) + Mantine, served by Vite. No tests and no
linter — `npm run typecheck` is the whole safety net.

## Modules

```
main.tsx        25   Mantine provider, teal/amber theme, mounts <Notifications/>
App.tsx        223   composes Scene + Sideband + LayerPanel + DataViewBand; gates on auth
Scene.tsx      385   the globe: imagery layers, terrain, 3D tiles; a clustered point layer
                     renders through PointCluster.tsx instead of an ImageryLayer
wms.ts         782   ★ zustand store `useApp`, GetCapabilities parsing, all endpoint URLs
legend.ts      451   ★ legend types and `buildSld()` — SLD generation lives here
selection.ts   189   ★ zustand store `useSelection` — open data-view tabs, select scope,
                     layer-tagged selection, and localStorage-persisted named bookmarks
                     (full-selection snapshots, restore replaces `selected` outright)

LayerPanel.tsx 958  layer tree, opacity, dnd-kit reordering, terrain/3D toggles, point-layer
                     clustering toggle, RGB composite builder (`RasterCompositeButton`) for
                     combining published single-band raster layers via /raster-composite;
                     `BatchGroupRow` collapses one zip upload's bands into one named group
                     (LayerState.batch/.batchTitle) with an inline per-band Rot/Grün/Blau
                     picker (a `channel` prop on `LayerRow`) feeding the same endpoint
PointCluster.tsx 132  `ClusteredPointLayer` — renders one point layer as real Cesium
                     entities with EntityCluster grouping, fed from /features, when its
                     LayerState.clustered flag is on
ClassifyLayer.tsx 445  categorized + graduated classification editor
UploadLayer.tsx 406  file upload (incl. drag-and-drop from App.tsx), register a table,
                     the multi-layer picker, and a raster mode for GeoTIFFs or a zip of
                     single-band rasters (e.g. a Sentinel-2 product) — every band in a
                     zip publishes immediately as its own layer, no picker here; see
                     LayerPanel.tsx's RasterCompositeButton for combining them into RGB
uploadState.ts  25  zustand store `useUpload` — the upload modal's open/pending-file state
Legend.tsx     206  per-class swatches + color picker. Only shown while its layer is
                     visible (else "Layer ausgeblendet"); of what's left, a class is
                     dropped when the active filter rules it out (reachableClasses()),
                     when its value never occurs anywhere in the table
                     (fetchDistinctValues, exact/uncapped), or when it has no feature
                     within the current map extent (fetchFeaturesInBbox, capped —
                     legend.ts's classSatisfiedBy() runs the same value-in-set test for
                     both checks). The two data-driven checks only run while the legend
                     is open (`active` prop, set by LayerPanel.tsx's legendOpen) — this
                     component stays mounted inside its Collapse even when collapsed, so
                     `active` is what stops every layer's legend from polling the camera
                     forever in the background

AttributeTable.tsx 366  one data-view tab's content (`AttributeTablePanel`) — paging,
                        sort-by-selection, column rename
DataViewBand.tsx   231  the tab strip + resizable panel hosting every open AttributeTablePanel,
                     plus one pinned "Dashboard" tab for SelectionDashboard.tsx's docked
                     `SelectionDashboardPanel` (selection.ts's `dashboardTabOpen`/
                     `dashboardTabActive`, toggled from Sideband.tsx — not a `panels.ts`
                     boolean, since it needed a real slot in this tab system, not an
                     independent open/closed flag). The band itself now stays mounted
                     whenever either any layer tab OR the dashboard tab is open.
                     While the dashboard tab is focused, the individual layer tabs collapse
                     into a single "Datenansicht (N)" pill instead — showing every layer
                     tab alongside the full dashboard felt cluttered; clicking the pill
                     (`focusDataView()`) or opening/focusing any layer tab from
                     LayerPanel.tsx switches straight back. `SelectToolsRow` (exported from
                     SelectionDashboard.tsx — point/circle/polygon select + count + clear)
                     shows in the header next to the maximize button always, regardless of
                     which tab is focused — selecting features works the same from a plain
                     attribute-table tab as from the dashboard, so there was no reason to
                     gate it on `dashboardTabActive`. The header's X used to be "close all layer
                     tabs" only, hidden while the dashboard was focused since it had
                     nothing to do with the dashboard tab; it now calls both
                     `closeAllLayerTabs()` and `closeDashboardTab()` at once and is always
                     shown, since the band itself only renders when at least one of the
                     two is actually open. A
                     maximize/restore button (`useResizeHeight`'s `maximized`/
                     `toggleMaximize`, new on that hook) sits next to `SelectToolsRow`/the
                     close X — it
                     swaps the band's `flex` to a very high grow factor (`10000 1 0px`)
                     against the map viewport's own `flex: 1` in App.tsx, so the band
                     absorbs essentially all available height and the map shrinks to its
                     `minHeight: 0` floor, rather than computing an exact pixel value.
                     Dragging the resize handle exits maximized mode automatically.
AttributeFilter.tsx 284 / filter.ts 112   OGC Filter XML + CQL builder; "Auswählen" selects
                     matches instead of restyling the map
columns.ts 101  features.ts 129  spatial.ts 171   shared column/feature-fetch/geometry helpers.
                     Both columns.ts's fetchColumns() and features.ts's fetchOnePage()
                     (backing every exported fetch in that file — the attribute table,
                     the attribute filter's apply/select action, and the map's select
                     tools) route a 404 through freshLayerRetry.ts's retryFreshLayer()
                     — pg_featureserv discovers a brand-new PostGIS table on its own
                     schedule, unrelated to when the mapfile append makes a fresh
                     upload show up in the layer panel, and has no HTTP endpoint or
                     config knob to force it sooner (checked its API docs directly),
                     so backoff-and-retry (~2.5 min budget) on the client is the only
                     lever there is. Both fetchColumns() and fetchFeaturePage()/
                     fetchFeaturePageInBbox() take an optional `onRetry` callback, fired
                     on the first 404 so a caller can swap its plain loading spinner for
                     a reassuring notice instead of silently spinning for however long
                     the backoff takes (see AttributeTable.tsx/AttributeFilter.tsx/
                     ClassifyLayer.tsx). columns.ts also has fetchColumnGroupBy()/
                     fetchTableCount() (upload-api's `/column-groupby`/`/table-count`,
                     plus new sum/avg/count fields on fetchColumnStats()'s
                     `/column-stats`) and features.ts has fetchAllFeatures() (every row
                     in a layer, no bbox/filter scope, same SELECTION_FETCH_CAP as
                     every other bulk fetch here) — all three exist for
                     SelectionDashboard.tsx's "everything selected" overview, which has
                     no in-memory features to aggregate over client-side the way a real
                     selection does
freshLayerRetry.ts 44  retryFreshLayer() (see columns.ts/features.ts's entry above) plus
                     FRESH_LAYER_WAIT_MESSAGE — the "grab a coffee ☕😊" copy shown both
                     live (via `onRetry`) and as the final error if every retry still
                     404s, and isFreshLayerWait(), which callers use to render that case
                     as a yellow "still settling in" Alert instead of a red hard error
mapHighlight.ts 88   addHighlightEntities() — per-geometry-type Cesium entity drawing (a
                     crisp shape + a wider translucent glow, since Cesium has no built-in
                     entity glow/bloom), parameterized by color so SelectionHighlight.tsx
                     (the real selection, always SELECTION_COLOR) and
                     DashboardHighlight.tsx (SelectionDashboard.tsx's own, separate
                     "preview" highlight, DASHBOARD_HIGHLIGHT_COLOR — see
                     dashboardHighlight.ts) share the same drawing code instead of
                     duplicating it. Both are mounted in Scene.tsx, next to each other.
                     dashboardHighlight.ts (29 lines) is the tiny zustand store
                     (`useDashboardHighlight`) SelectionDashboard.tsx/DashboardHighlight.tsx
                     (38 lines) share — ephemeral, session-only, same category as panels.ts

MapTools.tsx   515  the floating toolbox panel: owns the actual Cesium click handlers for
                     search-flyTo, identify, measure, select (point/circle/polygon;
                     scoped to the active tab's layer or every visible layer, see
                     selection.ts) — its own JSX is now just the Paper/drag-handle
                     chrome around ToolboxControls.tsx
ToolboxControls.tsx 296  the search box + identify/measure/select buttons. Rendered
                     inside MapTools.tsx's floating panel — SelectionDashboard.tsx no
                     longer embeds this component itself, but its own `SelectToolsRow`
                     (see SelectionDashboard.tsx's entry below) re-implements just the
                     select-tool row against the same state, since it needs only three of
                     this file's buttons. Also exports `useSelectCandidates()`, the layer-
                     candidate derivation this file's own select buttons,
                     SelectionDashboard.tsx's `SelectToolsRow`, and MapTools.tsx's select
                     click handlers all need, kept in one place so none of them can drift
                     apart
tools.ts       168  `useTools` store: search hits, identify, measure modes

auth.ts         72  zustand store `useAuth` — session state, login/logout
LoginScreen.tsx 119  AuthSplash.tsx 88  ConnectedGlobe.tsx 30   login + welcome/goodbye splash
UserAdmin.tsx  166  admin-only account management (role + premium)

Sideband.tsx   388  the docked icon band: panel toggles, reset-to-north, ETL trigger +
                     progress ring, geoprocessing (admin-only), handbook, logout. Most
                     toggles are a generic `RAIL` array driving `panels.ts`'s open/closed
                     booleans, but a few things don't fit that simple shape and get their
                     own bespoke button below the RAIL loop instead — CompassButton (a
                     live action, not a toggle — see its own entry below), EtlButton (its
                     own polling state), Geoprocessing/Handbook (modal opens), and the
                     Auswahl-Dashboard toggle (selection.ts's `dashboardTabOpen`/
                     `toggleDashboardTab()`, since it's a tab-strip slot now, not a
                     `panels.ts` boolean) — kept in the RAIL's old visual position even
                     though it's no longer a RAIL entry
Geoprocessing.tsx 232  buffer/dissolve/intersect/join modal, admin-only, publishes
                     the result as a new layer via /geoprocess (mirrors UploadLayer.tsx)
Handbook.tsx    15  placeholder in-app manual, opened from Sideband
panels.ts       28  zustand store `usePanels` — open/closed state for the floating boxes
                     (`mapTools` | `hud` | `layerPanel`). The Auswahl-Dashboard used to be
                     a fourth entry here but is no longer a floating box at all — see
                     DataViewBand.tsx/SelectionDashboard.tsx
useDraggable.ts 51  useResizeHeight.ts 68   drag-to-move / drag-to-resize hooks. useResizeHeight
                     takes an `edge` ('top', the default, or 'bottom') for which side of the
                     panel the handle sits on and grows it — 'top' for a panel fixed at its
                     bottom edge (the attribute table, DataViewBand.tsx), 'bottom' for one
                     fixed at its top edge instead (nothing currently uses 'bottom' — kept
                     as an option since SelectionDashboard.tsx used it before going docked).
                     Also returns a `maximized`/`toggleMaximize` pair independent of the
                     drag-resized `height` — the hook only tracks the boolean; the caller
                     decides what CSS "maximized" means for its own layout (DataViewBand.tsx
                     is the one consumer so far)
StatusHud.tsx   65  ZoomBar.tsx 76   the bottom-left HUD stack (inside <Scene>, useCesium()).
                     CompassButton.tsx 64 used to live here too but is docked in
                     Sideband.tsx's icon band instead now — a sibling of <Scene>, not a
                     descendant, so it reads `camera` from wms.ts's useApp store the same
                     way LayerPanel.tsx does, rather than useCesium()
SelectionDashboard.tsx 1449  docked into DataViewBand.tsx's tab strip as a pinned
                     "Dashboard" tab, not a floating popup any more — its default export is
                     `SelectionDashboardPanel({ isActive })`, a plain content component
                     with `display: isActive ? 'flex' : 'none'` on its root (same
                     convention AttributeTable.tsx uses for its own tabs), so switching
                     away and back never loses a layer's `groupBy` choice or chart-type
                     pick. Sizing now comes entirely
                     from DataViewBand's own resizable band (up to 800px, shared with
                     every other tab) and its full column width — no more own
                     Transition/Paper/useDraggable/useResizeHeight. The old glowing
                     total-count block and the collapsed "Werkzeuge" section are gone,
                     replaced by `SelectToolsRow` (holding just the point/circle/polygon
                     select buttons, the "N ausgewählt" badge, and the clear button, on
                     the same useSelection()/useTools()/useSelectCandidates() state
                     ToolboxControls.tsx's buttons use) — exported from this file but
                     rendered in DataViewBand.tsx's own tab-strip header now (v10), not
                     inside this panel's body. This panel's own header keeps just a close
                     `ActionIcon` calling selection.ts's `closeDashboardTab()` — the same
                     action the tab strip's own small X on the "Dashboard" pill already
                     triggers (DataViewBand.tsx), just easier to find from inside the
                     panel itself once that pill is one among others in the strip.
                     Below that, a master-detail layout (v9) — `LayerNavRow` renders one
                     row per involved layer (color bar, title, count) in a fixed-width,
                     independently-scrollable left list; clicking one shows its full
                     breakdown in the detail pane on the right, read straight from
                     selection.ts's flat, layer-tagged `selected` map. Replaced a
                     responsive `SimpleGrid` of per-layer cards each collapsed/expanded by
                     clicking its own header — Thomas didn't like that with several layers
                     involved. `LayerSummary`/`LayerOverviewCard` lost their own `expanded`/
                     `Collapse` and gained an `isActive` prop instead (every layer's detail
                     component stays mounted, `display: none` when not the selected one,
                     same convention as the tabs elsewhere in this app) — so a layer's own
                     `groupBy`/`chartType` choice and already-fetched columns survive
                     switching to another layer in the list and back.
                     `SelectionDashboardPanel`'s own `selectedLayerName` state tracks which
                     row is active, auto-selecting the first one whenever the current
                     selection isn't in the list any more (including right after a mode
                     switch between a real selection and the "everything selected"
                     overview). Becoming the active layer lazily
                     fetches columns.ts's fetchColumns() (same call
                     AttributeFilter.tsx/ClassifyLayer.tsx/Geoprocessing.tsx already make)
                     to show numeric sum/avg/min/max and a categorical group-by
                     breakdown, capped to the top 8 values with the rest folded into one
                     clickable "Andere" bucket — its own individual (excluded-from-top-N)
                     values are kept as `hidden` on the bucket object rather than
                     discarded, so a `IconChevronRight` next to "Andere" can unfold them
                     back into the row list on demand (`BreakdownColumns`'s `andereOpen`
                     state) instead of only ever showing the summed total. Every row also
                     shows its share of the layer's total as a percentage next to its
                     count (`BreakdownColumns`'s own `pct()`, denominator = the sum of
                     every bucket's count, Andere included, so it needs nothing extra from
                     either caller). The sum/avg/min/max numbers render as
                     `AggregatesTable` — a CSS grid (one row per numeric column, one
                     rounded `StatBox` per stat, sharing four stat columns so every row's
                     boxes line up like a real table without a literal `<table>`) — each
                     number formatted through `fmt()`'s `Intl.NumberFormat('de-DE', ...)`
                     (thousand separators, max 2 decimals) rather than a bare
                     `toFixed`/`String`. Once there's a breakdown, the detail pane splits
                     into two columns (wrapping to one when the pane itself gets narrow) —
                     the row list with data-bar formatting on the left, and on the right a
                     per-layer, swappable @mantine/charts chart (`LayerSummary`'s own
                     local `chartType` state, a `SegmentedControl` — 'Balken'/'Kreis'/
                     'Ring' — right above it) — BarChart (`h={220}`, x/y axes with
                     `gridAxis="y"`) and PieChart/DonutChart (`size={180}`) all color by
                     bucket now, cycling the same LAYER_PALETTE by index rather than one
                     flat color for the bars: BarChart picks this up from each data row's
                     own `color` field (the installed version's `<Cell>`-per-bar logic
                     prefers `entry.color` over the flat `series` color, which stays only
                     as a fallback), the same mechanism `pieData` already relied on.
                     PieChart/DonutChart have no native legend (unlike BarChart, whose
                     bars are already self-labeled by the x-axis) — a small hand-built one
                     (color swatch + label per segment, from `pieData`'s own colors) sits
                     beside the chart in a `Group`, not stacked under it. Hovering a pie/
                     donut segment shows just that segment's own tooltip
                     (`tooltipDataSource="segment"` — the default, `"all"`, showed every
                     segment's value in one combined tooltip on any hover, unlike BarChart).
                     DonutChart's `chartLabel` shows the layer's total selected count
                     centered in the ring. A `showLabels` toggle (a `Switch` next
                     to the chart-type control, another piece of `LayerSummary`'s own
                     per-layer state) drives `withBarValueLabel`/`withLabels` on whichever
                     chart is showing — on by default. Clicking a row **or** a
                     bar/slice/segment (`barProps.onClick`/`pieProps.onClick` — this
                     version of @mantine/charts passes a real recharts `onClick` through,
                     see the version note below) toggles dashboardHighlight.ts's own,
                     separate map highlight for that bucket (amber, via
                     DashboardHighlight.tsx) — deliberately non-destructive, it does NOT
                     touch selection.ts's `selected`/replaceSelectionForLayers(), unlike
                     a row's own drill-through icon, which does still call
                     replaceSelectionForLayers() (on purpose — its whole point is "jump
                     to a detail view of exactly this") and also opens/focuses that
                     layer's attribute table tab via selection.ts's openLayerTab() (which
                     also clears `dashboardTabActive`, so the dashboard tab visually
                     deactivates when a drill-through focuses a layer tab). A per-layer
                     CSV export button builds the file client-side from the same
                     properties. A bookmark bar at the bottom saves/restores/deletes
                     named full-selection snapshots (selection.ts).
                     The row-list-plus-chart block itself is `BreakdownColumns`, factored
                     out to a plain `{label, count}[]` shape so a second mode can reuse it
                     without duplicating that JSX: with an empty real selection, the panel
                     shows `LayerOverviewCard` instead — one per currently *visible* layer,
                     as if everything in it were selected. It has its own
                     "Kartenansicht"/"Alle Zeilen" `SegmentedControl`, same labels as
                     AttributeTable.tsx's — Kartenansicht (the default) fetches real
                     features within the current map view via features.ts's
                     fetchFeaturesInBbox() (same bounded/capped contract and
                     camera.changed-driven refetch AttributeTable.tsx's own Kartenansicht
                     mode already uses), then computes count/aggregates/breakdown
                     client-side with the exact same `computeAggregates()`/
                     `computeEntryBreakdown()` LayerSummary itself calls (extracted out of
                     it for this reuse) — real entries in memory means highlight-on-click,
                     drill-through and CSV export are all synchronous here, no fetch-on-
                     click needed. Alle Zeilen is the original SQL-aggregate
                     implementation, unchanged: every number comes from upload-api
                     (columns.ts's fetchTableCount()/fetchColumnGroupBy(), and
                     fetchColumnStats()'s sum/avg/count fields) rather than a client-side
                     reduce — since some real layers here run into the millions of rows,
                     this mode never fetches whole layers into the browser. Its headline
                     count is already pre-fetched by the panel for every visible overview
                     layer the moment overview mode is shown (not just the active one), so
                     switching to it is never a cold wait; only its per-column stats/
                     breakdown are still fetched lazily. There, a bucket only becomes real
                     features on demand — clicking a row/chart segment or drill-through
                     fetches just that value's matching rows via
                     fetchFeaturesWithFilter(), then hands the result to the same
                     dashboardHighlight/replaceSelectionForLayers() primitives a real
                     selection's row click already uses. Either mode's synthetic "Andere"
                     bucket is shown but not clickable (no single CQL condition means
                     "everything outside the top N" without deeper filter.ts changes).
                     `LayerOverviewCard` also respects that layer's active
                     `attributeFilters` entry now (wms.ts) — "everything selected" means
                     "everything matching the filter" when one is set, in both modes and
                     in CSV export. Kartenansicht passes the filter's CQL
                     (filter.ts's buildCql()) into fetchFeaturesInBbox()'s new `cql` param;
                     Alle Zeilen passes the raw filter object to fetchTableCount()/
                     fetchColumnGroupBy()/fetchColumnStats(), which upload-api turns into a
                     parameterized SQL WHERE (see upload-api/CLAUDE.md). A small
                     `IconFilter` next to a card's title (and its `LayerNavRow`) shows when
                     a filter is active. Scoped to this card only — a real selection
                     (`LayerSummary`) and the select tools/attribute table are unaffected.
                     This whole mode is otherwise display-only — only drill-through is
                     allowed to turn it into a real selection, exactly like drill-through
                     already does for a real one.
                     Deliberate visual identity, not a copy of StatusHud's plain rows:
                     colorScheme.ts's SELECTION_COLOR (the map's own selection-highlight
                     blue) still marks the bookmark icon and the highlight color story
                     described above; each
                     layer gets a deterministic accent hue (`layerColor()`, hashed from
                     its name, module-local — no other component needs per-layer color
                     yet) carried through its identity bar, its RingProgress
                     share-of-selection ring, and its own chart/data-bars, so color alone
                     identifies which layer a number belongs to.
                     @mantine/charts is actually pinned to `^7.17.8` (checked
                     package.json and the installed .d.ts directly — an earlier version
                     of this note wrongly said 7.13.x with no click support). BarChart/
                     PieChart/DonutChart's `barProps`/`pieProps` do pass a real recharts
                     `onClick` through in this version, which is what makes the chart
                     itself a click target too, not just the row list below it.

colorScheme.ts  96  panel/accent colors — the teal+amber palette shared by the app and
                     the login screen
webgl.ts        64  WebGL2/1 capability probe, feeds Viewer's contextOptions
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
- **Draw order is array order.** The store keeps `layers[]` top-first; `Scene` renders
  it reversed because Cesium draws the last-added imagery layer on top. Reordering a
  row reorders the array, and React does the rest. Never reach for `raiseToTop`.
- **A layer renders one of two ways, chosen by `LayerState.clustered`.** Every
  layer defaults to `WmsLayer` — MapServer bakes its `CLASS`/`STYLE` into a
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
  and 1.2KB. Pruning must never drop a class that could still draw; the tests cover a
  filter on a different column and a non-`eq` operator for exactly that reason.
  `reachableClasses()` is also reused directly by `Legend.tsx` to hide a filtered-out
  class from the legend list itself, not just from the SLD sent to the map.
- **The layer list comes from GetCapabilities**, never a hardcoded list. Add a `LAYER`
  to the mapfile and it appears on reload. Per-layer extras live in module-level maps
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
  hands back a clean, predictable layout.
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
