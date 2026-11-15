/* Standalone Explorer — folder data editor (local filesystem mode) */

const state = {
  folders: [],
  currentFolder: null,
  data: [],
  jsonFiles: [],
  wrapEnabled: false,
  playbackRate: 1.0,
  playAllActive: false,
  playAllQueue: [],
  playAllQueueIndex: 0,
  playAllTimeoutId: null,
  scrollToEntryKey: null,
  currentLoadId: 0,
  isMobile: window.innerWidth <= 768,
  genFuncs: {},
  adminMode: localStorage.getItem("adminMode") === "1",
  currentJsonContext: null,
};

// DOM
const folderList = document.getElementById("folder-list");
const sidebarLoading = document.getElementById("sidebar-loading");
const sidebarRoot = document.getElementById("sidebar-root");
const rootJsonList = document.getElementById("root-json-list");

const currentFolderLabel = document.getElementById("current-folder-label");
const dataSubtitle = document.getElementById("data-subtitle");
const dataList = document.getElementById("data-list");
const dataLoading = document.getElementById("data-loading");
const dataEmpty = document.getElementById("data-empty");
const entriesBody = dataList ? dataList.closest(".entries-body") : null;
const stickyStats = document.getElementById("sticky-stats");
const statsRow = document.getElementById("stats-row");
const statsToggleBtn = document.getElementById("stats-toggle-btn");
const statsToggleIcon = document.getElementById("stats-toggle-icon");

const speedControls = document.getElementById("speed-controls");
const playAllBtn = document.getElementById("play-all-btn");
const playAllStartInput = document.getElementById("play-all-start-index");
const generateAllStartInput = document.getElementById("generate-all-start-index");
const statJsonFiles = document.getElementById("stat-json-files");
const jsonFilesControls = document.getElementById("json-files-controls");

const processedIndicator = document.getElementById("processed-indicator");
const processedIcon = document.getElementById("processed-icon");
const folderActions = document.getElementById("folder-actions");
const moreEntriesLoading = document.getElementById("more-entries-loading");
const markProcessedBtn = document.getElementById("mark-processed-btn");
const setReviewedAllBtn = document.getElementById("set-reviewed-all-btn");
const curateOverview = document.getElementById("curate-overview");
const curateOverviewError = document.getElementById("curate-overview-error");
const closeFolderViewBtn = document.getElementById("close-folder-view");
const curateSyncBtn = document.getElementById("curate-sync-btn");
const curateSyncIcon = document.getElementById("curate-sync-icon");
const curateSyncLabel = document.getElementById("curate-sync-label");

function renderCurateChart(svgId, valueId, totalId, value, total, color, label) {
  const svg = document.getElementById(svgId);
  const valueElement = document.getElementById(valueId);
  const totalElement = document.getElementById(totalId);
  if (!svg || !valueElement || !totalElement) return;

  const safeTotal = Math.max(0, Number(total) || 0);
  const safeValue = Math.max(0, Math.min(Number(value) || 0, safeTotal));
  const percentage = safeTotal > 0 ? safeValue / safeTotal * 100 : null;
  const radius = 78;
  const circumference = 2 * Math.PI * radius;
  const filled = safeTotal > 0 ? safeValue / safeTotal * circumference : 0;
  const remainderColor = getComputedStyle(document.documentElement).getPropertyValue("--button-border-dark").trim() || "#3a3f5c";
  svg.setAttribute("viewBox", "0 0 220 220");
  svg.innerHTML =
    `<circle cx="110" cy="110" r="${radius}" fill="none" stroke="${remainderColor}" stroke-width="28" />` +
    `<circle cx="110" cy="110" r="${radius}" fill="none" stroke="${color}" stroke-width="28" ` +
    `stroke-dasharray="${filled} ${circumference - filled}" stroke-linecap="round" transform="rotate(-90 110 110)" />`;
  svg.setAttribute("aria-label", `${safeValue} of ${safeTotal} ${label}`);
  valueElement.textContent = percentage === null
    ? "—"
    : `${Number.isInteger(percentage) ? percentage : percentage.toFixed(1)}%`;
  totalElement.textContent = `${safeValue.toLocaleString()} / ${safeTotal.toLocaleString()} ${label}`;
}

function setCurateLoading(isLoading, isSyncing = false) {
  document.querySelectorAll(".curate-chart-spinner").forEach((spinner) => {
    spinner.hidden = !isLoading;
  });
  if (curateOverview) curateOverview.setAttribute("aria-busy", String(isLoading));
  if (curateSyncBtn) {
    curateSyncBtn.disabled = isLoading;
    curateSyncBtn.classList.toggle("is-syncing", isSyncing);
  }
  if (curateSyncIcon) curateSyncIcon.textContent = "sync";
  if (curateSyncLabel) curateSyncLabel.textContent = isSyncing ? "Syncing…" : "Sync";
}

function formatCurateSyncTimestamp(timestamp) {
  if (!timestamp) return "Last synced on: Never";
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return "Last synced on: Unknown";
  const pad = (number) => String(number).padStart(2, "0");
  return `Last synced on: ${date.getFullYear()}.${pad(date.getMonth() + 1)}.${pad(date.getDate())} at ${pad(date.getHours())}h${pad(date.getMinutes())}m`;
}

function renderCachedCurateStats(data) {
  const totalFolders = Number(data.total_folders) || 0;
  const statsComputedFolders = Number(data.stats_computed_folders) || 0;
  renderCurateChart("processed-chart", "processed-chart-value", "processed-chart-total",
    data.processed_folders, totalFolders, "#10b981", "folders");
  renderCurateChart("reviewed-chart", "reviewed-chart-value", "reviewed-chart-total",
    data.reviewed_audios, data.total_audios, "#38bdf8", "audios");
  const reviewedDuration = document.getElementById("reviewed-duration-total");
  const reviewedDurationStatsFolders = Number(data.reviewed_duration_stats_folders) || 0;
  if (reviewedDuration) {
    if (reviewedDurationStatsFolders < totalFolders) {
      reviewedDuration.textContent = "Sync to calculate reviewed hours";
    } else {
      const reviewedHours = (Number(data.reviewed_audios_duration) || 0) / 3600;
      const totalHours = (Number(data.total_audios_duration) || 0) / 3600;
      reviewedDuration.textContent = `${reviewedHours.toFixed(1)} / ${totalHours.toFixed(1)} hours reviewed`;
    }
  }
  const timestamp = document.getElementById("curate-last-synced");
  const cacheStatus = document.getElementById("curate-cache-status");
  if (timestamp) timestamp.textContent = formatCurateSyncTimestamp(data.last_synced_at);
  const reviewStatsFolders = Math.min(
    statsComputedFolders,
    Number(data.reviewed_stats_folders) || 0,
  );
  if (cacheStatus) cacheStatus.textContent = `Cached stats: ${reviewStatsFolders}/${totalFolders} folders`;
}

async function loadCurateOverview({ sync = false } = {}) {
  if (!curateOverview) return;
  const startedAt = performance.now();
  const processedTotal = document.getElementById("processed-chart-total");
  const reviewedTotal = document.getElementById("reviewed-chart-total");
  const reviewedDuration = document.getElementById("reviewed-duration-total");
  if (curateOverviewError) {
    curateOverviewError.hidden = true;
    curateOverviewError.textContent = "";
  }
  setCurateLoading(true, sync);
  processedTotal.textContent = "Loading folder counts…";
  reviewedTotal.textContent = "Loading audio counts…";
  if (reviewedDuration) reviewedDuration.textContent = "Calculating reviewed hours…";
  console.info(sync ? "[Curate] Sync requested" : "[Curate] Loading cached statistics from folders.json");

  let completed = false;
  try {
    const response = await fetch(
      sync ? "/api/curate_stats/sync" : "/api/curate_stats",
      sync ? { method: "POST" } : undefined,
    );
    if (!response.ok) throw new Error(`Stats request failed with HTTP ${response.status}`);
    if (!sync) {
      const cachedStats = await response.json();
      if (cachedStats.error) throw new Error(cachedStats.error);
      renderCachedCurateStats(cachedStats);
      completed = true;
      console.info("[Curate] Loaded cached statistics", cachedStats);
    } else {
      if (response.headers.get("content-type")?.includes("application/json")) {
        const errorData = await response.json();
        throw new Error(errorData.error || "Could not sync curation statistics.");
      }
      const reader = response.body?.getReader();
      if (!reader) throw new Error("Sync response does not support streaming.");
      const decoder = new TextDecoder();
      let buffer = "";
      let totalFolders = 0;

      const processEvent = (line) => {
        if (!line.trim()) return;
        const event = JSON.parse(line);
        if (event.event === "status") {
          console.info("[Curate] Listing folders for sync");
        } else if (event.event === "start") {
          totalFolders = event.total_folders;
          processedTotal.textContent = `Syncing folder counts… (0/${totalFolders})`;
          reviewedTotal.textContent = `Syncing audio counts… (0/${totalFolders} folders)`;
          console.info(`[Curate] Syncing ${totalFolders} folders; ${event.processed_folders} already processed`);
        } else if (event.event === "folder_start") {
          processedTotal.textContent = `Syncing folder counts… (${event.completed}/${totalFolders})`;
          reviewedTotal.textContent = `Reading audio counts… (${event.completed}/${totalFolders}: ${event.folder})`;
          console.info(`[Curate] Scanning folder ${event.completed}/${totalFolders}: ${event.folder}`);
        } else if (event.event === "folder_done") {
          processedTotal.textContent = `Syncing folder counts… (${event.completed}/${totalFolders})`;
          reviewedTotal.textContent = `Syncing audio counts… (${event.completed}/${totalFolders} folders)`;
          console.info(`[Curate] Finished ${event.completed}/${totalFolders}: ${event.folder}; ${event.total_audios} audios, ${event.reviewed_audios} reviewed so far`);
        } else if (event.event === "complete") {
          renderCachedCurateStats(event);
          completed = true;
          console.info(`[Curate] Sync completed in ${((performance.now() - startedAt) / 1000).toFixed(1)}s`, event);
        } else if (event.event === "error") {
          throw new Error(event.error || "Could not sync curation statistics.");
        }
      };

      while (true) {
        const { done, value } = await reader.read();
        buffer += decoder.decode(value, { stream: !done });
        let newlineIndex = buffer.indexOf("\n");
        while (newlineIndex >= 0) {
          processEvent(buffer.slice(0, newlineIndex));
          buffer = buffer.slice(newlineIndex + 1);
          newlineIndex = buffer.indexOf("\n");
        }
        if (done) break;
      }
      if (buffer.trim()) processEvent(buffer);
      if (!completed) throw new Error("Sync stream ended before totals were received.");
    }
  } catch (error) {
    console.error(`[Curate] Failed to load statistics after ${((performance.now() - startedAt) / 1000).toFixed(1)}s`, error);
    processedTotal.textContent = "Unable to load folder counts";
    reviewedTotal.textContent = "Unable to load audio counts";
    if (reviewedDuration) reviewedDuration.textContent = "Unable to load reviewed hours";
    if (curateOverviewError) {
      curateOverviewError.textContent = error.message;
      curateOverviewError.hidden = false;
    }
  } finally {
    setCurateLoading(false, false);
  }
}

if (curateSyncBtn) {
  curateSyncBtn.addEventListener("click", () => loadCurateOverview({ sync: true }));
}

function closeFolderView() {
  cancelPendingEntryBatch();
  state.currentLoadId += 1;
  state.currentFolder = null;
  state.data = [];
  state.jsonFiles = [];
  stopPlayAll();
  closeViewer();
  highlightFolder(null);
  currentFolderLabel.textContent = "Curation overview";
  dataSubtitle.textContent = "";
  dataList.innerHTML = "";
  stickyStats.style.display = "none";
  processedIndicator.hidden = true;
  folderActions.style.display = "none";
  if (moreEntriesLoading) moreEntriesLoading.style.display = "none";
  setdataLoading(false);
  setdataEmpty(false);
  curateOverview.hidden = false;
  closeFolderViewBtn.hidden = true;
  loadCurateOverview();
}

