// asset/js/vad.js

// ─────────────────────────────────────────────
// CONFIG — ปรับค่าได้ทั้งหมดที่นี่
// ─────────────────────────────────────────────
const VAD_CONFIG = {
    SMOOTHING_ALPHA:      0.2,    // Exponential smoothing (0=ช้า, 1=เร็ว)
    NOISE_FLOOR_ALPHA:    0.003,  // ความเร็วเรียนรู้ noise floor (ช้าๆ)
    NOISE_FLOOR_MARGIN:   8,      // % เผื่อเหนือ noise floor
    MIN_HOLD_MS:          300,    // Hold time ขั้นต่ำ — ป้องกันเสียงตัดกลางประโยค
    // [MODIFIED] ลด HIGHPASS จาก 120 → 100 Hz เพื่อเก็บ fundamental voice freq (ผู้ชาย ~85Hz)
    HIGHPASS_FREQ:        100,    // Hz — ตัดเสียงลม/เครื่องยนต์ ยังเก็บเสียงพูดไว้
    GAIN_VALUE:           1.4,    // boost เสียงพูด (1.0 = ไม่เปลี่ยน, max 1.8)
    FFT_SIZE:             512,    // frequency resolution — สมดุล CPU vs ความแม่นยำ
    VAD_INTERVAL_MS:      40,     // วัด VAD ทุก 40ms (25fps) — ประหยัด CPU
    UI_INTERVAL_MS:       100,    // อัปเดต UI ทุก 100ms — ลด DOM write
    // [ADDED] ต้องเจอเสียงดังต่อกัน N frames ก่อนถือว่ากำลังพูด — ป้องกัน false trigger จากเสียงลมกระโชก
    VOICE_CONFIRM_FRAMES: 2,
};

// ─────────────────────────────────────────────
// STATE
// ─────────────────────────────────────────────
let audioContext      = null;
let analyser          = null;
let micStream         = null;
let outTrack          = null;       // AudioTrack ส่งให้ WebRTC โดยตรง (ไม่ clone)
let vadIntervalId     = null;
let uiIntervalId      = null;
let isTesting         = false;
let isMainMicOn       = false;
let isVADActive       = false;
let holdTimeout       = null;
let smoothedVolume    = 0;
let noiseFloor        = 0;
let lastVolumePercent = 0;
// [ADDED] นับ frames ที่เสียงเกิน threshold ต่อเนื่อง — ป้องกัน false trigger
let voiceFrameCount   = 0;

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
        voiceFrameCount   = 0; // [ADDED] reset counter
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
    voiceFrameCount = 0; // [ADDED] reset counter
    stopVADLoop();
    stopUILoop();
    clearTimeout(holdTimeout);
    holdTimeout = null;

    if (micStream)    { micStream.getTracks().forEach(t => t.stop()); micStream = null; }
    // [FIXED] close audioContext แล้ว null analyser ด้วย — ป้องกัน stale reference
    if (audioContext) { audioContext.close(); audioContext = null; }
    analyser = null;

    testMicBtn.innerHTML = '🎙️ ทดสอบระดับเสียง';
    testMicBtn.classList.remove('active');
    // [FIXED] reset lastVolumePercent ด้วย ป้องกัน UI ค้างค่าเก่า
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
    // [MODIFIED] HPF freq ตาม CONFIG (100Hz) — ตัดเสียงลม/เครื่องยนต์ ยังเก็บเสียงพูด
    const hpf = ctx.createBiquadFilter();
    hpf.type            = 'highpass';
    hpf.frequency.value = VAD_CONFIG.HIGHPASS_FREQ;
    hpf.Q.value         = 0.7; // gentle slope ไม่ตัดหักเกินไป

    const gainNode = ctx.createGain();
    gainNode.gain.value = VAD_CONFIG.GAIN_VALUE;

    const analyserNode = ctx.createAnalyser();
    analyserNode.fftSize = VAD_CONFIG.FFT_SIZE;

    const dest = ctx.createMediaStreamDestination();

    // Chain: source → hpf → gain → analyser → dest
    source.connect(hpf);
    hpf.connect(gainNode);
    gainNode.connect(analyserNode);
    gainNode.connect(dest);

    return { analyserNode, destStream: dest.stream };
}

