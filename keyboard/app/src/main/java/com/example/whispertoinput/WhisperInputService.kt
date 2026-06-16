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

package com.example.whispertoinput

import android.inputmethodservice.InputMethodService
import android.os.Build
import android.view.View
import android.content.Intent
import android.media.AudioManager
import android.media.ToneGenerator
import android.os.IBinder
import android.text.TextUtils
import android.view.KeyEvent
import android.view.inputmethod.EditorInfo
import android.view.inputmethod.InputMethodManager
import android.widget.Toast
import android.util.Log
import androidx.datastore.preferences.core.Preferences
import com.example.whispertoinput.keyboard.WhisperKeyboard
import com.example.whispertoinput.recorder.RecorderManager
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import java.io.File
import java.net.URL
import java.util.Locale
import org.json.JSONObject
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.MediaType.Companion.toMediaTypeOrNull
import java.util.concurrent.TimeUnit

private const val RECORDED_AUDIO_FILENAME_M4A = "recorded.m4a"
private const val RECORDED_AUDIO_FILENAME_OGG = "recorded.ogg"
private const val AUDIO_MEDIA_TYPE_M4A = "audio/mp4"
private const val AUDIO_MEDIA_TYPE_OGG = "audio/ogg"
private const val IME_SWITCH_OPTION_AVAILABILITY_API_LEVEL = 28
private const val VOCABULARY_URL = "https://raw.githubusercontent.com/hermitdave/FrequencyWords/master/content/2018/it/it_50k.txt"

class WhisperInputService : InputMethodService() {
    private val whisperKeyboard: WhisperKeyboard = WhisperKeyboard()
    private val whisperTranscriber: WhisperTranscriber = WhisperTranscriber()
    private var recorderManager: RecorderManager? = null
    private var recordedAudioFilename: String = ""
    private var audioMediaType: String = AUDIO_MEDIA_TYPE_M4A
    private var useOggFormat: Boolean = false
    private var isFirstTime: Boolean = true
    private var toneGenerator: ToneGenerator? = null

    override fun onCreate() {
        super.onCreate()
        toneGenerator = ToneGenerator(AudioManager.STREAM_SYSTEM, 100)
        downloadVocabulary()
    }

    private fun downloadVocabulary() {
        CoroutineScope(Dispatchers.IO).launch {
            try {
                val vocabFile = File(cacheDir, "italian_vocab.txt")
                if (!vocabFile.exists()) {
                    Log.d("WhisperInputService", "Downloading vocabulary from $VOCABULARY_URL")
                    val text = URL(VOCABULARY_URL).readText()
                    vocabFile.writeText(text)
                }
                val words = vocabFile.readLines()
                    .filter { it.isNotBlank() }
                    .map { it.split(" ")[0].lowercase() }
                
                withContext(Dispatchers.Main) {
                    whisperKeyboard.setVocabulary(words)
                    Log.d("WhisperInputService", "Vocabulary loaded: ${words.size} words")
                }
            } catch (e: Exception) {
                Log.e("WhisperInputService", "Failed to download vocabulary", e)
            }
        }
    }

    override fun onDestroy() {
        super.onDestroy()
        whisperKeyboard.destroy()
        toneGenerator?.release()
    }

    private fun transcriptionCallback(text: String?) {
        val wasConsumed = whisperKeyboard.handleTranscriptionResult(text)
        Log.d("WhisperInputService", "transcriptionCallback: text='$text', wasConsumed=$wasConsumed")
        
        if (!text.isNullOrEmpty() && !wasConsumed) {
            whisperKeyboard.speakFullTranscript()
            whisperKeyboard.setResultsVisibility(true)
            whisperKeyboard.setKeyboardStatus(WhisperKeyboard.KeyboardStatus.Idle)
        } else if (wasConsumed) {
            // Surgical replacement handled its own TTS and status needs to reach Idle eventually
            whisperKeyboard.setKeyboardStatus(WhisperKeyboard.KeyboardStatus.Idle)
        }
    }

    private fun transcriptionExceptionCallback(message: String) {
        Toast.makeText(this, message, Toast.LENGTH_LONG).show()
        Log.e("WhisperInputService", "[transcriptionExceptionCallback] Transcription exception: $message")
        // Server-side errors should be visible in the toast only, not spoken aloud.
        whisperKeyboard.reset()
    }

    private suspend fun updateAudioFormat() {
        val backend = dataStore.data.map { preferences: Preferences ->
            preferences[SPEECH_TO_TEXT_BACKEND] ?: getString(R.string.settings_option_openai_api)
        }.first()
        
        useOggFormat = backend == getString(R.string.settings_option_nvidia_nim)
        if (useOggFormat) {
            recordedAudioFilename = "${externalCacheDir?.absolutePath}/${RECORDED_AUDIO_FILENAME_OGG}"
            audioMediaType = AUDIO_MEDIA_TYPE_OGG
        } else {
            recordedAudioFilename = "${externalCacheDir?.absolutePath}/${RECORDED_AUDIO_FILENAME_M4A}"
            audioMediaType = AUDIO_MEDIA_TYPE_M4A
        }
    }

