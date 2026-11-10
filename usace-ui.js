/* ============================================================
   USACE Release Analysis — UI Layer
   Chart plugins, renderers (baselines, gaps, results, legend),
   and all event wiring.
   ============================================================ */
'use strict';

/* ---------- Selection status helper ---------- */
function setSelectionUi(html, type) {
  const el = document.getElementById('selStatus');
  if (el) {
    el.className = 'status-box ' + (type || 'info');
    el.style.margin = '0 0 12px';
    el.innerHTML = html;
  }
}

/* Missing-data card collapse state (remembered in localStorage) */
function setGapsCollapsed(collapsed) {
  const card = document.getElementById('cardMissingData');
  if (card) card.classList.toggle('collapsed', !!collapsed);
  try { localStorage.setItem('usaceGapsCollapsed', collapsed ? '1' : '0'); } catch (e) { /* private mode: ignore */ }
}

/* ============================================================
   Chart.js plugins
   ============================================================ */
const hatchAtlas = {};
function hatchFor(chart, color) {
  const key = color;
  if (hatchAtlas[key]) return hatchAtlas[key];
  const c = document.createElement('canvas');
  c.width = 10; c.height = 10;
  const g = c.getContext('2d');
  g.fillStyle = 'rgba(148,163,184,0.10)';
  g.fillRect(0, 0, 10, 10);
  g.strokeStyle = color;
  g.globalAlpha = 0.45;
  g.lineWidth = 1.4;
  g.beginPath();
  g.moveTo(-2, 12); g.lineTo(12, -2);
  g.moveTo(-2, 7); g.lineTo(7, -2);
  g.moveTo(5, 12); g.lineTo(12, 5);
  g.stroke();
  hatchAtlas[key] = chart.ctx.createPattern(c, 'repeat');
  return hatchAtlas[key];
}

const gapShadingPlugin = {
  id: 'gapShadingPlugin',
  beforeDatasetsDraw(chart) {
    if (!document.getElementById('chkShowGaps').checked) return;
    if (!chart.$gageColors || chart.$gageColors.length === 0) return;
    const onlyEvent = document.getElementById('chkOnlyEvent').checked;
    const { ctx, chartArea: { top, bottom }, scales } = chart;
    const xs = scales.x;
    const xmin = xs.min, xmax = xs.max;
    const yesEvent = eventStart && eventEnd;
    ctx.save();
    for (const entry of chart.$gageColors) {
      const site = entry.site;
      for (const gap of site.gaps) {
        if (onlyEvent) {
          if (!yesEvent) continue;
          if (gap.t1 < eventStart.getTime() || gap.t0 > eventEnd.getTime()) continue;
        }
        let a = Math.max(gap.t0, xmin), b = Math.min(gap.t1, xmax);
        if (b <= a) continue;
        const x1 = xs.getPixelForValue(a), x2 = xs.getPixelForValue(b);
        if (x2 <= x1) continue;
        const filled = gap.fill && gap.fill !== '';
        ctx.fillStyle = filled
          ? hexToRgba(entry.color, GAP_ALPHA + 0.06)
          : hatchFor(chart, entry.color);
        ctx.fillRect(x1, top, x2 - x1, bottom - top);
        ctx.strokeStyle = filled ? 'transparent' : hexToRgba(entry.color, 0.8);
        if (!filled) {
          ctx.lineWidth = 1;
          ctx.beginPath();
          ctx.moveTo(x1, top); ctx.lineTo(x1, bottom);
          ctx.moveTo(x2, top); ctx.lineTo(x2, bottom);
          ctx.stroke();
        }
      }
    }
    ctx.restore();
  }
};

function hexToRgba(hex, alpha) {
  const h = hex.replace('#', '');
  const r = parseInt(h.slice(0, 2), 16), g = parseInt(h.slice(2, 4), 16), b = parseInt(h.slice(4, 6), 16);
  return 'rgba(' + r + ',' + g + ',' + b + ',' + alpha + ')';
}

const eventLinesPlugin = {
  id: 'eventLinesPlugin',
  afterDraw(chart) {
    if (!eventStart && !eventEnd) return;
    const { ctx, chartArea: { top, bottom, left, right }, scales } = chart;
    const xs = scales.x;
    ctx.save();
    if (eventStart) {
      const x = xs.getPixelForValue(eventStart.getTime());
      if (x >= left && x <= right) {
        ctx.strokeStyle = '#2563eb'; ctx.lineWidth = 2; ctx.setLineDash([5, 4]);
        ctx.beginPath(); ctx.moveTo(x, top); ctx.lineTo(x, bottom); ctx.stroke();
        ctx.fillStyle = '#1e40af'; ctx.font = '700 11px -apple-system, BlinkMacSystemFont, sans-serif';
        ctx.fillText('▼ Event Start', x + 4, top + 15);
      }
    }
    if (eventEnd) {
      const x = xs.getPixelForValue(eventEnd.getTime());
      if (x >= left && x <= right) {
        ctx.strokeStyle = '#dc2626'; ctx.lineWidth = 2; ctx.setLineDash([5, 4]);
        ctx.beginPath(); ctx.moveTo(x, top); ctx.lineTo(x, bottom); ctx.stroke();
        ctx.fillStyle = '#991b1b'; ctx.font = '700 11px -apple-system, BlinkMacSystemFont, sans-serif';
        ctx.fillText('▲ Event End', x + 4, top + 15);
      }
    }
    if (eventStart && eventEnd) {
      const x1 = Math.max(left, xs.getPixelForValue(eventStart.getTime()));
      const x2 = Math.min(right, xs.getPixelForValue(eventEnd.getTime()));
      if (x2 > x1) {
        ctx.fillStyle = EVENT_FILL;
        ctx.fillRect(x1, top, x2 - x1, bottom - top);
      }
    }
    ctx.restore();
  }
};

