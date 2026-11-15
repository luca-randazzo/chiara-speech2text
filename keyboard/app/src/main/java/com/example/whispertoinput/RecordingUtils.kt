package com.example.whispertoinput

import java.io.File
import java.io.RandomAccessFile

object RecordingUtils {
    const val MIN_RECORDING_DURATION_MS: Long = 500L

    fun isRecordingTooShort(filename: String, minDurationMs: Long = MIN_RECORDING_DURATION_MS): Boolean {
        val file = File(filename)
        if (!file.exists() || file.length() < 44L) {
            return true
        }

        return try {
            RandomAccessFile(file, "r").use { raf ->
                val header = ByteArray(44)
                raf.readFully(header)

                val channels = header.copyOfRange(22, 24).let {
                    it[0].toInt() and 0xFF or ((it[1].toInt() and 0xFF) shl 8)
                }
                val sampleRate = header.copyOfRange(24, 28).let {
                    ((it[0].toInt() and 0xFF) or
                        ((it[1].toInt() and 0xFF) shl 8) or
                        ((it[2].toInt() and 0xFF) shl 16) or
                        ((it[3].toInt() and 0xFF) shl 24))
                }
                val dataSize = header.copyOfRange(40, 44).let {
                    (it[0].toLong() and 0xFF) or
                        ((it[1].toLong() and 0xFF) shl 8) or
                        ((it[2].toLong() and 0xFF) shl 16) or
                        ((it[3].toLong() and 0xFF) shl 24)
                }

                if (sampleRate <= 0 || channels <= 0 || dataSize <= 0L) {
                    return true
                }

                val durationMs = (dataSize.toDouble() / (sampleRate * channels * 2.0)) * 1000.0
                durationMs < minDurationMs
            }
        } catch (_: Exception) {
            true
        }
    }
}
