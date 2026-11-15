/* Analyze page — vertical timeline of %_validated from timeline.json */

(function () {
  "use strict";

  const CHART_MARGIN = { top: 28, right: 20, bottom: 36, left: 88 };
  const PCT_MIN = -12;
  const PCT_MAX = 100;
  const MIN_ROW_HEIGHT = 52;
  const DAY_HEIGHT = 52;

  const timelineLoading = document.getElementById("timeline-loading");
  const timelineError = document.getElementById("timeline-error");
  const timelineEmpty = document.getElementById("timeline-empty");
  const chartWrapper = document.getElementById("chart-wrapper");
  const timelinePlot = document.getElementById("timeline-plot");
  const rootJsonList = document.getElementById("analyze-root-json-list");
  const analyzePlaceholder = document.getElementById("analyze-placeholder");
  const analyzePlaceholderLoading = document.getElementById("analyze-placeholder-loading");
  const analyzePlaceholderIdle = document.getElementById("analyze-placeholder-idle");
  const analyzeWorkspace = document.getElementById("analyze-workspace");
  const analyzeMain = document.getElementById("analyze-main");
  const analyzeSidebar = document.getElementById("analyze-sidebar");
  const analyzeSidebarOverlay = document.getElementById("analyze-sidebar-overlay");
  const analyzeTimelineToggle = document.getElementById("analyze-timeline-toggle");
  const folderStatsPanel = document.getElementById("folder-stats-panel");
  const folderStatsCloseBtn = document.getElementById("folder-stats-close-btn");
  const folderStatsTitle = document.getElementById("folder-stats-title");
  const folderStatsSubtitle = document.getElementById("folder-stats-subtitle");
  const folderStatsLoading = document.getElementById("folder-stats-loading");
  const folderStatsError = document.getElementById("folder-stats-error");
  const folderStatsContent = document.getElementById("folder-stats-content");
  const folderStatsDoughnut = document.getElementById("folder-stats-doughnut");
  const folderStatsChartCenter = document.getElementById("folder-stats-chart-center");
  const folderStatsValidated = document.getElementById("folder-stats-validated");
  const folderStatsTotal = document.getElementById("folder-stats-total");
  const folderStatsDuration = document.getElementById("folder-stats-duration");
  const folderStatsProcessed = document.getElementById("folder-stats-processed");
  const folderStatsLegendValidated = document.getElementById("folder-stats-legend-validated");
  const folderStatsLegendValidatedLabel = document.getElementById("folder-stats-legend-validated-label");
  const folderStatsLegendRemainderLabel = document.getElementById("folder-stats-legend-remainder-label");
  const folderStatsModelsList = document.getElementById("folder-stats-models-list");
  const folderStatsVocabBtn = document.getElementById("folder-stats-vocab-btn");
  const decodingPanel = document.getElementById("decoding-panel");
  const decodingPanelPlaceholder = document.getElementById("decoding-panel-placeholder");
  const decodingPanelLoading = document.getElementById("decoding-panel-loading");
  const decodingPanelError = document.getElementById("decoding-panel-error");
  const decodingPanelAnalyzer = document.getElementById("decoding-panel-analyzer");
  const decodingVocabularyLoading = document.getElementById("decoding-vocabulary-loading");
  const decodingVocabularyCount = document.getElementById("decoding-vocabulary-count");
  const decodingVocabularyPlot = document.getElementById("decoding-vocabulary-plot");
  const decodingVocabularyPlotSvg = document.getElementById("decoding-vocabulary-quadrant-plot");
  const decodingVocabularyPlotTooltip = document.getElementById("decoding-vocabulary-plot-tooltip");
  const decodingVocabularyTableWrap = document.getElementById("decoding-vocabulary-table-wrap");
  const decodingVocabularyTableBody = document.getElementById("decoding-vocabulary-table-body");
  const decodingVocabularyEmpty = document.getElementById("decoding-vocabulary-empty");
  const wordEntriesModal = document.getElementById("word-entries-modal");
  const wordEntriesModalClose = document.getElementById("word-entries-modal-close");
  const wordEntriesModalTitle = document.getElementById("word-entries-modal-title");
  const wordEntriesLoading = document.getElementById("word-entries-loading");
  const wordEntriesEmpty = document.getElementById("word-entries-empty");
  const wordEntriesList = document.getElementById("word-entries-list");
  const viewerPanel = document.getElementById("viewer-panel");
  const viewerCloseBtn = document.getElementById("viewer-close-btn");
  const viewerWrapBtn = document.getElementById("viewer-wrap-btn");
  const viewerCopyBtn = document.getElementById("viewer-copy-btn");
  const viewerFilename = document.getElementById("viewer-filename");
  const viewerSize = document.getElementById("viewer-size");
  const viewerLineCount = document.getElementById("viewer-line-count");
  const viewerLoading = document.getElementById("viewer-loading");
  const viewerPre = document.getElementById("viewer-pre");
  const chartTooltip = document.getElementById("chart-tooltip");
  const timelineInfoButton = document.querySelector(".timeline-info-button");
  const timelineInfoTooltip = document.getElementById("timeline-info-tooltip");
  const settingsIcon = document.querySelector(".settings-icon");
  const settingsModal = document.getElementById("settings-modal");
  const darkModeSwitch = document.getElementById("dark-mode-switch");
  const themeModeLabel = document.getElementById("theme-mode-label");

  const TOOLTIP_PADDING = 8;
  const TOOLTIP_GAP = 10;
  const AGGREGATE_FOLDER = "*";
  const NAME_LABEL_WIDTH_OFFSET = 12;
  const NAME_LINE_HEIGHT = 11;
  const NAME_GAP_BELOW_DATE = 4;
  const PROCESSED_MARK_WIDTH = 12;

  let events = [];
  let wrapEnabled = false;
  let currentViewerContent = "";
  let selectedEventIndex = null;
  let folderStatsRequestId = 0;

  function applyTheme(theme) {
    document.documentElement.classList.toggle("dark", theme === "dark");
    if (darkModeSwitch) darkModeSwitch.checked = theme === "dark";
    if (themeModeLabel) themeModeLabel.textContent = theme === "dark" ? "Dark" : "Bright";
    localStorage.setItem("theme", theme);
  }

  if (settingsIcon && settingsModal) {
    settingsIcon.addEventListener("click", (event) => {
      event.preventDefault();
      settingsModal.style.display = "flex";
      settingsModal.setAttribute("aria-hidden", "false");
    });

    settingsModal.addEventListener("click", (event) => {
      if (event.target === settingsModal) {
        settingsModal.style.display = "none";
        settingsModal.setAttribute("aria-hidden", "true");
      }
    });

    const closeButton = settingsModal.querySelector(".modal-close");
    closeButton?.addEventListener("click", () => {
      settingsModal.style.display = "none";
      settingsModal.setAttribute("aria-hidden", "true");
    });
  }

  const initialTheme = localStorage.getItem("theme") || "dark";
  applyTheme(initialTheme);
  darkModeSwitch?.addEventListener("change", () => {
    applyTheme(darkModeSwitch.checked ? "dark" : "bright");
  });

  function positionTimelineInfoTooltip() {
    if (!timelineInfoButton || !timelineInfoTooltip) return;

    const buttonRect = timelineInfoButton.getBoundingClientRect();
    const tooltipRect = timelineInfoTooltip.getBoundingClientRect();
    const gap = 8;
    const left = Math.min(
      buttonRect.left,
      window.innerWidth - tooltipRect.width - gap
    );
    const top = Math.min(
      buttonRect.bottom + gap,
      window.innerHeight - tooltipRect.height - gap
    );

    timelineInfoTooltip.style.left = `${Math.max(gap, left)}px`;
    timelineInfoTooltip.style.top = `${Math.max(gap, top)}px`;
  }

  function showTimelineInfoTooltip() {
    if (!timelineInfoTooltip) return;
    timelineInfoTooltip.classList.add("is-visible");
    positionTimelineInfoTooltip();
  }

  function hideTimelineInfoTooltip() {
    timelineInfoTooltip?.classList.remove("is-visible");
  }

  timelineInfoButton?.addEventListener("mouseenter", showTimelineInfoTooltip);
  timelineInfoButton?.addEventListener("mouseleave", hideTimelineInfoTooltip);
  timelineInfoButton?.addEventListener("focus", showTimelineInfoTooltip);
  timelineInfoButton?.addEventListener("blur", hideTimelineInfoTooltip);
  window.addEventListener("resize", positionTimelineInfoTooltip);
  window.addEventListener("scroll", positionTimelineInfoTooltip, true);
  let currentFolderName = null;
  let selectedModelVersion = null;
  let decodingRequestId = 0;
  let inferenceVocabularyRequestId = 0;
  let vocabularyItems = [];
  let vocabularySortCol = "word";
  let vocabularySortDir = "asc";
  let currentFolderEntries = [];
  let currentFolderEntriesFolder = null;
  let currentWordEntriesWord = null;
  let wordEntriesGenFuncs = {};
  let wordAccuracyAnalyzer = null;
  let cachedAggregateStats = null;

  function setTimelineSidebarOpen(open) {
    if (!analyzeSidebar) return;
    const isMobile = window.matchMedia("(max-width: 768px)").matches;
    const isOpen = isMobile && open;
    analyzeSidebar.classList.toggle("open", isOpen);
    analyzeSidebar.setAttribute("aria-hidden", String(isMobile && !isOpen));
    analyzeSidebarOverlay?.classList.toggle("active", isOpen);
    analyzeTimelineToggle?.setAttribute("aria-expanded", String(isOpen));
    analyzeTimelineToggle?.setAttribute("aria-label", isOpen ? "Close timeline" : "Open timeline");
    if (analyzeTimelineToggle) {
      analyzeTimelineToggle.title = isOpen ? "Close timeline" : "Open timeline";
    }
  }

  analyzeTimelineToggle?.addEventListener("click", () => {
    setTimelineSidebarOpen(!analyzeSidebar?.classList.contains("open"));
  });
  analyzeSidebarOverlay?.addEventListener("click", () => setTimelineSidebarOpen(false));
  window.addEventListener("keydown", (event) => {
    if (event.key === "Escape") setTimelineSidebarOpen(false);
  });
  window.addEventListener("resize", () => {
    if (!window.matchMedia("(max-width: 768px)").matches) {
      setTimelineSidebarOpen(false);
    }
  });
  setTimelineSidebarOpen(false);

  const viewerState = {
    wrapEnabled: false,
    isMobile: false,
    currentJsonContext: null,
  };

  const jsonViewer = window.JsonViewer.create({
    state: viewerState,
    elements: {
      viewerPanel,
      viewerCloseBtn,
      viewerWrapBtn,
      viewerCopyBtn,
      viewerFilename,
      viewerSize,
      viewerLineCount,
      viewerLoading,
      viewerPre,
    },
    onOpen: () => {
      if (analyzePlaceholder) analyzePlaceholder.hidden = true;
      if (analyzeWorkspace) analyzeWorkspace.hidden = true;
    },
    onClose: () => {
      if (selectedEventIndex != null) {
        showFolderStatsPanel();
      } else {
        openAggregateStats();
      }
    },
  });

  function showPlaceholderLoading() {
    if (!analyzePlaceholder) return;
    analyzePlaceholder.hidden = false;
    if (analyzePlaceholderLoading) analyzePlaceholderLoading.hidden = false;
    if (analyzePlaceholderIdle) analyzePlaceholderIdle.hidden = true;
    if (analyzeWorkspace) analyzeWorkspace.hidden = true;
    if (analyzeMain) analyzeMain.classList.remove("analyze-main--workspace");
    resetDecodingPanel();
  }

  function showPlaceholder() {
    if (!analyzePlaceholder) return;
    analyzePlaceholder.hidden = false;
    if (analyzePlaceholderLoading) analyzePlaceholderLoading.hidden = true;
    if (analyzePlaceholderIdle) analyzePlaceholderIdle.hidden = false;
    if (analyzeWorkspace) analyzeWorkspace.hidden = true;
    if (analyzeMain) analyzeMain.classList.remove("analyze-main--workspace");
    resetDecodingPanel();
  }

  function showFolderStatsPanel() {
    if (analyzePlaceholder) {
      analyzePlaceholder.hidden = true;
      if (analyzePlaceholderLoading) analyzePlaceholderLoading.hidden = true;
      if (analyzePlaceholderIdle) analyzePlaceholderIdle.hidden = true;
    }
    if (analyzeWorkspace) analyzeWorkspace.hidden = false;
    if (analyzeMain) analyzeMain.classList.add("analyze-main--workspace");
  }

  const VOCABULARY_IDLE_MESSAGE =
    "Select a point on the timeline to see unique words for that folder.";

  function clearInferenceVocabulary(message) {
    inferenceVocabularyRequestId += 1;
    vocabularyItems = [];
    if (decodingVocabularyLoading) decodingVocabularyLoading.hidden = true;
    if (decodingVocabularyCount) decodingVocabularyCount.textContent = "";
    if (decodingVocabularyPlot) decodingVocabularyPlot.hidden = true;
    if (decodingVocabularyPlotTooltip) decodingVocabularyPlotTooltip.hidden = true;
    if (decodingVocabularyTableWrap) decodingVocabularyTableWrap.hidden = true;
    if (decodingVocabularyTableBody) decodingVocabularyTableBody.innerHTML = "";
    if (decodingVocabularyEmpty) {
      decodingVocabularyEmpty.hidden = false;
      decodingVocabularyEmpty.textContent = message || VOCABULARY_IDLE_MESSAGE;
    }
    if (folderStatsVocabBtn) folderStatsVocabBtn.hidden = true;
  }

  function resetInferenceVocabulary() {
    inferenceVocabularyRequestId += 1;
    vocabularyItems = [];
    if (decodingVocabularyLoading) decodingVocabularyLoading.hidden = false;
    if (decodingVocabularyCount) decodingVocabularyCount.textContent = "";
    if (decodingVocabularyPlot) decodingVocabularyPlot.hidden = true;
    if (decodingVocabularyPlotTooltip) decodingVocabularyPlotTooltip.hidden = true;
    if (decodingVocabularyTableWrap) decodingVocabularyTableWrap.hidden = true;
    if (decodingVocabularyTableBody) decodingVocabularyTableBody.innerHTML = "";
    if (decodingVocabularyEmpty) decodingVocabularyEmpty.hidden = true;
    if (folderStatsVocabBtn) folderStatsVocabBtn.hidden = true;
  }

  function normalizeVocabularyItems(words) {
    if (!Array.isArray(words)) return [];
    return words
      .map((item) => {
        if (typeof item === "string" && item) {
          return { word: item, count: null, user_is_validated: false };
        }
        if (!item || typeof item !== "object") return null;
        const word = String(item.word || "").trim();
        if (!word) return null;
        const count = Number(item.count);
        return {
          word,
          count: Number.isFinite(count) ? count : null,
          user_is_validated: Boolean(item.user_is_validated),
          reviewer_is_reviewed: Boolean(item.reviewer_is_reviewed),
        };
      })
      .filter(Boolean);
  }

  function formatUserValidated(value) {
    return value ? "Yes" : "No";
  }

  function formatReviewerIsReviewed(value) {
    return value ? "Yes" : "No";
  }

  function getQuadrantPointColor(item) {
    if (item.user_is_validated && item.reviewer_is_reviewed) return "#38bdf8";
    if (item.user_is_validated && !item.reviewer_is_reviewed) return "#f97316";
    if (!item.user_is_validated && item.reviewer_is_reviewed) return "#8b5cf6";
    return "#64748b";
  }

  function getQuadrantLabel(item) {
    if (item.user_is_validated && item.reviewer_is_reviewed) return "Validated / Reviewed";
    if (item.user_is_validated && !item.reviewer_is_reviewed) return "Validated / Unreviewed";
    if (!item.user_is_validated && item.reviewer_is_reviewed) return "Unvalidated / Reviewed";
    return "Unvalidated / Unreviewed";
  }

  function hashString(str) {
    let hash = 0;
    for (let i = 0; i < str.length; i += 1) {
      hash = (hash << 5) - hash + str.charCodeAt(i);
      hash |= 0;
    }
    return hash;
  }

  function renderVocabularyPlot(words) {
    if (!decodingVocabularyPlot || !decodingVocabularyPlotSvg) return;
    if (!Array.isArray(words) || !words.length) {
      decodingVocabularyPlot.hidden = true;
      return;
    }

    const measuredWidth = decodingVocabularyPlotSvg.parentElement?.clientWidth || 520;
    const width = Math.max(
      measuredWidth,
      window.matchMedia("(max-width: 768px)").matches ? 440 : 0,
    );
    const height = 280;
    const padding = { top: 34, right: 20, bottom: 24, left: 32 };
    const plotWidth = width - padding.left - padding.right;
    const plotHeight = height - padding.top - padding.bottom;
    const axisX = padding.left + plotWidth / 2;
    const axisY = padding.top + plotHeight / 2;

    const counts = words.map((item) => Number(item.count) || 1);
    const minCount = Math.min(...counts);
    const maxCount = Math.max(...counts);

    const radiusForCount = (count) => {
      const minR = 5;
      const maxR = 18;
      if (minCount === maxCount) return (minR + maxR) / 2;
      const t = Math.log(Math.max(1, count)) / Math.log(Math.max(1, maxCount));
      return Math.round(minR + t * (maxR - minR));
    };

    const quadWidth = plotWidth / 2;
    const quadHeight = plotHeight / 2;
    const quadrantLabels = [
      { x: padding.left + quadWidth * 0.18, y: padding.top + quadHeight * 0.2, text: "Unvalidated / Unreviewed" },
      { x: padding.left + quadWidth * 1.18, y: padding.top + quadHeight * 0.2, text: "Validated / Unreviewed" },
      { x: padding.left + quadWidth * 0.18, y: padding.top + quadHeight * 1.25, text: "Unvalidated / Reviewed" },
      { x: padding.left + quadWidth * 1.18, y: padding.top + quadHeight * 1.25, text: "Validated / Reviewed" },
    ];

    const byQuadrant = [[], [], [], []];
    words.forEach((item) => {
      const index = item.user_is_validated
        ? item.reviewer_is_reviewed ? 3 : 1
        : item.reviewer_is_reviewed ? 2 : 0;
      byQuadrant[index].push(item);
    });

    let svg = "";
    svg += `<rect x="0" y="0" width="${width}" height="${height}" fill="transparent" />`;
    svg += `<line class="quadrant-line" x1="${axisX}" y1="${padding.top}" x2="${axisX}" y2="${height - padding.bottom}" />`;
    svg += `<line class="quadrant-line" x1="${padding.left}" y1="${axisY}" x2="${width - padding.right}" y2="${axisY}" />`;

    quadrantLabels.forEach((label) => {
      svg += `<text class="quadrant-label" x="${label.x}" y="${label.y}">${escapeHtml(label.text)}</text>`;
    });

    byQuadrant.forEach((group, idx) => {
      if (!group.length) return;
      const maxRadius = Math.max(...group.map((item) => radiusForCount(Number(item.count) || 1)));
      const cellWidth = Math.max(maxRadius * 2 + 10, quadWidth / Math.max(1, Math.ceil(Math.sqrt(group.length))));
      const cellHeight = Math.max(maxRadius * 2 + 10, quadHeight / Math.max(1, Math.ceil(Math.sqrt(group.length))));
      const cols = Math.max(1, Math.min(group.length, Math.floor(quadWidth / cellWidth)));
      const rows = Math.ceil(group.length / cols);
      const baseX = padding.left + (idx % 2) * quadWidth;
      const baseY = padding.top + (idx < 2 ? 0 : quadHeight);

      group.sort((a, b) => (Number(b.count) || 0) - (Number(a.count) || 0));

      group.forEach((item, itemIndex) => {
        const row = Math.floor(itemIndex / cols);
        const col = itemIndex % cols;
        const radius = radiusForCount(Number(item.count) || 1);
        const cx = baseX + (col + 0.5) * (quadWidth / Math.max(cols, 1));
        const cy = baseY + (row + 0.5) * (quadHeight / Math.max(rows, 1));
        const clampedCx = Math.max(padding.left + radius, Math.min(width - padding.right - radius, cx));
        const clampedCy = Math.max(padding.top + radius, Math.min(height - padding.bottom - radius, cy));
        const fill = getQuadrantPointColor(item);
        const label = getQuadrantLabel(item);
        svg += `<circle class="quadrant-point" data-word="${escapeHtml(item.word)}" cx="${clampedCx}" cy="${clampedCy}" r="${radius}" fill="${fill}" stroke="rgba(255,255,255,0.08)" data-label="${escapeHtml(label)}" data-count="${escapeHtml(String(item.count))}" />`;
        svg += `<circle class="quadrant-point-outline" cx="${clampedCx}" cy="${clampedCy}" r="${radius + 1}" fill="none" />`;
      });
    });

    decodingVocabularyPlotSvg.setAttribute("viewBox", `0 0 ${width} ${height}`);
    decodingVocabularyPlotSvg.setAttribute("width", String(width));
    decodingVocabularyPlotSvg.setAttribute("height", String(height));
    decodingVocabularyPlotSvg.innerHTML = svg;
    decodingVocabularyPlot.hidden = false;

    const svgPoints = decodingVocabularyPlotSvg.querySelectorAll(".quadrant-point");
    svgPoints.forEach((point) => {
      const word = point.dataset.word;
      const count = point.dataset.count;
      const label = point.dataset.label;
      point.addEventListener("mouseenter", (event) => {
        if (!decodingVocabularyPlotTooltip) return;
        decodingVocabularyPlotTooltip.innerHTML =
          `<span><strong>${escapeHtml(word)}</strong></span><br>` +
          `<span>${escapeHtml(label)}</span><br>` +
          `<span>Count: ${escapeHtml(count)}</span>`;
        decodingVocabularyPlotTooltip.hidden = false;
        point.classList.add("quadrant-point--active");
        moveVocabularyPlotTooltip(event);
      });
      point.addEventListener("mousemove", moveVocabularyPlotTooltip);
      point.addEventListener("mouseleave", () => {
        if (decodingVocabularyPlotTooltip) decodingVocabularyPlotTooltip.hidden = true;
        point.classList.remove("quadrant-point--active");
      });
      point.addEventListener("click", () => {
        openWordEntriesModal(word);
      });
    });
  }

  function moveVocabularyPlotTooltip(event) {
    if (!decodingVocabularyPlotTooltip || decodingVocabularyPlotTooltip.hidden) return;
    const rect = decodingVocabularyPlot.getBoundingClientRect();
    const tooltipW = decodingVocabularyPlotTooltip.offsetWidth;
    const tooltipH = decodingVocabularyPlotTooltip.offsetHeight;
    let left = event.clientX - rect.left - tooltipW / 2;
    let top = event.clientY - rect.top - tooltipH - 10;
    if (left < 8) left = 8;
    if (left + tooltipW > rect.width - 8) left = rect.width - tooltipW - 8;
    if (top < 8) top = event.clientY - rect.top + 10;
    decodingVocabularyPlotTooltip.style.left = `${left}px`;
    decodingVocabularyPlotTooltip.style.top = `${top}px`;
  }

  function resetVocabularyPlot() {
    if (decodingVocabularyPlot) decodingVocabularyPlot.hidden = true;
    if (decodingVocabularyPlotTooltip) decodingVocabularyPlotTooltip.hidden = true;
    if (decodingVocabularyPlotSvg) decodingVocabularyPlotSvg.innerHTML = "";
  }

  function compareVocabularyItems(a, b, col, dir) {
    let cmp = 0;
    if (col === "word") {
      cmp = a.word.localeCompare(b.word, undefined, { sensitivity: "base" });
    } else if (col === "count") {
      cmp = (a.count ?? -1) - (b.count ?? -1);
    } else if (col === "user_is_validated") {
      cmp = Number(a.user_is_validated) - Number(b.user_is_validated);
    } else if (col === "reviewer_is_reviewed") {
      cmp = Number(a.reviewer_is_reviewed) - Number(b.reviewer_is_reviewed);
    }
    return dir === "asc" ? cmp : -cmp;
  }

  function sortVocabularyItems(items) {
    return items
      .slice()
      .sort((a, b) => compareVocabularyItems(a, b, vocabularySortCol, vocabularySortDir));
  }

  function updateVocabularySortHeaders() {
    document.querySelectorAll(".decoding-vocabulary-table th[data-sort]").forEach((th) => {
      th.classList.remove("sorted-asc", "sorted-desc");
      if (th.dataset.sort === vocabularySortCol) {
        th.classList.add(vocabularySortDir === "asc" ? "sorted-asc" : "sorted-desc");
      }
    });
  }

  function renderVocabularyTableBody(items) {
    if (!decodingVocabularyTableBody) return;
    decodingVocabularyTableBody.innerHTML = items
      .map(({ word, count, user_is_validated, reviewer_is_reviewed }) => (
        "<tr>" +
        `<td class="decoding-vocabulary-word" role="button" tabindex="0" title="Show entries containing this word">${escapeHtml(word)}</td>` +
        `<td class="decoding-vocabulary-count">${count != null ? escapeHtml(String(count)) : "—"}</td>` +
        `<td class="decoding-vocabulary-validated">${escapeHtml(formatUserValidated(user_is_validated))}</td>` +
        `<td class="decoding-vocabulary-reviewed">${escapeHtml(formatReviewerIsReviewed(reviewer_is_reviewed))}</td>` +
        "</tr>"
      ))
      .join("");
  }

  function renderInferenceVocabulary(words) {
    if (decodingVocabularyLoading) decodingVocabularyLoading.hidden = true;

    const items = normalizeVocabularyItems(words);
    vocabularyItems = items;
    vocabularySortCol = "word";
    vocabularySortDir = "asc";
    if (decodingVocabularyCount) {
      decodingVocabularyCount.textContent =
        items.length === 1 ? "1 word" : `${items.length} words`;
    }

    if (!items.length) {
      resetVocabularyPlot();
      if (decodingVocabularyTableWrap) decodingVocabularyTableWrap.hidden = true;
      if (decodingVocabularyEmpty) {
        decodingVocabularyEmpty.hidden = false;
        decodingVocabularyEmpty.textContent = "No inference transcripts found.";
      }
      updateVocabularySortHeaders();
      return;
    }

    if (decodingVocabularyEmpty) decodingVocabularyEmpty.hidden = true;
    if (decodingVocabularyTableWrap) decodingVocabularyTableWrap.hidden = false;
    renderVocabularyPlot(items);
    updateVocabularySortHeaders();
    renderVocabularyTableBody(sortVocabularyItems(vocabularyItems));
  }

  function initVocabularyTableSorting() {
    document.querySelectorAll(".decoding-vocabulary-table th[data-sort]").forEach((th) => {
      th.addEventListener("click", () => {
        const col = th.dataset.sort;
        if (!col || !vocabularyItems.length) return;
        if (vocabularySortCol === col) {
          vocabularySortDir = vocabularySortDir === "asc" ? "desc" : "asc";
        } else {
          vocabularySortCol = col;
          vocabularySortDir = "asc";
        }
        updateVocabularySortHeaders();
        renderVocabularyTableBody(sortVocabularyItems(vocabularyItems));
      });
    });
  }

  function coerceBool(value) {
    if (typeof value === "boolean") return value;
    if (typeof value === "number") return value !== 0;
    if (typeof value === "string") {
      return ["1", "true", "yes", "y", "on"].includes(value.trim().toLowerCase());
    }
    return false;
  }

  function extractInferenceVocabulary(entries) {
    const counts = new Map();
    const inValidated = new Set();
    const inUnvalidated = new Set();
    const inReviewed = new Set();
    const inUnreviewed = new Set();
    (Array.isArray(entries) ? entries : []).forEach((entry) => {
      if (!entry || typeof entry !== "object") return;
      const text = String(entry.inference_transcript || "").trim();
      if (!text) return;
      const validated = coerceBool(entry.user_is_validated);
      const reviewed = coerceBool(entry.reviewer_is_reviewed);
      for (const word of text.split(/\s+/)) {
        if (!word) continue;
        counts.set(word, (counts.get(word) || 0) + 1);
        if (validated) inValidated.add(word);
        else inUnvalidated.add(word);
        if (reviewed) inReviewed.add(word);
        else inUnreviewed.add(word);
      }
    });
    return Array.from(counts.entries())
      .map(([word, count]) => ({
        word,
        count,
        user_is_validated: inValidated.has(word) && !inUnvalidated.has(word),
        reviewer_is_reviewed: inReviewed.has(word) && !inUnreviewed.has(word),
      }));
  }

  function entryContainsWord(entry, word) {
    const text = String(entry?.inference_transcript || "").trim();
    if (!text || !word) return false;
    return text.split(/\s+/).includes(word);
  }

  function indicesForWord(entries, word) {
    return entries
      .map((entry, index) => (entryContainsWord(entry, word) ? index : -1))
      .filter((index) => index >= 0);
  }

  async function ensureFolderEntries(folder, forceRefresh) {
    if (
      !forceRefresh &&
      currentFolderEntriesFolder === folder &&
      Array.isArray(currentFolderEntries)
    ) {
      return currentFolderEntries;
    }

    const res = await fetch(`/api/folder?folder=${encodeURIComponent(folder)}`);
    const data = await res.json();
    if (!res.ok || data.error) {
      throw new Error(data.error || "Failed to load folder entries.");
    }

    currentFolderEntries = Array.isArray(data.data) ? data.data : [];
    currentFolderEntriesFolder = folder;
    return currentFolderEntries;
  }

  function buildWordEntriesContext(folder, entries) {
    return {
      folder,
      entries,
      genFuncs: wordEntriesGenFuncs,
      playbackRate: 1.0,
      listEl: wordEntriesList,
      onAfterChange: async (action) => {
        await ensureFolderEntries(folder, true);
        if (currentWordEntriesWord) {
          if (wordEntriesList) {
            wordEntriesList.innerHTML = "";
            wordEntriesList.hidden = true;
            wordEntriesList.style.display = "none";
          }
          await renderWordEntriesList(currentWordEntriesWord);
        }
        if (action === "delete" || action === "generate" || action === "save") {
          renderInferenceVocabulary(extractInferenceVocabulary(currentFolderEntries));
        }
      },
      onDelete: async (ctx, index, row) => {
        const res = await fetch("/api/delete_entry", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ folder: ctx.folder, index }),
        });
        const data = await res.json();
        if (!data.ok) {
          alert("Delete failed: " + (data.error || "unknown error"));
          return false;
        }

        row.classList.add("deleting");
        await new Promise((resolve) => setTimeout(resolve, 320));
        row.remove();
        await ensureFolderEntries(folder, true);
        if (typeof ctx.onAfterChange === "function") {
          await ctx.onAfterChange("delete", index);
        }
        return true;
      },
    };
  }

  async function renderWordEntriesList(word) {
    const folder = currentFolderName;
    if (!folder || folder === AGGREGATE_FOLDER) return;

    if (wordEntriesLoading) {
      wordEntriesLoading.hidden = false;
      wordEntriesLoading.style.display = "flex";
    }
    if (wordEntriesEmpty) {
      wordEntriesEmpty.hidden = true;
      wordEntriesEmpty.style.display = "none";
    }
    if (wordEntriesList) {
      wordEntriesList.hidden = false;
      wordEntriesList.style.display = "flex";
      wordEntriesList.innerHTML = "";
    }

    const entries = await ensureFolderEntries(folder);
    const indices = indicesForWord(entries, word);

    if (wordEntriesLoading) {
      wordEntriesLoading.hidden = true;
      wordEntriesLoading.style.display = "none";
    }

    if (!indices.length) {
      if (wordEntriesEmpty) {
        wordEntriesEmpty.hidden = false;
        wordEntriesEmpty.style.display = "flex";
      }
      if (wordEntriesList) {
        wordEntriesList.hidden = true;
        wordEntriesList.style.display = "none";
      }
      return;
    }

    if (!window.ExplorerEntries) {
      if (wordEntriesEmpty) {
        wordEntriesEmpty.hidden = false;
        wordEntriesEmpty.style.display = "flex";
        const msg = wordEntriesEmpty.querySelector("p");
        if (msg) msg.textContent = "Entry viewer failed to load.";
      }
      if (wordEntriesList) {
        wordEntriesList.hidden = true;
        wordEntriesList.style.display = "none";
      }
      return;
    }

    if (wordEntriesEmpty) {
      wordEntriesEmpty.hidden = true;
      wordEntriesEmpty.style.display = "none";
    }
    if (wordEntriesList) {
      wordEntriesList.hidden = false;
      wordEntriesList.style.display = "flex";
    }
    wordEntriesGenFuncs = {};
    ExplorerEntries.renderList(
      wordEntriesList,
      buildWordEntriesContext(folder, entries),
      indices
    );
  }

  async function openWordEntriesModal(word) {
    if (!word || !currentFolderName || currentFolderName === AGGREGATE_FOLDER) return;

    currentWordEntriesWord = word;
    if (wordEntriesModal) {
      wordEntriesModal.hidden = false;
      wordEntriesModal.style.display = "flex";
      wordEntriesModal.setAttribute("aria-hidden", "false");
    }
    if (wordEntriesModalTitle) {
      wordEntriesModalTitle.textContent = `"${word}" in ${currentFolderName}`;
    }

    try {
      await renderWordEntriesList(word);
    } catch (err) {
      if (wordEntriesLoading) {
        wordEntriesLoading.hidden = true;
        wordEntriesLoading.style.display = "none";
      }
      if (wordEntriesEmpty) {
        wordEntriesEmpty.hidden = false;
        wordEntriesEmpty.style.display = "flex";
        const msg = wordEntriesEmpty.querySelector("p");
        if (msg) msg.textContent = err.message || "Failed to load entries.";
      }
      if (wordEntriesList) {
        wordEntriesList.hidden = true;
        wordEntriesList.style.display = "none";
      }
    }
  }

  function closeWordEntriesModal() {
    if (wordEntriesModal) {
      wordEntriesModal.hidden = true;
      wordEntriesModal.style.display = "none";
      wordEntriesModal.setAttribute("aria-hidden", "true");
    }
    if (wordEntriesList) {
      wordEntriesList.querySelectorAll("audio").forEach((audio) => {
        audio.pause();
      });
      wordEntriesList.innerHTML = "";
      wordEntriesList.hidden = true;
      wordEntriesList.style.display = "none";
    }
    if (wordEntriesLoading) {
      wordEntriesLoading.hidden = true;
      wordEntriesLoading.style.display = "none";
    }
    if (wordEntriesEmpty) {
      wordEntriesEmpty.hidden = true;
      wordEntriesEmpty.style.display = "none";
    }
    wordEntriesGenFuncs = {};
    currentWordEntriesWord = null;
    if (currentFolderName && currentFolderName !== AGGREGATE_FOLDER) {
      loadInferenceVocabulary(currentFolderName);
    }
  }

  function initWordEntriesModal() {
    if (wordEntriesModalClose) {
      wordEntriesModalClose.addEventListener("click", closeWordEntriesModal);
    }
    if (wordEntriesModal) {
      wordEntriesModal.addEventListener("click", (event) => {
        if (event.target === wordEntriesModal) closeWordEntriesModal();
      });
    }
    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape" && wordEntriesModal && !wordEntriesModal.hidden) {
        closeWordEntriesModal();
      }
    });
  }

  function initVocabularyWordClicks() {
    if (!decodingVocabularyTableBody) return;
    decodingVocabularyTableBody.addEventListener("click", (event) => {
      const wordCell = event.target.closest(".decoding-vocabulary-word");
      if (!wordCell) return;
      const word = wordCell.textContent.trim();
      if (word) openWordEntriesModal(word);
    });
    decodingVocabularyTableBody.addEventListener("keydown", (event) => {
      if (event.key !== "Enter" && event.key !== " ") return;
      const wordCell = event.target.closest(".decoding-vocabulary-word");
      if (!wordCell) return;
      event.preventDefault();
      const word = wordCell.textContent.trim();
      if (word) openWordEntriesModal(word);
    });
  }

  async function loadInferenceVocabulary(folder, preloadedWords) {
    // Increment the global request id to cancel any in-flight requests,
    // then capture the current id for this request.
    resetInferenceVocabulary();
    const requestId = inferenceVocabularyRequestId;

    if (Array.isArray(preloadedWords)) {
      renderInferenceVocabulary(preloadedWords);
      return;
    }

    try {
      // Add a timeout to avoid hanging the UI if the backend is slow or blocked.
      const controller = new AbortController();
      const timeoutMs = 15000; // 15s timeout
      const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
      const res = await fetch(`/api/folder?folder=${encodeURIComponent(folder)}`, { signal: controller.signal });
      clearTimeout(timeoutId);
      const data = await res.json();
      if (requestId !== inferenceVocabularyRequestId) return;

      if (!res.ok || data.error) {
        renderInferenceVocabulary([]);
        return;
      }

      currentFolderEntries = Array.isArray(data.data) ? data.data : [];
      currentFolderEntriesFolder = folder;
      renderInferenceVocabulary(extractInferenceVocabulary(currentFolderEntries));
    } catch (_err) {
      if (requestId !== inferenceVocabularyRequestId) return;
      renderInferenceVocabulary([]);
    } finally {
      if (requestId !== inferenceVocabularyRequestId) return;
      if (decodingVocabularyLoading) decodingVocabularyLoading.hidden = true;
    }
  }

  function resetDecodingPanel() {
    decodingRequestId += 1;
    selectedModelVersion = null;
    if (wordAccuracyAnalyzer) {
      wordAccuracyAnalyzer.destroy();
      wordAccuracyAnalyzer = null;
    }
    if (decodingPanelPlaceholder) decodingPanelPlaceholder.hidden = false;
    if (decodingPanelLoading) decodingPanelLoading.hidden = true;
    if (decodingPanelError) {
      decodingPanelError.hidden = true;
      decodingPanelError.textContent = "";
    }
    if (decodingPanelAnalyzer) {
      decodingPanelAnalyzer.hidden = true;
      decodingPanelAnalyzer.innerHTML = "";
    }
    if (folderStatsModelsList) {
      folderStatsModelsList.querySelectorAll(".folder-stats-model-item.is-selected").forEach((item) => {
        item.classList.remove("is-selected");
      });
    }
  }

  function showDecodingLoading() {
    if (decodingPanelPlaceholder) decodingPanelPlaceholder.hidden = true;
    if (decodingPanelLoading) decodingPanelLoading.hidden = false;
    if (decodingPanelError) decodingPanelError.hidden = true;
    if (decodingPanelAnalyzer) decodingPanelAnalyzer.hidden = true;
  }

  function showDecodingError(message) {
    if (decodingPanelPlaceholder) decodingPanelPlaceholder.hidden = true;
    if (decodingPanelLoading) decodingPanelLoading.hidden = true;
    if (decodingPanelError) {
      decodingPanelError.hidden = false;
      decodingPanelError.textContent = message;
    }
    if (decodingPanelAnalyzer) decodingPanelAnalyzer.hidden = true;
  }

  function clearSelectedPoint() {
    if (selectedEventIndex == null) return;
    timelinePlot
      .querySelectorAll(`.plot-point[data-index="${selectedEventIndex}"]`)
      .forEach((point) => point.classList.remove("plot-point--selected"));
    selectedEventIndex = null;
  }

  function setSelectedPoint(index) {
    clearSelectedPoint();
    selectedEventIndex = index;
    timelinePlot
      .querySelectorAll(`.plot-point[data-index="${index}"]`)
      .forEach((point) => point.classList.add("plot-point--selected"));
  }

  function renderDoughnutChart(validated, total) {
    if (!folderStatsDoughnut) return;

    const size = 220;
    const cx = size / 2;
    const cy = size / 2;
    const radius = 78;
    const stroke = 28;
    const circumference = 2 * Math.PI * radius;
    const safeTotal = Math.max(0, total);
    const safeValidated = Math.max(0, Math.min(validated, safeTotal));
    const pct = safeTotal > 0 ? (safeValidated / safeTotal) * 100 : 0;
    const validatedDash = safeTotal > 0 ? (safeValidated / safeTotal) * circumference : 0;
    const validatedColorFill = validatedColor(pct);
    const remainderColor = "#3a3f5c";

    folderStatsDoughnut.setAttribute("viewBox", `0 0 ${size} ${size}`);
    folderStatsDoughnut.innerHTML =
      `<circle class="doughnut-track" cx="${cx}" cy="${cy}" r="${radius}" ` +
      `fill="none" stroke="${remainderColor}" stroke-width="${stroke}" />` +
      `<circle class="doughnut-segment" cx="${cx}" cy="${cy}" r="${radius}" ` +
      `fill="none" stroke="${validatedColorFill}" stroke-width="${stroke}" ` +
      `stroke-dasharray="${validatedDash} ${circumference - validatedDash}" ` +
      `stroke-linecap="round" transform="rotate(-90 ${cx} ${cy})" />`;

    if (folderStatsChartCenter) {
      const pctLabel = safeTotal > 0
        ? (Number.isInteger(pct) ? `${pct}%` : `${pct.toFixed(1)}%`)
        : "—";
      folderStatsChartCenter.innerHTML =
        `<span class="folder-stats-chart-pct">${escapeHtml(pctLabel)}</span>` +
        `<span class="folder-stats-chart-label">validated</span>`;
    }

    if (folderStatsLegendValidated) {
      folderStatsLegendValidated.style.background = validatedColorFill;
    }
    if (folderStatsLegendValidatedLabel) {
      folderStatsLegendValidatedLabel.textContent = `Validated (${safeValidated})`;
    }
    if (folderStatsLegendRemainderLabel) {
      const remainder = Math.max(0, safeTotal - safeValidated);
      folderStatsLegendRemainderLabel.textContent = `Not validated (${remainder})`;
    }
  }

  function showFolderStatsLoading() {
    showFolderStatsPanel();
    folderStatsLoading.hidden = false;
    folderStatsError.hidden = true;
    folderStatsContent.hidden = true;
  }

  function showFolderStatsError(message) {
    showFolderStatsPanel();
    folderStatsLoading.hidden = true;
    folderStatsError.hidden = false;
    folderStatsError.textContent = message;
    folderStatsContent.hidden = true;
  }

  function renderFolderStats(event, stats) {
    const isAggregate = Boolean(stats?.aggregate);
    const folder = isAggregate ? AGGREGATE_FOLDER : (stats.folder || event?.folder_name || "—");
    currentFolderName = folder;
    const name = event?.name || (isAggregate ? "All folders" : folder);
    const date = event?.date || (isAggregate ? "Aggregated" : "—");
    const total = Number(stats.total_audios) || 0;
    const validated = Number(stats.validated_audios) || 0;
    const duration = stats.total_duration_str || "—";

    folderStatsTitle.textContent = name;
    if (isAggregate) {
      const folderCount = Number(stats.folder_count) || 0;
      folderStatsSubtitle.textContent =
        folderCount === 1 ? "1 folder · aggregated" : `${folderCount} folders · aggregated`;
      const processedFolders = Number(stats.processed_folders) || 0;
      folderStatsProcessed.textContent = `${processedFolders} / ${folderCount} folders`;
    } else {
      folderStatsSubtitle.textContent = `${folder} · ${date}`;
      folderStatsProcessed.textContent = stats.processed ? "Yes" : "No";
    }

    folderStatsValidated.textContent = String(validated);
    folderStatsTotal.textContent = String(total);
    folderStatsDuration.textContent = duration;

    renderDoughnutChart(validated, total);

    folderStatsLoading.hidden = true;
    folderStatsError.hidden = true;
    folderStatsContent.hidden = false;
    showFolderStatsPanel();

    if (folderStatsVocabBtn) {
      const isAggregate = Boolean(stats?.aggregate);
      folderStatsVocabBtn.hidden = isAggregate;
    }

    if (folderStatsModelsList) {
      folderStatsModelsList.innerHTML = "";
      const loadingItem = document.createElement("li");
      loadingItem.className = "folder-stats-models-empty";
      loadingItem.textContent = "Loading model versions…";
      folderStatsModelsList.appendChild(loadingItem);
    }
    resetDecodingPanel();

    fetchInferenceModelVersions(folder, stats).then((versions) => {
      if (folderStatsTitle.textContent !== name) return;
      renderInferenceModelVersions(folder, versions);
    });
    if (isAggregate) {
      clearInferenceVocabulary();
      currentFolderEntries = [];
      currentFolderEntriesFolder = null;
    } else {
      loadInferenceVocabulary(folder, stats.inference_vocabulary);
      ensureFolderEntries(folder).catch(() => {});
    }
  }

  function showInferenceVocabularyView() {
    if (!currentFolderName || currentFolderName === AGGREGATE_FOLDER) return;
    // Switch UI to the vocabulary view (hide any active model visualization)
    resetDecodingPanel();
    if (decodingPanelPlaceholder) decodingPanelPlaceholder.hidden = false;
    if (decodingPanelAnalyzer) {
      decodingPanelAnalyzer.hidden = true;
      decodingPanelAnalyzer.innerHTML = "";
    }
    if (decodingPanelError) decodingPanelError.hidden = true;

    // Ensure vocabulary is (re)loaded and scroll the decoding vocabulary into view
    loadInferenceVocabulary(currentFolderName).catch(() => {});
    const vocabEl = document.getElementById("decoding-vocabulary");
    if (vocabEl) {
      vocabEl.scrollIntoView({ behavior: "smooth", block: "center" });
    }
  }

  async function fetchAggregateStats() {
    if (cachedAggregateStats) {
      return cachedAggregateStats;
    }

    let res = await fetch("/api/aggregate_stats");
    if (res.status === 404) {
      res = await fetch("/api/analyze_timeline");
    }
    const data = await res.json();
    if (!res.ok || data.error || data.ok === false) {
      throw new Error(data.error || "Failed to load aggregated statistics.");
    }
    const stats = data.aggregate_stats || data;
    if (!stats || stats.aggregate !== true) {
      throw new Error("Aggregated statistics are unavailable. Restart the frontend server.");
    }
    cachedAggregateStats = stats;
    return stats;
  }

  async function openAggregateStats(preloadedStats) {
    const requestId = ++folderStatsRequestId;
    clearSelectedPoint();
    currentFolderName = AGGREGATE_FOLDER;
    showFolderStatsLoading();
    folderStatsTitle.textContent = "All folders";
    folderStatsSubtitle.textContent = "Aggregated statistics";

    try {
      const data = preloadedStats || await fetchAggregateStats();
      if (requestId !== folderStatsRequestId) return;

      renderFolderStats(
        { name: "All folders", date: "Aggregated", folder_name: AGGREGATE_FOLDER },
        data
      );
    } catch (err) {
      if (requestId !== folderStatsRequestId) return;
      showFolderStatsError(err.message || "Network error.");
    }
  }

  async function openFolderStats(event, index) {
    setTimelineSidebarOpen(false);
    const folder = event.folder_name;
    if (!folder) {
      showFolderStatsError("No folder linked to this timeline point.");
      return;
    }

    setSelectedPoint(index);
    showFolderStatsLoading();
    folderStatsTitle.textContent = event.name || folder;
    folderStatsSubtitle.textContent = `${folder} · ${event.date || "—"}`;

    const requestId = ++folderStatsRequestId;
    try {
      const res = await fetch(`/api/folder_stats?folder=${encodeURIComponent(folder)}`);
      const data = await res.json();
      if (requestId !== folderStatsRequestId) return;

      if (!res.ok || data.error) {
        showFolderStatsError(data.error || "Failed to load folder statistics.");
        return;
      }

      const recomputedPct = Number(data.pct_validated);
      if (!Number.isFinite(recomputedPct)) {
        throw new Error("Folder statistics returned an invalid validation percentage.");
      }
      event.pct_validated = recomputedPct;
      renderFolderStats(event, data);
      renderTimeline();
    } catch (err) {
      if (requestId !== folderStatsRequestId) return;
      showFolderStatsError("Network error: " + err.message);
    }
  }

  function closeFolderStats() {
    folderStatsRequestId += 1;
    resetDecodingPanel();
    openAggregateStats();
  }

  function uniqueInferenceModelVersions(entries) {
    const seen = new Set();
    const versions = [];
    (Array.isArray(entries) ? entries : []).forEach((entry) => {
      if (!entry || typeof entry !== "object") return;
      const version = String(entry.inference_model_version || entry.inference_model || "").trim();
      if (!version || seen.has(version)) return;
      seen.add(version);
      versions.push(version);
    });
    versions.sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" }));
    return versions;
  }

  async function fetchAggregateModelVersions() {
    const res = await fetch("/api/aggregate_model_versions");
    if (res.status === 404) {
      const fallback = await fetch("/api/aggregate_stats?model_versions=1");
      const data = await fallback.json();
      if (!fallback.ok || data.error) {
        throw new Error(data.error || "Failed to load model versions.");
      }
      return Array.isArray(data.inference_model_versions) ? data.inference_model_versions : [];
    }
    const data = await res.json();
    if (!res.ok || data.error) {
      throw new Error(data.error || "Failed to load model versions.");
    }
    return Array.isArray(data.inference_model_versions) ? data.inference_model_versions : [];
  }

  async function fetchInferenceModelVersions(folder, stats) {
    if (Array.isArray(stats?.inference_model_versions)) {
      return stats.inference_model_versions;
    }

    if (folder === AGGREGATE_FOLDER) {
      try {
        return await fetchAggregateModelVersions();
      } catch (_err) {
        return [];
      }
    }

    try {
      const res = await fetch(`/api/folder?folder=${encodeURIComponent(folder)}`);
      const data = await res.json();
      if (!res.ok || data.error) return [];
      return uniqueInferenceModelVersions(data.data);
    } catch (_err) {
      return [];
    }
  }

  function formatPctMetric(value) {
    if (value == null || Number.isNaN(Number(value))) return "—";
    return `${Number(value).toFixed(1)}%`;
  }

  function buildModelSummary(metrics) {
    if (!metrics?.metrics_available) {
      const count = metrics?.reviewed_sample_count ?? 0;
      return count ? `${count} reviewed` : "No reviewed samples";
    }
    return `WER ${formatPctMetric(metrics.wer)} · MWA ${formatPctMetric(metrics.mwa)}`;
  }

  function buildDecodingLabel(folder, modelVersion, metrics) {
    const folderLabel = folder === AGGREGATE_FOLDER ? "All folders" : folder;
    const parts = [folderLabel, modelVersion];
    if (metrics?.metrics_available) {
      parts.push(
        `WER ${formatPctMetric(metrics.wer)}`,
        `CER ${formatPctMetric(metrics.cer)}`,
        `WMR ${formatPctMetric(metrics.wmr)}`,
        `MWA ${formatPctMetric(metrics.mwa)}`
      );
    }
    return parts.filter(Boolean).join(" · ");
  }

  async function loadDecodingPerformance(folder, modelVersion, listItem, summaryEl) {
    const requestId = ++decodingRequestId;
    selectedModelVersion = modelVersion;
    showDecodingLoading();

    if (folderStatsModelsList) {
      folderStatsModelsList.querySelectorAll(".folder-stats-model-item.is-selected").forEach((item) => {
        item.classList.remove("is-selected");
      });
    }
    if (listItem) listItem.classList.add("is-selected");

    try {
      const res = await fetch(
        `/api/decoding_performance?folder=${encodeURIComponent(folder)}&model_version=${encodeURIComponent(modelVersion)}`
      );
      const data = await res.json();
      if (requestId !== decodingRequestId) return null;

      if (!res.ok || data.error) {
        showDecodingError(data.error || "Failed to load decoding metrics.");
        if (summaryEl) summaryEl.textContent = "Error";
        return null;
      }

      if (summaryEl) summaryEl.textContent = buildModelSummary(data);

      if (!data.metrics_available || !Array.isArray(data.vocabulary) || !data.vocabulary.length) {
        showDecodingError(
          data.error ||
            "No word-level metrics available for this model version (reviewed samples with ground truth required)."
        );
        return data;
      }

      if (!window.WordAccuracyAnalyzer) {
        showDecodingError("Visualization module not loaded.");
        return data;
      }

      if (wordAccuracyAnalyzer) {
        wordAccuracyAnalyzer.destroy();
        wordAccuracyAnalyzer = null;
      }

      decodingPanelAnalyzer.hidden = false;
      decodingPanelAnalyzer.innerHTML = "";
      wordAccuracyAnalyzer = window.WordAccuracyAnalyzer.create(decodingPanelAnalyzer);
      const loaded = wordAccuracyAnalyzer.loadVocabulary(
        data.vocabulary,
        buildDecodingLabel(folder, modelVersion, data)
      );

      if (decodingPanelPlaceholder) decodingPanelPlaceholder.hidden = true;
      if (decodingPanelLoading) decodingPanelLoading.hidden = true;
      if (decodingPanelError) decodingPanelError.hidden = true;

      if (!loaded) {
        showDecodingError("No word-level metrics available for this model version.");
      }

      return data;
    } catch (err) {
      if (requestId !== decodingRequestId) return null;
      showDecodingError("Network error: " + err.message);
      if (summaryEl) summaryEl.textContent = "Error";
      return null;
    }
  }

  function createModelVersionItem(folder, version) {
    const li = document.createElement("li");
    li.className = "folder-stats-model-item";

    const button = document.createElement("button");
    button.type = "button";
    button.className = "folder-stats-model-btn";

    const nameSpan = document.createElement("span");
    nameSpan.className = "folder-stats-model-name";
    nameSpan.textContent = version;

    const summarySpan = document.createElement("span");
    summarySpan.className = "folder-stats-model-summary";
    summarySpan.textContent = "Analyze";

    button.appendChild(nameSpan);
    button.appendChild(summarySpan);
    button.addEventListener("click", () => {
      loadDecodingPerformance(folder, version, li, summarySpan);
    });

    li.appendChild(button);
    return li;
  }

  function renderInferenceModelVersions(folder, versions) {
    if (!folderStatsModelsList) return;
    resetDecodingPanel();
    folderStatsModelsList.innerHTML = "";

    const items = Array.isArray(versions) ? versions.filter(Boolean) : [];
    if (!items.length) {
      const li = document.createElement("li");
      li.className = "folder-stats-models-empty";
      li.textContent = "No model versions found.";
      folderStatsModelsList.appendChild(li);
      return;
    }

    items.forEach((version) => {
      folderStatsModelsList.appendChild(createModelVersionItem(folder, version));
    });
  }

  if (folderStatsCloseBtn) {
    folderStatsCloseBtn.addEventListener("click", closeFolderStats);
  }

  function openJsonViewerRoot(file) {
    return jsonViewer.openJsonViewerRoot(file);
  }

  let textMeasurer = null;

  function getTextMeasurer() {
    if (!textMeasurer) {
      const canvas = document.createElement("canvas");
      textMeasurer = canvas.getContext("2d");
      textMeasurer.font = '9px "JetBrains Mono", monospace';
    }
    return textMeasurer;
  }

  function measureTextWidth(text) {
    return getTextMeasurer().measureText(text).width;
  }

  function wrapAxisName(text, maxWidth) {
    const words = String(text).split(/\s+/).filter(Boolean);
    const lines = [];
    let current = "";

    for (const word of words) {
      const candidate = current ? `${current} ${word}` : word;
      if (measureTextWidth(candidate) > maxWidth && current) {
        lines.push(current);
        current = word;
      } else {
        current = candidate;
      }
    }
    if (current) lines.push(current);

    const wrapped = [];
    for (const line of lines) {
      if (measureTextWidth(line) <= maxWidth) {
        wrapped.push(line);
        continue;
      }
      let chunk = "";
      for (const ch of line) {
        const candidate = chunk + ch;
        if (measureTextWidth(candidate) > maxWidth && chunk) {
          wrapped.push(chunk);
          chunk = ch;
        } else {
          chunk = candidate;
        }
      }
      if (chunk) wrapped.push(chunk);
    }
    return wrapped;
  }

  function measureNameBlock(name, maxWidth) {
    const lines = wrapAxisName(name, maxWidth);
    return {
      lines,
      height: lines.length * NAME_LINE_HEIGHT + 2,
    };
  }

  function renderAxisNameLabel(y, nameLabel, chartHeight, nameLabelWidth) {
    const textWidth = nameLabelWidth - (nameLabel.processed ? PROCESSED_MARK_WIDTH : 0);
    const block = measureNameBlock(nameLabel.text, textWidth);
    const foWidth = nameLabelWidth;
    const foHeight = block.height;
    const foX = CHART_MARGIN.left - 8 - foWidth;
    let foY = y + NAME_GAP_BELOW_DATE;

    if (foY + foHeight > chartHeight - 14) {
      foY = Math.max(4, y - 12 - foHeight);
    }

    return (
      `<foreignObject x="${foX}" y="${foY}" width="${foWidth}" height="${foHeight}">` +
      `<div xmlns="http://www.w3.org/1999/xhtml" class="axis-name-fo">` +
      `${nameLabel.processed ? '<span class="material-symbols-outlined axis-name-processed-mark" aria-label="Processed">check_circle</span>' : ""}` +
      `<span class="axis-name-text">${escapeHtml(nameLabel.text)}</span></div>` +
      "</foreignObject>"
    );
  }

  function timelineFolderLabel(event) {
    return {
      text: event.folder_name || event.name || "",
      processed: Boolean(event.processed),
    };
  }

  function computeExtraBottomPadding(parsed, yScale, baseHeight, nameLabelWidth) {
    let extraBottom = 0;
    parsed.forEach((item) => {
      if (item.event.type === "event") return;
      const nameLabel = timelineFolderLabel(item.event);
      if (!nameLabel.text) return;
      const y = yScale(item);
      const textWidth = nameLabelWidth - (nameLabel.processed ? PROCESSED_MARK_WIDTH : 0);
      const block = measureNameBlock(nameLabel.text, textWidth);
      const belowDate = y + 12 + block.height;
      if (belowDate > baseHeight - 14) {
        extraBottom = Math.max(extraBottom, belowDate - (baseHeight - 14));
      }
    });
    return extraBottom;
  }

  function parseEventDate(dateStr) {
    const parts = String(dateStr).split(".");
    if (parts.length !== 3) return null;
    const y = parseInt(parts[0], 10);
    const m = parseInt(parts[1], 10) - 1;
    const d = parseInt(parts[2], 10);
    const dt = new Date(y, m, d);
    return Number.isNaN(dt.getTime()) ? null : dt;
  }

  function validatedColor(pct) {
    const value = Math.max(0, Math.min(100, pct));
    const t = value / 100;
    let r;
    let g;
    let b;
    if (t <= 0.5) {
      const u = t * 2;
      r = Math.round(239 + (251 - 239) * u);
      g = Math.round(68 + (191 - 68) * u);
      b = Math.round(68 + (36 - 68) * u);
    } else {
      const u = (t - 0.5) * 2;
      r = Math.round(251 + (34 - 251) * u);
      g = Math.round(191 + (197 - 191) * u);
      b = Math.round(36 + (94 - 36) * u);
    }
    return `rgb(${r}, ${g}, ${b})`;
  }


  function renderRootJsonFiles(files) {
    // The Analyze timeline sidebar intentionally does not list root JSON files.
    // JSON files remain available in the Curate view sidebar.
    if (!rootJsonList) return;
    rootJsonList.innerHTML = "";
  }
  function showLoading(isLoading) {
    timelineLoading.style.display = isLoading ? "flex" : "none";
  }

  function showError(message) {
    timelineError.hidden = false;
    timelineError.textContent = message;
    timelineEmpty.hidden = true;
    chartWrapper.hidden = true;
  }

  function showEmpty() {
    timelineEmpty.hidden = false;
    timelineError.hidden = true;
    chartWrapper.hidden = true;
  }

  function showChart() {
    timelineEmpty.hidden = true;
    timelineError.hidden = true;
    chartWrapper.hidden = false;
  }

  function timeYScale(parsed, plotTop) {
    const firstTime = parsed[0].date.getTime();
    const rowsByDay = new Map();
    let maxOffset = 0;

    parsed.forEach((item) => {
      const dayOffset = Math.round((item.date.getTime() - firstTime) / 86400000);
      const sameDayOffset = rowsByDay.get(dayOffset) || 0;
      item.dayOffset = dayOffset;
      item.sameDayOffset = sameDayOffset;
      rowsByDay.set(dayOffset, sameDayOffset + 1);
      maxOffset = Math.max(maxOffset, dayOffset * DAY_HEIGHT + sameDayOffset * MIN_ROW_HEIGHT);
    });

    return {
      scale: (item) => plotTop + item.dayOffset * DAY_HEIGHT + item.sameDayOffset * MIN_ROW_HEIGHT + MIN_ROW_HEIGHT / 2,
      contentHeight: maxOffset + MIN_ROW_HEIGHT,
    };
  }

  function pctXScale(pct, plotLeft, plotW) {
    const clamped = Math.max(PCT_MIN, Math.min(PCT_MAX, pct));
    return plotLeft + ((clamped - PCT_MIN) / (PCT_MAX - PCT_MIN)) * plotW;
  }

  function renderTimeline() {
    hidePointTooltip();

    if (!events.length) {
      showEmpty();
      return;
    }

    showChart();

    const width = chartWrapper.clientWidth || 320;
    const parsed = events
      .map((event, index) => ({
        event,
        index,
        date: parseEventDate(event.date),
      }))
      .filter((item) => item.date !== null);

    if (!parsed.length) {
      showError("Timeline events have invalid dates.");
      return;
    }

    parsed.sort((a, b) => {
      const diff = a.date - b.date;
      if (diff !== 0) return diff;
      if (a.event.type === "data" && b.event.type !== "data") return -1;
      if (a.event.type !== "data" && b.event.type === "data") return 1;
      return a.index - b.index;
    });
    const plotW = width - CHART_MARGIN.left - CHART_MARGIN.right;
    const yScaleData = timeYScale(parsed, CHART_MARGIN.top);
    const plotH = Math.max(
      chartWrapper.clientHeight - CHART_MARGIN.top - CHART_MARGIN.bottom,
      yScaleData.contentHeight,
    );
    const yScale = yScaleData.scale;
    const nameLabelWidth = CHART_MARGIN.left - NAME_LABEL_WIDTH_OFFSET;
    const baseHeight = plotH + CHART_MARGIN.top + CHART_MARGIN.bottom;
    const extraBottom = computeExtraBottomPadding(parsed, yScale, baseHeight, nameLabelWidth);
    const height = baseHeight + extraBottom;
    const plotRight = width - CHART_MARGIN.right;
    const plotBottom = CHART_MARGIN.top + plotH;

    let svg = "<g class=\"plot-area\">";

    const pctTicks = [0, 25, 50, 75, 100];
    const zeroX = pctXScale(0, CHART_MARGIN.left, plotW);
    const naX = pctXScale(-6, CHART_MARGIN.left, plotW);
    svg += `<rect class="na-band" x="${CHART_MARGIN.left}" y="${CHART_MARGIN.top}" width="${zeroX - CHART_MARGIN.left}" height="${plotH}" />`;
    svg += `<text class="na-band-label" x="${naX}" y="${CHART_MARGIN.top - 8}" text-anchor="middle">n/a</text>`;
    pctTicks.forEach((tick) => {
      const x = pctXScale(tick, CHART_MARGIN.left, plotW);
      svg += `<line class="grid-line grid-line-major" x1="${x}" y1="${CHART_MARGIN.top}" x2="${x}" y2="${plotBottom}" />`;
      svg += `<line class="axis-tick" x1="${x}" y1="${plotBottom}" x2="${x}" y2="${plotBottom + 4}" />`;
      svg += `<text class="axis-label" x="${x}" y="${height - 10}" text-anchor="middle">${tick}%</text>`;
    });

    parsed.forEach((item) => {
      const y = yScale(item);
      const dateLabel = item.event.date;
      const nameLabel = timelineFolderLabel(item.event);
      svg += `<line class="axis-tick" x1="${CHART_MARGIN.left - 4}" y1="${y}" x2="${CHART_MARGIN.left}" y2="${y}" />`;
      svg += `<text class="axis-label" x="${CHART_MARGIN.left - 8}" y="${y - 2}" text-anchor="end">${escapeHtml(dateLabel)}</text>`;
      if (nameLabel.text && item.event.type !== "event") {
        svg += renderAxisNameLabel(y, nameLabel, height, nameLabelWidth);
      }
    });

    svg += `<line class="axis-line" x1="${CHART_MARGIN.left}" y1="${CHART_MARGIN.top}" x2="${CHART_MARGIN.left}" y2="${plotBottom}" />`;
    svg += `<line class="axis-line" x1="${CHART_MARGIN.left}" y1="${plotBottom}" x2="${plotRight}" y2="${plotBottom}" />`;
    svg += `<text class="axis-title" x="${CHART_MARGIN.left + plotW / 2}" y="${height - 2}" text-anchor="middle">% validated</text>`;

    parsed.forEach((item) => {
      const y = yScale(item);
      const type = item.event.type;

      if (type === "event") {
        const releaseLabel = item.event.name || "Model release";
        const releaseLabelY = y > CHART_MARGIN.top + 16 ? y - 6 : y + 14;
        svg += `<text class="release-label" x="${CHART_MARGIN.left + 8}" y="${releaseLabelY}">${escapeHtml(releaseLabel)}</text>`;
        svg += `<line class="release-line" x1="${CHART_MARGIN.left}" y1="${y}" x2="${plotRight}" y2="${y}" />`;
        return;
      }

      if (type !== "data") return;

      const pct = item.event.pct_validated;
      const numericPct = Number(pct);
      const isNotApplicable = pct == null || Number.isNaN(numericPct) || numericPct === 0;
      const cx = pctXScale(isNotApplicable ? -6 : numericPct, CHART_MARGIN.left, plotW);
      const fill = isNotApplicable ? "#7c8498" : validatedColor(numericPct);
      svg += `<circle class="plot-point-hit" data-index="${item.index}" cx="${cx}" cy="${y}" r="10" />`;
      svg += `<circle class="plot-point${isNotApplicable ? " plot-point--na" : ""}" data-index="${item.index}" cx="${cx}" cy="${y}" r="5" fill="${fill}" />`;
    });

    svg += "</g>";

    timelinePlot.setAttribute("viewBox", `0 0 ${width} ${height}`);
    timelinePlot.setAttribute("width", String(width));
    timelinePlot.setAttribute("height", String(height));
    timelinePlot.innerHTML = svg;

    timelinePlot.querySelectorAll(".plot-point-hit").forEach((hit) => {
      const idx = parseInt(hit.dataset.index, 10);
      const event = events[idx];
      const point = timelinePlot.querySelector(`.plot-point[data-index="${idx}"]`);

      hit.addEventListener("mouseenter", (e) => showPointTooltip(e, event, point));
      hit.addEventListener("mousemove", (e) => movePointTooltip(e));
      hit.addEventListener("mouseleave", () => hidePointTooltip(point));

      hit.addEventListener("click", () => {
        hidePointTooltip(point);
        openFolderStats(event, idx);
      });
    });

    if (selectedEventIndex != null) {
      timelinePlot
        .querySelectorAll(`.plot-point[data-index="${selectedEventIndex}"]`)
        .forEach((point) => point.classList.add("plot-point--selected"));
    }
  }

  function formatPctValidated(value) {
    if (value == null || Number.isNaN(Number(value))) return "n/a";
    const n = Number(value);
    if (n === 0) return "n/a (0%)";
    return Number.isInteger(n) ? `${n}%` : `${n.toFixed(1)}%`;
  }

  function showPointTooltip(event, item, point) {
    if (!chartTooltip || !item) return;
    const folder = item.folder_name || "—";
    const name = item.name || "—";
    const pct = formatPctValidated(item.pct_validated);
    chartTooltip.innerHTML =
      `<span><strong>Folder:</strong> ${escapeHtml(folder)}</span><br>` +
      `<span class="chart-tooltip-name"><strong>Name:</strong> ${escapeHtml(name)}</span><br>` +
      `<span><strong>% validated:</strong> ${escapeHtml(pct)}</span>`;
    chartTooltip.hidden = false;
    if (point) point.classList.add("plot-point--active");
    movePointTooltip(event);
  }

  function movePointTooltip(event) {
    if (!chartTooltip || chartTooltip.hidden) return;

    const rect = chartWrapper.getBoundingClientRect();
    const anchorX = event.clientX - rect.left;
    const anchorY = event.clientY - rect.top;
    const maxWidth = Math.max(120, rect.width - TOOLTIP_PADDING * 2);
    chartTooltip.style.maxWidth = `${maxWidth}px`;

    const tooltipW = chartTooltip.offsetWidth;
    const tooltipH = chartTooltip.offsetHeight;

    let left = anchorX - tooltipW / 2;
    let top = anchorY - tooltipH - TOOLTIP_GAP;

    if (left + tooltipW > rect.width - TOOLTIP_PADDING) {
      left = rect.width - TOOLTIP_PADDING - tooltipW;
    }
    if (left < TOOLTIP_PADDING) {
      left = TOOLTIP_PADDING;
    }

    if (top < TOOLTIP_PADDING) {
      top = anchorY + TOOLTIP_GAP;
    }
    if (top + tooltipH > rect.height - TOOLTIP_PADDING) {
      top = Math.max(TOOLTIP_PADDING, rect.height - TOOLTIP_PADDING - tooltipH);
    }

    chartTooltip.style.left = `${left}px`;
    chartTooltip.style.top = `${top}px`;
  }

  function hidePointTooltip(point) {
    if (chartTooltip) chartTooltip.hidden = true;
    if (point) point.classList.remove("plot-point--active");
  }

  function escapeHtml(text) {
    return String(text)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  async function loadTimeline() {
    showPlaceholderLoading();
    showLoading(true);
    try {
      const res = await fetch("/api/analyze_timeline");
      const data = await res.json();
      showLoading(false);

      if (!res.ok || !data.ok) {
        showError(data.error || "Failed to load timeline.");
        openAggregateStats();
        return;
      }

      renderRootJsonFiles(data.root_json_files);
      events = Array.isArray(data.events) ? data.events : [];
      if (data.aggregate_stats) {
        cachedAggregateStats = data.aggregate_stats;
      }
      if (!events.length) {
        showEmpty();
        openAggregateStats(cachedAggregateStats);
        return;
      }

      requestAnimationFrame(renderTimeline);
      openAggregateStats(cachedAggregateStats);
    } catch (err) {
      showLoading(false);
      showError("Network error: " + err.message);
      openAggregateStats();
    }
  }

  showPlaceholderLoading();

  let resizeTimer;
  window.addEventListener("resize", () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      if (events.length) renderTimeline();
      if (vocabularyItems.length) renderVocabularyPlot(vocabularyItems);
    }, 150);
  });

  document.addEventListener("DOMContentLoaded", () => {
    initVocabularyTableSorting();
    initWordEntriesModal();
    initVocabularyWordClicks();
    if (folderStatsVocabBtn) folderStatsVocabBtn.addEventListener("click", showInferenceVocabularyView);
    loadTimeline();
  });
})();