/* ---------- Main overlay chart ---------- */
function initChart() {
  if (chart) return;
  const ctx = document.getElementById('hydrographCanvas');
  chart = new Chart(ctx, {
    type: 'line',
    data: { datasets: [] },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: 'nearest', intersect: false, axis: 'x' },
      plugins: {
        legend: { display: false },
        tooltip: {
          backgroundColor: 'rgba(15, 23, 42, 0.92)',
          titleFont: { size: 12, weight: 'bold' },
          bodyFont: { size: 12 },
          padding: 10,
          callbacks: {
            title: (items) => items.length ? moment(items[0].raw.x).format('YYYY-MM-DD HH:mm') + ' (local)' : '',
            label: (context) => {
              const raw = context.raw || {};
              if (!Number.isFinite(raw.y)) return null;
              const label = (context.dataset.gLabel ? context.dataset.gLabel + ' · ' : '') + (context.dataset.dLabel || '');
              let s = label + ': ' + fmtNum(raw.y, 2) + ' cfs';
              if (raw.f) s += '  [filled: ' + raw.f + ']';
              return s;
            }
          }
        }
      },
      scales: {
        x: {
          type: 'time',
          time: {
            displayFormats: { hour: 'MMM D, HH:mm', day: 'MMM D' },
            tooltipFormat: 'YYYY-MM-DD HH:mm'
          },
          grid: { color: '#f1f5f9' },
          ticks: { color: '#64748b', font: { size: 11 }, maxRotation: 0, autoSkip: true }
        },
        y: {
          title: {
            display: true, text: 'Discharge (cfs)  —  axis and chart times shown in browser-local timezone', color: '#475569', font: { size: 12, weight: 'bold' }
          },
          grid: { color: '#f1f5f9' },
          ticks: { color: '#64748b', font: { size: 11 } }
        }
      },
      onClick: onChartClick
    },
    plugins: [eventLinesPlugin, gapShadingPlugin]
  });
}

/* Dataset construction — observed lines break (null) at unfilled gaps */
function updateChart() {
  if (!chart) initChart();

  const ds = [];
  const okGagesOrder = [];
  gages.forEach((g) => { if (g.ok) okGagesOrder.push(g); });

  okGagesOrder.forEach((g, gi) => {
    const color = GAGE_COLORS[gi % GAGE_COLORS.length];
    const gName = g.label || g.id;

    // Observed line, with hard breaks at unfilled gaps
    const data = [];
    const rd = g.readings;
    for (let i = 0; i < rd.length; i++) {
      const cur = rd[i];
      if (i > 0) {
        const gapDt = (cur.t - rd[i - 1].t) / 1000;
        if (gapDt > 1.5 * (g.intervalSec || 900)) {
          data.push({ x: rd[i - 1].t + 60000, y: null });
          data.push({ x: cur.t - 60000, y: null });
        }
      }
      data.push({ x: cur.t, y: cur.v, f: cur.f });
    }
    ds.push({
      label: 'flow', gLabel: gName, dLabel: 'Observed flow',
      data: data, borderColor: color, borderWidth: 2, tension: 0.1,
      pointRadius: 0, pointHoverRadius: 4, pointHoverBackgroundColor: color,
      spanGaps: false, fill: false, order: 3 + gi
    });

    // Filled points (markers)
    const fills = rd.filter((r) => r.f).map((r) => ({ x: r.t, y: r.v, f: r.f }));
    if (fills.length > 0) {
      ds.push({
        label: 'filled', gLabel: gName, dLabel: 'Gap-filled readings',
        type: 'scatter', data: fills,
        pointBackgroundColor: FILL_COLOR, pointBorderColor: '#fff', pointBorderWidth: 1,
        pointRadius: 3.2, pointHoverRadius: 5.5, showLine: false, order: 2
      });
    }

    // Baseline inside event window
    if (g.results && g.results.intervals.length > 0) {
      ds.push({
        label: 'baseline', gLabel: gName, dLabel: 'Baseline ' + (g.results ? g.results.baselineDesc : ''),
        data: g.results.intervals.map((iv) => ({ x: iv.t, y: iv.base })),
        borderColor: color, borderDash: [6, 4], borderWidth: 1.6, tension: 0,
        pointRadius: 0, pointHoverRadius: 3, fill: false, spanGaps: false, order: 1
      });
    }
  });

  chart.$gageColors = okGagesOrder.map((g, i) => ({
    uid: g.uid, site: g, color: GAGE_COLORS[i % GAGE_COLORS.length]
  }));
  chart.data.datasets = ds;
  chart.update();
  renderLegend(okGagesOrder);
}

