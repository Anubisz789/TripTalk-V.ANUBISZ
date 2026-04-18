// asset/js/app.js

// ─────────────────────────────────────────────
// SERVICE WORKER (PWA) — [Architect Fix] PWA Install & Update Logic
// ─────────────────────────────────────────────
let deferredPrompt;

if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
        navigator.serviceWorker.register('./sw.js', { scope: './' })
            .then(registration => {
                console.log('SW registered:', registration.scope);
                
                // Check for updates
                registration.onupdatefound = () => {
                    const installingWorker = registration.installing;
                    installingWorker.onstatechange = () => {
                        if (installingWorker.state === 'installed' && navigator.serviceWorker.controller) {
                            console.log('New content is available; please refresh.');
                            // Optional: Show a toast to user to refresh
                        }
                    };
                };
            })
            .catch(e => console.error('SW registration failed:', e));
    });
}

// Handle PWA Install Prompt (Android/Chrome)
window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferredPrompt = e;
    console.log('PWA Install prompt deferred');
    // You could show a custom install button here if needed
});

window.addEventListener('appinstalled', () => {
    deferredPrompt = null;
    console.log('PWA was installed');
});

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
        const display = document.getElementById('thresholdVal');
        if (display) display.innerText = `${preset.threshold}%`;
        const marker = document.getElementById('thresholdMarker');
        if (marker) marker.style.left = `${preset.threshold}%`;
    }
    if (holdTimeSlider) {
        holdTimeSlider.value = preset.holdMs;
        const display = document.getElementById('holdTimeVal');
        if (display) display.innerText = `${(preset.holdMs / 1000).toFixed(1)}s`;
    }
    if (highpassSlider) {
        highpassSlider.value = preset.highpassHz;
        const display = document.getElementById('highpassVal');
        if (display) display.innerText = `${preset.highpassHz} Hz`;
    }
    if (gainSlider) {
        gainSlider.value = Math.round(preset.gain * 10);
        const display = document.getElementById('gainVal');
        if (display) display.innerText = `${preset.gain.toFixed(1)}x`;
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
        const display = document.getElementById('thresholdVal');
        if (display) display.innerText = `${val}%`;
        const marker = document.getElementById('thresholdMarker');
        if (marker) marker.style.left = `${val}%`;
    });

    holdTimeSlider?.addEventListener('input', (e) => {
        const val = e.target.value;
        const display = document.getElementById('holdTimeVal');
        if (display) display.innerText = `${(val / 1000).toFixed(1)}s`;
    });

    highpassSlider?.addEventListener('input', (e) => {
        const hz = parseInt(e.target.value, 10);
        const display = document.getElementById('highpassVal');
        if (display) display.innerText = `${hz} Hz`;
        if (typeof window.applyPresetToAudio === 'function') {
            window.applyPresetToAudio(hz, parseInt(gainSlider.value, 10) / 10);
        }
    });

    gainSlider?.addEventListener('input', (e) => {
        const gain = parseInt(e.target.value, 10) / 10;
        const display = document.getElementById('gainVal');
        if (display) display.innerText = `${gain.toFixed(1)}x`;
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
    const roomIdInput = document.getElementById('roomInput');
    const nicknameInput = document.getElementById('nicknameInput');
    
    const roomId = roomIdInput?.value.trim();
    const nickname = nicknameInput?.value.trim();

    if (!roomId || !nickname) {
        alert('กรุณาใส่รหัสทริป และ ชื่อเล่น ให้ครบถ้วนครับ!');
        return;
    }

    if (!isRiding) {
        isRiding = true;
        startRideBtn.classList.add('stop');
        if (startBtnText) startBtnText.innerText = 'ออกจากห้อง';
        const icon = startRideBtn.querySelector('.btn-icon');
        if (icon) icon.innerText = '🛑';
        
        const testMicBtn = document.getElementById('testMicBtn');
        if (testMicBtn) testMicBtn.disabled = true;
        
        const roomControlPanel = document.getElementById('roomControlPanel');
        if (roomControlPanel) roomControlPanel.style.display = 'none';
        
        const membersPanel = document.getElementById('membersPanel');
        if (membersPanel) membersPanel.style.display = 'block';

        // [v4.7.0] Silent Audio Unlock
        const silentAudio = new (window.AudioContext || window.webkitAudioContext)();
        silentAudio.resume();

        const activeStream = await window.startMainMic();
        if (activeStream) {
            window.ClearWayWebRTC.joinVoiceRoom(roomId, nickname, activeStream);
            
            // [v4.7.0] Show SOS & Map
            const sosContainer = document.getElementById('sosContainer');
            const mapContainer = document.getElementById('map');
            if (sosContainer) sosContainer.style.display = 'flex';
            if (mapContainer) mapContainer.style.display = 'block';
            initMap();
            
            await requestWakeLock();
        } else {
            // Rollback UI if mic fails
            isRiding = false;
            startRideBtn.classList.remove('stop');
            if (startBtnText) startBtnText.innerText = 'เริ่มสนทนา';
            if (icon) icon.innerText = '🏍️';
            if (testMicBtn) testMicBtn.disabled = false;
            if (roomControlPanel) roomControlPanel.style.display = 'block';
            if (membersPanel) membersPanel.style.display = 'none';
        }
    } else {
        isRiding = false;
        startRideBtn.classList.remove('stop');
        if (startBtnText) startBtnText.innerText = 'เริ่มสนทนา';
        const icon = startRideBtn.querySelector('.btn-icon');
        if (icon) icon.innerText = '🏍️';
        
        const testMicBtn = document.getElementById('testMicBtn');
        if (testMicBtn) testMicBtn.disabled = false;
        
        const roomControlPanel = document.getElementById('roomControlPanel');
        if (roomControlPanel) roomControlPanel.style.display = 'block';
        
        const membersPanel = document.getElementById('membersPanel');
        if (membersPanel) membersPanel.style.display = 'none';

        // [v4.7.0] Hide SOS & Map
        const sosContainer = document.getElementById('sosContainer');
        const mapContainer = document.getElementById('map');
        if (sosContainer) sosContainer.style.display = 'none';
        if (mapContainer) mapContainer.style.display = 'none';

        window.stopMainMic();
        if (window.ClearWayWebRTC.leaveVoiceRoom) window.ClearWayWebRTC.leaveVoiceRoom();
        releaseWakeLock();
    }
}

// ─────────────────────────────────────────────
// UI RENDERER
// ─────────────────────────────────────────────

let map = null;
let markers = {};

function initMap() {
    if (map) return;
    const mapContainer = document.getElementById('map');
    if (!mapContainer) return;
    map = L.map('map').setView([13.7367, 100.5231], 13);
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
        attribution: '© OpenStreetMap contributors'
    }).addTo(map);
    setTimeout(() => map.invalidateSize(), 500);
}

