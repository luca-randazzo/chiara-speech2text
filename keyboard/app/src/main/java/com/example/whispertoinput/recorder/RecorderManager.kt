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

package com.example.whispertoinput.recorder

import android.Manifest
import android.content.Context
import android.content.pm.PackageManager
import android.media.AudioFormat
import android.media.AudioManager
import android.media.AudioRecord
import android.media.MediaRecorder
import android.util.Log
import androidx.core.content.ContextCompat
import com.example.whispertoinput.R
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import java.io.File
import java.io.FileOutputStream
import java.io.IOException
import java.io.RandomAccessFile
import kotlin.math.sqrt

class RecorderManager(context: Context) {
    companion object {
        fun requiredPermissions() = arrayOf(
            Manifest.permission.RECORD_AUDIO,
            Manifest.permission.POST_NOTIFICATIONS,
        )
    }

    private var audioRecord: AudioRecord? = null
    private var isRecording = false
    private var recordingThread: Thread? = null
    private var onUpdateMicrophoneAmplitude: (Int) -> Unit = { }
    private var onProgressUpdate: (Int) -> Unit = { }
    private var progressUpdateJob: Job? = null
    private val amplitudeReportPeriod: Long
    private val context: Context

    private val sampleRate = 16000
    private val channelConfig = AudioFormat.CHANNEL_IN_MONO
    private val audioEncoding = AudioFormat.ENCODING_PCM_16BIT
    private val bufferSize = AudioRecord.getMinBufferSize(sampleRate, channelConfig, audioEncoding)

    init {
        this.context = context
        this.amplitudeReportPeriod =
            context.resources.getInteger(R.integer.recorder_amplitude_report_period).toLong()
    }

