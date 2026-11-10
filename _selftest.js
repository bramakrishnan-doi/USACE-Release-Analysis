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

// downstream arrival forecast calibration + numerical volume closure
calibrateForecastModel();
assert(CalibrationModel.calibrated, 'forecast calibrated: ' + CalibrationModel.calibrationSource);
assert(CalibrationModel.conveyanceEfficiency > 0 && CalibrationModel.conveyanceEfficiency <= 0.95,
  'Ceff inside 0-95%, got ' + CalibrationModel.conveyanceEfficiency);
assert(Math.abs(CalibrationModel.frontLagHours - 3) < 0.5, 'front lag ~3h, got ' + CalibrationModel.frontLagHours.toFixed(2));
assert(Math.abs(CalibrationModel.crestLagHours - 3) < 0.01, 'crest lag ~3h, got ' + CalibrationModel.crestLagHours.toFixed(2));
assert(CalibrationModel.peakAttenuationRatio > 0.9 && CalibrationModel.peakAttenuationRatio < 1.0,
  'peak attenuation ~0.94, got ' + CalibrationModel.peakAttenuationRatio.toFixed(3));
const sched = buildForecastSchedule();
assert(sched.length > 10, 'forecast source schedule built, got ' + sched.length + ' hourly points');
const fc = computeArrivalForecast(sched, CalibrationModel.tuning);
assert(fc && fc.hourly.length > 2, 'arrival forecast hourly series built');
assert(fc.daily.length >= 1, 'arrival forecast daily accounting built');
const fsum = fc.summary;
const fcTargetAF = fsum.conveyanceEfficiency * Math.max(0, fsum.totalReleaseAF - fsum.initialAbstractionAF) *
  fsum.seasonalityETFactor * fsum.antecedentMoistureFactor;
assert(Math.abs(fsum.totalArrivedAF - fcTargetAF) < 0.5,
  'forecast volume closure: got ' + fsum.totalArrivedAF.toFixed(2) + ', target ' + fcTargetAF.toFixed(2));
assert(fsum.peakArrivingCfs > 0 && fsum.peakArrivalMs != null, 'forecast peak arrival present');
assert(fsum.frontArrivalMs != null, 'forecast first-water arrival present');
const hLast = fc.hourly[fc.hourly.length - 1];
assert(Math.abs(hLast.cumArrivingAF - fsum.totalArrivedAF) < 0.01, 'cumulative arrival closes the hourly grid');
assert(Math.abs(fc.daily.reduce((a, d) => a + d.arrivingAF, 0) - fsum.totalArrivedAF) < 0.5, 'daily arrival sums to forecast total');

// ---------- forecast timezone (MST / local / UTC) ----------
ReleaseScenario.timeZone = 'MST';
const mst6 = fcPartsToMs(2026, 11, 10, 6, 0);
assert(mst6 === Date.UTC(2026, 10, 10, 13, 0), '6am MST maps to 13:00 UTC, got ' + new Date(mst6).toISOString());
const mstParts = fcZonedParts(mst6);
assert(mstParts.y === 2026 && mstParts.m === 11 && mstParts.d === 10 && mstParts.h === 6 && mstParts.min === 0,
  'MST parts round-trip: ' + JSON.stringify(mstParts));
const mstShown = new Date(mst6 + fcChartShiftMs(mst6));
assert(mstShown.getHours() === 6 && mstShown.getMinutes() === 0,
  'chart axis shift renders the MST clock, got ' + mstShown.toString());
assert(fcDateTimeInputValue(mst6) === '2026-11-10T06:00', 'datetime-local value in MST: ' + fcDateTimeInputValue(mst6));
assert(fcParseDateTimeInput('2026-11-10T06:00') === mst6, 'datetime-local parse in MST');

ReleaseScenario.timeZone = 'LOCAL';
assert(fcPartsToMs(2026, 11, 10, 6, 0) === new Date(2026, 10, 10, 6, 0).getTime(), 'LOCAL parts map to browser-local ms');
assert(fcZoneAbbr() === 'local', 'local zone abbreviation');

