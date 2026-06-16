/*
 * This file is part of Whisper To Input, see <https://github.com/j3soon/whisper-to-input>.
 *
 * Copyright (c) 2023-2024 Yan-Bin Diau, Johnson Sun
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful, but
 * WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with this program. If not, see <https://www.gnu.org/licenses/>.
 */

package com.example.whispertoinput.keyboard

import android.animation.ValueAnimator
import android.animation.ArgbEvaluator
import android.content.ClipData
import android.content.ClipDescription
import android.graphics.Color
import android.graphics.drawable.ColorDrawable
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.graphics.Point
import android.speech.tts.TextToSpeech
import android.speech.tts.UtteranceProgressListener
import android.text.Spannable
import android.text.SpannableString
import android.text.style.BackgroundColorSpan
import android.graphics.Canvas
import android.graphics.Paint
import android.graphics.RectF
import android.text.style.ReplacementSpan
import android.util.Log
import android.view.DragEvent
import android.view.Gravity
import android.view.LayoutInflater
import android.view.MotionEvent
import android.view.View
import android.view.ViewGroup
import android.widget.GridLayout
import android.widget.ImageButton
import android.widget.ImageView
import android.widget.LinearLayout
import android.widget.PopupWindow
import android.widget.ProgressBar
import android.widget.TextView
import androidx.constraintlayout.widget.ConstraintLayout
import androidx.core.content.ContextCompat
import androidx.core.math.MathUtils
import com.example.whispertoinput.R
import java.util.Locale
import kotlin.math.log10
import kotlin.math.pow
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import android.text.SpannableStringBuilder
import android.text.Spanned
import androidx.datastore.preferences.core.edit
import androidx.datastore.preferences.core.Preferences
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.map
import com.example.whispertoinput.LLM_MODEL_ENDPOINT
import com.example.whispertoinput.PROMPT_FOR_LLM
import com.example.whispertoinput.RECENT_EMOJIS
import com.example.whispertoinput.dataStore
import org.json.JSONArray
import org.json.JSONObject
import okhttp3.MediaType.Companion.toMediaTypeOrNull
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import java.util.concurrent.TimeUnit

/* Main‑speech helper ---------------------------------- */
private val MAIN_WORD_UTTERANCE_PREFIX = "WORD_"

private const val TAG = "WhisperKeyboard"
private const val AMPLITUDE_CLAMP_MIN: Int = 10
private const val AMPLITUDE_CLAMP_MAX: Int = 25000
private const val LOG_10_10: Float = 1.0F
private const val LOG_10_25000: Float = 4.398F
private const val AMPLITUDE_ANIMATION_DURATION: Long = 500
// Use .toInt() to avoid Long vs Int compilation error for hex literals > 0x7FFFFFFF
private val HIGHLIGHT_COLOR = 0x80FAFA33.toInt() // playful_yellow (#FAFA33) with 50% alpha
private val CHIP_BACKGROUND_COLOR = 0x33FFFFFF // Subtle white/grey for ovals
private val CHIP_PADDING_HORIZONTAL = 24f
private val CHIP_PADDING_VERTICAL = 8f
private val CHIP_CORNER_RADIUS = 100f // Large radius for oval shape

private var playAllButton: ImageButton? = null

/**
 * Custom span to draw an oval background around words.
 */
class RoundedBackgroundSpan(
    private val backgroundColor: Int,
    private val textColor: Int = Color.WHITE
) : ReplacementSpan() {

    override fun getSize(
        paint: Paint, text: CharSequence, start: Int, end: Int, fm: Paint.FontMetricsInt?
    ): Int {
        if (fm != null) {
            val pfm = paint.fontMetricsInt
            fm.ascent = pfm.ascent - CHIP_PADDING_VERTICAL.toInt()
            fm.descent = pfm.descent + CHIP_PADDING_VERTICAL.toInt()
            fm.top = fm.ascent
            fm.bottom = fm.descent
        }
        return (paint.measureText(text, start, end) + 2 * CHIP_PADDING_HORIZONTAL).toInt()
    }

    override fun draw(
        canvas: Canvas, text: CharSequence, start: Int, end: Int,
        x: Float, top: Int, y: Int, bottom: Int, paint: Paint
    ) {
        val width = paint.measureText(text, start, end)
        val rect = RectF(
            x,
            y + paint.fontMetrics.ascent - CHIP_PADDING_VERTICAL,
            x + width + 2 * CHIP_PADDING_HORIZONTAL,
            y + paint.fontMetrics.descent + CHIP_PADDING_VERTICAL
        )

        // Draw background
        paint.color = backgroundColor
        canvas.drawRoundRect(rect, CHIP_CORNER_RADIUS, CHIP_CORNER_RADIUS, paint)

        // Draw text
        paint.color = textColor
        canvas.drawText(text, start, end, x + CHIP_PADDING_HORIZONTAL, y.toFloat(), paint)
    }
}

class WhisperKeyboard : TextToSpeech.OnInitListener {
    enum class KeyboardStatus { Idle, Recording, Transcribing }

    private var tts: TextToSpeech? = null
    private val keyboardScope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
    private var suggestionJob: Job? = null
    private val handler = Handler(Looper.getMainLooper())
    private val INSTANCE_ID = System.identityHashCode(this).toString().takeLast(4)

    /**
     * Permanent, process-level singleton for surgical substitution.
     * Guarantees state survives even if Keyboard instance is recreated.
     */
    object SurgicalState {
        @Volatile var isPerformingSubstitution: Boolean = false
        @Volatile var targetRange: Pair<Int, Int>? = null
    }

    companion object {
        @Volatile var mainSpokenText: String = ""
        @Volatile var wordBoundaries: List<Pair<Int, Int>> = emptyList()
    }

    // Simple Italian vocabulary for mock suggestions when SpellChecker fails
    private val mockVocabulary = listOf(
        "casa", "pane", "mare", "sole", "libro", "cane", "gatto", "scuola", "lavoro", "tempo",
        "amore", "vita", "mondo", "piazza", "strada", "città", "mangiare", "parlare", "vedere", "sentire",
        "bello", "buono", "grande", "piccolo", "nuovo", "vecchio", "primo", "ultimo", "italiano", "chiara"
    )
    private var vocabulary: List<String> = mockVocabulary

    fun setVocabulary(words: List<String>) {
        vocabulary = words
    }

    private fun levenshteinDistance(s1: String, s2: String): Int {
        if (s1 == s2) return 0
        if (s1.isEmpty()) return s2.length
        if (s2.isEmpty()) return s1.length

        val n = s2.length
        var v0 = IntArray(n + 1)
        var v1 = IntArray(n + 1)

        for (i in 0..n) v0[i] = i

        for (i in s1.indices) {
            v1[0] = i + 1
            for (j in s2.indices) {
                val cost = if (s1[i] == s2[j]) 0 else 1
                v1[j + 1] = minOf(v1[j] + 1, v0[j + 1] + 1, v0[j] + cost)
            }
            val temp = v0
            v0 = v1
            v1 = temp
        }
        return v0[n]
    }

    private fun computeWordBoundaries(text: String) {
        val pairs = mutableListOf<Pair<Int, Int>>()
        // Use uppercase consistency for index matching
        val upperText = text.uppercase(Locale.ROOT)
        var idx = 0
        upperText.split("\\s+".toRegex()).forEach { w ->
            if (w.isNotEmpty()) {
                val start = upperText.indexOf(w, idx)
                if (start != -1) {
                    val end = start + w.length
                    pairs.add(Pair(start, end))
                    idx = end
                }
            }
        }
        wordBoundaries = pairs
    }

    // Whisper.kt – add near the top of Whisper class
    private val suggestionIndices: MutableMap<String, Int> = mutableMapOf()

    // Keyboard event listeners.
    private var onStartRecording: () -> Unit = { }
    private var onCancelRecording: () -> Unit = { }
    private var onStartTranscribing: (attachToEnd: String) -> Unit = { }
    private var onCancelTranscribing: () -> Unit = { }
    private var onButtonBackspace: () -> Unit = { }
    private var onSwitchIme: () -> Unit = { }
    private var onOpenSettings: () -> Unit = { }
    private var onEnter: () -> Unit = { }
    private var onSpaceBar: () -> Unit = { }
    private var onKey: (character: Char) -> Unit = { }
    private var onCheck: (text: String) -> Unit = { }
    private var shouldShowRetry: () -> Boolean = { false }
    private var onPlayClickSound: () -> Unit = { }
    private var onEmoji: (emoji: String) -> Unit = { }

