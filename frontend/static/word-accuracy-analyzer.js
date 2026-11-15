/**
 * Mountable Word Accuracy Analyzer (from models-evaluator/analysis-tool)
 */
(function (global) {
  'use strict';

  const WORKSPACE_HTML = '<div class="stats-bar" id="wa-stats-bar" style="display:none;margin-bottom:16px;">\n  <div class="stat-chip"><span class="stat-label">Total Words</span><span class="stat-value" id="wa-stat-total">0</span></div>\n  <div class="stat-chip"><span class="stat-label">Shown</span><span class="stat-value" id="wa-stat-shown">0</span></div>\n  <div class="stat-chip"><span class="stat-label">Avg Accuracy</span><span class="stat-value" id="wa-stat-avg">0%</span></div>\n</div><section class="workspace" id="wa-workspace" >\n        <!-- Filter Controls -->\n        <div class="controls-panel">\n          <div class="controls-header">\n            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"\n              stroke-linecap="round" stroke-linejoin="round">\n              <polygon points="22 3 2 3 10 12.46 10 19 14 21 14 12.46 22 3" />\n            </svg>\n            <h2>Filters</h2>\n            <button class="reset-btn" id="wa-reset-btn" title="Reset all filters">\n              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"\n                stroke-linecap="round" stroke-linejoin="round">\n                <polyline points="1 4 1 10 7 10" />\n                <path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10" />\n              </svg>\n              Reset\n            </button>\n          </div>\n\n          <div class="controls-grid">\n            <!-- Count Range -->\n            <div class="control-group">\n              <div class="control-label">\n                <span class="label-text">Count Range</span>\n                <span class="label-values" id="wa-count-range-display">1 — 100</span>\n              </div>\n              <div class="dual-slider" id="wa-count-slider">\n                <div class="slider-track">\n                  <div class="slider-range" id="wa-count-range-bar"></div>\n                </div>\n                <input type="range" class="slider-thumb slider-thumb--min" id="wa-count-min" min="0" max="100" value="0">\n                <input type="range" class="slider-thumb slider-thumb--max" id="wa-count-max" min="0" max="100" value="100">\n              </div>\n              <div class="input-row">\n                <div class="input-group">\n                  <label for="wa-count-min-input">Min</label>\n                  <input type="number" id="wa-count-min-input" class="num-input" value="0" min="0">\n                </div>\n                <div class="input-group">\n                  <label for="wa-count-max-input">Max</label>\n                  <input type="number" id="wa-count-max-input" class="num-input" value="100" min="0">\n                </div>\n              </div>\n            </div>\n\n            <!-- Accuracy Range -->\n            <div class="control-group">\n              <div class="control-label">\n                <span class="label-text">Accuracy Range</span>\n                <span class="label-values" id="wa-accuracy-range-display">0% — 100%</span>\n              </div>\n              <div class="dual-slider" id="wa-accuracy-slider">\n                <div class="slider-track">\n                  <div class="slider-range" id="wa-accuracy-range-bar"></div>\n                </div>\n                <input type="range" class="slider-thumb slider-thumb--min" id="wa-accuracy-min" min="0" max="100" value="0"\n                  step="0.1">\n                <input type="range" class="slider-thumb slider-thumb--max" id="wa-accuracy-max" min="0" max="100"\n                  value="100" step="0.1">\n              </div>\n              <div class="input-row">\n                <div class="input-group">\n                  <label for="wa-accuracy-min-input">Min %</label>\n                  <input type="number" id="wa-accuracy-min-input" class="num-input" value="0" min="0" max="100" step="0.1">\n                </div>\n                <div class="input-group">\n                  <label for="wa-accuracy-max-input">Max %</label>\n                  <input type="number" id="wa-accuracy-max-input" class="num-input" value="100" min="0" max="100"\n                    step="0.1">\n                </div>\n              </div>\n            </div>\n          </div>\n        </div>\n\n        <!-- Scatter Plot -->\n        <div class="chart-panel">\n          <div class="chart-header">\n            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"\n              stroke-linecap="round" stroke-linejoin="round">\n              <circle cx="6" cy="18" r="2" />\n              <circle cx="12" cy="8" r="2" />\n              <circle cx="18" cy="14" r="2" />\n              <line x1="4" y1="20" x2="20" y2="20" />\n              <line x1="4" y1="20" x2="4" y2="4" />\n            </svg>\n            <h2>Count vs Accuracy</h2>\n            <div class="chart-controls">\n              <button class="chart-ctrl-btn" id="wa-chart-zoom-out" title="Zoom out" aria-label="Zoom out">\n                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"\n                  stroke-linecap="round" stroke-linejoin="round">\n                  <circle cx="11" cy="11" r="8" />\n                  <line x1="21" y1="21" x2="16.65" y2="16.65" />\n                  <line x1="8" y1="11" x2="14" y2="11" />\n                </svg>\n              </button>\n              <button class="chart-ctrl-btn" id="wa-chart-zoom-in" title="Zoom in" aria-label="Zoom in">\n                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"\n                  stroke-linecap="round" stroke-linejoin="round">\n                  <circle cx="11" cy="11" r="8" />\n                  <line x1="21" y1="21" x2="16.65" y2="16.65" />\n                  <line x1="11" y1="8" x2="11" y2="14" />\n                  <line x1="8" y1="11" x2="14" y2="11" />\n                </svg>\n              </button>\n              <button class="chart-ctrl-btn chart-ctrl-btn--text" id="wa-chart-reset-view" title="Reset view">\n                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"\n                  stroke-linecap="round" stroke-linejoin="round">\n                  <polyline points="1 4 1 10 7 10" />\n                  <path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10" />\n                </svg>\n                Reset view\n              </button>\n            </div>\n          </div>\n          <div class="chart-wrapper" id="wa-chart-wrapper">\n            <svg id="wa-scatter-plot" class="scatter-plot" role="img"\n              aria-label="Scatter plot of word count versus accuracy"></svg>\n            <div id="wa-chart-tooltip" class="chart-tooltip" hidden></div>\n          </div>\n        </div>\n\n        <!-- Data Table -->\n        <div class="table-container">\n          <div class="table-header">\n            <div class="table-header-left">\n              <h2>\n                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"\n                  stroke-linecap="round" stroke-linejoin="round">\n                  <rect x="3" y="3" width="18" height="18" rx="2" ry="2" />\n                  <line x1="3" y1="9" x2="21" y2="9" />\n                  <line x1="3" y1="15" x2="21" y2="15" />\n                  <line x1="9" y1="3" x2="9" y2="21" />\n                </svg>\n                Results\n              </h2>\n              <span class="file-name" id="wa-file-name-display"></span>\n            </div>\n            <div class="table-header-right">\n              <input type="text" id="wa-search-input" class="search-input" placeholder="Search words..." />\n            </div>\n          </div>\n          <div class="table-scroll">\n            <table id="wa-data-table">\n              <thead>\n                <tr>\n                  <th class="sortable" data-sort="word" id="wa-th-word">\n                    Word\n                    <span class="sort-icon"></span>\n                  </th>\n                  <th class="sortable" data-sort="count" id="wa-th-count">\n                    Count\n                    <span class="sort-icon"></span>\n                  </th>\n                  <th class="sortable" data-sort="accuracy" id="wa-th-accuracy">\n                    Accuracy\n                    <span class="sort-icon"></span>\n                  </th>\n                </tr>\n              </thead>\n              <tbody id="wa-table-body">\n              </tbody>\n            </table>\n          </div>\n          <div class="table-footer" id="wa-table-footer">\n            <span id="wa-row-count-label">0 words</span>\n          </div>\n        </div>\n      </section>';

  function create(container) {
    if (!container) return null;
    container.classList.add('wa-analyzer');
    container.innerHTML = WORKSPACE_HTML;

  // ─── State ──────────────────────────────────────────────
  let allRows = [];          // { word: string, count: number, accuracy: number }[]
  let filteredRows = [];
  let sortCol = 'word';
  let sortDir = 'asc';       // 'asc' | 'desc'

  // Data-range boundaries (set after CSV load)
  let countMin = 0, countMax = 1;
  let accMin = 0, accMax = 100;

  // ─── DOM refs ───────────────────────────────────────────
  const uploadZone   = container.querySelector('#wa-upload-zone');
  const uploadCard   = container.querySelector('#wa-upload-card');
  const uploadBtn    = container.querySelector('#wa-upload-btn');
  const fileInput    = container.querySelector('#wa-file-input');
  const workspace    = container.querySelector('#wa-workspace');
  const statsBar     = container.querySelector('#wa-stats-bar');
  const tableBody    = container.querySelector('#wa-table-body');
  const rowCountLabel= container.querySelector('#wa-row-count-label');
  const fileNameDisp = container.querySelector('#wa-file-name-display');
  const resetBtn     = container.querySelector('#wa-reset-btn');
  const searchInput  = container.querySelector('#wa-search-input');

  // Sliders
  const countMinSlider = container.querySelector('#wa-count-min');
  const countMaxSlider = container.querySelector('#wa-count-max');
  const accMinSlider   = container.querySelector('#wa-accuracy-min');
  const accMaxSlider   = container.querySelector('#wa-accuracy-max');

  // Number inputs
  const countMinInput  = container.querySelector('#wa-count-min-input');
  const countMaxInput  = container.querySelector('#wa-count-max-input');
  const accMinInput    = container.querySelector('#wa-accuracy-min-input');
  const accMaxInput    = container.querySelector('#wa-accuracy-max-input');

  // Range bars
  const countRangeBar  = container.querySelector('#wa-count-range-bar');
  const accRangeBar    = container.querySelector('#wa-accuracy-range-bar');

  // Labels
  const countRangeDisp = container.querySelector('#wa-count-range-display');
  const accRangeDisp   = container.querySelector('#wa-accuracy-range-display');

  // Stats
  const statTotal      = container.querySelector('#wa-stat-total');
  const statShown      = container.querySelector('#wa-stat-shown');
  const statAvg        = container.querySelector('#wa-stat-avg');

  // Sort headers
  const thWord     = container.querySelector('#wa-th-word');
  const thCount    = container.querySelector('#wa-th-count');
  const thAccuracy = container.querySelector('#wa-th-accuracy');

  // Chart
  const chartWrapper = container.querySelector('#wa-chart-wrapper');
  const scatterPlot  = container.querySelector('#wa-scatter-plot');
  const chartTooltip = container.querySelector('#wa-chart-tooltip');
  const chartZoomIn  = container.querySelector('#wa-chart-zoom-in');
  const chartZoomOut = container.querySelector('#wa-chart-zoom-out');
  const chartResetView = container.querySelector('#wa-chart-reset-view');

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
    const anchorX = event.clientX - rect.left;
    const anchorY = event.clientY - rect.top;
    const padding = 8;
    const gap = 10;

    chartTooltip.style.left = `${anchorX}px`;
    chartTooltip.style.top = `${anchorY}px`;
    chartTooltip.style.transform = "translate(-50%, calc(-100% - 10px))";
    chartTooltip.classList.remove("chart-tooltip--below");

    const tooltipW = chartTooltip.offsetWidth;
    const tooltipH = chartTooltip.offsetHeight;

    if (anchorY - tooltipH - gap < padding) {
      chartTooltip.classList.add("chart-tooltip--below");
      chartTooltip.style.transform = `translate(-50%, ${gap}px)`;
    }

    let left = anchorX;
    if (left - tooltipW / 2 < padding) {
      left = padding + tooltipW / 2;
    } else if (left + tooltipW / 2 > rect.width - padding) {
      left = rect.width - padding - tooltipW / 2;
    }
    chartTooltip.style.left = `${left}px`;
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

    function loadVocabulary(vocabulary, label) {
      const rows = (Array.isArray(vocabulary) ? vocabulary : []).map((item) => ({
        word: String(item.word || ''),
        count: Number(item.count),
        accuracy: Number(item.accuracy),
      })).filter((r) => r.word && !Number.isNaN(r.count) && !Number.isNaN(r.accuracy));

      allRows = rows;
      if (!allRows.length) {
        workspace.style.display = 'none';
        statsBar.style.display = 'none';
        return false;
      }

      countMin = Math.min(...allRows.map((r) => r.count));
      countMax = Math.max(...allRows.map((r) => r.count));
      accMin = Math.min(...allRows.map((r) => r.accuracy));
      accMax = Math.max(...allRows.map((r) => r.accuracy));
      fileNameDisp.textContent = label || 'Decoding analysis';
      workspace.style.display = '';
      statsBar.style.display = 'flex';
      initSliders();
      resetChartView();
      applyFilters();
      requestAnimationFrame(renderChart);
      return true;
    }

    function destroy() {
      if (resizeTimer) clearTimeout(resizeTimer);
      container.innerHTML = '';
    }

    return { loadVocabulary, destroy };
  }

  global.WordAccuracyAnalyzer = { create };
})(window);
