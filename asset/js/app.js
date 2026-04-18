// ─────────────────────────────────────────────
// PWA — Service Worker (v4.7.1)
// ─────────────────────────────────────────────
if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
        navigator.serviceWorker.register('./sw.js?v=4.7.1').then(reg => {
            reg.onupdatefound = () => {
                const installingWorker = reg.installing;
                installingWorker.onstatechange = () => {
                    if (installingWorker.state === 'installed' && navigator.serviceWorker.controller) {
                        console.log('New content is available; please refresh.');
                        // [v4.7.1] Auto-reload when updated
                        window.location.reload();
                    }
                };
            };
        });
    });
}

// ─────────────────────────────────────────────
// UI CONTROLS & WAKE LOCK
// ─────────────────────────────────────────────
let wakeLock = null;
async function requestWakeLock() {
    try {
        if ('wakeLock' in navigator) {
            wakeLock = await navigator.wakeLock.request('screen');
        }
    } catch (err) { console.error(`${err.name}, ${err.message}`); }
}
function releaseWakeLock() {
    if (wakeLock) { wakeLock.release(); wakeLock = null; }
}

// ─────────────────────────────────────────────
// PRESETS & SETTINGS
// ─────────────────────────────────────────────
const PRESETS = {
    city: { name: '🏙️ ในเมือง', hp: 100, gain: 1.4, threshold: 50, hold: 1200 },
    road: { name: '🛣️ ทริประยะไกล', hp: 250, gain: 1.8, threshold: 40, hold: 1500 },
    speed: { name: '🏎️ ความเร็วสูง', hp: 450, gain: 2.2, threshold: 35, hold: 2000 }
};

let customPresets = JSON.parse(localStorage.getItem('triptalk_presets') || '{}');
const presetSelector = document.getElementById('presetSelector');
const thresholdSlider = document.getElementById('thresholdSlider');
const holdTimeSlider = document.getElementById('holdTimeSlider');
const highpassSlider = document.getElementById('highpassSlider');
const gainSlider = document.getElementById('gainSlider');

function loadPresets() {
    presetSelector.innerHTML = '';
    Object.keys(PRESETS).forEach(k => {
        const opt = document.createElement('option');
        opt.value = k; opt.innerText = PRESETS[k].name;
        presetSelector.appendChild(opt);
    });
    Object.keys(customPresets).forEach(k => {
        const opt = document.createElement('option');
        opt.value = `custom_${k}`; opt.innerText = `⭐ ${k}`;
        presetSelector.appendChild(opt);
    });
}

presetSelector.addEventListener('change', (e) => {
    const val = e.target.value;
    let p;
    if (val.startsWith('custom_')) p = customPresets[val.replace('custom_', '')];
    else p = PRESETS[val];

    if (p) {
        thresholdSlider.value = p.threshold;
        holdTimeSlider.value = p.hold;
        highpassSlider.value = p.hp;
        gainSlider.value = p.gain;
        // Apply to Audio if running
        if (window.applyPresetToAudio) window.applyPresetToAudio(p.hp, p.gain);
    }
});

// ─────────────────────────────────────────────
// MAIN RIDE TOGGLE
// ─────────────────────────────────────────────
let isRiding = false;
const startRideBtn = document.getElementById('startRideBtn');
const startBtnText = document.getElementById('startBtnText');
const nicknameInput = document.getElementById('nicknameInput');
const roomInput = document.getElementById('roomInput');

startRideBtn.addEventListener('click', toggleRide);

