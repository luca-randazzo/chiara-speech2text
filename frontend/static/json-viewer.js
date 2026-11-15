/* Shared JSON viewer for explorer and analyze pages. */
(function () {
  "use strict";

  function formatBytes(bytes) {
    if (!bytes || bytes === 0) return "";
    if (bytes < 1024) return bytes + " B";
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + " KB";
    return (bytes / (1024 * 1024)).toFixed(2) + " MB";
  }

  function formatJson(content) {
    try {
      return JSON.stringify(JSON.parse(content), null, 2);
    } catch (_) {
      return content;
    }
  }

  function createJsonViewer(options) {
    const state = options.state || {};
    const elements = options.elements || {};
    const getCurrentFolder = options.getCurrentFolder || (() => state.currentFolder);
    const onOpen = options.onOpen || (() => {});
    const onClose = options.onClose || (() => {});
    const adminModeEnabled = options.adminModeEnabled || (() => false);

    const viewerPanel = elements.viewerPanel;
    const viewerCloseBtn = elements.viewerCloseBtn;
    const viewerWrapBtn = elements.viewerWrapBtn;
    const viewerCopyBtn = elements.viewerCopyBtn;
    const viewerSaveBtn = elements.viewerSaveBtn;
    const viewerFilename = elements.viewerFilename;
    const viewerSize = elements.viewerSize;
    const viewerLineCount = elements.viewerLineCount;
    const viewerLoading = elements.viewerLoading;
    const viewerPre = elements.viewerPre;
    const viewerTextarea = elements.viewerTextarea;
    const jsonModalBackdrop = elements.jsonModalBackdrop;

    function setVisible(isVisible) {
      if (!viewerPanel) return;
      if (state.isMobile && isVisible) {
        viewerPanel.classList.add("show-mobile");
        if (jsonModalBackdrop) jsonModalBackdrop.classList.add("active");
      } else {
        viewerPanel.style.display = isVisible ? "flex" : "none";
        viewerPanel.classList.remove("show-mobile");
        if (jsonModalBackdrop) jsonModalBackdrop.classList.remove("active");
      }
    }

    function close() {
      setVisible(false);
      if (viewerPre) {
        viewerPre.textContent = "";
        viewerPre.style.display = "none";
      }
      if (viewerFilename) viewerFilename.textContent = "";
      if (viewerSize) viewerSize.textContent = "";
      if (viewerLineCount) viewerLineCount.textContent = "";
      if (viewerLoading) viewerLoading.style.display = "none";
      if (viewerTextarea) {
        viewerTextarea.style.display = "none";
        viewerTextarea.value = "";
      }
      if (viewerSaveBtn) viewerSaveBtn.style.display = "none";
      state.currentJsonContext = null;
      onClose();
    }

    function setContent(content) {
      const formatted = formatJson(content);
      state.currentJsonContext = {
        ...state.currentJsonContext,
        content: formatted,
      };

      if (adminModeEnabled() && viewerTextarea) {
        viewerTextarea.value = formatted;
        viewerTextarea.style.display = "block";
        if (viewerPre) viewerPre.style.display = "none";
      } else if (viewerPre) {
        if (viewerTextarea) viewerTextarea.style.display = "none";
        viewerPre.style.display = "block";
        viewerPre.textContent = formatted;
      }

      if (viewerPre) viewerPre.classList.toggle("wrap", !!state.wrapEnabled);
      if (viewerLineCount) {
        const lineCount = formatted.split("\n").length;
        viewerLineCount.textContent = String(lineCount) + " line" + (lineCount !== 1 ? "s" : "");
      }
    }

    function prepare(file, context) {
      state.currentJsonContext = context;
      if (viewerSaveBtn) {
        viewerSaveBtn.style.display = adminModeEnabled() ? "inline-flex" : "none";
      }
      setVisible(true);
      onOpen();
      if (viewerFilename) viewerFilename.textContent = file;
      if (viewerSize) viewerSize.textContent = "";
      if (viewerLineCount) viewerLineCount.textContent = "";
      if (viewerPre) viewerPre.style.display = "none";
      if (viewerTextarea) viewerTextarea.style.display = "none";
      if (viewerLoading) viewerLoading.style.display = "flex";
    }

    function showError(message) {
      if (viewerLoading) viewerLoading.style.display = "none";
      if (viewerPre) {
        viewerPre.style.display = "block";
        viewerPre.textContent = message;
      }
    }

    async function openFromUrl(file, url, context) {
      prepare(file, context);
      try {
        const res = await fetch(url);
        const data = await res.json();
        if (data.error) {
          showError("Error: " + data.error);
          return;
        }
        if (viewerLoading) viewerLoading.style.display = "none";
        if (viewerSize) viewerSize.textContent = formatBytes((data.content || "").length);
        setContent(data.content || "");
      } catch (err) {
        showError("Network error: " + err.message);
      }
    }

    function openJsonViewer(file) {
      const folder = getCurrentFolder();
      if (!folder) return;
      const url = "/api/file_content?folder=" + encodeURIComponent(folder) + "&file=" + encodeURIComponent(file);
      return openFromUrl(file, url, { file, folder });
    }

    function openJsonViewerRoot(file) {
      const url = "/api/file_content_root?file=" + encodeURIComponent(file);
      return openFromUrl(file, url, { file });
    }

    async function save() {
      if (!state.currentJsonContext || !state.currentJsonContext.file || !viewerSaveBtn) return;
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
      if (state.currentJsonContext.folder) payload.folder = state.currentJsonContext.folder;

      try {
        viewerSaveBtn.disabled = true;
        const res = await fetch("/api/save_json", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        });
        const data = await res.json();
        if (!res.ok || data.error) throw new Error(data.error || "Failed to save file");
        const orig = viewerSaveBtn.innerHTML;
        viewerSaveBtn.innerHTML = "<span class=\"material-symbols-outlined\">check</span><span>Saved</span>";
        setTimeout(() => {
          viewerSaveBtn.innerHTML = orig;
        }, 1200);
        setContent(payload.content);
      } catch (err) {
        alert("Save failed: " + err.message);
      } finally {
        viewerSaveBtn.disabled = false;
      }
    }

    if (viewerCloseBtn) viewerCloseBtn.addEventListener("click", close);
    if (jsonModalBackdrop) jsonModalBackdrop.addEventListener("click", close);
    if (viewerWrapBtn) {
      viewerWrapBtn.addEventListener("click", () => {
        state.wrapEnabled = !state.wrapEnabled;
        if (viewerPre) viewerPre.classList.toggle("wrap", state.wrapEnabled);
        viewerWrapBtn.classList.toggle("active", state.wrapEnabled);
      });
    }
    if (viewerCopyBtn) {
      viewerCopyBtn.addEventListener("click", async () => {
        try {
          const content = (viewerPre && viewerPre.textContent) || (viewerTextarea && viewerTextarea.value) || "";
          await navigator.clipboard.writeText(content);
          const orig = viewerCopyBtn.innerHTML;
          viewerCopyBtn.innerHTML = "<span class=\"material-symbols-outlined\">check</span><span>Copied!</span>";
          setTimeout(() => {
            viewerCopyBtn.innerHTML = orig;
          }, 1200);
        } catch (_) { }
      });
    }
    if (viewerSaveBtn) viewerSaveBtn.addEventListener("click", save);

    return {
      close,
      formatBytes,
      openJsonViewer,
      openJsonViewerRoot,
      save,
      setContent,
    };
  }

  window.JsonViewer = {
    create: createJsonViewer,
    formatBytes,
  };
})();
