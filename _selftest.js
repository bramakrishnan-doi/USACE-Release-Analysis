/* Headless self-test for the USACE Release Analysis engine.
   Runs usace-data.js + usace-analysis.js in a VM context with DOM stubs,
   injects synthetic hydrographs, and asserts the core math.
   (Temporary harness — deletes itself from the release folder usage.) */
'use strict';
const fs = require('fs');
const vm = require('vm');
const path = require('path');

const DIR = __dirname;

// --- minimal DOM stub ---
const elems = {
  lagHours: { value: '24' },
  statusBox: { className: 'status-box', innerHTML: '', classList: { contains: () => false } },
  selStatus: { className: 'status-box', innerHTML: '', style: {} },
};
const documentStub = { getElementById: (id) => elems[id] || { innerHTML: '', style: {}, value: '' } };

const ctx = vm.createContext({ document: documentStub, console: console });

function run(file) {
  const code = fs.readFileSync(path.join(DIR, file), 'utf8');
  vm.runInContext(code, ctx, { filename: file });
}

run('usace-data.js');
run('usace-analysis.js');

// ---------- test driver (runs inside the same context) ----------
const driver = `
const H = 3600e3, step = 900e3; // 15 min
const t0 = Date.UTC(2026, 10, 1, 0, 0, 0); // Nov 1 2026 00:00 UTC
const pulseAmpUp = 800, pulseAmpDn = 750, sigma = 7200e3; // 2h
const peakUp = t0 + 36 * H;        // storm peak at hour 36
const peakDn = peakUp + 3 * H;     // arrives 3 h later
const shift = 3 * H;

function mkUpstream() {
  const vals = [];
  for (let t = t0; t <= t0 + 96 * H; t += step) { // 4 days
    const base = 50; // steady baseflow (exact-math tests)
    const x = t - peakUp;
    vals.push({ t: t, v: base + pulseAmpUp * Math.exp(-(x * x) / (2 * sigma * sigma)) });
  }
  return vals;
}
function mkDownstream(gapStart, gapEnd) {
  const vals = [];
  const g2s = peakUp + 8 * H;   // second gap: in-window, far on the recession tail
  const g2e = peakUp + 10 * H;
  for (let t = t0; t <= t0 + 96 * H; t += step) {
    if (t > gapStart && t < gapEnd) continue;   // gap 1 (pre-event or elsewhere)
    if (t > g2s && t < g2e) continue;           // gap 2 (inside event window)
    const base = 30;
    const x = t - peakDn;
    vals.push({ t: t, v: base + pulseAmpDn * Math.exp(-(x * x) / (2 * sigma * sigma)) });
  }
  return vals;
}

// Build gages directly (skip fetch/DOM)
gages = [];
const up = makeSite({ label: 'Gage A', id: '09419800' });
up.ok = true;
up.raw = mkUpstream();
up.meta = { name: 'Test upstream', da: 2193, coords: [-114.9, 36.12] };
const dn = makeSite({ label: 'Gage B', id: '09421500' });
dn.ok = true;
const gapStart = t0 + 2 * H;      // gap 1: 2h–4h, BEFORE the event window
const gapEnd = t0 + 4 * H;        //   -> does not disturb pulse-shape metrics
dn.raw = mkDownstream(gapStart, gapEnd);
dn.meta = { name: 'Test downstream', da: 2924, coords: [-114.7, 36.20] };
gages = [up, dn];

// interval + gaps + fills
up.intervalSec = medianInterval(up.raw);
dn.intervalSec = medianInterval(dn.raw);
detectGaps(up); detectGaps(dn);
assert(dn.gaps.length === 2, 'expected 2 gaps at downstream, got ' + dn.gaps.length);
assert(dn.gaps.every((g) => Math.abs(g.durSec - 7200) < 1), 'gap durations ~2h');
assert(dn.gaps.every((g) => g.missing === 7), 'missing readings expected 7 per gap');

// Fill via linear (close to the true smooth pulse) for exact volume math
dn.gaps.forEach((g) => { g.fill = 'linear'; });
applyAllFills();
assert(dn.readings.filter((r) => r.f).length === 14, 'expected 14 filled points, got ' + dn.readings.filter((r) => r.f).length);

// Event window: pulse + margin
eventStart = new Date(peakUp - 20 * H);
eventEnd = new Date(peakUp + 26 * H);
const windowSec = (eventEnd.getTime() - eventStart.getTime()) / 1000;

// Constant baseflow removed by manual baselines (up 50, dn 30) => direct = pulse only
up.baseline.method = 'manual'; up.baseline.manualCfs = 50;
dn.baseline.method = 'manual'; dn.baseline.manualCfs = 30;
computeSite(up); computeSite(dn);
assert(up.results && up.results.directAF > 0, 'upstream direct volume computed');
assert(dn.results && dn.results.directAF > 0, 'downstream direct volume computed');

// analytic direct volume: A*sqrt(2pi)*sigma / 43560
const theoUp = pulseAmpUp * Math.sqrt(2 * Math.PI) * (sigma / 1000) / 43560;
const theoDn = pulseAmpDn * Math.sqrt(2 * Math.PI) * (sigma / 1000) / 43560;
const relErr = (v, theo) => Math.abs(v - theo) / theo;
assert(relErr(up.results.directAF, theoUp) < 0.03, 'upstream vol error: ' + (relErr(up.results.directAF, theoUp) * 100).toFixed(1) + '% (got ' + up.results.directAF.toFixed(1) + ', theo ' + theoUp.toFixed(1) + ')');
assert(relErr(dn.results.directAF, theoDn) < 0.06, 'downstream vol error: ' + (relErr(dn.results.directAF, theoDn) * 100).toFixed(1) + '%');

// upstream total (none baseline) = pulse + constant baseflow pull
up.baseline.method = 'none';
computeSite(up);
assert(relErr(up.results.directAF, theoUp + 50 * windowSec / 43560) < 0.02,
  'none-baseline adds baseflow: got ' + up.results.directAF.toFixed(1) + ', theo ' + (theoUp + 50 * windowSec / 43560).toFixed(1));

// back to manual for comparative metrics
up.baseline.method = 'manual'; up.baseline.manualCfs = 50;
computeSite(up);

// ratio ~ 750/800 = 93.75%
const ratio = dn.results.directAF / up.results.directAF * 100;
assert(ratio > 91 && ratio < 97, 'volume ratio expected ~92-95%, got ' + ratio.toFixed(1) + '%');

assert(up.results.peak === 850, 'upstream peak = 50+800, got ' + up.results.peak);
assert(up.results.peakTimeMs === peakUp, 'upstream peak time');
assert(dn.results.peak === 780, 'downstream peak = 30+750, got ' + dn.results.peak);
assert(dn.results.peakTimeMs === peakDn, 'downstream peak time');

// centroid delay ~3h
const cd = dn.results.centroidMs - up.results.centroidMs;
assert(Math.abs(cd - shift) < 0.6 * H, 'centroid delay ~3h, got ' + (cd / 60000).toFixed(1) + ' min');

// peak delay exactly 180 min
const pd = dn.results.peakTimeMs - up.results.peakTimeMs;
assert(pd === shift, 'peak delay 180min, got ' + (pd / 60000));

// first rise (leading edge): analytic 2%-of-peak-excess crossing = σ·√(2·ln(1/0.02)) before the peak
const xThr = sigma * Math.sqrt(2 * Math.log(1 / 0.02));
assert(up.results.riseTimeMs != null, 'upstream first-rise detected');
assert(Math.abs(up.results.riseTimeMs - (peakUp - xThr)) < 120e3,
  'upstream rise vs analytic 2% crossing, off by ' + (Math.abs(up.results.riseTimeMs - (peakUp - xThr)) / 1000).toFixed(1) + ' s');
assert(dn.results.riseTimeMs != null, 'downstream first-rise detected');
assert(up.results.riseNote.indexOf('already elevated') < 0, 'clean gaussian rise mis-flagged as already-elevated: ' + up.results.riseNote);

// travel rows (with 2 gages the single adjacent pair == cumulative reach)
computeTravel();
assert(travelRows.length === 1, 'travel rows: 1 pair, got ' + travelRows.length);
const pair = travelRows[0];
assert(pair.peakDelayMs === shift, 'pair peak delay');
assert(Math.abs(pair.centDelayMs - shift) < 0.6 * H, 'pair centroid delay');
assert(pair.xc && Math.abs(pair.xc.lagMs - shift) <= 3 * step, 'xcorr lag ~3h, got ' + (pair.xc ? (pair.xc.lagMs / 60000) + ' min, r=' + pair.xc.r.toFixed(3) : 'none'));
assert(pair.xc && pair.xc.r > 0.85, 'xcorr similarity r>0.85, got ' + (pair.xc ? pair.xc.r.toFixed(3) : 'none'));
assert(Math.abs(pair.distMi - haversineMiles([-114.9, 36.12], [-114.7, 36.20])) < 0.01, 'distance');
assert(pair.velMph && pair.velMph > 0 && pair.velMph < 200, 'velocity computed: ' + pair.velMph);
const riseDelay = dn.results.riseTimeMs - up.results.riseTimeMs;
assert(Math.abs(pair.riseDelayMs - shift) < 200e3, 'first-rise delay ~3h, got ' + (pair.riseDelayMs / 60000).toFixed(2) + ' min');
assert(pair.riseDelayMs === riseDelay, 'pair riseDelayMs matches per-gage rise instants');

// flat baseline path (24h of constant-50 pre data -> flat = 50 = manual)
up.baseline.method = 'flat'; up.baseline.flatHours = 24;
assert(buildBaselineRef(up, eventStart.getTime(), eventEnd.getTime()) && up.blCache.type === 'flat', 'flat baseline built');
computeSite(up);
assert(relErr(up.results.directAF, theoUp) < 0.03, 'flat baseline removes baseflow: got ' + up.results.directAF.toFixed(1) + ', theo ' + theoUp.toFixed(1));

// diurnal path (constant flow -> every bucket = 50)
up.baseline.method = 'diurnal'; up.baseline.diurnalDays = 1;
assert(buildBaselineRef(up, eventStart.getTime(), eventEnd.getTime()), 'diurnal built');
computeSite(up);
assert(relErr(up.results.directAF, theoUp) < 0.03, 'diurnal baseline: got ' + up.results.directAF.toFixed(1));

// manual validation
up.baseline.method = 'manual';
up.baseline.manualCfs = -5;
assert(!buildBaselineRef(up, eventStart.getTime(), eventEnd.getTime()), 'manual negative rejected');
up.baseline.manualCfs = 51;
assert(buildBaselineRef(up, eventStart.getTime(), eventEnd.getTime()), 'manual valid when >= 0');

// gapSummary & excluded math (fill via upstream scaling — approximate; structural asserts)
const gap2 = dn.gaps.find((g) => g.t0 === peakUp + 8 * H);
assert(!!gap2, 'in-window gap identified');
gap2.fill = 'upstream';
applyAllFills();
assert(dn.readings.filter((r) => r.f && r.f === 'upstream').length === 7, 'upstream fill produced 7 points');
computeSite(dn);
assert(dn.results.excludedMs === 0, 'no excluded time once filled, got ' + dn.results.excludedMs);
const gs = gapSummary(dn, eventStart.getTime(), eventEnd.getTime());
assert(gs.tag === 'filled', 'gapSummary marks filled: ' + gs.tag + ' - ' + gs.text);

// unfilled case: drop gap2 -> its span is excluded from integration exactly
gap2.fill = '';
applyAllFills();
computeSite(dn);
assert(dn.results.excludedMs > 7.1e6 && dn.results.excludedMs <= 7.3e6,
  'unfilled 2h gap excluded from integration, got ' + (dn.results.excludedMs / 60000).toFixed(1) + ' min');
const gs2 = gapSummary(dn, eventStart.getTime(), eventEnd.getTime());
assert(gs2.tag === 'unfilled', 'gapSummary marks unfilled state: ' + gs2.tag + ' - ' + gs2.text);

console.log('SELFTEST PASS — all assertions passed');
`;
// expose a tiny assert inside the context
ctx.assert = (cond, msg) => { if (!cond) { throw new Error('ASSERT FAIL → ' + msg); } };

try {
  vm.runInContext(driver, ctx, { filename: 'test-driver.js' });
  // eslint-disable-next-line no-console
  console.log('SELFTEST PASS ✔');
} catch (e) {
  console.error('SELFTEST FAIL ✘ — ' + e.message + '\n' + e.stack);
  process.exit(1);
}
