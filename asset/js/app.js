// asset/js/app.js - TripTalk v4.6.6 (Architect Ultimate Edition)

// ─────────────────────────────────────────────
// [ARCHITECT บัคข้อ 5: Path & Dead Code Fix] ใช้ Relative Path และลบโค้ดส่วนเกิน
// ─────────────────────────────────────────────

// ─────────────────────────────────────────────
// GLOBAL AUDIO MANAGEMENT (v4.6.6)
// ─────────────────────────────────────────────
window.TripTalkAudio = {
    context: null,
    gainNode: null,
    remoteStreams: {}, // { peerId: { source, gain } }
    isUnlocked: false,

    async unlock() {
        if (this.isUnlocked) return;
        try {
            this.context = new (window.AudioContext || window.webkitAudioContext)();
            this.gainNode = this.context.createGain();
            this.gainNode.connect(this.context.destination);
            
            // Play silent buffer to unlock on iOS
            const buffer = this.context.createBuffer(1, 1, 22050);
            const source = this.context.createBufferSource();
            source.buffer = buffer;
            source.connect(this.context.destination);
            source.start(0);
            
            if (this.context.state === 'suspended') {
                await this.context.resume();
            }
            this.isUnlocked = true;
            console.log('[Audio] Context Unlocked & Running');
        } catch (e) {
            console.error('[Audio] Failed to unlock context:', e);
        }
    },

    connectRemoteStream(stream, peerId) {
        if (!this.context || !this.isUnlocked) return;
        if (this.remoteStreams[peerId]) this.remoteStreams[peerId].source.disconnect();

        const source = this.context.createMediaStreamSource(stream);
        const gain = this.context.createGain();
        source.connect(gain);
        gain.connect(this.gainNode);
        
        this.remoteStreams[peerId] = { source, gain };
        console.log('[Audio] Stream connected for:', peerId);
    }
};

// ─────────────────────────────────────────────
// UI & APP LOGIC
// ─────────────────────────────────────────────
let map = null;
let userMarker = null;
let peerMarkers = {};
let isJoined = false;
let locationInterval = null;

// [ARCHITECT บัคข้อ 4: GPS Race Condition Fix] ปรับปรุงลำดับการโหลดแผนที่
function initMap() {
    const mapDiv = document.getElementById('map');
    if (!mapDiv || map) return;

    console.log('[Map] Initializing Leaflet...');
    map = L.map('map').setView([13.7367, 100.5231], 13);
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
        attribution: '&copy; OpenStreetMap contributors'
    }).addTo(map);

    // Force redraw after init to prevent blank tiles
    setTimeout(() => map.invalidateSize(), 500);
}

async function fetchLocation(immediate = false) {
    if (!navigator.geolocation) return;
    
    navigator.geolocation.getCurrentPosition(
        (pos) => {
            const { latitude: lat, longitude: lng } = pos.coords;
            console.log(`[GPS] Location updated: ${lat}, ${lng}`);
            
            if (!map) initMap();
            if (map) {
                if (!userMarker) {
                    userMarker = L.marker([lat, lng]).addTo(map).bindPopup('คุณ (You)').openPopup();
                } else {
                    userMarker.setLatLng([lat, lng]);
                }
                if (immediate) map.setView([lat, lng], 15);
            }
            
            if (window.ClearWayWebRTC && isJoined) {
                window.ClearWayWebRTC.sendLocation(lat, lng);
            }
            
            const statusLabel = document.getElementById('locationStatus');
            if (statusLabel) statusLabel.innerText = '📍 อัปเดตพิกัดแล้ว';
        },
        (err) => {
            console.warn('[GPS] Error fetching location:', err.message);
            const statusLabel = document.getElementById('locationStatus');
            if (statusLabel) statusLabel.innerText = '❌ พิกัดขัดข้อง';
        },
        { enableHighAccuracy: true, timeout: 10000 }
    );
}

window.updatePeerLocation = (peerId, lat, lng, nickname) => {
    if (!map) initMap();
    if (!map) return;

    if (!peerMarkers[peerId]) {
        peerMarkers[peerId] = L.marker([lat, lng], {
            icon: L.icon({
                iconUrl: 'https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon.png',
                iconSize: [25, 41],
                iconAnchor: [12, 41]
            })
        }).addTo(map).bindPopup(nickname);
    } else {
        peerMarkers[peerId].setLatLng([lat, lng]);
    }
};

window.removePeerLocation = (peerId) => {
    if (peerMarkers[peerId]) {
        peerMarkers[peerId].remove();
        delete peerMarkers[peerId];
    }
};

