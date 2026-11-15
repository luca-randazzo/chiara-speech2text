package com.example.whispertoinput

import com.example.whispertoinput.keyboard.WhisperKeyboard
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class ExampleUnitTest {
    @Test
    fun deleteButton_shouldBeHidden_whenTranscriptIsEmpty() {
        assertFalse(WhisperKeyboard.shouldShowDeleteButton(""))
        assertFalse(WhisperKeyboard.shouldShowDeleteButton("   "))
        assertFalse(WhisperKeyboard.shouldShowDeleteButton(null))
    }

    @Test
    fun deleteButton_shouldBeVisible_whenTranscriptHasText() {
        assertTrue(WhisperKeyboard.shouldShowDeleteButton("HELLO"))
        assertTrue(WhisperKeyboard.shouldShowDeleteButton("  HELLO  "))
    }
}