    // Keyboard Status
    private var keyboardStatus: KeyboardStatus = KeyboardStatus.Idle
    private var isCapsLocked: Boolean = true

    // Views
    private var keyboardView: ConstraintLayout? = null
    private var spellCheckedTextView: TextView? = null
    private var ivSpellIcon: ImageView? = null
    private var buttonMic: ImageButton? = null
    private var buttonCancel: ImageButton? = null
    private var buttonRetry: ImageButton? = null
    private var waitingIcon: ProgressBar? = null
    private var progressBarTop: ProgressBar? = null
    private var buttonSettings: ImageButton? = null
    private var micRipples: Array<ImageView> = emptyArray()
    private var btnPlaySpell: ImageButton? = null
    private var btnCheckSpell: ImageButton? = null
    private var btnRobot: ImageButton? = null
    private var btnEmoji: ImageButton? = null
    private var btnEnter: ImageButton? = null
    private var waitingIconLlm: ProgressBar? = null
    private var btnKeyboard: ImageButton? = null
    private var btnDelete: BackspaceButton? = null
    private var btnDeleteAllTranscript: ImageButton? = null
    private var containerStatusMic: LinearLayout? = null
    private var containerStatusList: LinearLayout? = null
    private var containerStatusRobot: LinearLayout? = null
    private var containerStatusTrash: LinearLayout? = null
    private var tvStatusMic: TextView? = null
    private var tvStatusList: TextView? = null
    private var tvStatusRobot: TextView? = null
    private var tvStatusTrash: TextView? = null

    // Suggestion Popup
    private var suggestionPopup: PopupWindow? = null
    private var emojiPopup: PopupWindow? = null
    private var keyboardPopup: PopupWindow? = null
    private var popupBackspaceJob: Job? = null
    private var suggestionItemViews = mutableMapOf<String, View>()
    private var currentHighlightedSuggestionView: View? = null
    private var isSpeakingAllSuggestions = false
    private var currentSuggestions: List<String> = emptyList()
    private var lastSpokenSuggestionIndex: Int = -1
    private var isPaused: Boolean = false
    private var lastIntendedWordIndex: Int = -1
    private var currentHighlightedWordRange: Pair<Int, Int>? = null
    private var isSubstitutingWord: Boolean = false

    // Pulsing Animation for Surgical Drop
    private var pulseAnimator: ValueAnimator? = null
    private var pulsingWordIndex: Int = -1
    private var currentPulseColor: Int = Color.TRANSPARENT


    /**
     * Entry point for NEW transcription results from the ASR engine.
     * Decisions about surgical replacement vs full update happen here.
     * Returns true if the result was consumed (e.g. surgical replacement).
     */
    fun handleTranscriptionResult(text: String?): Boolean {
        val logPrefix = "[$INSTANCE_ID] [TRANS_RESULT]"
        if (text.isNullOrEmpty()) {
            Log.w(TAG, "$logPrefix Result is null/empty")
            reset()
            return false
        }
        updateProgressBar(0) // Reset progress bar when result is received

        val isSurgical = SurgicalState.isPerformingSubstitution
        val range = SurgicalState.targetRange
        Log.d(TAG, "$logPrefix text='$text', isSurgical=$isSurgical, range=$range")
        
        if (isSurgical) {
            Log.d(TAG, "$logPrefix !! SURGICAL MODE !!")
            SurgicalState.isPerformingSubstitution = false
            SurgicalState.targetRange = null
            stopPulsingHighlight()
            substituteWord(text, range)
            return true
        } else {
            Log.d(TAG, "$logPrefix !! FULL MODE !!")
            appendTranscriptionText(text)
            return false
        }
    }

    private fun appendTranscriptionText(text: String) {
        val incoming = text.trim()
        if (incoming.isEmpty()) return

        val combinedText = if (mainSpokenText.isBlank()) {
            incoming
        } else {
            "${mainSpokenText.trimEnd()} $incoming"
        }
        setSpellCheckedText(combinedText)
    }

    fun setSpellCheckedText(text: String) {
        val uppercaseText = text.uppercase(Locale.ROOT)
        Log.d(TAG, "[$INSTANCE_ID] setSpellCheckedText: '$uppercaseText'")
        
        mainSpokenText = uppercaseText
        computeWordBoundaries(uppercaseText)

        val spannable = SpannableStringBuilder(uppercaseText)
        for ((start, end) in wordBoundaries) {
            spannable.setSpan(
                RoundedBackgroundSpan(CHIP_BACKGROUND_COLOR),
                start, end,
                Spanned.SPAN_EXCLUSIVE_EXCLUSIVE
            )
        }

        spellCheckedTextView?.text = spannable
        updateDropAreasVisibility() // Keep drop areas visible in all transcript states
        spellCheckedTextView?.movementMethod = null
        spellCheckedTextView?.setOnTouchListener { v, event ->
            if (event.action == android.view.MotionEvent.ACTION_DOWN) {
                v.setTag(R.id.spell_checked_text, Pair(event.x, event.y))
            }
            false
        }
        spellCheckedTextView?.setOnClickListener { v ->
            val coords = v.getTag(R.id.spell_checked_text) as? Pair<Float, Float>
            if (coords != null) {
                val idx = findWordIndexAt(coords.first, coords.second)
                if (idx != -1) {
                    playWordAtIndex(idx)
                } else {
                    stopTTS()
                }
            }
        }
        spellCheckedTextView?.setOnLongClickListener { v ->
            val coords = v.getTag(R.id.spell_checked_text) as? Pair<Float, Float>
            if (coords != null) {
                val idx = findWordIndexAt(coords.first, coords.second)
                if (idx != -1) {
                    val range = wordBoundaries[idx]
                    val word = mainSpokenText.substring(range.first, range.second)
                    
                    // Create drag data with EXACT character range for absolute precision
                    val item = ClipData.Item("${range.first}:${range.second}:$word")
                    val dragData = ClipData(
                        word,
                        arrayOf(ClipDescription.MIMETYPE_TEXT_PLAIN),
                        item
                    )
                    
                    // Start drag with custom shadow
                    v.startDragAndDrop(dragData, WordChipDragShadowBuilder(v.context, word), null, 0)
                    return@setOnLongClickListener true
                }
            }
            false
        }
    }

    private fun findWordIndexAt(x: Float, y: Float): Int {
        val tv = spellCheckedTextView ?: return -1
        val layout = tv.layout ?: return -1

        // Adjust for TextView padding and scroll
        val xAdj = x - tv.totalPaddingLeft + tv.scrollX
        val yAdj = y - tv.totalPaddingTop + tv.scrollY

        if (yAdj < 0 || yAdj > layout.height) return -1

        val line = layout.getLineForVertical(yAdj.toInt())
        val horizontalTolerance = 30f // Forgiving tap area

        for ((idx, range) in wordBoundaries.withIndex()) {
            if (layout.getLineForOffset(range.first) != line) continue

            val left = layout.getPrimaryHorizontal(range.first)
            val right = layout.getPrimaryHorizontal(range.second)

            if (xAdj >= (left - horizontalTolerance) && xAdj <= (right + horizontalTolerance)) {
                return idx
            }
        }
        return -1
    }

    private fun playWordAtIndex(wordIdx: Int) {
        if (wordIdx < 0 || wordIdx >= wordBoundaries.size) {
            stopTTS()
            return
        }

        val (start, end) = wordBoundaries[wordIdx]
        val word = mainSpokenText.substring(start, end)

        stopTTS()
        lastIntendedWordIndex = wordIdx
        val uid = "$MAIN_WORD_UTTERANCE_PREFIX$wordIdx"
        text2speech(word, TextToSpeech.QUEUE_FLUSH, uid)
    }
    private fun highlightWordAtOffset(offset: Int) {
        val fullText = mainSpokenText
        if (fullText.isEmpty() || offset < 0 || offset >= fullText.length) return
        
        // Find word index
        val wordIdx = wordBoundaries.indexOfFirst { it.first <= offset && it.second > offset }
        if (wordIdx == -1) return
        
        val start = wordBoundaries[wordIdx].first
        val end = wordBoundaries[wordIdx].second
        val word = fullText.substring(start, end)
        if (word.isEmpty()) return

        currentHighlightedWordRange = Pair(start, end)
        
        // Use the chip-based highlighter for visual consistency
        highlightWordInSpeech(wordIdx)

        // Show suggestions popup asynchronously
        suggestionJob?.cancel()
        suggestionJob = keyboardScope.launch {
            val suggestions = withContext(Dispatchers.Default) {
                generateSuggestions(word)
            }
            showSuggestionsPopup(suggestions)
        }
    }

