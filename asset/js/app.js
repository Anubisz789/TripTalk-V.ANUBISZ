// asset/js/app.js

// ─────────────────────────────────────────────
// SERVICE WORKER (PWA)
// ─────────────────────────────────────────────
if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
        navigator.serviceWorker.register('/sw.js')
            .then(r => console.log('SW registered:', r.scope))
            .catch(e => console.log('SW failed:', e));
    });
}

// ─────────────────────────────────────────────
// SCREEN WAKE LOCK
// ─────────────────────────────────────────────
let wakeLock = null;

async function requestWakeLock() {
    try {
        if ('wakeLock' in navigator) {
            wakeLock = await navigator.wakeLock.request('screen');
            wakeLock.addEventListener('release', () => { console.log('Wake Lock released'); });
        }
    } catch (err) {
        console.error('Wake Lock failed:', err.name, err.message);
    }
}

function releaseWakeLock() {
    if (wakeLock !== null) {
        wakeLock.release().then(() => { wakeLock = null; });
    }
}

document.addEventListener('visibilitychange', async () => {
    if (wakeLock !== null && document.visibilityState === 'visible') {
        await requestWakeLock();
    }
});

// ─────────────────────────────────────────────
// [ADDED] PRESET SYSTEM
// ─────────────────────────────────────────────

// Built-in presets — ค่าที่เหมาะกับแต่ละสภาพแวดล้อม
const PRESET_DEFINITIONS = {
    city: {
        label:           '🏙️ ในเมือง',
        threshold:       35,      // % sensitivity (ค่าต่ำ = ไวมาก)
        holdMs:          800,     // ms hold time
        highpassHz:      80,      // Hz wind filter (ต่ำ = กรองน้อย)
        gain:            1.2,     // voice boost
        bitrateSpeaking: 24000,   // bps ตอนพูด
        bitrateSilent:   8000,    // bps ตอนเงียบ
    },
    touring: {
        label:           '🛣️ ทริประยะไกล',
        threshold:       50,
        holdMs:          1200,
        highpassHz:      100,
        gain:            1.4,
        bitrateSpeaking: 28000,
        bitrateSilent:   8000,
    },
    racing: {
        label:           '🏎️ ความเร็วสูง',
        threshold:       65,
        holdMs:          1500,
        highpassHz:      150,
        gain:            1.6,
        bitrateSpeaking: 32000,
        bitrateSilent:   8000,
    },
};

const STORAGE_KEY_PRESETS = 'triptalk_custom_presets';
const STORAGE_KEY_LAST    = 'triptalk_last_preset';

// [ADDED] โหลด custom presets จาก localStorage
function loadCustomPresets() {
    try {
        const raw = localStorage.getItem(STORAGE_KEY_PRESETS);
        return raw ? JSON.parse(raw) : {};
    } catch(e) {
        return {};
    }
}

// [ADDED] บันทึก custom presets ลง localStorage
function saveCustomPresets(customs) {
    try {
        localStorage.setItem(STORAGE_KEY_PRESETS, JSON.stringify(customs));
    } catch(e) {
        console.warn('localStorage unavailable');
    }
}

// [ADDED] รวม built-in + custom presets ทั้งหมด
function getAllPresets() {
    return { ...PRESET_DEFINITIONS, ...loadCustomPresets() };
}

// [ADDED] สร้าง custom preset จากค่า slider ปัจจุบัน
function createCustomPresetFromCurrent(name) {
    // อ่านค่าจาก slider ปัจจุบัน
    const highpassSlider = document.getElementById('highpassSlider');
    const gainSlider     = document.getElementById('gainSlider');

    return {
        label:           `⭐ ${name}`,
        threshold:       parseInt(thresholdSlider.value, 10),
        holdMs:          parseInt(holdTimeSlider.value, 10),
        highpassHz:      highpassSlider ? parseInt(highpassSlider.value, 10) : VAD_CONFIG.HIGHPASS_FREQ,
        gain:            gainSlider ? parseInt(gainSlider.value, 10) / 10 : VAD_CONFIG.GAIN_VALUE,
        bitrateSpeaking: RTC_CONFIG.BITRATE_SPEAKING,
        bitrateSilent:   RTC_CONFIG.BITRATE_SILENT,
    };
}

