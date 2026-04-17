// asset/js/vad.js

// ─────────────────────────────────────────────
// CONFIG — Technical Architect Refactor (v4.1)
// ─────────────────────────────────────────────
const VAD_CONFIG = {
    SMOOTHING_ALPHA:      0.15,   // เพิ่มความสมูทของระดับเสียง
    NOISE_FLOOR_ALPHA:    0.005,
    NOISE_FLOOR_MARGIN:   10,     // เพิ่ม margin กัน noise
    MIN_HOLD_MS:          400,    // เพิ่มเวลาหน่วงขั้นต่ำ
    HIGHPASS_FREQ:        100,    // Hz
    GAIN_VALUE:           1.4,    // boost
    FFT_SIZE:             512,
    VAD_INTERVAL_MS:      50,     // ลดความถี่การคำนวณเพื่อประหยัดแบต
    UI_INTERVAL_MS:       100,
    VOICE_CONFIRM_FRAMES: 2,      // จำนวนเฟรมที่ต้องดังต่อเนื่องถึงจะเปิดไมค์
};

// ─────────────────────────────────────────────
// STATE MANAGEMENT
// ─────────────────────────────────────────────
let audioContext      = null;
let analyser          = null;
let micStream         = null;
let outTrack          = null;
let vadIntervalId     = null;
let uiIntervalId      = null;
let isTesting         = false;
let isMainMicOn       = false;
let isVADActive       = false;
let holdTimeout       = null;
let smoothedVolume    = 0;
let noiseFloor        = 0;
let lastVolumePercent = 0;
let voiceFrameCount   = 0;

// Live Node References
let hpfNode           = null;
let gainNodeRef       = null;

// ─────────────────────────────────────────────
// DOM ELEMENTS
// ─────────────────────────────────────────────
const testMicBtn        = document.getElementById('testMicBtn');
const volumeMeterFill   = document.getElementById('volumeMeterFill');
const currentVolumeText = document.getElementById('currentVolumeText');
const thresholdSlider   = document.getElementById('thresholdSlider');
const holdTimeSlider    = document.getElementById('holdTimeSlider');
const micStatusBadge    = document.getElementById('micStatusBadge');
const micStatusText     = document.getElementById('micStatusText');

// ─────────────────────────────────────────────
// CORE AUDIO PIPELINE
// ─────────────────────────────────────────────

function buildAudioPipeline(ctx, source) {
    // 1. High Pass Filter (ตัดเสียงลม/เครื่องยนต์)
    const hpf = ctx.createBiquadFilter();
    hpf.type            = 'highpass';
    hpf.frequency.value = VAD_CONFIG.HIGHPASS_FREQ;
    hpf.Q.value         = 0.7;

    // 2. Gain Node (เพิ่มเสียงพูด)
    const gainNode = ctx.createGain();
    gainNode.gain.value = VAD_CONFIG.GAIN_VALUE;

    // 3. Analyser Node (สำหรับ VAD)
    const analyserNode = ctx.createAnalyser();
    analyserNode.fftSize = VAD_CONFIG.FFT_SIZE;

    // 4. Destination Stream (ส่งออกไปยัง WebRTC)
    const dest = ctx.createMediaStreamDestination();

    // Connection: Source -> HPF -> Gain -> Analyser + Destination
    source.connect(hpf);
    hpf.connect(gainNode);
    gainNode.connect(analyserNode);
    gainNode.connect(dest);

    // เก็บ reference สำหรับ Live Update
    hpfNode     = hpf;
    gainNodeRef = gainNode;

    return { analyserNode, destStream: dest.stream };
}

// ─────────────────────────────────────────────
// VAD LOGIC
// ─────────────────────────────────────────────

function processVAD() {
    if (!analyser) return;

    const dataArray = new Uint8Array(analyser.frequencyBinCount);
    analyser.getByteFrequencyData(dataArray);

    let sumSq = 0;
    for (let i = 0; i < dataArray.length; i++) sumSq += dataArray[i] * dataArray[i];
    const rms = Math.sqrt(sumSq / dataArray.length);
    const rawPercent = Math.min(100, Math.round((rms / 255) * 100 * 2.5)); // ปรับสเกลเล็กน้อย

    // Volume Smoothing
    smoothedVolume = VAD_CONFIG.SMOOTHING_ALPHA * rawPercent + (1 - VAD_CONFIG.SMOOTHING_ALPHA) * smoothedVolume;
    lastVolumePercent = Math.round(smoothedVolume);

    // Dynamic Noise Floor
    if (!isVADActive) {
        noiseFloor = VAD_CONFIG.NOISE_FLOOR_ALPHA * lastVolumePercent + (1 - VAD_CONFIG.NOISE_FLOOR_ALPHA) * noiseFloor;
    }

    const userThreshold = parseInt(thresholdSlider.value, 10);
    const holdTime = Math.max(parseInt(holdTimeSlider.value, 10), VAD_CONFIG.MIN_HOLD_MS);
    const effectiveThreshold = Math.max(userThreshold, noiseFloor + VAD_CONFIG.NOISE_FLOOR_MARGIN);

    if (lastVolumePercent >= effectiveThreshold) {
        voiceFrameCount++;
        if (!isVADActive && voiceFrameCount >= VAD_CONFIG.VOICE_CONFIRM_FRAMES) {
            isVADActive = true;
            updateVADStatus(true);
        }
        if (holdTimeout) {
            clearTimeout(holdTimeout);
            holdTimeout = null;
        }
    } else {
        voiceFrameCount = 0;
        if (isVADActive && !holdTimeout) {
            holdTimeout = setTimeout(() => {
                isVADActive = false;
                updateVADStatus(false);
                holdTimeout = null;
            }, holdTime);
        }
    }
}

