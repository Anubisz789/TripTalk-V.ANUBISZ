// asset/js/vad.js
// ปรับปรุงระบบ VAD + Audio Processing สำหรับการขี่มอเตอร์ไซค์

// ─────────────────────────────────────────────
// CONFIG — ปรับค่าได้ทั้งหมดที่นี่
// ─────────────────────────────────────────────
const VAD_CONFIG = {
    SMOOTHING_ALPHA:    0.15,   // Exponential smoothing (0=ช้า, 1=เร็ว)
    NOISE_FLOOR_ALPHA:  0.002,  // ความเร็วในการเรียนรู้ noise floor (ช้าๆ)
    NOISE_FLOOR_MARGIN: 10,     // % เผื่อเหนือ noise floor ก่อนถือว่าเป็นเสียงพูด
    MIN_HOLD_MS:        300,    // Hold time ขั้นต่ำ (ป้องกันเสียงตัดกลางประโยค)
    HIGHPASS_FREQ:      100,    // Hz — ตัดความถี่ต่ำ (เสียงลม/เครื่องยนต์)
    GAIN_VALUE:         1.4,    // boost เสียงพูดเล็กน้อย (1.0 = ไม่เปลี่ยน)
    FFT_SIZE:           256,
};

// ─────────────────────────────────────────────
// STATE
// ─────────────────────────────────────────────
let audioContext;
let analyser;
let micStream;
let outStream;
let processedStream;   // stream หลังผ่าน filter+gain → ส่งให้ WebRTC
let animationId;
let isTesting    = false;
let isMainMicOn  = false;
let isVADActive  = false;
let holdTimeout  = null;

// VAD smoothing & noise floor
let smoothedVolume  = 0;
let noiseFloor      = 0;

// ─────────────────────────────────────────────
// DOM ELEMENTS
// ─────────────────────────────────────────────
const testMicBtn       = document.getElementById('testMicBtn');
const volumeMeterFill  = document.getElementById('volumeMeterFill');
const currentVolumeText= document.getElementById('currentVolumeText');
const thresholdSlider  = document.getElementById('thresholdSlider');
const holdTimeSlider   = document.getElementById('holdTimeSlider');
const micStatusBadge   = document.getElementById('micStatusBadge');
const micStatusText    = document.getElementById('micStatusText');

// ─────────────────────────────────────────────
// TEST MIC (ปุ่มทดสอบ — ไม่เชื่อม WebRTC)
// ─────────────────────────────────────────────
testMicBtn.addEventListener('click', async () => {
    if (isTesting) {
        stopTestMic();
    } else if (!isMainMicOn) {
        await startTestMic();
    }
});

async function startTestMic() {
    try {
        micStream = await navigator.mediaDevices.getUserMedia({
            audio: { noiseSuppression: true, echoCancellation: true, autoGainControl: true }
        });

        audioContext = new (window.AudioContext || window.webkitAudioContext)();
        analyser = audioContext.createAnalyser();
        analyser.fftSize = VAD_CONFIG.FFT_SIZE;

        // Test mic ไม่ใส่ filter เพื่อให้เห็นเสียงจริงๆ ตอนปรับ threshold
        const source = audioContext.createMediaStreamSource(micStream);
        source.connect(analyser);

        isTesting = true;
        smoothedVolume = 0;
        noiseFloor = 0;
        testMicBtn.innerText = '⏹️ หยุดทดสอบ';
        testMicBtn.classList.add('active');
        checkVolume();

    } catch (err) {
        console.error('ไม่สามารถเข้าถึงไมโครโฟนได้:', err);
        alert('กรุณาอนุญาตการเข้าถึงไมโครโฟน');
    }
}

function stopTestMic() {
    isTesting = false;
    isVADActive = false;
    cancelAnimationFrame(animationId);
    clearTimeout(holdTimeout);
    holdTimeout = null;

    if (micStream) { micStream.getTracks().forEach(t => t.stop()); micStream = null; }
    if (audioContext) { audioContext.close(); audioContext = null; }

    testMicBtn.innerHTML = '🎙️ ทดสอบระดับเสียง';
    testMicBtn.classList.remove('active');
    volumeMeterFill.style.width = '0%';
    currentVolumeText.innerText = 'ระดับเสียง: 0%';
    updateVADStatus(false);
}

// ─────────────────────────────────────────────
// AUDIO PROCESSING PIPELINE
// Mic → HighPassFilter → Gain → analyser + processedStream
// ─────────────────────────────────────────────
function buildAudioPipeline(ctx, source) {
    // 1. High-pass filter — ตัดเสียงลม/เครื่องยนต์ที่ความถี่ต่ำ
    const hpf = ctx.createBiquadFilter();
    hpf.type = 'highpass';
    hpf.frequency.value = VAD_CONFIG.HIGHPASS_FREQ;
    hpf.Q.value = 0.7; // gentle slope

    // 2. Gain — boost เสียงพูดเล็กน้อย
    const gainNode = ctx.createGain();
    gainNode.gain.value = VAD_CONFIG.GAIN_VALUE;

    // 3. Analyser สำหรับวัด volume
    const analyserNode = ctx.createAnalyser();
    analyserNode.fftSize = VAD_CONFIG.FFT_SIZE;

    // 4. MediaStreamDestination — ส่งออกเป็น stream ใหม่ที่ผ่าน filter แล้ว
    const dest = ctx.createMediaStreamDestination();

    // เชื่อม chain
    source.connect(hpf);
    hpf.connect(gainNode);
    gainNode.connect(analyserNode);
    gainNode.connect(dest);

    return { analyserNode, processedStream: dest.stream };
}

