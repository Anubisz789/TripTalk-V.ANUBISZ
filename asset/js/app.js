// asset/js/app.js

// ─────────────────────────────────────────────
// [ARCHITECT v4.5] MAP & LOCATION LOGIC
// ─────────────────────────────────────────────
let map = null;
let markers = {}; // { peerId: Marker }
let locationWatchId = null;
let lastLocationSent = 0;

function initMap() {
    if (map) return;
    console.log('[Map] Initializing Map...');
    map = L.map('map').setView([13.7367, 100.5231], 13);
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
        attribution: '&copy; OpenStreetMap contributors'
    }).addTo(map);
    
    // Resize map to fit container
    setTimeout(() => map.invalidateSize(), 500);
}

function updateMapMarkers(roomState) {
    if (!map) return; // Wait for initMap
    
    Object.keys(roomState).forEach(peerId => {
        const user = roomState[peerId];
        if (user.lat && user.lng) {
            if (!markers[peerId]) {
                const icon = L.divIcon({
                    className: 'custom-div-icon',
                    html: `<div style='background-color:${user.isSOS ? "#f44336" : "#4caf50"};' class='marker-pin'></div><span class='marker-label'>${user.nickname}</span>`,
                    iconSize: [30, 42],
                    iconAnchor: [15, 42]
                });
                markers[peerId] = L.marker([user.lat, user.lng], { icon }).addTo(map)
                    .bindPopup(user.nickname + (user.isSOS ? ' 🚨 SOS!' : ''));
            } else {
                markers[peerId].setLatLng([user.lat, user.lng]);
                if (user.isSOS) markers[peerId].openPopup();
            }
        }
    });
}

function startLocationSharing() {
    if ("geolocation" in navigator) {
        console.log('[Location] Requesting GPS permission...');
        locationWatchId = navigator.geolocation.watchPosition(
            (pos) => {
                const { latitude, longitude } = pos.coords;
                const now = Date.now();
                // Send location immediately on first fix, then every 10s
                if (now - lastLocationSent > 10000 || lastLocationSent === 0) {
                    window.ClearWayWebRTC.sendLocation(latitude, longitude);
                    lastLocationSent = now;
                    document.getElementById('locationStatus').innerText = 'แชร์พิกัดอยู่ 🟢';
                    
                    // Center map on ME for the first time
                    if (lastLocationSent === now && map) {
                        map.setView([latitude, longitude], 15);
                    }
                }
            },
            (err) => {
                console.warn('[Location] Error:', err.message);
                document.getElementById('locationStatus').innerText = 'GPS ปิดอยู่ 🔴';
            },
            { enableHighAccuracy: true, timeout: 20000, maximumAge: 10000 }
        );
    }
}

function stopLocationSharing() {
    if (locationWatchId) navigator.geolocation.clearWatch(locationWatchId);
    locationWatchId = null;
    lastLocationSent = 0;
}

// ─────────────────────────────────────────────
// [ARCHITECT v4.5] AUDIO & SOS SYSTEM
// ─────────────────────────────────────────────
let isSOSActive = false;
const sosBtn = document.getElementById('sosBtn');

if (sosBtn) {
    sosBtn.addEventListener('click', () => {
        isSOSActive = !isSOSActive;
        sosBtn.classList.toggle('active', isSOSActive);
        window.ClearWayWebRTC.sendSOS(isSOSActive);
        
        // Force resume audio context on click (Mobile Unlock)
        forceResumeAudio();
        
        if (isSOSActive) {
            if (navigator.vibrate) navigator.vibrate([500, 200, 500]);
            alert('ส่งสัญญาณ SOS ถึงทุกคนในกลุ่มแล้ว! 🚨');
        }
    });
}

function forceResumeAudio() {
    // Attempt to resume all audio elements and context
    const audios = document.querySelectorAll('audio');
    audios.forEach(a => a.play().catch(() => {}));
    
    if (window.audioContext && window.audioContext.state === 'suspended') {
        window.audioContext.resume();
    }
}

// ─────────────────────────────────────────────
// SERVICE WORKER & PWA
// ─────────────────────────────────────────────
// [ARCHITECT v4.6] SERVICE WORKER & AUTO-UPDATE LOGIC
if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
        navigator.serviceWorker.register('./sw.js', { scope: './' })
            .then(reg => {
                console.log('[SW] Registered successfully');
                
                // ตรวจจับเมื่อมี SW ตัวใหม่พร้อมใช้งาน (Waiting state)
                reg.addEventListener('updatefound', () => {
                    const newWorker = reg.installing;
                    newWorker.addEventListener('statechange', () => {
                        if (newWorker.state === 'installed' && navigator.serviceWorker.controller) {
                            // แจ้งเตือนผู้ใช้หรือ Reload อัตโนมัติเมื่ออัปเดตเสร็จ
                            console.log('[SW] New version found! Reloading...');
                            window.location.reload();
                        }
                    });
                });
            })
            .catch(e => console.error('[SW] Registration failed:', e));
    });

    // ป้องกันการ Reload วนลูป (Infinite Reload Loop)
    let refreshing = false;
    navigator.serviceWorker.addEventListener('controllerchange', () => {
        if (!refreshing) {
            refreshing = true;
            window.location.reload();
        }
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
        }
    } catch (err) {}
}