// [ADDED] apply preset ทันที — อัปเดต slider + audio + bitrate
function applyPreset(presetKey) {
    const all    = getAllPresets();
    const preset = all[presetKey];
    if (!preset) return;

    // 1. อัปเดต threshold slider
    thresholdSlider.value = preset.threshold;
    thresholdVal.innerText = `${preset.threshold}%`;
    thresholdMarker.style.left = `${preset.threshold}%`;

    // 2. อัปเดต hold time slider
    holdTimeSlider.value = preset.holdMs;
    holdTimeVal.innerText = `${(preset.holdMs / 1000).toFixed(1)}s`;

    // 3. อัปเดต highpass slider (ถ้ามี)
    const highpassSlider = document.getElementById('highpassSlider');
    const highpassVal    = document.getElementById('highpassVal');
    if (highpassSlider) {
        highpassSlider.value = preset.highpassHz;
        if (highpassVal) highpassVal.innerText = `${preset.highpassHz} Hz`;
    }

    // 4. อัปเดต gain slider (ถ้ามี)
    const gainSlider = document.getElementById('gainSlider');
    const gainVal    = document.getElementById('gainVal');
    if (gainSlider) {
        gainSlider.value = Math.round(preset.gain * 10);
        if (gainVal) gainVal.innerText = `${preset.gain.toFixed(1)}x`;
    }

    // 5. apply ไป audio pipeline (live หรือตอน startMainMic ครั้งถัดไป)
    if (typeof applyPresetToAudio === 'function') {
        applyPresetToAudio(preset.highpassHz, preset.gain);
    }

    // 6. อัปเดต bitrate config (RTC_CONFIG เป็น object ใน webRTC.js — mutable)
    if (typeof RTC_CONFIG !== 'undefined') {
        RTC_CONFIG.BITRATE_SPEAKING = preset.bitrateSpeaking;
        RTC_CONFIG.BITRATE_SILENT   = preset.bitrateSilent;
    }

    // 7. บันทึก last preset ลง localStorage
    try { localStorage.setItem(STORAGE_KEY_LAST, presetKey); } catch(e) {}

    console.log(`[Preset] Applied: ${presetKey}`);
}

// [ADDED] populate dropdown ด้วย built-in + custom presets
function populatePresetSelector() {
    const sel = document.getElementById('presetSelector');
    if (!sel) return;

    const currentVal = sel.value;
    sel.innerHTML = '';

    // Built-in group
    const builtinGroup = document.createElement('optgroup');
    builtinGroup.label = 'Built-in';
    Object.entries(PRESET_DEFINITIONS).forEach(([key, p]) => {
        const opt   = document.createElement('option');
        opt.value   = key;
        opt.innerText = p.label;
        builtinGroup.appendChild(opt);
    });
    sel.appendChild(builtinGroup);

    // Custom group
    const customs = loadCustomPresets();
    if (Object.keys(customs).length > 0) {
        const customGroup = document.createElement('optgroup');
        customGroup.label = 'Custom';
        Object.entries(customs).forEach(([key, p]) => {
            const opt   = document.createElement('option');
            opt.value   = key;
            opt.innerText = p.label || key;
            customGroup.appendChild(opt);
        });
        sel.appendChild(customGroup);
    }

    // คืน selection เดิม (ถ้ายังมีอยู่)
    if (currentVal && sel.querySelector(`option[value="${currentVal}"]`)) {
        sel.value = currentVal;
    }
}

