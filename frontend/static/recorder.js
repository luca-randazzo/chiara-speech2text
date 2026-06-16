/**
 * Recorder module for chiara-speech2text-v2
 * Handles audio recording, uploading to Firebase via model-server, and word list management
 */

// ============================================================================
// STATE MANAGEMENT
// ============================================================================

let currentState = {
    currentWordIndex: 0,
    totalWords: 0,
    isRecording: false,
    mediaRecorder: null,
    audioChunks: [],
    progress: 0,
    mediaStream: null
};

let isSessionActive = false;
let dailyRecordingStartIndex = 0;

// Audio recording configuration
const AUDIO_CONFIG = {
    audio: true,
    video: false
};

// Recording duration helpers
function getRecordingDurationMs(word) {
    const base = 3000; // [ms] minimum duration
    const perChar = 125;  // [ms] additional per character
    return Math.max(base, base + word.length * perChar);
}

// Get current date in YYYYMMDD format
function getDateString() {
    const now = new Date();
    const year = now.getFullYear();
    const month = String(now.getMonth() + 1).padStart(2, '0');
    const day = String(now.getDate()).padStart(2, '0');
    return `${year}${month}${day}`;
}

// Get username from input
function getUsername() {
    const input = document.getElementById('input-name');
    return (input ? input.value : 'chiara').trim() || 'chiara';
}

// ============================================================================
// AUDIO UTILITIES
// ============================================================================

// Resample audio buffer to 16000 Hz
async function resampleAudioBuffer(audioBuffer, targetSampleRate = 16000) {
    const offlineCtx = new OfflineAudioContext(
        audioBuffer.numberOfChannels,
        Math.ceil(audioBuffer.duration * targetSampleRate),
        targetSampleRate
    );
    const bufferSource = offlineCtx.createBufferSource();
    bufferSource.buffer = audioBuffer;
    bufferSource.connect(offlineCtx.destination);
    bufferSource.start(0);
    const renderedBuffer = await offlineCtx.startRendering();
    return renderedBuffer;
}

// Convert AudioBuffer to WAV Blob
function audioBufferToWavBlob(buffer) {
    const numChannels = buffer.numberOfChannels;
    const sampleRate = buffer.sampleRate;
    const length = buffer.length * numChannels * 2 + 44;
    const bufferArray = new ArrayBuffer(length);
    const view = new DataView(bufferArray);

    // WAV header
    function writeString(view, offset, string) {
        for (let i = 0; i < string.length; i++) {
            view.setUint8(offset + i, string.charCodeAt(i));
        }
    }

    writeString(view, 0, 'RIFF');
    view.setUint32(4, length - 8, true);
    writeString(view, 8, 'WAVE');
    writeString(view, 12, 'fmt ');
    view.setUint32(16, 16, true); // PCM
    view.setUint16(20, 1, true); // Linear quantization
    view.setUint16(22, numChannels, true);
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, sampleRate * numChannels * 2, true);
    view.setUint16(32, numChannels * 2, true);
    view.setUint16(34, 16, true); // bits per sample
    writeString(view, 36, 'data');
    view.setUint32(40, length - 44, true);

    // PCM samples
    let offset = 44;
    for (let i = 0; i < buffer.length; i++) {
        for (let channel = 0; channel < numChannels; channel++) {
            let sample = Math.max(-1, Math.min(1, buffer.getChannelData(channel)[i]));
            sample = sample < 0 ? sample * 0x8000 : sample * 0x7fff;
            view.setInt16(offset, sample, true);
            offset += 2;
        }
    }

    return new Blob([bufferArray], { type: 'audio/wav' });
}

function playCompletionTone() {
    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    if (!AudioCtx) {
        return;
    }

    const ctx = new AudioCtx();
    const oscillator = ctx.createOscillator();
    const gain = ctx.createGain();

    oscillator.type = 'sine';
    oscillator.frequency.setValueAtTime(880, ctx.currentTime);
    gain.gain.setValueAtTime(0.0001, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.16, ctx.currentTime + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.22);

    oscillator.connect(gain);
    gain.connect(ctx.destination);

    oscillator.start(ctx.currentTime);
    oscillator.stop(ctx.currentTime + 0.22);

    oscillator.onended = () => {
        if (ctx.state !== 'closed') {
            ctx.close();
        }
    };
}

// ============================================================================
// UPLOAD FUNCTIONALITY
// ============================================================================

