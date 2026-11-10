/* ============================================================
   USACE Release Analysis — Data Layer
   Site rows, USGS OGC API retrieval (auto-paginating), gap
   detection, and gap-fill engine.
   ============================================================ */
'use strict';

/* ---------- Constants & shared state ---------- */
const API_BASE = 'https://api.waterdata.usgs.gov/ogcapi/v0';
const COL_CONT = API_BASE + '/collections/continuous/items';
const COL_LOC = API_BASE + '/collections/monitoring-locations/items';
const PAGE_LIMIT = 10000;   // per-page record cap (API max)
const MAX_PAGES = 10;       // 10 pages × 10,000 = 100,000 readings/gage
const MAX_GAGES = 6;

const GAGE_COLORS = ['#0284c7', '#d97706', '#059669', '#7c3aed', '#dc2626', '#0d9488'];
const FILL_COLOR = '#ea580c';   // filled-point marker color
const EVENT_FILL = 'rgba(2, 132, 199, 0.07)';
const GAP_ALPHA = 0.16;

const BASELINE_METHODS = [
  { key: 'flat',    name: 'Flat Average' },
  { key: 'diurnal', name: 'Diurnal Pattern' },
  { key: 'linear',  name: 'Linear Ramp' },
  { key: 'none',    name: 'None / Dry reach' },
  { key: 'manual',  name: 'Manual value (cfs)' }
];

const FILL_ACTIONS = [
  { key: '',        name: 'Leave as gap (exclude)' },
  { key: 'linear',  name: 'Linear interpolation' },
  { key: 'hold',    name: 'Hold last value' },
  { key: 'upstream', name: 'Scale from upstream' },
  { key: 'zero',    name: 'Fill with zero' }
];

/* Shared mutable state (also used by usace-analysis.js) */
let gages = [];                 // ordered upstream → downstream
let eventStart = null;          // Date|null
let eventEnd = null;            // Date|null
let volumeBasis = 'direct';     // 'direct' | 'total'
let chart = null;               // main overlay Chart
let barChart = null;            // results bar Chart
let forecastChart = null;       // downstream arrival forecast line Chart

/* ---------- Small utilities ---------- */
function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function fmtNum(x, d) {
  if (x === null || x === undefined || !Number.isFinite(x)) return '—';
  return x.toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
}

function fmtDT(ms) {
  if (ms === null || ms === undefined || !Number.isFinite(ms)) return '—';
  return moment(ms).format('YYYY-MM-DD HH:mm');
}

function fmtDur(sec) {
  if (!Number.isFinite(sec) || sec <= 0) return '—';
  const d = Math.floor(sec / 86400);
  const h = Math.floor((sec % 86400) / 3600);
  const m = Math.round((sec % 3600) / 60);
  if (d > 0) return d + 'd ' + h + 'h';
  if (h > 0) return h + 'h ' + m + 'm';
  return m + 'm';
}

function fmtDelay(ms) {
  if (ms === null || ms === undefined || !Number.isFinite(ms)) return 'n/a';
  const h = ms / 3600000;
  if (Math.abs(h) >= 24) return (h / 24).toFixed(2) + ' d';
  if (Math.abs(h) >= 1) return h.toFixed(2) + ' h';
  return Math.round(ms / 60000) + ' min';
}