if (closeFolderViewBtn) closeFolderViewBtn.addEventListener("click", closeFolderView);

function updateFolderActionsVisibility() {
  if (!state.data || state.data.length === 0) {
    if (folderActions) folderActions.style.display = "none";
    if (moreEntriesLoading) moreEntriesLoading.style.display = "none";
    return;
  }
  const hasMore = renderedEntryCount < filteredEntryIndices.length;
  if (folderActions) folderActions.style.display = hasMore ? "none" : "block";

  if (folderActions && !hasMore) {
    const markProcessedBtnLocal = document.getElementById("mark-processed-btn");
    const setReviewedAllBtnLocal = document.getElementById("set-reviewed-all-btn");
    const folderActionsMessage = document.getElementById("folder-actions-message");

    if (currentFilterReviewed === "true") {
      if (markProcessedBtnLocal) markProcessedBtnLocal.style.display = "none";
      if (setReviewedAllBtnLocal) setReviewedAllBtnLocal.style.display = "none";
      if (folderActionsMessage) folderActionsMessage.style.display = "block";
    } else {
      if (markProcessedBtnLocal) markProcessedBtnLocal.style.display = "inline-flex";
      if (setReviewedAllBtnLocal) setReviewedAllBtnLocal.style.display = "inline-flex";
      if (folderActionsMessage) folderActionsMessage.style.display = "none";
    }
  }
}

const viewerPanel = document.getElementById("viewer-panel");
const viewerCloseBtn = document.getElementById("viewer-close-btn");
const viewerWrapBtn = document.getElementById("viewer-wrap-btn");
const viewerCopyBtn = document.getElementById("viewer-copy-btn");
const viewerSaveBtn = document.getElementById("viewer-save-btn");
const viewerFilename = document.getElementById("viewer-filename");
const viewerSize = document.getElementById("viewer-size");
const viewerLineCount = document.getElementById("viewer-line-count");
const viewerLoading = document.getElementById("viewer-loading");
const viewerPre = document.getElementById("viewer-pre");
const viewerTextarea = document.getElementById("viewer-textarea");
const jsonModalBackdrop = document.getElementById("json-modal-backdrop");

const settingsIcon = document.querySelector(".settings-icon");
const settingsModal = document.getElementById("settings-modal");
const darkModeSwitch = document.getElementById("dark-mode-switch");
const adminModeSwitch = document.getElementById("admin-mode-switch");
const adminModeLabel = document.getElementById("admin-mode-label");
const themeModeLabel = document.getElementById("theme-mode-label");
const generateAllReportModal = document.getElementById("generate-all-report-modal");
const generateAllReportSuccess = document.getElementById("generate-all-report-success");

function setStatsExpanded(expanded) {
  statsRow.hidden = !expanded;
  statsToggleBtn.setAttribute("aria-expanded", String(expanded));
  statsToggleBtn.setAttribute("aria-label", expanded ? "Collapse controls" : "Expand controls");
  statsToggleBtn.title = expanded ? "Collapse controls" : "Expand controls";
  statsToggleIcon.textContent = expanded ? "keyboard_arrow_up" : "keyboard_arrow_down";
}

statsToggleBtn.addEventListener("click", () => {
  setStatsExpanded(statsRow.hidden);
});

// Sidebar elements & collapsible menu functionality
const hamburgerBtn = document.getElementById("hamburger-btn");
const sidebarOverlay = document.getElementById("sidebar-overlay");
const exploreSidebar = document.querySelector(".explorer-sidebar");

function updateMobileLayout() {
  state.isMobile = window.innerWidth <= 768;
}

function toggleSidebar() {
  if (!exploreSidebar) return;
  exploreSidebar.classList.toggle("open");
  if (sidebarOverlay) sidebarOverlay.classList.toggle("active");
}

function closeSidebar() {
  if (!exploreSidebar) return;
  exploreSidebar.classList.remove("open");
  if (sidebarOverlay) sidebarOverlay.classList.remove("active");
}

if (hamburgerBtn) {
  hamburgerBtn.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    toggleSidebar();
  });
}

if (sidebarOverlay) {
  sidebarOverlay.addEventListener("click", (e) => {
    e.preventDefault();
    closeSidebar();
  });
}

// Close sidebar when tapping outside of it.
document.addEventListener("click", (e) => {
  if (
    exploreSidebar &&
    exploreSidebar.classList.contains("open") &&
    !exploreSidebar.contains(e.target) &&
    hamburgerBtn &&
    !hamburgerBtn.contains(e.target)
  ) {
    closeSidebar();
  }
});

window.addEventListener("resize", updateMobileLayout);
document.addEventListener("DOMContentLoaded", updateMobileLayout);


function updateThemeLabel(theme) {
  if (!themeModeLabel) return;
  themeModeLabel.textContent = theme === "dark" ? "Dark" : "Bright";
}

function applyAdminMode(enabled) {
  state.adminMode = Boolean(enabled);
  localStorage.setItem("adminMode", state.adminMode ? "1" : "0");
  if (adminModeSwitch) adminModeSwitch.checked = state.adminMode;
  if (adminModeLabel) adminModeLabel.textContent = state.adminMode ? "Admin" : "User";
  if (viewerSaveBtn) {
    viewerSaveBtn.style.display = state.adminMode ? "inline-flex" : "none";
  }
  if (viewerTextarea && viewerPre) {
    const editing = state.adminMode && Boolean(state.currentJsonContext);
    viewerTextarea.style.display = editing ? "block" : "none";
    viewerPre.style.display = editing ? "none" : "block";
  }
}

function applyTheme(theme) {
  if (theme === "dark") {
    document.documentElement.classList.add("dark");
    if (darkModeSwitch) darkModeSwitch.checked = true;
  } else {
    document.documentElement.classList.remove("dark");
    if (darkModeSwitch) darkModeSwitch.checked = false;
  }
  updateThemeLabel(theme);
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

  const closeBtn = settingsModal.querySelector(".modal-close");
  if (closeBtn) {
    closeBtn.addEventListener("click", () => {
      settingsModal.style.display = "none";
      settingsModal.setAttribute("aria-hidden", "true");
    });
  }
}

if (generateAllReportModal) {
  generateAllReportModal.addEventListener("click", (event) => {
    if (event.target === generateAllReportModal) {
      closeGenerateAllReportModal();
    }
  });

  const closeBtn = generateAllReportModal.querySelector(".modal-close");
  if (closeBtn) {
    closeBtn.addEventListener("click", closeGenerateAllReportModal);
  }
}

function closeGenerateAllReportModal() {
  if (!generateAllReportModal) return;
  generateAllReportModal.style.display = "none";
  generateAllReportModal.setAttribute("aria-hidden", "true");
}

function showGenerateAllReport(successCount) {
  if (!generateAllReportModal || !generateAllReportSuccess) {
    alert(`${successCount} entries transcribed successfully.`);
    return;
  }
  generateAllReportSuccess.textContent =
    `${successCount} entr${successCount === 1 ? "y" : "ies"} transcribed successfully.`;
  generateAllReportModal.style.display = "flex";
  generateAllReportModal.setAttribute("aria-hidden", "false");
}

function showSpellcheckAllReport(entriesProcessed, totalMisspellings) {
  const notification = document.createElement("div");
  notification.style.position = "fixed";
  notification.style.bottom = "20px";
  notification.style.right = "20px";
  notification.style.backgroundColor = "#1f2937";
  notification.style.color = "white";
  notification.style.padding = "16px 20px";
  notification.style.borderRadius = "8px";
  notification.style.border = "1px solid #374151";
  notification.style.zIndex = "10001";
  notification.style.fontSize = "0.95rem";
  notification.style.maxWidth = "400px";
  notification.style.boxShadow = "0 10px 25px rgba(0,0,0,0.5)";

  const title = document.createElement("div");
  title.style.fontWeight = "600";
  title.style.marginBottom = "8px";
  title.textContent = "Spellcheck Complete";

  const summary = document.createElement("div");
  summary.style.color = "#d1d5db";
  summary.innerHTML = `
    <div>Checked ${entriesProcessed} entr${entriesProcessed === 1 ? "y" : "ies"}</div>
    <div>Found ${totalMisspellings} misspelling${totalMisspellings === 1 ? "" : "s"}</div>
  `;

  notification.appendChild(title);
  notification.appendChild(summary);
  document.body.appendChild(notification);

  setTimeout(() => notification.remove(), 5000);
}

function isUserValidatedEntry(entry) {
  if (!entry || typeof entry !== "object") return false;
  const value = entry.user_is_validated;
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;
  if (typeof value === "string") return ["1", "true", "yes", "y", "on"].includes(value.trim().toLowerCase());
  return false;
}

if (darkModeSwitch) {
  darkModeSwitch.addEventListener("change", () => {
    const newTheme = darkModeSwitch.checked ? "dark" : "light";
    applyTheme(newTheme);
  });
}

if (adminModeSwitch) {
  adminModeSwitch.addEventListener("change", () => {
    applyAdminMode(adminModeSwitch.checked);
    if (state.currentJsonContext) {
      setViewerContent(state.currentJsonContext.content || "");
    }
  });
}

applyTheme(localStorage.getItem("theme") || "dark");
applyAdminMode(state.adminMode);

const formatBytes = window.JsonViewer.formatBytes;

function entryKey(entry, index) {
  if (!entry || typeof entry !== "object") return "#" + String(index);
  if (entry.entry_id != null) return "entry_id=" + String(entry.entry_id);
  if (entry.interaction_id != null) return "interaction_id=" + String(entry.interaction_id);
  if (entry.id != null) return "id=" + String(entry.id);
  return "#" + String(index);
}

function guessAudioRelPath(entry) {
  if (!entry || typeof entry !== "object") return null;
  const candidates = [
    entry.audio_data,
    entry.audio_rel,
    entry.audio_relpath,
    entry.audio_path,
    entry.audio_file,
    entry.wav,
    entry.file,
    entry.filename,
    entry.path,
  ].filter(Boolean);

  for (const c of candidates) {
    const s = String(c);
    if (s.match(/\.(wav|mp3|ogg|flac|m4a)$/i)) return s;
  }

  for (const v of Object.values(entry)) {
    if (typeof v !== "string") continue;
    if (v.match(/\.(wav|mp3|ogg|flac|m4a)$/i)) return v;
  }

  return null;
}

function buildSpeedControls() {
  speedControls.innerHTML = "";
  for (let r = 0.5; r <= 3.5 + 1e-9; r += 0.5) {
    const btn = document.createElement("button");
    btn.className = "speed-btn" + (Math.abs(r - state.playbackRate) < 1e-9 ? " active" : "");
    btn.textContent = r.toFixed(1).replace(".0", "") + "x";
    btn.addEventListener("click", () => {
      state.playbackRate = r;
      applyPlaybackRateToAll();
      buildSpeedControls();
    });
    speedControls.appendChild(btn);
  }
}

function syncEntryIds() {
  state.data.forEach((entry, index) => {
    if (entry && typeof entry === "object") {
      entry.__explorer_entry_id = index + 1;
    }
  });
}

function getEntryDisplayId(entry, index) {
  if (entry && typeof entry === "object" && Number.isInteger(entry.__explorer_entry_id)) {
    return entry.__explorer_entry_id;
  }
  return index + 1;
}

function getEntryTitle(entry) {
  if (!entry || typeof entry !== "object") return "";
  const candidates = [
    entry.filename,
    entry.file_name,
    entry.file,
    entry.name,
    entry.audio_rel,
    entry.audio_relpath,
    entry.audio_path,
    entry.audio_file,
    entry.wav,
    entry.path,
  ].filter(Boolean);

  for (const candidate of candidates) {
    const value = String(candidate).trim();
    if (value) return value;
  }

  return "";
}

