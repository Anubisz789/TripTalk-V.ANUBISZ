// asset/js/vad.js

// ตัวแปรระบบเสียง
let audioContext;
let analyser;
let micStream;
let outStream;
let animationId;
let isTesting = false;

// สถานะการทำงานของ VAD (Voice Activity Detection)
let isVADActive = false;
let holdTimeout;

// ดึง Elements จาก DOM (อ้างอิงตาม ID ใน index.html)
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
    } else {
        await startTestMic();
    }
});

async function startTestMic() {
    try {
        // 1. ขอสิทธิ์ใช้งานไมโครโฟน และเปิดระบบตัดเสียงรบกวนพื้นฐานของ Browser
        micStream = await navigator.mediaDevices.getUserMedia({
            audio: {
                noiseSuppression: true,
                echoCancellation: true,
                autoGainControl: true
            }
        });

        // 2. สร้าง AudioContext เพื่อประมวลผลคลื่นเสียง
        audioContext = new (window.AudioContext || window.webkitAudioContext)();
        analyser = audioContext.createAnalyser();
        analyser.fftSize = 256;

        const source = audioContext.createMediaStreamSource(micStream);
        source.connect(analyser);

        // เปลี่ยนสถานะ UI ของปุ่ม
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
    cancelAnimationFrame(animationId); // หยุดลูป

    // ปิดการใช้งานไมค์และคืนทรัพยากร
    if (micStream) {
        micStream.getTracks().forEach(track => track.stop());
    }
    if (audioContext) {
        audioContext.close();
    }

    // รีเซ็ต UI กลับเป็นค่าเริ่มต้น
    testMicBtn.innerHTML = '🎙️ ทดสอบระดับเสียง';
    testMicBtn.classList.remove('active');
    volumeMeterFill.style.width = '0%';
    currentVolumeText.innerText = 'ระดับเสียง: 0%';
    updateVADStatus(false);
}

function checkVolume() {
    if (!isTesting) return;

    // ดึงค่าความถี่เสียงปัจจุบัน
    const dataArray = new Uint8Array(analyser.frequencyBinCount);
    analyser.getByteFrequencyData(dataArray);

    // หาค่าเฉลี่ยความดัง
    let sum = 0;
    for (let i = 0; i < dataArray.length; i++) {
        sum += dataArray[i];
    }
    let average = sum / dataArray.length;

    // แปลงค่าให้เป็นเปอร์เซ็นต์ (0-100%) 
    // หมายเหตุ: คูณ 2 เข้าไปเพื่อให้แถบสีตอบสนองกับเสียงพูดปกติได้ไวขึ้น ไม่ต้องตะโกน
    let volumePercent = Math.min(100, Math.round((average / 255) * 100 * 2)); 

    // อัปเดต UI แถบสีวิ่ง
    volumeMeterFill.style.width = `${volumePercent}%`;
    currentVolumeText.innerText = `ระดับเสียง: ${volumePercent}%`;

    // --- ส่วนลอจิกตัดเสียงลม (Noise Gate) ---
    const threshold = parseInt(thresholdSlider.value, 10);
    const holdTime = parseInt(holdTimeSlider.value, 10);

    if (volumePercent >= threshold) {
        // ถ้าระดับเสียง ทะลุเส้น Threshold ขาว -> สั่งเปิดไมค์
        if (!isVADActive) {
            isVADActive = true;
            updateVADStatus(true);
        }
        // รีเซ็ตตัวหน่วงเวลาทุกครั้งที่ยังมีเสียงดังอยู่
        clearTimeout(holdTimeout);
        holdTimeout = null;
        
    } else {
        // ถ้าระดับเสียง ตกต่ำกว่าเส้น Threshold -> เริ่มนับถอยหลังเตรียมปิดไมค์
        if (isVADActive && !holdTimeout) {
            holdTimeout = setTimeout(() => {
                isVADActive = false;
                updateVADStatus(false);
                holdTimeout = null;
            }, holdTime);
        }
    }

    // วนลูปอ่านค่าเฟรมถัดไป
    animationId = requestAnimationFrame(checkVolume);
}

// ฟังก์ชันอัปเดต Status Badge บนหน้าจอ
function updateVADStatus(isActive) {
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


// เพิ่มฟังก์ชันสำหรับใช้งานจริงตอนออกทริป (แยกจากการ Test Mic)
async function startMainMic() {
    if (isTesting) stopTestMic(); // เคลียร์ของเก่าก่อนเผื่อค้าง

    try {
        micStream = await navigator.mediaDevices.getUserMedia({
            audio: { noiseSuppression: true, echoCancellation: true, autoGainControl: true }
        });
        
        // ⚠️ [เพิ่มส่วนนี้] แยกร่างสตรีมเพื่อส่งให้เพื่อน
        outStream = micStream.clone();
        
        // ปิดเสียง "สตรีมที่จะส่งให้เพื่อน" ไว้ก่อน (รอให้ VAD สั่งเปิด)
        outStream.getAudioTracks()[0].enabled = false; 

        audioContext = new (window.AudioContext || window.webkitAudioContext)();
        if (audioContext.state === 'suspended') await audioContext.resume();
        
        analyser = audioContext.createAnalyser();
        analyser.fftSize = 256;
        
        // ⚠️ เอา "สตรีมตัวหลัก" (ที่เปิดอยู่ตลอด) ไปวิเคราะห์หาความดัง
        const source = audioContext.createMediaStreamSource(micStream);
        source.connect(analyser);

        isTesting = true; 
        checkVolume(); 

        // ⚠️ ส่ง "สตรีมร่างโคลน" (outStream) กลับไปให้ app.js เพื่อเข้า WebRTC
        return outStream; 
    } catch (err) {
        console.error("Mic error:", err);
        return null;
    }
}

function stopMainMic() {
    isTesting = false;
    cancelAnimationFrame(animationId);
    
    // ⚠️ ต้องสั่งหยุดการทำงานของสตรีมทั้ง 2 ตัว
    if (micStream) micStream.getTracks().forEach(track => track.stop());
    if (outStream) outStream.getTracks().forEach(track => track.stop());
    
    if (audioContext) audioContext.close();
    updateVADStatus(false);
}

// ⚠️ ให้หาบรรทัดฟังก์ชัน updateVADStatus(isActive) เดิม แล้วเติมโค้ดคุม WebRTC Track เข้าไปแบบนี้ครับ:
function updateVADStatus(isActive) {
    // ⚠️ สั่งเปิด/ปิดเสียงที่ "สตรีมร่างโคลน" (ตัวที่วิ่งไปหาเพื่อน) เท่านั้น!
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