/**
 * Get the next sequential audio number for a folder.
 * Returns the next number (N) to use for N.wav filename.
 */
async function getNextAudioNumber(folderName) {
    try {
        const url = `/api/next_audio_number?folder=${encodeURIComponent(folderName)}`;
        const response = await fetch(url, {
            method: 'GET',
            credentials: 'omit'
        });

        if (!response.ok) {
            console.error(`Failed to get next audio number: ${response.status}`);
            return null;
        }

        const result = await response.json();
        if (result.ok && typeof result.next_number === 'number') {
            console.log(`Next audio number for ${folderName}: ${result.next_number}`);
            return result.next_number;
        }
        return null;
    } catch (error) {
        console.error('Error fetching next audio number:', error);
        return null;
    }
}

/**
 * Upload recording to the frontend backend for Firebase storage only.
 * No remote inference call is made for recorder uploads.
 * Filename uses sequential numbering: N.wav
 */
async function uploadRecording(audioBlob, word, index) {
    const dateStr = getDateString();
    const username = getUsername();
    const folderName = `${dateStr}_${username}_frontend`;

    try {
        // Get the next sequential audio number
        const nextNumber = await getNextAudioNumber(folderName);
        if (nextNumber === null) {
            console.error('Could not determine next audio number, upload cancelled');
            return false;
        }

        // Create FormData for multipart upload with N.wav filename
        const formData = new FormData();
        const audioFilename = `${nextNumber}.wav`;
        formData.append('wav', audioBlob, audioFilename);
        formData.append('folder', folderName);
        formData.append('word', word);
        formData.append('index', index.toString());
        formData.append('audio_source', 'frontend');

        const url = `/api/recorder_upload`;
        console.log(`Uploading to frontend recorder API: ${url} (folder=${folderName}, filename=${audioFilename}, word=${word})`);

        // Send to the frontend backend so it can persist to FRONTEND_FIREBASE_BUCKET
        const response = await fetch(url, {
            method: 'POST',
            body: formData,
            credentials: 'omit'
        });

        if (!response.ok) {
            const errorText = await response.text();
            console.error(`Upload failed: ${response.status} ${response.statusText}`, errorText);
            return false;
        }

        const result = await response.json();
        console.log('Upload successful:', result);
        
        if (result.status === 'success' && result.entry_id) {
            console.log(`Recording stored with entry_id: ${result.entry_id}, transcript: "${result.transcript}"`);
            return true;
        }
        return true;
    } catch (error) {
        console.error('Error uploading recording:', error);
        return false;
    }
}

// ============================================================================
// MIC VISUALIZER
// ============================================================================

let audioContext = null;
let analyser = null;
let dataArray = null;
let animationId = null;
let sourceNode = null;
let timeOffset = 0;

function startMicVisualizer() {
    const canvas = document.getElementById('mic-visualizer');
    if (!canvas || !currentState.mediaStream) return;

    audioContext = new (window.AudioContext || window.webkitAudioContext)();
    analyser = audioContext.createAnalyser();
    analyser.fftSize = 128;
    const bufferLength = analyser.frequencyBinCount;
    dataArray = new Uint8Array(bufferLength);
    sourceNode = audioContext.createMediaStreamSource(currentState.mediaStream);
    sourceNode.connect(analyser);

    const ctx = canvas.getContext('2d');
    const centerY = canvas.height / 2;
    const stringCount = 3;
    
    // String colors: red, navy blue, gray
    const stringColors = ['#ff3333', '#1a2a6e', '#808080'];
    
    // Store time for wave animation
    let animationTime = 0;

    function drawVibratingStrings() {
        animationTime += 0.05;
        timeOffset = animationTime;
        animationId = requestAnimationFrame(drawVibratingStrings);
        analyser.getByteFrequencyData(dataArray);

        // Clear canvas with background color
        ctx.fillStyle = 'rgb(24, 28, 40)';
        ctx.fillRect(0, 0, canvas.width, canvas.height);

        // Calculate average frequency for overall amplitude
        const averageFreq = dataArray.reduce((a, b) => a + b, 0) / bufferLength;
        const amplitudeScale = (averageFreq / 255) * (canvas.height * 0.95); // Scale to fill more vertical space

        // Draw each vibrating string (all at centerY, superimposed)
        for (let stringIdx = 0; stringIdx < stringCount; stringIdx++) {
            const frequency = 2 + stringIdx * 0.5; // Different frequencies for each string
            const phaseShift = stringIdx * Math.PI / stringCount; // Phase offset for each string

            ctx.beginPath();
            ctx.strokeStyle = stringColors[stringIdx];
            ctx.lineWidth = 2.5;

            for (let x = 0; x < canvas.width; x++) {
                // Get frequency data for this x position
                const dataIndex = Math.floor((x / canvas.width) * bufferLength);
                const freqAmplitude = (dataArray[dataIndex] / 255) * amplitudeScale;

                // Calculate y position with multiple sine waves, centered at centerY
                const waveForm1 = Math.sin((x / canvas.width) * Math.PI * 2 * frequency + animationTime * 2 + phaseShift) * freqAmplitude;
                const waveForm2 = Math.sin((x / canvas.width) * Math.PI * 4 + animationTime * 3) * freqAmplitude * 0.5;
                const y = centerY + waveForm1 + waveForm2;

                if (x === 0) {
                    ctx.moveTo(x, y);
                } else {
                    ctx.lineTo(x, y);
                }
            }
            ctx.stroke();
        }
    }
    drawVibratingStrings();
}