    override fun onCreateInputView(): View {
        // Initialize members with regard to this context
        recorderManager = RecorderManager(this)

        // Initialize audio format based on backend setting
        CoroutineScope(Dispatchers.Main).launch {
            updateAudioFormat()
        }

        // Sets up recorder manager
        recorderManager!!.setOnUpdateMicrophoneAmplitude { amplitude ->
            onUpdateMicrophoneAmplitude(amplitude)
        }

        recorderManager!!.setOnProgressUpdate { progress ->
            onUpdateProgressBar(progress)
        }

        // Returns the keyboard after setting it up and inflating its layout
        return whisperKeyboard.setup(
            layoutInflater,
            onStartRecording = { onStartRecording() },
            onCancelRecording = { onCancelRecording() },
            onStartTranscribing = { attachToEnd -> onStartTranscription(attachToEnd) },
            onCancelTranscribing = { onCancelTranscription() },
            onButtonBackspace = { onDeleteText() },
            onEnter = { onEnter() },
            onSpaceBar = { onSpaceBar() },
            onSwitchIme = { onSwitchIme() },
            onOpenSettings = { onOpenSettings() },
            onKey = { character ->
                val ic = currentInputConnection
                ic?.commitText(character.toString(), 1)
            },
            onCheck = { text -> onCheck(text) },
            onEmoji = { emoji ->
                val ic = currentInputConnection
                ic?.commitText(emoji, 1)
            },
            shouldShowRetry = { shouldShowRetry() },
            onPlayClickSound = { onPlayClickSound() }
        )
    }

    private fun onPlayClickSound() {
        toneGenerator?.startTone(ToneGenerator.TONE_CDMA_CONFIRM, 5)
    }

    private fun onCheck(text: String) {
        val lowercaseText = text.lowercase(Locale.ROOT)
        currentInputConnection?.commitText(lowercaseText + "\n", 1)

        // Clear the transcript from the keyboard view after accepting it
        whisperKeyboard.clearTranscript()

        // Send validation request to server
        CoroutineScope(Dispatchers.IO).launch {
            try {
                val endpoint = dataStore.data.map { preferences: Preferences ->
                    preferences[ASR_WHISPER_MODEL_ENDPOINT]
                        ?: preferences[ENDPOINT]
                        ?: getString(R.string.settings_option_asr_primary_model_default)
                }.first()

                val validateEndpoint = endpoint.replace(Regex("/transcribe/?$"), "/validate")

                val jsonBody = JSONObject().apply {
                    put("transcript", text)
                }

                val requestBody = jsonBody.toString().toRequestBody("application/json".toMediaTypeOrNull())

                val request = Request.Builder()
                    .url(validateEndpoint)
                    .post(requestBody)
                    .build()

                val client = OkHttpClient.Builder()
                    .connectTimeout(10, TimeUnit.SECONDS)
                    .build()

                client.newCall(request).execute().use { response ->
                    if (!response.isSuccessful) {
                        Log.e("WhisperInputService", "Validation request failed: ${response.code}")
                    } else {
                        Log.d("WhisperInputService", "Validation request successful")
                    }
                }
            } catch (e: Exception) {
                Log.e("WhisperInputService", "Error sending validation request", e)
            }
        }

        // Check if auto-switch-back is enabled and switch if so
        CoroutineScope(Dispatchers.Main).launch {
            val autoSwitchBack = dataStore.data.map { preferences: Preferences ->
                preferences[AUTO_SWITCH_BACK] ?: false
            }.first()
            if (autoSwitchBack) {
                onSwitchIme()
            }
        }
    }
    private fun onStartRecording() {
        CoroutineScope(Dispatchers.Main).launch {
            // Upon starting recording, check whether audio permission is granted.
            if (!recorderManager!!.allPermissionsGranted(this@WhisperInputService)) {
                // If not, launch app MainActivity (for permission setup).
                launchMainActivity()
                whisperKeyboard.reset()
                return@launch
            }

            val recordingDurationMs = dataStore.data.map { preferences: Preferences ->
                preferences[RECORDING_DURATION_MS] ?: 7500
            }.first()

            toneGenerator?.startTone(ToneGenerator.TONE_PROP_BEEP, 100)

            // handle timeout
            recorderManager!!.start(
                context = this@WhisperInputService,
                filename = recordedAudioFilename,
                maxDurationMs = recordingDurationMs,
                useOggFormat = useOggFormat,
                onMaxDurationReached = {
                    whisperKeyboard.setKeyboardStatus(WhisperKeyboard.KeyboardStatus.Transcribing)
                    this@WhisperInputService.onStartTranscription("")
                },
                onError = { message ->
                    Toast.makeText(this@WhisperInputService, message, Toast.LENGTH_LONG).show()
                    whisperKeyboard.reset()
                }
            )
        }
    }