// ─────────────────────────────────────────────
// LIFECYCLE MANAGEMENT
// ─────────────────────────────────────────────

async function startMainMic() {
    if (isTesting) stopTestMic();
    if (isMainMicOn) return null;

    try {
        micStream = await navigator.mediaDevices.getUserMedia({
            audio: { noiseSuppression: true, echoCancellation: true, autoGainControl: true }
        });

        audioContext = new (window.AudioContext || window.webkitAudioContext)();
        if (audioContext.state === 'suspended') await audioContext.resume();

        const source = audioContext.createMediaStreamSource(micStream);
        const pipeline = buildAudioPipeline(audioContext, source);
        
        analyser = pipeline.analyserNode;
        outTrack = pipeline.destStream.getAudioTracks()[0];
        outTrack.enabled = false; // เริ่มต้นด้วยการปิดไมค์จนกว่าจะตรวจเจอเสียง

        isMainMicOn = true;
        startVADLoop();
        startUILoop();

        return new MediaStream([outTrack]);
    } catch (err) {
        console.error('Mic initialization failed:', err);
        return null;
    }
}

function stopMainMic() {
    isMainMicOn = false;
    isVADActive = false;
    stopVADLoop();
    stopUILoop();
    if (holdTimeout) {
        clearTimeout(holdTimeout);
        holdTimeout = null;
    }

    if (micStream) {
        micStream.getTracks().forEach(t => t.stop());
        micStream = null;
    }
    if (audioContext) {
        audioContext.close();
        audioContext = null;
    }
    
    analyser = null;
    outTrack = null;
    hpfNode = null;
    gainNodeRef = null;
    lastVolumePercent = 0;
    updateVADStatus(false);
}

// ─────────────────────────────────────────────
// TEST MIC (UI ONLY)
// ─────────────────────────────────────────────

testMicBtn.addEventListener('click', async () => {
    if (isTesting) stopTestMic();
    else if (!isMainMicOn) await startTestMic();
});

async function startTestMic() {
    try {
        micStream = await navigator.mediaDevices.getUserMedia({ audio: true });
        audioContext = new (window.AudioContext || window.webkitAudioContext)();
        analyser = audioContext.createAnalyser();
        analyser.fftSize = VAD_CONFIG.FFT_SIZE;

        const source = audioContext.createMediaStreamSource(micStream);
        source.connect(analyser);

        isTesting = true;
        testMicBtn.innerText = '⏹️ หยุดทดสอบ';
        testMicBtn.classList.add('active');

        startVADLoop();
        startUILoop();
    } catch (err) {
        console.error('Test mic error:', err);
        alert('กรุณาอนุญาตการเข้าถึงไมโครโฟน');
    }
}

function stopTestMic() {
    isTesting = false;
    stopMainMic();
    testMicBtn.innerHTML = '🎙️ ทดสอบระดับเสียง';
    testMicBtn.classList.remove('active');
    volumeMeterFill.style.width = '0%';
    currentVolumeText.innerText = 'ระดับเสียง: 0%';
}

// ─────────────────────────────────────────────
// LOOPS & UI
// ─────────────────────────────────────────────

function startVADLoop() {
    if (vadIntervalId) clearInterval(vadIntervalId);
    vadIntervalId = setInterval(processVAD, VAD_CONFIG.VAD_INTERVAL_MS);
}

function stopVADLoop() {
    if (vadIntervalId) {
        clearInterval(vadIntervalId);
        vadIntervalId = null;
    }
}

function startUILoop() {
    if (uiIntervalId) clearInterval(uiIntervalId);
    uiIntervalId = setInterval(() => {
        if (volumeMeterFill) volumeMeterFill.style.width = `${lastVolumePercent}%`;
        if (currentVolumeText) currentVolumeText.innerText = `ระดับเสียง: ${lastVolumePercent}%`;
    }, VAD_CONFIG.UI_INTERVAL_MS);
}

function stopUILoop() {
    if (uiIntervalId) {
        clearInterval(uiIntervalId);
        uiIntervalId = null;
    }
}

function updateVADStatus(isActive) {
    if (outTrack) outTrack.enabled = isActive;
    if (window.ClearWayWebRTC?.broadcastMicStatus) {
        window.ClearWayWebRTC.broadcastMicStatus(isActive);
    }
    if (micStatusBadge) {
        micStatusBadge.className = `status-badge ${isActive ? 'active' : 'muted'}`;
    }
    if (micStatusText) {
        micStatusText.innerText = isActive ? '🎙️ ไมค์เปิด (กำลังส่งเสียง)' : '🎙️ ไมค์ปิด (รอเสียง)';
    }
}

// ─────────────────────────────────────────────
// EXPORTED API
// ─────────────────────────────────────────────

function applyPresetToAudio(highpassHz, gain) {
    VAD_CONFIG.HIGHPASS_FREQ = highpassHz;
    VAD_CONFIG.GAIN_VALUE = gain;

    // Live update nodes without restarting stream
    if (audioContext && hpfNode) {
        hpfNode.frequency.setTargetAtTime(highpassHz, audioContext.currentTime, 0.1);
    }
    if (audioContext && gainNodeRef) {
        gainNodeRef.gain.setTargetAtTime(gain, audioContext.currentTime, 0.1);
    }
}

window.startMainMic = startMainMic;
window.stopMainMic = stopMainMic;
window.applyPresetToAudio = applyPresetToAudio;