function isEntryVisibleAtIndex(index) {
  if (index < 0 || index >= state.data.length) return false;
  const entry = state.data[index];
  if (!entry) return false;

  let show = true;

  if (currentFilterValidated !== "all") {
    const isValidated = isUserValidatedEntry(entry);
    if (currentFilterValidated === "true" && !isValidated) show = false;
    if (currentFilterValidated === "false" && isValidated) show = false;
  }

  if (show && currentFilterReviewed !== "all") {
    const isReviewed = Boolean(entry && entry.reviewer_is_reviewed);
    if (currentFilterReviewed === "true" && !isReviewed) show = false;
    if (currentFilterReviewed === "false" && isReviewed) show = false;
  }

  if (show && entry.inference_confidence != null) {
    const conf = parseFloat(entry.inference_confidence);
    if (!isNaN(conf)) {
      if (conf < currentConfidenceMin || conf > currentConfidenceMax) {
        show = false;
      }
    }
  }

  return show;
}

function getVisibleEntryIndices() {
  if (!state.data || state.data.length === 0) return [];
  return state.data.reduce((acc, entry, index) => {
    if (isEntryVisibleAtIndex(index)) acc.push(getEntryDisplayId(entry, index));
    return acc;
  }, []);
}

function getVisibleEntryDataIndices() {
  if (!state.data || state.data.length === 0) return [];
  return state.data.reduce((acc, entry, index) => {
    if (isEntryVisibleAtIndex(index)) acc.push(index);
    return acc;
  }, []);
}

function updatePlayAllButtonUI() {
  if (!playAllBtn) return;
  playAllBtn.textContent = state.playAllActive ? "Stop playing" : "Play all";
  playAllBtn.classList.toggle("active", state.playAllActive);
}

function stopPlayAll() {
  if (state.playAllTimeoutId) {
    clearTimeout(state.playAllTimeoutId);
    state.playAllTimeoutId = null;
  }

  if (state.playAllActive) {
    dataList.querySelectorAll("audio[data-explorer-audio=\"1\"]").forEach((audio) => {
      audio.pause();
      audio.currentTime = 0;
      audio.onended = null;
    });
  }

  state.playAllActive = false;
  state.playAllQueue = [];
  state.playAllQueueIndex = 0;
  updatePlayAllButtonUI();
}

function getPlayAllStartIndex() {
  const rawValue = parseInt(playAllStartInput?.value ?? "1", 10);
  if (Number.isNaN(rawValue) || rawValue < 1) return 1;
  return rawValue;
}

function getGenerateAllStartIndex() {
  const rawValue = parseInt(generateAllStartInput?.value ?? "1", 10);
  if (Number.isNaN(rawValue) || rawValue < 1) return 1;
  return rawValue;
}

if (generateAllStartInput) {
  generateAllStartInput.addEventListener("change", () => {
    if (state.genAll?.running) return;
    if (state.genAll) {
      state.genAll.visibleIndexes = [];
      state.genAll.nextPosition = 0;
    }
    if (generateAllTxt) generateAllTxt.textContent = "Generate all";
  });
}

function playNextEntryInSequence() {
  if (!state.playAllActive) return;
  if (!state.playAllQueue || state.playAllQueue.length === 0 || state.playAllQueueIndex >= state.playAllQueue.length) {
    stopPlayAll();
    return;
  }

  const entryId = state.playAllQueue[state.playAllQueueIndex];
  state.playAllQueueIndex += 1;

  if (playAllStartInput) {
    playAllStartInput.value = String(entryId);
  }

  const row = dataList.querySelector(`.entry-row[data-entry-id="${entryId}"]`);
  if (!row) {
    if (state.playAllActive) {
      state.playAllTimeoutId = window.setTimeout(playNextEntryInSequence, 50);
    }
    return;
  }

  row.scrollIntoView({ behavior: "smooth", block: "center" });

  const audio = row.querySelector("audio[data-explorer-audio=\"1\"]");

  dataList.querySelectorAll("audio[data-explorer-audio=\"1\"]").forEach((el) => {
    if (el !== audio) {
      el.pause();
      el.currentTime = 0;
    }
  });

  if (!audio) {
    if (state.playAllActive) {
      state.playAllTimeoutId = window.setTimeout(playNextEntryInSequence, 50);
    }
    return;
  }

  audio.currentTime = 0;
  audio.playbackRate = state.playbackRate;
  audio.onended = () => {
    if (state.playAllActive) {
      state.playAllTimeoutId = window.setTimeout(playNextEntryInSequence, 50);
    }
  };

  const playPromise = audio.play();
  if (playPromise && typeof playPromise.catch === "function") {
    playPromise.catch(() => {
      if (state.playAllActive) {
        state.playAllTimeoutId = window.setTimeout(playNextEntryInSequence, 50);
      }
    });
  }
}

function startPlayAll() {
  if (!state.currentFolder || !state.data || state.data.length === 0) return;
  stopPlayAll();

  const visibleIndices = getVisibleEntryIndices();
  if (visibleIndices.length === 0) {
    updatePlayAllButtonUI();
    return;
  }

  const requestedStartId = getPlayAllStartIndex();
  let startPosition = 0;
  while (startPosition < visibleIndices.length && visibleIndices[startPosition] < requestedStartId) {
    startPosition += 1;
  }
  if (startPosition >= visibleIndices.length) {
    startPosition = Math.max(0, visibleIndices.length - 1);
  }

  state.playAllActive = true;
  state.playAllQueue = visibleIndices.slice(startPosition);
  state.playAllQueueIndex = 0;
  updatePlayAllButtonUI();
  playNextEntryInSequence();
}

if (playAllBtn) {
  playAllBtn.addEventListener("click", () => {
    if (state.playAllActive) {
      stopPlayAll();
    } else {
      startPlayAll();
    }
  });
}

if (playAllStartInput) {
  playAllStartInput.addEventListener("change", () => {
    const parsed = parseInt(playAllStartInput.value, 10);
    if (Number.isNaN(parsed) || parsed < 1) {
      playAllStartInput.value = "1";
    } else if (state.data && state.data.length > 0 && parsed > state.data.length) {
      playAllStartInput.value = String(state.data.length);
    }
  });
}

function buildJsonFilesControls() {
  jsonFilesControls.innerHTML = "";
  if (!state.jsonFiles || state.jsonFiles.length === 0) {
    statJsonFiles.style.display = "none";
    return;
  }

  statJsonFiles.style.display = "block";

  state.jsonFiles.forEach((f) => {
    const btn = document.createElement("button");
    btn.className = "btn-small";

    const icon = document.createElement("span");
    icon.className = "material-symbols-outlined";
    icon.textContent = "data_object";

    const txt = document.createElement("span");
    txt.textContent = f.replace(/\.json$/i, "");

    btn.appendChild(icon);
    btn.appendChild(txt);

    btn.addEventListener("click", () => openJsonViewer(f));
    jsonFilesControls.appendChild(btn);
  });
}

function applyPlaybackRateToAll() {
  document.querySelectorAll("audio[data-explorer-audio=\"1\"]").forEach((a) => {
    a.playbackRate = state.playbackRate;
  });
}

function setSidebarError(msg) {
  sidebarLoading.style.display = "none";
  folderList.innerHTML = "<div style=\"padding:1rem;color:#ef4444;font-size:0.85rem;\"></div>";
  folderList.firstChild.textContent = msg;
}

async function loadConfig() {
  const sidebarHeaderTitle = document.getElementById("sidebar-header-title");
  const res = await fetch("/api/config");
  const data = await res.json();
  if (!data.ok) {
    sidebarHeaderTitle.textContent = "Error";
    setSidebarError(data.error || "Config error");
    return null;
  }

  // Format the path nicely
  let displayPath = data.root;
  if (data.source === 'firebase') {
    if (data.bucket) {
      displayPath = displayPath ? `gs://${data.bucket}/${displayPath}` : `gs://${data.bucket}`;
    } else {
      displayPath = displayPath ? `gs://${displayPath}` : "Firebase Storage";
    }
  }

  sidebarHeaderTitle.textContent = displayPath;
  sidebarHeaderTitle.title = displayPath;
  return data;
}

async function loadFolders() {
  const loadId = ++state.currentLoadId;
  if (folderStatsObserver) {
    folderStatsObserver.disconnect();
    folderStatsObserver = null;
  }
  sidebarLoading.style.display = "flex";
  const res = await fetch("/api/folders");
  const data = await res.json();
  sidebarLoading.style.display = "none";

  if (loadId !== state.currentLoadId) return;

  if (data.error) {
    setSidebarError(data.error);
    return;
  }

  state.folders = data.folders || [];
  state.rootJsonFiles = Array.isArray(data.root_json_files) ? data.root_json_files : [];
  folderList.innerHTML = "";

  if (state.folders.length === 0) {
    const el = document.createElement("div");
    el.style.padding = "1rem";
    el.style.opacity = "0.65";
    el.style.fontSize = "0.85rem";
    el.textContent = "No folders found.";
    folderList.appendChild(el);
    return;
  }

  state.folders.forEach((f) => {
    const item = document.createElement("div");
    item.className = "folder-item" + (f.processed ? " processed" : "");
    item.dataset.name = f.name;

    const left = document.createElement("div");
    left.className = "folder-left";
    left.style.flexDirection = "column";
    left.style.alignItems = "flex-start";
    left.style.gap = "0.2rem";

    const topWrap = document.createElement("div");
    topWrap.style.display = "flex";
    topWrap.style.alignItems = "center";
    topWrap.style.gap = "0.55rem";

    const nameEl = document.createElement("span");
    nameEl.className = "folder-name";
    nameEl.textContent = f.name;
    topWrap.appendChild(nameEl);

    const statsEl = document.createElement("div");
    const hasCachedStats = f.total_audios != null && f.total_duration_str;
    statsEl.className = "folder-stats" + (hasCachedStats ? "" : " loading");
    statsEl.textContent = hasCachedStats
      ? `${f.total_audios} audios • ${f.total_duration_str}`
      : "... audios • ...";
    if (hasCachedStats) {
      statsEl.style.opacity = "1";
    }

    left.appendChild(topWrap);
    left.appendChild(statsEl);

    const badgeWrap = document.createElement("div");
    badgeWrap.style.display = "flex";
    badgeWrap.style.alignItems = "center";
    badgeWrap.style.justifyContent = "center";

    const badge = document.createElement("span");
    badge.className = "material-symbols-outlined folder-badge";
    badge.style.fontSize = "1.2rem";
    badge.textContent = f.processed ? "check_circle" : "cancel";
    badge.style.color = f.processed ? "#10b981" : "#ef4444";

    badgeWrap.appendChild(badge);

    item.appendChild(left);
    item.appendChild(badgeWrap);

    item.addEventListener("click", (e) => {
      e.stopPropagation();
      selectFolder(f.name);
    });
    folderList.appendChild(item);
  });

  // Render root JSON files in sidebar
  if (rootJsonList) {
    rootJsonList.innerHTML = "";
    if (state.rootJsonFiles.length === 0) {
      const el = document.createElement("div");
      el.className = "sidebar-card-empty";
      el.textContent = "No root JSON files.";
      rootJsonList.appendChild(el);
    } else {
      state.rootJsonFiles.forEach((fn) => {
        const btn = document.createElement("button");
        btn.className = "btn-small json-file-btn";
        btn.textContent = "{} " + fn.replace(/\.json$/i, "");
        btn.addEventListener("click", () => openJsonViewerRoot(fn));
        rootJsonList.appendChild(btn);
      });
    }
  }

  lazyLoadFolderStats(loadId);
}

function applyFolderStatsToDom(folderName) {
  const f = state.folders.find((folder) => folder.name === folderName);
  if (!f || f.total_audios == null || !f.total_duration_str) return;
  const item = folderList.querySelector(`.folder-item[data-name="${CSS.escape(folderName)}"]`);
  if (!item) return;
  const statsEl = item.querySelector(".folder-stats");
  if (!statsEl) return;
  statsEl.classList.remove("loading");
  statsEl.textContent = `${f.total_audios} audios • ${f.total_duration_str}`;
  statsEl.style.opacity = "1";
}

