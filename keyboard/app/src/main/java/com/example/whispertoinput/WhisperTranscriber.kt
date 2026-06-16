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

import android.content.Context
import android.media.AudioManager
import android.media.ToneGenerator
import android.os.Handler
import android.os.Looper
import android.util.Log
import android.widget.Toast
import androidx.datastore.preferences.core.Preferences
import kotlinx.coroutines.*
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.map
import okhttp3.Headers
import okhttp3.MediaType.Companion.toMediaTypeOrNull
import okhttp3.MultipartBody
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody
import okhttp3.RequestBody.Companion.asRequestBody
import java.io.File
import java.io.InterruptedIOException
import java.util.concurrent.TimeUnit
import com.github.liuyueyi.quick.transfer.ChineseUtils

class WhisperTranscriber {
    private data class Config(
        val endpoint: String,
        val secondaryEndpoint: String,
        val languageCode: String,
        val speechToTextBackend: String,
        val apiKey: String,
        val model: String,
        val postprocessing: String,
        val addTrailingSpace: Boolean
    )

    private val TAG = "WhisperTranscriber"
    private val transcriptionTimeoutMs = 20_000L
    private var currentTranscriptionJob: Job? = null

    fun startAsync(
        context: Context,
        filename: String,
        mediaType: String,
        attachToEnd: String,
        callback: (String?) -> Unit,
        exceptionCallback: (String) -> Unit
    ) {
        suspend fun makeWhisperRequest(): String {
            // Retrieve configs
            val (endpoint, secondaryEndpoint, languageCode, speechToTextBackend, apiKey, model, postprocessing, addTrailingSpace) = context.dataStore.data.map { preferences: Preferences ->
                Config(
                    preferences[ASR_WHISPER_MODEL_ENDPOINT]
                        ?: preferences[ENDPOINT]
                        ?: context.getString(R.string.settings_option_asr_primary_model_default),
                    preferences[BACKUP_MODEL_ENDPOINT]
                        ?: preferences[SECONDARY_ENDPOINT]
                        ?: context.getString(R.string.settings_option_backup_model_default),
                    preferences[LANGUAGE_CODE] ?: "",
                    preferences[SPEECH_TO_TEXT_BACKEND] ?: context.getString(R.string.settings_option_openai_api),
                    preferences[API_KEY] ?: "",
                    preferences[MODEL] ?: "",
                    preferences[POSTPROCESSING] ?: context.getString(R.string.settings_option_no_conversion),
                    preferences[ADD_TRAILING_SPACE] ?: false
                )
            }.first()

            // Foolproof message
            if (endpoint.isBlank() && secondaryEndpoint.isBlank()) {
                throw Exception(context.getString(R.string.error_endpoint_unset))
            }

            val client = OkHttpClient.Builder()
                .callTimeout(transcriptionTimeoutMs, TimeUnit.MILLISECONDS)
                .connectTimeout(3, TimeUnit.SECONDS)
                .readTimeout(5, TimeUnit.MINUTES)
                .writeTimeout(5, TimeUnit.MINUTES)
                .build()

            var lastException: Exception? = null

            val endpointsToTry = listOf(endpoint, secondaryEndpoint).filter { it.isNotBlank() }
            var firstAttempt = true

            for (currentEndpoint in endpointsToTry) {
                try {
                    val request = buildWhisperRequest(
                        context,
                        filename,
                        mediaType,
                        speechToTextBackend,
                        currentEndpoint,
                        languageCode,
                        apiKey,
                        model
                    )
                    val response = client.newCall(request).execute()
                    val responseBody = response.body?.string() ?: ""

                    if (response.isSuccessful && response.code / 100 == 2) {
                        Log.d(TAG, "Response from $currentEndpoint received: $responseBody")
                        var rawText = responseBody.trim()

                        if (rawText.startsWith("\"") && rawText.endsWith("\"")) {
                            rawText = rawText.substring(1, rawText.length - 1).trim()
                        }

                        val processedText = when (postprocessing) {
                            context.getString(R.string.settings_option_to_simplified) -> ChineseUtils.tw2s(rawText)
                            context.getString(R.string.settings_option_to_traditional) -> ChineseUtils.s2tw(rawText)
                            else -> rawText
                        }

                        return if (attachToEnd == "") {
                            processedText + if (addTrailingSpace) " " else ""
                        } else {
                            processedText + attachToEnd
                        }
                    } else {
                         Log.e(TAG, "Request to $currentEndpoint failed with code ${response.code}: $responseBody")
                         throw Exception("Request failed with code ${response.code}: ${responseBody.replace('\n', ' ')}")
                    }
                } catch (e: Exception) {
                    if (e is InterruptedIOException) {
                        throw e
                    }
                    lastException = e
                    Log.w(TAG, "Endpoint '$currentEndpoint' failed. Trying next endpoint.", e)

                    if (firstAttempt && endpointsToTry.size > 1) {
                        withContext(Dispatchers.Main) {
                            notifyPrimaryEndpointFailure(context)
                        }
                    }
                }
                firstAttempt = false
            }

            throw lastException ?: Exception("All endpoints failed.")
        }

        // Create a cancellable job in the main thread (for UI updating)
        val job = CoroutineScope(Dispatchers.Main).launch {

            // Within the job, make a suspend call at the I/O thread
            // It suspends before result is obtained.
            // Returns (transcribed string, exception message)
            val (transcribedText, exceptionMessage) = withContext(Dispatchers.IO) {
                try {
                    // Perform transcription here
                    val response = withTimeout(transcriptionTimeoutMs) {
                        makeWhisperRequest()
                    }
                    // Clean up unused audio file after transcription
                    // Ref: https://developer.android.com/reference/android/media/MediaRecorder#setOutputFile(java.io.File)
                    File(filename).delete()
                    return@withContext Pair(response, null)
                } catch (_: TimeoutCancellationException) {
                    return@withContext Pair(
                        null,
                        "Transcription timed out after ${transcriptionTimeoutMs / 1000} seconds."
                    )
                } catch (e: CancellationException) {
                    // Task was canceled
                    return@withContext Pair(null, null)
                } catch (e: Exception) {
                    return@withContext Pair(null, e.message)
                }
            }

            // This callback is in the main thread.
            callback.invoke(transcribedText)

            // If exception message is not null
            if (!exceptionMessage.isNullOrEmpty()) {
                Log.e(TAG, "[startAsync] Transcription exception: $exceptionMessage")
                exceptionCallback(exceptionMessage)
            }
        }

        registerTranscriptionJob(job)
    }

