/* ============================================================
   USACE Release Analysis — Analysis Engine
   Baseline separation, volume integration, travel-time
   methods (peak / centroid / cross-correlation), CSV export.
   ============================================================ */
'use strict';

/* Event-window click stage: 0 = awaiting start, 1 = awaiting end, 2 = complete */
let clickStage = 0;
let travelRows = [];
let pendingConfig = null;   // saved configuration staged until its data finishes loading
let savedConfigs = [];      // published configurations listed in configs/index.json
let savedConfigReq = 0;     // guards against out-of-order saved-config fetches

const SAVED_CONFIG_BASE = 'configs/';

/* ============================================================
   Baseline reference construction (per gage)
   Mirrors the proven Storm-Event methods, generalized to work
   on any gage's own record.
   ============================================================ */
function buildBaselineRef(site, evSms, evEms) {
  const b = site.baseline;
  const warns = [];
  const pre = site.readings.filter((r) => r.t < evSms);
  const post = site.readings.filter((r) => r.t > evEms);
  const firstT = site.readings.length ? site.readings[0].t : null;

  if (b.method === 'none') {
    site.blCache = { type: 'none' };
    if (pre.length === 0) warns.push('No readings before the event start (uses zero baseline; treat direct ≈ total volume).');
    site.warnings = warns;
    return true;
  }

  if (b.method === 'manual') {
    const v = Number(b.manualCfs);
    if (!Number.isFinite(v) || v < 0) {
      warns.push('Manual baseline value is not a valid number — set a non-negative cfs value.');
      site.warnings = warns; site.blCache = { type: 'none' };
      return false;
    }
    site.blCache = { type: 'manual', v: v };
    site.warnings = warns;
    return true;
  }

  if (b.method === 'flat') {
    const hours = Math.max(0.5, Number(b.flatHours) || 24);
    const ref = pre.filter((r) => r.t >= evSms - hours * 3600e3);
    if (ref.length === 0) {
      warns.push('Flat Average: no pre-event readings inside the ' + hours + 'h window. Load earlier data, or use None/Dry (ephemeral) or Manual.');
      site.warnings = warns;
      return false;
    }
    const availH = firstT !== null ? (evSms - firstT) / 3600e3 : 0;
    if (availH < hours * 0.85) {
      warns.push('Flat Average: only ' + availH.toFixed(1) + ' h of pre-event data available of the requested ' + hours + ' h — using what exists.');
    }
    let sum = 0; ref.forEach((r) => { sum += r.v; });
    site.blCache = { type: 'flat', v: sum / ref.length };
    site.warnings = warns;
    return true;
  }

  if (b.method === 'diurnal') {
    const nDays = Math.max(1, Number(b.diurnalDays) || 2);
    const refStart = evSms - nDays * 24 * 3600e3;
    const ref = pre.filter((r) => r.t >= refStart);
    const availPreMs = firstT !== null ? evSms - firstT : 0;

    if (ref.length < 4 || availPreMs < 12 * 3600e3) {
      warns.push('Diurnal: only ' + (availPreMs / 3600e3).toFixed(1) + ' h of pre-event data. Needs ≥ 12 h (ideally ' + nDays + ' d). Use Flat or None/Dry instead, or load earlier data.');
      site.warnings = warns;
      return false;
    }
    if (availPreMs < nDays * 24 * 3600e3 * 0.85) {
      warns.push('Diurnal: pre-event coverage (' + (availPreMs / 3600e3).toFixed(1) + ' h) is shorter than the requested ' + nDays + ' d — averaging over available days.');
    }

    const bucketSec = Math.max(300, Math.min(3600, site.intervalSec || 900));
    const numBuckets = Math.round(86400 / bucketSec);
    const buckets = Array.from({ length: numBuckets }, () => []);
    for (const r of ref) {
      const sec = r.t;
      const msIntoDay = sec - Math.floor(sec / 86400e3) * 86400e3;   // UTC-anchored
      const secsIntoDay = Math.round(msIntoDay / 1000);
      const idx = Math.round(secsIntoDay / bucketSec) % numBuckets;
      buckets[idx].push(r.v);
    }
    const averages = new Array(numBuckets);
    let s = 0, c = 0;
    for (let i = 0; i < numBuckets; i++) {
      if (buckets[i].length > 0) {
        const val = buckets[i].reduce((acc, x) => acc + x, 0) / buckets[i].length;
        averages[i] = val; s += val * buckets[i].length; c += buckets[i].length;
      } else {
        averages[i] = null;
      }
    }
    const mean = c > 0 ? s / c : 0;
    for (let i = 0; i < numBuckets; i++) {
      if (averages[i] === null) {
        let found = null;
        for (let off = 1; off < numBuckets / 2; off++) {
          const L = (i - off + numBuckets) % numBuckets;
          const R = (i + off) % numBuckets;
          if (averages[L] !== null) { found = averages[L]; break; }
          if (averages[R] !== null) { found = averages[R]; break; }
        }
        averages[i] = found !== null ? found : mean;
      }
    }
    site.blCache = { type: 'diurnal', bucketSec: bucketSec, avgs: averages };
    site.warnings = warns;
    return true;
  }

  if (b.method === 'linear') {
    const winMs = (Math.max(0.5, Number(b.linearHours) || 2)) * 3600e3;
    let preSlice = pre.filter((r) => r.t >= evSms - winMs);
    let postSlice = post.filter((r) => r.t <= evEms + winMs);
    if (preSlice.length === 0) preSlice = pre.slice(-2);
    if (postSlice.length === 0) postSlice = post.slice(0, 2);
    if (preSlice.length === 0) {
      warns.push('Linear Ramp: no readings before event start. Load earlier data or use None/Dry.');
      site.warnings = warns;
      return false;
    }
    if (postSlice.length === 0) {
      warns.push('Linear Ramp: no readings after event end — extend the data window end later.');
      site.warnings = warns;
      return false;
    }
    const mean = (arr) => arr.reduce((acc, r) => acc + r.v, 0) / arr.length;
    site.blCache = {
      type: 'linear',
      startBase: mean(preSlice),
      endBase: mean(postSlice),
      durMs: Math.max(1, evEms - evSms)
    };
    site.warnings = warns;
    return true;
  }

  // unknown method — fail safe
  warns.push('Unknown baseline method "' + esc(b.method) + '".');
  site.warnings = warns;
  return false;
}

/* Evaluate baseline cfs at any timestamp t (ms) */
function getBaselineAt(site, t) {
  const c = site.blCache;
  if (!c) return 0;
  if (c.type === 'none') return 0;
  if (c.type === 'manual') return c.v;
  if (c.type === 'flat') return c.v;
  if (c.type === 'linear') {
    const frac = Math.max(0, Math.min(1, (t - eventStart.getTime()) / c.durMs));
    return c.startBase + frac * (c.endBase - c.startBase);
  }
  if (c.type === 'diurnal') {
    const msIntoDay = t - Math.floor(t / 86400e3) * 86400e3;
    const secs = Math.round(msIntoDay / 1000);
    const num = c.avgs.length;
    return c.avgs[Math.round(secs / c.bucketSec) % num];
  }
  return 0;
}