let folderStatsObserver = null;

function ensureFolderStatsObserver() {
  if (folderStatsObserver) return folderStatsObserver;
  folderStatsObserver = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        const item = entry.target;
        folderStatsObserver.unobserve(item);
        const name = item.dataset.name;
        const f = state.folders.find((folder) => folder.name === name);
        if (f && f.total_audios == null) {
          refreshFolderStats(name);
        }
      }
    },
    { root: folderList, rootMargin: "120px", threshold: 0 },
  );
  return folderStatsObserver;
}

async function refreshFolderStats(folderName, { refresh = false } = {}) {
  const f = state.folders.find((folder) => folder.name === folderName);
  if (!f) return;

  try {
    const qs = new URLSearchParams({ folder: folderName });
    if (refresh) qs.set("refresh", "1");
    const res = await fetch(`/api/folder_stats?${qs}`);
    const data = await res.json();
    if (data.error) return;

    f.total_audios = data.total_audios;
    f.total_duration_str = data.total_duration_str;
    applyFolderStatsToDom(folderName);
  } catch (err) {
    console.warn("Failed to load stats for folder: " + folderName, err);
  }
}

function lazyLoadFolderStats(loadId) {
  if (loadId !== state.currentLoadId) return;
  const observer = ensureFolderStatsObserver();
  state.folders.forEach((f) => {
    if (loadId !== state.currentLoadId) return;
    if (f.total_audios != null) return;
    const item = folderList.querySelector(`.folder-item[data-name="${CSS.escape(f.name)}"]`);
    if (item) observer.observe(item);
  });
}

function highlightFolder(name) {
  document.querySelectorAll(".folder-item").forEach((el) => {
    el.classList.toggle("active", el.dataset.name === name);
  });
}

function setdataLoading(isLoading) {
  dataLoading.style.display = isLoading ? "flex" : "none";
}

function setdataEmpty(isEmpty) {
  dataEmpty.style.display = isEmpty ? "flex" : "none";
}

const jsonViewer = window.JsonViewer.create({
  state,
  elements: {
    viewerPanel,
    viewerCloseBtn,
    viewerWrapBtn,
    viewerCopyBtn,
    viewerSaveBtn,
    viewerFilename,
    viewerSize,
    viewerLineCount,
    viewerLoading,
    viewerPre,
    viewerTextarea,
    jsonModalBackdrop,
  },
  getCurrentFolder: () => state.currentFolder,
  adminModeEnabled: () => state.adminMode,
});

function closeViewer() {
  jsonViewer.close();
}

function setViewerContent(content) {
  jsonViewer.setContent(content);
}

async function saveViewerJson() {
  return jsonViewer.save();
}

async function openJsonViewer(file) {
  return jsonViewer.openJsonViewer(file);
}

async function openJsonViewerRoot(file) {
  return jsonViewer.openJsonViewerRoot(file);
}

async function selectFolder(name) {
  cancelPendingEntryBatch();
  const loadId = ++state.currentLoadId;
  closeViewer();
  state.currentFolder = name;
  curateOverview.hidden = true;
  closeFolderViewBtn.hidden = false;
  highlightFolder(name);

  currentFolderLabel.textContent = name;
  dataSubtitle.textContent = "";
  dataList.innerHTML = "";

  stickyStats.style.display = "none";
  processedIndicator.hidden = true;
  folderActions.style.display = "none";
  if (moreEntriesLoading) moreEntriesLoading.style.display = "none";

  setdataEmpty(false);
  setdataLoading(true);

  // Close sidebar on mobile when folder is selected
  closeSidebar();

  // Show the folder stats loading animation while the server updates folders.json.
  const selectedItem = folderList.querySelector(`.folder-item[data-name="${CSS.escape(name)}"]`);
  if (selectedItem) {
    const statsEl = selectedItem.querySelector(".folder-stats");
    if (statsEl) {
      statsEl.classList.add("loading");
      statsEl.textContent = "... audios • ...";
      statsEl.style.opacity = "0.65";
    }
  }

  try {
    const res = await fetch("/api/folder?folder=" + encodeURIComponent(name));
    const data = await res.json();

    if (loadId !== state.currentLoadId) return;

    setdataLoading(false);

    if (data.error) {
      if (selectedItem) {
        const statsEl = selectedItem.querySelector(".folder-stats");
        if (statsEl) {
          statsEl.classList.remove("loading");
        }
      }
      dataSubtitle.textContent = data.error;
      setdataEmpty(true);
      return;
    }

    state.data = Array.isArray(data.data)
      ? data.data
      : (Array.isArray(data.entries) ? data.entries : []);
    state.jsonFiles = Array.isArray(data.json_files) ? data.json_files : [];

    processedIndicator.hidden = false;
    processedIcon.textContent = data.processed ? "check_circle" : "cancel";
    processedIcon.style.color = data.processed ? "#10b981" : "#ef4444";

    stickyStats.style.display = "block";
    buildSpeedControls();
    buildJsonFilesControls();
    const totalAudios = String((data.stats && data.stats.total_audios) ?? state.data.length);
    const totalDuration = String((data.stats && data.stats.total_duration_str) ?? "0:00");
    dataSubtitle.textContent = "Total audios: " + totalAudios + " - Total duration: " + totalDuration;

    if (state.data.length === 0) {
      setdataEmpty(true);
    } else {
      setdataEmpty(false);
      renderdata();
      scrollToSavedEntry();
    }

    updateFolderActionsVisibility();
    // Update mark-processed button text and appearance based on current processed state
    if (data.processed) {
      markProcessedBtn.textContent = "Set 'is_processed'=false for this folder";
      markProcessedBtn.classList.add("toggled");
    } else {
      markProcessedBtn.textContent = "Set 'is_processed'=true for this folder";
      markProcessedBtn.classList.remove("toggled");
    }
    updateReviewedAllButton();

    if (data.stats) {
      const folderObj = state.folders.find((f) => f.name === name);
      if (folderObj) {
        folderObj.total_audios = Number(data.stats.total_audios || state.data.length);
        folderObj.total_duration_str = String(data.stats.total_duration_str || "0:00");
      }
      applyFolderStatsToDom(name);
    }
  } catch (err) {
    if (loadId !== state.currentLoadId) return;
    setdataLoading(false);
    dataSubtitle.textContent = "Network error: " + err.message;
    setdataEmpty(true);
  }
}

function renderdata() {
  stopPlayAll();
  syncEntryIds();
  dataList.innerHTML = "";
  setdataEmpty(false);
  state.genFuncs = {};
  applyFilters();
}

function autoSizeTranscript(textarea) {
  textarea.style.height = "auto";
  const minHeight = parseFloat(getComputedStyle(textarea).minHeight) || 0;
  textarea.style.height = Math.max(textarea.scrollHeight, minHeight) + "px";
}