function haversineMiles(lonlatA, lonlatB) {
  if (!lonlatA || !lonlatB) return null;
  const R = 3958.8; // Earth radius miles
  const toRad = (d) => d * Math.PI / 180;
  const aLat = toRad(lonlatA[1]), bLat = toRad(lonlatB[1]);
  const dLat = bLat - aLat;
  const dLon = toRad(lonlatB[0] - lonlatA[0]);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(aLat) * Math.cos(bLat) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

function showStatus(msg, type) {
  const el = document.getElementById('statusBox');
  el.className = 'status-box ' + (type || 'info');
  el.innerHTML = msg;
  if (type === 'success') setTimeout(hideStatusIf, 9000);
}

function hideStatusIf() {
  const el = document.getElementById('statusBox');
  if (el.classList.contains('success')) { el.className = 'status-box'; el.innerHTML = ''; }
}

/* ---------- Gage-row management (Step 1) ---------- */
let gageRowsArr = [];
let nextRowUid = 1;

function makeRow(label, id) {
  return { uid: 'r' + (nextRowUid++), label: label || '', id: id || '' };
}

function defaultRows() {
  return [makeRow('Upstream', '09421500'), makeRow('Downstream', '09421501')];
}

function renderSiteRows() {
  const box = document.getElementById('gageRows');
  box.innerHTML = gageRowsArr.map((r, i) => {
    const first = i === 0, last = i === gageRowsArr.length - 1;
    return '<div class="gage-row" data-uid="' + r.uid + '">' +
      '<span class="gage-order">G' + (i + 1) + '</span>' +
      '<input class="input g-label" data-field="label" placeholder="Label (e.g. Upstream)" value="' + esc(r.label) + '" />' +
      '<input class="input g-id" data-field="id" placeholder="USGS gage no. (e.g. 09419800)" value="' + esc(r.id) + '" />' +
      '<button class="gage-row-arrow" data-act="up" title="Move upstream" ' + (first ? 'disabled' : '') + '>▲</button>' +
      '<button class="gage-row-arrow" data-act="down" title="Move downstream" ' + (last ? 'disabled' : '') + '>▼</button>' +
      '<button class="gage-del" data-act="del" title="Remove gage" ' + (gageRowsArr.length <= 2 ? 'disabled' : '') + '>✕</button>' +
      '</div>';
  }).join('');
}

function readRowsFromDom() {
  const out = [];
  document.querySelectorAll('#gageRows .gage-row').forEach((el) => {
    out.push({
      uid: el.getAttribute('data-uid'),
      label: el.querySelector('[data-field="label"]').value.trim(),
      id: el.querySelector('[data-field="id"]').value.trim()
    });
  });
  return out;
}

function normalizeGageId(raw) {
  if (!raw) return null;
  let s = raw.trim().toUpperCase();
  if (!s) return null;
  if (s.startsWith('USGS-')) s = s.slice(5);
  return 'USGS-' + s;
}

/* ---------- Site factory ---------- */
function makeSite(row) {
  return {
    uid: 's' + (nextRowUid++),
    label: row.label || '',
    id: normalizeGageId(row.id),
    meta: null,             // {name,state,county,da,siteType,coords}
    raw: [],                // [{t(ms), v(cfs)}] sorted, deduped, unfilled
    readings: [],           // merged = raw + synthetic fill points [{t, v, f}]
    ok: false,
    err: null,
    intervalSec: 900,
    gaps: [],
    gapSeq: 1,
    blCache: null,          // baseline reference built in analysis layer
    warnings: [],
    results: null,
    baseline: {
      method: 'flat',
      flatHours: 24,
      diurnalDays: 2,
      linearHours: 2,
      manualCfs: 0
    }
  };
}

/* ---------- USGS retrieval ---------- */
async function fetchContinuous(gid, startISO, endISO, siteOut) {
  let url = COL_CONT +
    '?f=json' +
    '&monitoring_location_id=' + encodeURIComponent(gid) +
    '&datetime=' + encodeURIComponent(startISO) + '%2F' + encodeURIComponent(endISO) +
    '&parameter_code=00060' +
    '&limit=' + PAGE_LIMIT;

  const out = [];
  let page = 0, truncated = false;

  while (url && page < MAX_PAGES) {
    let resp;
    try { resp = await fetch(url); }
    catch (e) { throw new Error('Network error reaching USGS API (check internet connection).'); }
    if (!resp.ok) {
      if (resp.status === 404) throw new Error('HTTP 404 — gage ID not found in USGS Water Data.');
      throw new Error('HTTP ' + resp.status + ' (' + resp.statusText + ') — continuous-values request.');
    }
    const data = await resp.json();
    const feats = data.features || [];
    for (const ft of feats) {
      const p = ft.properties || {};
      if (!p.time || p.value === null || p.value === undefined) continue;
      const t = Date.parse(p.time);
      const v = parseFloat(p.value);
      if (Number.isFinite(t) && Number.isFinite(v)) out.push({ t: t, v: v });
    }
    const next = (data.links || []).find((l) => l.rel === 'next');
    url = next ? next.href : null;
    page++;
    if (feats.length < PAGE_LIMIT && !next) break;
    if (page === MAX_PAGES && next) truncated = true;
  }

  if (truncated && siteOut) {
    siteOut.fetchNote = 'Record cap reached (' + (MAX_PAGES * PAGE_LIMIT).toLocaleString() +
      ' readings) — window truncated at the lower end of the loaded range. Narrow the date window for full coverage.';
  }
  return out;
}

async function fetchMeta(gid) {
  try {
    const r = await fetch(COL_LOC + '/' + encodeURIComponent(gid) + '?f=json');
    if (!r.ok) return null;
    const d = await r.json();
    const p = d.properties || {};
    const da = [p.drainage_area, p.contributing_drainage_area, p.drainage_area_sqmi]
      .find((x) => typeof x === 'number' && x > 0) || null;
    const g = d.geometry;
    return {
      name: p.monitoring_location_name || gid,
      state: p.state_name || '',
      county: p.county_name || '',
      da: da,
      siteType: p.site_type || p.site_type_code || '',
      coords: (g && Array.isArray(g.coordinates) && g.coordinates.length === 2) ? g.coordinates : null
    };
  } catch (e) {
    return null;
  }
}

function sortDedupe(list) {
  const arr = list.slice().sort((a, b) => a.t - b.t);
  const out = [];
  for (let i = 0; i < arr.length; i++) {
    if (i === 0 || arr[i].t !== arr[i - 1].t) out.push(arr[i]);
  }
  return out;
}

function medianInterval(readings) {
  const diffs = [];
  for (let i = 1; i < readings.length; i++) {
    const d = (readings[i].t - readings[i - 1].t) / 1000;
    if (d >= 60 && d <= 7200) diffs.push(d);
  }
  if (diffs.length === 0) return 900;
  diffs.sort((a, b) => a - b);
  return diffs[Math.floor(diffs.length / 2)];
}

/* ---------- Load everything (Step 1 button) ---------- */
async function loadAllData() {
  const rows = readRowsFromDom();
  if (rows.length < 2) { showStatus('At least two gages are required for comparison.', 'error'); return; }

  // Normalize & validate IDs
  const seen = new Map();
  for (const r of rows) {
    const id = normalizeGageId(r.id);
    if (!id) { showStatus('Every gage row needs a USGS gage number (e.g. 09419800).', 'error'); return; }
    if (seen.has(id)) { showStatus('Duplicate gage ID <strong>' + esc(id) + '</strong> — each row must be a different gage.', 'error'); return; }
    seen.set(id, true);
  }

  const startVal = document.getElementById('startDateInput').value;
  const endVal = document.getElementById('endDateInput').value;
  if (!startVal || !endVal) { showStatus('Specify both a start and end for the data window.', 'error'); return; }
  const sDate = new Date(startVal), eDate = new Date(endVal);
  if (isNaN(sDate.getTime()) || isNaN(eDate.getTime())) { showStatus('Invalid date values.', 'error'); return; }
  if (sDate >= eDate) { showStatus('Start must be earlier than end.', 'error'); return; }
  const startISO = sDate.toISOString();
  const endISO = eDate.toISOString();

  // Reset state
  gages = rows.map((r) => makeSite(r));
  eventStart = null; eventEnd = null; clickStage = 0;
  setSelectionUi('Load gage data above, then click two points on the chart to define the storm start and end.', 'info');

  const btn = document.getElementById('btnLoad');
  const spin = document.getElementById('loadBtnSpinner');
  const txt = document.getElementById('loadBtnText');
  btn.disabled = true; spin.style.display = 'inline-block'; txt.textContent = 'Loading…';
  showStatus('Connecting to the USGS Water Data OGC API for ' + gages.length + ' gages…', 'info');

  // Parallel fetch: streamflow + metadata
  const jobs = gages.map(async (g) => {
    try {
      const [vals, meta] = await Promise.all([
        fetchContinuous(g.id, startISO, endISO, g),
        fetchMeta(g.id)
      ]);
      const clean = sortDedupe(vals);
      g.raw = clean;
      g.meta = meta;
      g.ok = clean.length > 0;
      if (!g.ok) g.err = 'No continuous discharge (parameter 00060) records returned in this window — gage may be offline, non-reporting, or temporary.';
    } catch (e) {
      g.ok = false; g.err = e.message || String(e);
    }
  });
  await Promise.all(jobs);

  // Post-process each
  for (const g of gages) {
    if (g.ok) {
      g.intervalSec = medianInterval(g.raw);
      g.readings = g.raw.map((r) => ({ t: r.t, v: r.v, f: null }));
      detectGaps(g);
      applyFillsSilent(g);
    }
  }

  const loaded = gages.filter((g) => g.ok);
  btn.disabled = false; spin.style.display = 'none'; txt.textContent = 'Load Gage Data ▶';

  if (loaded.length === 0) {
    showStatus('No gage returned data. Details: ' +
      gages.map((g) => '<strong>' + esc(g.id) + '</strong>: ' + esc(g.err)).join('<br/>'), 'error');
    renderAllDynamic();
    return;
  }

  const summary = loaded.map((g) => {
    const first = fmtDT(g.readings[0].t), last = fmtDT(g.readings[g.readings.length - 1].t);
    const name = g.meta && g.meta.name ? g.meta.name : g.id;
    return '<strong>' + esc(g.label || g.id) + '</strong> (' + esc(g.id) + '): ' +
      g.readings.length.toLocaleString() + ' readings, ' + first + ' → ' + last +
      ', ~' + Math.round(g.intervalSec / 60) + '-min interval' +
      (g.gaps.length ? ', ' + g.gaps.length + ' gap' + (g.gaps.length > 1 ? 's' : '') + ' detected' : '') +
      '<br/><span style="font-size:0.78rem">' + esc(name) + '</span>';
  }).join('<br/><br/>');

  const failed = gages.filter((g) => !g.ok)
    .map((g) => '<strong>' + esc(g.id) + '</strong>: ' + esc(g.err));
  showStatus(
    (failed.length ? '<span style="color:#991b1b">Failed gages:</span><br/>' + failed.join('<br/>') + '<br/><br/>' : '') +
    summary, failed.length ? 'info' : 'success'
  );

  renderAllDynamic();
  updateChart();
  applyPendingConfig();   // re-apply a saved configuration staged by applyConfig(), if any
}

/* ---------- Gap detection & fill engine ---------- */
function detectGaps(site) {
  site.gaps = [];
  site.gapSeq = 1;
  const raw = site.raw;
  if (raw.length < 2) return;
  const thr = Math.max(1.5 * site.intervalSec, site.intervalSec + 120);
  for (let i = 1; i < raw.length; i++) {
    const dt = (raw[i].t - raw[i - 1].t) / 1000;
    if (dt > thr) {
      site.gaps.push({
        gid: site.uid + '-' + site.gapSeq++,
        t0: raw[i - 1].t,
        t1: raw[i].t,
        durSec: dt,
        missing: Math.max(0, Math.round(dt / site.intervalSec) - 1),
        fill: 'linear',     // default action
        inEvent: false
      });
    }
  }
  updateGapEventFlags(site);
}

function updateGapEventFlags(site) {
  if (!eventStart || !eventEnd) {
    site.gaps.forEach((g) => { g.inEvent = false; });
    return;
  }
  const s = eventStart.getTime(), e = eventEnd.getTime();
  site.gaps.forEach((g) => {
    g.inEvent = g.t1 >= s && g.t0 <= e;
  });
}

/* Linear value lookup on a site's merged readings (null when outside coverage) */
function valueAt(site, ms) {
  const arr = site.readings;
  if (!site.ok || !arr || arr.length === 0) return null;
  if (ms <= arr[0].t || ms >= arr[arr.length - 1].t) return null;
  let lo = 0, hi = arr.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (arr[mid].t <= ms) lo = mid; else hi = mid;
  }
  const a = arr[lo], b = arr[hi];
  if (a.t === b.t) return a.v;
  const frac = (ms - a.t) / (b.t - a.t);
  return a.v + (b.v - a.v) * frac;
}