/* ============================================================
   Per-gage integration inside the event window
   ============================================================ */
function computeSite(site) {
  site.results = null;
  if (!site.ok || !eventStart || !eventEnd) {
    if (site.ok && !eventStart) site.warnings = [];
    return;
  }
  const evS = eventStart.getTime(), evE = eventEnd.getTime();
  const sr = site.readings.filter((r) => r.t >= evS && r.t <= evE);
  if (sr.length === 0) {
    site.warnings = ['No readings fall inside the selected event window at this gage.'];
    return;
  }

  // Baseline validation (constructs site.blCache; sets site.warnings)
  if (!buildBaselineRef(site, evS, evE)) { site.results = null; return; }

  const res = {
    directAF: 0, totalAF: 0,
    peak: null, peakTimeMs: null, peakExcess: 0,
    centroidMs: null,
    excludedMs: 0,
    windowMs: evE - evS,
    intervals: [],
    baselineDesc: describeBaseline(site)
  };

  let cW = 0, cWT = 0;

  for (let i = 0; i < sr.length; i++) {
    const t = sr[i].t, q = Math.max(0, sr[i].v);
    let dtSec;

    if (i < sr.length - 1) {
      const nd = (sr[i + 1].t - t) / 1000;
      // Does an unfilled (left-as-gap) detected gap span exactly this interval?
      let unfilled = false;
      for (const gap of site.gaps) {
        if (!gap.fill && gap.t0 === t && gap.t1 === sr[i + 1].t) { unfilled = true; break; }
      }
      if (nd <= 7200 && !unfilled) {
        dtSec = nd;
      } else {
        // Unmeasured span follows this reading: credit only one interval of
        // measured data; exclude the unmeasured portion from integration.
        dtSec = site.intervalSec;
        if (unfilled) {
          const overMs = Math.min(sr[i + 1].t, evE) - t;
          if (overMs > 0) res.excludedMs += Math.min(overMs, nd * 1000);
        }
      }
    } else {
      // Last reading inside window: cap at the window end
      const prevDt = i > 0 ? (t - sr[i - 1].t) / 1000 : site.intervalSec;
      const rem = Math.max(0, (evE - t) / 1000);
      if (rem > 1.5 * site.intervalSec) {
        dtSec = site.intervalSec;
        res.excludedMs += rem * 1000;
      } else {
        dtSec = Math.min(prevDt, rem);
      }
    }

    if (!Number.isFinite(dtSec) || dtSec <= 0) dtSec = site.intervalSec;

    const base = getBaselineAt(site, t);
    const ex = Math.max(0, q - base);

    res.directAF += ex * (dtSec / 43560);
    res.totalAF += q * (dtSec / 43560);
    cW += ex * dtSec;
    cWT += ex * dtSec * (t + dtSec * 500);   // interval midpoint weighting

    res.intervals.push({ t: t, q: q, base: base });

    if (q > (res.peak === null ? -Infinity : res.peak)) {
      res.peak = q; res.peakTimeMs = t;
    }
    if (ex > res.peakExcess) res.peakExcess = ex;
  }

  res.centroidMs = cW > 0 ? cWT / cW : null;
  detectFirstRise(site, res);
  site.results = res;
}

/* ============================================================
   First-rise (leading-edge) arrival detection.
   The operational "when did the flow start rising" instant:
   the first reading whose baseline-removed excess crosses 2% of
   the gage's peak excess AND stays at/above it for a sustained
   window (skips sensor noise spikes), linearly interpolated
   between the two straddling readings.
   ============================================================ */
function detectFirstRise(site, res) {
  res.riseTimeMs = null;
  res.riseNote = '';
  const iv = res.intervals;
  if (iv.length < 3 || !(res.peakExcess > 0)) return;
  const thr = 0.02 * res.peakExcess;
  const stepMs = site.intervalSec * 1000;
  const sustainMs = Math.min(3600e3, Math.max(2 * stepMs, res.windowMs * 0.2));
  const ex = iv.map((p) => Math.max(0, p.q - p.base));

  // Flow already above threshold at the very first in-window reading?
  if (ex[0] >= thr) {
    res.riseTimeMs = iv[0].t;
    res.riseNote = 'already elevated at window start';
    return;
  }

  // First crossing that holds for the sustained window
  for (let i = 1; i < iv.length; i++) {
    if (ex[i] < thr) continue;
    const tEnd = iv[i].t + sustainMs;
    let k = i, ok = true;
    while (k < iv.length && iv[k].t <= tEnd) {
      if (ex[k] < thr) { ok = false; break; }
      k++;
    }
    if (!ok) continue;   // noise spike — keep scanning
    if (ex[i - 1] < thr) {   // interpolate the true threshold crossing
      const f = (thr - ex[i - 1]) / (ex[i] - ex[i - 1]);
      res.riseTimeMs = iv[i - 1].t + f * (iv[i].t - iv[i - 1].t);
    } else {
      res.riseTimeMs = iv[i].t;
    }
    res.riseNote = 'first sustained rise ≥ 2% of peak excess';
    return;
  }

  // Nothing sustained — fall back to the raw first crossing, flagged
  for (let i = 1; i < iv.length; i++) {
    if (ex[i] >= thr && ex[i - 1] < thr) {
      const f = (thr - ex[i - 1]) / (ex[i] - ex[i - 1]);
      res.riseTimeMs = iv[i - 1].t + f * (iv[i].t - iv[i - 1].t);
      res.riseNote = 'rise ≥ 2% of peak excess (not sustained — verify baseline)';
      return;
    }
  }
}

/* Preferred operational delay for a travel row:
   peak-to-peak (crest timing) → cross-correlation → centroid (mass balance) */
function operDelayMs(row) {
  if (row.peakDelayMs != null && row.peakDelayMs > 0) return row.peakDelayMs;
  if (row.xc && row.xc.lagMs > 0) return row.xc.lagMs;
  if (row.centDelayMs != null && row.centDelayMs > 0) return row.centDelayMs;
  return null;
}

function describeBaseline(site) {
  const m = site.baseline.method;
  if (m === 'none') return 'None (dry = 0 cfs)';
  if (m === 'manual') return 'Manual ' + fmtNum(Number(site.baseline.manualCfs), 2) + ' cfs';
  if (m === 'flat') return 'Flat (pre-event avg)';
  if (m === 'diurnal') return 'Diurnal (' + Number(site.baseline.diurnalDays) + ' d pattern)';
  if (m === 'linear') return 'Linear ramp';
  return m;
}