function renderEntryRow(entry, index) {
  const row = document.createElement("div");
  row.className = "entry-row";
  row.dataset.entryKey = entryKey(entry, index);
  row.dataset.entryIndex = String(index);
  row.dataset.entryId = String(getEntryDisplayId(entry, index));

  const audioRel = guessAudioRelPath(entry);
  const entryDisplayId = getEntryDisplayId(entry, index);

  const top = document.createElement("div");
  top.className = "entry-top";

  const titleBlock = document.createElement("div");
  titleBlock.className = "entry-title-block";

  const titleId = document.createElement("button");
  titleId.className = "entry-title-id entry-title-id-clickable";
  titleId.title = "Click to generate, play audio, and auto-accept transcript";
  titleId.type = "button";
  titleId.textContent = `#${entryDisplayId}`;

  titleId.addEventListener("click", async () => {
    // Start glowing yellow immediately to signal the pending flow
    titleId.classList.add("entry-title-id-pending");

    // --- Step 1: Play audio (fire-and-forget)
    // Use `row` (available in closure) — `currentRow` doesn't exist yet
    const audioEl = row.querySelector('audio[data-explorer-audio="1"]');
    if (audioEl) {
      audioEl.currentTime = 0;
      audioEl.play().catch(() => { });
    }

    // --- Step 2: Generate transcript
    const generated = await generateEntryAPI(index);
    if (!generated) {
      // Remove glow on failure (titleId is still the original element here
      // because generateEntryAPI only replaces the row on success)
      titleId.classList.remove("entry-title-id-pending");
      return;
    }

    // After generateEntryAPI the row is replaced in the DOM — re-query it
    const currentRow = dataList.querySelector(`[data-entry-index="${index}"]`);
    if (!currentRow) return;

    // Re-apply the glow to the fresh titleId element in the new row
    const newTitleId = currentRow.querySelector(".entry-title-id");
    if (newTitleId) newTitleId.classList.add("entry-title-id-pending");

    // --- Step 3: Auto-accept immediately after Generate returns
    const acceptBtn = currentRow.querySelector(".temporary-transcript-actions .btn-info");
    if (acceptBtn && !acceptBtn.disabled) {
      currentRow.dataset.autoSpellcheck = "1";
      acceptBtn.click();
    } else {
      const spellBtn = currentRow.querySelector(".spellcheck-btn");
      if (spellBtn && !spellBtn.disabled) spellBtn.click();
    }
  });

  const titleFilename = document.createElement("div");
  titleFilename.className = "entry-title-filename";
  titleFilename.textContent = getEntryTitle(entry);

  titleBlock.appendChild(titleId);
  titleBlock.appendChild(titleFilename);

  const deleteBtn = document.createElement("button");
  deleteBtn.className = "btn-small btn-danger";
  deleteBtn.title = "Delete entry and audio file";

  const deleteIcon = document.createElement("span");
  deleteIcon.className = "material-symbols-outlined";
  deleteIcon.textContent = "delete";

  const deleteTxt = document.createElement("span");
  deleteTxt.textContent = "Delete";

  deleteBtn.appendChild(deleteIcon);
  deleteBtn.appendChild(deleteTxt);

  const editBtn = document.createElement("button");
  editBtn.className = "btn-small";
  editBtn.title = "Open audio trim editor";
  editBtn.disabled = !audioRel;

  const editIcon = document.createElement("span");
  editIcon.className = "material-symbols-outlined";
  editIcon.textContent = "content_cut";

  const editTxt = document.createElement("span");
  editTxt.textContent = "Edit";

  editBtn.appendChild(editIcon);
  editBtn.appendChild(editTxt);

  editBtn.addEventListener("click", () => {
    if (!audioRel || !window.AudioEditor) return;
    document.querySelectorAll('audio[data-explorer-audio="1"]').forEach((el) => {
      el.pause();
    });
    stopPlayAll();
    const audioUrl =
      "/api/media?folder=" +
      encodeURIComponent(state.currentFolder) +
      "&rel=" +
      encodeURIComponent(audioRel) +
      "&t=" +
      Date.now();

    window.AudioEditor.open({
      folder: state.currentFolder,
      index,
      audioRel,
      audioUrl,
      onApplied: async (data) => {
        if (data && data.entry && state.data[index]) {
          state.data[index] = data.entry;
        } else if (data && typeof data.audio_duration === "number" && state.data[index]) {
          state.data[index].audio_duration = data.audio_duration;
        }

        const rowAudio = row.querySelector("audio[data-explorer-audio=\"1\"]");
        if (rowAudio) {
          rowAudio.src =
            "/api/media?folder=" +
            encodeURIComponent(state.currentFolder) +
            "&rel=" +
            encodeURIComponent(audioRel) +
            "&t=" +
            Date.now();
          rowAudio.load();
        }

        const durationProp = Array.from(row.querySelectorAll(".prop-item")).find((item) => {
          const key = item.querySelector(".prop-key");
          return key && key.textContent === "audio_duration";
        });
        if (durationProp && data && typeof data.audio_duration === "number") {
          const val = durationProp.querySelector(".prop-val");
          if (val) val.textContent = String(data.audio_duration);
        }

        await refreshFolderStats(state.currentFolder, { refresh: true });
        const f = state.folders.find((folder) => folder.name === state.currentFolder);
        if (f) {
          dataSubtitle.textContent =
            "Total audios: " + f.total_audios + " - Total duration: " + f.total_duration_str;
        }
      },
    });
  });

  deleteBtn.addEventListener("click", async () => {
    if (!confirm("Delete this entry and its audio file? This cannot be undone.")) {
      return;
    }

    deleteBtn.disabled = true;
    deleteBtn.classList.add("deleting");
    try {
      // Remember the entry to scroll to after deletion.
      const prevIndex = index > 0 ? index - 1 : (state.data.length > 1 ? 1 : null);
      state.scrollToEntryKey = prevIndex != null ? entryKey(state.data[prevIndex], prevIndex) : null;

      const res = await fetch("/api/delete_entry", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ folder: state.currentFolder, index: index }),
      });
      const data = await res.json();
      if (!data.ok) {
        alert("Delete failed: " + (data.error || "unknown error"));
        deleteBtn.disabled = false;
        deleteBtn.classList.remove("deleting");
        state.scrollToEntryKey = null;
        return;
      }
      const folder = state.currentFolder;
      await animateDeleteRow(index);
      removeLocalEntry(index);

      // Show loading animation for folder stats in sidebar
      const selectedItem = folderList.querySelector(`.folder-item[data-name="${CSS.escape(folder)}"]`);
      if (selectedItem) {
        const statsEl = selectedItem.querySelector(".folder-stats");
        if (statsEl) {
          statsEl.classList.add("loading");
          statsEl.textContent = "... audios • ...";
          statsEl.style.opacity = "0.65";
        }
      }

      await refreshFolderStats(folder, { refresh: true });

      // Update the subtitle with refreshed stats
      const f = state.folders.find((f) => f.name === state.currentFolder);
      if (f) {
        dataSubtitle.textContent = "Total audios: " + f.total_audios + " - Total duration: " + f.total_duration_str;
      }
    } catch (err) {
      alert("Delete failed: " + err.message);
      deleteBtn.disabled = false;
      deleteBtn.classList.remove("deleting");
      state.scrollToEntryKey = null;
    }
  });

  const audioWrap = document.createElement("div");
  audioWrap.className = "entry-audio";

  const audioTop = document.createElement("div");
  audioTop.className = "entry-audio-top";

  if (audioRel) {
    const audioMeta = document.createElement("div");
    audioMeta.className = "entry-id";
    audioMeta.style.opacity = "0.55";
    audioMeta.textContent = audioRel;
    audioTop.appendChild(audioMeta);

    const audio = document.createElement("audio");
    audio.setAttribute("controls", "");
    audio.setAttribute("preload", "none");
    audio.dataset.explorerAudio = "1";
    audio.src = "/api/media?folder=" + encodeURIComponent(state.currentFolder) + "&rel=" + encodeURIComponent(audioRel);
    audio.playbackRate = state.playbackRate;
    audioTop.appendChild(audio);
  } else {
    const noAudio = document.createElement("div");
    noAudio.className = "entry-id";
    noAudio.style.opacity = "0.55";
    noAudio.textContent = "No audio path found in entry";
    audioTop.appendChild(noAudio);
  }

  audioWrap.appendChild(audioTop);

  const hasTranscript = entry && typeof entry === "object" && (
    Object.prototype.hasOwnProperty.call(entry, "reviewer_transcript_corrected") ||
    Object.prototype.hasOwnProperty.call(entry, "reviewer_corrected_transcript") ||
    Object.prototype.hasOwnProperty.call(entry, "generated_transcript")
  );
  const hasReviewerIsReviewed = entry && typeof entry === "object" && Object.prototype.hasOwnProperty.call(entry, "reviewer_is_reviewed");

  const topActions = document.createElement("div");
  topActions.className = "entry-top-actions";
  topActions.appendChild(editBtn);
  topActions.appendChild(deleteBtn);

  top.appendChild(titleBlock);
  top.appendChild(audioWrap);
  top.appendChild(topActions);
  row.appendChild(top);

  if (hasTranscript || hasReviewerIsReviewed) {
    const transcriptRowWrap = document.createElement("div");
    transcriptRowWrap.className = "entry-props";
    transcriptRowWrap.style.marginTop = "0.75rem";

    if (hasTranscript) {
      const reviewerTranscriptWrap = document.createElement("div");
      reviewerTranscriptWrap.className = "prop-item prop-item-full reviewer-transcript-section";

      const reviewerTranscriptHeader = document.createElement("div");
      reviewerTranscriptHeader.className = "reviewer-transcript-header";

      const reviewerTranscriptKey = document.createElement("div");
      reviewerTranscriptKey.className = "prop-key";
      reviewerTranscriptKey.textContent = "reviewer_transcript_corrected";

      const genActions = document.createElement("div");
      genActions.className = "reviewer-transcript-actions";

      const gen = document.createElement("button");
      gen.className = "btn-small";

      const genIcon = document.createElement("span");
      genIcon.className = "material-symbols-outlined";
      genIcon.textContent = "auto_awesome";

      const spinner = document.createElement("span");
      spinner.className = "spinner hidden";

      const genTxt = document.createElement("span");
      genTxt.textContent = "Generate";

      gen.appendChild(genIcon);
      gen.appendChild(spinner);
      gen.appendChild(genTxt);

      const setGeneratePending = (isPending) => {
        gen.disabled = isPending;
        genIcon.style.display = isPending ? "none" : "inline-block";
        spinner.style.display = isPending ? "inline-block" : "none";
        genTxt.textContent = isPending ? "Generating…" : "Generate";
        gen.classList.toggle("btn-generating", isPending);
      };
      state.genFuncs[index] = setGeneratePending;

      gen.addEventListener("click", () => {
        generateEntryAPI(index);
      });

      genActions.appendChild(gen);
      reviewerTranscriptHeader.appendChild(reviewerTranscriptKey);
      reviewerTranscriptHeader.appendChild(genActions);

      const reviewerTranscriptVal = document.createElement("div");
      reviewerTranscriptVal.className = "prop-val reviewer-transcript-val";

      const ta = document.createElement("textarea");
      ta.className = "input-text transcript-textarea";
      //ta.setAttribute("spellcheck", "true");
      ta.value = entry.reviewer_transcript_corrected == null
        ? String(entry.reviewer_corrected_transcript || "")
        : String(entry.reviewer_transcript_corrected);
      ta.addEventListener("change", async () => {
        const previousValue = entry.reviewer_transcript_corrected;
        const nextValue = ta.value;
        entry.reviewer_transcript_corrected = nextValue;
        const saved = await saveEntryField(
          index,
          { reviewer_transcript_corrected: nextValue },
          ta,
        );
        if (saved === false && entry.reviewer_transcript_corrected === nextValue) {
          entry.reviewer_transcript_corrected = previousValue;
          ta.value = previousValue == null ? "" : String(previousValue);
        }
      });
      ta.addEventListener("input", () => autoSizeTranscript(ta));

      // Trigger Google Chrome's spell-check detection by briefly focusing the textarea
      // This makes spell-check errors visible without user interaction
      /* setTimeout(() => {
        ta.focus();
        ta.blur();
      }, 100); */

      // Wrap textarea in a resize container with a custom touch handle
      const resizeWrap = document.createElement("div");
      resizeWrap.className = "textarea-resize-wrap";

      const resizeHandle = document.createElement("div");
      resizeHandle.className = "textarea-resize-handle";
      resizeHandle.innerHTML = '<span class="material-symbols-outlined">drag_handle</span>';

      // Touch-based resize
      let startY = 0, startH = 0;
      resizeHandle.addEventListener("touchstart", (e) => {
        e.preventDefault();
        startY = e.touches[0].clientY;
        startH = ta.offsetHeight;
        const onMove = (ev) => {
          const dy = ev.touches[0].clientY - startY;
          ta.style.height = Math.max(48, startH + dy) + "px";
        };
        const onEnd = () => {
          document.removeEventListener("touchmove", onMove);
          document.removeEventListener("touchend", onEnd);
        };
        document.addEventListener("touchmove", onMove, { passive: true });
        document.addEventListener("touchend", onEnd);
      }, { passive: false });

      resizeWrap.appendChild(ta);
      resizeWrap.appendChild(resizeHandle);
      reviewerTranscriptVal.appendChild(resizeWrap);
      requestAnimationFrame(() => autoSizeTranscript(ta));

      if (Object.prototype.hasOwnProperty.call(entry, "generated_transcript")) {
        reviewerTranscriptVal.classList.add("has-temporary-transcript");
        const generatedWrap = document.createElement("div");
        generatedWrap.className = "temporary-transcript-section";

        const generatedLabel = document.createElement("div");
        generatedLabel.className = "prop-key";
        generatedLabel.textContent = "generated_transcript (temporary)";

        const generatedTextarea = document.createElement("textarea");
        generatedTextarea.className = "input-text transcript-textarea";
        generatedTextarea.value = String(entry.generated_transcript || "");
        generatedTextarea.addEventListener("input", () => autoSizeTranscript(generatedTextarea));

        const acceptBtn = document.createElement("button");
        acceptBtn.className = "btn-small btn-info";
        acceptBtn.textContent = "Accept";
        acceptBtn.addEventListener("click", async () => {
          acceptBtn.disabled = true;
          const acceptedText = generatedTextarea.value;
          const saved = await saveEntryField(
            index,
            {
              reviewer_transcript_corrected: acceptedText,
              reviewer_is_reviewed: false,
            },
            acceptBtn,
            () => {
              state.data[index].reviewer_transcript_corrected = acceptedText;
              state.data[index].reviewer_is_reviewed = false;
              delete state.data[index].generated_transcript;
              const reviewedCheckbox = row.querySelector(
                'input[type="checkbox"][title="reviewer_is_reviewed"]',
              );
              if (reviewedCheckbox) {
                reviewedCheckbox.checked = false;
                reviewedCheckbox.classList.remove("reviewer-reset-animation");
                void reviewedCheckbox.offsetWidth;
                reviewedCheckbox.classList.add("reviewer-reset-animation");
                reviewedCheckbox.addEventListener(
                  "animationend",
                  () => reviewedCheckbox.classList.remove("reviewer-reset-animation"),
                  { once: true },
                );
              }
              ta.value = acceptedText;
              flashUpdate(ta);
              generatedWrap.remove();
              autoSizeTranscript(ta);
              // Transcript accepted — stop the yellow glow on the entry ID button
              const pendingTitleId = row.querySelector(".entry-title-id");
              if (pendingTitleId) pendingTitleId.classList.remove("entry-title-id-pending");
              setTimeout(() => {
                ta.scrollIntoView({ behavior: "smooth", block: "center" });
              }, 300);

              if (row.dataset.autoSpellcheck) {
                delete row.dataset.autoSpellcheck;
                const spellcheckBtn = row.querySelector(".spellcheck-btn");
                if (spellcheckBtn && !spellcheckBtn.disabled) {
                  spellcheckBtn.click();
                }
              }
            },
          );
          acceptBtn.disabled = !saved;
        });

        const rejectBtn = document.createElement("button");
        rejectBtn.className = "btn-small";
        rejectBtn.classList.add("btn-reject");
        rejectBtn.textContent = "Reject";
        rejectBtn.addEventListener("click", () => {
          delete state.data[index].generated_transcript;
          generatedWrap.remove();
        });

        generatedWrap.appendChild(generatedLabel);
        generatedWrap.appendChild(generatedTextarea);
        const generatedActions = document.createElement("div");
        generatedActions.className = "temporary-transcript-actions";
        generatedActions.appendChild(acceptBtn);
        generatedActions.appendChild(rejectBtn);
        generatedWrap.appendChild(generatedActions);
        reviewerTranscriptVal.appendChild(generatedWrap);
        requestAnimationFrame(() => autoSizeTranscript(generatedTextarea));
      }

      // Add spellcheck button now that reviewerTranscriptVal exists
      const spellcheckBtn = document.createElement("button");
      spellcheckBtn.className = "btn-small spellcheck-btn";
      spellcheckBtn.title = "Spellcheck Italian text";

      const spellcheckIcon = document.createElement("span");
      spellcheckIcon.className = "material-symbols-outlined";
      spellcheckIcon.textContent = "spellcheck";

      const spellcheckTxt = document.createElement("span");
      spellcheckTxt.textContent = "Spellcheck";

      spellcheckBtn.appendChild(spellcheckIcon);
      spellcheckBtn.appendChild(spellcheckTxt);

      spellcheckBtn.addEventListener("click", () => {
        const transcript = ta.value || "";
        const spellcheckDisplay = reviewerTranscriptVal.querySelector(".spellcheck-display");

        // Fetch and show spellcheck results inline
        spellcheckBtn.disabled = true;
        fetch("/api/spellcheck", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ text: transcript })
        })
          .then(res => res.json())
          .then(data => {
            if (data.error) {
              alert("Spellcheck error: " + data.error);
              spellcheckBtn.disabled = false;
              return;
            }

            const misspellings = data.misspellings || [];
            if (!spellcheckDisplay) {
              const newDisplay = document.createElement("div");
              newDisplay.className = "spellcheck-display";
              reviewerTranscriptVal.appendChild(newDisplay);
              renderInlineSpellcheck(transcript, misspellings, newDisplay, index, ta);
            } else {
              spellcheckDisplay.style.display = "block";
              renderInlineSpellcheck(transcript, misspellings, spellcheckDisplay, index, ta);
            }
            spellcheckBtn.classList.add("active");
            spellcheckBtn.disabled = false;
          })
          .catch(err => {
            alert("Error: " + err.message);
            spellcheckBtn.disabled = false;
          });
      });

      genActions.insertBefore(spellcheckBtn, gen);

      reviewerTranscriptWrap.appendChild(reviewerTranscriptHeader);
      reviewerTranscriptWrap.appendChild(reviewerTranscriptVal);
      transcriptRowWrap.appendChild(reviewerTranscriptWrap);
    }

    if (hasReviewerIsReviewed) {
      const reviewerIsReviewedWrap = document.createElement("div");
      reviewerIsReviewedWrap.className = "prop-item";

      const reviewerIsReviewedKey = document.createElement("div");
      reviewerIsReviewedKey.className = "prop-key";
      reviewerIsReviewedKey.textContent = "reviewer_is_reviewed";

      const reviewerIsReviewedVal = document.createElement("div");
      reviewerIsReviewedVal.className = "prop-val";

      const wrap = document.createElement("div");
      wrap.className = "inline-actions";
      wrap.style.alignItems = "center";

      const cb = document.createElement("input");
      cb.type = "checkbox";
      cb.className = "checkbox reviewer-is-reviewed-cb";
      cb.checked = Boolean(entry.reviewer_is_reviewed);
      cb.title = "reviewer_is_reviewed";
      cb.addEventListener("change", async () => {
        const previousValue = Boolean(entry.reviewer_is_reviewed);
        const nextValue = cb.checked;
        entry.reviewer_is_reviewed = nextValue;

        const row = cb.closest(".entry-row");
        if (currentFilterReviewed !== "all" && !isEntryVisibleAtIndex(index) && row) {
          row.classList.add("filter-removing");
          highlightFilterArea();
          window.setTimeout(() => {
            row.classList.remove("filter-removing");
            applyFilters();
          }, 350);
        } else if (currentFilterReviewed !== "all") {
          applyFilters();
        }

        const saved = await saveEntryField(index, { reviewer_is_reviewed: nextValue }, cb);
        if (saved === false) {
          entry.reviewer_is_reviewed = previousValue;
          cb.checked = previousValue;
          if (row) row.classList.remove("filter-removing");
          applyFilters();
        }
      });
      wrap.appendChild(cb);

      reviewerIsReviewedVal.appendChild(wrap);
      reviewerIsReviewedWrap.appendChild(reviewerIsReviewedKey);
      reviewerIsReviewedWrap.appendChild(reviewerIsReviewedVal);
      transcriptRowWrap.appendChild(reviewerIsReviewedWrap);
    }

    row.appendChild(transcriptRowWrap);
  }

  const props = document.createElement("div");
  props.className = "entry-props";

  const ordered = [];
  const pushIfPresent = (k) => {
    if (entry && typeof entry === "object" && Object.prototype.hasOwnProperty.call(entry, k)) ordered.push(k);
  };

  /*pushIfPresent("inference_transcript");
  pushIfPresent("reviewer_transcript_corrected");
  pushIfPresent("is_reviewed");*/
  const preferredOrder = [
    "entry_timestamp",
    "entry_id",
    "audio_data",
    "audio_duration",
    "audio_source",
    "inference_transcript",
    "inference_confidence",
    "inference_model",
    "user_transcript_processed",
    "user_is_validated"
  ];
  for (const k of preferredOrder) pushIfPresent(k);

  if (entry && typeof entry === "object") {
    for (const k of Object.keys(entry)) {
      if (!ordered.includes(k) && !k.startsWith("__explorer_entry_id") && !k.startsWith("_explorer_entry_id") && k !== "inference_model_version" && k !== "inference_alternative_transcript" && k !== "user_validated" && k !== "reviewer_corrected_transcript" && k !== "generated_transcript") ordered.push(k);
    }
  }

  const addKV = (k, vNode) => {
    const itemEl = document.createElement("div");
    itemEl.className = "prop-item";
    if (k === "reviewer_transcript_corrected") {
      itemEl.classList.add("prop-item-full");
    }

    const kEl = document.createElement("div");
    kEl.className = "prop-key";
    kEl.textContent = k;

    const vEl = document.createElement("div");
    vEl.className = "prop-val";
    vEl.appendChild(vNode);

    itemEl.appendChild(kEl);
    itemEl.appendChild(vEl);
    props.appendChild(itemEl);
  };

  ordered.forEach((k) => {
    if (!entry || typeof entry !== "object") return;
    const v = entry[k];

    if (k.startsWith("__explorer_entry_id") || k.startsWith("_explorer_entry_id") || k === "inference_model_version" || k === "inference_alternative_transcript" || k === "user_validated" || k === "reviewer_transcript_corrected" || k === "reviewer_corrected_transcript" || k === "reviewer_is_reviewed" || k === "generated_transcript") {
      return; // Rendered directly below the audio player
    }

    if (k === "inference_transcript") {
      const code = document.createElement("code");
      code.className = "transcript-code";
      code.textContent = v == null ? "" : String(v);
      addKV(k, code);
      return;
    }

    const span = document.createElement("span");
    if (typeof v === "object") {
      const code = document.createElement("code");
      code.textContent = JSON.stringify(v);
      span.appendChild(code);
    } else {
      span.textContent = v == null ? "" : String(v);
    }
    addKV(k, span);
  });

  row.appendChild(props);
  return row;
}

