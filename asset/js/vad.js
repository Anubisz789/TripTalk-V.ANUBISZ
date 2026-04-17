// asset/js/vad.js

// ─────────────────────────────────────────────
// CONFIG
// ─────────────────────────────────────────────
const VAD_CONFIG = {
    SMOOTHING_ALPHA:    0.2,    // Exponential smoothing (สูงขึ้นเพื่อ response เร็วขึ้น)
    NOISE_FLOOR_ALPHA:  0.003,  // เรียนรู้ noise floor ช้าๆ
    NOISE_FLOOR_MARGIN: 8,      // % เผื่อเหนือ noise floor
    MIN_HOLD_MS:        300,    // Hold time ขั้นต่ำ
    HIGHPASS_FREQ:      120,    // Hz — ตัดเสียงลม/เครื่องยนต์
    GAIN_VALUE:         1.3,    // boost เสียงพูด
    FFT_SIZE:           512,    // ใหญ่ขึ้น = วัด freq แม่นขึ้น แต่ยังเบา
    VAD_INTERVAL_MS:    40,     // วัด VAD ทุก 40ms (25fps) แทน 60fps — ประหยัด CPU
    UI_INTERVAL_MS:     100,    // อัปเดต UI ทุก 100ms — ลด DOM write
};

// ─────────────────────────────────────────────
// STATE
// ─────────────────────────────────────────────
let audioContext    = null;
let analyser        = null;
let micStream       = null;
let outTrack        = null;     // AudioTrack ที่ส่งให้ WebRTC โดยตรง (ไม่ clone)
let vadIntervalId   = null;     // ใช้ setInterval แทน requestAnimationFrame
let uiIntervalId    = null;     // interval สำหรับ UI update แยกออกมา
let isTesting       = false;
let isMainMicOn     = false;
let isVADActive     = false;
let holdTimeout     = null;
let smoothedVolume  = 0;
let noiseFloor      = 0;
let lastVolumePercent = 0;      // cache ค่าล่าสุดสำหรับ UI

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
    if (isTesting)       stopTestMic();
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

        isTesting      = true;
        smoothedVolume = 0;
        noiseFloor     = 0;
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
    isTesting   = false;
    isVADActive = false;
    stopVADLoop();
    stopUILoop();
    clearTimeout(holdTimeout);
    holdTimeout = null;

    if (micStream)   { micStream.getTracks().forEach(t => t.stop()); micStream = null; }
    if (audioContext){ audioContext.close(); audioContext = null; }

    testMicBtn.innerHTML = '🎙️ ทดสอบระดับเสียง';
    testMicBtn.classList.remove('active');
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

    return { analyserNode, destStream: dest.stream };
}

// ─────────────────────────────────────────────
// VAD LOOP — ใช้ setInterval แทน requestAnimationFrame ประหยัด CPU มาก
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

    // RMS — แม่นกว่า average
    let sumSq = 0;
    for (let i = 0; i < dataArray.length; i++) sumSq += dataArray[i] * dataArray[i];
    const rms        = Math.sqrt(sumSq / dataArray.length);
    const rawPercent = Math.min(100, Math.round((rms / 255) * 100 * 2));

    // Exponential smoothing
    smoothedVolume    = VAD_CONFIG.SMOOTHING_ALPHA * rawPercent + (1 - VAD_CONFIG.SMOOTHING_ALPHA) * smoothedVolume;
    lastVolumePercent = Math.round(smoothedVolume);

    // Noise floor อัปเดตเฉพาะตอนเงียบ
    if (!isVADActive) {
        noiseFloor = VAD_CONFIG.NOISE_FLOOR_ALPHA * lastVolumePercent + (1 - VAD_CONFIG.NOISE_FLOOR_ALPHA) * noiseFloor;
    }

    const userThreshold      = parseInt(thresholdSlider.value, 10);
    const holdTime           = Math.max(parseInt(holdTimeSlider.value, 10), VAD_CONFIG.MIN_HOLD_MS);
    const effectiveThreshold = Math.max(userThreshold, noiseFloor + VAD_CONFIG.NOISE_FLOOR_MARGIN);

    if (lastVolumePercent >= effectiveThreshold) {
        if (!isVADActive) { isVADActive = true; updateVADStatus(true); }
        clearTimeout(holdTimeout);
        holdTimeout = null;
    } else {
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
// UI LOOP — แยกออกมา อัปเดตช้ากว่า VAD Loop
// ─────────────────────────────────────────────
function startUILoop() {
    if (uiIntervalId) return;
    uiIntervalId = setInterval(() => {
        volumeMeterFill.style.width     = `${lastVolumePercent}%`;
        currentVolumeText.innerText     = `ระดับเสียง: ${lastVolumePercent}%`;
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

        // ✅ ใช้ track จาก destStream โดยตรง — ไม่ clone
        // เพราะ clone track กับ source track เป็นคนละ object
        // การ enable/disable clone ไม่กระทบสิ่งที่ WebRTC ส่งออกจริง
        outTrack = pipeline.destStream.getAudioTracks()[0];
        outTrack.enabled = false; // ปิดไว้ก่อน รอ VAD สั่งเปิด

        // สร้าง MediaStream ใหม่จาก outTrack เพื่อส่งให้ WebRTC
        const outStream = new MediaStream([outTrack]);

        smoothedVolume = 0;
        noiseFloor     = 0;
        isMainMicOn    = true;

        startVADLoop();
        startUILoop();

        return outStream;

    } catch (err) {
        console.error('Mic error:', err);
        return null;
    }
}

function stopMainMic() {
    isMainMicOn = false;
    isVADActive = false;
    stopVADLoop();
    stopUILoop();
    clearTimeout(holdTimeout);
    holdTimeout = null;

    if (micStream)   { micStream.getTracks().forEach(t => t.stop()); micStream = null; }
    if (audioContext){ audioContext.close(); audioContext = null; }
    outTrack = null;

    updateVADStatus(false);
}

// ─────────────────────────────────────────────
// VAD STATUS
// ─────────────────────────────────────────────
function updateVADStatus(isActive) {
    // เปิด/ปิด track ที่ส่งให้ WebRTC โดยตรง
    if (outTrack) outTrack.enabled = isActive;

    // แจ้ง WebRTC
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
