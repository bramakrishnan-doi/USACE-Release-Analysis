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
let lastForecast = null;    // most recent routed arrival forecast (UI + CSV + report reuse it)
let forecastSourceId = null;
let forecastTargetId = null;

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
  calibrateForecastModel();
  renderGapsCard(true);
  renderWarnings();
  renderResults();
  if (typeof renderForecast === 'function') renderForecast();
  updateChart();
}

function clearSelection() {
  eventStart = null; eventEnd = null; clickStage = 0;
  setSelectionUi('Select the storm start and end by clicking twice on the chart, or use "Suggest Largest Event".', 'info');
  computeAll();
}

/* ============================================================
   Downstream Arrival Forecast
   ------------------------------------------------------------
   Calibrates transmission loss (initial abstraction + dynamic
   conveyance efficiency) and wave routing (front/crest lag,
   peak attenuation, recession dispersion) from the selected
   historical event, then routes a proposed source hydrograph
   to the selected downstream gage.
   ============================================================ */
const FORECAST_DEFAULTS = {
  frontLagHours: 140,
  crestLagHours: 96,
  peakAttenuationRatio: 0.42,
  dispersionK: 0.02,
  initialAbstractionAF: 10000,
  conveyanceEfficiency: 0.23,
  seasonalityETFactor: 1.10,
  antecedentMoistureFactor: 1.00,
  releaseScale: 1.00
};

const CalibrationModel = {
  calibrated: false,
  sourceId: null,
  targetId: null,
  sourceLabel: '',
  targetLabel: '',
  eventLabel: '',
  initialAbstractionAF: FORECAST_DEFAULTS.initialAbstractionAF,
  conveyanceEfficiency: FORECAST_DEFAULTS.conveyanceEfficiency,
  frontLagHours: FORECAST_DEFAULTS.frontLagHours,
  crestLagHours: FORECAST_DEFAULTS.crestLagHours,
  peakAttenuationRatio: FORECAST_DEFAULTS.peakAttenuationRatio,
  dispersionK: FORECAST_DEFAULTS.dispersionK,
  releaseAF: 0,
  arrivedAF: 0,
  netRecoveryPct: 0,
  calibrationSource: 'Not calibrated — load at least two gages and select an event window.',
  seasonalityETFactor: FORECAST_DEFAULTS.seasonalityETFactor,
  antecedentMoistureFactor: FORECAST_DEFAULTS.antecedentMoistureFactor,
  releaseScale: FORECAST_DEFAULTS.releaseScale,
  tuning: {
    initialAbstractionAF: FORECAST_DEFAULTS.initialAbstractionAF,
    conveyanceEfficiency: FORECAST_DEFAULTS.conveyanceEfficiency,
    seasonalityETFactor: FORECAST_DEFAULTS.seasonalityETFactor,
    antecedentMoistureFactor: FORECAST_DEFAULTS.antecedentMoistureFactor,
    releaseScale: FORECAST_DEFAULTS.releaseScale
  },
  tuningDirty: false,
  tuningSignature: '',
  notes: []
};

function fcClamp(v, lo, hi) {
  return Math.max(lo, Math.min(hi, v));
}

function fcPad2(n) {
  return (n < 10 ? '0' : '') + n;
}

function fcMonthAbbr(m) {
  return ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][m] || '';
}

function fcDateTimeLocal(ms) {
  if (ms == null || !Number.isFinite(Number(ms))) return '—';
  const d = new Date(Number(ms));
  return fcMonthAbbr(d.getMonth()) + ' ' + d.getDate() + ', ' + d.getFullYear() + ' ' +
    fcPad2(d.getHours()) + ':' + fcPad2(d.getMinutes());
}

function fcDateTimeShort(ms) {
  const d = new Date(ms);
  return fcMonthAbbr(d.getMonth()) + ' ' + d.getDate() + ' ' + fcPad2(d.getHours()) + ':' + fcPad2(d.getMinutes());
}

function fcDayKey(ms) {
  const d = new Date(ms);
  return d.getFullYear() + '-' + fcPad2(d.getMonth() + 1) + '-' + fcPad2(d.getDate());
}

function fcDayLabel(ms) {
  const d = new Date(ms);
  return fcMonthAbbr(d.getMonth()) + ' ' + d.getDate() + ', ' + d.getFullYear();
}

/* Restore the tuning controls to the freshly calibrated values
   (user adjustments are deliberately not overwritten on every
   recompute, only when the calibration dataset/reach changes
   or the user presses Reset tuning). */
function resetForecastTuning() {
  const m = CalibrationModel;
  const ia = Number.isFinite(m.initialAbstractionAF) ? m.initialAbstractionAF : FORECAST_DEFAULTS.initialAbstractionAF;
  const ceff = Number.isFinite(m.conveyanceEfficiency) ? m.conveyanceEfficiency : FORECAST_DEFAULTS.conveyanceEfficiency;
  m.tuning = {
    initialAbstractionAF: Math.round(ia / 100) * 100,
    conveyanceEfficiency: Math.round(ceff * 1000) / 1000,
    seasonalityETFactor: FORECAST_DEFAULTS.seasonalityETFactor,
    antecedentMoistureFactor: FORECAST_DEFAULTS.antecedentMoistureFactor,
    releaseScale: FORECAST_DEFAULTS.releaseScale
  };
  m.seasonalityETFactor = m.tuning.seasonalityETFactor;
  m.antecedentMoistureFactor = m.tuning.antecedentMoistureFactor;
  m.releaseScale = m.tuning.releaseScale;
  m.tuningDirty = false;
}

