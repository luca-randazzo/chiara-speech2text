/* Standalone Explorer — folder data editor (local filesystem mode) */

const state = {
  folders: [],
  currentFolder: null,
  data: [],
  jsonFiles: [],
  wrapEnabled: false,
  playbackRate: 1.0,
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
const stickyStats = document.getElementById("sticky-stats");


const speedControls = document.getElementById("speed-controls");
const statJsonFiles = document.getElementById("stat-json-files");
const jsonFilesControls = document.getElementById("json-files-controls");

const processedIndicator = document.getElementById("processed-indicator");
const processedIcon = document.getElementById("processed-icon");
const folderActions = document.getElementById("folder-actions");
const markProcessedBtn = document.getElementById("mark-processed-btn");
const setReviewedAllBtn = document.getElementById("set-reviewed-all-btn");

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
const generateAllReportSkipped = document.getElementById("generate-all-report-skipped");

const USER_VALIDATED_GENERATE_ERROR =
  "The transcript has been validated by the user. Further transcription (through Generate) is not allowed - to avoid losing the transcript validated by the user";

// Mobile elements
const hamburgerBtn = document.getElementById("hamburger-btn");
const sidebarOverlay = document.getElementById("sidebar-overlay");
const exploreSidebar = document.querySelector(".explorer-sidebar");

// Mobile menu functionality
function updateMobileLayout() {
  state.isMobile = window.innerWidth <= 768;

  if (!state.isMobile) {
    closeSidebar();
  }
}

function toggleSidebar() {
  if (state.isMobile) {
    exploreSidebar.classList.toggle("open");
    sidebarOverlay.classList.toggle("active");
  }
}

function closeSidebar() {
  if (state.isMobile) {
    exploreSidebar.classList.remove("open");
    sidebarOverlay.classList.remove("active");
  }
}

if (hamburgerBtn) {
  hamburgerBtn.addEventListener("click", (e) => {
    e.preventDefault();
    toggleSidebar();
  });
}

// Close sidebar when tapping outside of it on mobile.
// The overlay has pointer-events:none (purely visual), so we detect
// outside-clicks at the document level instead.  Folder-item clicks
// call e.stopPropagation(), so they won't reach this handler.
document.addEventListener("click", (e) => {
  if (
    state.isMobile &&
    exploreSidebar.classList.contains("open") &&
    !exploreSidebar.contains(e.target) &&
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

function showGenerateAllReport(successCount, skippedUserValidatedCount) {
  if (!generateAllReportModal || !generateAllReportSuccess || !generateAllReportSkipped) {
    alert(
      `${successCount} entries transcribed successfully.\n` +
      `${skippedUserValidatedCount} entries skipped because they had user_validated=true.`
    );
    return;
  }
  generateAllReportSuccess.textContent =
    `${successCount} entr${successCount === 1 ? "y" : "ies"} transcribed successfully.`;
  generateAllReportSkipped.textContent =
    `${skippedUserValidatedCount} entr${skippedUserValidatedCount === 1 ? "y" : "ies"} skipped because ` +
    `${skippedUserValidatedCount === 1 ? "it had" : "they had"} user_validated=true.`;
  generateAllReportModal.style.display = "flex";
  generateAllReportModal.setAttribute("aria-hidden", "false");
}

function isUserValidatedEntry(entry) {
  if (!entry || typeof entry !== "object") return false;
  const value = entry.user_validated;
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

function formatBytes(bytes) {
  if (!bytes || bytes === 0) return "";
  if (bytes < 1024) return bytes + " B";
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + " KB";
  return (bytes / (1024 * 1024)).toFixed(2) + " MB";
}

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
  for (let r = 1.0; r <= 2.5 + 1e-9; r += 0.5) {
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

function closeViewer() {
  viewerPanel.style.display = "none";
  viewerPanel.classList.remove("show-mobile");
  if (jsonModalBackdrop) jsonModalBackdrop.classList.remove("active");
  viewerPre.textContent = "";
  viewerFilename.textContent = "";
  viewerSize.textContent = "";
  viewerLineCount.textContent = "";
  viewerLoading.style.display = "none";
  viewerPre.style.display = "none";
  if (viewerTextarea) {
    viewerTextarea.style.display = "none";
    viewerTextarea.value = "";
  }
  if (viewerSaveBtn) {
    viewerSaveBtn.style.display = "none";
  }
  state.currentJsonContext = null;
}

viewerCloseBtn.addEventListener("click", closeViewer);
if (jsonModalBackdrop) {
  jsonModalBackdrop.addEventListener("click", closeViewer);
}
viewerWrapBtn.addEventListener("click", () => {
  state.wrapEnabled = !state.wrapEnabled;
  viewerPre.classList.toggle("wrap", state.wrapEnabled);
  viewerWrapBtn.classList.toggle("active", state.wrapEnabled);
});
viewerCopyBtn.addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText(viewerPre.textContent || viewerTextarea.value || "");
    const orig = viewerCopyBtn.innerHTML;
    viewerCopyBtn.innerHTML = "<span class=\"material-symbols-outlined\">check</span><span>Copied!</span>";
    setTimeout(() => {
      viewerCopyBtn.innerHTML = orig;
    }, 1200);
  } catch (_) { }
});

if (viewerSaveBtn) {
  viewerSaveBtn.addEventListener("click", async () => {
    await saveViewerJson();
  });
}

function setViewerContent(content) {
  const formatted = (() => {
    try {
      return JSON.stringify(JSON.parse(content), null, 2);
    } catch (_) {
      return content;
    }
  })();
  state.currentJsonContext = {
    ...state.currentJsonContext,
    content: formatted,
  };

  if (state.adminMode && viewerTextarea) {
    viewerTextarea.value = formatted;
    viewerTextarea.style.display = "block";
    viewerPre.style.display = "none";
  } else {
    viewerTextarea.style.display = "none";
    viewerPre.style.display = "block";
    viewerPre.textContent = formatted;
  }
  viewerPre.classList.toggle("wrap", state.wrapEnabled);
  const lineCount = formatted.split("\n").length;
  viewerLineCount.textContent = String(lineCount) + " line" + (lineCount !== 1 ? "s" : "");
}

async function saveViewerJson() {
  if (!state.currentJsonContext || !state.currentJsonContext.file) return;
  const raw = viewerTextarea ? viewerTextarea.value : "";
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    alert("Invalid JSON: " + err.message);
    return;
  }

  const payload = {
    file: state.currentJsonContext.file,
    content: JSON.stringify(parsed, null, 2) + "\n",
  };
  if (state.currentJsonContext.folder) {
    payload.folder = state.currentJsonContext.folder;
  }

  try {
    viewerSaveBtn.disabled = true;
    const res = await fetch("/api/save_json", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const data = await res.json();
    if (!res.ok || data.error) {
      throw new Error(data.error || "Failed to save file");
    }
    const orig = viewerSaveBtn.innerHTML;
    viewerSaveBtn.innerHTML = "<span class=\"material-symbols-outlined\">check</span><span>Saved</span>";
    setTimeout(() => {
      viewerSaveBtn.innerHTML = orig;
    }, 1200);
    setViewerContent(payload.content);
  } catch (err) {
    alert("Save failed: " + err.message);
  } finally {
    if (viewerSaveBtn) viewerSaveBtn.disabled = false;
  }
}

async function openJsonViewer(file) {
  if (!state.currentFolder) return;
  state.currentJsonContext = { file, folder: state.currentFolder };
  if (viewerSaveBtn) {
    viewerSaveBtn.style.display = state.adminMode ? "inline-flex" : "none";
  }
  if (state.isMobile) {
    viewerPanel.classList.add("show-mobile");
    if (jsonModalBackdrop) jsonModalBackdrop.classList.add("active");
  } else {
    viewerPanel.style.display = "flex";
  }
  viewerFilename.textContent = file;
  viewerSize.textContent = "";
  viewerLineCount.textContent = "";
  viewerPre.style.display = "none";
  if (viewerTextarea) viewerTextarea.style.display = "none";
  viewerLoading.style.display = "flex";

  try {
    const url = "/api/file_content?folder=" + encodeURIComponent(state.currentFolder) + "&file=" + encodeURIComponent(file);
    const res = await fetch(url);
    const data = await res.json();

    if (data.error) {
      viewerLoading.style.display = "none";
      viewerPre.style.display = "block";
      viewerPre.textContent = "Error: " + data.error;
      return;
    }

    viewerLoading.style.display = "none";
    viewerSize.textContent = formatBytes((data.content || "").length);
    setViewerContent(data.content || "");
  } catch (err) {
    viewerLoading.style.display = "none";
    viewerPre.style.display = "block";
    viewerPre.textContent = "Network error: " + err.message;
  }
}

async function openJsonViewerRoot(file) {
  state.currentJsonContext = { file };
  if (viewerSaveBtn) {
    viewerSaveBtn.style.display = state.adminMode ? "inline-flex" : "none";
  }
  if (state.isMobile) {
    viewerPanel.classList.add("show-mobile");
    if (jsonModalBackdrop) jsonModalBackdrop.classList.add("active");
  } else {
    viewerPanel.style.display = "flex";
  }
  viewerFilename.textContent = file;
  viewerSize.textContent = "";
  viewerLineCount.textContent = "";
  viewerPre.style.display = "none";
  if (viewerTextarea) viewerTextarea.style.display = "none";
  viewerLoading.style.display = "flex";

  try {
    const url = "/api/file_content_root?file=" + encodeURIComponent(file);
    const res = await fetch(url);
    const data = await res.json();

    if (data.error) {
      viewerLoading.style.display = "none";
      viewerPre.style.display = "block";
      viewerPre.textContent = "Error: " + data.error;
      return;
    }

    viewerLoading.style.display = "none";
    viewerSize.textContent = formatBytes((data.content || "").length);
    setViewerContent(data.content || "");
  } catch (err) {
    viewerLoading.style.display = "none";
    viewerPre.style.display = "block";
    viewerPre.textContent = "Network error: " + err.message;
  }
}

async function selectFolder(name) {
  closeViewer();
  state.currentFolder = name;
  highlightFolder(name);

  currentFolderLabel.textContent = name;
  dataSubtitle.textContent = "";
  dataList.innerHTML = "";

  stickyStats.style.display = "none";
  processedIndicator.hidden = true;
  folderActions.style.display = "none";

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

    folderActions.style.display = "block";
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
    setdataLoading(false);
    dataSubtitle.textContent = "Network error: " + err.message;
    setdataEmpty(true);
  }
}

function renderdata() {
  dataList.innerHTML = "";
  setdataEmpty(false);
  state.genFuncs = {};

  state.data.forEach((entry, index) => {
    const row = document.createElement("div");
    row.className = "entry-row";
    row.dataset.entryKey = entryKey(entry, index);

    const entryId = row.dataset.entryKey;
    const audioRel = guessAudioRelPath(entry);

    const top = document.createElement("div");
    top.className = "entry-top";

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

    const topActions = document.createElement("div");
    topActions.className = "entry-top-actions";
    topActions.appendChild(deleteBtn);

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
      audio.setAttribute("preload", "metadata");
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

    const hasTranscript = entry && typeof entry === "object" && Object.prototype.hasOwnProperty.call(entry, "reviewer_corrected_transcript");
    const hasReviewerIsReviewed = entry && typeof entry === "object" && Object.prototype.hasOwnProperty.call(entry, "reviewer_is_reviewed");
    top.appendChild(audioWrap);
    top.appendChild(topActions);
    row.appendChild(top);

    if (hasTranscript || hasReviewerIsReviewed) {
      const transcriptRowWrap = document.createElement("div");
      transcriptRowWrap.className = "entry-props";
      transcriptRowWrap.style.marginTop = "0.75rem";

      if (hasTranscript) {
        const reviewerTranscriptWrap = document.createElement("div");
        reviewerTranscriptWrap.className = "prop-item prop-item-full";

        const reviewerTranscriptKey = document.createElement("div");
        reviewerTranscriptKey.className = "prop-key";
        reviewerTranscriptKey.textContent = "reviewer_corrected_transcript";

        const reviewerTranscriptVal = document.createElement("div");
        reviewerTranscriptVal.className = "prop-val";
        reviewerTranscriptVal.style.height = "100%";

        const ta = document.createElement("textarea");
        ta.className = "input-text transcript-textarea";
        ta.style.height = "100%";
        ta.style.flex = "1";
        ta.value = entry.reviewer_corrected_transcript == null ? "" : String(entry.reviewer_corrected_transcript);
        ta.addEventListener("change", () => {
          saveEntryField(index, { reviewer_corrected_transcript: ta.value }, ta);
        });

        // Wrap textarea in a resize container with a custom touch handle
        const resizeWrap = document.createElement("div");
        resizeWrap.className = "textarea-resize-wrap";
        resizeWrap.style.width = "100%";

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

        reviewerTranscriptWrap.appendChild(reviewerTranscriptKey);
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
        cb.className = "checkbox";
        cb.style.transform = "scale(1.2)";
        cb.checked = Boolean(entry.reviewer_is_reviewed);
        cb.title = "reviewer_is_reviewed";
        cb.addEventListener("change", () => {
          saveEntryField(index, { reviewer_is_reviewed: cb.checked }, cb);
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
    pushIfPresent("reviewer_corrected_transcript");
    pushIfPresent("is_reviewed");*/
    const preferredOrder = [
      //"entry_id",
      //"interaction_id",
      "entry_timestamp",
      "interaction_timestamp",
      "audio_data",
      "audio_duration",
      "audio_source",
      "inference_transcript",
      "inference_confidence",
      "inference_model_version",
      "inference_alternative_transcript",
      "user_validated",
      //"is_reviewed",
      "reviewer_corrected_transcript",
      "reviewer_is_reviewed"
    ];
    for (const k of preferredOrder) pushIfPresent(k);

    if (entry && typeof entry === "object") {
      for (const k of Object.keys(entry)) {
        if (!ordered.includes(k)) ordered.push(k);
      }
    }

    const addKV = (k, vNode) => {
      const itemEl = document.createElement("div");
      itemEl.className = "prop-item";
      if (k === "reviewer_corrected_transcript" || k === "inference_transcript" || k === "inference_alternative_transcript") {
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

      if (k === "reviewer_corrected_transcript" || k === "reviewer_is_reviewed") {
        return; // Rendered directly below the audio player
      }

      if (k === "inference_transcript") {
        const wrap = document.createElement("div");
        wrap.className = "inline-actions";

        const text = document.createElement("div");
        text.style.flex = "1";
        text.style.minWidth = "220px";

        const code = document.createElement("code");
        code.className = "transcript-code";
        code.textContent = v == null ? "" : String(v);
        text.appendChild(code);

        wrap.appendChild(text);

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

        const copyBtn = document.createElement("button");
        copyBtn.className = "btn-small";
        copyBtn.title = "Copy transcript";

        const copyIcon = document.createElement("span");
        copyIcon.className = "material-symbols-outlined";
        copyIcon.textContent = "content_copy";

        const copyTxt = document.createElement("span");
        copyTxt.textContent = "Copy";

        copyBtn.appendChild(copyIcon);
        copyBtn.appendChild(copyTxt);
        copyBtn.style.marginLeft = "0.35rem";

        const setGeneratePending = (isPending) => {
          gen.disabled = isPending;
          copyBtn.disabled = isPending;
          genIcon.style.display = isPending ? "none" : "inline-block";
          spinner.style.display = isPending ? "inline-block" : "none";
          genTxt.textContent = isPending ? "Generating…" : "Generate";
          gen.classList.toggle("btn-generating", isPending);
        };
        state.genFuncs[index] = setGeneratePending;

        gen.addEventListener("click", () => {
          generateEntryAPI(index);
        });

        copyBtn.addEventListener("click", async () => {
          try {
            await navigator.clipboard.writeText(code.textContent || "");
            const orig = copyBtn.innerHTML;
            copyBtn.innerHTML = "<span class=\"material-symbols-outlined\">check</span><span>Copied!</span>";
            setTimeout(() => {
              copyBtn.innerHTML = orig;
            }, 1200);
          } catch (err) {
            alert("Copy failed: " + err.message);
          }
        });

        wrap.appendChild(gen);
        wrap.appendChild(copyBtn);
        addKV(k, wrap);
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
    dataList.appendChild(row);
  });

  applyPlaybackRateToAll();
}

function updateDataSubtitle() {
  dataSubtitle.textContent = String(state.data.length) + " data • " + String(state.jsonFiles.length) + " JSON files";
}

function removeLocalEntry(index) {
  if (index < 0 || index >= state.data.length) return;

  const prevIndex = index > 0 ? index - 1 : (state.data.length > 1 ? 1 : null);
  state.scrollToEntryKey = prevIndex != null ? entryKey(state.data[prevIndex], prevIndex) : null;

  state.data.splice(index, 1);
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

async function saveEntryField(index, updates, el) {
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
    } else if (el) {
      flashUpdate(el);
    }
  } catch (err) {
    console.warn("Save failed", err);
    alert("Save failed: " + err.message);
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
    buildSpeedControls();
  } catch (err) {
    setSidebarError(err.message);
  }
});

async function generateEntryAPI(index) {
  const entry = state.data && state.data[index];
  if (isUserValidatedEntry(entry)) {
    alert(USER_VALIDATED_GENERATE_ERROR);
    return false;
  }

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
    renderdata();
    flashEntryRow(index);
    scrollToSavedEntry();
    return true;
  } catch (err) {
    alert("Generate failed: " + err.message);
    if (state.genFuncs && state.genFuncs[index]) state.genFuncs[index](false);
    return false;
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
    if (!state.genAll) state.genAll = { running: false, stopRequested: false, lastSuccessIndex: -1 };

    // If a run is already in progress, request stop and update button text
    if (state.genAll.running) {
      state.genAll.stopRequested = true;
      generateAllTxt.textContent = "Stopping... Press again to force stop";
      return;
    }

    // Start (or restart) generation
    const startIndex = Math.max(0, (state.genAll.lastSuccessIndex == null ? -1 : state.genAll.lastSuccessIndex) + 1);
    state.genAll.running = true;
    state.genAll.stopRequested = false;
    let successCount = 0;
    let skippedUserValidatedCount = 0;

    // Update UI to running state but keep button enabled so user can stop
    generateAllIcon.style.display = "none";
    generateAllSpinner.style.display = "inline-block";
    generateAllTxt.textContent = "Generating all... Press to stop";

    try {
      for (let index = startIndex; index < state.data.length; index++) {
        // Allow stopping between items
        if (state.genAll.stopRequested) break;

        if (isUserValidatedEntry(state.data[index])) {
          skippedUserValidatedCount++;
          state.genAll.lastSuccessIndex = index;
          continue;
        }

        const ok = await generateEntryAPI(index);
        if (ok) {
          successCount++;
          state.genAll.lastSuccessIndex = index;
        }
      }
    } finally {
      // Clean up running flag
      state.genAll.running = false;
      state.genAll.stopRequested = false;

      generateAllSpinner.style.display = "none";

      // If we generated all items, return to default label. If we stopped early, allow restart.
      if (state.genAll.lastSuccessIndex >= 0 && state.genAll.lastSuccessIndex < state.data.length - 1) {
        generateAllIcon.style.display = "inline-block";
        generateAllTxt.textContent = "Restart generating all";
      } else if (state.genAll.lastSuccessIndex >= state.data.length - 1) {
        generateAllIcon.style.display = "inline-block";
        generateAllTxt.textContent = "Generate all";
        // reset lastSuccessIndex so next run starts from beginning
        state.genAll.lastSuccessIndex = -1;
      } else {
        generateAllIcon.style.display = "inline-block";
        generateAllTxt.textContent = "Generate all";
      }

      showGenerateAllReport(successCount, skippedUserValidatedCount);
    }
  });
}
