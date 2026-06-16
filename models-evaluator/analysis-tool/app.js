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