function onChartClick(e, elements, c) {
  if (!gages.some((g) => g.ok)) return;
  const rect = c.canvas.getBoundingClientRect();
  const px = (e.clientX != null && e.clientX !== undefined) ? (e.clientX - rect.left) : e.x;
  const t = c.scales.x.getValueForPixel(px);
  if (!Number.isFinite(t)) return;
  const ms = Math.round(t);

  if (clickStage === 2) {
    // restart selection with a new start
    eventStart = new Date(ms); eventEnd = null; clickStage = 1;
    setSelectionUi('Resetting selection — event start set at <strong>' + esc(fmtDT(ms)) + '</strong>. Click again to set the event end.', 'info');
    computeAll();
    return;
  }
  const msNowEventStart = eventStart ? eventStart.getTime() : null;
  if (clickStage === 0 || msNowEventStart === null) {
    eventStart = new Date(ms); eventEnd = null; clickStage = 1;
    setSelectionUi('Event start set at <strong>' + esc(fmtDT(ms)) + '</strong> (local). Click again to set the event end.', 'info');
    computeAll();
  } else {
    if (ms <= msNowEventStart) {
      setSelectionUi('Event end must be later than the start — click a point to the right of the start line.', 'error');
      return;
    }
    eventEnd = new Date(ms); clickStage = 2;
    const durH = ((ms - msNowEventStart) / 3600e3);
    setSelectionUi(
      'Event window: <strong>' + esc(fmtDT(msNowEventStart)) + '</strong> → <strong>' + esc(fmtDT(ms)) + '</strong> (' +
      fmtDur(durH * 3600) + '). Click to redefine, or review volumes below.', 'success'
    );
    computeAll();
  }
}

/* ---------- Results bar chart ---------- */
/* Draw the acre-foot volume inside each bar (or just above it when the bar is too short). */
const barValueLabelsPlugin = {
  id: 'barValueLabels',
  afterDatasetsDraw(chart) {
    const ctx = chart.ctx;
    const meta = chart.getDatasetMeta(0);
    if (!ctx || !meta || !meta.data || !meta.data.length) return;
    const ds = chart.data.datasets[0];
    if (!ds) return;
    ctx.save();
    ctx.textAlign = 'center';
    meta.data.forEach((bar, i) => {
      const v = Number(ds.data[i]);
      if (!Number.isFinite(v)) return;
      const label = fmtNum(v, 0) + ' AF';
      const h = Math.abs(bar.base - bar.y);
      const barW = Math.abs(bar.width || 0);
      ctx.font = '600 ' + Math.max(8, Math.min(11, Math.round(barW / 8))) + 'px system-ui, -apple-system, "Segoe UI", sans-serif';
      if (h >= 18) {
        ctx.fillStyle = 'rgba(255,255,255,0.96)';
        ctx.textBaseline = 'middle';
        ctx.fillText(label, bar.x, bar.y + h / 2);
      } else {
        ctx.fillStyle = '#0f172a';
        ctx.textBaseline = 'bottom';
        ctx.fillText(label, bar.x, bar.y - 4);
      }
    });
    ctx.restore();
  }
};

function initBarChart() {
  if (barChart) return;
  barChart = new Chart(document.getElementById('barCanvas'), {
    type: 'bar',
    data: { labels: [], datasets: [] },
    plugins: [barValueLabelsPlugin],
    options: {
      responsive: true, maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: { position: 'top', labels: { boxWidth: 12, font: { size: 11 } } },
        tooltip: {
          titleFont: { size: 12, weight: 'bold' }, bodyFont: { size: 12 }, padding: 10,
          callbacks: {
            label: (c) => c.dataset.label + ': ' + fmtNum(c.parsed.y, 2) + ' AF'
          }
        }
      },
      scales: {
        y: {
          title: { display: true, text: 'Volume (acre-feet)', color: '#475569', font: { size: 12, weight: 'bold' } },
          grid: { color: '#f1f5f9' }, ticks: { color: '#64748b', font: { size: 11 } },
          beginAtZero: true
        },
        x: { ticks: { color: '#475569', font: { size: 11 } } }
      }
    }
  });
}

function updateBarChart() {
  if (!barChart) initBarChart();
  const okG = gages.filter((g) => g.ok);
  const labels = [];
  const direct = [];
  okG.forEach((g) => {
    labels.push(g.label || g.id);
    direct.push(g.results ? +g.results.directAF.toFixed(3) : 0);
  });
  barChart.data.labels = labels;
  barChart.data.datasets = [{
    label: 'Direct storm volume (AF)', data: direct,
    backgroundColor: 'rgba(2,132,199,0.85)',
    hoverBackgroundColor: 'rgba(2,132,199,0.95)',
    borderRadius: 4, borderWidth: 0
  }];
  barChart.update();
}

/* ============================================================
   Renderers
   ============================================================ */
function renderLegend(okGagesOrder) {
  const el = document.getElementById('legendChips');
  let html = '';
  okGagesOrder.forEach((g, i) => {
    const c = GAGE_COLORS[i % GAGE_COLORS.length];
    html += '<span class="chip"><span class="swatch" style="background:' + c + '"></span>' +
      esc(g.label || g.id) + (g.label ? ' <span style="color:var(--color-text-muted)">(' + esc(g.id) + ')</span>' : '') + '</span>';
  });
  if (okGagesOrder.length) {
    html += '<span class="chip"><span class="dot" style="background:' + FILL_COLOR + '"></span>gap-filled reading</span>';
    html += '<span class="chip"><span class="band" style="background:repeating-linear-gradient(45deg,#94a3b880 0 2px,#e2e8f022 2px 4px);border:1px solid #cbd5e1;border-radius:2px;"></span>unfilled gap</span>';
  }
  el.innerHTML = html;
}

function renderAllDynamic() {
  renderBaselinesCard();
  renderGapsCard(true);
  renderWarnings();
  renderLegend(gages.filter((g) => g.ok));
  renderResults();
  updateBarChart();
  syncButtonStates();
}

function syncButtonStates() {
  const anyOk = gages.some((g) => g.ok);
  document.getElementById('btnAutoDetect').disabled = !anyOk;
  document.getElementById('btnClearSel').disabled = !anyOk;
  const hasFills = anyOk && gages.some((g) => g.ok && g.gaps.length > 0);
  document.getElementById('btnFillAllLinear').disabled = !hasFills;
  document.getElementById('btnFillAllUpstream').disabled = !hasFills;
  document.getElementById('btnClearAllFills').disabled = !hasFills;
  document.getElementById('btnExportReport').disabled = !(anyOk && eventStart && eventEnd);
  document.getElementById('btnExportCSV').disabled = !(anyOk && eventStart && eventEnd);
}