function stopMicVisualizer() {
    if (animationId) cancelAnimationFrame(animationId);
    animationId = null;
    if (audioContext) audioContext.close();
    analyser = null;
    dataArray = null;
    sourceNode = null;
    timeOffset = 0;

    const canvas = document.getElementById('mic-visualizer');
    if (canvas) {
        const ctx = canvas.getContext('2d');
        ctx.fillStyle = 'rgb(24, 28, 40)';
        ctx.fillRect(0, 0, canvas.width, canvas.height);
    }
}

// ============================================================================
// RECORDING CONTROL
// ============================================================================

function updateProgress(percentage) {
    const bar = document.querySelector('.progress-bar');
    if (bar) {
        bar.style.width = percentage + '%';
    }
}

function updateCurrentWord(shouldSpeak = false, onSpeakEndCallback) {
    const display = document.getElementById('word-display');
    if (!display) return;

    if (currentState.currentWordIndex < currentState.totalWords) {
        const word = window.TRAINING_WORDS[currentState.currentWordIndex];
        display.querySelector('.current-word').textContent = word;

        if (shouldSpeak) {
            speakWord(word, onSpeakEndCallback);
        }
    }
}

function speakWord(word, onEndCallback) {
    if ('speechSynthesis' in window) {
        const utterance = new SpeechSynthesisUtterance(word);
        utterance.lang = 'it-IT';
        utterance.onend = onEndCallback;
        speechSynthesis.speak(utterance);
    } else if (onEndCallback) {
        onEndCallback();
    }
}

let stopTimeoutId = null;

async function startRecording() {
    if (isSessionActive || currentState.isRecording) return;

    try {
        // Initialize media stream
        const stream = await navigator.mediaDevices.getUserMedia(AUDIO_CONFIG);
        currentState.mediaStream = stream;
        currentState.audioChunks = [];
        currentState.isRecording = true;
        isSessionActive = true;
        currentState.currentWordIndex = 0;
        isPaused = false;

        // Show training section
        document.getElementById('setup-section').style.display = 'none';
        document.getElementById('training-section').style.display = 'block';

        // Show pause button immediately
        setPlayPauseButton(true);

        startMicVisualizer();
        updateCurrentWord(true, recordNextWord);
    } catch (error) {
        console.error('Error accessing microphone:', error);
        alert('Could not access microphone. Please check permissions.');
        isSessionActive = false;
    }
}