    private fun clearHighlight() {
        highlightWordInSpeech(-1)
        // Only clear the "targetRange" if we are NOT currently preparing for a surgical substitution
        if (!SurgicalState.isPerformingSubstitution) {
            SurgicalState.targetRange = null
        }
    }

    private fun highlightRange(start: Int, end: Int) {
        val currentText = spellCheckedTextView?.text ?: return
        val spannable = SpannableString(currentText)
        val oldSpans = spannable.getSpans(0, spannable.length, BackgroundColorSpan::class.java)
        for (span in oldSpans) spannable.removeSpan(span)
        if (start in 0..spannable.length && end in 0..spannable.length && start < end) {
            spannable.setSpan(BackgroundColorSpan(HIGHLIGHT_COLOR), start, end, Spannable.SPAN_EXCLUSIVE_EXCLUSIVE)
        }
        spellCheckedTextView?.text = spannable
    }

    private fun generateSuggestions(word: String): List<String> {
        val target = word.lowercase()
        if (target.isEmpty()) return emptyList()

        return vocabulary
            .asSequence()
            .filter { kotlin.math.abs(it.length - target.length) <= 2 }
            .map { it to levenshteinDistance(target, it) }
            .sortedBy { it.second }
            .take(7)
            .map { it.first.uppercase(Locale.ROOT) }
            .toList()
    }

    /**
     * Speak all suggestions in order, automatically starting the stream
     * and leaving the UI in “Playing” state (as if Play‑All had been tapped).
     */
    private fun autoSpeakAllSuggestions(suggestions: List<String>) {
        if (suggestions.isEmpty() || tts == null) return

        // 1. Stop any previous utterance that might be running
        tts?.stop()

        // 2. Mark the UI as “speaking all”
        isSpeakingAllSuggestions = true
        isPaused = false
        lastSpokenSuggestionIndex = -1

        // 3. Show the pause icon immediately
        playAllButton?.setImageDrawable(
            ContextCompat.getDrawable(playAllButton!!.context, R.drawable.ic_pause)
        )

        // 4. Enqueue all suggestions – first as FLUSH, the rest as ADD
        for ((index, word) in suggestions.withIndex()) {
            val mode = if (index == 0) TextToSpeech.QUEUE_FLUSH else TextToSpeech.QUEUE_ADD
            text2speech(word, mode, utteranceId = word)
        }
    }

    private fun showSuggestionsPopup(suggestions: List<String>) {
        if (suggestions.isEmpty() || keyboardView == null) return
        suggestionPopup?.dismiss()
        suggestionItemViews.clear()
        currentHighlightedSuggestionView = null
        currentSuggestions = suggestions
        lastSpokenSuggestionIndex = -1
        isPaused = false

        val inflater = LayoutInflater.from(keyboardView!!.context)
        val popupView = inflater.inflate(R.layout.suggestion_list_popup, null)
        val container = popupView.findViewById<LinearLayout>(R.id.suggestion_container)

        /* ----------  Play All button  ---------- */
        if (suggestions.isNotEmpty()) {
            if (playAllButton == null) {
                playAllButton = ImageButton(keyboardView!!.context).apply {
                    setBackgroundResource(R.drawable.button_feedback)
                    setPadding(10, 10, 10, 10)
                    setImageDrawable(ContextCompat.getDrawable(context, R.drawable.ic_play_all))
                    layoutParams = LinearLayout.LayoutParams(70, 70).apply {
                        // Place a little margin so it doesn’t touch the edges
                        marginStart = 4
                        marginEnd = 4
                        topMargin = 4
                        bottomMargin = 4
                    }
                }
            }

            playAllButton!!.setImageDrawable(ContextCompat.getDrawable(playAllButton!!.context, R.drawable.ic_play_all))
            isSpeakingAllSuggestions = false
            playAllButton!!.setOnClickListener(null) // Remove old listener first

            playAllButton!!.setOnClickListener {
                onPlayClickSound()

                if (isSpeakingAllSuggestions) {
                    // **Pause**
                    tts?.stop()                        // Stop the current utterance
                    isPaused = true                    // Remember that we’re paused
                    isSpeakingAllSuggestions = false   // ← reset flag so next click *resumes*
                    playAllButton!!.setImageDrawable(
                        ContextCompat.getDrawable(it.context, R.drawable.ic_play_all)
                    )
                } else {
                    // **Resume / Start**
                    isSpeakingAllSuggestions = true
                    playAllButton!!.setImageDrawable(
                        ContextCompat.getDrawable(it.context, R.drawable.ic_pause)
                    )

                    // Start from the last spoken index if we were paused, otherwise from 0
                    val startIndex = if (isPaused) lastSpokenSuggestionIndex + 1 else 0
                    isPaused = false

                    // Speak all remaining suggestions
                    for (i in startIndex until currentSuggestions.size) {
                        val mode = if (i == startIndex) TextToSpeech.QUEUE_FLUSH else TextToSpeech.QUEUE_ADD
                        text2speech(
                            currentSuggestions[i],
                            queueMode = mode,
                            utteranceId = currentSuggestions[i]   // unique id per utterance
                        )
                    }
                }
            }

            // Put the button first, then the suggestion rows
            val parent = playAllButton!!.parent as? ViewGroup
            parent?.removeView(playAllButton)
            container.addView(playAllButton, 0)
        }

        playAllButton!!.visibility =
            if (suggestions.isEmpty()) View.GONE else View.VISIBLE

        for ((index, suggestion) in suggestions.withIndex()) {
            if (index > 0) {
                val divider = View(keyboardView!!.context).apply {
                    layoutParams = LinearLayout.LayoutParams(
                        LinearLayout.LayoutParams.MATCH_PARENT,
                        keyboardView!!.resources.getDimensionPixelSize(R.dimen.divider_height)
                    )
                    setBackgroundColor(Color.LTGRAY)
                }
                container.addView(divider)
            }
            val itemView = inflater.inflate(R.layout.suggestion_item, container, false)
            val suggestionTextView = itemView.findViewById<TextView>(R.id.tv_suggestion_text)
            suggestionTextView.text = suggestion
            suggestionItemViews[suggestion] = itemView
            itemView.findViewById<ImageButton>(R.id.btn_play_suggestion).setOnClickListener {
                onPlayClickSound(); text2speech(suggestion, TextToSpeech.QUEUE_FLUSH, suggestion)
            }
            itemView.findViewById<ImageButton>(R.id.btn_substitute_suggestion).setOnClickListener {
                onPlayClickSound()
                isSubstitutingWord = true
                substituteWord(suggestion, currentHighlightedWordRange)
                suggestionPopup?.dismiss()
            }
            container.addView(itemView)
        }

        suggestionPopup = PopupWindow(popupView, ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT, true)
        suggestionPopup?.setBackgroundDrawable(ColorDrawable(Color.TRANSPARENT))
        suggestionPopup?.isOutsideTouchable = true
        suggestionPopup?.setOnDismissListener {
            clearHighlight()
            if (!isSubstitutingWord) {
                tts?.stop()
            }
            isSubstitutingWord = false
            currentHighlightedSuggestionView?.setBackgroundColor(Color.TRANSPARENT)
            currentHighlightedSuggestionView = null
        }
        suggestionPopup?.setTouchInterceptor { _, event ->
            if (event.action == MotionEvent.ACTION_DOWN) {
                tts?.stop()
            }
            false
        }

        val location = IntArray(2)
        spellCheckedTextView?.getLocationInWindow(location)
        val layout = spellCheckedTextView?.layout
        val range = currentHighlightedWordRange

        if (layout != null && range != null) {
            val line = layout.getLineForOffset(range.first)
            val xOffset = layout.getPrimaryHorizontal(range.first).toInt()
            val yOffset = layout.getLineBottom(line)
            suggestionPopup?.showAtLocation(spellCheckedTextView, android.view.Gravity.NO_GRAVITY, location[0] + xOffset, location[1] + yOffset)
            autoSpeakAllSuggestions(suggestions)
        } else {
            suggestionPopup?.showAtLocation(spellCheckedTextView, android.view.Gravity.CENTER, 0, 0)
            autoSpeakAllSuggestions(suggestions)
        }
    }