    fun start(
        context: Context,
        filename: String,
        useOggFormat: Boolean = false,
        maxDurationMs: Int = 0,
        onMaxDurationReached: () -> Unit = {},
        onError: (String) -> Unit = {}
    ) {
        stop()

        val file = File(filename)
        if (file.exists()) {
            file.delete()
        }

        if (ContextCompat.checkSelfPermission(context, Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) {
            Log.e("RecorderManager", "Permission not granted")
            onError("Permission not granted")
            return
        }

        // Check if microphone is likely in use by checking audio mode (e.g., in a call)
        val audioManager = context.getSystemService(Context.AUDIO_SERVICE) as AudioManager
        if (audioManager.mode == AudioManager.MODE_IN_CALL || audioManager.mode == AudioManager.MODE_IN_COMMUNICATION) {
            Log.e("RecorderManager", "Microphone is likely in use (mode: ${audioManager.mode})")
            onError(context.getString(R.string.error_mic_in_use))
            return
        }

        try {
            // Using VOICE_RECOGNITION source as it's more appropriate for STT 
            // and might have better priority handling in some Android versions.
            audioRecord = AudioRecord(
                MediaRecorder.AudioSource.VOICE_RECOGNITION,
                sampleRate,
                channelConfig,
                audioEncoding,
                bufferSize
            )

            if (audioRecord?.state != AudioRecord.STATE_INITIALIZED) {
                Log.e("RecorderManager", "AudioRecord initialization failed")
                onError(context.getString(R.string.error_mic_in_use))
                return
            }

            audioRecord?.startRecording()
            
            if (audioRecord?.recordingState != AudioRecord.RECORDSTATE_RECORDING) {
                Log.e("RecorderManager", "AudioRecord startRecording failed (state: ${audioRecord?.recordingState})")
                onError(context.getString(R.string.error_mic_in_use))
                return
            }

        } catch (e: Exception) {
            Log.e("RecorderManager", "Error starting AudioRecord", e)
            onError(context.getString(R.string.error_mic_in_use))
            return
        }

        isRecording = true

        recordingThread = Thread {
            val data = ByteArray(bufferSize)
            var totalRead = 0
            try {
                FileOutputStream(filename).use { os ->
                    // Leave space for 44-byte WAV header
                    os.write(ByteArray(44))
                    var totalLength = 0L
                    val startTime = System.currentTimeMillis()

                    while (isRecording) {
                        val read = audioRecord?.read(data, 0, bufferSize) ?: 0
                        if (read > 0) {
                            os.write(data, 0, read)
                            totalLength += read
                            totalRead += read
                            
                            // Calculate amplitude (RMS)
                            val amplitude = calculateAmplitude(data, read)
                            // Run UI updates on the main thread
                            CoroutineScope(Dispatchers.Main).launch {
                                onUpdateMicrophoneAmplitude(amplitude)
                            }
                        } else if (read < 0) {
                             Log.e("RecorderManager", "AudioRecord read error: $read")
                             if (totalRead == 0) {
                                 isRecording = false
                                 CoroutineScope(Dispatchers.Main).launch {
                                     onError(context.getString(R.string.error_mic_in_use))
                                 }
                             }
                             break
                        } else if (read == 0) {
                            // On some devices, read returning 0 repeatedly means mic is blocked
                            // We can wait a bit or check if this persists.
                            // For simplicity, if we get many consecutive 0s, we could trigger an error.
                            // But usually, read() blocks if no data is available. 
                            // Returning 0 immediately in blocking mode is often a sign of preemption.
                            Log.w("RecorderManager", "AudioRecord read 0 bytes")
                            if (totalRead == 0 && (System.currentTimeMillis() - startTime) > 500) {
                                Log.e("RecorderManager", "Microphone seems stuck/blocked (read 0 for 500ms)")
                                isRecording = false
                                CoroutineScope(Dispatchers.Main).launch {
                                    onError(context.getString(R.string.error_mic_in_use))
                                }
                                break
                            }
                        }

                        if (maxDurationMs > 0 && (System.currentTimeMillis() - startTime) >= maxDurationMs) {
                            CoroutineScope(Dispatchers.Main).launch {
                                onMaxDurationReached()
                            }
                            break
                        }
                    }
                    
                    // After recording stops, update WAV header
                    writeWavHeader(file, totalLength)
                }
            } catch (e: IOException) {
                Log.e("RecorderManager", "Recording failed", e)
            }
        }
        recordingThread?.start()

        // Start a job to periodically report recording progress
        progressUpdateJob?.cancel()
        if (maxDurationMs > 0) {
            progressUpdateJob = CoroutineScope(Dispatchers.Main).launch {
                val startTime = System.currentTimeMillis()
                while (isRecording) {
                    val elapsedTime = System.currentTimeMillis() - startTime
                    val progress = ((elapsedTime.toFloat() / maxDurationMs) * 100).toInt()
                    onProgressUpdate(progress.coerceIn(0, 100))
                    if (elapsedTime >= maxDurationMs) {
                        break
                    }
                    delay(100) // Update progress every 100ms
                }
            }
        }
    }

    private fun calculateAmplitude(data: ByteArray, size: Int): Int {
        var sum = 0.0
        for (i in 0 until size step 2) {
            val sample = (data[i].toInt() and 0xFF) or (data[i + 1].toInt() shl 8)
            sum += sample * sample
        }
        return sqrt(sum / (size / 2)).toInt()
    }

    private fun writeWavHeader(file: File, pcmLength: Long) {
        val totalDataLen = pcmLength + 36
        val byteRate = sampleRate * 2 // 16 bit * 1 channel / 8 bits per byte

        val header = ByteArray(44)
        header[0] = 'R'.toByte() // RIFF
        header[1] = 'I'.toByte()
        header[2] = 'F'.toByte()
        header[3] = 'F'.toByte()
        header[4] = (totalDataLen and 0xff).toByte()
        header[5] = ((totalDataLen shr 8) and 0xff).toByte()
        header[6] = ((totalDataLen shr 16) and 0xff).toByte()
        header[7] = ((totalDataLen shr 24) and 0xff).toByte()
        header[8] = 'W'.toByte() // WAVE
        header[9] = 'A'.toByte()
        header[10] = 'V'.toByte()
        header[11] = 'E'.toByte()
        header[12] = 'f'.toByte() // 'fmt ' chunk
        header[13] = 'm'.toByte()
        header[14] = 't'.toByte()
        header[15] = ' '.toByte()
        header[16] = 16 // 4 bytes: size of 'fmt ' chunk
        header[17] = 0
        header[18] = 0
        header[19] = 0
        header[20] = 1 // format = 1 (PCM)
        header[21] = 0
        header[22] = 1 // channels = 1
        header[23] = 0
        header[24] = (sampleRate and 0xff).toByte()
        header[25] = ((sampleRate shr 8) and 0xff).toByte()
        header[26] = ((sampleRate shr 16) and 0xff).toByte()
        header[27] = ((sampleRate shr 24) and 0xff).toByte()
        header[28] = (byteRate and 0xff).toByte()
        header[29] = ((byteRate shr 8) and 0xff).toByte()
        header[30] = ((byteRate shr 16) and 0xff).toByte()
        header[31] = ((byteRate shr 24) and 0xff).toByte()
        header[32] = 2 // block align
        header[33] = 0
        header[34] = 16 // bits per sample
        header[35] = 0
        header[36] = 'd'.toByte() // data
        header[37] = 'a'.toByte()
        header[38] = 't'.toByte()
        header[39] = 'a'.toByte()
        header[40] = (pcmLength and 0xff).toByte()
        header[41] = ((pcmLength shr 8) and 0xff).toByte()
        header[42] = ((pcmLength shr 16) and 0xff).toByte()
        header[43] = ((pcmLength shr 24) and 0xff).toByte()

        RandomAccessFile(file, "rw").use { raf ->
            raf.seek(0)
            raf.write(header)
        }
    }

    fun stop() {
        isRecording = false
        audioRecord?.apply {
            if (state == AudioRecord.STATE_INITIALIZED) {
                try {
                    stop()
                } catch (e: IllegalStateException) {
                    Log.e("RecorderManager", "stop() failed", e)
                }
            }
            release()
        }
        audioRecord = null
        recordingThread = null

        progressUpdateJob?.cancel()
        progressUpdateJob = null
    }

    fun setOnUpdateMicrophoneAmplitude(onUpdateMicrophoneAmplitude: (Int) -> Unit) {
        this.onUpdateMicrophoneAmplitude = onUpdateMicrophoneAmplitude
    }

    fun setOnProgressUpdate(onProgressUpdate: (Int) -> Unit) {
        this.onProgressUpdate = onProgressUpdate
    }

    fun allPermissionsGranted(context: Context): Boolean {
        for (permission in requiredPermissions()) {
            if (ContextCompat.checkSelfPermission(
                    context,
                    permission
                ) != PackageManager.PERMISSION_GRANTED
            ) {
                return false
            }
        }
        return true
    }
}