// [ADDED] เริ่มต้น preset system — wire UI และ auto-load last preset
function initPresetSystem() {
    populatePresetSelector();

    const sel            = document.getElementById('presetSelector');
    const applyBtn       = document.getElementById('applyPresetBtn');
    const saveBtn        = document.getElementById('savePresetBtn');
    const deleteBtn      = document.getElementById('deletePresetBtn');
    const customNameInput= document.getElementById('customPresetName');

    // Apply preset เมื่อกดปุ่ม
    if (applyBtn) {
        applyBtn.addEventListener('click', () => {
            if (sel) applyPreset(sel.value);
        });
    }

    // [ADDED] Apply preset เมื่อเปลี่ยน dropdown ทันที
    if (sel) {
        sel.addEventListener('change', () => applyPreset(sel.value));
    }

    // Save custom preset
    if (saveBtn) {
        saveBtn.addEventListener('click', () => {
            const name = customNameInput ? customNameInput.value.trim() : '';
            if (!name) { alert('กรุณาใส่ชื่อ preset'); return; }

            // ไม่ให้ทับ built-in
            if (PRESET_DEFINITIONS[name]) {
                alert(`"${name}" เป็นชื่อ built-in preset — กรุณาใช้ชื่ออื่น`);
                return;
            }

            const customs  = loadCustomPresets();
            customs[name]  = createCustomPresetFromCurrent(name);
            saveCustomPresets(customs);
            populatePresetSelector();
            if (sel) sel.value = name;
            if (customNameInput) customNameInput.value = '';
            try { localStorage.setItem(STORAGE_KEY_LAST, name); } catch(e) {}
            console.log(`[Preset] Saved: ${name}`);
        });
    }

    // Delete custom preset
    if (deleteBtn) {
        deleteBtn.addEventListener('click', () => {
            if (!sel) return;
            const key = sel.value;
            if (PRESET_DEFINITIONS[key]) {
                alert('ไม่สามารถลบ built-in preset ได้');
                return;
            }
            if (!confirm(`ลบ preset "${key}" ใช่ไหม?`)) return;
            const customs = loadCustomPresets();
            delete customs[key];
            saveCustomPresets(customs);
            populatePresetSelector();
            if (sel) sel.value = 'touring'; // fallback
        });
    }

    // [ADDED] Auto-load last preset ตอนเปิดแอป
    try {
        const lastKey = localStorage.getItem(STORAGE_KEY_LAST) || 'touring';
        const all     = getAllPresets();
        if (all[lastKey]) {
            if (sel) sel.value = lastKey;
            applyPreset(lastKey);
            console.log(`[Preset] Auto-loaded: ${lastKey}`);
        } else {
            if (sel) sel.value = 'touring';
            applyPreset('touring');
        }
    } catch(e) {
        applyPreset('touring');
    }
}

// ─────────────────────────────────────────────
// SLIDER SYNC — ตัว slider ที่มีอยู่เดิม
// ─────────────────────────────────────────────

// thresholdSlider และ holdTimeSlider ถูก declare เป็น global ใน vad.js อยู่แล้ว
const thresholdVal    = document.getElementById('thresholdVal');
const thresholdMarker = document.getElementById('thresholdMarker');
const holdTimeVal     = document.getElementById('holdTimeVal');

thresholdSlider.addEventListener('input', (e) => {
    const value = e.target.value;
    thresholdVal.innerText     = `${value}%`;
    thresholdMarker.style.left = `${value}%`;
});

holdTimeSlider.addEventListener('input', (e) => {
    const value = e.target.value;
    holdTimeVal.innerText = `${(value / 1000).toFixed(1)}s`;
});

// [ADDED] highpassSlider event listener
const highpassSliderEl = document.getElementById('highpassSlider');
const highpassValEl    = document.getElementById('highpassVal');
if (highpassSliderEl) {
    highpassSliderEl.addEventListener('input', (e) => {
        const hz = parseInt(e.target.value, 10);
        if (highpassValEl) highpassValEl.innerText = `${hz} Hz`;
        // apply ทันที — ไม่ต้องรอกด Apply
        if (typeof applyPresetToAudio === 'function') {
            applyPresetToAudio(hz, VAD_CONFIG.GAIN_VALUE);
        }
    });
}

// [ADDED] gainSlider event listener
const gainSliderEl = document.getElementById('gainSlider');
const gainValEl    = document.getElementById('gainVal');
if (gainSliderEl) {
    gainSliderEl.addEventListener('input', (e) => {
        const gain = parseInt(e.target.value, 10) / 10;
        if (gainValEl) gainValEl.innerText = `${gain.toFixed(1)}x`;
        // apply ทันที
        if (typeof applyPresetToAudio === 'function') {
            applyPresetToAudio(VAD_CONFIG.HIGHPASS_FREQ, gain);
        }
    });
}

