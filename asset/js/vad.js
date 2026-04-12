// asset/js/vad.js

// ตัวแปรระบบเสียง
let audioContext;
let analyser;
let micStream;
let outStream;
let animationId;
let isTesting = false;    // สำหรับปุ่ม "ทดสอบระดับเสียง" เท่านั้น
let isMainMicOn = false;  // สำหรับทริปจริง (แยกออกจาก isTesting)

// สถานะการทำงานของ VAD (Voice Activity Detection)
let isVADActive = false;
let holdTimeout;

// ดึง Elements จาก DOM
const testMicBtn = document.getElementById('testMicBtn');
const volumeMeterFill = document.getElementById('volumeMeterFill');
const currentVolumeText = document.getElementById('currentVolumeText');
const thresholdSlider = document.getElementById('thresholdSlider');
const holdTimeSlider = document.getElementById('holdTimeSlider');
const micStatusBadge = document.getElementById('micStatusBadge');
const micStatusText = document.getElementById('micStatusText');

// ผูก Event ให้ปุ่ม Test Mic
testMicBtn.addEventListener('click', async () => {
    if (isTesting) {
        stopTestMic();
    } else if (!isMainMicOn) { 
        await startTestMic();
    }
});

async function startTestMic() {
    try {
        // 1. ขอสิทธิ์ใช้งานไมโครโฟน
        micStream = await navigator.mediaDevices.getUserMedia({
            audio: {
                noiseSuppression: true,
                echoCancellation: true,
                autoGainControl: true
            }
        });

        // 2. สร้าง AudioContext
        audioContext = new (window.AudioContext || window.webkitAudioContext)();
        analyser = audioContext.createAnalyser();
        analyser.fftSize = 256;

        const source = audioContext.createMediaStreamSource(micStream);
        
        // --- ส่วนที่แก้ไข: เชื่อมต่อสัญญาณเสียง ---
        source.connect(analyser);             // ส่งไปที่ Analyser เพื่อวัดระดับความดัง (แถบวิ่ง)
        source.connect(audioContext.destination); // ส่งไปที่ลำโพง เพื่อให้เราได้ยินเสียงตัวเองตอนทดสอบ

        // เปลี่ยนสถานะ UI
        isTesting = true;
        testMicBtn.innerText = '⏹️ หยุดทดสอบ';
        testMicBtn.classList.add('active');

        // 3. เริ่มลูปอ่านค่าความดัง
        checkVolume();

    } catch (err) {
        console.error('ไม่สามารถเข้าถึงไมโครโฟนได้:', err);
        alert('กรุณาอนุญาตการเข้าถึงไมโครโฟนบนเบราว์เซอร์เพื่อใช้งาน ClearWay');
    }
}

function stopTestMic() {
    isTesting = false;
    isVADActive = false;
    cancelAnimationFrame(animationId);
    clearTimeout(holdTimeout);
    holdTimeout = null;

    // ปิด Stream และ AudioContext ให้สนิท
    if (micStream) { 
        micStream.getTracks().forEach(track => track.stop()); 
        micStream = null; 
    }
    if (audioContext) { 
        audioContext.close(); 
        audioContext = null; 
    }

    testMicBtn.innerHTML = '🎙️ ทดสอบระดับเสียง';
    testMicBtn.classList.remove('active');
    volumeMeterFill.style.width = '0%';
    currentVolumeText.innerText = 'ระดับเสียง: 0%';
    updateVADStatus(false);
}

function checkVolume() {
    if (!isTesting && !isMainMicOn) return;

    const dataArray = new Uint8Array(analyser.frequencyBinCount);
    analyser.getByteFrequencyData(dataArray);

    let sum = 0;
    for (let i = 0; i < dataArray.length; i++) {
        sum += dataArray[i];
    }
    let average = sum / dataArray.length;

    // เพิ่ม Sensitivity ให้ตอบสนองไวขึ้น
    let volumePercent = Math.min(100, Math.round((average / 255) * 100 * 2)); 

    volumeMeterFill.style.width = `${volumePercent}%`;
    currentVolumeText.innerText = `ระดับเสียง: ${volumePercent}%`;

    const threshold = parseInt(thresholdSlider.value, 10);
    const holdTime = parseInt(holdTimeSlider.value, 10);

    if (volumePercent >= threshold) {
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

async function startMainMic() {
    if (isTesting) stopTestMic(); 
    if (isMainMicOn) return null;

    try {
        micStream = await navigator.mediaDevices.getUserMedia({
            audio: { noiseSuppression: true, echoCancellation: true, autoGainControl: true }
        });
        
        outStream = micStream.clone();
        outStream.getAudioTracks()[0].enabled = false; 

        audioContext = new (window.AudioContext || window.webkitAudioContext)();
        if (audioContext.state === 'suspended') await audioContext.resume();
        
        analyser = audioContext.createAnalyser();
        analyser.fftSize = 256;
        
        const source = audioContext.createMediaStreamSource(micStream);
        source.connect(analyser);
        // หมายเหตุ: สำหรับ MainMic เราไม่ต่อเข้า destination เพราะไม่อยากได้ยินเสียงตัวเองสะท้อนขณะคุยจริง

        isMainMicOn = true;
        checkVolume(); 

        return outStream; 
    } catch (err) {
        console.error("Mic error:", err);
        return null;
    }
}

function stopMainMic() {
    isMainMicOn = false;
    isVADActive = false;
    cancelAnimationFrame(animationId);
    clearTimeout(holdTimeout);
    holdTimeout = null;
    
    if (micStream) micStream.getTracks().forEach(track => track.stop());
    if (outStream) outStream.getAudioTracks().forEach(track => track.stop());
    micStream = null;
    outStream = null;
    
    if (audioContext) { audioContext.close(); audioContext = null; }
    updateVADStatus(false);
}

function updateVADStatus(isActive) {
    if (outStream && outStream.getAudioTracks().length > 0) {
        outStream.getAudioTracks()[0].enabled = isActive;
    }

    if (window.ClearWayWebRTC && window.ClearWayWebRTC.broadcastMicStatus) {
        window.ClearWayWebRTC.broadcastMicStatus(isActive);
    }
    
    if (isActive) {
        micStatusBadge.classList.remove('muted');
        micStatusBadge.classList.add('active');
        micStatusText.innerText = '🎙️ ไมค์เปิด (กำลังส่งเสียง)';
    } else {
        micStatusBadge.classList.remove('active');
        micStatusBadge.classList.add('muted');
        micStatusText.innerText = '🎙️ ไมค์ปิด (รอเสียง)';
    }
}