/* ---------- Step 4 card (baselines) ---------- */
function renderBaselinesCard() {
  const box = document.getElementById('baselinesContainer');
  const anyOk = gages.some((g) => g.ok);
  if (!anyOk) {
    box.innerHTML = '<div class="results-empty">Load gage data in Step 1 to configure baselines.</div>';
    return;
  }
  let html = '';
  gages.forEach((g, gi) => {
    const color = GAGE_COLORS[gi % GAGE_COLORS.length];
    if (!g.ok) {
      html += '<div class="gage-panel" style="--gc:' + color + ';opacity:0.65">' +
        '<div class="gage-panel-head"><span class="gage-panel-title">' + esc(g.label || g.id) + '</span>' +
        '<span class="gage-panel-sub">' + esc(g.id) + '</span></div>' +
        '<div style="font-size:0.8rem;color:var(--color-end)">No data — ' + esc(g.err || 'unavailable') + '. Remove or fix this row in Step 1.</div></div>';
      return;
    }
    const name = g.meta && g.meta.name ? g.meta.name : '';
    const daTxt = g.meta && g.meta.da ? ' · drainage ' + fmtNum(g.meta.da, 0) + ' mi²' : '';
    const b = g.baseline;

    let paramHtml = '';
    if (b.method === 'flat') {
      paramHtml = '<input class="input input-sm tabular-nums" type="number" min="0.5" step="0.5" value="' + b.flatHours + '" data-mparam="flatHours" data-muid="' + g.uid + '" /> <span class="unit">hr before start</span>';
    } else if (b.method === 'diurnal') {
      paramHtml = '<input class="input input-sm tabular-nums" type="number" min="1" max="30" step="1" value="' + b.diurnalDays + '" data-mparam="diurnalDays" data-muid="' + g.uid + '" /> <span class="unit">days of pre-event pattern</span>';
    } else if (b.method === 'linear') {
      paramHtml = '<input class="input input-sm tabular-nums" type="number" min="0.5" step="0.5" value="' + b.linearHours + '" data-mparam="linearHours" data-muid="' + g.uid + '" /> <span class="unit">hr averaging on each side</span>';
    } else if (b.method === 'manual') {
      paramHtml = '<input class="input input-sm tabular-nums" type="number" min="0" step="1" value="' + b.manualCfs + '" data-mparam="manualCfs" data-muid="' + g.uid + '" /> <span class="unit">cfs constant</span>';
    } else {
      paramHtml = '<span class="unit">baseline = 0 cfs (ephemeral / no baseflow)</span>';
    }

    const methodOpts = BASELINE_METHODS.map((m) =>
      '<option value="' + m.key + '"' + (m.key === b.method ? ' selected' : '') + '>' + m.name + '</option>'
    ).join('');

    html += '<div class="gage-panel" style="--gc:' + color + '">' +
      '<div class="gage-panel-head">' +
      '<span class="gage-panel-title">' + esc(g.label || g.id) + '</span>' +
      '<span class="gage-panel-sub">' + esc(g.id) + (name ? ' · ' + esc(name) : '') + daTxt + '</span></div>' +
      '<div class="gage-panel-body">' +
      '<select class="select-input-sm" data-mmethod="' + g.uid + '">' + methodOpts + '</select>' +
      '<div class="param-wrap">' + paramHtml + '</div>' +
      '</div></div>';
  });
  box.innerHTML = html;
}