function updateDataSubtitle() {
  dataSubtitle.textContent = String(state.data.length) + " data • " + String(state.jsonFiles.length) + " JSON files";
}

function removeLocalEntry(index) {
  if (index < 0 || index >= state.data.length) return;

  const prevIndex = index > 0 ? index - 1 : (state.data.length > 1 ? 1 : null);
  state.scrollToEntryKey = prevIndex != null ? entryKey(state.data[prevIndex], prevIndex) : null;

  state.data.splice(index, 1);
  syncEntryIds();
  updateDataSubtitle();

  if (state.data.length === 0) {
    dataList.innerHTML = "";
    setdataEmpty(true);
    return;
  }

  renderdata();
  scrollToSavedEntry();
}

function flashEntryRow(index) {
  const rows = dataList.querySelectorAll(".entry-row");
  if (index < 0 || index >= rows.length) return;
  flashUpdate(rows[index]);
}

async function animateDeleteRow(index) {
  const rows = dataList.querySelectorAll(".entry-row");
  if (index < 0 || index >= rows.length) return;
  const row = rows[index];
  row.classList.add("delete-row");
  await new Promise((resolve) => {
    row.addEventListener("animationend", resolve, { once: true });
  });
}

function scrollToSavedEntry() {
  if (!state.scrollToEntryKey) return;
  const selector = `[data-entry-key="${state.scrollToEntryKey.replace(/"/g, '\\"')}"]`;
  const row = dataList.querySelector(selector);
  if (row) {
    row.scrollIntoView({ behavior: "smooth", block: "center" });
  }
  state.scrollToEntryKey = null;
}

function flashUpdate(el) {
  if (!el || !(el instanceof HTMLElement)) return;
  el.classList.add("update-glow");
  window.setTimeout(() => {
    el.classList.remove("update-glow");
  }, 800);
}

async function saveEntryField(index, updates, el, callback) {
  try {
    const res = await fetch("/api/entry", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ folder: state.currentFolder, index: index, updates: updates }),
    });
    const data = await res.json();
    if (!data.ok) {
      console.warn("Save failed", data);
      alert("Save failed: " + (data.error || "unknown error"));
      return false;
    } else {
      if (el) {
        flashUpdate(el);
      }
      if (callback && typeof callback === "function") {
        callback();
      }
      return true;
    }
  } catch (err) {
    console.warn("Save failed", err);
    alert("Save failed: " + err.message);
    return false;
  }
}

function getReviewedAllDesiredState() {
  const allReviewed = state.data.length > 0 && state.data.every((entry) => Boolean(entry && entry.reviewer_is_reviewed));
  return !allReviewed;
}

function updateReviewedAllButton() {
  if (!setReviewedAllBtn) return;
  const reviewed = getReviewedAllDesiredState();
  setReviewedAllBtn.textContent = `Set 'reviewer_is_reviewed'=${reviewed ? "true" : "false"} for all entries`;
  if (!reviewed) {
    setReviewedAllBtn.classList.add("toggled");
  } else {
    setReviewedAllBtn.classList.remove("toggled");
  }
}

setReviewedAllBtn.addEventListener("click", async () => {
  if (!state.currentFolder) return;
  const reviewed = getReviewedAllDesiredState();
  const confirmation = confirm(
    "The value of 'reviewer_is_reviewed' will be changed for all entries. This cannot be undone, it will not be possible to restore the previous states. Do you want to continue?"
  );
  if (!confirmation) {
    return;
  }
  setReviewedAllBtn.disabled = true;
  try {
    const res = await fetch("/api/reviewed_all", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ folder: state.currentFolder, reviewed }),
    });
    const data = await res.json();
    if (!data.ok) {
      alert("Failed: " + (data.error || "unknown error"));
      return;
    }
    state.data.forEach((entry) => {
      if (entry && typeof entry === "object") {
        entry.reviewer_is_reviewed = reviewed;
      }
    });
    renderdata();
    updateReviewedAllButton();
    flashUpdate(setReviewedAllBtn);
  } catch (err) {
    alert("Network error: " + err.message);
  } finally {
    setReviewedAllBtn.disabled = false;
  }
});