window.renderMembersUI = (roomState, myId) => {
    const list = document.getElementById('memberList');
    if (!list) return;
    list.innerHTML = '';
    
    Object.entries(roomState).forEach(([pid, state]) => {
        const li = document.createElement('li');
        li.className = 'member-item';
        const isMe = pid === myId;
        const talkingClass = state.isTalking ? 'talking' : '';
        const sosClass = state.isSOS ? 'sos-active' : '';
        
        li.innerHTML = `
            <div class="member-info">
                <span class="member-status ${talkingClass}"></span>
                <span class="member-name">${state.nickname} ${isMe ? '(คุณ)' : ''}</span>
                <span class="member-role">${state.role}</span>
            </div>
            ${state.isSOS ? '<span class="sos-tag">🆘 SOS</span>' : ''}
        `;
        list.appendChild(li);
    });
};

// ─────────────────────────────────────────────
// EVENT LISTENERS
// ─────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', () => {
    const startBtn = document.getElementById('startRideBtn');
    const nicknameInput = document.getElementById('nicknameInput');
    const roomInput = document.getElementById('roomInput');
    const vadToggle = document.getElementById('vadToggle');
    const vadContent = document.getElementById('vadContent');
    const sosBtn = document.getElementById('sosBtn');

    // [ARCHITECT บัคข้อ 5 Fix] ป้องกัน Error หากปุ่มไม่มีอยู่จริง
    if (vadToggle && vadContent) {
        vadToggle.addEventListener('click', () => {
            vadContent.classList.toggle('collapsed');
            const icon = document.getElementById('vadIcon');
            if (icon) icon.innerText = vadContent.classList.contains('collapsed') ? '▶' : '▼';
        });
    }

    if (startBtn) {
        startBtn.addEventListener('click', async () => {
            if (!isJoined) {
                const nick = nicknameInput.value.trim();
                const room = roomInput.value.trim();
                if (!nick || !room) return alert('กรุณากรอกชื่อและรหัสทริป');

                startBtn.disabled = true;
                startBtn.innerHTML = '<span>⏳ กำลังเข้าห้อง...</span>';

                try {
                    // [ARCHITECT บัคข้อ 3 Fix] ปลดล็อกเสียงทันทีที่กดปุ่ม
                    await window.TripTalkAudio.unlock();
                    
                    await window.ClearWayWebRTC.joinVoiceRoom(room, nick);
                    
                    isJoined = true;
                    startBtn.disabled = false;
                    startBtn.classList.add('btn-danger');
                    startBtn.innerHTML = '<span class="btn-icon">🛑</span><span>หยุดสนทนา</span>';
                    
                    document.getElementById('roomControlPanel').style.display = 'none';
                    document.getElementById('membersPanel').style.display = 'block';
                    document.getElementById('networkStatusPanel').style.display = 'flex';
                    if (sosBtn) sosBtn.style.display = 'flex';

                    // [ARCHITECT บัคข้อ 4 Fix] ดึงพิกัดทันที ไม่ต้องรอรอบ
                    fetchLocation(true);
                    locationInterval = setInterval(() => fetchLocation(), 15000);
                    
                } catch (e) {
                    alert(e.message);
                    startBtn.disabled = false;
                    startBtn.innerHTML = '<span class="btn-icon">🏍️</span><span>เริ่มสนทนา</span>';
                }
            } else {
                window.ClearWayWebRTC.leaveVoiceRoom();
                location.reload(); // [ARCHITECT บัคข้อ 1 Fix] รีโหลดเพื่อล้าง State
            }
        });
    }

    if (sosBtn) {
        sosBtn.addEventListener('click', () => {
            const isActive = sosBtn.classList.toggle('active');
            window.ClearWayWebRTC.sendSOS(isActive);
        });
    }
});

// [ARCHITECT บัคข้อ 1: Zombie SW Fix] บังคับ Reload เมื่อ SW อัปเดต
if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('./sw.js?v=4.6.6').then(reg => {
        reg.addEventListener('updatefound', () => {
            const newWorker = reg.installing;
            newWorker.addEventListener('statechange', () => {
                if (newWorker.state === 'installed' && navigator.serviceWorker.controller) {
                    console.log('[SW] New version available, reloading...');
                    window.location.reload();
                }
            });
        });
    });

    let refreshing = false;
    navigator.serviceWorker.addEventListener('controllerchange', () => {
        if (!refreshing) {
            window.location.reload();
            refreshing = true;
        }
    });
}