async function recordNextWord() {
    if (!currentState.isRecording || !currentState.mediaStream) return;
    if (currentState.currentWordIndex >= currentState.totalWords) {
        await endSession();
        return;
    }

    const word = window.TRAINING_WORDS[currentState.currentWordIndex];
    const recordingDurationMs = getRecordingDurationMs(word);
    
    // Create new MediaRecorder for this word
    if (!animationId && currentState.mediaStream) {
        startMicVisualizer();
    }

    const mediaRecorder = new MediaRecorder(currentState.mediaStream);
    currentState.mediaRecorder = mediaRecorder;
    currentState.audioChunks = [];

    mediaRecorder.ondataavailable = (event) => {
        currentState.audioChunks.push(event.data);
    };

    mediaRecorder.onstop = async () => {
        if (!currentState.isRecording) {
            console.log('Session ended, skipping upload');
            return;
        }

        stopMicVisualizer();

        const audioBlob = new Blob(currentState.audioChunks, { type: 'audio/webm' });
        
        console.log(`Processing recording for word ${currentState.currentWordIndex}: "${word}"`);

        // Convert to WAV and upload
        try {
            const audioContext = new (window.AudioContext || window.webkitAudioContext)();
            const arrayBuffer = await audioBlob.arrayBuffer();
            const audioBuffer = await audioContext.decodeAudioData(arrayBuffer);
            const resampledBuffer = await resampleAudioBuffer(audioBuffer, 16000);
            const wavBlob = audioBufferToWavBlob(resampledBuffer);

            console.log(`Uploading ${word} (${currentState.currentWordIndex + 1}/${currentState.totalWords})`);
            
            // Upload to server
            const success = await uploadRecording(
                wavBlob,
                word,
                currentState.currentWordIndex
            );

            if (success) {
                console.log(`Successfully uploaded "${word}"`);
                currentState.currentWordIndex++;
                updateProgress((currentState.currentWordIndex / currentState.totalWords) * 100);

                // Wait a moment before recording next word
                await new Promise(resolve => setTimeout(resolve, 500));

                if (currentState.currentWordIndex < currentState.totalWords) {
                    // Speak the next word while recording
                    updateCurrentWord(true, recordNextWord);
                } else {
                    // All done
                    console.log('All words recorded!');
                    await endSession();
                }
            } else {
                console.error('Upload failed for word:', word);
                // Continue anyway
                currentState.currentWordIndex++;
                updateProgress((currentState.currentWordIndex / currentState.totalWords) * 100);
                
                await new Promise(resolve => setTimeout(resolve, 500));
                
                if (currentState.currentWordIndex < currentState.totalWords) {
                    updateCurrentWord(true, recordNextWord);
                } else {
                    await endSession();
                }
            }
        } catch (error) {
            console.error('Error processing recording:', error);
            // Try to continue with next word
            currentState.currentWordIndex++;
            updateProgress((currentState.currentWordIndex / currentState.totalWords) * 100);
            
            await new Promise(resolve => setTimeout(resolve, 500));
            
            if (currentState.currentWordIndex < currentState.totalWords) {
                updateCurrentWord(true, recordNextWord);
            } else {
                await endSession();
            }
        }
    };

    // Start recording
    console.log(`Starting to record word ${currentState.currentWordIndex + 1}/${currentState.totalWords}: "${word}"`);
    mediaRecorder.start();

    const recordProgressBar = document.getElementById('record-progress-bar');
    if (recordProgressBar) {
        recordProgressBar.style.transition = 'none';
        recordProgressBar.style.width = '0%';
        recordProgressBar.getBoundingClientRect();
        requestAnimationFrame(() => {
            recordProgressBar.style.transition = `width ${recordingDurationMs / 1000}s linear`;
            recordProgressBar.style.width = '100%';
        });
    }

    stopTimeoutId = setTimeout(() => {
        console.log(`Recording time limit reached for "${word}"`);
        if (mediaRecorder.state === 'recording') {
            mediaRecorder.stop();
        }
    }, recordingDurationMs);
}

function stopRecording() {
    if (currentState.mediaRecorder && currentState.mediaRecorder.state === 'recording') {
        currentState.mediaRecorder.stop();
    }
    if (stopTimeoutId) clearTimeout(stopTimeoutId);
}

async function endSession() {
    console.log('Ending recording session');
    currentState.isRecording = false;
    isSessionActive = false;

    if (currentState.mediaRecorder && currentState.mediaRecorder.state === 'recording') {
        currentState.mediaRecorder.stop();
    }

    // Close media stream
    if (currentState.mediaStream) {
        currentState.mediaStream.getTracks().forEach(track => track.stop());
        currentState.mediaStream = null;
    }

    stopMicVisualizer();
    playCompletionTone();

    // Show completion
    alert('Recording session completed!');

    // Reset UI
    document.getElementById('setup-section').style.display = 'block';
    document.getElementById('training-section').style.display = 'none';
    currentState.currentWordIndex = 0;
    updateProgress(0);
}

// ============================================================================
// PLAY/PAUSE
// ============================================================================

let isPaused = false;