markProcessedBtn.addEventListener("click", async () => {
  if (!state.currentFolder) return;
  try {
    const res = await fetch("/api/processed_toggle", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ folder: state.currentFolder }),
    });
    const data = await res.json();
    if (!data.ok) {
      alert("Failed: " + (data.error || "unknown error"));
      return;
    }
    // Update UI according to new processed state
    const isProcessed = Boolean(data.processed);
    processedIndicator.hidden = false;
    processedIcon.textContent = isProcessed ? "check_circle" : "cancel";
    processedIcon.style.color = isProcessed ? "#10b981" : "#ef4444";
    if (isProcessed) {
      markProcessedBtn.textContent = "Set 'is_processed'=false for this folder";
      markProcessedBtn.classList.add("toggled");
    } else {
      markProcessedBtn.textContent = "Set 'is_processed'=true for this folder";
      markProcessedBtn.classList.remove("toggled");
    }
    flashUpdate(markProcessedBtn);
    // Update only the folder that changed instead of reloading all folders.
    // Update in-memory state
    try {
      const folderObj = state.folders.find((f) => f.name === state.currentFolder);
      if (folderObj) folderObj.processed = isProcessed;

      // Update sidebar item appearance immediately
      const item = folderList.querySelector(`.folder-item[data-name="${CSS.escape(
        state.currentFolder
      )}"]`);
      if (item) {
        item.classList.toggle("processed", isProcessed);
        const badge = item.querySelector(".folder-badge");
        if (badge) {
          badge.textContent = isProcessed ? "check_circle" : "cancel";
          badge.style.color = isProcessed ? "#10b981" : "#ef4444";
        }
        const statsEl = item.querySelector(".folder-stats");
        if (statsEl) {
          // show loading while we fetch updated stats for this folder
          statsEl.classList.add("loading");
          statsEl.textContent = "... audios • ...";
          statsEl.style.opacity = "0.65";
        }
      }

      // Refresh stats for the single folder from the server
      await refreshFolderStats(state.currentFolder, { refresh: true });
    } catch (e) {
      console.warn("Failed to update folder UI after processed toggle:", e);
      // As a fallback, do a full reload (should be rare)
      await loadFolders();
      highlightFolder(state.currentFolder);
    }
    highlightFolder(state.currentFolder);
  } catch (err) {
    alert("Network error: " + err.message);
  }
});

document.addEventListener("DOMContentLoaded", async () => {
  try {
    await loadConfig();
    await loadFolders();
    await loadCurateOverview();
    buildSpeedControls();
  } catch (err) {
    setSidebarError(err.message);
  }
});

async function generateEntryAPI(index) {
  if (state.genFuncs && state.genFuncs[index]) {
    state.genFuncs[index](true);
  }
  try {
    const res = await fetch("/api/generate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ folder: state.currentFolder, index: index }),
    });
    const data = await res.json();
    if (!data.ok) {
      alert("Generate failed: " + (data.error || "unknown error"));
      if (state.genFuncs && state.genFuncs[index]) state.genFuncs[index](false);
      return false;
    }
    state.data[index] = data.entry;
    state.scrollToEntryKey = entryKey(data.entry, index);
    const oldRow = dataList.querySelector(`[data-entry-index="${index}"]`);
    if (oldRow) {
      const newRow = renderEntryRow(data.entry, index);
      const oldAudio = oldRow.querySelector("audio[data-explorer-audio]");
      const newAudio = newRow.querySelector("audio[data-explorer-audio]");
      if (oldAudio && newAudio) {
        newAudio.replaceWith(oldAudio);
      }
      dataList.replaceChild(newRow, oldRow);
      applyPlaybackRateToAll();
    } else {
      renderdata();
    }
    flashEntryRow(index);
    setTimeout(() => {
      const generatedTextarea = dataList.querySelector(
        `[data-entry-index="${index}"] .temporary-transcript-section textarea`,
      );
      (generatedTextarea || dataList.querySelector(`[data-entry-index="${index}"]`))
        ?.scrollIntoView({ behavior: "smooth", block: "center" });
    }, 300);
    return true;
  } catch (err) {
    alert("Generate failed: " + err.message);
    return false;
  } finally {
    if (state.genFuncs && state.genFuncs[index]) state.genFuncs[index](false);
  }
}

const generateAllBtn = document.getElementById("generate-all-btn");
const generateAllIcon = document.getElementById("generate-all-icon");
const generateAllSpinner = document.getElementById("generate-all-spinner");
const generateAllTxt = document.getElementById("generate-all-txt");

if (generateAllBtn) {
  generateAllBtn.addEventListener("click", async () => {
    if (!state.currentFolder || !state.data || state.data.length === 0) return;

    // Toggleable generate-all: start / stop / restart
    if (!state.genAll) {
      state.genAll = {
        running: false,
        stopRequested: false,
        visibleIndexes: [],
        nextPosition: 0,
      };
    }

    // If a run is already in progress, request stop and update button text
    if (state.genAll.running) {
      state.genAll.stopRequested = true;
      generateAllTxt.textContent = "Stopping... Press again to force stop";
      return;
    }

    // Snapshot the visible entries when a new run starts. A stopped run resumes
    // from the same filtered set, even if the underlying data changes while it runs.
    if (
      state.genAll.nextPosition >= state.genAll.visibleIndexes.length
    ) {
      state.genAll.visibleIndexes = getVisibleEntryDataIndices();
      const requestedStartId = getGenerateAllStartIndex();
      state.genAll.nextPosition = state.genAll.visibleIndexes.findIndex((index) => {
        return getEntryDisplayId(state.data[index], index) >= requestedStartId;
      });
      if (state.genAll.nextPosition < 0) {
        state.genAll.nextPosition = state.genAll.visibleIndexes.length;
      }
    }
    const visibleIndexes = state.genAll.visibleIndexes;
    state.genAll.running = true;
    state.genAll.stopRequested = false;
    let successCount = 0;

    // Update UI to running state but keep button enabled so user can stop
    generateAllIcon.style.display = "none";
    generateAllSpinner.style.display = "inline-block";
    generateAllTxt.textContent = "Generating all... Press to stop";

    try {
      for (
        ;
        state.genAll.nextPosition < visibleIndexes.length;
        state.genAll.nextPosition++
      ) {
        // Allow stopping between items
        if (state.genAll.stopRequested) break;

        const index = visibleIndexes[state.genAll.nextPosition];
        if (generateAllStartInput) {
          generateAllStartInput.value = String(getEntryDisplayId(state.data[index], index));
        }
        const ok = await generateEntryAPI(index);
        if (ok) {
          successCount++;
        }
      }
    } finally {
      // Clean up running flag
      state.genAll.running = false;
      state.genAll.stopRequested = false;

      generateAllSpinner.style.display = "none";

      // If we generated all visible items, return to default label. If stopped,
      // allow restart from the next item in the same filtered set.
      if (state.genAll.nextPosition < visibleIndexes.length) {
        generateAllIcon.style.display = "inline-block";
        generateAllTxt.textContent = "Restart generating all";
      } else {
        generateAllIcon.style.display = "inline-block";
        generateAllTxt.textContent = "Generate all";
        state.genAll.visibleIndexes = [];
        state.genAll.nextPosition = 0;
      }

      showGenerateAllReport(successCount);
    }
  });
}

const spellcheckAllBtn = document.getElementById("spellcheck-all-btn");
const spellcheckAllIcon = document.getElementById("spellcheck-all-icon");
const spellcheckAllSpinner = document.getElementById("spellcheck-all-spinner");
const spellcheckAllTxt = document.getElementById("spellcheck-all-txt");

if (spellcheckAllBtn) {
  spellcheckAllBtn.addEventListener("click", async () => {
    if (!state.currentFolder || !state.data || state.data.length === 0) return;

    spellcheckAllBtn.disabled = true;
    spellcheckAllIcon.style.display = "none";
    spellcheckAllSpinner.style.display = "inline-block";
    spellcheckAllTxt.textContent = "Spellchecking...";

    try {
      let totalMisspellings = 0;
      let entriesProcessed = 0;

      for (let index = 0; index < state.data.length; index++) {
        const entry = state.data[index];
        if (!entry || !(entry.reviewer_transcript_corrected || entry.reviewer_corrected_transcript)) continue;

        const transcript = entry.reviewer_transcript_corrected || entry.reviewer_corrected_transcript;

        try {
          const res = await fetch("/api/spellcheck", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ text: transcript })
          });
          const data = await res.json();
          const misspellings = data.misspellings || [];
          totalMisspellings += misspellings.length;
          entriesProcessed++;

          // Render spellcheck results for this entry
          const allEntryRows = document.querySelectorAll(".entry-row");
          if (index < allEntryRows.length) {
            const entryRow = allEntryRows[index];
            const entryProps = entryRow.querySelector(".entry-props");
            const propItem = entryProps ? entryProps.querySelector(".prop-item-full") : null;
            const reviewerTranscriptVal = propItem ? propItem.querySelector(".prop-val") : null;
            const ta = reviewerTranscriptVal ? reviewerTranscriptVal.querySelector(".transcript-textarea") : null;

            if (reviewerTranscriptVal && ta) {
              // Find or create spellcheck display
              let spellcheckDisplay = reviewerTranscriptVal.querySelector(".spellcheck-display");
              if (!spellcheckDisplay) {
                spellcheckDisplay = document.createElement("div");
                spellcheckDisplay.className = "spellcheck-display";
                reviewerTranscriptVal.appendChild(spellcheckDisplay);
              }

              // Render the results
              renderInlineSpellcheck(transcript, misspellings, spellcheckDisplay, index, ta);
            }
          }
        } catch (err) {
          console.error(`Error spellchecking entry ${index}:`, err);
        }
      }

      // Show report
      showSpellcheckAllReport(entriesProcessed, totalMisspellings);
    } finally {
      spellcheckAllSpinner.style.display = "none";
      spellcheckAllIcon.style.display = "inline-block";
      spellcheckAllTxt.textContent = "Spellcheck all";
      spellcheckAllBtn.disabled = false;
    }
  });
}

// ===== SPELLCHECK FUNCTIONALITY =====

function renderInlineSpellcheck(text, misspellings, container, entryIndex, textareaElement) {
  container.innerHTML = "";

  if (misspellings.length === 0) {
    const msg = document.createElement("div");
    msg.style.padding = "0.75rem";
    msg.style.color = "#10b981";
    msg.style.fontSize = "0.9rem";
    msg.style.backgroundColor = "rgba(16, 185, 129, 0.1)";
    msg.style.borderRadius = "6px";
    msg.style.marginTop = "0.5rem";
    msg.textContent = "✓ No misspellings found!";
    container.appendChild(msg);
    return;
  }

  // Sort misspellings by position (reverse) to build segments from end to start
  const sorted = [...misspellings].sort((a, b) => b.start_pos - a.start_pos);

  // Build array of segments: text chunks + misspelling objects
  let segments = [{ type: "text", content: text }];

  for (const miss of sorted) {
    const newSegments = [];
    for (const seg of segments) {
      if (seg.type === "text") {
        const before = seg.content.substring(0, miss.start_pos);
        const word = seg.content.substring(miss.start_pos, miss.end_pos);
        const after = seg.content.substring(miss.end_pos);

        if (before) newSegments.push({ type: "text", content: before });
        newSegments.push({ type: "misspelling", word: word, suggestions: miss.suggestions });
        if (after) newSegments.push({ type: "text", content: after });
      } else {
        newSegments.push(seg);
      }
    }
    segments = newSegments;
  }

  // Render segments
  const textDiv = document.createElement("div");
  textDiv.className = "spellcheck-inline-text";
  textDiv.style.padding = "0.75rem";
  textDiv.style.marginTop = "0.5rem";
  textDiv.style.backgroundColor = "rgba(255, 255, 255, 0.02)";
  textDiv.style.border = "1px solid #374151";
  textDiv.style.borderRadius = "6px";
  textDiv.style.lineHeight = "1.8";
  textDiv.style.whiteSpace = "pre-wrap";
  textDiv.style.wordBreak = "break-word";
  textDiv.style.fontSize = "0.95rem";
  textDiv.style.fontFamily = "JetBrains Mono, monospace";

  for (const seg of segments) {
    if (seg.type === "text") {
      const span = document.createElement("span");
      span.textContent = seg.content;
      textDiv.appendChild(span);
    } else if (seg.type === "misspelling") {
      const word = document.createElement("span");
      word.className = "spellcheck-misspelled-word";
      word.textContent = seg.word;
      word.dataset.word = seg.word;
      word.dataset.suggestions = JSON.stringify(seg.suggestions);
      word.style.cursor = "pointer";
      word.style.backgroundColor = "#fee2e2";
      word.style.color = "#dc2626";
      word.style.padding = "2px 4px";
      word.style.borderRadius = "3px";
      word.style.fontWeight = "bold";

      word.addEventListener("click", (e) => {
        e.stopPropagation();
        showInlineContextMenu(e, seg.word, seg.suggestions, entryIndex, textareaElement);
      });

      textDiv.appendChild(word);
    }
  }

  container.appendChild(textDiv);

  const statsDiv = document.createElement("div");
  statsDiv.style.padding = "0.5rem 0.75rem 0 0.75rem";
  statsDiv.style.fontSize = "0.85rem";
  statsDiv.style.color = "#9ca3af";
  statsDiv.textContent = `Found ${misspellings.length} misspelling${misspellings.length !== 1 ? 's' : ''}.`;

  container.appendChild(statsDiv);
}