function updateMap(roomState) {
    if (!map) return;
    Object.entries(roomState).forEach(([id, data]) => {
        if (data.location && data.location.lat) {
            if (!markers[id]) {
                markers[id] = L.marker([data.location.lat, data.location.lng]).addTo(map);
            } else {
                markers[id].setLatLng([data.location.lat, data.location.lng]);
            }
            markers[id].bindPopup(`${data.nickname}${data.sos ? ' 🚨 SOS!' : ''}`).openPopup();
        }
    });
}

window.ClearWayUI = {
    renderMembers(roomState, myPeerId) {
        const list = document.getElementById('memberList');
        if (!list) return;
        list.innerHTML = '';

        Object.keys(roomState).forEach(peerId => {
            const user = roomState[peerId];
            const isMe = peerId === myPeerId;
            const li = document.createElement('li');
            li.className = `member-item ${user.sos ? 'sos-alert' : ''}`;
            li.innerHTML = `
                <div class="member-info">
                    <div class="mic-indicator ${user.isTalking ? 'active' : ''}"></div>
                    <span class="member-name" style="${isMe ? 'color: var(--primary-color);' : ''}">${user.nickname}${isMe ? ' (คุณ)' : ''}${user.sos ? ' 🚨' : ''}</span>
                </div>
                <span class="member-role">${user.role === 'Host' ? '👑 Host' : '👤 Member'}</span>
            `;
            list.appendChild(li);
        });
        updateMap(roomState);
    }
};

let isSOSActive = false;
const sosBtnMain = document.getElementById('sosBtnMain');
if (sosBtnMain) {
    sosBtnMain.onclick = () => {
        isSOSActive = !isSOSActive;
        sosBtnMain.classList.toggle('active', isSOSActive);
        if (window.ClearWayWebRTC?.sendSOS) window.ClearWayWebRTC.sendSOS(isSOSActive);
    };
}

window.playSOSAlert = () => {
    try {
        const ctx = new (window.AudioContext || window.webkitAudioContext)();
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.type = 'triangle';
        osc.frequency.setValueAtTime(880, ctx.currentTime);
        osc.frequency.exponentialRampToValueAtTime(440, ctx.currentTime + 0.5);
        gain.gain.setValueAtTime(0.5, ctx.currentTime);
        gain.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + 0.5);
        osc.start();
        osc.stop(ctx.currentTime + 0.5);
        osc.onended = () => ctx.close();
    } catch(e) {}
};

// ─────────────────────────────────────────────
// INITIALIZATION
// ─────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', () => {
    initSliders();
    initPresetSystem();
    
    const startRideBtn = document.getElementById('startRideBtn');
    if (startRideBtn) startRideBtn.addEventListener('click', toggleRide);
    
    const vadToggle = document.getElementById('vadToggle');
    if (vadToggle) {
        vadToggle.addEventListener('click', () => {
            const content = document.getElementById('vadContent');
            const icon = document.getElementById('vadIcon');
            if (content) content.classList.toggle('collapsed');
            if (icon) icon.classList.toggle('rotate');
        });
    }
});