async function toggleRide() {
    if (!isRiding) {
        const nick = nicknameInput.value.trim();
        const room = roomInput.value.trim();
        if (!nick || !room) return alert('กรุณาใส่ชื่อและรหัสทริป');

        isRiding = true;
        startRideBtn.classList.add('stop');
        if (startBtnText) startBtnText.innerText = 'จบการสนทนา';
        const icon = startRideBtn.querySelector('.btn-icon');
        if (icon) icon.innerText = '🛑';
        
        const testMicBtn = document.getElementById('testMicBtn');
        if (testMicBtn) testMicBtn.disabled = true;
        
        const roomControlPanel = document.getElementById('roomControlPanel');
        if (roomControlPanel) roomControlPanel.style.display = 'none';
        
        const membersPanel = document.getElementById('membersPanel');
        if (membersPanel) membersPanel.style.display = 'block';

        // [v4.7.0] Show SOS & Map
        const sosContainer = document.getElementById('sosContainer');
        const mapDiv = document.getElementById('map');
        const netPanel = document.getElementById('networkStatusPanel');
        
        if (sosContainer) sosContainer.style.display = 'flex';
        if (mapDiv) mapDiv.style.display = 'block';
        if (netPanel) netPanel.style.display = 'flex';

        try {
            // [v4.6] Silent Audio Unlock for Mobile
            const unlockCtx = new (window.AudioContext || window.webkitAudioContext)();
            unlockCtx.resume();

            const stream = await window.startMainMic();
            window.ClearWayWebRTC.joinVoiceRoom(room, nick, stream);
            requestWakeLock();
            initMap();
        } catch (err) {
            console.error(err);
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
        const mapDiv = document.getElementById('map');
        const netPanel = document.getElementById('networkStatusPanel');
        
        if (sosContainer) sosContainer.style.display = 'none';
        if (mapDiv) mapDiv.style.display = 'none';
        if (netPanel) netPanel.style.display = 'none';

        window.stopMainMic();
        if (window.ClearWayWebRTC.leaveVoiceRoom) window.ClearWayWebRTC.leaveVoiceRoom();
        releaseWakeLock();
    }
}

// ─────────────────────────────────────────────
// UI RENDERER (MAP & MEMBERS)
// ─────────────────────────────────────────────
let map = null;
let markers = {};

function initMap() {
    if (map) return;
    const mapDiv = document.getElementById('map');
    if (!mapDiv) return;
    
    map = L.map('map').setView([13.7367, 100.5231], 13);
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
        attribution: '© OpenStreetMap'
    }).addTo(map);
    
    // Fix Leaflet gray box issue
    setTimeout(() => map.invalidateSize(), 500);
}

function updateMap(roomState) {
    if (!map) return;
    Object.keys(roomState).forEach(id => {
        const user = roomState[id];
        if (user.location && user.location.lat !== 0) {
            if (!markers[id]) {
                markers[id] = L.marker([user.location.lat, user.location.lng]).addTo(map);
                markers[id].bindPopup(user.nickname);
            } else {
                markers[id].setLatLng([user.location.lat, user.location.lng]);
            }
        }
    });
}

window.ClearWayUI = {
    renderMembers: (roomState, myPeerId) => {
        const list = document.getElementById('memberList');
        if (!list) return;
        list.innerHTML = '';
        
        Object.keys(roomState).forEach(id => {
            const user = roomState[id];
            const li = document.createElement('li');
            li.className = `member-item ${user.isTalking ? 'talking' : ''} ${user.sos ? 'sos-alert' : ''}`;
            li.innerHTML = `
                <span class="mic-icon">${user.isTalking ? '🔊' : '🔇'}</span>
                <span class="member-name">${user.nickname} ${id === myPeerId ? '(คุณ)' : ''}</span>
                ${user.sos ? '<span class="sos-tag">🆘 SOS</span>' : ''}
            `;
            list.appendChild(li);
        });
        
        updateMap(roomState);
    }
};

// SOS Button Logic
const sosBtn = document.getElementById('sosBtnMain');
let isSOSActive = false;
if (sosBtn) {
    sosBtn.addEventListener('click', () => {
        isSOSActive = !isSOSActive;
        sosBtn.classList.toggle('active', isSOSActive);
        window.ClearWayWebRTC.sendSOS(isSOSActive);
    });
}

// VAD Toggle Logic
const vadToggle = document.getElementById('vadToggle');
const vadContent = document.getElementById('vadContent');
if (vadToggle && vadContent) {
    vadToggle.addEventListener('click', () => {
        vadContent.classList.toggle('collapsed');
        document.getElementById('vadIcon').innerText = vadContent.classList.contains('collapsed') ? '▶' : '▼';
    });
}

loadPresets();