    // when mic amplitude is updated, notify the keyboard
    // this callback is registered to the recorder manager
    private fun onUpdateMicrophoneAmplitude(amplitude: Int) {
        whisperKeyboard.updateMicrophoneAmplitude(amplitude)
    }

    private fun onUpdateProgressBar(progress: Int) {
        whisperKeyboard.updateProgressBar(progress)
    }

    private fun onCancelRecording() {
        toneGenerator?.startTone(ToneGenerator.TONE_PROP_BEEP, 100)
        recorderManager!!.stop()
    }

    private fun onStartTranscription(attachToEnd: String) {
        toneGenerator?.startTone(ToneGenerator.TONE_PROP_BEEP, 100)
        recorderManager!!.stop()
        whisperTranscriber.startAsync(this,
            recordedAudioFilename,
            audioMediaType,
            attachToEnd,
            { transcriptionCallback(it) },
            { transcriptionExceptionCallback(it) })
    }

    private fun onCancelTranscription() {
        whisperTranscriber.stop()
    }

    private fun onDeleteText() {
        val inputConnection = currentInputConnection ?: return
        val selectedText = inputConnection.getSelectedText(0)

        // Deletes cursor pointed text, or all selected texts
        if (TextUtils.isEmpty(selectedText)) {
            inputConnection.deleteSurroundingText(1, 0)
        } else {
            inputConnection.commitText("", 1)
        }
    }

    private fun onSwitchIme() {
        // Before API Level 28, switchToPreviousInputMethod() was not available
        if (Build.VERSION.SDK_INT >= IME_SWITCH_OPTION_AVAILABILITY_API_LEVEL) {
            switchToPreviousInputMethod()
        } else {
            val inputMethodManager = getSystemService(INPUT_METHOD_SERVICE) as InputMethodManager
            val token: IBinder? = window?.window?.attributes?.token
            @Suppress("DEPRECATION")
            inputMethodManager.switchToLastInputMethod(token)
        }

    }

    private fun onOpenSettings() {
        launchMainActivity()
    }

    private fun onEnter() {
        val inputConnection = currentInputConnection ?: return
        if (sendDefaultEditorAction(true)) {
            return
        }

        val editorInfo = currentInputEditorInfo
        val actionId = (editorInfo?.imeOptions ?: 0) and EditorInfo.IME_MASK_ACTION
        if (actionId != EditorInfo.IME_ACTION_NONE && actionId != EditorInfo.IME_ACTION_UNSPECIFIED) {
            if (inputConnection.performEditorAction(actionId)) {
                return
            }
        }

        val sentDown = inputConnection.sendKeyEvent(KeyEvent(KeyEvent.ACTION_DOWN, KeyEvent.KEYCODE_ENTER))
        val sentUp = inputConnection.sendKeyEvent(KeyEvent(KeyEvent.ACTION_UP, KeyEvent.KEYCODE_ENTER))
        if (!sentDown && !sentUp) {
            inputConnection.commitText("\n", 1)
        }
    }

    private fun onSpaceBar() {
        val inputConnection = currentInputConnection ?: return
        inputConnection.commitText(" ", 1)
    }

    private fun shouldShowRetry(): Boolean {
        return File(recordedAudioFilename).exists()
    }

    // Opens up app MainActivity
    private fun launchMainActivity() {
        val dialogIntent = Intent(this, MainActivity::class.java)
        dialogIntent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        startActivity(dialogIntent)
    }

    override fun onEvaluateFullscreenMode(): Boolean {
        return false
    }

    override fun onWindowShown() {
        super.onWindowShown()
        whisperTranscriber.stop()
        whisperKeyboard.reset()
        recorderManager!!.stop()

        // If this is the first time calling onWindowShown, it means this IME is just being switched to.
        // Automatically starts recording after switching to Whisper Input. (if settings enabled)
        // Dispatch a coroutine to do this task.
        CoroutineScope(Dispatchers.Main).launch {
            // Update audio format based on current backend setting
            updateAudioFormat()
            if (!isFirstTime) return@launch
            isFirstTime = false
            
            val autoRecordingStart = dataStore.data.map { preferences: Preferences ->
                preferences[AUTO_RECORDING_START] ?: false
            }.first()
            if (autoRecordingStart) {
                whisperKeyboard.setKeyboardStatus(WhisperKeyboard.KeyboardStatus.Recording)
                onStartRecording()
            }
        }
    }
}
