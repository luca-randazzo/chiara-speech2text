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

import androidx.appcompat.app.AppCompatActivity
import android.os.Bundle
import androidx.core.app.ActivityCompat
import android.Manifest
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.VibrationEffect
import android.os.Vibrator
import android.provider.*
import android.util.Log
import android.view.View
import android.view.inputmethod.InputMethodManager
import android.widget.AdapterView
import android.widget.Button
import android.widget.CheckBox
import android.widget.EditText
import android.widget.Spinner
import android.widget.Toast
import androidx.core.content.ContextCompat
import androidx.core.widget.doOnTextChanged
import androidx.datastore.core.DataStore
import androidx.datastore.preferences.core.Preferences
import androidx.datastore.preferences.core.booleanPreferencesKey
import androidx.datastore.preferences.core.edit
import androidx.datastore.preferences.core.stringPreferencesKey
import androidx.datastore.preferences.preferencesDataStore
import androidx.datastore.preferences.core.intPreferencesKey
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.joinAll
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking

// 200 and 201 are an arbitrary values, as long as they do not conflict with each other
private const val MICROPHONE_PERMISSION_REQUEST_CODE = 200
private const val NOTIFICATION_PERMISSION_REQUEST_CODE = 201
val Context.dataStore: DataStore<Preferences> by preferencesDataStore(name = "settings")
val SPEECH_TO_TEXT_BACKEND = stringPreferencesKey("speech-to-text-backend")
val ENDPOINT = stringPreferencesKey("endpoint")
val SECONDARY_ENDPOINT = stringPreferencesKey("secondary_endpoint")
val LANGUAGE_CODE = stringPreferencesKey("language-code")
val API_KEY = stringPreferencesKey("api-key")
val MODEL = stringPreferencesKey("model")
val AUTO_RECORDING_START = booleanPreferencesKey("is-auto-recording-start")
val AUTO_SWITCH_BACK = booleanPreferencesKey("auto-switch-back")
val ADD_TRAILING_SPACE = booleanPreferencesKey("add-trailing-space")
val POSTPROCESSING = stringPreferencesKey("postprocessing")
val RECORDING_DURATION_MS = intPreferencesKey("recording_duration_ms")
// Generation section
val ASR_MODEL = stringPreferencesKey("asr-model")
val MAX_RECORDING_DURATION_MS = intPreferencesKey("max_recording_duration_ms")
val PROMPT_FOR_LLM = stringPreferencesKey("prompt-for-llm")
val LEADING_STRING = stringPreferencesKey("leading-string")
val TRAILING_SPACE = booleanPreferencesKey("trailing-space")
val TRAILING_NEWLINE = booleanPreferencesKey("trailing-newline")
// Endpoints section
val ASR_WHISPER_MODEL_ENDPOINT = stringPreferencesKey("asr-whisper-model-endpoint")
val ASR_CANARY_MODEL_ENDPOINT = stringPreferencesKey("asr-canary-model-endpoint")
val LLM_MODEL_ENDPOINT = stringPreferencesKey("llm-model-endpoint")
val BACKUP_MODEL_ENDPOINT = stringPreferencesKey("backup-model-endpoint")
// Visualization section
val HF_TOKEN = stringPreferencesKey("hf-token")
// Emoji section
val RECENT_EMOJIS = stringPreferencesKey("recent-emojis")

class MainActivity : AppCompatActivity() {
    private companion object {
        const val TAG = "MainActivity"
        const val INSTALL_STATE_PREFS = "install_state_prefs"
        const val LAST_HANDLED_UPDATE_TIME = "last_handled_update_time"
    }