/* Recompute every calibrated term from the current event window.
   Called by computeAll() after the per-gage volumes and travel
   times are refreshed, so data/baseline/gap edits recalibrate. */
function calibrateForecastModel() {
  const m = CalibrationModel;
  m.notes = [];
  m.calibrated = false;
  lastForecast = null;

  if (!eventStart || !eventEnd) {
    m.calibrationSource = 'Not calibrated — select a storm release window.';
    m.notes.push('Select an event window (Step 2) to calibrate the forecast.');
    return m;
  }
  const candidates = gages.filter((g) => g.ok && g.results);
  if (candidates.length < 2) {
    m.calibrationSource = 'Not calibrated — two gages with data are required.';
    m.notes.push('Load at least two gages with data in the event window to calibrate the forecast.');
    return m;
  }

  let src = candidates.find((g) => g.id === forecastSourceId);
  if (!src) src = candidates[0];
  const si = gages.indexOf(src);
  const downstream = gages.slice(si + 1).filter((g) => g.ok && g.results);
  if (!downstream.length) {
    m.calibrationSource = 'Not calibrated — no downstream gage with data.';
    m.notes.push('Choose a source gage that has a downstream gage after it in the gage list.');
    return m;
  }
  let tgt = downstream.find((g) => g.id === forecastTargetId);
  if (!tgt) tgt = downstream[downstream.length - 1];

  const sres = src.results;
  const tres = tgt.results;
  const evS = eventStart.getTime();
  const evE = eventEnd.getTime();
  const vRel = Math.max(0, Number(sres.directAF) || 0);
  const vArr = Math.max(0, Number(tres.directAF) || 0);
  if (!(vRel > 0)) {
    m.calibrationSource = 'Not calibrated — no release volume at the source gage.';
    m.notes.push('The source gage has no direct release volume in this window — adjust its baseline or the event window.');
    return m;
  }

  // Initial abstraction: source volume spent before the downstream wetting front arrives.
  const sRise = sres.riseTimeMs != null ? sres.riseTimeMs : evS;
  const tRise = tres.riseTimeMs;
  let ia = null;
  if (tRise != null && tRise > evS) {
    ia = integrateExcessAF(src, evS, Math.min(tRise, evE));
  }
  if (!(ia > 0)) {
    ia = Math.min(12000, vRel * 0.15);
    m.notes.push('Downstream first rise was not detected — initial abstraction fell back to ' +
      Math.round(ia).toLocaleString('en-US') + ' AF.');
  }
  ia = fcClamp(ia, 0, vRel * 0.85);

  // Dynamic conveyance efficiency: post-priming arrived ÷ released.
  let ceff = (vRel - ia) > 1e-6 ? vArr / (vRel - ia) : 0;
  if (!Number.isFinite(ceff)) ceff = 0;
  if (ceff > 0.95) {
    ceff = 0.95;
    m.notes.push('Conveyance efficiency exceeded 95% — clamped; check baseline separation at the downstream gage.');
  } else if (ceff < 0.02) {
    ceff = vArr > 0 ? Math.min(0.45, Math.max(0.02, vArr / Math.max(vRel, 1e-9))) : 0.02;
    m.notes.push('Conveyance efficiency was near zero — clamped to ' + (ceff * 100).toFixed(1) + '%; verify the downstream record and baseline.');
  }

  // Front lag: first-rise to first-rise. Crest lag: peak-to-peak.
  let frontH = (tRise != null && sRise != null) ? (tRise - sRise) / 3600e3 : FORECAST_DEFAULTS.frontLagHours;
  if (!Number.isFinite(frontH) || frontH <= 0) {
    frontH = FORECAST_DEFAULTS.frontLagHours;
    m.notes.push('Front lag could not be measured — using the ' + frontH + ' h default.');
  }
  let crestH = (sres.peakTimeMs != null && tres.peakTimeMs != null)
    ? (tres.peakTimeMs - sres.peakTimeMs) / 3600e3
    : FORECAST_DEFAULTS.crestLagHours;
  if (!Number.isFinite(crestH) || crestH <= 0) {
    crestH = FORECAST_DEFAULTS.crestLagHours;
    m.notes.push('Crest lag could not be measured — using the ' + crestH + ' h default.');
  }
  const riseToPeakH = sres.peakTimeMs != null ? Math.max(0, (sres.peakTimeMs - sRise) / 3600e3) : 0;
  if (frontH > riseToPeakH + crestH) {
    frontH = Math.max(1, riseToPeakH + crestH);
    m.notes.push('Front lag reduced to ' + frontH.toFixed(1) + ' h so the routed peak falls after first water arrival.');
  }

  // Peak attenuation: downstream peak excess ÷ upstream peak excess.
  let alpha = sres.peakExcess > 0 ? tres.peakExcess / sres.peakExcess : FORECAST_DEFAULTS.peakAttenuationRatio;
  if (!Number.isFinite(alpha) || alpha <= 0) alpha = FORECAST_DEFAULTS.peakAttenuationRatio;
  alpha = fcClamp(alpha, 0.02, 1.5);

  // Recession decay rate from the downstream hydrograph (bank-storage tail).
  let k = estimateRecessionK(tgt, tres);
  if (!Number.isFinite(k) || k <= 0) k = FORECAST_DEFAULTS.dispersionK;

  const netRecoveryPct = vRel > 0 ? (100 * vArr) / vRel : 0;
  const srcLabel = src.label || src.id;
  const tgtLabel = tgt.label || tgt.id;
  const eventLabel = fcDateTimeLocal(evS) + ' → ' + fcDateTimeLocal(evE);

  m.calibrated = true;
  m.sourceId = src.id;
  m.targetId = tgt.id;
  m.sourceLabel = srcLabel;
  m.targetLabel = tgtLabel;
  m.eventLabel = eventLabel;
  m.initialAbstractionAF = ia;
  m.conveyanceEfficiency = ceff;
  m.frontLagHours = frontH;
  m.crestLagHours = crestH;
  m.peakAttenuationRatio = alpha;
  m.dispersionK = k;
  m.releaseAF = vRel;
  m.arrivedAF = vArr;
  m.netRecoveryPct = netRecoveryPct;
  m.calibrationSource = 'Calibrated from ' + eventLabel + ': ' + netRecoveryPct.toFixed(1) +
    '% net recovery (' + srcLabel + ' → ' + tgtLabel + ')';
  forecastSourceId = src.id;
  forecastTargetId = tgt.id;

  // Reset user tuning only when the calibration dataset/reach changes.
  const sig = [evS, evE, src.id, tgt.id, src.readings.length, tgt.readings.length,
    src.gaps.map((g) => g.fill || '').join('/'), tgt.gaps.map((g) => g.fill || '').join('/'),
    JSON.stringify(src.baseline), JSON.stringify(tgt.baseline),
    Math.round(vRel * 100), Math.round(vArr * 100), Math.round(ia * 100),
    Math.round(ceff * 1e4), Math.round(frontH * 100), Math.round(crestH * 100),
    Math.round(alpha * 1e4), Math.round(k * 1e5)].join('|');
  if (sig !== m.tuningSignature) {
    m.tuningSignature = sig;
    resetForecastTuning();
  }
  return m;
}

