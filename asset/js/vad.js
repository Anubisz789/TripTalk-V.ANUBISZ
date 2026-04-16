// asset/js/vad.js

// ─────────────────────────────────────────────
// CONFIG — ปรับค่าได้ทั้งหมดที่นี่
// (properties สามารถ mutate ได้ตอน runtime เช่น VAD_CONFIG.HIGHPASS_FREQ = 150)
// ─────────────────────────────────────────────
const VAD_CONFIG = {
    SMOOTHING_ALPHA:      0.2,
    NOISE_FLOOR_ALPHA:    0.003,
    NOISE_FLOOR_MARGIN:   8,
    MIN_HOLD_MS:          300,
    HIGHPASS_FREQ:        100,    // Hz — ตัดเสียงลม/เครื่องยนต์ (ปรับได้ผ่าน preset)
    GAIN_VALUE:           1.4,    // boost เสียงพูด (ปรับได้ผ่าน preset)
    FFT_SIZE:             512,
    VAD_INTERVAL_MS:      40,
    UI_INTERVAL_MS:       100,
    VOICE_CONFIRM_FRAMES: 2,
};

// ─────────────────────────────────────────────
// STATE
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
// [ADDED] เก็บ reference ของ audio nodes เพื่ออัปเดต config แบบ live (ไม่ต้อง restart)
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
// TEST MIC
// ─────────────────────────────────────────────
testMicBtn.addEventListener('click', async () => {
    if (isTesting)         stopTestMic();
    else if (!isMainMicOn) await startTestMic();
});

async function startTestMic() {
    try {
        micStream = await navigator.mediaDevices.getUserMedia({
            audio: { noiseSuppression: true, echoCancellation: true, autoGainControl: true }
        });
        audioContext = new (window.AudioContext || window.webkitAudioContext)();
        analyser     = audioContext.createAnalyser();
        analyser.fftSize = VAD_CONFIG.FFT_SIZE;

        const source = audioContext.createMediaStreamSource(micStream);
        source.connect(analyser);

        isTesting         = true;
        smoothedVolume    = 0;
        noiseFloor        = 0;
        voiceFrameCount   = 0;
        testMicBtn.innerText = '⏹️ หยุดทดสอบ';
        testMicBtn.classList.add('active');

        startVADLoop();
        startUILoop();
    } catch (err) {
        console.error('Mic error:', err);
        alert('กรุณาอนุญาตการเข้าถึงไมโครโฟน');
    }
}

function stopTestMic() {
    isTesting       = false;
    isVADActive     = false;
    voiceFrameCount = 0;
    stopVADLoop();
    stopUILoop();
    clearTimeout(holdTimeout);
    holdTimeout = null;

    if (micStream)    { micStream.getTracks().forEach(t => t.stop()); micStream = null; }
    if (audioContext) { audioContext.close(); audioContext = null; }
    analyser    = null;
    // [ADDED] clear node refs เมื่อ stop
    hpfNode     = null;
    gainNodeRef = null;

    testMicBtn.innerHTML = '🎙️ ทดสอบระดับเสียง';
    testMicBtn.classList.remove('active');
    lastVolumePercent = 0;
    volumeMeterFill.style.width = '0%';
    currentVolumeText.innerText = 'ระดับเสียง: 0%';
    updateVADStatus(false);
}

// ─────────────────────────────────────────────
// AUDIO PIPELINE
// Mic → HighPassFilter → Gain → Analyser + MediaStreamDestination
// ─────────────────────────────────────────────
function buildAudioPipeline(ctx, source) {
    const hpf = ctx.createBiquadFilter();
    hpf.type            = 'highpass';
    hpf.frequency.value = VAD_CONFIG.HIGHPASS_FREQ;
    hpf.Q.value         = 0.7;

    const gainNode = ctx.createGain();
    gainNode.gain.value = VAD_CONFIG.GAIN_VALUE;

    const analyserNode = ctx.createAnalyser();
    analyserNode.fftSize = VAD_CONFIG.FFT_SIZE;

    const dest = ctx.createMediaStreamDestination();

    source.connect(hpf);
    hpf.connect(gainNode);
    gainNode.connect(analyserNode);
    gainNode.connect(dest);

    // [ADDED] เก็บ reference สำหรับ live update ผ่าน applyPresetToAudio()
    hpfNode     = hpf;
    gainNodeRef = gainNode;

    return { analyserNode, destStream: dest.stream };
}

// ─────────────────────────────────────────────
// VAD LOOP
// ─────────────────────────────────────────────
function startVADLoop() {
    if (vadIntervalId) return;
    vadIntervalId = setInterval(processVAD, VAD_CONFIG.VAD_INTERVAL_MS);
}

function stopVADLoop() {
    if (vadIntervalId) { clearInterval(vadIntervalId); vadIntervalId = null; }
}