function setPlayPauseButton(isPauseState) {
    const btn = document.getElementById('play-pause-btn');
    if (!btn) return;
    if (isPauseState) {
        // Recording is active, show pause button
        btn.innerHTML = '<div class="icon"><span class="material-symbols-outlined">pause</span></div><div>Pause</div>';
    } else {
        // Recording is paused, show resume button
        btn.innerHTML = '<div class="icon"><span class="material-symbols-outlined">play_arrow</span></div><div>Resume</div>';
    }
}

function pauseSession() {
    if (currentState.mediaRecorder && currentState.mediaRecorder.state === 'recording') {
        currentState.mediaRecorder.pause();
    }
    if (stopTimeoutId) {
        clearTimeout(stopTimeoutId);
        stopTimeoutId = null;
    }
    isPaused = true;
    setPlayPauseButton(false);
}

function resumeSession() {
    if (isPaused && currentState.isRecording && currentState.mediaRecorder) {
        if (currentState.mediaRecorder.state === 'paused') {
            currentState.mediaRecorder.resume();
        }
        isPaused = false;
        setPlayPauseButton(true);
        
        // Restart the recording timeout for the current word
        const word = window.TRAINING_WORDS[currentState.currentWordIndex];
        const recordingDurationMs = getRecordingDurationMs(word);
        stopTimeoutId = setTimeout(() => {
            console.log(`Recording time limit reached for "${word}"`);
            if (currentState.mediaRecorder && currentState.mediaRecorder.state !== 'inactive') {
                currentState.mediaRecorder.stop();
            }
        }, recordingDurationMs);
    }
}

// ============================================================================
// WORD LIST MANAGEMENT
// ============================================================================

window.TRAINING_WORDS = [];
let availableWordLists = [];
let currentListId = null;

function shuffleArray(array) {
    for (let i = array.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [array[i], array[j]] = [array[j], array[i]];
    }
}

function updateWordsTextbox() {
    const textarea = document.getElementById('words-list');
    if (textarea) {
        textarea.value = window.TRAINING_WORDS.join('\n');
    }
}

async function loadTrainingWords() {
    const textarea = document.getElementById('words-list');
    if (textarea && textarea.value.trim()) {
        window.TRAINING_WORDS = textarea.value
            .split('\n')
            .map(line => line.trim())
            .filter(line => line.length > 0);
    }
    shuffleArray(window.TRAINING_WORDS);
    currentState.totalWords = window.TRAINING_WORDS.length;
    console.log('Loaded words:', window.TRAINING_WORDS);
}

async function initWordLists() {
    // Try to load available input sets from the backend inputs.json file.
    try {
        const response = await fetch('/api/inputs');
        if (response.ok) {
            const inputs = await response.json();
            if (Array.isArray(inputs) && inputs.length > 0) {
                availableWordLists = inputs.map(item => ({
                    id: item.inputs_id,
                    name: item.inputs_id,
                    emoji: item.inputs_emoji || '📝',
                    words: Array.isArray(item.inputs)
                        ? item.inputs.map(entry => entry.input).filter(Boolean)
                        : []
                }));
                renderWordListSelector();
                return;
            }
        }
    } catch (e) {
        console.warn('Could not load inputs from backend:', e);
    }

    const stored = localStorage.getItem('wordLists');
    if (stored) {
        availableWordLists = JSON.parse(stored);
        renderWordListSelector();
    }
}

function renderWordListSelector() {
    const selector = document.getElementById('word-set-selector');
    if (!selector) return;

    selector.innerHTML = '<option value="">Select a list...</option>';
    availableWordLists.forEach(list => {
        const option = document.createElement('option');
        option.value = list.id;
        option.textContent = `${list.emoji} ${list.name}`;
        selector.appendChild(option);
    });
}

function selectWordList(listId) {
    const list = availableWordLists.find(l => l.id === listId);
    if (!list) return;

    currentListId = listId;
    window.TRAINING_WORDS = [...list.words];
    updateWordsTextbox();

    // Show emoji and delete button
    const emoji = document.getElementById('list-emoji');
    const deleteBtn = document.getElementById('delete-list-btn');
    if (emoji && deleteBtn) {
        emoji.textContent = list.emoji;
        emoji.style.display = 'inline';
        deleteBtn.style.display = 'inline-flex';
    }
}