    private fun substituteWord(newWord: String, providedRange: Pair<Int, Int>?) {
        val logPrefix = "[$INSTANCE_ID] [SUBSTITUTE]"
        val range = providedRange
        if (range == null) {
            Log.e(TAG, "$logPrefix FAILED - range is NULL")
            return
        }
        
        val currentText = mainSpokenText
        val upperNewWord = newWord.trim().uppercase(Locale.ROOT)
        Log.d(TAG, "$logPrefix range=$range, curLen=${currentText.length}, word='$upperNewWord'")
        
        val start = MathUtils.clamp(range.first, 0, currentText.length)
        val end = MathUtils.clamp(range.second, start, currentText.length)
        
        val newText = currentText.substring(0, start) + upperNewWord + currentText.substring(end)
        Log.d(TAG, "$logPrefix DONE. New text set.")
        
        setSpellCheckedText(newText)
        text2speech(newText)
    }

    fun setResultsVisibility(isVisible: Boolean) {
        btnPlaySpell?.visibility = View.VISIBLE
        btnCheckSpell?.visibility = View.VISIBLE
        spellCheckedTextView?.visibility = if (isVisible) View.VISIBLE else View.INVISIBLE
    }

    private fun updateDropAreasVisibility() {
        containerStatusMic?.visibility = View.VISIBLE
        containerStatusList?.visibility = View.VISIBLE
        containerStatusRobot?.visibility = View.VISIBLE
        containerStatusTrash?.visibility = View.VISIBLE
    }

    fun clearTranscript() {
        Log.d(TAG, "[$INSTANCE_ID] clearTranscript: Clearing transcript from keyboard view")
        mainSpokenText = ""
        wordBoundaries = emptyList()
        spellCheckedTextView?.text = ""
        setResultsVisibility(false)
        updateDropAreasVisibility() // Keep drop areas visible when transcript is cleared
        stopTTS()
        suggestionPopup?.dismiss()
        stopPulsingHighlight()
        clearHighlight()
    }

    fun speakFullTranscript() {
        if (mainSpokenText.isNotBlank()) {
            text2speech(mainSpokenText)
        }
    }

    private fun highlightWordInSpeech(wordIdx: Int) {
        val tv = spellCheckedTextView ?: return
        // wordIdx -1 means "no highlight", just show all chips
        if (wordIdx >= wordBoundaries.size) return

        val sp = SpannableStringBuilder(mainSpokenText)
        for ((idx, range) in wordBoundaries.withIndex()) {
            val (start, end) = range
            val color = when {
                idx == pulsingWordIndex -> currentPulseColor
                idx == wordIdx -> HIGHLIGHT_COLOR
                else -> CHIP_BACKGROUND_COLOR
            }
            sp.setSpan(
                RoundedBackgroundSpan(color),
                start, end,
                Spanned.SPAN_EXCLUSIVE_EXCLUSIVE
            )
        }
        tv.text = sp
    }

    private fun startPulsingHighlight(wordIdx: Int) {
        stopPulsingHighlight()
        pulsingWordIndex = wordIdx
        val red = Color.parseColor("#D56062") // playful_red
        
        pulseAnimator = ValueAnimator.ofObject(ArgbEvaluator(), Color.TRANSPARENT, red).apply {
            duration = 600
            repeatMode = ValueAnimator.REVERSE
            repeatCount = ValueAnimator.INFINITE
            addUpdateListener { animator ->
                currentPulseColor = animator.animatedValue as Int
                highlightWordInSpeech(-1) // Ensure no other word is highlighted yellow
            }
            start()
        }
    }

    private fun stopPulsingHighlight() {
        pulseAnimator?.cancel()
        pulseAnimator = null
        pulsingWordIndex = -1
        currentPulseColor = Color.TRANSPARENT
        highlightWordInSpeech(-1) // Clear any remaining highlight
    }

    override fun onInit(status: Int) {
        if (status == TextToSpeech.SUCCESS) {
            val result = tts?.setLanguage(Locale.ITALIAN)
            when (result) {
                TextToSpeech.LANG_MISSING_DATA -> {
                    Log.e(TAG, "TTS Italian data is missing. Please install it in TTS settings.")
                }
                TextToSpeech.LANG_NOT_SUPPORTED -> {
                    Log.e(TAG, "TTS Italian is not supported. Falling back to default locale.")
                    tts?.language = Locale.getDefault()
                }
                else -> {
                    Log.d(TAG, "TTS initialized with Italian.")
                }
            }
            tts?.setOnUtteranceProgressListener(object : UtteranceProgressListener() {
                override fun onStart(utteranceId: String) {
                    handler.post {
                        if (utteranceId.startsWith(MAIN_WORD_UTTERANCE_PREFIX)) {
                            val idx = utteranceId.removePrefix(MAIN_WORD_UTTERANCE_PREFIX).toIntOrNull()
                            if (idx != null) {
                                highlightWordInSpeech(idx)
                            }
                        } else {
                            // Highlight suggestion item
                            currentHighlightedSuggestionView?.setBackgroundColor(Color.TRANSPARENT)
                            val view = suggestionItemViews[utteranceId]
                            view?.let {
                                it.setBackgroundColor(HIGHLIGHT_COLOR)
                                currentHighlightedSuggestionView = it

                                // Update the last spoken suggestion index so that a pause can be resumed
                                val idx = currentSuggestions.indexOf(utteranceId)
                                if (idx >= 0) {
                                    lastSpokenSuggestionIndex = idx
                                }
                            }
                        }
                    }
                }

                override fun onDone(utteranceId: String) {
                    handler.post {
                        if (utteranceId.startsWith(MAIN_WORD_UTTERANCE_PREFIX)) {
                            val idx = utteranceId.removePrefix(MAIN_WORD_UTTERANCE_PREFIX).toIntOrNull()
                            if (idx != null && idx == lastIntendedWordIndex) {
                                // When the intended sequence is spoken, clear the highlight
                                highlightWordInSpeech(-1)
                            }
                        }
                    }
                }

                override fun onError(utteranceId: String) {
                    handler.post {
                        // On error, just reset the text to remove any highlighting but keep chips
                        highlightWordInSpeech(-1)
                    }
                }
            })
        } else {
            Log.e(TAG, "TTS initialization failed.")
        }
    }

    fun reset() {
        setKeyboardStatus(KeyboardStatus.Idle)
        setSpellCheckedText("")
        setResultsVisibility(true)
        suggestionPopup?.dismiss()
        stopPulsingHighlight()
    }

    private fun stopTTS() {
        if (tts?.isSpeaking == true) {
            tts?.stop()
        }
        isSpeakingAllSuggestions = false
        highlightWordInSpeech(-1)
    }

    fun updateMicrophoneAmplitude(amplitude: Int) {
        if (keyboardStatus != KeyboardStatus.Recording) return
        val clamped = MathUtils.clamp(amplitude, AMPLITUDE_CLAMP_MIN, AMPLITUDE_CLAMP_MAX)
        val normalized = (log10(clamped * 1f) - LOG_10_10) / (LOG_10_25000 - LOG_10_10)
        for (ripple in micRipples) {
            ripple.clearAnimation(); ripple.alpha = normalized.pow(1.0f); ripple.animate().alpha(0f).setDuration(AMPLITUDE_ANIMATION_DURATION).start()
        }
    }

    fun updateProgressBar(progress: Int) {
        progressBarTop?.progress = progress
    }

    private fun onButtonMicClick() {
        stopTTS()
        onPlayClickSound()
        when (keyboardStatus) {
            KeyboardStatus.Idle -> {
                setKeyboardStatus(KeyboardStatus.Recording); onStartRecording()
            }
            KeyboardStatus.Recording -> {
                setKeyboardStatus(KeyboardStatus.Transcribing); onStartTranscribing("")
            }
            KeyboardStatus.Transcribing -> return
        }
    }

    private fun onButtonSettingsClick() {
        stopTTS()
        onPlayClickSound(); onOpenSettings()
    }

    private fun onButtonEnterClick() {
        onPlayClickSound()
        if (keyboardStatus == KeyboardStatus.Recording) {
            setKeyboardStatus(KeyboardStatus.Transcribing); onStartTranscribing("")
        } else onEnter()
    }


    private fun onButtonCancelClick() {
        onPlayClickSound()
        if (keyboardStatus == KeyboardStatus.Recording) {
            setKeyboardStatus(KeyboardStatus.Idle); onCancelRecording()
        } else if (keyboardStatus == KeyboardStatus.Transcribing) {
            setKeyboardStatus(KeyboardStatus.Idle); onCancelTranscribing()
        }
    }