/* ---------- Step 5 card (gaps) ---------- */
function renderGapsCard() {
  const box = document.getElementById('gapsContainer');
  const anyOk = gages.some((g) => g.ok);
  if (!anyOk) {
    box.innerHTML = '<div class="results-empty">Load gage data in Step 1 to audit gaps.</div>';
    return;
  }
  let html = '';
  gages.forEach((g, gi) => {
    const color = GAGE_COLORS[gi % GAGE_COLORS.length];
    if (!g.ok) return;
    const inEv = g.gaps.filter((x) => x.inEvent);
    const totalDur = g.gaps.reduce((acc, x) => acc + x.durSec, 0);
    const filledCount = g.gaps.filter((x) => x.fill && x.fill !== '').length;

    html += '<div class="gap-block" style="--gc:' + color + '">' +
      '<div class="gap-head">' +
      '<div><strong style="font-size:0.9rem">' + esc(g.label || g.id) + '</strong> ' +
      '<span class="gap-stat">(' + esc(g.id) + ')' +
      (g.gaps.length
        ? ' · ' + g.gaps.length + ' gap' + (g.gaps.length > 1 ? 's' : '') + ' totaling ' + fmtDur(totalDur) +
          ', ~' + g.gaps.reduce((a, x) => a + x.missing, 0) + ' missing readings' +
          (eventStart ? ' · ' + inEv.length + ' inside event window' : '')
        : ' · no gaps ≥ 1.5 × interval') +
      (filledCount ? ' · ' + filledCount + ' filled' : '') +
      '</span></div>' +
      (g.gaps.length ? '<button class="btn btn-danger-ghost btn-sm" data-act="reset" data-uid="' + g.uid + '">Reset fills for this gage</button>' : '') +
      '</div>';

    if (g.gaps.length > 0) {
      html += '<div class="table-wrap"><table class="data-table"><thead><tr>' +
        '<th></th><th>Gap start (local)</th><th>Gap end (local)</th><th class="num">Duration</th>' +
        '<th class="num">Missing readings</th><th>Fill action</th></tr></thead><tbody>';
      for (const gap of g.gaps) {
        const opts = FILL_ACTIONS.map((f) =>
          '<option value="' + f.key + '"' + (f.key === (gap.fill || '') ? ' selected' : '') + '>' +
          (f.key === 'upstream' ? 'Scale from upstream' :
            f.key === 'linear' ? 'Linear interpolation' :
            f.key === 'hold' ? 'Hold last value' :
            f.key === 'zero' ? 'Fill with zero' : 'Leave as gap (exclude)') + '</option>'
        ).join('');
        html += '<tr>' +
          '<td>' + (eventStart ? (gap.inEvent ? '<span class="badge badge-event">event</span>' : '<span class="badge badge-pre">pre</span>') : '—') + '</td>' +
          '<td class="tabular-nums">' + esc(fmtDT(gap.t0)) + '</td>' +
          '<td class="tabular-nums">' + esc(fmtDT(gap.t1)) + '</td>' +
          '<td class="num">' + esc(fmtDur(gap.durSec)) + '</td>' +
          '<td class="num">~' + gap.missing + '</td>' +
          '<td><select class="select-input-sm" data-gapuid="' + g.uid + '" data-gapgid="' + gap.gid + '">' + opts + '</select></td>' +
          '</tr>';
      }
      html += '</tbody></table></div>';
    } else {
      html += '<div style="font-size:0.8rem;color:#166534;background:#f0fdf4;border:1px solid #86efac;border-radius:5px;padding:7px 10px;">No gaps detected at this gage — the record is continuous within reading tolerance.</div>';
    }
    html += '</div>';
  });

  // Header summary chip (visible even when the card is collapsed)
  const okGs = gages.filter((g) => g.ok);
  const sumEl = document.getElementById('gapsSummary');
  if (sumEl) {
    if (okGs.length === 0) {
      sumEl.textContent = '';
      sumEl.style.display = 'none';
    } else {
      let totalGaps = 0, totalFilled = 0, unfilledEvent = 0;
      okGs.forEach((g) => {
        totalGaps += g.gaps.length;
        g.gaps.forEach((x) => {
          if (x.fill) totalFilled++;
          if (x.inEvent && !x.fill) unfilledEvent++;
        });
      });
      sumEl.textContent = totalGaps === 0
        ? '✓ no gaps detected'
        : totalGaps + ' gap' + (totalGaps > 1 ? 's' : '') + ' · ' + totalFilled + ' filled' +
          (unfilledEvent ? ' · ' + unfilledEvent + ' event-window unfilled' : '');
      sumEl.style.display = '';
    }
  }

  box.innerHTML = html;
}

/* ---------- Step 3: results renderers ---------- */
function renderResults() {
  const emptyEl = document.getElementById('resultsEmpty');
  const contentEl = document.getElementById('resultsContent');
  const hasEvent = eventStart && eventEnd;
  const anyOk = gages.some((g) => g.ok);
  syncButtonStates();

  if (!anyOk || !hasEvent) {
    emptyEl.style.display = 'block';
    contentEl.style.display = 'none';
    emptyEl.textContent = !anyOk
      ? 'Load gage data (Step 1) — at least one usable gage is required.'
      : 'Select the storm release window (Step 2) by clicking twice on the chart, or press "Suggest Largest Event".';
    if (barChart) { barChart.data.labels = []; barChart.data.datasets = []; barChart.update(); }
    return;
  }

  emptyEl.style.display = 'none';
  contentEl.style.display = 'block';
  renderKpis();
  renderVolumesTable();
  renderTravelTable();
  updateBarChart();
}

function renderKpis() {
  const grid = document.getElementById('kpiGrid');
  const evS = eventStart.getTime(), evE = eventEnd.getTime();
  const okG = gages.filter((g) => g.ok && g.results);
  const up = okG[0];
  const down = okG[okG.length - 1];

  const basisVol = (r) => volumeBasis === 'direct' ? r.directAF : r.totalAF;

  let kpiHtml = '';
  kpiHtml += kpi('Event window', fmtDur((evE - evS) / 1000), fmtDT(evS) + ' → ' + fmtDT(evE) + ' local');
  if (up) {
    kpiHtml += kpi((up.label || up.id) + ' — upstream ' + (volumeBasis === 'direct' ? 'direct' : 'total') + ' volume',
      fmtNum(basisVol(up.results), 1) + ' AF', up.id + (up.results ? ' · peak ' + fmtNum(up.results.peak, 1) + ' cfs' : ''));
  }
  if (down && down !== up) {
    kpiHtml += kpi((down.label || down.id) + ' — downstream ' + (volumeBasis === 'direct' ? 'direct' : 'total') + ' volume',
      fmtNum(basisVol(down.results), 1) + ' AF', down.id);
  }
  if (up && down && down !== up && basisVol(up.results) > 0) {
    const ratio = basisVol(down.results) / basisVol(up.results) * 100;
    const interp = volumeBasis === 'direct'
      ? (ratio < 95 ? 'suggested reach LOSS' : ratio > 105 ? 'suggested reach GAIN' : 'comparable')
      : 'see table details';
    kpiHtml += kpi('Volume ratio (downstream ÷ upstream)', ratio.toFixed(0) + '%', interp);
  }
  const cum = travelRows.find((r) => r.isCumulative) || travelRows[travelRows.length - 1];
  if (cum && cum.peakDelayMs != null) {
    kpiHtml += kpi('Crest travel time (first → last gage)', fmtDelay(cum.peakDelayMs), 'peak-to-peak delay');
  }
  if (cum && cum.riseDelayMs != null) {
    kpiHtml += kpi('Operational lead time', fmtDelay(cum.riseDelayMs), 'first-rise (leading-edge) delay, upstream → downstream');
  }
  grid.innerHTML = kpiHtml;
}