/* Integrate the source's baseline-removed flow over [t0, t1], in AF. */
function integrateExcessAF(site, t0, t1) {
  const iv = site && site.results ? site.results.intervals : null;
  if (!iv || iv.length < 2 || !(t1 > t0)) return 0;
  let af = 0;
  for (let i = 0; i < iv.length - 1; i++) {
    const a = iv[i], b = iv[i + 1];
    const s = Math.max(a.t, t0), e = Math.min(b.t, t1);
    if (!(e > s)) continue;
    const exA = Math.max(0, a.q - a.base);
    const exB = Math.max(0, b.q - b.base);
    const span = Math.max(1, b.t - a.t);
    const f0 = (s - a.t) / span;
    const f1 = (e - a.t) / span;
    const q0 = exA + (exB - exA) * f0;
    const q1 = exA + (exB - exA) * f1;
    af += (q0 + q1) / 2 * ((e - s) / 1000) / 43560;
  }
  return af;
}

/* Exponential recession rate k (per hour) from the downstream hydrograph. */
function estimateRecessionK(site, res) {
  if (!res || res.peakTimeMs == null || !(res.peakExcess > 0)) return FORECAST_DEFAULTS.dispersionK;
  const thr = 0.05 * res.peakExcess;
  let n = 0, sx = 0, sy = 0, sxx = 0, sxy = 0;
  for (const p of res.intervals) {
    if (p.t <= res.peakTimeMs) continue;
    const ex = Math.max(0, p.q - p.base);
    if (ex < thr) continue;
    const x = (p.t - res.peakTimeMs) / 3600e3;
    const y = Math.log(ex);
    n++; sx += x; sy += y; sxx += x * x; sxy += x * y;
  }
  if (n < 4) return FORECAST_DEFAULTS.dispersionK;
  const den = n * sxx - sx * sx;
  if (Math.abs(den) < 1e-9) return FORECAST_DEFAULTS.dispersionK;
  const slope = (n * sxy - sx * sy) / den;
  const k = -slope;
  if (!Number.isFinite(k) || k <= 0) return FORECAST_DEFAULTS.dispersionK;
  return fcClamp(k, 0.002, 0.08);
}

function interpForecastPoints(points, t) {
  if (!points || !points.length) return 0;
  if (t <= points[0].t) return points[0].v;
  if (t >= points[points.length - 1].t) return points[points.length - 1].v;
  let lo = 0, hi = points.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (points[mid].t <= t) lo = mid; else hi = mid;
  }
  const a = points[lo], b = points[hi];
  const span = b.t - a.t;
  if (!(span > 0)) return a.v;
  return a.v + (b.v - a.v) * ((t - a.t) / span);
}

function resampleForecastHourly(points, startMs, endMs) {
  if (!points || points.length < 2) return points ? points.slice() : [];
  const step = 3600e3;
  const out = [];
  const t0 = Math.ceil(startMs / step) * step;
  for (let t = t0; t <= endMs; t += step) {
    out.push({ t: t, v: Math.max(0, interpForecastPoints(points, t)) });
  }
  if (out.length < 2) return points.slice();
  return out;
}

