/**
 * Word Accuracy Analyzer — app.js
 * Parses uploaded CSV (word, count, accuracy), renders a filterable + sortable table.
 */

(function () {
  'use strict';

  // ─── State ──────────────────────────────────────────────
  let allRows = [];          // { word: string, count: number, accuracy: number }[]
  let filteredRows = [];
  let sortCol = 'word';
  let sortDir = 'asc';       // 'asc' | 'desc'

  // Data-range boundaries (set after CSV load)
  let countMin = 0, countMax = 1;
  let accMin = 0, accMax = 100;

  // ─── DOM refs ───────────────────────────────────────────
  const uploadZone   = document.getElementById('upload-zone');
  const uploadCard   = document.getElementById('upload-card');
  const uploadBtn    = document.getElementById('upload-btn');
  const fileInput    = document.getElementById('file-input');
  const workspace    = document.getElementById('workspace');
  const statsBar     = document.getElementById('stats-bar');
  const tableBody    = document.getElementById('table-body');
  const rowCountLabel= document.getElementById('row-count-label');
  const fileNameDisp = document.getElementById('file-name-display');
  const resetBtn     = document.getElementById('reset-btn');
  const searchInput  = document.getElementById('search-input');

  // Sliders
  const countMinSlider = document.getElementById('count-min');
  const countMaxSlider = document.getElementById('count-max');
  const accMinSlider   = document.getElementById('accuracy-min');
  const accMaxSlider   = document.getElementById('accuracy-max');

  // Number inputs
  const countMinInput  = document.getElementById('count-min-input');
  const countMaxInput  = document.getElementById('count-max-input');
  const accMinInput    = document.getElementById('accuracy-min-input');
  const accMaxInput    = document.getElementById('accuracy-max-input');

  // Range bars
  const countRangeBar  = document.getElementById('count-range-bar');
  const accRangeBar    = document.getElementById('accuracy-range-bar');

  // Labels
  const countRangeDisp = document.getElementById('count-range-display');
  const accRangeDisp   = document.getElementById('accuracy-range-display');

  // Stats
  const statTotal      = document.getElementById('stat-total');
  const statShown      = document.getElementById('stat-shown');
  const statAvg        = document.getElementById('stat-avg');

  // Sort headers
  const thWord     = document.getElementById('th-word');
  const thCount    = document.getElementById('th-count');
  const thAccuracy = document.getElementById('th-accuracy');

  // Chart
  const chartWrapper = document.getElementById('chart-wrapper');
  const scatterPlot  = document.getElementById('scatter-plot');
  const chartTooltip = document.getElementById('chart-tooltip');
  const chartZoomIn  = document.getElementById('chart-zoom-in');
  const chartZoomOut = document.getElementById('chart-zoom-out');
  const chartResetView = document.getElementById('chart-reset-view');

  // ─── Upload handling ────────────────────────────────────
  uploadCard.addEventListener('click', () => fileInput.click());
  uploadBtn.addEventListener('click', (e) => { e.stopPropagation(); fileInput.click(); });

  fileInput.addEventListener('change', (e) => {
    if (e.target.files.length) loadFile(e.target.files[0]);
  });

  // Drag & drop
  uploadCard.addEventListener('dragover', (e) => { e.preventDefault(); uploadCard.classList.add('drag-over'); });
  uploadCard.addEventListener('dragleave', () => uploadCard.classList.remove('drag-over'));
  uploadCard.addEventListener('drop', (e) => {
    e.preventDefault();
    uploadCard.classList.remove('drag-over');
    if (e.dataTransfer.files.length) loadFile(e.dataTransfer.files[0]);
  });

  function loadFile(file) {
    if (!file.name.endsWith('.csv')) {
      alert('Please upload a .csv file.');
      return;
    }
    const reader = new FileReader();
    reader.onload = (ev) => {
      parseCSV(ev.target.result);
      fileNameDisp.textContent = file.name;
      uploadZone.style.display = 'none';
      workspace.style.display = '';
      statsBar.style.display = '';
    };
    reader.readAsText(file);
  }

  // ─── CSV Parsing ────────────────────────────────────────
  function parseCSV(text) {
    const lines = text.replace(/\r/g, '').split('\n').filter(Boolean);
    if (lines.length < 2) { alert('CSV appears empty.'); return; }

    // Skip header
    allRows = [];
    for (let i = 1; i < lines.length; i++) {
      const parts = smartSplit(lines[i]);
      if (parts.length < 3) continue;
      const word = parts.slice(0, parts.length - 2).join(',').replace(/^"|"$/g, '');
      const count = parseInt(parts[parts.length - 2], 10);
      const accuracy = parseFloat(parts[parts.length - 1]);
      if (isNaN(count) || isNaN(accuracy)) continue;
      allRows.push({ word, count, accuracy });
    }

    // Compute data boundaries
    countMin = Math.min(...allRows.map(r => r.count));
    countMax = Math.max(...allRows.map(r => r.count));
    accMin   = Math.min(...allRows.map(r => r.accuracy));
    accMax   = Math.max(...allRows.map(r => r.accuracy));

    initSliders();
    resetChartView();
    applyFilters();
  }

  /**
   * CSV-aware split: the "word" column may contain commas within quotes.
   * We need to split carefully. Since the last two columns are always numeric,
   * we take a simpler approach: split by comma and treat the last two tokens
   * as count and accuracy, everything else as the word.
   */
  function smartSplit(line) {
    const result = [];
    let current = '';
    let inQuotes = false;
    for (let ch of line) {
      if (ch === '"') { inQuotes = !inQuotes; current += ch; }
      else if (ch === ',' && !inQuotes) { result.push(current); current = ''; }
      else { current += ch; }
    }
    result.push(current);
    return result;
  }

  // ─── Slider init ────────────────────────────────────────
  function initSliders() {
    // Count slider
    countMinSlider.min = countMin;
    countMinSlider.max = countMax;
    countMinSlider.value = countMin;
    countMaxSlider.min = countMin;
    countMaxSlider.max = countMax;
    countMaxSlider.value = countMax;
    countMinInput.value = countMin;
    countMinInput.min = countMin;
    countMinInput.max = countMax;
    countMaxInput.value = countMax;
    countMaxInput.min = countMin;
    countMaxInput.max = countMax;

    // Accuracy slider
    accMinSlider.min = accMin;
    accMinSlider.max = accMax;
    accMinSlider.value = accMin;
    accMaxSlider.min = accMin;
    accMaxSlider.max = accMax;
    accMaxSlider.value = accMax;
    accMinInput.value = accMin;
    accMinInput.min = accMin;
    accMinInput.max = accMax;
    accMaxInput.value = accMax;
    accMaxInput.min = accMin;
    accMaxInput.max = accMax;

    updateRangeBars();
    updateLabels();
  }

  // ─── Slider events ─────────────────────────────────────
  function onCountSliderChange() {
    let lo = parseInt(countMinSlider.value);
    let hi = parseInt(countMaxSlider.value);
    if (lo > hi) { if (this === countMinSlider) countMinSlider.value = hi; else countMaxSlider.value = lo; }
    lo = parseInt(countMinSlider.value);
    hi = parseInt(countMaxSlider.value);
    countMinInput.value = lo;
    countMaxInput.value = hi;
    updateRangeBars();
    updateLabels();
    applyFilters();
  }

  function onAccSliderChange() {
    let lo = parseFloat(accMinSlider.value);
    let hi = parseFloat(accMaxSlider.value);
    if (lo > hi) { if (this === accMinSlider) accMinSlider.value = hi; else accMaxSlider.value = lo; }
    lo = parseFloat(accMinSlider.value);
    hi = parseFloat(accMaxSlider.value);
    accMinInput.value = lo;
    accMaxInput.value = hi;
    updateRangeBars();
    updateLabels();
    applyFilters();
  }

  countMinSlider.addEventListener('input', onCountSliderChange);
  countMaxSlider.addEventListener('input', onCountSliderChange);
  accMinSlider.addEventListener('input', onAccSliderChange);
  accMaxSlider.addEventListener('input', onAccSliderChange);

  // Number input sync
  function onCountInputChange() {
    let lo = parseInt(countMinInput.value) || countMin;
    let hi = parseInt(countMaxInput.value) || countMax;
    lo = Math.max(countMin, Math.min(lo, countMax));
    hi = Math.max(countMin, Math.min(hi, countMax));
    if (lo > hi) [lo, hi] = [hi, lo];
    countMinSlider.value = lo;
    countMaxSlider.value = hi;
    countMinInput.value = lo;
    countMaxInput.value = hi;
    updateRangeBars();
    updateLabels();
    applyFilters();
  }

  function onAccInputChange() {
    let lo = parseFloat(accMinInput.value);
    let hi = parseFloat(accMaxInput.value);
    if (isNaN(lo)) lo = accMin;
    if (isNaN(hi)) hi = accMax;
    lo = Math.max(accMin, Math.min(lo, accMax));
    hi = Math.max(accMin, Math.min(hi, accMax));
    if (lo > hi) [lo, hi] = [hi, lo];
    accMinSlider.value = lo;
    accMaxSlider.value = hi;
    accMinInput.value = lo;
    accMaxInput.value = hi;
    updateRangeBars();
    updateLabels();
    applyFilters();
  }

  countMinInput.addEventListener('change', onCountInputChange);
  countMaxInput.addEventListener('change', onCountInputChange);
  accMinInput.addEventListener('change', onAccInputChange);
  accMaxInput.addEventListener('change', onAccInputChange);

  // Reset
  resetBtn.addEventListener('click', () => {
    searchInput.value = '';
    countMinSlider.value = countMin;
    countMaxSlider.value = countMax;
    countMinInput.value = countMin;
    countMaxInput.value = countMax;
    accMinSlider.value = accMin;
    accMaxSlider.value = accMax;
    accMinInput.value = accMin;
    accMaxInput.value = accMax;
    updateRangeBars();
    updateLabels();
    applyFilters();
  });

  searchInput.addEventListener('input', applyFilters);

  // ─── Visual helpers ─────────────────────────────────────
  function updateRangeBars() {
    const cRange = countMax - countMin || 1;
    const cLo = ((parseInt(countMinSlider.value) - countMin) / cRange) * 100;
    const cHi = ((parseInt(countMaxSlider.value) - countMin) / cRange) * 100;
    countRangeBar.style.left  = cLo + '%';
    countRangeBar.style.right = (100 - cHi) + '%';

    const aRange = accMax - accMin || 1;
    const aLo = ((parseFloat(accMinSlider.value) - accMin) / aRange) * 100;
    const aHi = ((parseFloat(accMaxSlider.value) - accMin) / aRange) * 100;
    accRangeBar.style.left  = aLo + '%';
    accRangeBar.style.right = (100 - aHi) + '%';
  }

  function updateLabels() {
    countRangeDisp.textContent = `${countMinSlider.value} — ${countMaxSlider.value}`;
    accRangeDisp.textContent = `${Number(accMinSlider.value).toFixed(1)}% — ${Number(accMaxSlider.value).toFixed(1)}%`;
  }

  // ─── Filter + render ───────────────────────────────────
  function applyFilters() {
    const cLo = parseInt(countMinSlider.value);
    const cHi = parseInt(countMaxSlider.value);
    const aLo = parseFloat(accMinSlider.value);
    const aHi = parseFloat(accMaxSlider.value);
    const q = searchInput.value.trim().toLowerCase();

    filteredRows = allRows.filter(r =>
      r.count >= cLo && r.count <= cHi &&
      r.accuracy >= aLo && r.accuracy <= aHi &&
      (q === '' || r.word.toLowerCase().includes(q))
    );

    sortData();
    renderTable();
    renderChart();
    updateStats();
  }

  // ─── Sorting ────────────────────────────────────────────
  function sortData() {
    filteredRows.sort((a, b) => {
      let va = a[sortCol], vb = b[sortCol];
      if (typeof va === 'string') {
        va = va.toLowerCase(); vb = vb.toLowerCase();
        return sortDir === 'asc' ? va.localeCompare(vb) : vb.localeCompare(va);
      }
      return sortDir === 'asc' ? va - vb : vb - va;
    });
  }

  function setSortHeader() {
    [thWord, thCount, thAccuracy].forEach(th => {
      th.classList.remove('sorted-asc', 'sorted-desc');
    });
    const th = { word: thWord, count: thCount, accuracy: thAccuracy }[sortCol];
    th.classList.add(sortDir === 'asc' ? 'sorted-asc' : 'sorted-desc');
  }

  [thWord, thCount, thAccuracy].forEach(th => {
    th.addEventListener('click', () => {
      const col = th.dataset.sort;
      if (sortCol === col) sortDir = sortDir === 'asc' ? 'desc' : 'asc';
      else { sortCol = col; sortDir = 'asc'; }
      setSortHeader();
      sortData();
      renderTable();
    });
  });

  // ─── Render table ──────────────────────────────────────
  function renderTable() {
    setSortHeader();

    // Build HTML in bulk for performance
    const html = filteredRows.map(r => {
      const accClass = r.accuracy < 50 ? 'low' : r.accuracy < 80 ? 'mid' : 'high';
      return `<tr>
        <td>${escapeHtml(r.word)}</td>
        <td>${r.count}</td>
        <td>
          <div class="accuracy-cell">
            <div class="accuracy-bar-bg">
              <div class="accuracy-bar-fill bar-${accClass}" style="width:${r.accuracy}%"></div>
            </div>
            <span class="accuracy-val acc-${accClass}">${r.accuracy.toFixed(1)}%</span>
          </div>
        </td>
      </tr>`;
    }).join('');

    tableBody.innerHTML = html;
    rowCountLabel.textContent = `${filteredRows.length} word${filteredRows.length !== 1 ? 's' : ''}`;
  }

  function updateStats() {
    statTotal.textContent = allRows.length;
    statShown.textContent = filteredRows.length;
    if (filteredRows.length) {
      const avg = filteredRows.reduce((s, r) => s + r.accuracy, 0) / filteredRows.length;
      statAvg.textContent = avg.toFixed(1) + '%';
    } else {
      statAvg.textContent = '—';
    }
  }

  function escapeHtml(str) {
    const d = document.createElement('div');
    d.textContent = str;
    return d.innerHTML;
  }

  // ─── Scatter plot ──────────────────────────────────────
  const CHART_MARGIN = { top: 16, right: 20, bottom: 44, left: 52 };
  const CHART_ZOOM_FACTOR = 1.35;

  let viewCountMin = 0;
  let viewCountMax = 1;
  let viewAccMin = 0;
  let viewAccMax = 100;

  function resetChartView() {
    viewCountMin = countMin;
    viewCountMax = countMax;
    viewAccMin = accMin;
    viewAccMax = accMax;
    updateChartControls();
  }

  function isChartViewDefault() {
    return viewCountMin === countMin &&
      viewCountMax === countMax &&
      viewAccMin === accMin &&
      viewAccMax === accMax;
  }

  function updateChartControls() {
    if (!chartZoomIn || !chartZoomOut || !chartResetView) return;
    const atDefault = isChartViewDefault();
    chartResetView.disabled = atDefault;
    chartZoomOut.disabled = atDefault;
  }

  function enforceChartViewBounds() {
    const minCountSpan = Math.max((countMax - countMin) / 200, 1);
    const minAccSpan = Math.max((accMax - accMin) / 200, 0.1);
    const dataCountSpan = countMax - countMin || 1;
    const dataAccSpan = accMax - accMin || 1;

    let countSpan = viewCountMax - viewCountMin;
    let accSpan = viewAccMax - viewAccMin;

    if (countSpan < minCountSpan) {
      const cx = (viewCountMin + viewCountMax) / 2;
      viewCountMin = cx - minCountSpan / 2;
      viewCountMax = cx + minCountSpan / 2;
      countSpan = minCountSpan;
    }
    if (accSpan < minAccSpan) {
      const cy = (viewAccMin + viewAccMax) / 2;
      viewAccMin = cy - minAccSpan / 2;
      viewAccMax = cy + minAccSpan / 2;
      accSpan = minAccSpan;
    }

    if (countSpan >= dataCountSpan) {
      viewCountMin = countMin;
      viewCountMax = countMax;
    } else {
      if (viewCountMin < countMin) {
        viewCountMin = countMin;
        viewCountMax = countMin + countSpan;
      }
      if (viewCountMax > countMax) {
        viewCountMax = countMax;
        viewCountMin = countMax - countSpan;
      }
    }

    if (accSpan >= dataAccSpan) {
      viewAccMin = accMin;
      viewAccMax = accMax;
    } else {
      if (viewAccMin < accMin) {
        viewAccMin = accMin;
        viewAccMax = accMin + accSpan;
      }
      if (viewAccMax > accMax) {
        viewAccMax = accMax;
        viewAccMin = accMax - accSpan;
      }
    }
  }

  function applyChartView() {
    enforceChartViewBounds();
    updateChartControls();
    renderChart();
  }

  function zoomChartAt(factor, focusCount, focusAcc) {
    const countSpan = viewCountMax - viewCountMin;
    const accSpan = viewAccMax - viewAccMin;
    const newCountSpan = countSpan / factor;
    const newAccSpan = accSpan / factor;
    const countRatio = countSpan ? (focusCount - viewCountMin) / countSpan : 0.5;
    const accRatio = accSpan ? (focusAcc - viewAccMin) / accSpan : 0.5;

    viewCountMin = focusCount - newCountSpan * countRatio;
    viewCountMax = focusCount + newCountSpan * (1 - countRatio);
    viewAccMin = focusAcc - newAccSpan * accRatio;
    viewAccMax = focusAcc + newAccSpan * (1 - accRatio);

    applyChartView();
  }

  function zoomChart(direction) {
    const factor = direction === 'in' ? CHART_ZOOM_FACTOR : 1 / CHART_ZOOM_FACTOR;
    zoomChartAt(
      factor,
      (viewCountMin + viewCountMax) / 2,
      (viewAccMin + viewAccMax) / 2
    );
  }

  chartZoomIn.addEventListener('click', () => zoomChart('in'));
  chartZoomOut.addEventListener('click', () => zoomChart('out'));
  chartResetView.addEventListener('click', () => {
    resetChartView();
    renderChart();
  });

  const CHART_WHEEL_ZOOM = 1.12;
  let isPanning = false;
  let panStartX = 0;
  let panStartY = 0;
  let panViewCountMin = 0;
  let panViewCountMax = 0;
  let panViewAccMin = 0;
  let panViewAccMax = 0;
  let panPlotW = 1;
  let panPlotH = 1;

  function getChartLayout() {
    const width = chartWrapper.clientWidth;
    const height = chartWrapper.clientHeight;
    return {
      width,
      height,
      plotW: width - CHART_MARGIN.left - CHART_MARGIN.right,
      plotH: height - CHART_MARGIN.top - CHART_MARGIN.bottom,
    };
  }

  function isInPlotArea(clientX, clientY) {
    const rect = chartWrapper.getBoundingClientRect();
    const x = clientX - rect.left;
    const y = clientY - rect.top;
    return x >= CHART_MARGIN.left &&
      x <= rect.width - CHART_MARGIN.right &&
      y >= CHART_MARGIN.top &&
      y <= rect.height - CHART_MARGIN.bottom;
  }

  function chartPixelToData(clientX, clientY) {
    const rect = chartWrapper.getBoundingClientRect();
    const { plotW, plotH, height } = getChartLayout();
    const x = clientX - rect.left;
    const y = clientY - rect.top;
    const count = viewCountMin + ((x - CHART_MARGIN.left) / plotW) * (viewCountMax - viewCountMin);
    const accuracy = viewAccMin + ((height - CHART_MARGIN.bottom - y) / plotH) * (viewAccMax - viewAccMin);
    return { count, accuracy };
  }

  function endChartPan() {
    if (!isPanning) return;
    isPanning = false;
    chartWrapper.classList.remove('chart-wrapper--panning');
    updateChartControls();
  }

  chartWrapper.addEventListener('wheel', (e) => {
    if (!allRows.length || !isInPlotArea(e.clientX, e.clientY)) return;
    e.preventDefault();
    const { count, accuracy } = chartPixelToData(e.clientX, e.clientY);
    const factor = e.deltaY < 0 ? CHART_WHEEL_ZOOM : 1 / CHART_WHEEL_ZOOM;
    zoomChartAt(factor, count, accuracy);
  }, { passive: false });

  chartWrapper.addEventListener('mousedown', (e) => {
    if (e.button !== 1 || !allRows.length) return;
    e.preventDefault();
    const { plotW, plotH } = getChartLayout();
    isPanning = true;
    panStartX = e.clientX;
    panStartY = e.clientY;
    panViewCountMin = viewCountMin;
    panViewCountMax = viewCountMax;
    panViewAccMin = viewAccMin;
    panViewAccMax = viewAccMax;
    panPlotW = plotW;
    panPlotH = plotH;
    chartWrapper.classList.add('chart-wrapper--panning');
    chartTooltip.hidden = true;
  });

  window.addEventListener('mousemove', (e) => {
    if (!isPanning) return;
    const countSpan = panViewCountMax - panViewCountMin;
    const accSpan = panViewAccMax - panViewAccMin;
    const countDelta = -(e.clientX - panStartX) / panPlotW * countSpan;
    const accDelta = (e.clientY - panStartY) / panPlotH * accSpan;

    viewCountMin = panViewCountMin + countDelta;
    viewCountMax = panViewCountMax + countDelta;
    viewAccMin = panViewAccMin + accDelta;
    viewAccMax = panViewAccMax + accDelta;

    enforceChartViewBounds();
    renderChart();
  });

  window.addEventListener('mouseup', (e) => {
    if (e.button === 1) endChartPan();
  });

  function accClass(accuracy) {
    return accuracy < 50 ? 'low' : accuracy < 80 ? 'mid' : 'high';
  }

  function renderChart() {
    if (!scatterPlot || !chartWrapper) return;

    const width = chartWrapper.clientWidth;
    const height = chartWrapper.clientHeight;
    if (!width || !height) {
      requestAnimationFrame(renderChart);
      return;
    }

    const plotW = width - CHART_MARGIN.left - CHART_MARGIN.right;
    const plotH = height - CHART_MARGIN.top - CHART_MARGIN.bottom;
    const cRange = viewCountMax - viewCountMin || 1;
    const aRange = viewAccMax - viewAccMin || 1;

    const xScale = (count) => CHART_MARGIN.left + ((count - viewCountMin) / cRange) * plotW;
    const yScale = (accuracy) => CHART_MARGIN.top + plotH - ((accuracy - viewAccMin) / aRange) * plotH;

    const xTicks = niceTicks(viewCountMin, viewCountMax, 5);
    const yTicks = niceTicks(viewAccMin, viewAccMax, 5);

    let svg = `<g class="plot-area">`;

    yTicks.forEach((tick) => {
      const y = yScale(tick);
      svg += `<line class="grid-line" x1="${CHART_MARGIN.left}" y1="${y}" x2="${width - CHART_MARGIN.right}" y2="${y}" />`;
      svg += `<line class="axis-tick" x1="${CHART_MARGIN.left - 4}" y1="${y}" x2="${CHART_MARGIN.left}" y2="${y}" />`;
      svg += `<text class="axis-label" x="${CHART_MARGIN.left - 8}" y="${y + 4}" text-anchor="end">${formatTick(tick)}%</text>`;
    });

    xTicks.forEach((tick) => {
      const x = xScale(tick);
      svg += `<line class="grid-line" x1="${x}" y1="${CHART_MARGIN.top}" x2="${x}" y2="${height - CHART_MARGIN.bottom}" />`;
      svg += `<line class="axis-tick" x1="${x}" y1="${height - CHART_MARGIN.bottom}" x2="${x}" y2="${height - CHART_MARGIN.bottom + 4}" />`;
      svg += `<text class="axis-label" x="${x}" y="${height - CHART_MARGIN.bottom + 18}" text-anchor="middle">${formatTick(tick)}</text>`;
    });

    svg += `<line class="axis-line" x1="${CHART_MARGIN.left}" y1="${CHART_MARGIN.top}" x2="${CHART_MARGIN.left}" y2="${height - CHART_MARGIN.bottom}" />`;
    svg += `<line class="axis-line" x1="${CHART_MARGIN.left}" y1="${height - CHART_MARGIN.bottom}" x2="${width - CHART_MARGIN.right}" y2="${height - CHART_MARGIN.bottom}" />`;
    svg += `<text class="axis-title" x="${CHART_MARGIN.left + plotW / 2}" y="${height - 6}" text-anchor="middle">Count</text>`;
    svg += `<text class="axis-title" x="14" y="${CHART_MARGIN.top + plotH / 2}" text-anchor="middle" transform="rotate(-90 14 ${CHART_MARGIN.top + plotH / 2})">Accuracy</text>`;

    filteredRows.forEach((row, i) => {
      const cx = xScale(row.count);
      const cy = yScale(row.accuracy);
      const cls = accClass(row.accuracy);
      svg += `<circle class="plot-point-hit" data-index="${i}" cx="${cx}" cy="${cy}" r="8" />`;
      svg += `<circle class="plot-point plot-point--${cls}" data-index="${i}" cx="${cx}" cy="${cy}" r="4" />`;
    });

    svg += `</g>`;

    scatterPlot.setAttribute('viewBox', `0 0 ${width} ${height}`);
    scatterPlot.innerHTML = svg;

    scatterPlot.querySelectorAll('.plot-point-hit').forEach((hit) => {
      const idx = parseInt(hit.dataset.index, 10);
      const row = filteredRows[idx];
      const point = scatterPlot.querySelector(`.plot-point[data-index="${idx}"]`);

      hit.addEventListener('mouseenter', (e) => showChartTooltip(e, row, point));
      hit.addEventListener('mousemove', (e) => moveChartTooltip(e));
      hit.addEventListener('mouseleave', () => hideChartTooltip(point));
    });
  }

  function showChartTooltip(event, row, point) {
    chartTooltip.innerHTML =
      `<strong>Word:</strong> ${escapeHtml(row.word)}<br>` +
      `<span><strong>Count:</strong> ${row.count}</span><br>` +
      `<span><strong>Accuracy:</strong> ${row.accuracy.toFixed(1)}%</span>`;
    chartTooltip.hidden = false;
    point.classList.add('plot-point--active');
    moveChartTooltip(event);
  }

  function moveChartTooltip(event) {
    const rect = chartWrapper.getBoundingClientRect();
    chartTooltip.style.left = `${event.clientX - rect.left}px`;
    chartTooltip.style.top = `${event.clientY - rect.top}px`;
  }

  function hideChartTooltip(point) {
    chartTooltip.hidden = true;
    point.classList.remove('plot-point--active');
  }

  function niceTicks(min, max, targetCount) {
    if (min === max) return [min];
    const range = max - min;
    const roughStep = range / Math.max(targetCount - 1, 1);
    const magnitude = Math.pow(10, Math.floor(Math.log10(roughStep)));
    const residual = roughStep / magnitude;
    let step = magnitude;
    if (residual > 5) step = 10 * magnitude;
    else if (residual > 2) step = 5 * magnitude;
    else if (residual > 1) step = 2 * magnitude;

    const start = Math.ceil(min / step) * step;
    const ticks = [];
    for (let v = start; v <= max + step * 0.001; v += step) ticks.push(v);
    if (!ticks.length) ticks.push(min, max);
    return ticks;
  }

  function formatTick(value) {
    return Number.isInteger(value) ? String(value) : value.toFixed(1);
  }

  let resizeTimer;
  window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      if (allRows.length) renderChart();
    }, 150);
  });

  // Check if a default CSV was provided via the python launcher
  fetch('/default.csv')
    .then(res => {
      if (res.ok) return res.text();
      throw new Error('No default csv');
    })
    .then(text => {
      parseCSV(text);
      fileNameDisp.textContent = 'Command-line input';
      uploadZone.style.display = 'none';
      workspace.style.display = '';
      statsBar.style.display = '';
    })
    .catch(() => {
      // No default CSV, do nothing and wait for user upload
    });

})();