    private var setupSettingItemsDone: Boolean = false

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_main)
        val resetOnInstallOrUpdate = resetUserSettingsOnInstallOrUpdate()
        setupSettingItems()
        checkPermissions()

        if (resetOnInstallOrUpdate) {
            // Reinstall/fresh install/update: try to make this IME active/default.
            setKeyboardAsDefault()
        }

        findViewById<Button>(R.id.btn_manage_keyboards).setOnClickListener {
            val intent = Intent(Settings.ACTION_INPUT_METHOD_SETTINGS)
            startActivity(intent)
        }
    }

    private fun resetUserSettingsOnInstallOrUpdate(): Boolean {
        val installStatePrefs = getSharedPreferences(INSTALL_STATE_PREFS, Context.MODE_PRIVATE)
        val lastHandledUpdateTime = installStatePrefs.getLong(LAST_HANDLED_UPDATE_TIME, -1L)
        val currentUpdateTime = getCurrentPackageUpdateTime()
        val shouldResetSettings = currentUpdateTime != lastHandledUpdateTime
        if (!shouldResetSettings) return false

        runBlocking {
            dataStore.edit { preferences ->
                preferences.clear()
            }
        }
        getSharedPreferences("emoji_prefs", Context.MODE_PRIVATE).edit().clear().apply()
        getSharedPreferences("app_prefs", Context.MODE_PRIVATE).edit().clear().apply()
        installStatePrefs.edit().putLong(LAST_HANDLED_UPDATE_TIME, currentUpdateTime).apply()

        return true
    }

    private fun getCurrentPackageUpdateTime(): Long {
        return if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            packageManager.getPackageInfo(
                packageName,
                PackageManager.PackageInfoFlags.of(0)
            ).lastUpdateTime
        } else {
            @Suppress("DEPRECATION")
            packageManager.getPackageInfo(packageName, 0).lastUpdateTime
        }
    }

    private fun setKeyboardAsDefault() {
        val myInputMethodId = "${packageName}/com.example.whispertoinput.WhisperInputService"

        if (isCurrentDefaultInputMethod(myInputMethodId)) {
            Log.d(TAG, "Input method already default: $myInputMethodId")
            return
        }

        if (hasWriteSecureSettingsPermission()) {
            try {
                setInputMethodAsDefaultWithSecureSettings(myInputMethodId)
                if (isCurrentDefaultInputMethod(myInputMethodId)) {
                    Log.d(TAG, "Input method set as default using secure settings: $myInputMethodId")
                    return
                }
            } catch (error: Exception) {
                Log.w(TAG, "Unable to set secure IME settings directly", error)
            }
        }

        if (!isInputMethodEnabled(myInputMethodId)) {
            openInputMethodSettings()
            Toast.makeText(
                this,
                R.string.toast_enable_keyboard_then_select,
                Toast.LENGTH_LONG
            ).show()
            return
        }

        showInputMethodPicker()
        Toast.makeText(this, R.string.toast_select_keyboard_as_default, Toast.LENGTH_LONG).show()
    }

    private fun hasWriteSecureSettingsPermission(): Boolean {
        return ContextCompat.checkSelfPermission(
            this,
            Manifest.permission.WRITE_SECURE_SETTINGS
        ) == PackageManager.PERMISSION_GRANTED
    }

    private fun setInputMethodAsDefaultWithSecureSettings(inputMethodId: String) {
        val enabledMethods = Settings.Secure.getString(
            contentResolver,
            Settings.Secure.ENABLED_INPUT_METHODS
        ).orEmpty()

        if (!enabledMethods.split(':').contains(inputMethodId)) {
            val newEnabledMethods = if (enabledMethods.isEmpty()) {
                inputMethodId
            } else {
                "$enabledMethods:$inputMethodId"
            }
            Settings.Secure.putString(
                contentResolver,
                Settings.Secure.ENABLED_INPUT_METHODS,
                newEnabledMethods
            )
        }

        Settings.Secure.putString(
            contentResolver,
            Settings.Secure.DEFAULT_INPUT_METHOD,
            inputMethodId
        )
    }

    private fun isInputMethodEnabled(inputMethodId: String): Boolean {
        val enabledMethods = Settings.Secure.getString(
            contentResolver,
            Settings.Secure.ENABLED_INPUT_METHODS
        ).orEmpty()
        return enabledMethods.split(':').contains(inputMethodId)
    }

    private fun isCurrentDefaultInputMethod(inputMethodId: String): Boolean {
        val currentDefaultInputMethod = Settings.Secure.getString(
            contentResolver,
            Settings.Secure.DEFAULT_INPUT_METHOD
        )
        return currentDefaultInputMethod == inputMethodId
    }

    private fun showInputMethodPicker() {
        try {
            val inputMethodManager = getSystemService(INPUT_METHOD_SERVICE) as InputMethodManager
            inputMethodManager.showInputMethodPicker()
            Log.d(TAG, "Opened input method picker")
        } catch (error: Exception) {
            Log.w(TAG, "Unable to open input method picker", error)
            openInputMethodSettings()
        }
    }

    private fun openInputMethodSettings() {
        try {
            val intent = Intent(Settings.ACTION_INPUT_METHOD_SETTINGS).apply {
                addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            }
            startActivity(intent)
            Log.d(TAG, "Opened input method settings")
        } catch (error: Exception) {
            Log.w(TAG, "Could not open input method settings", error)
        }
    }

    private fun vibrate() {
        val vibrator = getSystemService(Context.VIBRATOR_SERVICE) as? Vibrator
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            vibrator?.vibrate(VibrationEffect.createOneShot(30, VibrationEffect.DEFAULT_AMPLITUDE))
        } else {
            @Suppress("DEPRECATION")
            vibrator?.vibrate(30)
        }
    }

    // The onClick event of the grant permission button.
    // Opens up the app settings panel to manually configure permissions.
    fun onRequestMicrophonePermission(view: View) {
        val intent = Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS)
        with(intent) {
            data = Uri.fromParts("package", packageName, null)
            addCategory(Intent.CATEGORY_DEFAULT)
            addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            addFlags(Intent.FLAG_ACTIVITY_NO_HISTORY)
            addFlags(Intent.FLAG_ACTIVITY_EXCLUDE_FROM_RECENTS)
        }

        startActivity(intent)
    }

    // Checks whether permissions are granted. If not, automatically make a request.
    private fun checkPermissions() {
        val permission_and_code = arrayOf(
            Pair(Manifest.permission.RECORD_AUDIO, MICROPHONE_PERMISSION_REQUEST_CODE),
            Pair(Manifest.permission.POST_NOTIFICATIONS, NOTIFICATION_PERMISSION_REQUEST_CODE),
        )
        for ((permission, code) in permission_and_code) {
            if (ContextCompat.checkSelfPermission(
                    this,
                    permission
                ) == PackageManager.PERMISSION_DENIED
            ) {
                // Shows a popup for permission request.
                // If the permission has been previously (hard-)denied, the popup will not show.
                // onRequestPermissionsResult will be called in either case.
                ActivityCompat.requestPermissions(
                    this,
                    arrayOf(permission),
                    code
                )
            }
        }
    }

    // Handles the results of permission requests.
    override fun onRequestPermissionsResult(
        requestCode: Int,
        permissions: Array<out String>,
        grantResults: IntArray
    ) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults)
        var msg: String

        // Only handles requests marked with the unique code.
        if (requestCode == MICROPHONE_PERMISSION_REQUEST_CODE) {
            msg = getString(R.string.mic_permission_required)
        } else if (requestCode == NOTIFICATION_PERMISSION_REQUEST_CODE) {
            msg = getString(R.string.notification_permission_required)
        } else {
            return
        }

        // All permissions should be granted.
        for (result in grantResults) {
            if (result != PackageManager.PERMISSION_GRANTED) {
                Toast.makeText(this, msg, Toast.LENGTH_SHORT).show()
                return
            }
        }
    }

    // Below are settings related functions
    abstract inner class SettingItem() {
        protected var isDirty: Boolean = false
        abstract fun setup() : Job
        abstract suspend fun apply()
        protected suspend fun <T> readSetting(key: Preferences.Key<T>): T? {
            // work is moved to `Dispatchers.IO` under the hood
            // Ref: https://developer.android.com/codelabs/android-preferences-datastore#3
            return dataStore.data.map { preferences ->
                preferences[key]
            }.first()
        }
        protected suspend fun <T> writeSetting(key: Preferences.Key<T>, newValue: T) {
            // work is moved to `Dispatchers.IO` under the hood
            // Ref: https://developer.android.com/codelabs/android-preferences-datastore#3
            dataStore.edit { settings ->
                settings[key] = newValue
            }
        }
    }

    // This is a generic class for handling integer settings in a text box
    inner class SettingIntText(        private val viewId: Int,
                                       private val preferenceKey: Preferences.Key<Int>,
                                       private val defaultValue: Int
    ): SettingItem() {
        override fun setup(): Job {
            return CoroutineScope(Dispatchers.Main).launch {
                val btnApply: Button = findViewById(R.id.btn_settings_apply)
                val editText = findViewById<EditText>(viewId)
                editText.isEnabled = false
                editText.doOnTextChanged { _, _, _, _ ->
                    if (!setupSettingItemsDone) return@doOnTextChanged
                    isDirty = true
                    btnApply.isEnabled = true
                }

                // Read data. If none, apply default value.
                val settingValue: Int? = readSetting(preferenceKey)
                val value: Int = settingValue ?: defaultValue
                if (settingValue == null) {
                    writeSetting(preferenceKey, defaultValue)
                }
                editText.setText(value.toString())
                editText.isEnabled = true
            }
        }
        override suspend fun apply() {
            if (!isDirty) return
            // Convert text to integer, with a fallback to the default value
            val newValue: Int = findViewById<EditText>(viewId).text.toString().toIntOrNull() ?: defaultValue
            writeSetting(preferenceKey, newValue)
            isDirty = false
        }
    }

    inner class SettingText(
        private val viewId: Int,
        private val preferenceKey: Preferences.Key<String>,
        private val defaultValue: String = ""
    ): SettingItem() {
        override fun setup(): Job {
            return CoroutineScope(Dispatchers.Main).launch {
                val btnApply: Button = findViewById(R.id.btn_settings_apply)
                val editText = findViewById<EditText>(viewId)
                editText.isEnabled = false
                editText.doOnTextChanged { _, _, _, _ ->
                    if (!setupSettingItemsDone) return@doOnTextChanged
                    isDirty = true
                    btnApply.isEnabled = true
                }

                // Read data. If none, apply default value.
                val settingValue: String? = readSetting(preferenceKey)
                val value: String = settingValue ?: defaultValue
                if (settingValue == null) {
                    writeSetting(preferenceKey, defaultValue)
                }
                editText.setText(value)
                editText.isEnabled = true
            }
        }
        override suspend fun apply() {
            if (!isDirty) return
            val newValue: String = findViewById<EditText>(viewId).text.toString()
            writeSetting(preferenceKey, newValue)
            isDirty = false
        }
    }

    inner class SettingDropdown(
        private val viewId: Int,
        private val preferenceKey: Preferences.Key<Boolean>,
        private val stringToValue: HashMap<String, Boolean>,
        private val defaultValue: Boolean = true
    ): SettingItem() {
        override fun setup(): Job {
            return CoroutineScope(Dispatchers.Main).launch {
                val btnApply: Button = findViewById(R.id.btn_settings_apply)
                val spinner = findViewById<Spinner>(viewId)
                spinner.isEnabled = false
                spinner.onItemSelectedListener = object : AdapterView.OnItemSelectedListener {
                    override fun onItemSelected(parent: AdapterView<*>, view: View?, pos: Int, id: Long) {
                        if (!setupSettingItemsDone) return
                        isDirty = true
                        btnApply.isEnabled = true
                    }
                    override fun onNothingSelected(parent: AdapterView<*>) { }
                }

                val valueToString = stringToValue.map { (k, v) -> v to k }.toMap()
                // Read data. If none, apply default value.
                val settingValue: Boolean? = readSetting(preferenceKey)
                val value: Boolean = settingValue ?: defaultValue
                val string: String = valueToString[value]!!
                if (settingValue == null) {
                    writeSetting(preferenceKey, defaultValue)
                }
                val index: Int? = (0 until spinner.adapter.count).firstOrNull {
                    spinner.adapter.getItem(it) == string
                }
                spinner.setSelection(index!!, false)
                spinner.isEnabled = true
            }
        }
        override suspend fun apply() {
            if (!isDirty) return
            val selectedItem = findViewById<Spinner>(viewId).selectedItem
            val newValue: Boolean = stringToValue[selectedItem]!!
            writeSetting(preferenceKey, newValue)
            isDirty = false
        }
    }

    inner class SettingStringDropdown(
        private val viewId: Int,
        private val preferenceKey: Preferences.Key<String>,
        private val optionValues: List<String>,
        private val defaultValue: String = ""
    ): SettingItem() {
        override fun setup(): Job {
            return CoroutineScope(Dispatchers.Main).launch {
                val btnApply: Button = findViewById(R.id.btn_settings_apply)
                val spinner = findViewById<Spinner>(viewId)
                spinner.isEnabled = false
                spinner.onItemSelectedListener = object : AdapterView.OnItemSelectedListener {
                    override fun onItemSelected(parent: AdapterView<*>, view: View?, pos: Int, id: Long) {
                        if (!setupSettingItemsDone) return
                        isDirty = true
                        btnApply.isEnabled = true
                    }
                    override fun onNothingSelected(parent: AdapterView<*>) { }
                }

                // Read data. If none, apply default value.
                val settingValue: String? = readSetting(preferenceKey)
                val value: String = settingValue ?: defaultValue
                if (settingValue == null) {
                    writeSetting(preferenceKey, defaultValue)
                }
                val index: Int? = (0 until spinner.adapter.count).firstOrNull {
                    spinner.adapter.getItem(it) == value
                }
                spinner.setSelection(index ?: 0, false)
                spinner.isEnabled = true
            }
        }
        override suspend fun apply() {
            if (!isDirty) return
            val selectedItem = findViewById<Spinner>(viewId).selectedItem
            val newValue: String = selectedItem.toString()
            writeSetting(preferenceKey, newValue)
            isDirty = false
        }
    }

    inner class SettingCheckbox(
        private val viewId: Int,
        private val preferenceKey: Preferences.Key<Boolean>,
        private val defaultValue: Boolean = false
    ): SettingItem() {
        override fun setup(): Job {
            return CoroutineScope(Dispatchers.Main).launch {
                val btnApply: Button = findViewById(R.id.btn_settings_apply)
                val checkBox = findViewById<CheckBox>(viewId)
                checkBox.isEnabled = false
                checkBox.setOnCheckedChangeListener { _, _ ->
                    if (!setupSettingItemsDone) return@setOnCheckedChangeListener
                    isDirty = true
                    btnApply.isEnabled = true
                }

                // Read data. If none, apply default value.
                val settingValue: Boolean? = readSetting(preferenceKey)
                val value: Boolean = settingValue ?: defaultValue
                if (settingValue == null) {
                    writeSetting(preferenceKey, defaultValue)
                }
                checkBox.isChecked = value
                checkBox.isEnabled = true
            }
        }
        override suspend fun apply() {
            if (!isDirty) return
            val newValue: Boolean = findViewById<CheckBox>(viewId).isChecked
            writeSetting(preferenceKey, newValue)
            isDirty = false
        }
    }

    private fun setupSettingItems() {
        setupSettingItemsDone = false
        // Add setting items here to apply functions to them
        CoroutineScope(Dispatchers.Main).launch {
            val settingItems = arrayOf(
                // Generation section
                /* SettingStringDropdown(R.id.spinner_asr_model, ASR_MODEL, listOf(
                    getString(R.string.settings_option_asr_whisper),
                    getString(R.string.settings_option_asr_canary),
                    getString(R.string.settings_option_asr_mixer)
                ), getString(R.string.settings_option_asr_whisper)), */
                SettingIntText(R.id.field_max_recording_duration_ms, MAX_RECORDING_DURATION_MS, resources.getInteger(R.integer.settings_label_recording_duration)),
                SettingText(R.id.field_prompt_for_llm, PROMPT_FOR_LLM, getString(R.string.settings_option_prompt_for_llm_default)),
                //SettingText(R.id.field_leading_string, LEADING_STRING, ""),
                //SettingCheckbox(R.id.checkbox_trailing_space, TRAILING_SPACE, false),
                //SettingCheckbox(R.id.checkbox_trailing_newline, TRAILING_NEWLINE, false),
                
                // Endpoints section
                SettingText(R.id.field_asr_primary_model_endpoint, ASR_WHISPER_MODEL_ENDPOINT, getString(R.string.settings_option_asr_primary_model_default)),
                //SettingText(R.id.field_asr_canary_model_endpoint, ASR_CANARY_MODEL_ENDPOINT, getString(R.string.settings_option_asr_canary_model_default)),
                SettingText(R.id.field_llm_model_endpoint, LLM_MODEL_ENDPOINT, getString(R.string.settings_option_llm_model_default)),
                SettingText(R.id.field_backup_model_endpoint, BACKUP_MODEL_ENDPOINT, getString(R.string.settings_option_backup_model_default)),
                
                // Visualization section
                SettingText(R.id.field_hf_token, HF_TOKEN, getString(R.string.settings_option_hf_token_default)),
            )
            val btnApply: Button = findViewById(R.id.btn_settings_apply)
            btnApply.isEnabled = false
            btnApply.setOnClickListener { _ ->
                vibrate()
                CoroutineScope(Dispatchers.Main).launch {
                    btnApply.isEnabled = false
                    for (settingItem in settingItems) {
                        settingItem.apply()
                    }
                    btnApply.isEnabled = false
                }
                Toast.makeText(this@MainActivity, R.string.successfully_set, Toast.LENGTH_SHORT).show()
            }
            settingItems.map { settingItem -> settingItem.setup() }.joinAll()
            setupSettingItemsDone = true
        }
    }
}