function integrateForecastSeries(series) {
  if (!series || series.length < 2) return 0;
  let af = 0;
  for (let i = 1; i < series.length; i++) {
    const dtSec = (series[i].t - series[i - 1].t) / 1000;
    if (!(dtSec > 0)) continue;
    af += (series[i - 1].v + series[i].v) / 2 * dtSec / 43560;
  }
  return af;
}

function valueInForecastSeries(series, t) {
  if (!series || !series.length) return 0;
  if (t < series[0].t || t > series[series.length - 1].t) return 0;
  return interpForecastPoints(series, t);
}

/* The proposed schedule is the active source hydrograph
   (baseline-removed), resampled to a uniform hourly grid. */
function buildForecastSchedule() {
  const src = gages.find((g) => g.id === CalibrationModel.sourceId);
  if (!src || !src.results || !eventStart || !eventEnd) return [];
  const pts = src.results.intervals.map((p) => ({ t: p.t, v: Math.max(0, p.q - p.base) }));
  return resampleForecastHourly(pts, eventStart.getTime(), eventEnd.getTime());
}

/* Numerically route the proposed source schedule to the downstream
   gage.  Returns hourly series, daily accounting, and KPI summary. */
function computeArrivalForecast(sourceSchedule, calibrationParams) {
  const m = CalibrationModel;
  const p = calibrationParams || m.tuning || {};
  const srcPts = (sourceSchedule || [])
    .map((r) => ({
      t: Number(r.t != null ? r.t : r.timestamp),
      v: Math.max(0, Number(r.v != null ? r.v : r.flow))
    }))
    .filter((r) => Number.isFinite(r.t) && Number.isFinite(r.v))
    .sort((a, b) => a.t - b.t);
  if (srcPts.length < 2) return null;

  const numOr = (key, fallback) => {
    const v = Number(p[key]);
    return Number.isFinite(v) ? v : fallback;
  };
  const ia = Math.max(0, numOr('initialAbstractionAF', m.initialAbstractionAF || FORECAST_DEFAULTS.initialAbstractionAF));
  const ceff = fcClamp(numOr('conveyanceEfficiency', m.conveyanceEfficiency || FORECAST_DEFAULTS.conveyanceEfficiency), 0, 1);
  const season = fcClamp(numOr('seasonalityETFactor', m.seasonalityETFactor || FORECAST_DEFAULTS.seasonalityETFactor), 0.5, 1.5);
  const ante = fcClamp(numOr('antecedentMoistureFactor', m.antecedentMoistureFactor || FORECAST_DEFAULTS.antecedentMoistureFactor), 0.5, 1.5);
  const scale = fcClamp(numOr('releaseScale', m.releaseScale || FORECAST_DEFAULTS.releaseScale), 0.1, 3);
  const frontH = Math.max(1, numOr('frontLagHours', m.frontLagHours || FORECAST_DEFAULTS.frontLagHours));
  const crestH = Math.max(0, numOr('crestLagHours', m.crestLagHours || FORECAST_DEFAULTS.crestLagHours));
  const alpha = fcClamp(numOr('peakAttenuationRatio', m.peakAttenuationRatio || FORECAST_DEFAULTS.peakAttenuationRatio), 0.02, 1.5);
  const k = fcClamp(numOr('dispersionK', m.dispersionK || FORECAST_DEFAULTS.dispersionK), 0.001, 0.2);

  const src = srcPts.map((r) => ({ t: r.t, v: r.v * scale }));
  const srcStart = src[0].t;
  const srcEnd = src[src.length - 1].t;
  let srcPeakIdx = 0;
  for (let i = 1; i < src.length; i++) {
    if (src[i].v > src[srcPeakIdx].v) srcPeakIdx = i;
  }
  const srcPeakMs = src[srcPeakIdx].t;
  const srcPeakCfs = src[srcPeakIdx].v;
  const vRelease = integrateForecastSeries(src);
  if (!(vRelease > 0)) return null;

  // The calibrated front lag is measured first-rise → first-rise.  Anchor
  // the time warp at the source hydrograph's first rise (not the arbitrary
  // event-window start) so the routed leading edge lands at the calibrated
  // downstream arrival.
  const riseThr = 0.02 * srcPeakCfs;
  let srcRiseMs = srcStart;
  for (const r of src) {
    if (r.v >= riseThr) { srcRiseMs = r.t; break; }
  }
  if (!(srcRiseMs < srcPeakMs)) srcRiseMs = srcStart;

  const frontMs = frontH * 3600e3;
  const crestMs = crestH * 3600e3;
  let targetStart = srcRiseMs + frontMs;
  let targetPeak = srcPeakMs + crestMs;
  if (!(targetPeak > targetStart + 3600e3)) {
    targetStart = targetPeak - Math.max(3600e3, (srcPeakMs - srcRiseMs) * 0.25);
    if (targetStart < srcRiseMs) targetStart = srcRiseMs;
  }
  const targetSrcEnd = targetPeak + Math.max(0, srcEnd - srcPeakMs);

  // Time-warp the source hydrograph: source first rise -> front arrival,
  // source peak -> crest arrival; then diffuse the routed pulse.
  const step = 3600e3;
  const raw = [];
  const firstT = Math.ceil(targetStart / step) * step;
  const lastT = Math.floor(targetSrcEnd / step) * step;
  for (let t = firstT; t <= lastT; t += step) {
    let st;
    if (t <= targetPeak) {
      const spanT = Math.max(1, targetPeak - targetStart);
      st = srcRiseMs + (t - targetStart) * (srcPeakMs - srcRiseMs) / spanT;
    } else {
      st = srcPeakMs + (t - targetPeak);
    }
    raw.push({ t: t, v: Math.max(0, alpha * interpForecastPoints(src, st)) });
  }
  if (raw.length < 2) return null;

  // Gaussian diffusion (longitudinal spreading + bank storage).
  const sigmaH = fcClamp(0.15 / k, 2, 12);
  const radius = Math.max(1, Math.ceil(3 * sigmaH));
  const weights = [];
  for (let j = -radius; j <= radius; j++) weights.push(Math.exp(-0.5 * Math.pow(j / sigmaH, 2)));
  const wsum = weights.reduce((a, b) => a + b, 0);
  const smooth = raw.map((r, i) => {
    let sum = 0;
    for (let j = -radius; j <= radius; j++) {
      const idx = i + j;
      if (idx >= 0 && idx < raw.length) sum += raw[idx].v * weights[j + radius];
    }
    return { t: r.t, v: sum / wsum };
  });

  // Exponential bank-storage tail after the routed source ends.
  const tailHours = Math.min(360, Math.max(72, Math.round(6 / Math.max(k, 0.005))));
  const tailBase = smooth[smooth.length - 1].v;
  const tailStart = smooth[smooth.length - 1].t;
  const arrival = smooth.slice();
  for (let h = 1; h <= tailHours; h++) {
    const q = tailBase * Math.exp(-k * h);
    if (q < 0.05) break;
    arrival.push({ t: tailStart + h * step, v: q });
  }

  // Enforce the calibrated volumetric projection by normalizing the
  // routed series.  This is the numerical ∫Q dt = V_Dome constraint.
  const rawArrAF = integrateForecastSeries(arrival);
  const targetArrAF = Math.max(0, ceff * Math.max(0, vRelease - ia) * season * ante);
  const arrScale = rawArrAF > 1e-9 ? targetArrAF / rawArrAF : 0;
  for (const r of arrival) r.v *= arrScale;

  // Build the common release/arrival timeline on an hourly grid.
  const endMs = Math.max(srcEnd, arrival.length ? arrival[arrival.length - 1].t : srcEnd);
  const gridStart = Math.ceil(srcStart / step) * step;
  const gridEnd = Math.ceil(endMs / step) * step;
  const hourly = [];
  for (let t = gridStart; t <= gridEnd; t += step) {
    const rel = t <= srcEnd ? Math.max(0, interpForecastPoints(src, t)) : 0;
    const arr = valueInForecastSeries(arrival, t);
    hourly.push({
      timestamp: t,
      dateLabel: fcDateTimeShort(t),
      releaseFlow: rel,
      arrivingFlow: arr,
      cumReleaseAF: 0,
      cumArrivingAF: 0
    });
  }
  if (hourly.length < 2) return null;

  // Grid re-normalization: the hourly series is the product the user
  // sees/exports, so make its integral match the calibrated volume.
  let gridArrAF = 0;
  for (let i = 1; i < hourly.length; i++) {
    const dtSec = (hourly[i].timestamp - hourly[i - 1].timestamp) / 1000;
    gridArrAF += (hourly[i - 1].arrivingFlow + hourly[i].arrivingFlow) / 2 * dtSec / 43560;
  }
  if (gridArrAF > 1e-9 && targetArrAF > 0) {
    const corr = targetArrAF / gridArrAF;
    for (const r of hourly) r.arrivingFlow *= corr;
  }
  let cumRel = 0, cumArr = 0;
  for (let i = 0; i < hourly.length; i++) {
    if (i > 0) {
      const dtSec = (hourly[i].timestamp - hourly[i - 1].timestamp) / 1000;
      cumRel += (hourly[i - 1].releaseFlow + hourly[i].releaseFlow) / 2 * dtSec / 43560;
      cumArr += (hourly[i - 1].arrivingFlow + hourly[i].arrivingFlow) / 2 * dtSec / 43560;
    }
    hourly[i].cumReleaseAF = cumRel;
    hourly[i].cumArrivingAF = cumArr;
  }

  // KPIs from the final hourly product.
  let peakArrivingCfs = 0, peakArrivalMs = null;
  for (const r of hourly) {
    if (r.arrivingFlow > peakArrivingCfs) {
      peakArrivingCfs = r.arrivingFlow;
      peakArrivalMs = r.timestamp;
    }
  }
  let frontArrivalMs = null;
  if (peakArrivingCfs > 0) {
    const thr = Math.max(0.5, 0.01 * peakArrivingCfs);
    for (const r of hourly) {
      if (r.arrivingFlow >= thr) { frontArrivalMs = r.timestamp; break; }
    }
  }
  const last = hourly[hourly.length - 1];
  const totalReleaseAF = last.cumReleaseAF;
  const totalArrivedAF = last.cumArrivingAF;
  const netRecoveryPct = totalReleaseAF > 0 ? (100 * totalArrivedAF) / totalReleaseAF : 0;

  // Daily volumetric accounting (calendar-day buckets).
  const dayMap = new Map();
  for (let i = 1; i < hourly.length; i++) {
    const a = hourly[i - 1], b = hourly[i];
    const dtSec = (b.timestamp - a.timestamp) / 1000;
    if (!(dtSec > 0)) continue;
    const relAF = (a.releaseFlow + b.releaseFlow) / 2 * dtSec / 43560;
    const arrAF = (a.arrivingFlow + b.arrivingFlow) / 2 * dtSec / 43560;
    const key = fcDayKey(b.timestamp);
    let d = dayMap.get(key);
    if (!d) { d = { date: fcDayLabel(b.timestamp), releaseAF: 0, arrivingAF: 0 }; dayMap.set(key, d); }
    d.releaseAF += relAF;
    d.arrivingAF += arrAF;
  }
  const daily = [];
  let cumLoss = 0;
  for (const key of Array.from(dayMap.keys()).sort()) {
    const d = dayMap.get(key);
    const loss = d.releaseAF - d.arrivingAF;
    cumLoss += loss;
    daily.push({
      date: d.date,
      releaseAF: d.releaseAF,
      arrivingAF: d.arrivingAF,
      transmissionLossAF: loss,
      cumulativeLossAF: cumLoss,
      recoveryPct: d.releaseAF > 0 ? (100 * d.arrivingAF) / d.releaseAF : null
    });
  }

  const notes = m.notes.slice();
  if (Math.abs(scale - 1) > 1e-9) {
    notes.push('Proposed release = observed direct source hydrograph × ' + scale.toFixed(2) + '.');
  }
  if (vRelease <= ia) {
    notes.push('The proposed release (' + Math.round(vRelease).toLocaleString('en-US') +
      ' AF) is below the initial abstraction (' + Math.round(ia).toLocaleString('en-US') +
      ' AF) — no downstream arrival is projected.');
  }
  if (!(targetArrAF > 0)) {
    notes.push('The calibrated volume projection is zero — check the release volume, initial abstraction and conveyance efficiency.');
  }

  return {
    hourly: hourly,
    daily: daily,
    summary: {
      sourceLabel: m.sourceLabel,
      targetLabel: m.targetLabel,
      releaseStartMs: srcStart,
      releaseEndMs: srcEnd,
      forecastEndMs: last.timestamp,
      totalReleaseAF: totalReleaseAF,
      totalArrivedAF: totalArrivedAF,
      transmissionLossAF: totalReleaseAF - totalArrivedAF,
      netRecoveryPct: netRecoveryPct,
      billionGallons: totalArrivedAF * 325851.428571 / 1e9,
      peakArrivingCfs: peakArrivingCfs,
      peakArrivalMs: peakArrivalMs,
      peakSourceCfs: srcPeakCfs,
      peakAttenuationRatio: srcPeakCfs > 0 ? peakArrivingCfs / srcPeakCfs : 0,
      frontArrivalMs: frontArrivalMs,
      frontLagHours: frontArrivalMs != null ? (frontArrivalMs - srcStart) / 3600e3 : null,
      crestLagHours: peakArrivalMs != null ? (peakArrivalMs - srcPeakMs) / 3600e3 : null,
      initialAbstractionAF: ia,
      conveyanceEfficiency: ceff,
      seasonalityETFactor: season,
      antecedentMoistureFactor: ante,
      releaseScale: scale,
      modelFrontLagHours: frontH,
      modelCrestLagHours: crestH,
      modelPeakAttenuation: alpha,
      modelDispersionK: k,
      calibrationSource: m.calibrationSource
    },
    notes: notes,
    sourceSchedule: src
  };
}

