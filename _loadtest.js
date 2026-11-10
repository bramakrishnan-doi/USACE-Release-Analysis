/* Integration load test — catches missing cross-file symbols & wiring.
   Loads usace-data.js + usace-analysis.js + usace-ui.js inside a VM with a
   tolerant DOM/Chart/moment stub, then drives the full pipeline:
   gage rows render, init(), fabricated gages through computeAll/renderers. */
'use strict';
const fs = require('fs');
const vm = require('vm');
const path = require('path');

function makeEl(id) {
  const el = {
    id: id,
    value: '',
    checked: false,
    disabled: false,
    innerHTML: '',
    textContent: '',
    className: '',
    style: {},
    classList: {
      add() {}, remove() {}, toggle() {}, contains() { return false; }
    },
    addEventListener() {},
    getContext() { return {}; },
    getBoundingClientRect() { return { left: 0, top: 0, width: 800, height: 400 }; },
    querySelector() { return null; },
    querySelectorAll() { return []; },
    closest() { return null; },
    setAttribute() {},
    getAttribute() { return null; },
    appendChild() {},
    removeChild() {},
    click() {},
    canvas: { getContext() { return {}; }, getBoundingClientRect() { return { left: 0, top: 0 }; }, toDataURL() { return 'data:image/png;base64,AAAA'; } }
  };
  return el;
}

const els = {};
const ctxObj = {
  document: {
    getElementById: (id) => (els[id] = els[id] || makeEl(id)),
    querySelectorAll() { return []; },
    querySelector(sel) {
      if (sel === '.forecast-chart-wrap') return (els['forecast-wrap'] = els['forecast-wrap'] || makeEl('forecast-wrap'));
      return null;
    },
    createElement: (tag) => makeEl('tag-' + tag),
    body: makeEl('body'),
    addEventListener() {}
  },
  window: { addEventListener() {} },
  setTimeout: () => 0,
  clearTimeout: () => {},
  console: console,
  fetch: (u) => Promise.reject(new Error('network disabled in load test')),
  Chart: class ChartStub {
    constructor(el, cfg) {
      this.canvas = el.canvas ? el.canvas : el;   // mirror Chart.js: chart.canvas = the <canvas> element
      this.config = cfg || {};
      this.data = (cfg && cfg.data) || { labels: [], datasets: [] };
      this.datasets = [];
    }
    update() {}
    destroy() {}
    get scales() { return { x: { min: 0, max: 1, getValueForPixel: () => 0 }, y: {} }; }
    get chartArea() { return { top: 0, bottom: 400, left: 0, right: 800 }; }
    get ctx() { return { save() {}, restore() {}, fillRect() {}, beginPath() {}, moveTo() {}, lineTo() {}, stroke() {}, fill() {}, fillText() {}, setLineDash() {}, createPattern() { return null; } }; }
  },
  moment: (v) => {
    const o = {
      format() { return '2026-01-01 00:00'; },
      subtract() { return o; },
      add() { return o; }
    };
    return o;
  },
  URL: { createObjectURL() { return 'blob:x'; }, revokeObjectURL() {} },
  Blob: class { constructor() {} }
};
const ctx = vm.createContext(ctxObj);

function run(file) {
  const code = fs.readFileSync(path.join(__dirname, file), 'utf8');
  try {
    vm.runInContext(code, ctx, { filename: file });
  } catch (e) {
    console.error('LOAD TEST FAIL ✘ — "' + file + '" → ' + e.message + '\n' + (e.stack || '').split('\n').slice(0, 4).join('\n'));
    process.exit(1);
  }
}

run('usace-data.js');
run('usace-analysis.js');
run('usace-ui.js');