async function saveWordList(name, words) {
    const payload = { name, words };
    let listId = Date.now().toString();
    let newList = {
        id: listId,
        name: name,
        emoji: '📝',
        words: words
    };

    try {
        const response = await fetch('/api/inputs', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });

        if (response.ok) {
            const result = await response.json();
            const data = result.inputs_set || {};
            listId = data.inputs_id || listId;
            newList = {
                id: listId,
                name: name,
                emoji: data.inputs_emoji || '📝',
                words: words
            };
        } else {
            console.error('Failed to save inputs to backend:', response.status);
        }
    } catch (error) {
        console.error('Error uploading inputs to backend:', error);
    }

    availableWordLists.push(newList);
    localStorage.setItem('wordLists', JSON.stringify(availableWordLists));
    renderWordListSelector();

    return listId;
}

async function deleteWordList(listId) {
    try {
        const response = await fetch(`/api/inputs/${encodeURIComponent(listId)}`, {
            method: 'DELETE'
        });
        if (!response.ok) {
            console.warn('Failed to delete input set from backend:', response.status);
        }
    } catch (error) {
        console.warn('Error deleting input set from backend:', error);
    }

    availableWordLists = availableWordLists.filter(l => l.id !== listId);
    localStorage.setItem('wordLists', JSON.stringify(availableWordLists));
    renderWordListSelector();

    if (currentListId === listId) {
        currentListId = null;
        document.getElementById('word-set-selector').value = '';
        document.getElementById('list-emoji').style.display = 'none';
        document.getElementById('delete-list-btn').style.display = 'none';
    }
}

// ============================================================================
// EVENT LISTENERS & INITIALIZATION
// ============================================================================

