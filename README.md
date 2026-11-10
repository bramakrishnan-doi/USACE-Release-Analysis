# USACE Release Analysis

Compares storm (or controlled release) volumes and travel times across **two or more USGS stream gages on the same river**, using USGS continuous (instantaneous, 15-min class) discharge records. Built for the workflow: a big slug of water passes the upstream gage, routes down the reach, and passes the downstream gages — did all the water arrive? and how long did it take?

Single-folder, no-build app (HTML + 2 JS assets, Chart.js from cdnjs). All data comes live from the USGS Water Data OGC API (`api.waterdata.usgs.gov`), parameter 00060 — continuous instantaneous discharge (cfs).

---

## Quick Start on Windows

### Method 1 — 1-Click (recommended)
1. Double-click **`run.bat`**.
2. It starts a local server (Node via `npx http-server`, or falls back to Python), then opens `http://localhost:3000`.

### Method 2 — Terminal
Serves from this folder with any static server, e.g.:
```cmd
npx --yes http-server -p 3000
```

### Method 3 — Direct open
Double-click `index.html`. If your browser blocks the USGS API from a `file://` page, use Method 1. Published configurations also require the app to be served over HTTP.

---

## Workflow

### Step 1 — List gages (upstream → downstream)
Enter gage IDs (**8-digit USGS numbers, e.g. `09419800`**) in order; the **first row is the reference gage** for volume ratios and travel-time origins. Give each a short label. Pick one shared data window (all gages fetched over the same start/end), then **Load Gage Data**.

- Fetches run in parallel; the retriever auto-follows OGC-API `rel="next"` cursor pages (10,000 records/page, up to 10 pages = 100,000 readings/gage). If the cap is hit you get a diagnostics note, not an error.
- Gage metadata (name, drainage area, coordinates) comes from the `monitoring-locations` collection and feeds the tables, the upstream-scaling fill, and wave-speed estimates.
- **Save Config / Load Config** — *Save Config* downloads a portable `usace-release-config-<date>-<time>.json` holding the gage list and order, the shared data window, the event window, per-gage baseline methods and parameters, gap-fill decisions, volume basis, and max-lag setting. *Load Config* restores that file: it refills the gage rows and dates, re-fetches the data, then re-applies the event window, baselines, fills, basis, and lag. Handy for recurring storm reviews or sharing an exact setup with a colleague.
- **Published configurations** — the **Published configurations** dropdown in Step 1 lists setups stored in the repository's `configs/` folder through `configs/index.json`. Select one and click **Load selected** to fetch that JSON, refill the gages and dates, and re-fetch the data with the saved settings. This is how shared examples work on the GitHub Pages site. To publish a new one: *Save Config*, put the JSON in `configs/`, add a `{ "label", "file", "description" }` entry to `configs/index.json`, then commit and push.

### Step 2 — Select the event window
All hydrographs overlay on one chart (gage colors: blue, amber, green, purple, red, teal). Click once on the chart to mark **event start**, click again for **event end** — the window applies to every gage. **"Suggest Largest Event"** auto-frames the biggest rise at the reference gage; click to adjust.