function kpi(title, value, sub) {
  return '<div class="kpi"><div class="kpi-label">' + esc(title) + '</div>' +
    '<div class="kpi-value">' + esc(value) + '</div>' +
    (sub ? '<div class="kpi-sub">' + esc(sub) + '</div>' : '') + '</div>';
}

function renderVolumesTable() {
  const body = document.getElementById('volumesBody');
  const evS = eventStart.getTime(), evE = eventEnd.getTime();
  let html = '';

  gages.forEach((g) => {
    if (!g.ok) {
      html += '<tr><td colspan="11" class="subtle" style="color:var(--color-end)">' + esc(g.id) + ' — failed: ' + esc(g.err || 'no data') + '</td></tr>';
      return;
    }
    const ref = gages.find((x) => x.ok && x.results);
    const first = ref !== null && ref.uid === g.uid;
    const r = g.results;
    const basisVol = r ? (volumeBasis === 'direct' ? r.directAF : r.totalAF) : null;
    const upVol = (ref && ref.results) ? (volumeBasis === 'direct' ? ref.results.directAF : ref.results.totalAF) : null;
    let pct = null, delta = null, tag = null, tagText = '';
    if (first) {
      pct = 100; delta = 0; tag = 'tag-even'; tagText = 'reference gage (upstream)';
    } else if (r && upVol) {
      pct = basisVol / upVol * 100;
      delta = basisVol - upVol;
      if (pct > 105) { tag = 'tag-gain'; tagText = 'gains — tributaries / lateral inflow'; }
      else if (pct < 95) { tag = 'tag-loss'; tagText = 'losses — channel storage / transmission'; }
      else { tag = 'tag-even'; tagText = '≈ comparable volume'; }
    }
    const q = g.results ? gapSummary(g, evS, evE) : null;

    html += '<tr>' +
      '<td><strong>' + esc(g.label || g.id) + '</strong> ' +
      '<span class="subtle">' + esc(g.id) + (g.meta && g.meta.name ? '<br/><span style="font-size:0.7rem">' + esc(g.meta.name) + '</span>' : '') + '</span></td>' +
      '<td class="num">' + (g.meta && g.meta.da != null ? fmtNum(g.meta.da, 0) : '—') + '</td>' +
      '<td class="num">' + (r ? fmtNum(r.peak, 1) : '—') + '</td>' +
      '<td class="tabular-nums">' + (r ? fmtDT(r.peakTimeMs) : '—') + '</td>' +
      '<td class="tabular-nums"' + (r && r.riseNote ? ' title="' + esc(r.riseNote) + '"' : '') + '>' +
      (r && r.riseTimeMs != null ? fmtDT(r.riseTimeMs) : '—') + '</td>' +
      '<td class="num" style="' + (volumeBasis === 'direct' ? 'font-weight:700' : '') + '">' + (r ? fmtNum(r.directAF, 2) : '—') + '</td>' +
      '<td class="num" style="' + (volumeBasis === 'total' ? 'font-weight:700' : '') + '">' + (r ? fmtNum(r.totalAF, 2) : '—') + '</td>' +
      '<td class="num">' + (pct != null ? pct.toFixed(1) + '%' : '—') + '</td>' +
      '<td class="num">' + (delta != null ? (delta >= 0 ? '+' : '') + fmtNum(delta, 2) + ' AF' : '—') + '</td>' +
      '<td>' + (tag ? '<span class="tag-pill ' + tag + '">' + esc(tagText) + '</span>' : '—') + '</td>' +
      '<td>' + (q ? '<span class="tag-pill ' + q.tone + '">' + esc(q.text) + '</span>' : '—') + '</td>' +
      '</tr>';
  });

  body.innerHTML = html || '<tr><td colspan="11" class="subtle">No gages loaded.</td></tr>';
}

function renderTravelTable() {
  const body = document.getElementById('travelBody');
  let html = '';
  for (const row of travelRows) {
    const pairTxt = '<strong>' + esc(row.label) + '</strong> → <strong>' + esc(row.labelB) + '</strong>' +
      (row.isCumulative ? ' <span class="badge badge-pre">cumulative</span>' : '');
    if (!row.aOk || !row.bOk) {
      html += '<tr><td>' + pairTxt + ' <span class="subtle">— ' + esc(row.note) + '</span></td>' +
        '<td class="num">n/a</td><td class="num">n/a</td><td class="num">n/a</td><td class="num">—</td><td class="num">—</td></tr>';
      continue;
    }
    const xcTxt = row.xc ? (fmtDelay(row.xc.lagMs) + ' <span class="subtle">r=' + row.xc.r.toFixed(2) + '</span>') : 'n/a';
    html += '<tr>' +
      '<td>' + pairTxt + '</td>' +
      '<td class="num" style="font-weight:600"' + (row.riseNote ? ' title="' + esc(row.riseNote) + '"' : '') + '>' +
      (row.riseDelayMs != null ? fmtDelay(row.riseDelayMs) : 'n/a') + '</td>' +
      '<td class="num">' + (row.peakDelayMs != null ? fmtDelay(row.peakDelayMs) : 'n/a') + '</td>' +
      '<td class="num">' + xcTxt + '</td>' +
      '<td class="num">' + (row.distMi != null ? row.distMi.toFixed(1) + ' mi (straight-line)' : '—') + '</td>' +
      '<td class="num">' + (row.velMph != null ? row.velMph.toFixed(1) + ' mph' : '—') + '</td>' +
      '</tr>';
  }
  if (travelRows.length === 0) {
    html = '<tr><td colspan="6" class="subtle">Travel times appear after an event window is selected.</td></tr>';
  }
  body.innerHTML = html;
}