// ─────────────────────────────────────────────
// VAD VOLUME LOOP
// ─────────────────────────────────────────────
function checkVolume() {
    if (!isTesting && !isMainMicOn) return;

    const dataArray = new Uint8Array(analyser.frequencyBinCount);
    analyser.getByteFrequencyData(dataArray);

    // คำนวณ RMS แทน average — แม่นยำกว่าสำหรับเสียงพูด
    let sumSq = 0;
    for (let i = 0; i < dataArray.length; i++) {
        sumSq += dataArray[i] * dataArray[i];
    }
    const rms = Math.sqrt(sumSq / dataArray.length);
    const rawPercent = Math.min(100, Math.round((rms / 255) * 100 * 2));

    // Exponential smoothing — ป้องกันค่ากระโดด
    smoothedVolume = VAD_CONFIG.SMOOTHING_ALPHA * rawPercent
                   + (1 - VAD_CONFIG.SMOOTHING_ALPHA) * smoothedVolume;
    const volumePercent = Math.round(smoothedVolume);

    // อัปเดต Noise Floor อย่างช้าๆ (เรียนรู้เสียงพื้นหลัง)
    // อัปเดตเฉพาะตอน VAD ไม่ active เพื่อไม่ให้เสียงพูดรบกวน noise floor
    if (!isVADActive) {
        noiseFloor = VAD_CONFIG.NOISE_FLOOR_ALPHA * volumePercent
                   + (1 - VAD_CONFIG.NOISE_FLOOR_ALPHA) * noiseFloor;
    }

    // อัปเดต UI
    volumeMeterFill.style.width = `${volumePercent}%`;
    currentVolumeText.innerText = `ระดับเสียง: ${volumePercent}%`;

    // ─── VAD Logic ───
    const userThreshold  = parseInt(thresholdSlider.value, 10);
    const holdTime       = Math.max(parseInt(holdTimeSlider.value, 10), VAD_CONFIG.MIN_HOLD_MS);

    // threshold จริง = ค่าที่ user ตั้ง หรือ noise floor + margin (เอาค่าสูงกว่า)
    const effectiveThreshold = Math.max(userThreshold, noiseFloor + VAD_CONFIG.NOISE_FLOOR_MARGIN);

    if (volumePercent >= effectiveThreshold) {
        if (!isVADActive) {
            isVADActive = true;
            updateVADStatus(true);
        }
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

    animationId = requestAnimationFrame(checkVolume);
}

// ─────────────────────────────────────────────
// MAIN MIC (ใช้จริงตอนออกทริป)
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

        // ใส่ Audio Processing Pipeline
        const pipeline = buildAudioPipeline(audioContext, source);
        analyser       = pipeline.analyserNode;
        processedStream = pipeline.processedStream;

        // Clone processed stream เพื่อส่ง WebRTC — ปิดไว้ก่อน รอ VAD สั่งเปิด
        outStream = processedStream.clone();
        outStream.getAudioTracks()[0].enabled = false;

        smoothedVolume = 0;
        noiseFloor     = 0;
        isMainMicOn    = true;
        checkVolume();

        return outStream;

    } catch (err) {
        console.error('Mic error:', err);
        return null;
    }
}

function stopMainMic() {
    isMainMicOn  = false;
    isVADActive  = false;
    cancelAnimationFrame(animationId);
    clearTimeout(holdTimeout);
    holdTimeout = null;

    if (micStream)       { micStream.getTracks().forEach(t => t.stop());       micStream       = null; }
    if (outStream)       { outStream.getTracks().forEach(t => t.stop());        outStream       = null; }
    if (processedStream) { processedStream.getTracks().forEach(t => t.stop()); processedStream = null; }
    if (audioContext)    { audioContext.close();                                audioContext     = null; }

    updateVADStatus(false);
}

// ─────────────────────────────────────────────
// VAD STATUS — อัปเดต UI + ควบคุม track + แจ้ง WebRTC
// ─────────────────────────────────────────────
function updateVADStatus(isActive) {
    // เปิด/ปิด track ที่ส่งไปหาเพื่อน
    if (outStream && outStream.getAudioTracks().length > 0) {
        outStream.getAudioTracks()[0].enabled = isActive;
    }

    // แจ้ง WebRTC เพื่ออัปเดต bitrate + UI รายชื่อ
    if (window.ClearWayWebRTC && window.ClearWayWebRTC.broadcastMicStatus) {
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
