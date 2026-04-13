// asset/js/app.js


// ลงทะเบียน Service Worker สำหรับ PWA
if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
        navigator.serviceWorker.register('/sw.js')
            .then((registration) => {
                console.log('Service Worker ลงทะเบียนสำเร็จ:', registration.scope);
            })
            .catch((error) => {
                console.log('Service Worker ลงทะเบียนล้มเหลว:', error);
            });
    });
}


// --- ระบบป้องกันหน้าจอดับ (Screen Wake Lock) ---
let wakeLock = null;

async function requestWakeLock() {
    try {
        if ('wakeLock' in navigator) {
            wakeLock = await navigator.wakeLock.request('screen');
            console.log('ป้องกันหน้าจอดับ: ทำงานแล้ว (Wake Lock Active)');
            
            // ดักจับกรณีที่ระบบ OS แย่งคืนสิทธิ์ไป
            wakeLock.addEventListener('release', () => {
                console.log('ป้องกันหน้าจอดับ: ถูกยกเลิก');
            });
        } else {
            console.warn('เบราว์เซอร์นี้ไม่รองรับ Screen Wake Lock API');
        }
    } catch (err) {
        console.error('ไม่สามารถเปิดใช้งาน Wake Lock ได้:', err.name, err.message);
    }
}

function releaseWakeLock() {
    if (wakeLock !== null) {
        wakeLock.release()
            .then(() => {
                wakeLock = null;
            });
    }
}

// ⚠️ สำคัญ: เบราว์เซอร์มักจะปลด Wake Lock อัตโนมัติเวลาเราสลับแอป 
// เราต้องสั่งให้มันขอสิทธิ์ใหม่ทุกครั้งที่ผู้ใช้สลับแอปกลับมาที่ ClearWay
document.addEventListener('visibilitychange', async () => {
    if (wakeLock !== null && document.visibilityState === 'visible') {
        // ถ้าระบบเคยล็อกไว้ แล้วผู้ใช้สลับแอปกลับมา ให้ทำการล็อกใหม่
        await requestWakeLock();
    }
});


// หมายเหตุ: ไม่ต้องใช้ const ประกาศ thresholdSlider และ holdTimeSlider แล้ว 
// เพราะเราสามารถดึงมาจากที่ vad.js ประกาศไว้ใน Global Scope ได้เลย

const thresholdVal = document.getElementById('thresholdVal');
const thresholdMarker = document.getElementById('thresholdMarker');
const holdTimeVal = document.getElementById('holdTimeVal');

// 1. ซิงก์ค่า ความไวไมค์ (Threshold) ไปยัง UI หน้าจอ
thresholdSlider.addEventListener('input', (e) => {
    const value = e.target.value;
    // อัปเดตตัวเลข %
    thresholdVal.innerText = `${value}%`;
    // ขยับเส้น Marker ขาวทับบนหลอดเสียง
    thresholdMarker.style.left = `${value}%`;
});

// 2. ซิงก์ค่า หน่วงเวลาปิดไมค์ (Hold Time) ไปยัง UI หน้าจอ
holdTimeSlider.addEventListener('input', (e) => {
    const value = e.target.value;
    // แปลงมิลลิวินาทีเป็นวินาที (เช่น 1500 -> 1.5s)
    holdTimeVal.innerText = `${(value / 1000).toFixed(1)}s`;
});

// ... (โค้ดดึง Slider เดิมปล่อยไว้เหมือนเดิม) ...

const startRideBtn = document.getElementById('startRideBtn');
const roomInput = document.getElementById('roomInput');
const nicknameInput = document.getElementById('nicknameInput'); // ดึงช่องชื่อเล่น
const startBtnText = document.getElementById('startBtnText');

const roomControlPanel = document.getElementById('roomControlPanel');
const membersPanel = document.getElementById('membersPanel');

let isRiding = false;

startRideBtn.addEventListener('click', async () => {
    const roomId = roomInput.value.trim();
    const nickname = nicknameInput.value.trim();
    
    if (!roomId || !nickname) {
        alert("กรุณาใส่รหัสทริป และ ชื่อเล่น ให้ครบถ้วนครับ!");
        return;
    }

    if (!isRiding) {
        isRiding = true;
        startRideBtn.classList.add('stop');
        startBtnText.innerText = "ออกจากห้อง";
        startRideBtn.querySelector('.btn-icon').innerText = "🛑";
        document.getElementById('testMicBtn').disabled = true;

        roomControlPanel.style.display = 'none';
        membersPanel.style.display = 'block';

        const activeStream = await startMainMic(); 
        
        if (activeStream) {
            // ให้ webRTC.js จัดการ connectionStatus เอง ไม่ทับที่นี่
            window.ClearWayWebRTC.joinVoiceRoom(roomId, nickname, activeStream);
            await requestWakeLock();
        } else {
            // mic ไม่ได้ → rollback UI
            isRiding = false;
            startRideBtn.classList.remove('stop');
            startBtnText.innerText = "เริ่มสนทนา";
            startRideBtn.querySelector('.btn-icon').innerText = "🏍️";
            document.getElementById('testMicBtn').disabled = false;
            roomControlPanel.style.display = 'block';
            membersPanel.style.display = 'none';
        }

    } else {
        isRiding = false;
        startRideBtn.classList.remove('stop');
        startBtnText.innerText = "เริ่มสนทนา";
        startRideBtn.querySelector('.btn-icon').innerText = "🏍️";
        document.getElementById('testMicBtn').disabled = false;
        
        roomControlPanel.style.display = 'block';
        membersPanel.style.display = 'none';

        stopMainMic();
        if (window.ClearWayWebRTC.leaveVoiceRoom) window.ClearWayWebRTC.leaveVoiceRoom();
        releaseWakeLock();
        // รอให้ peer destroy เสร็จก่อนค่อย reset status
        setTimeout(() => {
            document.getElementById('connectionStatusBadge').className = 'status-badge disconnected';
            document.getElementById('connectionStatusText').innerText = "🔴 สิ้นสุดทริป";
        }, 200);
    }
});

// ฟังก์ชันสำหรับวาด UI รายชื่อคนในห้อง (webRTC.js จะเป็นคนเรียกใช้ฟังก์ชันนี้)
window.ClearWayUI = {
    renderMembers: function(roomState, myPeerId) {
        const list = document.getElementById('memberList');
        list.innerHTML = '';

        Object.keys(roomState).forEach(peerId => {
            const user = roomState[peerId];
            const isMe = peerId === myPeerId;
            
            // จัดเตรียมข้อความและคลาส
            const displayName = user.nickname + (isMe ? ' (คุณ)' : '');
            const roleText = user.role === 'Host' ? '👑 Host' : '👤 Member';
            const activeClass = user.isTalking ? 'active' : '';
            const nameColor = isMe ? 'color: var(--primary-color);' : '';

            // สร้างแท็ก <li> ทีละคน
            const li = document.createElement('li');
            li.className = 'member-item';
            li.innerHTML = `
                <div class="member-info">
                    <div class="mic-indicator ${activeClass}"></div>
                    <span class="member-name" style="${nameColor}">${displayName}</span>
                </div>
                <span class="member-role">${roleText}</span>
            `;
            list.appendChild(li);
        });
    }
};

const vadToggle = document.getElementById('vadToggle');
const vadContent = document.getElementById('vadContent');
const vadIcon = document.getElementById('vadIcon');

vadToggle.addEventListener('click', () => {
    // สลับคลาสเพื่อพับหรือกางออก
    vadContent.classList.toggle('collapsed');
    // หมุนไอคอนลูกศร
    vadIcon.classList.toggle('rotate');
});