// ---------- custom release schedule parsing ----------
ReleaseScenario.timeZone = 'MST';
const parsed = parseReleaseScheduleText([
  'Tuesday, 10 NOV at 6am MST - 250 cfs',
  'Tuesday, 10 NOV at 6pm MST - 500 cfs',
  'Wednesday, 11 NOV Maintain 500 cfs',
  'Thursday, 12 NOV - Discharge will be increased:',
  'At 8am MST - 1,000 cfs',
  'At 8:30am MST - 1,500 cfs',
  'At 9am MST - 2,000 cfs',
  'At 9:30am MST - 2,500 cfs',
  'At 10am MST - 3,000 cfs'
].join(String.fromCharCode(10)), 2026);
assert(parsed.points.length === 7, 'parser found 7 timed change points, got ' + parsed.points.length);
assert(parsed.skipped.length === 2, 'parser skipped the two untimed hold lines, got ' + parsed.skipped.length);
assert(parsed.points[0].t === Date.UTC(2026, 10, 10, 13, 0) && parsed.points[0].v === 250, 'first parsed point: 6am MST 250 cfs');
assert(parsed.points[1].t === Date.UTC(2026, 10, 11, 1, 0) && parsed.points[1].v === 500, 'second parsed point: 6pm MST 500 cfs');
assert(parsed.points[6].t === Date.UTC(2026, 10, 12, 17, 0) && parsed.points[6].v === 3000, 'last parsed point: 10am MST 3000 cfs');
assert(parsed.points.every((p, i) => i === 0 || p.t > parsed.points[i - 1].t), 'parsed points strictly ordered');
const isoParsed = parseReleaseScheduleText('2026-11-10 06:00, 250' + String.fromCharCode(10) + '2026-11-10 18:00, 500', 2026);
assert(isoParsed.points.length === 2 && isoParsed.points[0].v === 250 && isoParsed.points[0].t === mst6, 'ISO paste parser');
const normPts = normalizeReleasePoints([{ t: mst6 + 5, v: 10 }, { t: mst6, v: 1 }, { t: mst6 + 5, v: 20 }]);
assert(normPts.length === 2 && normPts[0].v === 1 && normPts[1].v === 20, 'normalize sorts and last-wins duplicate times');

// ---------- custom schedule hold/step semantics + volume ----------
ReleaseScenario.mode = 'custom';
const cst = Date.UTC(2026, 10, 10, 13, 0);
ReleaseScenario.points = [
  { t: cst, v: 250 },
  { t: cst + 12 * H, v: 500 },
  { t: cst + 36 * H, v: 1000 },
  { t: cst + 37 * H, v: 0 }
];
const cs = buildCustomReleaseSchedule();
assert(cs.length > 20, 'custom schedule hourly grid built, got ' + cs.length + ' points');
const csAt = (t) => interpForecastPoints(cs, t);
assert(csAt(cst) === 250, 'custom start flow 250 cfs');
assert(csAt(cst + 12 * H - 1) === 250, '250 cfs holds until the next row');
assert(csAt(cst + 12 * H) === 500, '500 cfs starts at the second row');
assert(csAt(cst + 36 * H - 1) === 500, '500 cfs holds until the third row');
assert(csAt(cst + 36 * H) === 1000, '1000 cfs starts at the third row');
assert(csAt(cst + 37 * H) === 0, 'release ends at 0 cfs at the final row');
const csSummary = releaseScheduleSummary();
const csTheoAF = (250 * 12 + 500 * 24 + 1000 * 1) * 3600 / 43560;
assert(csSummary.count === 4, 'schedule summary count, got ' + csSummary.count);
assert(Math.abs(csSummary.totalAF - csTheoAF) < 0.01, 'step-schedule volume: got ' + csSummary.totalAF.toFixed(3) + ', expected ' + csTheoAF.toFixed(3));

// Custom schedules bypass the observed-release scale but use the same routing/volume closure.
const savedScale = CalibrationModel.tuning.releaseScale;
CalibrationModel.tuning.releaseScale = 1.5;
const cfc = computeArrivalForecast(buildForecastSchedule(), CalibrationModel.tuning);
assert(cfc && cfc.summary.releaseMode === 'custom', 'custom forecast flagged');
assert(cfc.summary.releaseScale === 1, 'custom schedule ignores the observed release scale');
assert(cfc.summary.releasePointCount === 4, 'custom forecast reports 4 change points');
assert(Math.abs(cfc.summary.totalReleaseAF - csSummary.totalAF) < 0.01, 'custom release volume preserved through routing');
const cTarget = cfc.summary.conveyanceEfficiency * Math.max(0, cfc.summary.totalReleaseAF - cfc.summary.initialAbstractionAF) *
  cfc.summary.seasonalityETFactor * cfc.summary.antecedentMoistureFactor;