    private fun onButtonRetryClick() {
        onPlayClickSound()
        if (keyboardStatus == KeyboardStatus.Idle) {
            setKeyboardStatus(KeyboardStatus.Transcribing); onStartTranscribing("")
        }
    }

    // Helper functions for recent emojis
    private suspend fun saveRecentEmoji(context: android.content.Context, emoji: String) {
        val recentEmojis = loadRecentEmojis(context).toMutableList()
        // Remove if already exists (to avoid duplicates)
        recentEmojis.remove(emoji)
        // Add to front
        recentEmojis.add(0, emoji)
        // Keep only the 20 most recent
        val trimmed = recentEmojis.take(20)
        // Save as comma-separated string
        val emojiString = trimmed.joinToString(",")
        context.dataStore.edit { preferences ->
            preferences[RECENT_EMOJIS] = emojiString
        }
    }

    private suspend fun loadRecentEmojis(context: android.content.Context): List<String> {
        return try {
            val emojiString = context.dataStore.data.map { preferences ->
                preferences[RECENT_EMOJIS] ?: ""
            }.first()
            if (emojiString.isEmpty()) {
                emptyList()
            } else {
                emojiString.split(",").filter { it.isNotEmpty() }
            }
        } catch (e: Exception) {
            emptyList()
        }
    }

    private fun populateRecentGrid(gridRecent: GridLayout, recentEmojis: List<String>, onEmojiClick: ((String) -> Unit)? = null) {
        // Clear existing children
        gridRecent.removeAllViews()
        val emojiCellSizePx = android.util.TypedValue.applyDimension(
            android.util.TypedValue.COMPLEX_UNIT_DIP,
            55f,
            keyboardView!!.context.resources.displayMetrics
        ).toInt()
        val recentViewportHeightPx = android.util.TypedValue.applyDimension(
            android.util.TypedValue.COMPLEX_UNIT_DIP,
            240f,
            keyboardView!!.context.resources.displayMetrics
        ).toInt()
        // Keep stable popup size even when recent is empty.
        gridRecent.minimumWidth = emojiCellSizePx * 10
        gridRecent.minimumHeight = recentViewportHeightPx
        
        if (recentEmojis.isEmpty()) {
            return
        }
        
        // Add emojis to grid
        recentEmojis.forEach { emoji ->
            val textView = TextView(keyboardView!!.context, null, 0, R.style.EmojiItem)
            textView.text = emoji
            val params = GridLayout.LayoutParams().apply {
                width = emojiCellSizePx
                height = emojiCellSizePx
                setMargins(0, 0, 0, 0)
            }
            textView.layoutParams = params
            if (onEmojiClick != null) {
                textView.setOnClickListener {
                    onEmojiClick(emoji)
                }
            }
            gridRecent.addView(textView)
        }
        
    }

    private fun onButtonEmojiClick() {
        stopTTS()
        onPlayClickSound()
        if (emojiPopup?.isShowing == true) {
            tts?.stop()
            emojiPopup?.dismiss()
            emojiPopup = null
            return
        }
        val inflater = LayoutInflater.from(keyboardView!!.context)
        val popupView = inflater.inflate(R.layout.emoji_popup, keyboardView, false)
        val popupWindow = PopupWindow(popupView, ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT, true)
        
        // Get all emoji grids
        val gridRecent = popupView.findViewById<GridLayout>(R.id.emoji_grid_recent)
        val gridFaces = popupView.findViewById<GridLayout>(R.id.emoji_grid_faces)
        val gridGestures = popupView.findViewById<GridLayout>(R.id.emoji_grid_gestures)
        val gridAnimals = popupView.findViewById<GridLayout>(R.id.emoji_grid_animals)
        val gridFood = popupView.findViewById<GridLayout>(R.id.emoji_grid_food)
        val gridTravel = popupView.findViewById<GridLayout>(R.id.emoji_grid_travel)
        val gridObjects = popupView.findViewById<GridLayout>(R.id.emoji_grid_objects)
        val gridSymbols = popupView.findViewById<GridLayout>(R.id.emoji_grid_symbols)
        
        val allGrids = listOf(gridRecent, gridFaces, gridGestures, gridAnimals, gridFood, gridTravel, gridObjects, gridSymbols)
        val context = keyboardView!!.context

        fun onEmojiSelected(emoji: String) {
            onPlayClickSound()
            onEmoji(emoji)
            keyboardScope.launch {
                saveRecentEmoji(context, emoji)
                val recentEmojis = loadRecentEmojis(context)
                populateRecentGrid(gridRecent, recentEmojis, ::onEmojiSelected)
            }
        }
        
        // Set up click listeners for all emojis in all grids
        val setupEmojiClickListener = { grid: GridLayout ->
            for (i in 0 until grid.childCount) {
                val child = grid.getChildAt(i)
                if (child is TextView) {
                    child.setOnClickListener {
                        val emoji = child.text.toString()
                        onEmojiSelected(emoji)
                    }
                }
            }
        }
        
        allGrids.forEach { grid -> setupEmojiClickListener(grid) }

        // Get menu buttons
        val menuRecent = popupView.findViewById<TextView>(R.id.menu_recent)
        val menuFaces = popupView.findViewById<TextView>(R.id.menu_faces)
        val menuGestures = popupView.findViewById<TextView>(R.id.menu_gestures)
        val menuAnimals = popupView.findViewById<TextView>(R.id.menu_animals)
        val menuFood = popupView.findViewById<TextView>(R.id.menu_food)
        val menuTravel = popupView.findViewById<TextView>(R.id.menu_travel)
        val menuObjects = popupView.findViewById<TextView>(R.id.menu_objects)
        val menuSymbols = popupView.findViewById<TextView>(R.id.menu_symbols)
        val menuItems = listOf(menuRecent, menuFaces, menuGestures, menuAnimals, menuFood, menuTravel, menuObjects, menuSymbols)
        
        val menuIndicator = popupView.findViewById<View>(R.id.menu_indicator)
        
        // Function to switch sections
        val switchSection = { selectedGrid: GridLayout, selectedMenu: TextView ->
            // Hide all grids
            allGrids.forEach { it.visibility = android.view.View.GONE }
            // Show selected grid
            selectedGrid.visibility = android.view.View.VISIBLE
            
            // Update indicator position
            val menuBar = popupView.findViewById<android.view.View>(R.id.emoji_menu_bar)
            menuBar.post {
                val layoutParams = menuIndicator.layoutParams as android.view.ViewGroup.MarginLayoutParams
                val menuWidth = menuBar.width / menuItems.size.toFloat()
                val menuIndex = when (selectedMenu) {
                    menuRecent -> 0
                    menuFaces -> 1
                    menuGestures -> 2
                    menuAnimals -> 3
                    menuFood -> 4
                    menuTravel -> 5
                    menuObjects -> 6
                    menuSymbols -> 7
                    else -> 0
                }
                layoutParams.leftMargin = (menuIndex * menuWidth).toInt()
                menuIndicator.layoutParams = layoutParams
            }
        }
        
        // Set up menu button click listeners
        menuRecent.setOnClickListener {
            onPlayClickSound()
            switchSection(gridRecent, menuRecent)
            keyboardScope.launch {
                val recentEmojis = loadRecentEmojis(context)
                populateRecentGrid(gridRecent, recentEmojis, ::onEmojiSelected)
            }
        }
        menuFaces.setOnClickListener {
            onPlayClickSound()
            switchSection(gridFaces, menuFaces)
        }
        menuGestures.setOnClickListener {
            onPlayClickSound()
            switchSection(gridGestures, menuGestures)
        }
        menuAnimals.setOnClickListener {
            onPlayClickSound()
            switchSection(gridAnimals, menuAnimals)
        }
        menuFood.setOnClickListener {
            onPlayClickSound()
            switchSection(gridFood, menuFood)
        }
        menuTravel.setOnClickListener {
            onPlayClickSound()
            switchSection(gridTravel, menuTravel)
        }
        menuObjects.setOnClickListener {
            onPlayClickSound()
            switchSection(gridObjects, menuObjects)
        }
        menuSymbols.setOnClickListener {
            onPlayClickSound()
            switchSection(gridSymbols, menuSymbols)
        }
        
        // Show faces section by default
        switchSection(gridFaces, menuFaces)
        keyboardScope.launch {
            val recentEmojis = loadRecentEmojis(context)
            populateRecentGrid(gridRecent, recentEmojis, ::onEmojiSelected)
        }
        
        popupWindow.showAtLocation(keyboardView, android.view.Gravity.CENTER, 0, 0)
        emojiPopup = popupWindow
    }

