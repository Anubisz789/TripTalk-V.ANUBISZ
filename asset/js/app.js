// asset/js/app.js

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
window.wakeLock = null;
window.requestWakeLock = async function() {
    try {
        if ('wakeLock' in navigator) {
            window.wakeLock = await navigator.wakeLock.request('screen');
        }
    } catch (err) { console.error(`${err.name}, ${err.message}`); }
};
window.releaseWakeLock = function() {
    if (window.wakeLock) { window.wakeLock.release(); window.wakeLock = null; }
};

// ─────────────────────────────────────────────
// PRESETS & SETTINGS
// ─────────────────────────────────────────────
const PRESETS = {
    city: { name: '🏙️ ในเมือง', hp: 100, gain: 1.4, threshold: 50, hold: 1200 },
    road: { name: '🛣️ ทริประยะไกล', hp: 250, gain: 1.8, threshold: 40, hold: 1500 },
    speed: { name: '🏎️ ความเร็วสูง', hp: 450, gain: 2.2, threshold: 35, hold: 2000 }
};

window.customPresets = JSON.parse(localStorage.getItem('triptalk_presets') || '{}');

function loadPresets() {
    const presetSelector = document.getElementById('presetSelector');
    if (!presetSelector) return;
    presetSelector.innerHTML = '';
    Object.keys(PRESETS).forEach(k => {
        const opt = document.createElement('option');
        opt.value = k; opt.innerText = PRESETS[k].name;
        presetSelector.appendChild(opt);
    });
    Object.keys(window.customPresets).forEach(k => {
        const opt = document.createElement('option');
        opt.value = `custom_${k}`; opt.innerText = `⭐ ${k}`;
        presetSelector.appendChild(opt);
    });
}

// ─────────────────────────────────────────────
// MAIN RIDE TOGGLE
// ─────────────────────────────────────────────
window.isRiding = false;

window.toggleRide = async function() {
    const startRideBtn = document.getElementById('startRideBtn');
    const startBtnText = document.getElementById('startBtnText');
    const nicknameInput = document.getElementById('nicknameInput');
    const roomInput = document.getElementById('roomInput');
    
    if (!window.isRiding) {
        const nick = nicknameInput.value.trim();
        const room = roomInput.value.trim();
        if (!nick || !room) return alert('กรุณาใส่ชื่อและรหัสทริป');

        window.isRiding = true;
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

        const sosContainer = document.getElementById('sosContainer');
        const mapDiv = document.getElementById('map');
        const netPanel = document.getElementById('networkStatusPanel');
        
        if (sosContainer) sosContainer.style.display = 'flex';
        if (mapDiv) mapDiv.style.display = 'block';
        if (netPanel) netPanel.style.display = 'flex';

        try {
            const unlockCtx = new (window.AudioContext || window.webkitAudioContext)();
            unlockCtx.resume();

            const stream = await window.startMainMic();
            window.ClearWayWebRTC.joinVoiceRoom(room, nick, stream);
            window.requestWakeLock();
            window.initMap();
        } catch (err) {
            console.error(err);
            window.isRiding = false;
            startRideBtn.classList.remove('stop');
            if (startBtnText) startBtnText.innerText = 'เริ่มสนทนา';
            if (icon) icon.innerText = '🏍️';
            if (testMicBtn) testMicBtn.disabled = false;
            if (roomControlPanel) roomControlPanel.style.display = 'block';
            if (membersPanel) membersPanel.style.display = 'none';
        }
    } else {
        window.isRiding = false;
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

        const sosContainer = document.getElementById('sosContainer');
        const mapDiv = document.getElementById('map');
        const netPanel = document.getElementById('networkStatusPanel');
        
        if (sosContainer) sosContainer.style.display = 'none';
        if (mapDiv) mapDiv.style.display = 'none';
        if (netPanel) netPanel.style.display = 'none';

        window.stopMainMic();
        if (window.ClearWayWebRTC.leaveVoiceRoom) window.ClearWayWebRTC.leaveVoiceRoom();
        window.releaseWakeLock();
    }
};

// ─────────────────────────────────────────────
// UI RENDERER (MAP & MEMBERS)
// ─────────────────────────────────────────────
window.ttMap = null;
window.ttMarkers = {};

window.initMap = function() {
    if (window.ttMap) return;
    const mapDiv = document.getElementById('map');
    if (!mapDiv) return;
    
    window.ttMap = L.map('map').setView([13.7367, 100.5231], 13);
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
        attribution: '© OpenStreetMap'
    }).addTo(window.ttMap);
    
    setTimeout(() => window.ttMap.invalidateSize(), 500);
};

window.updateMap = function(roomState) {
    if (!window.ttMap) return;
    Object.keys(roomState).forEach(id => {
        const user = roomState[id];
        if (user.location && user.location.lat !== 0) {
            if (!window.ttMarkers[id]) {
                window.ttMarkers[id] = L.marker([user.location.lat, user.location.lng]).addTo(window.ttMap);
                window.ttMarkers[id].bindPopup(user.nickname);
            } else {
                window.ttMarkers[id].setLatLng([user.location.lat, user.location.lng]);
            }
        }
    });
};

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
        
        window.updateMap(roomState);
    }
};

// ─────────────────────────────────────────────
// INITIALIZATION
// ─────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
    const startRideBtn = document.getElementById('startRideBtn');
    if (startRideBtn) startRideBtn.addEventListener('click', window.toggleRide);

    const presetSelector = document.getElementById('presetSelector');
    if (presetSelector) {
        presetSelector.addEventListener('change', (e) => {
            const val = e.target.value;
            let p;
            if (val.startsWith('custom_')) p = window.customPresets[val.replace('custom_', '')];
            else p = PRESETS[val];

            if (p) {
                document.getElementById('thresholdSlider').value = p.threshold;
                document.getElementById('holdTimeSlider').value = p.hold;
                document.getElementById('highpassSlider').value = p.hp;
                document.getElementById('gainSlider').value = p.gain;
                if (window.applyPresetToAudio) window.applyPresetToAudio(p.hp, p.gain);
            }
        });
    }

    const sosBtn = document.getElementById('sosBtnMain');
    if (sosBtn) {
        let isSOSActive = false;
        sosBtn.addEventListener('click', () => {
            isSOSActive = !isSOSActive;
            sosBtn.classList.toggle('active', isSOSActive);
            window.ClearWayWebRTC.sendSOS(isSOSActive);
        });
    }

    const vadToggle = document.getElementById('vadToggle');
    const vadContent = document.getElementById('vadContent');
    if (vadToggle && vadContent) {
        vadToggle.addEventListener('click', () => {
            vadContent.classList.toggle('collapsed');
            document.getElementById('vadIcon').innerText = vadContent.classList.contains('collapsed') ? '▶' : '▼';
        });
    }

    loadPresets();
});