// Drive the full pipeline with fabricated gages (exercises every renderer incl. FILL_ACTIONS)
const driver = `
const D = 86400e3, H = 3600e3;
gages = [];
const a = makeSite({ label: 'Gage A', id: '09419800' });
a.ok = true;
a.intervalSec = 900;
a.meta = { name: 'Test A', da: 2193, coords: [-114.9, 36.12] };
const t0 = Date.UTC(2023, 2, 1);
a.raw = [];
for (let t = t0; t <= t0 + 3 * D; t += 900e3) {
  a.raw.push({
    t: t,
    v: 40 + 10 * Math.sin(t / D) + 90 * Math.exp(-Math.pow((t - (t0 + 40 * H)) / (6 * H), 2))   // pulse: gives a rising edge
  });
}
a.readings = a.raw.map((r) => ({ t: r.t, v: r.v, f: null }));

const b = makeSite({ label: 'Gage B', id: '09520500' });
b.ok = true;
b.intervalSec = 900;
b.meta = { name: 'Test B', da: 3120, coords: [-114.7, 35.8] };
b.raw = [];
for (let t = t0; t <= t0 + 3 * D; t += 900e3) {
  if (t > t0 + D && t < t0 + D + 2 * H) continue;   // gap: for FILL_ACTIONS exercise
  b.raw.push({ t: t, v: 25 + 120 * Math.exp(-Math.pow((t - (t0 + 2 * D)) / (6 * H), 2)) });
}
b.readings = b.raw.map((r) => ({ t: r.t, v: r.v, f: null }));
gages = [a, b];

detectGaps(a); detectGaps(b);
if (b.gaps.length !== 1) throw new Error('expected 1 gap');
b.gaps[0].fill = 'linear';
applyAllFills();
if (b.readings.filter((r) => r.f).length !== 7) throw new Error('fill produced wrong count');

eventStart = new Date(t0 + 8 * H);
eventEnd = new Date(t0 + 70 * H);
a.baseline.method = 'flat'; b.baseline.method = 'none';
computeAll();
updateBarChart();
renderAllDynamic();
if (!b.results || !(b.results.directAF > 0)) throw new Error('no downstream volume computed');
if (barChart.data.datasets.length !== 1) throw new Error('bar chart should show only the direct storm volume series');
if (!/Direct storm volume/.test(barChart.data.datasets[0].label)) throw new Error('bar chart dataset is mislabeled');
const travel = travelRows[0];
if (!travel) throw new Error('no travel rows');
if (a.results.riseTimeMs == null || b.results.riseTimeMs == null) throw new Error('first-rise not detected at a gage');
if (travel.riseDelayMs == null) throw new Error('travel row missing riseDelayMs');
exportCSV ? 0 : 0;   // symbol existence probe only
console.log('in-load pipeline OK: directAF B = ' + b.results.directAF.toFixed(1) + ' AF, travel rows = ' + travelRows.length + ', gaps listed = ' + b.gaps.length);

// --- downstream arrival forecast ---
if (!CalibrationModel.calibrated) throw new Error('forecast did not calibrate: ' + CalibrationModel.calibrationSource);
if (typeof generateArrivalForecast !== 'function' || generateArrivalForecast.constructor.name !== 'AsyncFunction') {
  throw new Error('generateArrivalForecast should be an async function');
}
if (!lastForecast || !lastForecast.hourly || lastForecast.hourly.length < 2) throw new Error('forecast hourly series not built');
if (!lastForecast.daily || !lastForecast.daily.length) throw new Error('forecast daily accounting not built');
const fs = lastForecast.summary;
if (!(fs.totalArrivedAF > 0)) throw new Error('forecast arrival volume should be positive');
if (!(fs.peakArrivingCfs > 0) || fs.peakArrivalMs == null) throw new Error('forecast peak arrival missing');
const targetVol = fs.conveyanceEfficiency * Math.max(0, fs.totalReleaseAF - fs.initialAbstractionAF) *
  fs.seasonalityETFactor * fs.antecedentMoistureFactor;
if (Math.abs(fs.totalArrivedAF - targetVol) > 0.5) {
  throw new Error('forecast volume normalization off: ' + fs.totalArrivedAF.toFixed(2) + ' vs ' + targetVol.toFixed(2) + ' AF');
}
const lastRow = lastForecast.hourly[lastForecast.hourly.length - 1];
if (Math.abs(lastRow.cumArrivingAF - fs.totalArrivedAF) > 0.01) throw new Error('cumulative arrival does not close');
if (Math.abs(lastRow.cumReleaseAF - fs.totalReleaseAF) > 0.01) throw new Error('cumulative release does not close');
const dailyArr = lastForecast.daily.reduce((s, d) => s + d.arrivingAF, 0);
if (Math.abs(dailyArr - fs.totalArrivedAF) > 0.5) throw new Error('daily arrival does not sum to the forecast total');
const csv = buildCsvText();
const fcHeader = 'timestamp_utc,date_local,Release_Flow_cfs,Forecast_Dome_Flow_cfs,Release_Cumulative_AF,Cumulative_Dome_AF';
if (csv.indexOf(fcHeader) < 0) throw new Error('CSV is missing the forecast hourly header block');
if (csv.indexOf('# FORECAST DAILY ACCOUNTING') < 0) throw new Error('CSV is missing the forecast daily block');
if (!forecastChart || forecastChart.data.datasets.length !== 4) {
  throw new Error('forecast chart should carry release, arrival and both cumulative series');
}
console.log('forecast OK: ' + fs.totalArrivedAF.toFixed(1) + ' AF arrives (' + fs.netRecoveryPct.toFixed(1) + '%), peak ' +
  fs.peakArrivingCfs.toFixed(1) + ' cfs, ' + lastForecast.daily.length + ' daily rows, CSV headers + dual-axis chart verified');

// --- HTML report build (excludes baseline/gap-fill cards; peak-to-peak primary) ---
const report = buildReportHtml();
if (!report || report.length < 2000) throw new Error('report html not built (len ' + (report ? report.length : 0) + ')');
const mustHave = [
  'Volume comparison', 'Peak-to-peak delay', 'First-rise delay', 'Operational lead time',
  'Hydrograph overlay', 'data:image/png', 'Travel time between gages', 'Gages analyzed', 'peak-to-peak basis',
  'Downstream arrival forecast', 'Daily volumetric accounting', 'Routing notes'
];
for (const s of mustHave) {
  if (report.indexOf(s) < 0) throw new Error('report missing section: ' + s);
}
if (report.indexOf('Fill action') >= 0) throw new Error('report leaked the gap-fill editor');
if (report.indexOf('<select class="select-input-sm" data-gapgid') >= 0) throw new Error('report leaked interactive gap selects');
console.log('report OK: ' + report.length.toLocaleString() + ' chars, peak-to-peak primary, no config cards');

// --- saved-configuration apply pipeline (staged config applied after load) ---
pendingConfig = {
  app: 'USACE Release Analysis', version: 1, savedAt: 'test',
  rows: [{ label: 'Gage A', id: '09419800' }, { label: 'Gage B', id: '09520500' }],
  window: { start: '2023-03-01T00:00:00Z', end: '2023-03-04T00:00:00Z' },
  volumeBasis: 'total',
  lagHours: 48,
  event: { start: new Date(t0 + 10 * H).toISOString(), end: new Date(t0 + 60 * H).toISOString() },
  baselines: { 'USGS-09419800': { method: 'manual', flatHours: 12, diurnalDays: 2, linearHours: 3, manualCfs: 35 } },
  fills: { 'USGS-09520500': [{ t0: b.gaps[0].t0, t1: b.gaps[0].t1, fill: 'hold' }] },
  forecast: {
    sourceId: 'USGS-09419800', targetId: 'USGS-09520500',
    tuning: {
      initialAbstractionAF: 9000, conveyanceEfficiency: 0.30,
      seasonalityETFactor: 1.15, antecedentMoistureFactor: 1.05, releaseScale: 1.25
    },
    tuningDirty: true
  }
};
applyPendingConfig();
if (volumeBasis !== 'total') throw new Error('config did not restore volume basis');
if (a.baseline.method !== 'manual' || a.baseline.manualCfs !== 35) throw new Error('config did not restore baseline');
if (b.gaps[0].fill !== 'hold') throw new Error('config did not restore gap fill, got "' + b.gaps[0].fill + '"');
if (!eventStart || eventStart.getTime() !== t0 + 10 * H) throw new Error('config did not restore event start');
if (!eventEnd || eventEnd.getTime() !== t0 + 60 * H) throw new Error('config did not restore event end');
if (document.getElementById('lagHours').value !== 48) throw new Error('config did not restore lag hours');
if (forecastSourceId !== 'USGS-09419800' || forecastTargetId !== 'USGS-09520500') {
  throw new Error('config did not restore the forecast source/target pair');
}
if (CalibrationModel.tuning.initialAbstractionAF !== 9000 ||
    Math.abs(CalibrationModel.tuning.conveyanceEfficiency - 0.30) > 1e-9 ||
    Math.abs(CalibrationModel.tuning.seasonalityETFactor - 1.15) > 1e-9 ||
    Math.abs(CalibrationModel.tuning.antecedentMoistureFactor - 1.05) > 1e-9 ||
    Math.abs(CalibrationModel.tuning.releaseScale - 1.25) > 1e-9) {
  throw new Error('config did not restore forecast tuning');
}
console.log('config apply OK: basis, baseline, gap fill, event window, lag, forecast tuning restored');
`;
try {
  vm.runInContext(driver, ctx, { filename: 'loadtest-driver.js' });
  console.log('LOAD TEST PASS ✔ — all three files execute and wire together');
} catch (e) {
  console.error('LOAD TEST FAIL ✘ — driver: ' + e.message + '\n' + (e.stack || '').split('\n').slice(0, 4).join('\n'));
  process.exit(1);
}