    private fun onButtonKeyboardClick() {
        stopTTS()
        onPlayClickSound()
        if (keyboardPopup?.isShowing == true) {
            tts?.stop()
            popupBackspaceJob?.cancel()
            popupBackspaceJob = null
            keyboardPopup?.dismiss()
            keyboardPopup = null
            return
        }
        val inflater = LayoutInflater.from(keyboardView!!.context)
        val popupView = inflater.inflate(R.layout.keyboard_popup, keyboardView, false)
        val popupWindow = PopupWindow(popupView, ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT, true)
        popupWindow.setOnDismissListener {
            // Cancel any ongoing backspace job when popup is dismissed
            popupBackspaceJob?.cancel()
            popupBackspaceJob = null
        }
        
        val lettersGrid = popupView.findViewById<GridLayout>(R.id.letters_grid)
        val symbolsGrid = popupView.findViewById<GridLayout>(R.id.symbols_grid)
        
        val setupGrid = { grid: GridLayout? ->
            grid?.let {
                for (i in 0 until it.childCount) {
                    val child = it.getChildAt(i)
                    if (child is TextView && child.text.isNotEmpty()) {
                        child.setOnClickListener {
                            onPlayClickSound()
                            val text = child.text.toString()
                            if (text.length == 1) {
                                onKey(text[0])
                            }
                        }
                    }
                }
            }
        }
        
        setupGrid(lettersGrid)
        setupGrid(symbolsGrid)
        
        // Handle special action buttons
        val popupCapsLock = popupView.findViewById<ImageButton>(R.id.popup_caps_lock)
        val popupSpace = popupView.findViewById<ImageButton>(R.id.popup_space)
        val popupBackspace = popupView.findViewById<ImageButton>(R.id.popup_backspace)
        val popupEnter = popupView.findViewById<ImageButton>(R.id.popup_enter)
        
        popupCapsLock?.setOnClickListener {
            onPlayClickSound()
            isCapsLocked = !isCapsLocked
            updateCapsLockState()
            // Update the icon in the popup
            val newIcon = if (isCapsLocked) R.drawable.ic_shift_on else R.drawable.ic_shift
            popupCapsLock.setImageResource(newIcon)
            
            // Update letter case in the letters popup grid
            lettersGrid?.let { grid ->
                for (i in 0 until grid.childCount) {
                    val child = grid.getChildAt(i)
                    if (child is TextView && child.text.length == 1 && child.text.any { it.isLetter() }) {
                        val currentText = child.text.toString()
                        child.text = if (isCapsLocked) currentText.uppercase(Locale.ROOT) else currentText.lowercase(Locale.ROOT)
                    }
                }
            }
            // Don't dismiss - keep popup open
        }
        
        popupSpace?.setOnClickListener {
            onPlayClickSound()
            onSpaceBar()
            // Don't dismiss - keep popup open
        }
        
        // Long-press deletion for popup backspace button
        popupBackspace?.setOnTouchListener { _, event ->
            when (event.action) {
                MotionEvent.ACTION_DOWN -> {
                    // Perform initial delete
                    onPlayClickSound()
                    onButtonBackspace()
                    // Start long-press detector
                    popupBackspaceJob?.cancel()
                    popupBackspaceJob = keyboardScope.launch {
                        // Wait before starting rapid deletion
                        delay(600) // DELAY_BEFORE_QUICK_BACKSPACE
                        // Continue deleting while button is held
                        while (this.isActive) {
                            onPlayClickSound()
                            onButtonBackspace()
                            delay(80) // QUICK_BACKSPACE_DELAY
                        }
                    }
                    true
                }
                MotionEvent.ACTION_UP, MotionEvent.ACTION_CANCEL -> {
                    // Stop rapid deletion
                    popupBackspaceJob?.cancel()
                    popupBackspaceJob = null
                    true
                }
                else -> false
            }
        }
        
        popupEnter?.setOnClickListener {
            onButtonEnterClick()
            // Don't dismiss - keep popup open
        }
        
        keyboardPopup = popupWindow
        popupWindow.showAtLocation(keyboardView, android.view.Gravity.CENTER, 0, 0)
    }

    private fun onButtonCapsLockClick() {
        onPlayClickSound()
        isCapsLocked = !isCapsLocked
        updateCapsLockState()
    }

    private fun onButtonRobotClick() {
        stopTTS()
        onPlayClickSound()
        setRobotLoadingState(isLoading = true)
        
        keyboardScope.launch {
            try {
                // Read settings from DataStore
                val (llmEndpoint, prompt) = keyboardView?.context?.dataStore?.data?.map { preferences: Preferences ->
                    Pair(
                        preferences[LLM_MODEL_ENDPOINT] ?: keyboardView!!.context.getString(R.string.settings_option_llm_model_default),
                        preferences[PROMPT_FOR_LLM] ?: keyboardView!!.context.getString(R.string.settings_option_prompt_for_llm_default)
                    )
                }?.first() ?: Pair("", "")
                
                if (llmEndpoint.isBlank()) {
                    Log.w(TAG, "LLM endpoint is not set")
                    return@launch
                }
                
                // Make LLM request
                val response = makeLlmRequest(llmEndpoint, prompt)
                
                // Add response to transcript area
                if (response.isNotBlank()) {
                    setSpellCheckedText(response)
                    setResultsVisibility(true)
                    text2speech(response, TextToSpeech.QUEUE_FLUSH)
                }
            } catch (e: Exception) {
                Log.e(TAG, "Error making LLM request", e)
            } finally {
                setRobotLoadingState(isLoading = false)
            }
        }
    }

    private fun onRobotDropWord(start: Int, end: Int, droppedWord: String) {
        stopTTS()
        onPlayClickSound()
        setRobotLoadingState(isLoading = true)

        val targetRange = Pair(start, end)
        val transcript = mainSpokenText
        val prompt = buildRobotDropPrompt(droppedWord = droppedWord, transcript = transcript)

        keyboardScope.launch {
            try {
                val llmEndpoint = keyboardView?.context?.dataStore?.data?.map { preferences: Preferences ->
                    preferences[LLM_MODEL_ENDPOINT]
                        ?: keyboardView!!.context.getString(R.string.settings_option_llm_model_default)
                }?.first() ?: ""

                if (llmEndpoint.isBlank()) {
                    Log.w(TAG, "LLM endpoint is not set")
                    return@launch
                }

                val response = makeLlmRequest(llmEndpoint, prompt)
                if (response.isNotBlank()) {
                    val replacementWord = extractSingleWordSuggestion(response)
                    if (replacementWord.isNotBlank()) {
                        substituteWord(replacementWord, targetRange)
                    }
                }
            } catch (e: Exception) {
                Log.e(TAG, "Error making LLM request for dropped word substitution", e)
            } finally {
                setRobotLoadingState(isLoading = false)
            }
        }
    }

    private fun setRobotLoadingState(isLoading: Boolean) {
        btnRobot?.isEnabled = !isLoading
        waitingIconLlm?.visibility = if (isLoading) View.VISIBLE else View.INVISIBLE
    }

    private fun buildRobotDropPrompt(droppedWord: String, transcript: String): String {
        return "The user identified that a word constitutes an error within a context. " +
            "You have to provide a suggestion for a word that can correctly substitute the erroneous word within the context. " +
            "Your answer must only be the processed output, no decorations nor explanations (like 'sure', 'this is the answer', etc). " +
            "The context, word, and your answer must be in Italian. " +
            "The context is: '$transcript'. " +
            "The word identified as erroneous is: '$droppedWord'. "
    }

    private fun extractSingleWordSuggestion(rawResponse: String): String {
        val cleaned = rawResponse.trim().trimQuotes()
        val firstToken = cleaned
            .lineSequence()
            .map { it.trim() }
            .firstOrNull { it.isNotBlank() }
            ?.split(Regex("\\s+"))
            ?.firstOrNull()
            ?: return ""

        return firstToken.trim('"', '\'', '.', ',', ';', ':', '!', '?', '(', ')', '[', ']', '{', '}')
    }