### Step 3 — Results (volume & travel-time comparison, right under the plot)
- **Toggle** between *Direct storm volume* and *Total volume above zero* — ratios and the highlighted volume column follow the basis. The bar chart always shows **direct storm volume**, with each bar labeled in acre-feet (and the same labels appear in the HTML report snapshot).
- **Volume table**: per-gage peak (cfs) & peak time, **first-rise time** (leading-edge arrival, hover for caveats), direct + total volumes (AF, `1 cfs-day = 1.98347 AF`), % of upstream, Δ vs upstream, and an interpretation pill (channel losses vs tributary gains), plus a **data-quality** pill ("complete", "N gaps filled (…)", or "x.x% of window NOT integrated" when gaps are left unfilled).
- **Travel-time table** — operational order, per reach (adjacent pairs + a cumulative row):
  1. **First-rise delay** (leading edge — each gage's first *sustained* rise above 2% of its peak excess, noise-filtered and interpolated; the warning time operators need to prepare for the peak)
  2. **Peak-to-peak delay** (crest arrival)
  3. **Cross-correlation lag** (best similarity, searched up to the configured max lag, reported with r)
  Centroid delay (volume-weighted center of mass — half the routed volume passed) is still computed as an internal cross-check and included in the CSV export.
  Plus straight-line gage distance (mi) and implied wave speed (mph — an upper bound since river distance is longer).
- **KPI cards** summarize the window, upstream/downstream volumes, ratio, crest travel time (peak-to-peak), and the **Operational lead time** (first-rise delay, first → last gage).
- **Export Report (HTML)** — a self-contained, printable report file with the overlay hydrograph and volume bar chart embedded as images (snapshot of exactly what's on screen, including gap shading and fills), the volume table, a travel-time table led by the **first-rise and peak-to-peak delays** (plus cross-correlation lag, distance, and wave speed), an *Operational lead time* KPI, a gage-metadata table, diagnostics, and method notes. The report intentionally omits the interactive configuration cards (baseline separation, gap-fill editing). Open it in any browser — no server or internet needed.
- **Export CSV** — summaries + travel rows + the full per-gage series (each reading flagged `measured` or with its fill method).

Task and load summaries appear in the status boxes; global notes/warnings live under the results **Diagnostics** section.

### Step 4 — Baseline separation (independent per gage)
Direct storm volume = observed minus baseline, floored at zero. Methods per gage:

| Method | Use when |
|---|---|
| **Flat Average** | steady natural baseflow (mean of N pre-event hours) |
| **Diurnal Pattern** | wastewater/pumping/snowmelt cycles (time-of-day buckets averaged over N prior days) |
| **Linear Ramp** | baseflow differs before vs after the event (pre-average → post-average) |
| **None / Dry** | ephemeral reach, usually no flow (baseline = 0 → direct ≈ total) |
| **Manual cfs** | fixed minimum dam/administered baseflow |

Changes here re-compute the Step 3 tables live — the card sits below the results so the summary stays in view while you tune.

### Step 5 — Missing data audit & fills (collapsible, last)
This card is **collapsible** (chevron next to the title; your choice is remembered) and defaults to collapsed so it stays out of the way. The header chip always summarizes gap status ("3 gaps · 2 filled · 1 event-window unfilled") even while collapsed.

Any interval ≥ 1.5× the gage's sampling interval is flagged as a **gap** and shaded on the chart (gage color; hatched = left unfilled, soft solid = filled). Gaps lying inside the event window get an **`event`** badge.

| Fill action | Effect |
|---|---|
| **Linear interpolation** (default) | neutral bridge between the boundary readings |
| **Hold last value** | carry the last known flow forward (can bias volume high during recessions) |
| **Scale from upstream** | plug the adjacent upstream gage's concurrent flow × drainage-area ratio (best for instrument outages; falls back to linear where the upstream gage also lacks data) |
| **Fill with zero** | treat as no flow (biases volume low) |
| **Leave as gap** | span excluded from integration and reported in the data-quality column |

Apply per gap or batch (buttons fill **all** gaps / reset **all** fills). Filled points are orange on the chart; hover any point for its source.

---

## Project layout

| File | Role |
|---|---|
| `index.html` | markup + styling (app shell) |
| `usace-data.js` | retrieval (pagination included), site rows, gap detection & fill engine |
| `usace-analysis.js` | baseline methods, volume integration, travel-time methods, CSV export |
| `usace-ui.js` | Chart.js setup/plugins (event & gap shading), all renderers, event wiring |
| `_selftest.js` | headless engine test — run `node _selftest.js` after edits |
| `_loadtest.js` | integration test loading all 3 files (catches wiring/symbol breaks) — run `node _loadtest.js` |
| `run.bat` | Windows launcher |

## Notes & caveats

- Data are UTC instants from USGS; dialogs/chart axis render in your browser's local timezone.
- Provisional values may be revised by USGS.
- Volume integration deliberately **does not guess** through unfilled gaps — the excluded share is flagged; fill gaps if you need the full window.
- Wave velocities use straight-line gage separation, so they are upper bounds.
- Provisional, not a substitute for calibrated routing models or official Corps reporting.