function renderWarnings() {
  const box = document.getElementById('warningsContainer');
  const items = [];
  for (const g of gages) {
    if (!g.ok && g.err) items.push('<strong>' + esc(g.id) + '</strong> failed: ' + esc(g.err));
    if (g.fetchNote) items.push('<strong>' + esc(g.label || g.id) + '</strong>: ' + esc(g.fetchNote));
    for (const w of g.warnings) items.push('<strong>' + esc(g.label || g.id) + '</strong>: ' + w);
  }
  const evS = eventStart ? eventStart.getTime() : null;
  const evE = eventEnd ? eventEnd.getTime() : null;
  if (evS && evE) {
    for (const g of gages) {
      if (!g.ok) continue;
      const gs = gapSummary(g, evS, evE);
      if (gs.tag === 'unfilled') items.push('<strong>' + esc(g.label || g.id) + '</strong>: ' + esc(gs.text) + ' — choose a fill action in Step 5 or accept the reduced accuracy.');
    }
  }
  if (!eventStart || !eventEnd) items.push('No event window selected yet — volumes and travel times are pending (Step 2).');
  else items.push('First rise = each gage\'s first sustained rise above 2% of its peak excess (baseline-removed), interpolated between readings — hover the First-rise cells for per-gage caveats. Cross-correlation lags are searched up to ' + esc(document.getElementById('lagHours').value || 24) + ' h on a grid no finer than the gage interval; wave speeds use straight-line gage distances (upper bounds).');

  let html = '';
  if (items.length === 0) {
    html = '<ul class="warn-list"><li class="ok">No warnings — gages loaded cleanly with valid baselines.</li></ul>';
  } else {
    html = '<ul class="warn-list">' + items.map((w) => '<li>' + w + '</li>').join('') + '<li class="ok">Volume integration excludes (does not guess) any portion of the event window left unfilled — flagged rows above affect downstream comparisons.</li></ul>';
  }
  box.innerHTML = html;
}

/* ============================================================
   Init & wiring
   ============================================================ */