function processVAD() {
    if (!analyser) return;

    const dataArray = new Uint8Array(analyser.frequencyBinCount);
    analyser.getByteFrequencyData(dataArray);

    let sumSq = 0;
    for (let i = 0; i < dataArray.length; i++) sumSq += dataArray[i] * dataArray[i];
    const rms        = Math.sqrt(sumSq / dataArray.length);
    const rawPercent = Math.min(100, Math.round((rms / 255) * 100 * 2));

    smoothedVolume    = VAD_CONFIG.SMOOTHING_ALPHA * rawPercent
                      + (1 - VAD_CONFIG.SMOOTHING_ALPHA) * smoothedVolume;
    lastVolumePercent = Math.round(smoothedVolume);

    if (!isVADActive) {
        noiseFloor = VAD_CONFIG.NOISE_FLOOR_ALPHA * lastVolumePercent
                   + (1 - VAD_CONFIG.NOISE_FLOOR_ALPHA) * noiseFloor;
    }

    const userThreshold      = parseInt(thresholdSlider.value, 10);
    const holdTime           = Math.max(parseInt(holdTimeSlider.value, 10), VAD_CONFIG.MIN_HOLD_MS);
    const effectiveThreshold = Math.max(userThreshold, noiseFloor + VAD_CONFIG.NOISE_FLOOR_MARGIN);

    if (lastVolumePercent >= effectiveThreshold) {
        voiceFrameCount++;
        if (!isVADActive && voiceFrameCount >= VAD_CONFIG.VOICE_CONFIRM_FRAMES) {
            isVADActive = true;
            updateVADStatus(true);
        }
        clearTimeout(holdTimeout);
        holdTimeout = null;
    } else {
        voiceFrameCount = 0;
        if (isVADActive && !holdTimeout) {
            holdTimeout = setTimeout(() => {
                isVADActive     = false;
                voiceFrameCount = 0;
                updateVADStatus(false);
                holdTimeout = null;
            }, holdTime);
        }
    }
}

// ─────────────────────────────────────────────
// UI LOOP
// ─────────────────────────────────────────────
function startUILoop() {
    if (uiIntervalId) return;
    uiIntervalId = setInterval(() => {
        volumeMeterFill.style.width = `${lastVolumePercent}%`;
        currentVolumeText.innerText = `ระดับเสียง: ${lastVolumePercent}%`;
    }, VAD_CONFIG.UI_INTERVAL_MS);
}

function stopUILoop() {
    if (uiIntervalId) { clearInterval(uiIntervalId); uiIntervalId = null; }
}

// ─────────────────────────────────────────────
// MAIN MIC
// ─────────────────────────────────────────────
async function startMainMic() {
    if (isTesting)   stopTestMic();
    if (isMainMicOn) return null;

    try {
        micStream = await navigator.mediaDevices.getUserMedia({
            audio: { noiseSuppression: true, echoCancellation: true, autoGainControl: true }
        });

        audioContext = new (window.AudioContext || window.webkitAudioContext)();
        if (audioContext.state === 'suspended') await audioContext.resume();

        const source   = audioContext.createMediaStreamSource(micStream);
        const pipeline = buildAudioPipeline(audioContext, source);
        analyser       = pipeline.analyserNode;

        outTrack = pipeline.destStream.getAudioTracks()[0];
        // [FIXED] removed track.enabled control

        const outStream = new MediaStream([outTrack]);

        smoothedVolume  = 0;
        noiseFloor      = 0;
        voiceFrameCount = 0;
        isMainMicOn     = true;

        startVADLoop();
        startUILoop();

        return outStream;

    } catch (err) {
        console.error('Mic error:', err);
        return null;
    }
}

function stopMainMic() {
    isMainMicOn     = false;
    isVADActive     = false;
    voiceFrameCount = 0;
    stopVADLoop();
    stopUILoop();
    clearTimeout(holdTimeout);
    holdTimeout = null;

    if (micStream)    { micStream.getTracks().forEach(t => t.stop()); micStream = null; }
    if (audioContext) { audioContext.close(); audioContext = null; }
    analyser          = null;
    outTrack          = null;
    // [ADDED] clear node refs เมื่อ stop
    hpfNode           = null;
    gainNodeRef       = null;

    lastVolumePercent = 0;
    updateVADStatus(false);
}

// ─────────────────────────────────────────────
// VAD STATUS
// ─────────────────────────────────────────────
function updateVADStatus(isActive) {
    // [FIXED] use gain instead of track.enabled to avoid WebRTC audio drop
    if (gainNodeRef && audioContext) {
        const now = audioContext.currentTime;
        if (isActive) {
            gainNodeRef.gain.setTargetAtTime(VAD_CONFIG.GAIN_VALUE, now, 0.02);
        } else {
            gainNodeRef.gain.setTargetAtTime(0.0001, now, 0.02);
        }
    }

    if (outTrack) // [FIXED] removed track.enabled control

    if (window.ClearWayWebRTC?.broadcastMicStatus) {
        window.ClearWayWebRTC.broadcastMicStatus(isActive);
    }

    if (isActive) {
        micStatusBadge.classList.replace('muted', 'active');
        micStatusText.innerText = '🎙️ ไมค์เปิด (กำลังส่งเสียง)';
    } else {
        micStatusBadge.classList.replace('active', 'muted');
        micStatusText.innerText = '🎙️ ไมค์ปิด (รอเสียง)';
    }
}

// ─────────────────────────────────────────────
// [ADDED] PRESET AUDIO APPLY
// เรียกจาก app.js เมื่อผู้ใช้เลือก preset
// อัปเดต config ทันที และ apply ไป live audio nodes ถ้ากำลัง run อยู่
// ─────────────────────────────────────────────
function applyPresetToAudio(highpassHz, gain) {
    // อัปเดต config — ใช้ครั้งต่อไปที่ buildAudioPipeline ถูกเรียก
    VAD_CONFIG.HIGHPASS_FREQ = highpassHz;
    VAD_CONFIG.GAIN_VALUE    = gain;

    // [ADDED] อัปเดต live nodes ทันทีถ้ากำลัง run อยู่ — ไม่ต้อง restart mic
    if (audioContext && hpfNode) {
        hpfNode.frequency.setTargetAtTime(highpassHz, audioContext.currentTime, 0.05);
    }
    if (audioContext && gainNodeRef) {
        gainNodeRef.gain.setTargetAtTime(gain, audioContext.currentTime, 0.05);
    }
}
