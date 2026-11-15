package com.example.whispertoinput

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File
import java.io.RandomAccessFile

class RecordingUtilsTest {
    @Test
    fun `returns true for recordings shorter than 500ms`() {
        val tempFile = createWavFile(durationMs = 400)
        try {
            assertTrue(RecordingUtils.isRecordingTooShort(tempFile.absolutePath, minDurationMs = 500L))
        } finally {
            tempFile.delete()
        }
    }

    @Test
    fun `returns false for recordings at least 500ms long`() {
        val tempFile = createWavFile(durationMs = 600)
        try {
            assertFalse(RecordingUtils.isRecordingTooShort(tempFile.absolutePath, minDurationMs = 500L))
        } finally {
            tempFile.delete()
        }
    }

    private fun createWavFile(durationMs: Int): File {
        val file = File.createTempFile("recording_test", ".wav")
        val sampleRate = 16000
        val dataBytes = (sampleRate * 2 * durationMs / 1000.0).toInt()
        val totalDataLen = dataBytes + 36
        val byteRate = sampleRate * 2

        val header = ByteArray(44)
        header[0] = 'R'.code.toByte(); header[1] = 'I'.code.toByte(); header[2] = 'F'.code.toByte(); header[3] = 'F'.code.toByte()
        header[4] = (totalDataLen and 0xff).toByte(); header[5] = ((totalDataLen shr 8) and 0xff).toByte(); header[6] = ((totalDataLen shr 16) and 0xff).toByte(); header[7] = ((totalDataLen shr 24) and 0xff).toByte()
        header[8] = 'W'.code.toByte(); header[9] = 'A'.code.toByte(); header[10] = 'V'.code.toByte(); header[11] = 'E'.code.toByte()
        header[12] = 'f'.code.toByte(); header[13] = 'm'.code.toByte(); header[14] = 't'.code.toByte(); header[15] = ' '.code.toByte()
        header[16] = 16; header[17] = 0; header[18] = 0; header[19] = 0
        header[20] = 1; header[21] = 0; header[22] = 1; header[23] = 0
        header[24] = (sampleRate and 0xff).toByte(); header[25] = ((sampleRate shr 8) and 0xff).toByte(); header[26] = ((sampleRate shr 16) and 0xff).toByte(); header[27] = ((sampleRate shr 24) and 0xff).toByte()
        header[28] = (byteRate and 0xff).toByte(); header[29] = ((byteRate shr 8) and 0xff).toByte(); header[30] = ((byteRate shr 16) and 0xff).toByte(); header[31] = ((byteRate shr 24) and 0xff).toByte()
        header[32] = 2; header[33] = 0; header[34] = 16; header[35] = 0
        header[36] = 'd'.code.toByte(); header[37] = 'a'.code.toByte(); header[38] = 't'.code.toByte(); header[39] = 'a'.code.toByte()
        header[40] = (dataBytes and 0xff).toByte(); header[41] = ((dataBytes shr 8) and 0xff).toByte(); header[42] = ((dataBytes shr 16) and 0xff).toByte(); header[43] = ((dataBytes shr 24) and 0xff).toByte()

        RandomAccessFile(file, "rw").use { raf ->
            raf.setLength(header.size.toLong() + dataBytes.toLong())
            raf.seek(0)
            raf.write(header)
            raf.seek(header.size.toLong())
            raf.write(ByteArray(dataBytes))
        }

        return file
    }
}
