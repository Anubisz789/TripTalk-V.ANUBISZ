// asset/js/app.js

// ─────────────────────────────────────────────
// SERVICE WORKER (PWA) — [Architect Fix] Relative Path
// ─────────────────────────────────────────────
if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
        // ใช้ relative path เพื่อรองรับการ deploy ใน sub-directory
        navigator.serviceWorker.register('./sw.js')
            .then(r => console.log('SW registered:', r.scope))
            .catch(e => console.error('SW registration failed:', e));
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
// PRESET SYSTEM
// ─────────────────────────────────────────────

const PRESET_DEFINITIONS = {
    city: {
        label:           '🏙️ ในเมือง',
        threshold:       35,
        holdMs:          800,
        highpassHz:      80,
        gain:            1.2,
    },
    touring: {
        label:           '🛣️ ทริประยะไกล',
        threshold:       50,
        holdMs:          1200,
        highpassHz:      100,
        gain:            1.4,
    },
    racing: {
        label:           '🏎️ ความเร็วสูง',
        threshold:       65,
        holdMs:          1500,
        highpassHz:      150,
        gain:            1.6,
    },
};

const STORAGE_KEY_PRESETS = 'triptalk_custom_presets';
const STORAGE_KEY_LAST    = 'triptalk_last_preset';

function loadCustomPresets() {
    try {
        const raw = localStorage.getItem(STORAGE_KEY_PRESETS);
        return raw ? JSON.parse(raw) : {};
    } catch(e) { return {}; }
}

function saveCustomPresets(customs) {
    try { localStorage.setItem(STORAGE_KEY_PRESETS, JSON.stringify(customs)); } catch(e) {}
}

function getAllPresets() {
    return { ...PRESET_DEFINITIONS, ...loadCustomPresets() };
}

function applyPreset(presetKey) {
    const all = getAllPresets();
    const preset = all[presetKey];
    if (!preset) return;

    // Update Sliders
    const thresholdSlider = document.getElementById('thresholdSlider');
    const holdTimeSlider = document.getElementById('holdTimeSlider');
    const highpassSlider = document.getElementById('highpassSlider');
    const gainSlider = document.getElementById('gainSlider');

    if (thresholdSlider) {
        thresholdSlider.value = preset.threshold;
        document.getElementById('thresholdVal').innerText = `${preset.threshold}%`;
        document.getElementById('thresholdMarker').style.left = `${preset.threshold}%`;
    }
    if (holdTimeSlider) {
        holdTimeSlider.value = preset.holdMs;
        document.getElementById('holdTimeVal').innerText = `${(preset.holdMs / 1000).toFixed(1)}s`;
    }
    if (highpassSlider) {
        highpassSlider.value = preset.highpassHz;
        document.getElementById('highpassVal').innerText = `${preset.highpassHz} Hz`;
    }
    if (gainSlider) {
        gainSlider.value = Math.round(preset.gain * 10);
        document.getElementById('gainVal').innerText = `${preset.gain.toFixed(1)}x`;
    }

    // Apply to Audio Pipeline
    if (typeof window.applyPresetToAudio === 'function') {
        window.applyPresetToAudio(preset.highpassHz, preset.gain);
    }

    try { localStorage.setItem(STORAGE_KEY_LAST, presetKey); } catch(e) {}
    console.log(`[Preset] Applied: ${presetKey}`);
}

function populatePresetSelector() {
    const sel = document.getElementById('presetSelector');
    if (!sel) return;
    const currentVal = sel.value;
    sel.innerHTML = '';

    const builtinGroup = document.createElement('optgroup');
    builtinGroup.label = 'Built-in';
    Object.entries(PRESET_DEFINITIONS).forEach(([key, p]) => {
        const opt = document.createElement('option');
        opt.value = key;
        opt.innerText = p.label;
        builtinGroup.appendChild(opt);
    });
    sel.appendChild(builtinGroup);

    const customs = loadCustomPresets();
    if (Object.keys(customs).length > 0) {
        const customGroup = document.createElement('optgroup');
        customGroup.label = 'Custom';
        Object.entries(customs).forEach(([key, p]) => {
            const opt = document.createElement('option');
            opt.value = key;
            opt.innerText = p.label || key;
            customGroup.appendChild(opt);
        });
        sel.appendChild(customGroup);
    }

    if (currentVal && sel.querySelector(`option[value="${currentVal}"]`)) {
        sel.value = currentVal;
    }
}

function initPresetSystem() {
    populatePresetSelector();
    const sel = document.getElementById('presetSelector');
    const saveBtn = document.getElementById('savePresetBtn');
    const deleteBtn = document.getElementById('deletePresetBtn');
    const customNameInput = document.getElementById('customPresetName');

    if (sel) {
        sel.addEventListener('change', () => applyPreset(sel.value));
    }

    if (saveBtn) {
        saveBtn.addEventListener('click', () => {
            const name = customNameInput?.value.trim();
            if (!name) { alert('กรุณาใส่ชื่อ preset'); return; }
            if (PRESET_DEFINITIONS[name]) { alert('ไม่สามารถทับชื่อ built-in ได้'); return; }

            const customs = loadCustomPresets();
            customs[name] = {
                label: `⭐ ${name}`,
                threshold: parseInt(document.getElementById('thresholdSlider').value, 10),
                holdMs: parseInt(document.getElementById('holdTimeSlider').value, 10),
                highpassHz: parseInt(document.getElementById('highpassSlider').value, 10),
                gain: parseInt(document.getElementById('gainSlider').value, 10) / 10,
            };
            saveCustomPresets(customs);
            populatePresetSelector();
            sel.value = name;
            customNameInput.value = '';
        });
    }

    if (deleteBtn) {
        deleteBtn.addEventListener('click', () => {
            const key = sel.value;
            if (PRESET_DEFINITIONS[key]) { alert('ไม่สามารถลบ built-in ได้'); return; }
            if (!confirm(`ลบ preset "${key}"?`)) return;
            const customs = loadCustomPresets();
            delete customs[key];
            saveCustomPresets(customs);
            populatePresetSelector();
            sel.value = 'touring';
            applyPreset('touring');
        });
    }

    // Auto-load last preset
    const lastKey = localStorage.getItem(STORAGE_KEY_LAST) || 'touring';
    applyPreset(lastKey);
    if (sel) sel.value = lastKey;
}