// ─────────────────────────────────────────────
// PRESET SYSTEM
// ─────────────────────────────────────────────
const PRESET_DEFINITIONS = {
    city: { label: '🏙️ ในเมือง', threshold: 35, holdMs: 800, highpassHz: 80, gain: 1.2 },
    touring: { label: '🛣️ ทริประยะไกล', threshold: 50, holdMs: 1200, highpassHz: 100, gain: 1.4 },
    racing: { label: '🏎️ ความเร็วสูง', threshold: 65, holdMs: 1500, highpassHz: 150, gain: 1.6 }
};

function applyPreset(key) {
    const p = { ...PRESET_DEFINITIONS, ...JSON.parse(localStorage.getItem('custom_presets') || '{}') }[key];
    if (!p) return;
    
    document.getElementById('thresholdSlider').value = p.threshold;
    document.getElementById('holdTimeSlider').value = p.holdMs;
    document.getElementById('highpassSlider').value = p.highpassHz;
    document.getElementById('gainSlider').value = p.gain * 10;
    
    // Update labels
    document.getElementById('thresholdVal').innerText = p.threshold + '%';
    document.getElementById('holdTimeVal').innerText = (p.holdMs/1000).toFixed(1) + 's';
    document.getElementById('highpassVal').innerText = p.highpassHz + ' Hz';
    document.getElementById('gainVal').innerText = p.gain.toFixed(1) + 'x';
    
    if (window.applyPresetToAudio) window.applyPresetToAudio(p.highpassHz, p.gain);
}

// ─────────────────────────────────────────────
// CALL CONTROL
// ─────────────────────────────────────────────
let isRiding = false;

async function toggleRide() {
    const roomId = document.getElementById('roomInput').value.trim();
    const nickname = document.getElementById('nicknameInput').value.trim();

    if (!roomId || !nickname) {
        alert('กรุณาใส่รหัสทริป และ ชื่อเล่น!');
        return;
    }

    if (!isRiding) {
        isRiding = true;
        document.getElementById('startRideBtn').classList.add('stop');
        document.getElementById('startBtnText').innerText = 'ออกจากห้อง';
        document.getElementById('roomControlPanel').style.display = 'none';
        document.getElementById('membersPanel').style.display = 'block';
        document.getElementById('sosBtn').style.display = 'flex';

        // Unlock audio context
        forceResumeAudio();

        const stream = await window.startMainMic();
        if (stream) {
            window.ClearWayWebRTC.joinVoiceRoom(roomId, nickname, stream);
            requestWakeLock();
            initMap();
            startLocationSharing();
        }
    } else {
        isRiding = false;
        document.getElementById('startRideBtn').classList.remove('stop');
        document.getElementById('startBtnText').innerText = 'เริ่มสนทนา';
        document.getElementById('roomControlPanel').style.display = 'block';
        document.getElementById('membersPanel').style.display = 'none';
        document.getElementById('sosBtn').style.display = 'none';

        window.stopMainMic();
        window.ClearWayWebRTC.leaveVoiceRoom();
        stopLocationSharing();
    }
}

// ─────────────────────────────────────────────
// UI RENDERER & INITIALIZATION
// ─────────────────────────────────────────────
window.ClearWayUI = {
    renderMembers(roomState, myId) {
        const list = document.getElementById('memberList');
        if (!list) return;
        list.innerHTML = '';
        Object.keys(roomState).forEach(id => {
            const user = roomState[id];
            const li = document.createElement('li');
            li.className = `member-item ${user.isSOS ? 'sos-alert' : ''}`;
            li.innerHTML = `
                <div class="member-info">
                    <div class="mic-indicator ${user.isTalking ? 'active' : ''}"></div>
                    <span>${user.nickname} ${id === myId ? '(คุณ)' : ''}</span>
                </div>
                <span>${user.isSOS ? '🚨 SOS' : (user.role === 'Host' ? '👑 Host' : '👤')}</span>
            `;
            list.appendChild(li);
        });
        updateMapMarkers(roomState);
    },
    onSOS(peerId, nickname, active) {
        if (active) {
            if (navigator.vibrate) navigator.vibrate([200, 100, 200]);
            forceResumeAudio(); // Try to play audio when SOS received
        }
    },
    updateMap: updateMapMarkers
};

document.addEventListener('DOMContentLoaded', () => {
    document.getElementById('startRideBtn').addEventListener('click', toggleRide);
    document.getElementById('vadToggle').addEventListener('click', () => {
        document.getElementById('vadContent').classList.toggle('collapsed');
    });
    
    // Populate presets
    const sel = document.getElementById('presetSelector');
    if (sel) {
        Object.entries(PRESET_DEFINITIONS).forEach(([k, v]) => {
            const opt = document.createElement('option');
            opt.value = k; opt.innerText = v.label;
            sel.appendChild(opt);
        });
        sel.addEventListener('change', (e) => applyPreset(e.target.value));
        applyPreset('touring');
    }

    // Global click listener to unlock audio
    document.addEventListener('click', forceResumeAudio, { once: false });
});