// ─────────────────────────────────────────────
// VAD LOOP — setInterval แทน requestAnimationFrame ประหยัด CPU
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

    // RMS — แม่นกว่า average สำหรับเสียงพูด
    let sumSq = 0;
    for (let i = 0; i < dataArray.length; i++) sumSq += dataArray[i] * dataArray[i];
    const rms        = Math.sqrt(sumSq / dataArray.length);
    const rawPercent = Math.min(100, Math.round((rms / 255) * 100 * 2));

    // Exponential smoothing — ป้องกันค่ากระโดด
    smoothedVolume    = VAD_CONFIG.SMOOTHING_ALPHA * rawPercent
                      + (1 - VAD_CONFIG.SMOOTHING_ALPHA) * smoothedVolume;
    lastVolumePercent = Math.round(smoothedVolume);

    // Noise floor — เรียนรู้เสียงพื้นหลังเฉพาะตอนเงียบ
    if (!isVADActive) {
        noiseFloor = VAD_CONFIG.NOISE_FLOOR_ALPHA * lastVolumePercent
                   + (1 - VAD_CONFIG.NOISE_FLOOR_ALPHA) * noiseFloor;
    }

    const userThreshold      = parseInt(thresholdSlider.value, 10);
    const holdTime           = Math.max(parseInt(holdTimeSlider.value, 10), VAD_CONFIG.MIN_HOLD_MS);
    const effectiveThreshold = Math.max(userThreshold, noiseFloor + VAD_CONFIG.NOISE_FLOOR_MARGIN);

    if (lastVolumePercent >= effectiveThreshold) {
        // [MODIFIED] ใช้ frame counter แทนการ trigger ทันที — ป้องกัน false trigger จากเสียงลมกระโชก
        voiceFrameCount++;
        if (!isVADActive && voiceFrameCount >= VAD_CONFIG.VOICE_CONFIRM_FRAMES) {
            isVADActive = true;
            updateVADStatus(true);
        }
        // reset hold timeout ทุกครั้งที่ยังมีเสียงอยู่
        clearTimeout(holdTimeout);
        holdTimeout = null;
    } else {
        // [FIXED] reset voiceFrameCount เมื่อเสียงต่ำกว่า threshold — ไม่สะสมข้ามช่วงเงียบ
        voiceFrameCount = 0;
        if (isVADActive && !holdTimeout) {
            holdTimeout = setTimeout(() => {
                isVADActive     = false;
                voiceFrameCount = 0; // [ADDED] ensure reset
                updateVADStatus(false);
                holdTimeout = null;
            }, holdTime);
        }
    }
}

// ─────────────────────────────────────────────
// UI LOOP — แยกออกมา อัปเดตช้ากว่า VAD (ประหยัด DOM write)
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

        // ✅ ใช้ track จาก destStream โดยตรง ไม่ clone
        // clone() สร้าง track ใหม่ที่ไม่เชื่อมกับ source — enable/disable ไม่กระทบเสียงที่ส่งจริง
        outTrack = pipeline.destStream.getAudioTracks()[0];
        outTrack.enabled = false; // ปิดไว้ก่อน รอ VAD สั่งเปิด

        // สร้าง MediaStream จาก outTrack ส่งให้ WebRTC
        const outStream = new MediaStream([outTrack]);

        smoothedVolume  = 0;
        noiseFloor      = 0;
        voiceFrameCount = 0; // [ADDED] reset counter ตอนเริ่มทริปใหม่
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
    voiceFrameCount = 0; // [ADDED] reset counter
    stopVADLoop();
    stopUILoop();
    clearTimeout(holdTimeout);
    holdTimeout = null;

    if (micStream)    { micStream.getTracks().forEach(t => t.stop()); micStream = null; }
    // [FIXED] null audioContext และ analyser หลัง close — ป้องกัน stale reference
    if (audioContext) { audioContext.close(); audioContext = null; }
    analyser = null;
    outTrack = null;

    // [FIXED] reset lastVolumePercent ป้องกัน UI loop อัปเดตค่าเก่าหลัง stop
    lastVolumePercent = 0;

    updateVADStatus(false);
}

// ─────────────────────────────────────────────
// VAD STATUS — อัปเดต UI + ควบคุม track + แจ้ง WebRTC
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