/* Fill/gap quality summary for the results table */
function gapSummary(site, evSms, evEms) {
  if (!eventStart || !eventEnd) return { tag: null, text: '—', tone: 'tag-even' };
  const inEv = site.gaps.filter((g) => g.t1 >= evSms && g.t0 <= evEms);
  if (inEv.length === 0) return { tag: 'complete', text: 'Complete record in event', tone: 'tag-ok' };
  const filled = inEv.filter((g) => g.fill && g.fill !== '');
  const unfilledMs = unfilledEventMs(site, evSms, evEms);
  const pct = site.results ? (unfilledMs / Math.max(1, site.results.windowMs)) * 100 : null;
  if (filled.length === inEv.length) {
    return {
      tag: 'filled',
      text: filled.length + ' gap' + (filled.length > 1 ? 's' : '') + ' filled (' +
        filled.map((g) => g.fill).join(', ').slice(0, 40) + ')',
      tone: 'tag-gap'
    };
  }
  return {
    tag: 'unfilled',
    text: unfilledMs > 0
      ? filled.length + '/' + inEv.length + ' filled · ' + pct.toFixed(1) + '% of window NOT integrated'
      : filled.length + '/' + inEv.length + ' filled',
    tone: 'tag-gap'
  };
}

/* ============================================================
   Cross-correlation travel time
   ============================================================ */
function xcorrPair(a, b, maxLagHours) {
  const evS = eventStart.getTime(), evE = eventEnd.getTime();
  const spanMs = evE - evS;
  const step = Math.max(60, Math.min(3600, Math.min(a.intervalSec, b.intervalSec)));
  const n = Math.min(20000, Math.floor(spanMs / (step * 1000)));
  if (n < 8) return null;

  const maxSteps = Math.max(1, Math.min(
    Math.floor(((maxLagHours || 24) * 3600e3) / (step * 1000)),
    Math.floor(n / 2)
  ));

  const u = new Array(n), d = new Array(n);
  for (let i = 0; i < n; i++) {
    const t = evS + i * step * 1000;
    const uv = valueAt(a, t), dv = valueAt(b, t);
    u[i] = uv === null ? NaN : Math.max(0, uv - getBaselineAt(a, t));
    d[i] = dv === null ? NaN : Math.max(0, dv - getBaselineAt(b, t));
  }

  let best = null;
  for (let lag = 0; lag <= maxSteps; lag++) {
    let su = 0, sd = 0, cu = 0, cd = 0, cc = 0, cnt = 0;
    for (let i = 0; i + lag < n; i++) {
      const x = u[i], y = d[i + lag];
      if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
      su += x; sd += y; cu += x * x; cd += y * y; cc += x * y; cnt++;
    }
    if (cnt < 8) continue;
    const du = su * su, dd = sd * sd;
    const denom = Math.sqrt((cu * cnt - du) * (cd * cnt - dd));
    if (denom <= 1e-9) continue;
    const r = (cc * cnt - su * sd) / denom;
    if (!best || r > best.r) best = { lagMs: lag * step * 1000, r: r };
  }
  return best;
}

/* Build travel rows: adjacent pairs + cumulative first→last */
function computeTravel() {
  travelRows = [];
  if (!eventStart || !eventEnd) return;
  let maxLag = 24;
  const lagEl = document.getElementById('lagHours');
  if (lagEl) {
    const v = Number(lagEl.value);
    if (Number.isFinite(v) && v > 0) maxLag = v;
  }

  const pairRow = (a, b, isCumulative) => {
    const row = {
      label: a.label || a.id,
      labelB: b.label || b.id,
      aId: a.id, bId: b.id,
      isCumulative: !!isCumulative,
      aOk: !!a.ok && !!a.results, bOk: !!b.ok && !!b.results,
      peakDelayMs: null, riseDelayMs: null, centDelayMs: null, xc: null, distMi: null, velMph: null,
      riseNote: '', note: ''
    };
    if (!row.aOk || !row.bOk) {
      row.note = !a.ok ? 'upstream gage has no data' :
        (!b.ok ? 'downstream gage has no data' : 'event window has no data at a gage');
      return row;
    }
    if (a.results.peakTimeMs != null && b.results.peakTimeMs != null) {
      row.peakDelayMs = b.results.peakTimeMs - a.results.peakTimeMs;
    }
    if (a.results.riseTimeMs != null && b.results.riseTimeMs != null) {
      row.riseDelayMs = b.results.riseTimeMs - a.results.riseTimeMs;
    }
    row.riseNote = [a.results.riseNote, b.results.riseNote].filter(Boolean).join(' · ');
    if (a.results.centroidMs != null && b.results.centroidMs != null) {
      row.centDelayMs = b.results.centroidMs - a.results.centroidMs;
    }
    row.xc = xcorrPair(a, b, maxLag);

    if (a.meta && a.meta.coords && b.meta && b.meta.coords) {
      row.distMi = haversineMiles(a.meta.coords, b.meta.coords);
    }
    const delay = operDelayMs(row);
    if (row.distMi != null && delay != null && delay > 0) {
      row.velMph = row.distMi / (delay / 3600e3);
    }
    if (delay != null && delay <= 0) {
      row.note = 'check gage order / clock alignment';
    }
    return row;
  };

  for (let k = 1; k < gages.length; k++) {
    travelRows.push(pairRow(gages[k - 1], gages[k], false));
  }
  if (gages.length > 2) {
    travelRows.push(pairRow(gages[0], gages[gages.length - 1], true));
  }
}

/* ============================================================
   Suggest the largest event (moving-average peak detection)
   ============================================================ */
function autoDetectEvent() {
  const up = gages.find((g) => g.ok && g.readings.length > 4);
  if (!up) { setSelectionUi('No loaded gage data to analyze.', 'error'); return; }

  const arr = up.readings;
  const w = Math.max(3, Math.min(13, Math.round(1800e3 / (up.intervalSec * 1000) * 2) || 5));
  const sm = [];
  for (let i = 0; i < arr.length; i++) {
    let s = 0, c = 0;
    for (let k = Math.max(0, i - w); k <= Math.min(arr.length - 1, i + w); k++) { s += arr[k].v; c++; }
    sm.push(s / c);
  }
  let p = 0;
  for (let i = 1; i < sm.length; i++) if (sm[i] > sm[p]) p = i;

  // Walk back to the trough at the start of this rise
  const amp = Math.max(sm[p] - Math.min.apply(null, sm), 1e-9);
  let startIdx = 0, localMin = Infinity;
  for (let k = p - 1; k >= 0; k--) {
    if (sm[k] < localMin) localMin = sm[k];
    if (sm[k] <= localMin + 0.08 * amp) { startIdx = k; break; }
    startIdx = k;
  }
  // Walk forward to the recession end (falls to ~start level + 10% amplitude)
  const startLevel = sm[startIdx];
  let endIdx = arr.length - 1;
  for (let k = p + 1; k < arr.length; k++) {
    if (sm[k] <= startLevel + 0.10 * (sm[p] - startLevel)) { endIdx = k; break; }
    endIdx = k;
  }

  let startMs = arr[startIdx].t, endMs = arr[endIdx].t;
  if (endMs - startMs < Math.max(4 * up.intervalSec, 30 * 60) * 1000) {
    startMs = Math.max(arr[0].t, arr[p].t - 3 * 3600e3);
    endMs = Math.min(arr[arr.length - 1].t, arr[p].t + 6 * 3600e3);
  }

  eventStart = new Date(startMs);
  eventEnd = new Date(endMs);
  clickStage = 2;
  setSelectionUi(
    'Suggested event: <strong>' + fmtDT(startMs) + '</strong> → <strong>' + fmtDT(endMs) + '</strong> (local), ' +
    'from the largest rise at ' + esc(up.label || up.id) + '. Click the chart to adjust, or use Suggest again.',
    'success'
  );
  computeAll();
}