function showInlineContextMenu(event, word, suggestions, entryIndex, textareaElement) {
  // Remove existing menu
  const existingMenu = document.getElementById("spellcheck-context-menu");
  if (existingMenu) existingMenu.remove();

  const menu = document.createElement("div");
  menu.id = "spellcheck-context-menu";
  menu.className = "spellcheck-context-menu";
  menu.style.position = "fixed";
  menu.style.zIndex = "10000";
  menu.style.backgroundColor = "#1f2937";
  menu.style.border = "1px solid #374151";
  menu.style.borderRadius = "8px";
  menu.style.boxShadow = "0 10px 25px rgba(0,0,0,0.5)";
  menu.style.minWidth = "200px";
  menu.style.maxWidth = "300px";

  // Position near the clicked word
  const rect = event.target.getBoundingClientRect();
  menu.style.left = rect.left + "px";
  menu.style.top = (rect.bottom + 8) + "px";

  // Title
  const title = document.createElement("div");
  title.style.padding = "8px 12px";
  title.style.borderBottom = "1px solid #374151";
  title.style.fontSize = "0.85rem";
  title.style.color = "#9ca3af";
  title.style.fontWeight = "600";
  title.textContent = `Suggestions for "${word}"`;
  menu.appendChild(title);

  // Suggestions
  if (suggestions && suggestions.length > 0) {
    for (const suggestion of suggestions) {
      const item = document.createElement("button");
      item.className = "spellcheck-menu-item";
      item.textContent = suggestion;
      item.style.display = "block";
      item.style.width = "100%";
      item.style.padding = "8px 12px";
      item.style.border = "none";
      item.style.background = "transparent";
      item.style.color = "#e5e7eb";
      item.style.textAlign = "left";
      item.style.cursor = "pointer";
      item.style.borderBottom = "1px solid #374151";
      item.style.transition = "background 0.2s";

      item.addEventListener("mouseover", () => {
        item.style.background = "#374151";
      });
      item.addEventListener("mouseout", () => {
        item.style.background = "transparent";
      });
      item.addEventListener("click", () => {
        applyInlineCorrection(word, suggestion, entryIndex, textareaElement);
        menu.remove();
      });

      menu.appendChild(item);
    }
  } else {
    const noSuggestions = document.createElement("div");
    noSuggestions.style.padding = "8px 12px";
    noSuggestions.style.color = "#9ca3af";
    noSuggestions.style.fontSize = "0.9rem";
    noSuggestions.style.borderBottom = "1px solid #374151";
    noSuggestions.textContent = "No suggestions available";
    menu.appendChild(noSuggestions);
  }

  // Add to dictionary button
  const addToDictBtn = document.createElement("button");
  addToDictBtn.className = "spellcheck-menu-item";
  addToDictBtn.innerHTML = '<span class="material-symbols-outlined" style="font-size: 16px; vertical-align: middle; margin-right: 6px;">add_circle</span> Add to dictionary';
  addToDictBtn.style.display = "flex";
  addToDictBtn.style.alignItems = "center";
  addToDictBtn.style.width = "100%";
  addToDictBtn.style.padding = "8px 12px";
  addToDictBtn.style.border = "none";
  addToDictBtn.style.background = "transparent";
  addToDictBtn.style.color = "#e5e7eb";
  addToDictBtn.style.textAlign = "left";
  addToDictBtn.style.cursor = "pointer";
  addToDictBtn.style.transition = "background 0.2s";

  addToDictBtn.addEventListener("mouseover", () => {
    addToDictBtn.style.background = "#374151";
  });
  addToDictBtn.addEventListener("mouseout", () => {
    addToDictBtn.style.background = "transparent";
  });
  addToDictBtn.addEventListener("click", () => {
    addWordToDictionary(word);
    menu.remove();
  });

  menu.appendChild(addToDictBtn);

  document.body.appendChild(menu);

  // Close menu when clicking elsewhere
  const closeMenuHandler = (e) => {
    if (!menu.contains(e.target) && e.target !== event.target) {
      menu.remove();
      document.removeEventListener("click", closeMenuHandler);
    }
  };
  setTimeout(() => {
    document.addEventListener("click", closeMenuHandler);
  }, 0);
}

function applyInlineCorrection(oldWord, newWord, entryIndex, textareaElement) {
  // Replace word in textarea
  const regex = new RegExp("\\b" + oldWord + "\\b", "gi");
  const newText = textareaElement.value.replace(regex, newWord);

  if (newText !== textareaElement.value) {
    textareaElement.value = newText;
    saveEntryField(entryIndex, { reviewer_transcript_corrected: newText }, textareaElement, () => {
      // Show notification
      const notification = document.createElement("div");
      notification.style.position = "fixed";
      notification.style.bottom = "20px";
      notification.style.right = "20px";
      notification.style.backgroundColor = "#10b981";
      notification.style.color = "white";
      notification.style.padding = "12px 16px";
      notification.style.borderRadius = "6px";
      notification.style.zIndex = "10001";
      notification.style.fontSize = "0.9rem";
      notification.textContent = `Replaced "${oldWord}" with "${newWord}"`;
      document.body.appendChild(notification);

      setTimeout(() => notification.remove(), 3000);
    });
  }
}

function addWordToDictionary(word) {
  fetch("/api/spellcheck_add_word", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ word: word })
  })
    .then(res => res.json())
    .then(data => {
      if (data.ok) {
        const notification = document.createElement("div");
        notification.style.position = "fixed";
        notification.style.bottom = "20px";
        notification.style.right = "20px";
        notification.style.backgroundColor = "#10b981";
        notification.style.color = "white";
        notification.style.padding = "12px 16px";
        notification.style.borderRadius = "6px";
        notification.style.zIndex = "10001";
        notification.style.fontSize = "0.9rem";
        notification.textContent = `"${word}" added to dictionary`;
        document.body.appendChild(notification);

        setTimeout(() => notification.remove(), 3000);
      } else {
        alert("Error adding word to dictionary: " + (data.error || "unknown error"));
      }
    })
    .catch(err => {
      alert("Error: " + err.message);
    });
}

// ===== FILTERING FUNCTIONALITY =====

let currentFilterValidated = "all";
let currentFilterReviewed = "all";
let currentConfidenceMin = 0.0;
let currentConfidenceMax = 100.0;
const RENDER_BATCH_SIZE = 60;
let filteredEntryIndices = [];
let renderedEntryCount = 0;
let pendingEntryBatchTimeout = null;

function cancelPendingEntryBatch() {
  if (pendingEntryBatchTimeout !== null) {
    window.clearTimeout(pendingEntryBatchTimeout);
    pendingEntryBatchTimeout = null;
  }
  if (moreEntriesLoading) moreEntriesLoading.style.display = "none";
}

function renderNextEntryBatch() {
  if (!dataList || renderedEntryCount >= filteredEntryIndices.length) return;

  const nextEnd = Math.min(
    renderedEntryCount + RENDER_BATCH_SIZE,
    filteredEntryIndices.length,
  );
  for (let position = renderedEntryCount; position < nextEnd; position++) {
    const index = filteredEntryIndices[position];
    const row = renderEntryRow(state.data[index], index);
    if (row) dataList.appendChild(row);
  }
  renderedEntryCount = nextEnd;
  applyPlaybackRateToAll();

  requestAnimationFrame(() => {
    dataList.querySelectorAll(".transcript-textarea").forEach(autoSizeTranscript);
  });

  updateFolderActionsVisibility();
}

function maybeRenderMoreEntries() {
  if (
    !entriesBody ||
    pendingEntryBatchTimeout !== null ||
    renderedEntryCount >= filteredEntryIndices.length
  ) return;
  const distanceToBottom = entriesBody.scrollHeight - entriesBody.scrollTop - entriesBody.clientHeight;
  if (distanceToBottom < entriesBody.clientHeight * 1.5) {
    if (moreEntriesLoading) moreEntriesLoading.style.display = "flex";
    pendingEntryBatchTimeout = window.setTimeout(() => {
      pendingEntryBatchTimeout = null;
      renderNextEntryBatch();
      if (moreEntriesLoading) moreEntriesLoading.style.display = "none";
    }, 80);
  }
}

if (entriesBody) {
  entriesBody.addEventListener("scroll", maybeRenderMoreEntries, { passive: true });
}

function applyFilters() {
  if (!state.data) return;
  cancelPendingEntryBatch();
  filteredEntryIndices = getVisibleEntryDataIndices();
  renderedEntryCount = 0;
  dataList.innerHTML = "";
  renderNextEntryBatch();

  const countLabel = document.getElementById("filter-count-label");
  if (countLabel) {
    countLabel.textContent = `${filteredEntryIndices.length} / ${state.data.length}`;
  }
}

function highlightFilterArea() {
  const filterArea = document.getElementById("stat-filters");
  if (!filterArea) return;
  filterArea.classList.remove("filter-area-highlight");
  void filterArea.offsetWidth;
  filterArea.classList.add("filter-area-highlight");
}

function updateConfidenceSliderUI() {
  const numMin = document.getElementById("confidence-min");
  const numMax = document.getElementById("confidence-max");

  if (!numMin || !numMax) return;

  let minV = parseFloat(numMin.value);
  let maxV = parseFloat(numMax.value);

  if (isNaN(minV)) minV = 0;
  if (isNaN(maxV)) maxV = 100;

  if (minV > maxV) {
    const tmp = minV;
    minV = maxV;
    maxV = tmp;
  }

  currentConfidenceMin = minV;
  currentConfidenceMax = maxV;

  numMin.value = minV.toFixed(2);
  numMax.value = maxV.toFixed(2);
}

function initFilters() {
  const valRadios = document.querySelectorAll('input[name="filter-validated"]');
  valRadios.forEach(r => {
    r.addEventListener("change", (e) => {
      const group = e.target.closest(".filter-radio-group");
      if (group) group.querySelectorAll(".filter-radio").forEach(lbl => lbl.classList.remove("active"));
      e.target.closest(".filter-radio").classList.add("active");
      currentFilterValidated = e.target.value;
      applyFilters();
    });
  });

  const revRadios = document.querySelectorAll('input[name="filter-reviewed"]');
  revRadios.forEach(r => {
    r.addEventListener("change", (e) => {
      const group = e.target.closest(".filter-radio-group");
      if (group) group.querySelectorAll(".filter-radio").forEach(lbl => lbl.classList.remove("active"));
      e.target.closest(".filter-radio").classList.add("active");
      currentFilterReviewed = e.target.value;
      applyFilters();
    });
  });

  const numMin = document.getElementById("confidence-min");
  const numMax = document.getElementById("confidence-max");

  const onNumInput = () => {
    let minV = parseFloat(numMin.value);
    let maxV = parseFloat(numMax.value);
    if (isNaN(minV)) minV = 0;
    if (isNaN(maxV)) maxV = 100;
    if (minV < 0) minV = 0;
    if (maxV > 100) maxV = 100;

    numMin.value = minV;
    numMax.value = maxV;
    updateConfidenceSliderUI();
    applyFilters();
  };

  if (numMin) numMin.addEventListener("change", onNumInput);
  if (numMax) numMax.addEventListener("change", onNumInput);

  updateConfidenceSliderUI();
}

document.addEventListener("DOMContentLoaded", () => {
  initFilters();
});