/* Async public API requested by the forecast specification.  The
   computation is deterministic and CPU-bound, so the internal
   engine is synchronous; this wrapper lets callers await it. */
async function generateArrivalForecast(sourceSchedule, calibrationParams) {
  return computeArrivalForecast(sourceSchedule, calibrationParams);
}

/* ============================================================
   CSV export
   ============================================================ */
function csvField(v) {
  const s = String(v == null ? '' : v);
  return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

function buildCsvText() {
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
  L.push('# DOWNSTREAM ARRIVAL FORECAST (hourly routed series)');
  if (lastForecast && lastForecast.summary) {
    const fs = lastForecast.summary;
    L.push('# Source: ' + fs.sourceLabel + ' -> Target: ' + fs.targetLabel);
    L.push('# Calibration: ' + fs.calibrationSource);
    L.push('# Scenario: release x' + fs.releaseScale.toFixed(2) +
      ', seasonality x' + fs.seasonalityETFactor.toFixed(2) +
      ', antecedent x' + fs.antecedentMoistureFactor.toFixed(2));
    L.push('timestamp_utc,date_local,Release_Flow_cfs,Forecast_Dome_Flow_cfs,Release_Cumulative_AF,Cumulative_Dome_AF');
    for (const r of lastForecast.hourly) {
      L.push([
        new Date(r.timestamp).toISOString(),
        csvField(r.dateLabel),
        r.releaseFlow.toFixed(2),
        r.arrivingFlow.toFixed(2),
        r.cumReleaseAF.toFixed(3),
        r.cumArrivingAF.toFixed(3)
      ].join(','));
    }
    L.push('');
    L.push('# FORECAST DAILY ACCOUNTING');
    L.push('date,Dam_Release_AF,Arrival_at_Dome_AF,Estimated_River_Loss_AF,Cumulative_Loss_AF,Recovery_Pct');
    for (const d of lastForecast.daily) {
      L.push([
        csvField(d.date),
        d.releaseAF.toFixed(3),
        d.arrivingAF.toFixed(3),
        d.transmissionLossAF.toFixed(3),
        d.cumulativeLossAF.toFixed(3),
        d.recoveryPct == null ? '' : d.recoveryPct.toFixed(1)
      ].join(','));
    }
  } else {
    L.push('# Not available — select an event window with two usable gages.');
  }

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

  return L.join('\r\n');
}

function exportCSV() {
  const blob = new Blob([buildCsvText()], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  const stamp = moment().format('YYYYMMDD-HHmm');
  a.href = url;
  a.download = 'usace-release-analysis-' + stamp + '.csv';
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
  showStatus('CSV exported (<strong>' + a.download + '</strong>). Includes per-gage summary, travel rows, full fill-flagged series, and the hourly routed forecast.', 'success');
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
  'h3{font-size:0.9rem;margin:18px 0 8px;}' +
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

  /* --- downstream arrival forecast --- */
  if (lastForecast && lastForecast.summary) {
    const fs = lastForecast.summary;
    html += '<h2>Downstream arrival forecast</h2>' +
      '<div class="meta">' + esc(fs.calibrationSource) + '<br/>' +
      'Proposed release = observed direct source hydrograph × ' + fmtNum(fs.releaseScale, 2) +
      ' · seasonality ×' + fmtNum(fs.seasonalityETFactor, 2) +
      ' · antecedent ×' + fmtNum(fs.antecedentMoistureFactor, 2) + '.</div>' +
      '<div class="kpi-grid">' +
      '<div class="kpi"><div class="kpi-label">Projected volume at ' + esc(fs.targetLabel) + '</div>' +
      '<div class="kpi-value">' + fmtNum(fs.totalArrivedAF, 0) + ' AF</div>' +
      '<div class="kpi-sub">' + fmtNum(fs.billionGallons, 2) + ' billion gallons</div></div>' +
      '<div class="kpi"><div class="kpi-label">Net recovery rate</div>' +
      '<div class="kpi-value">' + fmtNum(fs.netRecoveryPct, 1) + '%</div>' +
      '<div class="kpi-sub">' + fmtNum(fs.totalReleaseAF, 0) + ' AF released · ' + fmtNum(fs.transmissionLossAF, 0) + ' AF lost</div></div>' +
      '<div class="kpi"><div class="kpi-label">Forecast peak at ' + esc(fs.targetLabel) + '</div>' +
      '<div class="kpi-value">' + fmtNum(fs.peakArrivingCfs, 0) + ' cfs</div>' +
      '<div class="kpi-sub">' + esc(fmtDT(fs.peakArrivalMs)) + ' local</div></div>' +
      '<div class="kpi"><div class="kpi-label">First water arrival</div>' +
      '<div class="kpi-value">' + esc(fmtDT(fs.frontArrivalMs)) + '</div>' +
      '<div class="kpi-sub">' + (fs.frontLagHours != null ? fmtNum(fs.frontLagHours, 0) + ' h after release start' : 'no positive arrival projected') + '</div></div>' +
      '</div>';
    if (forecastChart && forecastChart.canvas && forecastChart.canvas.toDataURL) {
      html += '<img class="chart-img" alt="Release and projected downstream arrival hydrograph" src="' +
        forecastChart.canvas.toDataURL('image/png') + '"/>';
    }
    html += '<h3>Daily volumetric accounting</h3><table class="data-table"><thead><tr><th>Date</th>' +
      '<th class="num">Dam Release (AF)</th><th class="num">Arrival at ' + esc(fs.targetLabel) + ' (AF)</th>' +
      '<th class="num">Estimated River Loss (AF)</th><th class="num">Cumulative Loss (AF)</th></tr></thead><tbody>';
    for (const d of lastForecast.daily) {
      html += '<tr><td>' + esc(d.date) + '</td>' +
        '<td class="num">' + fmtNum(d.releaseAF, 1) + '</td>' +
        '<td class="num">' + fmtNum(d.arrivingAF, 1) + '</td>' +
        '<td class="num">' + fmtNum(d.transmissionLossAF, 1) + '</td>' +
        '<td class="num">' + fmtNum(d.cumulativeLossAF, 1) + '</td></tr>';
    }
    html += '<tr style="font-weight:700;background:#f8fafc;"><td>Total</td>' +
      '<td class="num">' + fmtNum(fs.totalReleaseAF, 1) + '</td>' +
      '<td class="num">' + fmtNum(fs.totalArrivedAF, 1) + '</td>' +
      '<td class="num">' + fmtNum(fs.transmissionLossAF, 1) + '</td>' +
      '<td class="num">' + fmtNum(fs.transmissionLossAF, 1) + '</td></tr>';
    html += '</tbody></table>';
    html += '<div class="doc-body" style="margin-top:10px;"><p><strong>Routing notes.</strong> ' +
      'Initial abstraction I<sub>a</sub> = ' + fmtNum(fs.initialAbstractionAF, 0) + ' AF; ' +
      'C<sub>eff</sub> = ' + fmtNum(fs.conveyanceEfficiency * 100, 1) + '%; ' +
      'front lag = ' + fmtNum(fs.modelFrontLagHours, 0) + ' h; ' +
      'crest lag = ' + fmtNum(fs.modelCrestLagHours, 0) + ' h; ' +
      'peak attenuation α = ' + fmtNum(fs.modelPeakAttenuation, 2) + '; ' +
      'dispersion k = ' + fmtNum(fs.modelDispersionK, 3) + '/h. ' +
      'The hourly arrival series is normalized so its integral equals ' +
      'C<sub>eff</sub> × (V<sub>release</sub> − I<sub>a</sub>) × Φ<sub>season</sub> × Φ<sub>antecedent</sub>.</p></div>';
  }

  /* --- diagnostics & method notes --- */
  const warnEl = document.getElementById('warningsContainer');
  if (warnEl && warnEl.innerHTML) {
    // strip app-navigation phrasing that makes no sense in a standalone file
    const warnHtml = warnEl.innerHTML
      .split('— choose a fill action in Step 6 or accept the reduced accuracy.').join('');
    html += '<h2>Diagnostics &amp; data-quality notes</h2>' + warnHtml;
  }
  const docEl = document.querySelector('details.method-doc .doc-body');
  if (docEl && docEl.innerHTML) {
    html += '<h2>Method notes</h2><div class="doc-body">' + docEl.innerHTML + '</div>';
  } else {
    html += '<h2>Method notes</h2><div class="doc-body">' +
      '<p><strong>Volume.</strong> Direct storm volume integrates max(0, Q − baseline); total integrates raw Q. AF = cfs × Δt (s) / 43,560; 1 cfs-day = 1.98347 AF.</p>' +
      '<p><strong>Travel time.</strong> Peak-to-peak: event-window peak time difference between gages.</p>' +
      '<p><strong>Arrival forecast.</strong> Initial abstraction, conveyance efficiency, front/crest lag, peak attenuation and recession decay are calibrated from the selected event. The proposed source hydrograph is time-warped (front and crest lags), attenuated, diffusively smoothed, given an exponential bank-storage tail, and normalized to the calibrated volumetric projection.</p></div>';
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
    forecast: CalibrationModel.calibrated ? {
      sourceId: CalibrationModel.sourceId,
      targetId: CalibrationModel.targetId,
      tuning: {
        initialAbstractionAF: CalibrationModel.tuning.initialAbstractionAF,
        conveyanceEfficiency: CalibrationModel.tuning.conveyanceEfficiency,
        seasonalityETFactor: CalibrationModel.tuning.seasonalityETFactor,
        antecedentMoistureFactor: CalibrationModel.tuning.antecedentMoistureFactor,
        releaseScale: CalibrationModel.tuning.releaseScale
      },
      tuningDirty: CalibrationModel.tuningDirty
    } : null,
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
  showStatus('Configuration saved (<strong>' + a.download + '</strong>) — gages, data window, event window, baselines, gap fills, volume basis, lag and forecast tuning. Restore it any time with <strong>Load Config</strong>.', 'success');
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
    if (!cfg || cfg.app !== 'USACE Release Analysis' || !Array.isArray(cfg.rows) || cfg.rows.length < 2) {
      showStatus('Could not load configuration: this is not a USACE Release Analysis configuration file (missing "app" or "rows").', 'error');
      return;
    }
    applyConfig(cfg);
  };
  reader.onerror = () => showStatus('Could not read the configuration file.', 'error');
  reader.readAsText(file);
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

  if (cfg.forecast) {
    if (cfg.forecast.sourceId) forecastSourceId = cfg.forecast.sourceId;
    if (cfg.forecast.targetId) forecastTargetId = cfg.forecast.targetId;
  }

  computeAll();
  renderBaselinesCard();

  // Re-apply saved forecast tuning after calibration has refreshed the
  // calibrated values (computeAll resets tuning only when the reach/data changes).
  if (cfg.forecast && cfg.forecast.tuning && CalibrationModel.calibrated) {
    const ft = cfg.forecast.tuning;
    const num = (k) => Number(ft[k]);
    if (Number.isFinite(num('initialAbstractionAF'))) {
      CalibrationModel.tuning.initialAbstractionAF = Math.max(0, num('initialAbstractionAF'));
    }
    if (Number.isFinite(num('conveyanceEfficiency'))) {
      CalibrationModel.tuning.conveyanceEfficiency = fcClamp(num('conveyanceEfficiency'), 0, 1);
    }
    if (Number.isFinite(num('seasonalityETFactor'))) {
      const sea = num('seasonalityETFactor');
      CalibrationModel.tuning.seasonalityETFactor = [1.00, 1.10, 1.15].some((x) => Math.abs(x - sea) < 0.001) ? sea : 1.10;
    }
    if (Number.isFinite(num('antecedentMoistureFactor'))) {
      CalibrationModel.tuning.antecedentMoistureFactor = fcClamp(num('antecedentMoistureFactor'), 0.5, 1.5);
    }
    if (Number.isFinite(num('releaseScale'))) {
      CalibrationModel.tuning.releaseScale = fcClamp(num('releaseScale'), 0.1, 3);
    }
    CalibrationModel.tuningDirty = !!cfg.forecast.tuningDirty;
    renderForecast();
    notes.push('forecast tuning');
  }

  showStatus('Saved configuration applied — ' + (notes.length ? notes.join(' · ') : 'form settings') + '. Adjust anything and results update instantly.', 'success');
}