document.addEventListener('DOMContentLoaded', async () => {
    // Initialize word lists
    await initWordLists();

    // Start recording button
    document.getElementById('start-session-btn')?.addEventListener('click', async () => {
        await loadTrainingWords();
        if (window.TRAINING_WORDS.length === 0) {
            alert('Please select or upload a word list first.');
            return;
        }
        console.log('Starting recording session with', window.TRAINING_WORDS.length, 'words');
        startRecording();
    });

    // Play/pause button
    document.getElementById('play-pause-btn')?.addEventListener('click', () => {
        if (isPaused) {
            resumeSession();
        } else {
            pauseSession();
        }
    });

    // Upload button
    document.getElementById('upload-trigger-btn')?.addEventListener('click', () => {
        document.getElementById('words-file')?.click();
    });

    // File input change
    document.getElementById('words-file')?.addEventListener('change', async (e) => {
        const file = e.target.files?.[0];
        if (!file) return;

        try {
            const text = await file.text();
            const words = text
                .split('\n')
                .map(line => line.trim())
                .filter(line => line.length > 0);

            if (words.length === 0) {
                alert('No valid words found in file.');
                return;
            }

            // Save to localStorage
            const listName = file.name.replace('.txt', '');
            await saveWordList(listName, words);

            window.TRAINING_WORDS = [...words];
            updateWordsTextbox();

            const feedback = document.getElementById('upload-feedback');
            if (feedback) {
                feedback.textContent = `✓ Loaded ${words.length} word(s) from ${file.name}`;
                feedback.style.color = 'var(--primary-color)';
            }
        } catch (error) {
            console.error('Error reading file:', error);
            alert('Error reading file.');
        }
    });

    // Word list selector
    document.getElementById('word-set-selector')?.addEventListener('change', (e) => {
        if (e.target.value) {
            selectWordList(e.target.value);
        }
    });

    // Delete list button
    document.getElementById('delete-list-btn')?.addEventListener('click', () => {
        if (currentListId && confirm('Delete this word list?')) {
            deleteWordList(currentListId);
        }
    });

    // Info modal for word list
    const infoBtn = document.getElementById('info-btn');
    const infoModal = document.getElementById('info-modal');
    const infoClose = infoModal?.querySelector('.modal-close');

    infoBtn?.addEventListener('click', () => {
        if (infoModal) infoModal.style.display = 'flex';
    });

    infoClose?.addEventListener('click', () => {
        if (infoModal) infoModal.style.display = 'none';
    });

    infoModal?.addEventListener('click', (e) => {
        if (e.target === infoModal) infoModal.style.display = 'none';
    });

    // Username info modal
    const recorderInfoBtn = document.getElementById('recorder-info-btn');
    const usernameModal = document.getElementById('recorder-username-info-modal');
    const usernameModalClose = usernameModal?.querySelector('.modal-close');

    recorderInfoBtn?.addEventListener('click', () => {
        if (usernameModal) usernameModal.style.display = 'flex';
    });

    usernameModalClose?.addEventListener('click', () => {
        if (usernameModal) usernameModal.style.display = 'none';
    });

    usernameModal?.addEventListener('click', (e) => {
        if (e.target === usernameModal) usernameModal.style.display = 'none';
    });

    // Save username to localStorage when changed
    const usernameInput = document.getElementById('input-name');
    usernameInput?.addEventListener('change', () => {
        localStorage.setItem('username', usernameInput.value);
    });

    // Load username from localStorage on page load
    const saved = localStorage.getItem('username');
    if (saved && usernameInput) {
        usernameInput.value = saved;
    }

    // Load default word list if available
    if (availableWordLists.length > 0) {
        selectWordList(availableWordLists[0].id);
        document.getElementById('word-set-selector').value = availableWordLists[0].id;
    }

    // ----------------------------------------------------------------
    // Edit Input Set modal (emoji + id editor)
    // ----------------------------------------------------------------

    const editSetModal   = document.getElementById('edit-set-modal');
    const editSetClose   = document.getElementById('edit-set-close');
    const editEmojiInput = document.getElementById('edit-set-emoji-input');
    const editEmojiPrev  = document.getElementById('edit-set-emoji-preview');
    const editIdInput    = document.getElementById('edit-set-id-input');
    const editError      = document.getElementById('edit-set-error');
    const editSaveBtn    = document.getElementById('edit-set-save-btn');

    function openEditSetModal() {
        if (!currentListId) return;
        const list = availableWordLists.find(l => l.id === currentListId);
        if (!list) return;

        editEmojiInput.value  = list.emoji || '📝';
        editEmojiPrev.textContent = list.emoji || '📝';
        editIdInput.value     = list.id;
        editError.style.display = 'none';
        editError.textContent   = '';
        if (editSetModal) editSetModal.style.display = 'flex';
        editEmojiInput.focus();
    }

    // Live emoji preview
    editEmojiInput?.addEventListener('input', () => {
        const val = editEmojiInput.value.trim();
        editEmojiPrev.textContent = val || '📝';
    });

    // Open on emoji badge click
    document.getElementById('list-emoji')?.addEventListener('click', openEditSetModal);

    // Close handlers
    editSetClose?.addEventListener('click', () => {
        if (editSetModal) editSetModal.style.display = 'none';
    });
    editSetModal?.addEventListener('click', (e) => {
        if (e.target === editSetModal) editSetModal.style.display = 'none';
    });

    // Save
    editSaveBtn?.addEventListener('click', async () => {
        if (!currentListId) return;

        const newEmoji = editEmojiInput.value.trim();
        const newId    = editIdInput.value.trim();

        if (!newEmoji) {
            editError.textContent   = 'Please enter an emoji.';
            editError.style.display = 'block';
            return;
        }
        if (!newId) {
            editError.textContent   = 'Set ID cannot be empty.';
            editError.style.display = 'block';
            return;
        }

        editError.style.display = 'none';
        editSaveBtn.disabled    = true;
        editSaveBtn.textContent = 'Saving…';

        try {
            const response = await fetch(`/api/inputs/${encodeURIComponent(currentListId)}`, {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ inputs_emoji: newEmoji, inputs_id: newId })
            });

            const result = await response.json();

            if (!response.ok) {
                editError.textContent   = result.error || 'Save failed.';
                editError.style.display = 'block';
                return;
            }

            // Apply changes locally so a reload is not required
            const list = availableWordLists.find(l => l.id === currentListId);
            if (list) {
                list.emoji = newEmoji;
                list.id    = newId;
                list.name  = newId;
            }
            const oldId   = currentListId;
            currentListId = newId;

            // Update selector option text + value
            const selector = document.getElementById('word-set-selector');
            const opt = selector?.querySelector(`option[value="${CSS.escape(oldId)}"]`);
            if (opt) {
                opt.value       = newId;
                opt.textContent = `${newEmoji} ${newId}`;
                selector.value  = newId;
            }

            // Update badge
            const badge = document.getElementById('list-emoji');
            if (badge) badge.textContent = newEmoji;

            localStorage.setItem('wordLists', JSON.stringify(availableWordLists));

            if (editSetModal) editSetModal.style.display = 'none';
        } catch (err) {
            editError.textContent   = 'Network error — could not save.';
            editError.style.display = 'block';
        } finally {
            editSaveBtn.disabled    = false;
            editSaveBtn.textContent = 'Save changes';
        }
    });
});
