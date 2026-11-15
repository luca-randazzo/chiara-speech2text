/* Shared explorer entry list rendering for Explorer and Analyze views. */
window.ExplorerEntries = (function () {
  "use strict";

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
      entry.audio_data, entry.audio_rel, entry.audio_relpath, entry.audio_path,
      entry.audio_file, entry.wav, entry.file, entry.filename, entry.path,
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

  function flashUpdate(el) {
    if (!el) return;
    el.classList.add("update-glow");
    setTimeout(() => el.classList.remove("update-glow"), 800);
  }

  async function saveEntryField(ctx, index, updates, el, callback) {
    try {
      const res = await fetch("/api/entry", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ folder: ctx.folder, index, updates }),
      });
      const data = await res.json();
      if (!data.ok) {
        alert("Save failed: " + (data.error || "unknown error"));
        return false;
      }
      if (el) flashUpdate(el);
      if (typeof callback === "function") callback();
      if (typeof ctx.onAfterChange === "function") ctx.onAfterChange("save", index, updates);
      return true;
    } catch (err) {
      alert("Save failed: " + err.message);
      return false;
    }
  }

  async function generateEntry(ctx, index) {
    if (ctx.genFuncs && ctx.genFuncs[index]) ctx.genFuncs[index](true);
    try {
      const res = await fetch("/api/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ folder: ctx.folder, index }),
      });
      const data = await res.json();
      if (!data.ok) {
        alert("Generate failed: " + (data.error || "unknown error"));
        if (ctx.genFuncs && ctx.genFuncs[index]) ctx.genFuncs[index](false);
        return false;
      }
      ctx.entries[index] = data.entry;
      const oldRow = ctx.listEl && ctx.listEl.querySelector('[data-entry-index="' + index + '"]');
      if (oldRow) {
        const newRow = renderEntryRow(data.entry, index, ctx);
        const oldAudio = oldRow.querySelector("audio[data-explorer-audio]");
        const newAudio = newRow.querySelector("audio[data-explorer-audio]");
        if (oldAudio && newAudio) {
          newAudio.replaceWith(oldAudio);
        }
        ctx.listEl.replaceChild(newRow, oldRow);
        applyPlaybackRate(ctx.listEl, ctx.playbackRate);
          const generatedTextarea = newRow.querySelector(
            ".temporary-transcript-section textarea",
          );
          setTimeout(() => {
            (generatedTextarea || newRow).scrollIntoView({
              behavior: "smooth",
              block: "center",
            });
          }, 300);
        }
      if (typeof ctx.onAfterChange === "function") ctx.onAfterChange("generate", index, data.entry);
      return true;
    } catch (err) {
      alert("Generate failed: " + err.message);
      return false;
    } finally {
      if (ctx.genFuncs && ctx.genFuncs[index]) ctx.genFuncs[index](false);
    }
  }

  function applyPlaybackRate(container, rate) {
    if (!container) return;
    container.querySelectorAll("audio[data-explorer-audio]").forEach((audio) => {
      audio.playbackRate = rate;
    });
  }

  async function animateDeleteRow(rowEl) {
    if (!rowEl) return;
    rowEl.classList.add("deleting");
    await new Promise((resolve) => setTimeout(resolve, 320));
    rowEl.remove();
  }

  async function defaultDelete(ctx, index, rowEl) {
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
    ctx.entries.splice(index, 1);
    await animateDeleteRow(rowEl);
    if (typeof ctx.onAfterChange === "function") ctx.onAfterChange("delete", index);
    return true;
  }

  function renderInlineSpellcheck(text, misspellings, container, entryIndex, textareaElement, ctx) {
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
        showInlineContextMenu(e, seg.word, seg.suggestions, entryIndex, textareaElement, ctx);
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

  function showInlineContextMenu(event, word, suggestions, entryIndex, textareaElement, ctx) {
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
        applyInlineCorrection(word, suggestion, entryIndex, textareaElement, ctx);
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

  function applyInlineCorrection(oldWord, newWord, entryIndex, textareaElement, ctx) {
  // Replace word in textarea
  const regex = new RegExp("\\b" + oldWord + "\\b", "gi");
  const newText = textareaElement.value.replace(regex, newWord);

  if (newText !== textareaElement.value) {
    textareaElement.value = newText;
    saveEntryField(ctx, entryIndex, { reviewer_transcript_corrected: newText }, textareaElement, () => {
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


  function renderEntryRow(entry, index, ctx) {
  const row = document.createElement("div");
  row.className = "entry-row";
  row.dataset.entryKey = entryKey(entry, index);
  row.dataset.entryIndex = String(index);

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
    if (!confirm("Delete this entry and its audio file? This cannot be undone.")) return;
    deleteBtn.disabled = true;
    deleteBtn.classList.add("deleting");
    try {
      const handler = ctx.onDelete || defaultDelete;
      const ok = await handler(ctx, index, row, deleteBtn);
      if (!ok) {
        deleteBtn.disabled = false;
        deleteBtn.classList.remove("deleting");
      }
    } catch (err) {
      alert("Delete failed: " + err.message);
      deleteBtn.disabled = false;
      deleteBtn.classList.remove("deleting");
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
    audio.src = "/api/media?folder=" + encodeURIComponent(ctx.folder) + "&rel=" + encodeURIComponent(audioRel);
    audio.playbackRate = ctx.playbackRate;
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
  topActions.appendChild(deleteBtn);

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
      ctx.genFuncs[index] = setGeneratePending;

      gen.addEventListener("click", () => {
        generateEntry(ctx, index);
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
      ta.addEventListener("change", () => {
        saveEntryField(ctx, index, { reviewer_transcript_corrected: ta.value }, ta);
      });

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
            ctx,
            index,
            {
              reviewer_transcript_corrected: acceptedText,
              reviewer_is_reviewed: false,
            },
            acceptBtn,
            () => {
              ctx.entries[index].reviewer_transcript_corrected = acceptedText;
              ctx.entries[index].reviewer_is_reviewed = false;
              delete ctx.entries[index].generated_transcript;
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
              generatedWrap.remove();
              autoSizeTranscript(ta);
              setTimeout(() => {
                ta.scrollIntoView({ behavior: "smooth", block: "center" });
              }, 300);
            },
          );
          acceptBtn.disabled = !saved;
        });

        const rejectBtn = document.createElement("button");
        rejectBtn.className = "btn-small";
        rejectBtn.classList.add("btn-reject");
        rejectBtn.textContent = "Reject";
        rejectBtn.addEventListener("click", () => {
          delete ctx.entries[index].generated_transcript;
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
      spellcheckBtn.className = "btn-small";
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
              renderInlineSpellcheck(transcript, misspellings, newDisplay, index, ta, ctx);
            } else {
              spellcheckDisplay.style.display = "block";
              renderInlineSpellcheck(transcript, misspellings, spellcheckDisplay, index, ta, ctx);
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
      cb.className = "checkbox";
      cb.style.transform = "scale(1.2)";
      cb.checked = Boolean(entry.reviewer_is_reviewed);
      cb.title = "reviewer_is_reviewed";
      cb.addEventListener("change", () => {
        saveEntryField(ctx, index, { reviewer_is_reviewed: cb.checked }, cb);
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


  function renderList(container, ctx, indices) {
    container.innerHTML = "";
    ctx.genFuncs = ctx.genFuncs || {};
    ctx.listEl = container;
    const idxs = Array.isArray(indices)
      ? indices.slice()
      : ctx.entries.map((_, i) => i);
    idxs.forEach((index) => {
      const entry = ctx.entries[index];
      if (!entry) return;
      container.appendChild(renderEntryRow(entry, index, ctx));
    });
    applyPlaybackRate(container, ctx.playbackRate || 1.0);
  }

  return {
    renderEntryRow,
    renderList,
    applyPlaybackRate,
    generateEntry,
    saveEntryField,
    renderInlineSpellcheck,
    entryKey,
  };
})();