function init() {
  // Guard: CDN libraries required before anything else can work
  if (typeof moment === 'undefined' || typeof Chart === 'undefined') {
    const box = document.getElementById('statusBox');
    box.className = 'status-box error';
    box.innerHTML = '<strong>Charting libraries failed to load.</strong><br/>' +
      'This app loads Chart.js and moment.js from cdnjs.cloudflare.com — check your internet connection (or a blocking extension/firewall) and reload the page.';
    ['btnAddGage', 'btnLoad'].forEach((id) => { document.getElementById(id).disabled = true; });
    return;
  }

  gageRowsArr = defaultRows();
  renderSiteRows();
  document.getElementById('startDateInput').value = moment().subtract(10, 'days').format('YYYY-MM-DDTHH:mm');
  document.getElementById('endDateInput').value = moment().format('YYYY-MM-DDTHH:mm');

  document.getElementById('btnAddGage').addEventListener('click', () => {
    if (readRowsFromDom().length >= MAX_GAGES) {
      showStatus('Maximum of ' + MAX_GAGES + ' gages.', 'error'); return;
    }
    gageRowsArr = readRowsFromDom();
    gageRowsArr.push(makeRow('', ''));
    renderSiteRows();
  });

  document.getElementById('gageRows').addEventListener('click', (ev) => {
    const btn = ev.target.closest('[data-act]');
    if (!btn) return;
    const rowEl = btn.closest('.gage-row');
    const uid = rowEl.getAttribute('data-uid');
    const idx = gageRowsArr.findIndex((r) => r.uid === uid);
    if (idx < 0) return;
    const act = btn.getAttribute('data-act');
    gageRowsArr = readRowsFromDom();
    if (act === 'up' && idx > 0) {
      const t = gageRowsArr[idx - 1]; gageRowsArr[idx - 1] = gageRowsArr[idx]; gageRowsArr[idx] = t;
    } else if (act === 'down' && idx < gageRowsArr.length - 1) {
      const t = gageRowsArr[idx + 1]; gageRowsArr[idx + 1] = gageRowsArr[idx]; gageRowsArr[idx] = t;
    } else if (act === 'del') {
      if (gageRowsArr.length > 2) gageRowsArr.splice(idx, 1);
      else { showStatus('At least two gage rows are required.', 'error'); return; }
    }
    renderSiteRows();
  });

  document.getElementById('btnLoad').addEventListener('click', loadAllData);

  document.getElementById('btnAutoDetect').addEventListener('click', autoDetectEvent);
  document.getElementById('btnClearSel').addEventListener('click', clearSelection);

  // Volume basis toggle
  document.querySelectorAll('input[name="basis"]').forEach((r) => {
    r.addEventListener('change', () => {
      volumeBasis = document.getElementById('rBasisDirect').checked ? 'direct' : 'total';
      document.getElementById('lblBasisDirect').classList.toggle('on', volumeBasis === 'direct');
      document.getElementById('lblBasisTotal').classList.toggle('on', volumeBasis === 'total');
      renderResults();
    });
  });

  document.getElementById('chkShowGaps').addEventListener('change', updateChart);
  document.getElementById('chkOnlyEvent').addEventListener('change', updateChart);
  document.getElementById('lagHours').addEventListener('change', () => {
    if (eventStart && eventEnd) { computeTravel(); renderResults(); }
  });

  // Global fill buttons
  document.getElementById('btnFillAllLinear').addEventListener('click', () => {
    gages.forEach((g) => g.gaps.forEach((x) => { x.fill = 'linear'; }));
    applyAllFills(); computeAll();
    showStatus('All gaps set to <strong>linear interpolation</strong>. Filled points are orange on the chart.', 'success');
  });
  document.getElementById('btnFillAllUpstream').addEventListener('click', () => {
    gages.forEach((g) => g.gaps.forEach((x) => { x.fill = 'upstream'; }));
    applyAllFills(); computeAll();
    showStatus('All gaps set to <strong>scale-from-upstream</strong> (falls back to linear where the upstream gage has no data).', 'success');
  });
  document.getElementById('btnClearAllFills').addEventListener('click', () => {
    gages.forEach((g) => g.gaps.forEach((x) => { x.fill = ''; }));
    applyAllFills(); computeAll();
    showStatus('All fills cleared — unfilled gaps are excluded from integration (quality column shows the excluded share).', 'success');
  });

  // Baselines card: method select + param inputs (delegation)
  const bc = document.getElementById('baselinesContainer');
  bc.addEventListener('change', (ev) => {
    const sel = ev.target.closest('[data-mmethod]');
    if (!sel) return;
    const site = gages.find((g) => g.uid === sel.getAttribute('data-mmethod'));
    if (!site) return;
    site.baseline.method = sel.value;
    renderBaselinesCard();
    computeAll();
  });
  bc.addEventListener('input', (ev) => {
    const inp = ev.target.closest('[data-mparam]');
    if (!inp) return;
    const site = gages.find((g) => g.uid === inp.getAttribute('data-muid'));
    if (!site) return;
    const k = inp.getAttribute('data-mparam');
    const v = Number(inp.value);
    if (Number.isFinite(v)) site.baseline[k] = v;
    computeAll();
  });

  // Gaps card: per-gap fill selection + per-gage reset (delegation)
  const gc = document.getElementById('gapsContainer');
  gc.addEventListener('change', (ev) => {
    const sel = ev.target.closest('[data-gapgid]');
    if (!sel) return;
    const site = gages.find((g) => g.uid === sel.getAttribute('data-gapuid'));
    if (!site) return;
    const gap = site.gaps.find((x) => x.gid === sel.getAttribute('data-gapgid'));
    if (!gap) return;
    gap.fill = sel.value;
    applyAllFills();
    computeAll();
  });
  gc.addEventListener('click', (ev) => {
    const btn = ev.target.closest('[data-act="reset"]');
    if (!btn) return;
    const site = gages.find((g) => g.uid === btn.getAttribute('data-uid'));
    if (!site) return;
    site.gaps.forEach((x) => { x.fill = ''; });
    applyAllFills();
    computeAll();
    showStatus('Cleared all fill actions for <strong>' + esc(site.label || site.id) + '</strong>.', 'success');
  });

  document.getElementById('btnExportCSV').addEventListener('click', exportCSV);
  document.getElementById('btnExportReport').addEventListener('click', exportReport);

  // Missing-data card collapse (default collapsed; remembers the choice)
  let startCollapsed = true;
  try { startCollapsed = localStorage.getItem('usaceGapsCollapsed') !== '0'; } catch (e) { /* default collapsed */ }
  setGapsCollapsed(startCollapsed);
  document.getElementById('btnGapsCollapse').addEventListener('click', () => {
    const card = document.getElementById('cardMissingData');
    setGapsCollapsed(!(card && card.classList.contains('collapsed')));
  });

  // Configuration save / load
  document.getElementById('btnSaveConfig').addEventListener('click', saveConfig);
  document.getElementById('btnLoadConfig').addEventListener('click', () => document.getElementById('configFileInput').click());
  document.getElementById('configFileInput').addEventListener('change', (ev) => {
    const inp = ev.target;
    const f = inp && inp.files && inp.files[0];
    if (f) loadConfigFile(f);
    if (inp) inp.value = '';
  });

  // Published configurations (configs/index.json)
  const savedSel = document.getElementById('savedConfigSelect');
  const savedBtn = document.getElementById('btnLoadSavedConfig');
  const syncSavedBtn = () => {
    if (savedBtn) savedBtn.disabled = !(savedSel && savedSel.value);
  };
  if (savedSel && savedBtn) {
    savedSel.addEventListener('change', syncSavedBtn);
    savedBtn.addEventListener('click', () => {
      if (savedSel.value) loadSavedConfig(savedSel.value);
    });
  }
  loadSavedConfigIndex().then(syncSavedBtn);

  initChart();
  initBarChart();
  setSelectionUi('Load gage data above, then click two points on the chart to define the storm start and end.', 'info');
}

// Surface any runtime failure in the UI instead of failing silently
window.addEventListener('error', (ev) => {
  const box = document.getElementById('statusBox');
  if (box) {
    box.className = 'status-box error';
    box.innerHTML = '<strong>Unexpected error</strong> — ' + esc(ev.message || String(ev)) +
      (ev.filename ? '<br/><span style="font-size:0.75rem">' + esc(ev.filename) + ':' + (ev.lineno || '') + '</span>' : '') +
      '<br/>If this persists after reloading, report it with this message.';
  }
});

try {
  init();
} catch (err) {
  const box = document.getElementById('statusBox');
  box.className = 'status-box error';
  box.innerHTML = '<strong>Startup failed:</strong> ' + esc(err.message || String(err));
  throw err;
}