// ─────────────────────────────────────────────
// START/STOP RIDE
// ─────────────────────────────────────────────
const startRideBtn     = document.getElementById('startRideBtn');
const roomInput        = document.getElementById('roomInput');
const nicknameInput    = document.getElementById('nicknameInput');
const startBtnText     = document.getElementById('startBtnText');
const roomControlPanel = document.getElementById('roomControlPanel');
const membersPanel     = document.getElementById('membersPanel');

let isRiding = false;

startRideBtn.addEventListener('click', async () => {
    const roomId   = roomInput.value.trim();
    const nickname = nicknameInput.value.trim();

    if (!roomId || !nickname) {
        alert('กรุณาใส่รหัสทริป และ ชื่อเล่น ให้ครบถ้วนครับ!');
        return;
    }

    if (!isRiding) {
        isRiding = true;
        startRideBtn.classList.add('stop');
        startBtnText.innerText = 'ออกจากห้อง';
        startRideBtn.querySelector('.btn-icon').innerText = '🛑';
        document.getElementById('testMicBtn').disabled = true;

        roomControlPanel.style.display = 'none';
        membersPanel.style.display     = 'block';

        const activeStream = await startMainMic();

        if (activeStream) {
            window.ClearWayWebRTC.joinVoiceRoom(roomId, nickname, activeStream);
            await requestWakeLock();
        } else {
            // rollback UI
            isRiding = false;
            startRideBtn.classList.remove('stop');
            startBtnText.innerText = 'เริ่มสนทนา';
            startRideBtn.querySelector('.btn-icon').innerText = '🏍️';
            document.getElementById('testMicBtn').disabled = false;
            roomControlPanel.style.display = 'block';
            membersPanel.style.display     = 'none';
        }

    } else {
        isRiding = false;
        startRideBtn.classList.remove('stop');
        startBtnText.innerText = 'เริ่มสนทนา';
        startRideBtn.querySelector('.btn-icon').innerText = '🏍️';
        document.getElementById('testMicBtn').disabled = false;

        roomControlPanel.style.display = 'block';
        membersPanel.style.display     = 'none';

        stopMainMic();
        if (window.ClearWayWebRTC.leaveVoiceRoom) window.ClearWayWebRTC.leaveVoiceRoom();
        releaseWakeLock();

        setTimeout(() => {
            document.getElementById('connectionStatusBadge').className = 'status-badge disconnected';
            document.getElementById('connectionStatusText').innerText  = '🔴 สิ้นสุดทริป';
        }, 200);
    }
});

// ─────────────────────────────────────────────
// RENDER MEMBERS
// ─────────────────────────────────────────────
window.ClearWayUI = {
    renderMembers(roomState, myPeerId) {
        const list = document.getElementById('memberList');
        if (!list) return;
        list.innerHTML = '';

        Object.keys(roomState).forEach(peerId => {
            const user        = roomState[peerId];
            const isMe        = peerId === myPeerId;
            const displayName = user.nickname + (isMe ? ' (คุณ)' : '');
            const roleText    = user.role === 'Host' ? '👑 Host' : '👤 Member';
            const activeClass = user.isTalking ? 'active' : '';
            const nameColor   = isMe ? 'color: var(--primary-color);' : '';

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

// ─────────────────────────────────────────────
// VAD SETTINGS PANEL TOGGLE
// ─────────────────────────────────────────────
const vadToggle = document.getElementById('vadToggle');
const vadContent = document.getElementById('vadContent');
const vadIcon    = document.getElementById('vadIcon');

vadToggle.addEventListener('click', () => {
    vadContent.classList.toggle('collapsed');
    vadIcon.classList.toggle('rotate');
});

// ─────────────────────────────────────────────
// [ADDED] INIT — เรียก preset system หลัง DOM พร้อม
// ─────────────────────────────────────────────
initPresetSystem();