    private suspend fun makeLlmRequest(endpoint: String, prompt: String): String {
        return withContext(Dispatchers.IO) {
            try {
                val client = OkHttpClient.Builder()
                    .connectTimeout(30, TimeUnit.SECONDS)
                    .readTimeout(60, TimeUnit.SECONDS)
                    .writeTimeout(30, TimeUnit.SECONDS)
                    .build()

                val jsonBody = JSONObject().apply {
                    put("messages", JSONArray().put(JSONObject().put("role", "user").put("content", prompt)))
                }

                val requestBody = jsonBody.toString().toRequestBody("application/json".toMediaTypeOrNull())

                val request = Request.Builder()
                    .url(endpoint)
                    .header("Content-Type", "application/json")
                    .post(requestBody)
                    .build()

                val response = client.newCall(request).execute()
                val responseBody = response.body?.string() ?: ""

                if (response.isSuccessful) {
                    // Return the plain text response
                    responseBody.trim().trimQuotes()
                } else {
                    Log.e(TAG, "LLM request failed with code ${response.code}: $responseBody")
                    ""
                }
            } catch (e: Exception) {
                Log.e(TAG, "Exception during LLM request", e)
                ""
            }
        }
    }

    private fun String.trimQuotes(): String {
        return if (startsWith("\"") && endsWith("\"")) {
            substring(1, length - 1)
        } else {
            this
        }
    }

    private fun updateCapsLockState() {
        fun updateCase(view: View) {
            when (view) {
                is android.widget.Button -> {
                    if (view.text.length == 1 && view.text.any { it.isLetter() }) {
                        val currentText = view.text.toString()
                        view.text = if (isCapsLocked) currentText.uppercase(Locale.ROOT) else currentText.lowercase(Locale.ROOT)
                    }
                }
                is ViewGroup -> {
                    for (i in 0 until view.childCount) {
                        updateCase(view.getChildAt(i))
                    }
                }
            }
        }

        keyboardView?.let { updateCase(it) }
    }

    fun setKeyboardStatus(newStatus: KeyboardStatus) {
        when (newStatus) {
            KeyboardStatus.Idle -> {
                buttonMic!!.setImageResource(R.drawable.ic_mic); waitingIcon!!.visibility = View.INVISIBLE
                progressBarTop!!.visibility = View.VISIBLE
                for (ripple in micRipples) ripple.visibility = View.GONE; keyboardView!!.keepScreenOn = false
            }
            KeyboardStatus.Recording -> {
                buttonMic!!.setImageResource(R.drawable.ic_mic); waitingIcon!!.visibility = View.INVISIBLE
                progressBarTop!!.visibility = View.VISIBLE
                for (ripple in micRipples) ripple.visibility = View.VISIBLE
                keyboardView!!.keepScreenOn = true
            }
            KeyboardStatus.Transcribing -> {
                buttonMic!!.setImageResource(R.drawable.ic_mic); waitingIcon!!.visibility = View.VISIBLE
                progressBarTop!!.visibility = View.INVISIBLE
                for (ripple in micRipples) ripple.visibility = View.GONE; keyboardView!!.keepScreenOn = true
            }
        }
        keyboardStatus = newStatus
        if (newStatus == KeyboardStatus.Idle) {
            stopPulsingHighlight()
        }
    }

    fun destroy() {
        keyboardScope.cancel()
        if (tts != null) {
            tts!!.stop(); tts!!.shutdown(); tts = null
        }
    }

    fun text2speech(
        textToSpeak: String,
        queueMode: Int = TextToSpeech.QUEUE_FLUSH,
        utteranceId: String? = null
    ) {
        if (textToSpeak.isNotEmpty()) {
            if (utteranceId == null) {                 // MAIN speech
                val uppercaseText = textToSpeak.uppercase(Locale.ROOT)
                val wordsToSpeak = uppercaseText
                    .split("\\s+".toRegex())
                    .filter { it.isNotBlank() }
                lastIntendedWordIndex = wordsToSpeak.size - 1

                // Speak word‑by‑word so we can receive a callback per word
                var mode = queueMode
                wordsToSpeak.forEachIndexed { idx, word ->
                        val uid = "$MAIN_WORD_UTTERANCE_PREFIX$idx"
                        val p = Bundle()
                        p.putString(TextToSpeech.Engine.KEY_PARAM_UTTERANCE_ID, uid)
                        tts?.speak(word, mode, p, uid)
                        mode = TextToSpeech.QUEUE_ADD          // queue the rest
                }
            } else {                                    // SUGGESTION or “explicit” utterance
                val p = Bundle()
                p.putString(TextToSpeech.Engine.KEY_PARAM_UTTERANCE_ID, utteranceId)
                tts?.speak(textToSpeak, queueMode, p, utteranceId)
            }
        }
    }


    fun setup(
        layoutInflater: LayoutInflater, onStartRecording: () -> Unit, onCancelRecording: () -> Unit,
        onStartTranscribing: (attachToEnd: String) -> Unit, onCancelTranscribing: () -> Unit,
        onButtonBackspace: () -> Unit, onEnter: () -> Unit, onSpaceBar: () -> Unit,
        onSwitchIme: () -> Unit, onOpenSettings: () -> Unit, onKey: (character: Char) -> Unit,
        onCheck: (text: String) -> Unit, onEmoji: (emoji: String) -> Unit,
        shouldShowRetry: () -> Boolean, onPlayClickSound: () -> Unit,
    ): View {
        keyboardView = layoutInflater.inflate(R.layout.keyboard_view, null) as ConstraintLayout
        keyboardView!!.setOnTouchListener { _, _ -> stopTTS(); false }
        
        buttonMic = keyboardView!!.findViewById(R.id.btn_mic)
        buttonCancel = keyboardView!!.findViewById(R.id.btn_cancel)
        buttonRetry = keyboardView!!.findViewById(R.id.btn_retry)
        waitingIcon = keyboardView!!.findViewById(R.id.pb_waiting_icon)
        progressBarTop = keyboardView!!.findViewById(R.id.progress_bar_top)
        buttonSettings = keyboardView!!.findViewById(R.id.btn_settings)
        micRipples = arrayOf(keyboardView!!.findViewById(R.id.mic_ripple_0))
        spellCheckedTextView = keyboardView!!.findViewById(R.id.spell_checked_text)
        tvStatusMic = keyboardView!!.findViewById(R.id.tv_status_mic)
        tvStatusList = keyboardView!!.findViewById(R.id.tv_status_list)
        tvStatusRobot = keyboardView!!.findViewById(R.id.tv_status_robot)
        tvStatusTrash = keyboardView!!.findViewById(R.id.tv_status_trash)
        containerStatusMic = keyboardView!!.findViewById(R.id.container_status_mic)
        containerStatusList = keyboardView!!.findViewById(R.id.container_status_list)
        containerStatusRobot = keyboardView!!.findViewById(R.id.container_status_robot)
        containerStatusTrash = keyboardView!!.findViewById(R.id.container_status_trash)
        
        setupDragListeners()

        ivSpellIcon = keyboardView!!.findViewById(R.id.iv_spell_icon)
        btnPlaySpell = keyboardView!!.findViewById(R.id.btn_play_spell)
        btnPlaySpell!!.setOnClickListener { stopTTS(); onPlayClickSound(); text2speech(spellCheckedTextView?.text.toString()) }
        btnCheckSpell = keyboardView!!.findViewById(R.id.btn_check_spell)
        btnCheckSpell!!.setOnClickListener { stopTTS(); onPlayClickSound(); onCheck(spellCheckedTextView?.text.toString()) }
        btnEmoji = keyboardView!!.findViewById(R.id.btn_emoji)
        btnEmoji!!.setOnClickListener { onButtonEmojiClick() }
        btnKeyboard = keyboardView!!.findViewById(R.id.btn_keyboard)
        btnKeyboard!!.setOnClickListener { onButtonKeyboardClick() }
        btnEnter = keyboardView!!.findViewById(R.id.btn_enter)
        btnEnter!!.setOnClickListener { onButtonEnterClick() }
        btnDelete = keyboardView!!.findViewById(R.id.btn_delete)
        btnDelete!!.setBackspaceCallback(
            callback = { onButtonBackspace() },
            onPlayClickSound = { onPlayClickSound() },
        )
        btnDeleteAllTranscript = keyboardView!!.findViewById(R.id.btn_delete_all_transcript)
        btnDeleteAllTranscript!!.setOnClickListener {
            stopTTS()
            onPlayClickSound()
            clearTranscript()
        }
        btnRobot = keyboardView!!.findViewById(R.id.btn_robot)
        btnRobot!!.setOnClickListener { onButtonRobotClick() }
        waitingIconLlm = keyboardView!!.findViewById(R.id.pb_waiting_icon_llm)

        buttonMic!!.setOnClickListener { onButtonMicClick() }
        buttonCancel!!.setOnClickListener { onButtonCancelClick() }
        buttonRetry!!.setOnClickListener { onButtonRetryClick() }
        buttonSettings!!.setOnClickListener { onButtonSettingsClick() }

        this.onStartRecording = onStartRecording; this.onCancelRecording = onCancelRecording
        this.onStartTranscribing = onStartTranscribing; this.onCancelTranscribing = onCancelTranscribing
        this.onButtonBackspace = onButtonBackspace; this.onSwitchIme = onSwitchIme
        this.onOpenSettings = onOpenSettings; this.onEnter = onEnter; this.onSpaceBar = onSpaceBar
        this.shouldShowRetry = shouldShowRetry; this.onKey = onKey; this.onCheck = onCheck
        this.onEmoji = onEmoji; this.onPlayClickSound = onPlayClickSound

        updateCapsLockState()

        tts = TextToSpeech(keyboardView!!.context, this)
        reset(); return keyboardView!!
    }