assert(Math.abs(cfc.summary.totalArrivedAF - cTarget) < 0.5, 'custom forecast volume closure');
assert(Math.abs(cfc.hourly[cfc.hourly.length - 1].cumArrivingAF - cfc.summary.totalArrivedAF) < 0.01, 'custom cumulative arrival closes');
assert(Math.abs(cfc.daily.reduce((a, d) => a + d.arrivingAF, 0) - cfc.summary.totalArrivedAF) < 0.5, 'custom daily arrival sums to total');
assert(Math.abs(cfc.daily.reduce((a, d) => a + d.releaseAF, 0) - cfc.summary.totalReleaseAF) < 0.01, 'custom daily release sums to total');
CalibrationModel.tuning.releaseScale = savedScale;

// A schedule that starts between hourly marks still closes its daily release volume.
ReleaseScenario.points = [
  { t: cst + 15 * 60e3, v: 250 },
  { t: cst + 2 * H + 15 * 60e3, v: 500 },
  { t: cst + 3 * H + 15 * 60e3, v: 0 }
];
const offFc = computeArrivalForecast(buildForecastSchedule(), CalibrationModel.tuning);
assert(offFc && offFc.summary.releasePointCount === 3, 'off-grid schedule forecast missing');
assert(Math.abs(offFc.daily.reduce((a, d) => a + d.releaseAF, 0) - offFc.summary.totalReleaseAF) < 0.01,
  'off-grid schedule daily release closes: ' + offFc.daily.reduce((a, d) => a + d.releaseAF, 0).toFixed(2) + ' vs ' + offFc.summary.totalReleaseAF.toFixed(2));
assert(Math.abs(offFc.hourly[offFc.hourly.length - 1].cumReleaseAF - offFc.summary.totalReleaseAF) < 0.01,
  'off-grid schedule cumulative release closes');

// ---------- user's Nov 10-22 example schedule ----------
ReleaseScenario.points = normalizeReleasePoints(exampleReleaseSchedulePoints());
const exPts = ReleaseScenario.points;
const exYear = fcZonedParts(exPts[0].t).y;
assert(exPts.length === 11, 'example schedule has 11 change points, got ' + exPts.length);
assert(exPts[0].t === fcPartsToMs(exYear, 11, 10, 6, 0) && exPts[0].v === 250, 'example starts Nov 10 6am MST at 250 cfs');
assert(exPts[6].v === 3000 && exPts[7].v === 3000 && exPts[10].v === 0, 'example holds 3000 cfs then ends at 0');
const ex = releaseScheduleSummary();
assert(Math.abs(ex.totalAF - 703500 * 3600 / 43560) < 0.5, 'example release volume: got ' + ex.totalAF.toFixed(1) + ' AF');
const exFc = computeArrivalForecast(buildForecastSchedule(), CalibrationModel.tuning);
assert(exFc && exFc.summary.releasePointCount === 11, 'example schedule routed through the forecast engine');
assert(exFc.summary.totalReleaseAF > 58000 && exFc.summary.totalReleaseAF < 58300,
  'example release ~58,140 AF, got ' + exFc.summary.totalReleaseAF.toFixed(1));
assert(exFc.summary.peakArrivingCfs > 0 && exFc.summary.frontArrivalMs != null, 'example forecast produces arrival KPIs');

// Fewer than two change points is not a routable release.
ReleaseScenario.points = [{ t: cst, v: 250 }];
assert(buildCustomReleaseSchedule().length === 0, 'single-row schedule produces no routing series');
assert(computeArrivalForecast(buildForecastSchedule(), CalibrationModel.tuning) === null, 'single-row schedule returns no forecast');

// Restore observed mode for the remaining baseline tests.
ReleaseScenario.mode = 'observed';
ReleaseScenario.points = [];
ReleaseScenario.timeZone = 'MST';

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