// ─────────────────────────────────────────────
// SLIDER EVENTS
// ─────────────────────────────────────────────

function initSliders() {
    const thresholdSlider = document.getElementById('thresholdSlider');
    const holdTimeSlider = document.getElementById('holdTimeSlider');
    const highpassSlider = document.getElementById('highpassSlider');
    const gainSlider = document.getElementById('gainSlider');

    thresholdSlider?.addEventListener('input', (e) => {
        const val = e.target.value;
        document.getElementById('thresholdVal').innerText = `${val}%`;
        document.getElementById('thresholdMarker').style.left = `${val}%`;
    });

    holdTimeSlider?.addEventListener('input', (e) => {
        const val = e.target.value;
        document.getElementById('holdTimeVal').innerText = `${(val / 1000).toFixed(1)}s`;
    });

    highpassSlider?.addEventListener('input', (e) => {
        const hz = parseInt(e.target.value, 10);
        document.getElementById('highpassVal').innerText = `${hz} Hz`;
        if (typeof window.applyPresetToAudio === 'function') {
            window.applyPresetToAudio(hz, parseInt(gainSlider.value, 10) / 10);
        }
    });

    gainSlider?.addEventListener('input', (e) => {
        const gain = parseInt(e.target.value, 10) / 10;
        document.getElementById('gainVal').innerText = `${gain.toFixed(1)}x`;
        if (typeof window.applyPresetToAudio === 'function') {
            window.applyPresetToAudio(parseInt(highpassSlider.value, 10), gain);
        }
    });
}

// ─────────────────────────────────────────────
// CALL CONTROL
// ─────────────────────────────────────────────

let isRiding = false;

async function toggleRide() {
    const startRideBtn = document.getElementById('startRideBtn');
    const startBtnText = document.getElementById('startBtnText');
    const roomId = document.getElementById('roomInput').value.trim();
    const nickname = document.getElementById('nicknameInput').value.trim();

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
        document.getElementById('roomControlPanel').style.display = 'none';
        document.getElementById('membersPanel').style.display = 'block';

        const activeStream = await window.startMainMic();
        if (activeStream) {
            window.ClearWayWebRTC.joinVoiceRoom(roomId, nickname, activeStream);
            await requestWakeLock();
        } else {
            // Rollback UI if mic fails
            isRiding = false;
            startRideBtn.classList.remove('stop');
            startBtnText.innerText = 'เริ่มสนทนา';
            startRideBtn.querySelector('.btn-icon').innerText = '🏍️';
            document.getElementById('testMicBtn').disabled = false;
            document.getElementById('roomControlPanel').style.display = 'block';
            document.getElementById('membersPanel').style.display = 'none';
        }
    } else {
        isRiding = false;
        startRideBtn.classList.remove('stop');
        startBtnText.innerText = 'เริ่มสนทนา';
        startRideBtn.querySelector('.btn-icon').innerText = '🏍️';
        document.getElementById('testMicBtn').disabled = false;
        document.getElementById('roomControlPanel').style.display = 'block';
        document.getElementById('membersPanel').style.display = 'none';

        window.stopMainMic();
        if (window.ClearWayWebRTC.leaveVoiceRoom) window.ClearWayWebRTC.leaveVoiceRoom();
        releaseWakeLock();
    }
}

// ─────────────────────────────────────────────
// UI RENDERER
// ─────────────────────────────────────────────

window.ClearWayUI = {
    renderMembers(roomState, myPeerId) {
        const list = document.getElementById('memberList');
        if (!list) return;
        list.innerHTML = '';

        Object.keys(roomState).forEach(peerId => {
            const user = roomState[peerId];
            const isMe = peerId === myPeerId;
            const li = document.createElement('li');
            li.className = 'member-item';
            li.innerHTML = `
                <div class="member-info">
                    <div class="mic-indicator ${user.isTalking ? 'active' : ''}"></div>
                    <span class="member-name" style="${isMe ? 'color: var(--primary-color);' : ''}">${user.nickname}${isMe ? ' (คุณ)' : ''}</span>
                </div>
                <span class="member-role">${user.role === 'Host' ? '👑 Host' : '👤 Member'}</span>
            `;
            list.appendChild(li);
        });
    }
};

// ─────────────────────────────────────────────
// INITIALIZATION
// ─────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', () => {
    initSliders();
    initPresetSystem();
    
    document.getElementById('startRideBtn').addEventListener('click', toggleRide);
    
    document.getElementById('vadToggle').addEventListener('click', () => {
        document.getElementById('vadContent').classList.toggle('collapsed');
        document.getElementById('vadIcon').classList.toggle('rotate');
    });
});