/* ============================================================
   Full recompute + rerender pipeline
   ============================================================ */
function computeAll() {
  for (const g of gages) updateGapEventFlags(g);
  for (const g of gages) computeSite(g);
  if (eventStart && eventEnd) computeTravel();
  else travelRows = [];
  renderGapsCard(true);
  renderWarnings();
  renderResults();
  updateChart();
}

function clearSelection() {
  eventStart = null; eventEnd = null; clickStage = 0;
  setSelectionUi('Select the storm start and end by clicking twice on the chart, or use "Suggest Largest Event".', 'info');
  computeAll();
}

/* ============================================================
   CSV export
   ============================================================ */
function csvField(v) {
  const s = String(v == null ? '' : v);
  return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

function exportCSV() {
  const evSms = eventStart ? eventStart.getTime() : null;
  const evEms = eventEnd ? eventEnd.getTime() : null;
  const L = [];

  L.push('# USACE Release Analysis — multi-gage storm comparison export');
  L.push('# Generated: ' + new Date().toISOString());
  L.push('# Event window (local): ' + (eventStart ? fmtDT(evSms) : '—') + ' to ' + (eventEnd ? fmtDT(evEms) : '—'));
  L.push('# Volume basis for ratios: ' + volumeBasis);
  L.push('');
  L.push('# GAGE SUMMARY');
  L.push('order,label,site_id,site_name,drainage_area_sqmi,interval_sec,peak_cfs,peak_time_local,first_rise_local,direct_storm_vol_AF,total_vol_AF,pct_of_upstream,baseline_method,gap_summary');
  const okG = gages.filter((g) => g.ok);
  okG.forEach((g, i) => {
    const up = gages[0];
    const vol = g.results ? (volumeBasis === 'direct' ? g.results.directAF : g.results.totalAF) : null;
    const upVol = up && up.results ? (volumeBasis === 'direct' ? up.results.directAF : up.results.totalAF) : null;
    const pct = (i > 0 && g.results && up.results && upVol) ? (vol / upVol * 100) : (i === 0 ? 100 : null);
    L.push([
      i + 1, csvField(g.label || g.id), g.id,
      csvField(g.meta ? g.meta.name : ''), g.meta && g.meta.da != null ? g.meta.da : '',
      g.intervalSec,
      g.results ? g.results.peak.toFixed(2) : '', g.results ? fmtDT(g.results.peakTimeMs) : '',
      g.results && g.results.riseTimeMs != null ? fmtDT(g.results.riseTimeMs) : '',
      g.results ? g.results.directAF.toFixed(3) : '', g.results ? g.results.totalAF.toFixed(3) : '',
      pct == null ? '' : pct.toFixed(1), csvField(g.results ? describeBaseline(g) : ''),
      g.results ? csvField(gapSummary(g, evSms, evEms).text) : ''
    ].join(','));
  });

  L.push('');
  L.push('# TRAVEL TIME (per reach)');
  L.push('reach,pair,first_rise_delay_minutes,peak_delay_minutes,centroid_delay_minutes,xcorr_lag_minutes,xcorr_r,distance_mi,velocity_mph');
  travelRows.forEach((row) => {
    const pair = row.label + ' -> ' + row.labelB;
    L.push([
      row.isCumulative ? 'CUMULATIVE' : 'adjacent',
      csvField(pair),
      row.riseDelayMs != null ? (row.riseDelayMs / 60000).toFixed(1) : '',
      row.peakDelayMs != null ? (row.peakDelayMs / 60000).toFixed(1) : '',
      row.centDelayMs != null ? (row.centDelayMs / 60000).toFixed(1) : '',
      row.xc ? (row.xc.lagMs / 60000).toFixed(1) : '',
      row.xc ? row.xc.r.toFixed(3) : '',
      row.distMi != null ? row.distMi.toFixed(2) : '',
      row.velMph != null ? row.velMph.toFixed(2) : ''
    ].join(','));
  });

  L.push('');
  L.push('# FULL SERIES (one block per gage; includes filled readings, flagged)');
  L.push('# value_source: measured | fill method used');
  for (const g of okG) {
    L.push('# Series: ' + g.id + (g.label ? ' ("' + g.label + '")' : ''));
    L.push('site_id,label,time_utc,discharge_cfs,value_source');
    for (const r of g.readings) {
      L.push([g.id, csvField(g.label || ''), new Date(r.t).toISOString(), r.v.toFixed(2), r.f ? csvField(r.f) : 'measured'].join(','));
    }
    L.push('');
  }

  const blob = new Blob([L.join('\r\n')], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  const stamp = moment().format('YYYYMMDD-HHmm');
  a.href = url;
  a.download = 'usace-release-analysis-' + stamp + '.csv';
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
  showStatus('CSV exported (' + (a.download) + '). Includes per-gage summary, travel rows, and full series with fill flags.', 'success');
}

/* ============================================================
   HTML report export — self-contained file with embedded chart
   images (PNG data URLs), volume & travel tables. Excludes the
   interactive config cards (baseline separation, gap fills);
   travel times lead with the peak-to-peak method.
   ============================================================ */
const REPORT_CSS =
  ':root{--border:#e2e8f0;--muted:#64748b;--main:#0f172a;}' +
  'body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Arial,sans-serif;color:var(--main);margin:0;background:#f8fafc;padding-bottom:40px;}' +
  '.rpt-wrap{max-width:1200px;margin:0 auto;padding:24px;}' +
  '.rpt-band{background:linear-gradient(135deg,#0369a1,#0284c7);color:#fff;border-radius:10px;padding:20px 26px;margin-bottom:22px;display:flex;justify-content:space-between;align-items:center;gap:16px;flex-wrap:wrap;}' +
  '.rpt-band h1{font-size:1.35rem;margin:0;letter-spacing:-0.02em;}' +
  '.rpt-band .sub{font-size:0.78rem;opacity:0.92;margin-top:3px;}' +
  '.rpt-band .tag{font-size:0.72rem;background:rgba(255,255,255,0.16);padding:3px 10px;border-radius:12px;white-space:nowrap;}' +
  'h2{font-size:1.02rem;margin:26px 0 10px;}' +
  '.meta{font-size:0.8rem;color:var(--muted);margin:4px 0 12px;line-height:1.6;}' +
  '.kpi-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(190px,1fr));gap:12px;margin-bottom:8px;}' +
  '.kpi{border:1px solid var(--border);border-radius:8px;padding:12px 14px;background:#fff;}' +
  '.kpi .kpi-label{font-size:0.66rem;font-weight:700;color:var(--muted);text-transform:uppercase;letter-spacing:0.05em;}' +
  '.kpi .kpi-value{font-size:1.2rem;font-weight:700;margin-top:3px;}' +
  '.kpi .kpi-sub{font-size:0.72rem;color:var(--muted);margin-top:2px;}' +
  'img.chart-img{width:100%;height:auto;background:#fff;border:1px solid var(--border);border-radius:8px;}' +
  '.legend{display:flex;gap:14px;flex-wrap:wrap;font-size:0.78rem;color:var(--muted);margin:8px 2px;align-items:center;}' +
  '.legend .sw{width:18px;height:4px;border-radius:2px;display:inline-block;vertical-align:middle;}' +
  '.legend .dot{width:8px;height:8px;border-radius:50%;display:inline-block;vertical-align:middle;}' +
  'table.data-table{width:100%;border-collapse:collapse;font-size:0.8rem;background:#fff;}' +
  'table.data-table th{text-align:left;font-size:0.68rem;text-transform:uppercase;letter-spacing:0.05em;color:var(--muted);padding:7px 8px;border-bottom:2px solid var(--border);white-space:nowrap;}' +
  'table.data-table td{padding:7px 8px;border-bottom:1px solid #f1f5f9;vertical-align:top;}' +
  'table.data-table td.num,table.data-table th.num{text-align:right;font-variant-numeric:tabular-nums;}' +
  'table.data-table tr:last-child td{border-bottom:none;}' +
  'table.data-table .subtle{color:var(--muted);font-size:0.74rem;}' +
  '.tag-pill{font-size:0.66rem;font-weight:700;padding:2px 7px;border-radius:9px;white-space:nowrap;}' +
  '.tag-loss{background:#fef2f2;color:#991b1b;}' +
  '.tag-gain{background:#f0fdf4;color:#166534;}' +
  '.tag-even{background:#f8fafc;color:var(--muted);}' +
  '.tag-gap{background:#fff7ed;color:#c2410c;}' +
  '.tag-ok{background:#f0fdf4;color:#166534;}' +
  '.warn-list{list-style:none;padding:0;margin:0;}' +
  '.warn-list li{font-size:0.78rem;color:#92400e;background:#fffbeb;border:1px solid #fde68a;border-radius:5px;padding:6px 9px;margin-top:5px;}' +
  '.warn-list li.ok{color:#166534;background:#f0fdf4;border-color:#86efac;}' +
  '.doc-body{font-size:0.78rem;color:#334155;line-height:1.65;}' +
  '.doc-body ul,.doc-body ol{padding-left:20px;margin:6px 0;}' +
  'code{background:#f1f5f9;border-radius:4px;padding:1px 5px;font-size:0.76rem;}' +
  '.foot{font-size:0.73rem;color:var(--muted);margin-top:24px;border-top:1px solid var(--border);padding-top:12px;line-height:1.6;}' +
  '@media print{body{background:#fff;}.rpt-wrap{max-width:100%;padding:0;}img.chart-img{page-break-inside:avoid;}}';

function liveTableHeadHtml(tbodyId) {
  const tb = document.getElementById(tbodyId);
  if (!tb) return '';
  const t = tb.closest ? tb.closest('table') : null;
  const th = (t && t.querySelector) ? t.querySelector('thead') : null;
  return th ? th.innerHTML : '';
}

/* Preferred operational delay for a travel row: see operDelayMs */

function buildReportHtml() {
  if (!eventStart || !eventEnd) return null;
  const evSms = eventStart.getTime(), evEms = eventEnd.getTime();
  const okG = gages.filter((g) => g.ok && g.results);
  const basisName = volumeBasis === 'direct' ? 'Direct storm volume' : 'Total volume above zero';
  const basisVol = (r) => volumeBasis === 'direct' ? r.directAF : r.totalAF;
  const up = okG[0], down = okG[okG.length - 1];

  /* --- header --- */
  let html = '<!doctype html><html lang="en"><head><meta charset="utf-8"/>' +
    '<title>USACE Release Analysis Report — ' + moment().format('YYYY-MM-DD HH:mm') + '</title>' +
    '<style>' + REPORT_CSS + '</style></head><body><div class="rpt-wrap">';
  html += '<div class="rpt-band"><div><h1>USACE Release Analysis — Storm Release Report</h1>' +
    '<div class="sub">' + okG.map((g) => esc(g.label || g.id)).join(' → ') + '</div></div>' +
    '<span class="tag">Generated ' + moment().format('YYYY-MM-DD HH:mm') + ' (local)</span></div>';

  /* --- event / basis meta --- */
  html += '<div class="meta"><strong>Event window:</strong> ' + esc(fmtDT(evSms)) + ' → ' + esc(fmtDT(evEms)) +
    ' (' + esc(fmtDur((evEms - evSms) / 1000)) + '), browser-local time. ' +
    '<strong>Volume basis:</strong> ' + esc(basisName) + '. ' +
    '<strong>Data:</strong> USGS Water Data OGC API, continuous instantaneous discharge (parameter 00060, cfs).' + '</div>';

  /* --- KPI cards (peak-to-peak travel) --- */
  html += '<div class="kpi-grid">';
  html += '<div class="kpi"><div class="kpi-label">Event window</div><div class="kpi-value">' + esc(fmtDur((evEms - evSms) / 1000)) + '</div>' +
    '<div class="kpi-sub">' + esc(fmtDT(evSms)) + ' → ' + esc(fmtDT(evEms)) + '</div></div>';
  if (up && up.results) {
    html += '<div class="kpi"><div class="kpi-label">' + esc(up.label || up.id) + ' — upstream volume</div>' +
      '<div class="kpi-value">' + esc(fmtNum(basisVol(up.results), 1)) + ' AF</div>' +
      '<div class="kpi-sub">peak ' + esc(fmtNum(up.results.peak, 1)) + ' cfs at ' + esc(fmtDT(up.results.peakTimeMs)) + '</div></div>';
  }
  if (down && down !== up && down.results) {
    html += '<div class="kpi"><div class="kpi-label">' + esc(down.label || down.id) + ' — downstream volume</div>' +
      '<div class="kpi-value">' + esc(fmtNum(basisVol(down.results), 1)) + ' AF</div>' +
      '<div class="kpi-sub">peak ' + esc(fmtNum(down.results.peak, 1)) + ' cfs at ' + esc(fmtDT(down.results.peakTimeMs)) + '</div></div>';
  }
  if (up && down && down !== up && basisVol(up.results) > 0) {
    const ratio = basisVol(down.results) / basisVol(up.results) * 100;
    html += '<div class="kpi"><div class="kpi-label">Volume ratio (down ÷ up)</div><div class="kpi-value">' + ratio.toFixed(0) + '%</div>' +
      '<div class="kpi-sub">' + esc(basisName) + '</div></div>';
  }
  const cum = travelRows.find((r) => r.isCumulative) || (travelRows.length ? travelRows[travelRows.length - 1] : null);
  if (cum) {
    const d = operDelayMs(cum);
    if (d != null) {
      html += '<div class="kpi"><div class="kpi-label">Travel time (first → last gage)</div>' +
        '<div class="kpi-value">' + esc(fmtDelay(d)) + '</div><div class="kpi-sub">peak-to-peak basis</div></div>';
    }
    if (cum.riseDelayMs != null) {
      html += '<div class="kpi"><div class="kpi-label">Operational lead time (first → last gage)</div>' +
        '<div class="kpi-value">' + esc(fmtDelay(cum.riseDelayMs)) + '</div>' +
        '<div class="kpi-sub">first-rise (leading-edge) arrival</div></div>';
    }
  }
  html += '</div>';

  /* --- hydrograph image --- */
  if (chart && chart.canvas && chart.canvas.toDataURL) {
    html += '<h2>Hydrograph overlay</h2>' +
      '<img class="chart-img" alt="Overlay hydrograph of all gages with event window and gap shading" src="' + chart.canvas.toDataURL('image/png') + '"/>' +
      '<div class="legend">';
    okG.forEach((g, i) => {
      const c = GAGE_COLORS[i % GAGE_COLORS.length];
      html += '<span class="chip"><span class="sw" style="background:' + c + '"></span> ' + esc(g.label || g.id) + ' (' + esc(g.id) + ')</span>';
    });
    html += '<span><span class="dot" style="background:' + FILL_COLOR + '"></span> gap-filled reading (orange)</span>' +
      '<span>shaded bands: gaps (hatched = unfilled), blue tint: event window</span></div>';
  }

  /* --- volume table (embedded live table) --- */
  html += '<h2>Volume comparison</h2>' +
    '<table class="data-table"><thead>' + liveTableHeadHtml('volumesBody') + '</thead><tbody>' +
    (document.getElementById('volumesBody') ? document.getElementById('volumesBody').innerHTML : '') +
    '</tbody></table>';

  /* --- bar chart image --- */
  if (barChart && barChart.canvas && barChart.canvas.toDataURL) {
    html += '<h2>Direct storm volume by gage (acre-feet)</h2>' +
      '<img class="chart-img" alt="Bar chart of direct storm volume by gage, labeled in acre-feet" src="' + barChart.canvas.toDataURL('image/png') + '"/>';
  }

  /* --- travel table (first-rise + peak-to-peak primary) --- */
  html += '<h2>Travel time between gages</h2>' +
    '<table class="data-table"><thead><tr><th>Reach (upstream → downstream)</th><th class="num">First-rise delay</th>' +
    '<th class="num">Peak-to-peak delay</th><th class="num">Cross-correlation lag</th><th class="num">Similarity r</th>' +
    '<th class="num">Gage distance (mi)</th><th class="num">Wave speed</th></tr></thead><tbody>';
  for (const row of travelRows) {
    const reach = '<strong>' + esc(row.label) + '</strong> → <strong>' + esc(row.labelB) + '</strong>' +
      (row.isCumulative ? ' <span class="tag-pill tag-even">cumulative</span>' : '');
    if (!row.aOk || !row.bOk) {
      html += '<tr><td>' + reach + ' <span class="subtle">— ' + esc(row.note) + '</span></td>' +
        '<td class="num">n/a</td><td class="num">n/a</td><td class="num">n/a</td><td class="num">n/a</td><td class="num">—</td><td class="num">—</td></tr>';
      continue;
    }
    const d = operDelayMs(row);
    const vel = (row.distMi != null && d) ? row.distMi / (d / 3600e3) : null;
    html += '<tr><td>' + reach + '</td>' +
      '<td class="num" style="font-weight:600"' + (row.riseNote ? ' title="' + esc(row.riseNote) + '"' : '') + '>' +
      (row.riseDelayMs != null ? esc(fmtDelay(row.riseDelayMs)) : 'n/a') + '</td>' +
      '<td class="num">' + (row.peakDelayMs != null ? esc(fmtDelay(row.peakDelayMs)) : 'n/a') + '</td>' +
      '<td class="num">' + (row.xc ? esc(fmtDelay(row.xc.lagMs)) : 'n/a') + '</td>' +
      '<td class="num">' + (row.xc ? row.xc.r.toFixed(3) : 'n/a') + '</td>' +
      '<td class="num">' + (row.distMi != null ? row.distMi.toFixed(1) + ' (straight-line)' : '—') + '</td>' +
      '<td class="num">' + (vel != null ? vel.toFixed(1) + ' mph' : '—') + '</td></tr>';
  }
  html += '</tbody></table>';
  html += '<div class="meta" style="margin-top:8px;">Wave speed uses the peak-to-peak delay and straight-line gage separation (river distance is longer — treat speeds as upper bounds). Cross-correlation lag searches up to the configured maximum on a grid no finer than the gage interval.</div>';

  /* --- gage metadata --- */
  html += '<h2>Gages analyzed</h2><table class="data-table"><thead><tr><th>#</th><th>Gage</th>' +
    '<th>USGS ID</th><th>Name</th><th class="num">Drainage area (mi²)</th><th class="num">Interval</th>' +
    '<th class="num">Readings</th><th>Record span (local)</th></tr></thead><tbody>';
  gages.forEach((g, i) => {
    if (!g.ok) {
      html += '<tr><td>' + (i + 1) + '</td><td>' + esc(g.label || g.id) + '</td><td>' + esc(g.id) + '</td>' +
        '<td colspan="5" class="subtle" style="color:#991b1b">failed: ' + esc(g.err || 'no data') + '</td></tr>';
      return;
    }
    html += '<tr><td>' + (i + 1) + '</td><td>' + esc(g.label || g.id) + '</td><td>' + esc(g.id) + '</td>' +
      '<td>' + esc(g.meta && g.meta.name ? g.meta.name : '') + '</td>' +
      '<td class="num">' + (g.meta && g.meta.da != null ? fmtNum(g.meta.da, 0) : '—') + '</td>' +
      '<td class="num">~' + Math.round(g.intervalSec / 60) + ' min</td>' +
      '<td class="num">' + g.readings.length.toLocaleString() + '</td>' +
      '<td>' + esc(fmtDT(g.readings[0].t)) + ' → ' + esc(fmtDT(g.readings[g.readings.length - 1].t)) + '</td></tr>';
  });
  html += '</tbody></table>';

  /* --- diagnostics & method notes --- */
  const warnEl = document.getElementById('warningsContainer');
  if (warnEl && warnEl.innerHTML) {
    // strip app-navigation phrasing that makes no sense in a standalone file
    const warnHtml = warnEl.innerHTML
      .split('— choose a fill action in Step 5 or accept the reduced accuracy.').join('');
    html += '<h2>Diagnostics &amp; data-quality notes</h2>' + warnHtml;
  }
  const docEl = document.querySelector('details.method-doc .doc-body');
  if (docEl && docEl.innerHTML) {
    html += '<h2>Method notes</h2><div class="doc-body">' + docEl.innerHTML + '</div>';
  } else {
    html += '<h2>Method notes</h2><div class="doc-body">' +
      '<p><strong>Volume.</strong> Direct storm volume integrates max(0, Q − baseline); total integrates raw Q. AF = cfs × Δt (s) / 43,560; 1 cfs-day = 1.98347 AF.</p>' +
      '<p><strong>Travel time.</strong> Peak-to-peak: event-window peak time difference between gages.</p></div>';
  }

  html += '<div class="foot">Report generated by USACE Release Analysis from live USGS Water Data (OGC API — continuous instantaneous discharge, parameter 00060). ' +
    'Provisional values are subject to revision. Unfilled gaps are excluded from integration and flagged in the tables above. ' +
    'Not for design or permitting decisions without independent verification.</div>';
  html += '</div></body></html>';
  return html;
}

function exportReport() {
  const html = buildReportHtml();
  if (!html) {
    showStatus('Select an event window first — the report needs volumes and travel times.', 'error');
    return;
  }
  const blob = new Blob([html], { type: 'text/html;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  const stamp = moment().format('YYYYMMDD-HHmm');
  a.href = url;
  a.download = 'usace-release-report-' + stamp + '.html';
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
  showStatus('HTML report exported (<strong>usace-release-report-' + stamp + '.html</strong>) — self-contained, opens in any browser and prints cleanly.', 'success');
}

/* ============================================================
   Configuration save / load (.json)
   Persists the gage list & order, data window, event window,
   per-gage baseline methods & parameters, per-gap fill
   decisions, volume basis and max-lag setting — everything
   needed to reproduce (or hand off) the analysis setup.
   ============================================================ */
function saveConfig() {
  const rows = readRowsFromDom().map((r) => ({
    label: r.label,
    id: normalizeGageId(r.id) || r.id
  }));
  if (rows.length < 2) {
    showStatus('Add at least two gage rows before saving a configuration.', 'error');
    return;
  }
  const startVal = document.getElementById('startDateInput').value;
  const endVal = document.getElementById('endDateInput').value;
  if (!startVal || !endVal) {
    showStatus('Set the data window (start and end) before saving a configuration.', 'error');
    return;
  }

  const cfg = {
    app: 'USACE Release Analysis',
    version: 1,
    savedAt: new Date().toISOString(),
    rows: rows,
    window: { start: new Date(startVal).toISOString(), end: new Date(endVal).toISOString() },
    volumeBasis: volumeBasis,
    lagHours: Number((document.getElementById('lagHours') || {}).value) || 24,
    event: (eventStart && eventEnd)
      ? { start: eventStart.toISOString(), end: eventEnd.toISOString() }
      : null,
    baselines: {},
    fills: {}
  };
  for (const g of gages) {
    if (!g.ok) continue;
    cfg.baselines[g.id] = {
      method: g.baseline.method,
      flatHours: Number(g.baseline.flatHours),
      diurnalDays: Number(g.baseline.diurnalDays),
      linearHours: Number(g.baseline.linearHours),
      manualCfs: Number(g.baseline.manualCfs)
    };
    if (g.gaps.length) {
      // Every detected gap is stored (including "" = leave as gap) so fill decisions round-trip.
      cfg.fills[g.id] = g.gaps.map((gp) => ({ t0: gp.t0, t1: gp.t1, fill: gp.fill || '' }));
    }
  }

  const blob = new Blob([JSON.stringify(cfg, null, 2)], { type: 'application/json;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  const stamp = moment().format('YYYYMMDD-HHmm');
  a.href = url;
  a.download = 'usace-release-config-' + stamp + '.json';
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
  showStatus('Configuration saved (<strong>' + a.download + '</strong>) — gages, data window, event window, baselines, gap fills, volume basis and lag. Restore it any time with <strong>Load Config</strong>.', 'success');
}

function isUsaceConfig(cfg) {
  return !!(cfg && cfg.app === 'USACE Release Analysis' &&
    Array.isArray(cfg.rows) && cfg.rows.length >= 2);
}

function loadConfigFile(file) {
  const reader = new FileReader();
  reader.onload = () => {
    let cfg;
    try {
      cfg = JSON.parse(String(reader.result));
    } catch (e) {
      showStatus('Could not read configuration: the file is not valid JSON.', 'error');
      return;
    }
    if (!isUsaceConfig(cfg)) {
      showStatus('Could not load configuration: this is not a USACE Release Analysis configuration file (missing "app" or "rows").', 'error');
      return;
    }
    applyConfig(cfg);
  };
  reader.onerror = () => showStatus('Could not read the configuration file.', 'error');
  reader.readAsText(file);
}

/* ---------- Published configurations (configs/index.json) ----------
   Static configs shipped with the site.  Users pick one from the
   card above Step 1; the JSON is fetched from the same origin and
   fed through the normal Load Config pipeline. */

function normalizeSavedConfigIndex(data) {
  const list = Array.isArray(data)
    ? data
    : (data && Array.isArray(data.configs) ? data.configs : []);
  const seen = new Set();
  const out = [];
  for (const entry of list) {
    if (!entry || typeof entry.file !== 'string') continue;
    const file = entry.file.trim().replace(/\\/g, '/').replace(/^\.?\//, '');
    // Only permit simple relative JSON paths inside configs/.
    if (!file || file.length > 200 || file.indexOf('..') >= 0 ||
        !/^[A-Za-z0-9][A-Za-z0-9._/-]*\.json$/i.test(file)) continue;
    if (seen.has(file)) continue;
    seen.add(file);
    const label = entry.label == null ? '' : String(entry.label).trim();
    out.push({
      label: label || file,
      file: file,
      description: entry.description == null ? '' : String(entry.description).trim()
    });
  }
  return out;
}

function savedConfigUrl(file) {
  return SAVED_CONFIG_BASE + String(file).split('/').map(encodeURIComponent).join('/');
}

async function loadSavedConfigIndex() {
  const sel = document.getElementById('savedConfigSelect');
  if (!sel) return;
  const desc = document.getElementById('savedConfigDesc');
  const setDesc = (txt) => { if (desc) desc.textContent = txt; };
  if (typeof fetch !== 'function') {
    sel.innerHTML = '<option value="">Saved configurations unavailable</option>';
    sel.title = 'Serve the app over HTTP to load published configurations.';
    setDesc('Published configurations need the app served over HTTP. Set up manually below.');
    return;
  }
  savedConfigs = [];
  sel.disabled = true;
  sel.innerHTML = '<option value="">Loading saved configurations…</option>';
  try {
    const res = await fetch(SAVED_CONFIG_BASE + 'index.json', { cache: 'no-cache' });
    if (!res || !res.ok) throw new Error('HTTP ' + (res ? res.status : 'error'));
    savedConfigs = normalizeSavedConfigIndex(await res.json());
    if (!savedConfigs.length) {
      sel.innerHTML = '<option value="">No saved configurations published</option>';
      sel.title = 'Add configuration files to the configs folder and list them in configs/index.json.';
      setDesc('No published configurations are available right now. Set up manually below.');
      return;
    }
    sel.innerHTML = '<option value="">Choose a saved configuration…</option>' +
      savedConfigs.map((c) =>
        '<option value="' + esc(c.file) + '"' +
        (c.description ? ' title="' + esc(c.description) + '"' : '') + '>' +
        esc(c.label) + '</option>').join('');
    sel.disabled = false;
    sel.title = 'Select a configuration and click Load configuration to re-fetch its gages and restore the saved analysis settings.';
  } catch (e) {
    sel.innerHTML = '<option value="">Saved configurations unavailable</option>';
    sel.title = 'Could not load configs/index.json: ' + String(e && e.message ? e.message : e);
    setDesc('Published configurations could not be loaded. Set up manually below.');
    if (typeof console !== 'undefined' && console.warn) {
      console.warn('Saved configurations unavailable:', e);
    }
  }
}

async function loadSavedConfig(file) {
  const entry = savedConfigs.find((c) => c.file === file);
  if (!entry) return;
  const req = ++savedConfigReq;
  showStatus('Loading saved configuration <strong>' + esc(entry.label) + '</strong>…', 'info');
  try {
    const res = await fetch(savedConfigUrl(entry.file), { cache: 'no-cache' });
    if (!res || !res.ok) throw new Error('HTTP ' + (res ? res.status : 'error'));
    const cfg = await res.json();
    if (req !== savedConfigReq) return;   // a newer selection won
    if (!isUsaceConfig(cfg)) {
      showStatus('Saved configuration <strong>' + esc(entry.label) +
        '</strong> is not a valid USACE Release Analysis configuration (missing "app" or "rows").', 'error');
      return;
    }
    applyConfig(cfg);
  } catch (e) {
    if (req !== savedConfigReq) return;
    showStatus('Could not load saved configuration <strong>' + esc(entry.label) + '</strong>: ' +
      esc(e && e.message ? e.message : e) + '.', 'error');
  }
}

/* Put the saved form state back into Step 1 and trigger a fresh fetch. */
function applyConfig(cfg) {
  gageRowsArr = cfg.rows.map((r) => makeRow(
    r && r.label ? String(r.label) : '',
    r && r.id ? String(r.id) : ''
  ));
  renderSiteRows();
  try {
    if (cfg.window && cfg.window.start) {
      document.getElementById('startDateInput').value = moment(cfg.window.start).format('YYYY-MM-DDTHH:mm');
    }
    if (cfg.window && cfg.window.end) {
      document.getElementById('endDateInput').value = moment(cfg.window.end).format('YYYY-MM-DDTHH:mm');
    }
  } catch (e) { /* keep whatever the form already holds */ }

  pendingConfig = cfg;
  showStatus('Configuration accepted — fetching ' + cfg.rows.length + ' gages over the saved window, then re-applying baselines, gap fills, event window and basis…', 'info');
  loadAllData();
}

/* Called at the end of a successful loadAllData() when a config was staged. */
function applyPendingConfig() {
  const cfg = pendingConfig;
  if (!cfg) return;
  pendingConfig = null;
  const notes = [];

  if (cfg.volumeBasis === 'direct' || cfg.volumeBasis === 'total') {
    volumeBasis = cfg.volumeBasis;
    const rd = document.getElementById('rBasisDirect');
    const rt = document.getElementById('rBasisTotal');
    if (rd) rd.checked = volumeBasis === 'direct';
    if (rt) rt.checked = volumeBasis === 'total';
    const ld = document.getElementById('lblBasisDirect');
    const lt = document.getElementById('lblBasisTotal');
    if (ld) ld.classList.toggle('on', volumeBasis === 'direct');
    if (lt) lt.classList.toggle('on', volumeBasis === 'total');
    notes.push(volumeBasis + ' volume basis');
  }

  if (cfg.lagHours) {
    const lagEl = document.getElementById('lagHours');
    const lv = Number(cfg.lagHours);
    if (lagEl && Number.isFinite(lv) && lv > 0) { lagEl.value = lv; notes.push('max lag ' + lv + ' h'); }
  }

  let nBase = 0;
  for (const g of gages) {
    if (!g.ok) continue;
    const b = cfg.baselines && cfg.baselines[g.id];
    if (!b) continue;
    if (b.method && BASELINE_METHODS.some((m) => m.key === b.method)) g.baseline.method = b.method;
    ['flatHours', 'diurnalDays', 'linearHours', 'manualCfs'].forEach((k) => {
      const v = Number(b[k]);
      if (Number.isFinite(v)) g.baseline[k] = v;
    });
    nBase++;
  }
  if (nBase) notes.push(nBase + ' baseline' + (nBase > 1 ? 's' : ''));

  let nFills = 0;
  for (const g of gages) {
    if (!g.ok || !g.gaps.length) continue;
    const list = cfg.fills && cfg.fills[g.id];
    if (!Array.isArray(list)) continue;
    for (const gap of g.gaps) {
      const m = list.find((f) => f && Math.abs(Number(f.t0) - gap.t0) < 120000 && Math.abs(Number(f.t1) - gap.t1) < 120000);
      if (m) { gap.fill = m.fill || ''; nFills++; }
    }
  }
  if (nFills) notes.push(nFills + ' gap fill' + (nFills > 1 ? 's' : ''));
  applyAllFills();

  if (cfg.event && cfg.event.start && cfg.event.end) {
    const s = new Date(cfg.event.start);
    const e2 = new Date(cfg.event.end);
    if (!isNaN(s.getTime()) && !isNaN(e2.getTime()) && e2 > s) {
      eventStart = s;
      eventEnd = e2;
      clickStage = 2;
      setSelectionUi('Restored event window: <strong>' + esc(fmtDT(s.getTime())) + '</strong> → <strong>' + esc(fmtDT(e2.getTime())) + '</strong> (local). Click the chart to adjust.', 'success');
      notes.push('event window');
    }
  }

  computeAll();
  renderBaselinesCard();
  showStatus('Saved configuration applied — ' + (notes.length ? notes.join(' · ') : 'form settings') + '. Adjust anything and results update instantly.', 'success');
}