    fun stop() {
        registerTranscriptionJob(null)
    }

    private fun registerTranscriptionJob(job: Job?) {
        currentTranscriptionJob?.cancel()
        currentTranscriptionJob = job
    }

    private fun notifyPrimaryEndpointFailure(context: Context) {
        Toast.makeText(context, R.string.trying_fallback_endpoint, Toast.LENGTH_LONG).show()
        runCatching {
            val tone = ToneGenerator(AudioManager.STREAM_SYSTEM, 1000)
            val durationMs = 1000
            tone.startTone(ToneGenerator.TONE_PROP_NACK, durationMs)
            Handler(Looper.getMainLooper()).postDelayed(
                { tone.release() },
                (durationMs + 100).toLong()
            )
        }.onFailure { error ->
            Log.w(TAG, "Unable to play endpoint failure tone", error)
        }
    }

    private fun buildWhisperRequest(
        context: Context,
        filename: String,
        mediaType: String,
        speechToTextBackend: String, // This and other params are no longer used but kept for signature consistency
        endpoint: String,
        languageCode: String,
        apiKey: String,
        model: String
    ): Request {
        // A simple curl-like request: curl -H "Authorization: Bearer $hf_token" -F wav=@filename endpoint

        val hfToken = if (apiKey.isNotBlank()) apiKey else context.getString(R.string.hf_token)
        val audioFile = File(filename)
        if (!audioFile.exists()) {
            Log.e(TAG, "Audio file does not exist: $filename")
        } else {
            Log.d(TAG, "Audio file exists, size: ${audioFile.length()} bytes")
        }
        
        // We use "audio/mpeg" for .m4a files which is generally safer than "audio/mp4" 
        // for simple audio processing endpoints.
        val fileBody = audioFile.asRequestBody("audio/mpeg".toMediaTypeOrNull())

        val requestBody = MultipartBody.Builder()
            .setType(MultipartBody.FORM)
            // The filename "1.wav" is kept as requested, but the server logs 
            // show it's successfully converting it. The error happens during 
            // the actual transcription (Whisper processing).
            .addFormDataPart("wav", "1.wav", fileBody)
            .build()

        return Request.Builder()
            .url(endpoint) // Use the endpoint URL directly
            .addHeader("Authorization", "Bearer $hfToken")
            .post(requestBody)
            .build()
    }
}
