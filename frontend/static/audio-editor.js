/* Minimal audio trim editor for the Curate (Explorer) view. */
window.AudioEditor = (function () {
  const MIN_SELECTION_SEC = 0.05;

  const els = {
    modal: null,
    closeBtn: null,
    meta: null,
    canvas: null,
    waveformWrap: null,
    waveformLoading: null,
    region: null,
    handleStart: null,
    handleEnd: null,
    playhead: null,
    startLabel: null,
    endLabel: null,
    selectionLabel: null,
    playBtn: null,
    playIcon: null,
    playText: null,
    resetBtn: null,
    applyBtn: null,
    speedGroup: null,
    status: null,
  };

  let ctx2d = null;
  let spectrogramCtx2d = null;
  let audioCtx = null;
  let audioBuffer = null;
  let peaks = null;
  let htmlAudio = null;
  let startSec = 0;
  let endSec = 0;
  let duration = 0;
  let playing = false;
  let rafId = null;
  let dragHandle = null; // "start" | "end" — only set when dragging a handle
  let current = null; // { folder, index, audioRel, audioUrl, onApplied }
  let applying = false;
  let playbackRate = 1;

  function qs(id) {
    return document.getElementById(id);
  }

  function ensureElements() {
    if (els.modal) return;
    els.modal = qs("audio-editor-modal");
    els.closeBtn = qs("audio-editor-close");
    els.meta = qs("audio-editor-meta");
    els.canvas = qs("audio-editor-waveform");
    els.waveformWrap = els.canvas ? els.canvas.parentElement : null;
    els.waveformLoading = qs("audio-editor-waveform-loading");
    els.region = qs("audio-editor-region");
    els.handleStart = qs("audio-editor-handle-start");
    els.handleEnd = qs("audio-editor-handle-end");
    els.playhead = qs("audio-editor-playhead");
    els.startLabel = qs("audio-editor-start-label");
    els.endLabel = qs("audio-editor-end-label");
    els.selectionLabel = qs("audio-editor-selection-label");
    els.playBtn = qs("audio-editor-play-btn");
    els.playIcon = qs("audio-editor-play-icon");
    els.playText = qs("audio-editor-play-text");
    els.resetBtn = qs("audio-editor-reset-btn");
    els.applyBtn = qs("audio-editor-apply-btn");
    els.speedGroup = qs("audio-editor-speed-group");
    els.status = qs("audio-editor-status");
    els.spectrogram = qs("audio-editor-spectrogram");
    if (els.canvas) ctx2d = els.canvas.getContext("2d");
    if (els.spectrogram) spectrogramCtx2d = els.spectrogram.getContext("2d");
  }

  function setWaveformLoading(isLoading) {
    if (els.waveformWrap) {
      els.waveformWrap.classList.toggle("is-loading", !!isLoading);
    }
    if (els.waveformLoading) {
      if (isLoading) els.waveformLoading.removeAttribute("hidden");
      else els.waveformLoading.setAttribute("hidden", "");
    }
  }

  function bustAudioUrl(url) {
    if (!url) return url;
    const cleaned = url.replace(/([?&])t=\d+/g, "$1").replace(/[?&]$/, "");
    return cleaned + (cleaned.includes("?") ? "&" : "?") + "t=" + Date.now();
  }

  function setControlsEnabled(enabled) {
    if (els.applyBtn) els.applyBtn.disabled = !enabled;
    if (els.playBtn) els.playBtn.disabled = !enabled;
    if (els.resetBtn) els.resetBtn.disabled = !enabled;
  }

  async function loadWaveform(audioUrl) {
    await ensureAudioContext();
    const res = await fetch(audioUrl);
    if (!res.ok) throw new Error("Failed to load audio");
    const arrayBuffer = await res.arrayBuffer();
    audioBuffer = await audioCtx.decodeAudioData(arrayBuffer.slice(0));
    duration = audioBuffer.duration || 0;
    startSec = 0;
    endSec = duration;
    peaks = computePeaks(
      audioBuffer,
      Math.max(120, Math.floor((els.canvas?.clientWidth || 600) / 2))
    );
    resizeCanvas();
    updateOverlay();
    drawSpectrogram(audioBuffer);
  }

  function formatTime(sec) {
    if (!Number.isFinite(sec)) return "0.00s";
    return sec.toFixed(2) + "s";
  }

  function setStatus(message, kind) {
    if (!els.status) return;
    els.status.textContent = message || "";
    els.status.classList.remove("error", "success");
    if (kind) els.status.classList.add(kind);
  }

  function setPlayingUi(isPlaying) {
    playing = isPlaying;
    if (els.playIcon) els.playIcon.textContent = isPlaying ? "pause" : "play_arrow";
    if (els.playText) els.playText.textContent = isPlaying ? "Pause" : "Play";
  }

  function clampSelection() {
    if (!Number.isFinite(duration) || duration <= 0) {
      startSec = 0;
      endSec = 0;
      return;
    }
    startSec = Math.max(0, Math.min(startSec, duration));
    endSec = Math.max(0, Math.min(endSec, duration));
    if (endSec - startSec < MIN_SELECTION_SEC) {
      if (dragHandle === "end" || endSec >= duration) {
        startSec = Math.max(0, endSec - MIN_SELECTION_SEC);
      } else {
        endSec = Math.min(duration, startSec + MIN_SELECTION_SEC);
      }
    }
  }

  function updateOverlay() {
    if (!duration || !els.region) return;
    const leftPct = (startSec / duration) * 100;
    const rightPct = (endSec / duration) * 100;
    els.region.style.left = leftPct + "%";
    els.region.style.width = Math.max(0, rightPct - leftPct) + "%";
    els.handleStart.style.left = leftPct + "%";
    els.handleEnd.style.left = rightPct + "%";
    els.startLabel.textContent = formatTime(startSec);
    els.endLabel.textContent = formatTime(endSec);
    els.selectionLabel.textContent = "Selection: " + formatTime(Math.max(0, endSec - startSec));
  }

  function setPlayhead(sec) {
    if (!els.playhead || !duration) return;
    const pct = Math.max(0, Math.min(1, sec / duration)) * 100;
    els.playhead.style.left = pct + "%";
    els.playhead.classList.add("visible");
    els.playhead.dataset.sec = sec;
  }

  function hidePlayhead() {
    if (!els.playhead) return;
    els.playhead.classList.remove("visible");
    delete els.playhead.dataset.sec;
  }

  function resizeCanvas() {
    if (!els.canvas || !els.canvas.parentElement) return;
    const wrap = els.canvas.parentElement;
    const dpr = window.devicePixelRatio || 1;
    const width = Math.max(1, Math.floor(wrap.clientWidth));
    els.canvas.width = Math.floor(width * dpr);
    els.canvas.height = Math.floor(140 * dpr);
    els.canvas.style.width = width + "px";
    els.canvas.style.height = "140px";
    if (ctx2d) ctx2d.setTransform(dpr, 0, 0, dpr, 0, 0);
    drawWaveform();

    if (els.spectrogram) {
      els.spectrogram.width = Math.floor(width * dpr);
      els.spectrogram.height = Math.floor(250 * dpr);
      els.spectrogram.style.width = width + "px";
      els.spectrogram.style.height = "250px";
      if (spectrogramCtx2d) spectrogramCtx2d.setTransform(dpr, 0, 0, dpr, 0, 0);
      if (audioBuffer) drawSpectrogram(audioBuffer);
    }
  }

  async function drawSpectrogram(buffer) {
    if (!els.spectrogram || !spectrogramCtx2d || !buffer) return;
    const width = els.spectrogram.clientWidth || 1;
    const height = els.spectrogram.clientHeight || 1;
    spectrogramCtx2d.clearRect(0, 0, width, height);

    const length = buffer.length;
    const sampleRate = buffer.sampleRate;
    const offlineCtx = new (window.OfflineAudioContext || window.webkitOfflineAudioContext)(1, length, sampleRate);

    const source = offlineCtx.createBufferSource();
    source.buffer = buffer;

    const analyser = offlineCtx.createAnalyser();
    analyser.fftSize = 1024;
    analyser.smoothingTimeConstant = 0;

    source.connect(analyser);
    analyser.connect(offlineCtx.destination);

    source.start(0);

    const freqs = [];
    const sliceCount = Math.min(width, 400);
    const step = buffer.duration / sliceCount;
    
    // Web Audio API spec allows scheduling suspends.
    for (let i = 1; i < sliceCount; i++) {
      const time = i * step;
      if (time < buffer.duration) {
        try {
          offlineCtx.suspend(time).then(() => {
            const arr = new Uint8Array(analyser.frequencyBinCount);
            analyser.getByteFrequencyData(arr);
            freqs.push(arr);
            offlineCtx.resume();
          }).catch(() => {});
        } catch (e) {
          // Ignore scheduling errors
        }
      }
    }

    try {
      await offlineCtx.startRendering();
    } catch (e) {
      /* ignore */
    }

    if (freqs.length === 0) return;

    const binCount = analyser.frequencyBinCount;
    const sliceWidth = width / freqs.length;

    for (let i = 0; i < freqs.length; i++) {
      const x = i * sliceWidth;
      const data = freqs[i];
      for (let j = 0; j < binCount; j++) {
        const val = data[j];
        if (val === 0) continue;
        const y = height - (j / binCount) * height;
        const h = Math.ceil(height / binCount);
        spectrogramCtx2d.fillStyle = `hsla(${240 - (val / 255) * 240}, 100%, 50%, ${val / 255})`;
        spectrogramCtx2d.fillRect(x, y, Math.ceil(sliceWidth), h);
      }
    }
  }

  function computePeaks(buffer, buckets) {
    const channel = buffer.getChannelData(0);
    const samplesPerBucket = Math.max(1, Math.floor(channel.length / buckets));
    const result = new Float32Array(buckets);
    for (let i = 0; i < buckets; i++) {
      const start = i * samplesPerBucket;
      const end = Math.min(channel.length, start + samplesPerBucket);
      let peak = 0;
      for (let j = start; j < end; j++) {
        const v = Math.abs(channel[j]);
        if (v > peak) peak = v;
      }
      result[i] = peak;
    }
    return result;
  }

  function drawWaveform() {
    if (!els.canvas || !ctx2d) return;
    const width = els.canvas.clientWidth || 1;
    const height = els.canvas.clientHeight || 1;
    ctx2d.clearRect(0, 0, width, height);

    const mid = height / 2;
    ctx2d.strokeStyle = "rgba(148, 163, 184, 0.35)";
    ctx2d.beginPath();
    ctx2d.moveTo(0, mid);
    ctx2d.lineTo(width, mid);
    ctx2d.stroke();

    if (!peaks || !peaks.length) return;

    let maxPeak = 0;
    for (let i = 0; i < peaks.length; i++) {
      if (peaks[i] > maxPeak) maxPeak = peaks[i];
    }
    // Normalize to fill most of the canvas so quiet clips stay readable.
    const targetHeight = height * 0.95;
    const scale = maxPeak > 0 ? targetHeight / maxPeak : 0;

    const barWidth = width / peaks.length;
    ctx2d.fillStyle = "rgba(148, 163, 184, 0.85)";
    for (let i = 0; i < peaks.length; i++) {
      const amp = Math.min(targetHeight, peaks[i] * scale);
      const x = i * barWidth;
      const y = mid - amp / 2;
      ctx2d.fillRect(x, y, Math.max(1, barWidth * 0.85), Math.max(1, amp));
    }
  }

  function stopPlayback() {
    if (rafId) {
      cancelAnimationFrame(rafId);
      rafId = null;
    }
    if (htmlAudio) {
      htmlAudio.pause();
    }
    setPlayingUi(false);
  }

  function tickPlayhead() {
    if (!playing || !htmlAudio) return;
    const pos = htmlAudio.currentTime;
    if (pos >= endSec) {
      stopPlayback();
      hidePlayhead();
      return;
    }
    setPlayhead(pos);
    rafId = requestAnimationFrame(tickPlayhead);
  }

  async function ensureAudioContext() {
    if (!audioCtx) {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      audioCtx = new Ctx();
    }
    if (audioCtx.state === "suspended") {
      await audioCtx.resume();
    }
  }

  async function togglePlay() {
    if (!audioBuffer || !duration) return;
    if (playing) {
      stopPlayback();
      return;
    }

    let offset = startSec;
    if (els.playhead && els.playhead.classList.contains("visible")) {
      const pSec = parseFloat(els.playhead.dataset.sec);
      if (!isNaN(pSec)) {
        offset = pSec;
        if (offset >= endSec) {
          offset = startSec;
        }
      }
    }

    stopPlayback();
    
    if (!htmlAudio) {
      htmlAudio = new Audio(current.audioUrl);
    }
    
    htmlAudio.playbackRate = playbackRate;
    htmlAudio.currentTime = offset;
    htmlAudio.onended = () => {
      stopPlayback();
      hidePlayhead();
    };

    try {
      await htmlAudio.play();
      setPlayingUi(true);
      setPlayhead(offset);
      rafId = requestAnimationFrame(tickPlayhead);
    } catch (err) {
      throw err;
    }
  }

  /** Seek playhead to a given time (does not change trim handles). */
  function seekTo(sec) {
    if (!duration) return;
    const t = Math.max(0, Math.min(duration, sec));
    setPlayhead(t);
    // If currently playing, restart from the new position.
    if (playing) {
      stopPlayback();
      startSec = Math.min(startSec, t);
      endSec = Math.max(endSec, t + MIN_SELECTION_SEC);
      togglePlay().catch(() => {});
    }
  }

  function resetHandles() {
    startSec = 0;
    endSec = duration;
    clampSelection();
    updateOverlay();
    stopPlayback();
  }

  function pointerToTime(clientX) {
    const rect = els.canvas.getBoundingClientRect();
    if (!rect.width || !duration) return 0;
    const ratio = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
    return ratio * duration;
  }

  // ── Handle dragging (only triggered from the handle elements) ──────────────

  function onHandlePointerDown(e) {
    if (!duration || applying) return;
    const handle = e.currentTarget?.dataset?.handle;
    if (!handle) return;
    dragHandle = handle;
    e.preventDefault();
    e.currentTarget.setPointerCapture?.(e.pointerId);
  }

  function onHandlePointerMove(e) {
    if (!dragHandle || !duration) return;
    const t = pointerToTime(e.clientX);
    if (dragHandle === "start") startSec = Math.min(t, endSec - MIN_SELECTION_SEC);
    else endSec = Math.max(t, startSec + MIN_SELECTION_SEC);
    clampSelection();
    updateOverlay();
  }

  function onHandlePointerUp(e) {
    if (!dragHandle) return;
    try {
      e.currentTarget.releasePointerCapture?.(e.pointerId);
    } catch (_) {
      /* ignore */
    }
    dragHandle = null;
  }

  // ── Canvas click → seek playhead ──────────────────────────────────────────

  function onCanvasClick(e) {
    if (!duration || applying) return;
    // Ignore if we just finished a drag (pointer moved significantly)
    const t = pointerToTime(e.clientX);
    seekTo(t);
  }

  // ── Speed buttons ─────────────────────────────────────────────────────────

  function setPlaybackRate(rate) {
    playbackRate = rate;
    if (els.speedGroup) {
      els.speedGroup.querySelectorAll(".audio-editor-speed-btn").forEach((btn) => {
        btn.classList.toggle("active", Number(btn.dataset.rate) === rate);
      });
    }
    // Apply live if currently playing
    if (playing && htmlAudio) {
      htmlAudio.playbackRate = rate;
    }
  }

  async function applyTrim() {
    if (!current || applying) return;
    if (!duration || endSec - startSec < MIN_SELECTION_SEC) {
      setStatus("Selection is too short.", "error");
      return;
    }
    const nearlyFull =
      startSec <= 0.001 && Math.abs(endSec - duration) <= 0.001;
    if (nearlyFull) {
      setStatus("Move the trim lines before applying.", "error");
      return;
    }
    if (!confirm("Apply trim and overwrite this audio file? This cannot be undone.")) {
      return;
    }

    applying = true;
    stopPlayback();
    setControlsEnabled(false);
    setWaveformLoading(true);
    setStatus("Saving trim…");

    try {
      const res = await fetch("/api/trim_audio", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          folder: current.folder,
          index: current.index,
          start_sec: startSec,
          end_sec: endSec,
        }),
      });
      const data = await res.json();
      if (!res.ok || !data.ok) {
        throw new Error(data.error || "Trim failed");
      }

      if (typeof current.onApplied === "function") {
        await current.onApplied(data);
      }

      current.audioUrl = bustAudioUrl(current.audioUrl);
      setStatus("Reloading waveform…");
      audioBuffer = null;
      peaks = null;
      if (htmlAudio) {
        htmlAudio.pause();
        htmlAudio.removeAttribute('src');
        htmlAudio.load();
        htmlAudio = null;
      }
      await loadWaveform(current.audioUrl);
      setStatus("Trim applied. Drag the blue lines to trim further.", "success");
      setControlsEnabled(true);
    } catch (err) {
      setStatus(err.message || String(err), "error");
      setControlsEnabled(!!audioBuffer);
    } finally {
      applying = false;
      setWaveformLoading(false);
    }
  }

  function bindEvents() {
    ensureElements();
    if (!els.modal || els.modal.dataset.bound === "1") return;
    els.modal.dataset.bound = "1";

    els.closeBtn?.addEventListener("click", close);
    els.modal.addEventListener("click", (e) => {
      if (e.target === els.modal) close();
    });
    els.playBtn?.addEventListener("click", () => {
      togglePlay().catch((err) => setStatus(err.message || String(err), "error"));
    });
    els.resetBtn?.addEventListener("click", resetHandles);
    els.applyBtn?.addEventListener("click", () => {
      applyTrim().catch((err) => setStatus(err.message || String(err), "error"));
    });

    // Speed buttons
    if (els.speedGroup) {
      els.speedGroup.addEventListener("click", (e) => {
        const btn = e.target.closest(".audio-editor-speed-btn");
        if (!btn) return;
        const rate = Number(btn.dataset.rate);
        if (rate > 0) setPlaybackRate(rate);
      });
    }

    // Handle elements: pointer drag only
    [els.handleStart, els.handleEnd].forEach((node) => {
      if (!node) return;
      node.addEventListener("pointerdown", onHandlePointerDown);
      node.addEventListener("pointermove", onHandlePointerMove);
      node.addEventListener("pointerup", onHandlePointerUp);
      node.addEventListener("pointercancel", onHandlePointerUp);
    });

    // Canvas: click to seek, no trim handle dragging
    if (els.canvas) {
      els.canvas.addEventListener("click", onCanvasClick);
    }

    document.addEventListener("keydown", (e) => {
      if (!els.modal || els.modal.style.display !== "flex") return;
      if (e.key === "Escape") close();
      if (e.key === " " && e.target === document.body) {
        e.preventDefault();
        togglePlay().catch(() => {});
      }
    });

    window.addEventListener("resize", () => {
      if (els.modal && els.modal.style.display === "flex") resizeCanvas();
    });
  }

  async function open({ folder, index, audioRel, audioUrl, onApplied }) {
    ensureElements();
    bindEvents();
    if (!els.modal) return;

    current = { folder, index, audioRel, audioUrl, onApplied };
    stopPlayback();
    audioBuffer = null;
    peaks = null;
    if (htmlAudio) {
      htmlAudio.pause();
      htmlAudio.removeAttribute('src');
      htmlAudio.load();
      htmlAudio = null;
    }
    startSec = 0;
    endSec = 0;
    duration = 0;
    setStatus("Loading waveform…");
    setWaveformLoading(true);
    if (els.meta) els.meta.textContent = audioRel || "";
    setControlsEnabled(false);

    // Reset speed to 1× on each open
    setPlaybackRate(1);

    els.modal.style.display = "flex";
    els.modal.setAttribute("aria-hidden", "false");
    resizeCanvas();
    updateOverlay();

    try {
      await loadWaveform(audioUrl);
      setStatus("Click the waveform to seek · Drag the blue handles to set the trim range.");
      setControlsEnabled(true);
    } catch (err) {
      setStatus(err.message || String(err), "error");
    } finally {
      setWaveformLoading(false);
    }
  }

  function close() {
    ensureElements();
    if (applying) return;
    stopPlayback();
    if (!els.modal) return;
    els.modal.style.display = "none";
    els.modal.setAttribute("aria-hidden", "true");
    current = null;
    audioBuffer = null;
    peaks = null;
    if (htmlAudio) {
      htmlAudio.pause();
      htmlAudio.removeAttribute('src');
      htmlAudio.load();
      htmlAudio = null;
    }
    setWaveformLoading(false);
    setStatus("");
  }

  return { open, close };
})();
