package com.example.whispertoinput

import org.junit.Assert.assertEquals
import org.junit.Test

class WhisperTranscriberTest {
    @Test
    fun normalizeEndpoint_addsSchemeAndTrimsWhitespace() {
        val value = " 100.83.218.66:8000/transcribe \n"
        assertEquals("http://100.83.218.66:8000/transcribe", WhisperTranscriber.normalizeEndpoint(value))
    }

    @Test
    fun normalizeEndpoint_preservesValidUrl() {
        val value = "https://example.com/transcribe"
        assertEquals(value, WhisperTranscriber.normalizeEndpoint(value))
    }

    @Test
    fun formatRemoteServerErrorMessage_addsWarningEmojiForUnreachableServer() {
        val value = "Failed to connect to the remote server"
        assertEquals("𓃑 Failed to connect to the remote server", WhisperTranscriber.formatRemoteServerErrorMessage(value))
    }

    @Test
    fun formatRemoteServerErrorMessage_keepsRegularServerErrorsUnchanged() {
        val value = "Request failed with code 500: internal server error"
        assertEquals(value, WhisperTranscriber.formatRemoteServerErrorMessage(value))
    }
}