    private fun setupDragListeners() {
        val dragListener = View.OnDragListener { v, event ->
            when (event.action) {
                DragEvent.ACTION_DRAG_STARTED -> {
                    // Highlight potential destinations when drag begins
                    v.setBackgroundColor(Color.parseColor("#80FAFA33")) // playful_yellow with 50% alpha
                    event.clipDescription.hasMimeType(ClipDescription.MIMETYPE_TEXT_PLAIN)
                }
                DragEvent.ACTION_DRAG_ENTERED -> {
                    // Stronger highlight when hovering over a specific box
                    v.setBackgroundColor(Color.parseColor("#FAFA33")) // Solid playful_yellow
                    true
                }
                DragEvent.ACTION_DRAG_EXITED -> {
                    // Return to potential highlight
                    v.setBackgroundColor(Color.parseColor("#80FAFA33"))
                    true
                }
                DragEvent.ACTION_DROP -> {
                    v.setBackgroundResource(R.drawable.status_box_background)
                    val item = event.clipData.getItemAt(0)
                    val rawData = item.text.toString()
                    val parts = rawData.split(":", limit = 3)
                    
                    if (parts.size >= 2) {
                        try {
                            if (v.id == R.id.container_status_list) {
                                val idx = parts[0].toIntOrNull() ?: -1
                                if (idx != -1) highlightWordAtOffset(idx)
                            } else if (v.id == R.id.container_status_robot) {
                                val start = parts[0].toInt()
                                val end = parts[1].toInt()
                                val droppedWord = if (parts.size >= 3 && parts[2].isNotBlank()) {
                                    parts[2]
                                } else {
                                    mainSpokenText.substring(start, end)
                                }
                                onRobotDropWord(start, end, droppedWord)
                            } else if (v.id == R.id.container_status_trash) {
                                val start = parts[0].toInt()
                                val end = parts[1].toInt()
                                val sb = StringBuilder(mainSpokenText)
                                
                                // Clean up spacing
                                if (end < sb.length && sb[end] == ' ') {
                                    sb.delete(start, end + 1)
                                } else if (start > 0 && sb[start - 1] == ' ') {
                                    sb.delete(start - 1, end)
                                } else {
                                    sb.delete(start, end)
                                }
                                
                                val newText = sb.toString().trim().replace(Regex("\\s+"), " ")
                                setSpellCheckedText(newText); onPlayClickSound()
                            } else if (v.id == R.id.container_status_mic) {
                                val start = parts[0].toInt()
                                val end = parts[1].toInt()
                                SurgicalState.targetRange = Pair(start, end)
                                SurgicalState.isPerformingSubstitution = true
                                Log.d(TAG, "ACTION_DROP (mic): global substitution ARMED for range $start:$end")
                                
                                // Visual highlight: pulsing red if we are about to start a surgical recording
                                val wordIdx = wordBoundaries.indexOfFirst { it.first == start && it.second == end }
                                if (wordIdx != -1) {
                                    startPulsingHighlight(wordIdx)
                                }
                                onButtonMicClick()
                            }
                        } catch (e: Exception) {
                            Log.e(TAG, "Failed to parse drag data: $rawData", e)
                        }
                    }
                    true
                }
                DragEvent.ACTION_DRAG_ENDED -> {
                    // Absolute reset once drag is finished
                    v.setBackgroundResource(R.drawable.status_box_background)
                    true
                }
                else -> false
            }
        }

        containerStatusMic?.setOnDragListener(dragListener)
        containerStatusList?.setOnDragListener(dragListener)
        containerStatusRobot?.setOnDragListener(dragListener)
        containerStatusTrash?.setOnDragListener(dragListener)

        val transcriptDragListener = View.OnDragListener { _, event ->
            when (event.action) {
                DragEvent.ACTION_DRAG_STARTED -> {
                    event.clipDescription.hasMimeType(ClipDescription.MIMETYPE_TEXT_PLAIN)
                }
                DragEvent.ACTION_DROP -> {
                    val rawData = event.clipData.getItemAt(0).text.toString()
                    val parts = rawData.split(":", limit = 3)
                    if (parts.size >= 2) {
                        try {
                            val start = parts[0].toInt()
                            val end = parts[1].toInt()
                            moveWordWithinTranscript(start, end, event.x, event.y)
                        } catch (e: Exception) {
                            Log.e(TAG, "Failed to parse transcript drag data: $rawData", e)
                        }
                    }
                    true
                }
                else -> true
            }
        }

        spellCheckedTextView?.setOnDragListener(transcriptDragListener)
    }

    private fun moveWordWithinTranscript(start: Int, end: Int, dropX: Float, dropY: Float) {
        if (mainSpokenText.isBlank() || wordBoundaries.isEmpty()) return

        val sourceIndex = wordBoundaries.indexOfFirst { it.first == start && it.second == end }
        if (sourceIndex == -1) return

        val insertionIndex = findInsertionIndexAt(dropX, dropY)
        if (insertionIndex == -1) return

        val words = wordBoundaries.map { (s, e) -> mainSpokenText.substring(s, e) }.toMutableList()
        val movedWord = words.removeAt(sourceIndex)

        val adjustedInsertIndex = if (insertionIndex > sourceIndex) insertionIndex - 1 else insertionIndex
        if (adjustedInsertIndex == sourceIndex) return

        words.add(adjustedInsertIndex.coerceIn(0, words.size), movedWord)
        setSpellCheckedText(words.joinToString(" "))
        onPlayClickSound()
    }

    private fun findInsertionIndexAt(x: Float, y: Float): Int {
        val tv = spellCheckedTextView ?: return -1
        val layout = tv.layout ?: return -1

        val xAdj = x - tv.totalPaddingLeft + tv.scrollX
        val yAdj = y - tv.totalPaddingTop + tv.scrollY
        val clampedY = yAdj.toInt().coerceIn(0, layout.height.coerceAtLeast(1) - 1)
        val line = layout.getLineForVertical(clampedY)
        val offset = layout.getOffsetForHorizontal(line, xAdj)

        for ((idx, range) in wordBoundaries.withIndex()) {
            if (offset < range.first) return idx
            if (offset <= range.second) {
                val middle = (range.first + range.second) / 2
                return if (offset < middle) idx else idx + 1
            }
        }
        return wordBoundaries.size
    }

    private class WordChipDragShadowBuilder(val context: android.content.Context, val word: String) : View.DragShadowBuilder() {
        private val textView = TextView(context).apply {
            layoutParams = ViewGroup.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT)
            textSize = 45f // Match main text size
            setTextColor(Color.WHITE)
            text = SpannableStringBuilder(word).apply {
                setSpan(RoundedBackgroundSpan(CHIP_BACKGROUND_COLOR), 0, word.length, Spanned.SPAN_EXCLUSIVE_EXCLUSIVE)
            }
            // Add padding to prevent clipping in the shadow
            setPadding(40, 20, 40, 20)
            gravity = Gravity.CENTER
        }

        override fun onProvideShadowMetrics(size: Point, touch: Point) {
            val widthSpec = View.MeasureSpec.makeMeasureSpec(0, View.MeasureSpec.UNSPECIFIED)
            val heightSpec = View.MeasureSpec.makeMeasureSpec(0, View.MeasureSpec.UNSPECIFIED)
            textView.measure(widthSpec, heightSpec)
            size.set(textView.measuredWidth, textView.measuredHeight)
            touch.set(size.x / 2, size.y / 2)
        }

        override fun onDrawShadow(canvas: Canvas) {
            textView.layout(0, 0, textView.measuredWidth, textView.measuredHeight)
            textView.draw(canvas)
        }
    }
}