/* Adjacent upstream gage (index - 1), or null */
function upstreamOf(site) {
  const idx = gages.findIndex((g) => g.uid === site.uid);
  if (idx <= 0) return null;
  return gages[idx - 1];
}

function scaleRatio(site, up) {
  const a = site.meta && site.meta.da, b = up.meta && up.meta.da;
  if (b > 0 && a > 0) return a / b;
  return 1.0;
}

/* Rebuild site.readings from raw + each gap's fill action (upstream gage first!) */
function applyFillsSilent(site) {
  if (!site.ok) { site.readings = site.raw.map((r) => ({ t: r.t, v: r.v, f: null })); return; }
  const merged = site.raw.map((r) => ({ t: r.t, v: r.v, f: null }));
  const up = upstreamOf(site);
  const ratio = (up && up.ok && up.meta && up.meta.da && site.meta && site.meta.da)
    ? (site.meta.da / up.meta.da) : 1;

  for (const gap of site.gaps) {
    if (!gap.fill || gap.fill === '') continue;
    const raw = site.raw;
    let li = -1, ri = -1;
    for (let i = 0; i < raw.length; i++) {
      if (raw[i].t === gap.t0) li = i;
      if (raw[i].t === gap.t1) { ri = i; break; }
    }
    if (li < 0 || ri < 0) continue;
    const v0 = raw[li].v, v1 = raw[ri].v;
    const t0 = raw[li].t, t1 = raw[ri].t;
    const step = site.intervalSec * 1000;

    for (let t = t0 + step; t < t1 - step / 2; t += step) {
      let v = null, f = gap.fill;
      if (gap.fill === 'linear') {
        v = v0 + (v1 - v0) * ((t - t0) / (t1 - t0));
      } else if (gap.fill === 'hold') {
        v = v0;
      } else if (gap.fill === 'zero') {
        v = 0;
      } else if (gap.fill === 'upstream') {
        const uv = up && up.ok ? valueAt(up, t) : null;
        if (uv === null) {
          v = v0 + (v1 - v0) * ((t - t0) / (t1 - t0));
          f = 'upstream→linear';
        } else {
          v = Math.max(0, uv * ratio);
        }
      }
      if (v !== null && Number.isFinite(v)) merged.push({ t: t, v: Math.max(0, v), f: f });
    }
  }
  merged.sort((a, b) => a.t - b.t);
  site.readings = merged;
}

function applyAllFills() {
  for (const g of gages) applyFillsSilent(g);   // sequential keeps upstream refs fresh
}

/* Timestamps (ms) where a site has synthetic fill values */
function filledTimes(site) {
  return site.readings.filter((r) => r.f).map((r) => r.t);
}

/* Per-gap overlap with event window (ms) for "unfilled" reporting */
function unfilledEventMs(site, evSms, evEms) {
  let sum = 0;
  for (const gap of site.gaps) {
    if (gap.fill && gap.fill !== '') continue;
    const a = Math.max(gap.t0, evSms), b = Math.min(gap.t1, evEms);
    if (b > a) sum += b - a;
  }
  return sum;
}
