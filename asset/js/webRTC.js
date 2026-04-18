// asset/js/webRTC.js - TripTalk v4.6.6 (Architect Ultimate Edition)

// ─────────────────────────────────────────────
// [ARCHITECT บัคข้อ 2: Symmetric NAT Fix] ติดตั้ง TURN Server (Relay) สำหรับ 4G/5G
// ─────────────────────────────────────────────
const RTC_CONFIG = {
    ICE_SERVERS: [
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:stun1.l.google.com:19302' },
        { urls: 'stun:stun2.l.google.com:19302' },
        {
            urls: 'turn:openrelay.metered.ca:443',
            username: 'openrelayproject',
            credential: 'openrelayproject'
        }
    ],
    ICE_TRANSPORT_POLICY: 'all',
    ICE_CANDIDATE_POOL_SIZE: 10,
    RECONNECT_DELAY_MS: 3000
};

// ─────────────────────────────────────────────
// STATE MANAGEMENT
// ─────────────────────────────────────────────
let peer = null;
let myStream = null;
let myNickname = '';
let isHost = false;
let roomHostId = '';
let roomState = {}; // { peerId: { nickname, role, isTalking, lat, lng, isSOS } }
let connections = {}; // { peerId: DataConnection }
let calls = {}; // { peerId: MediaCall }

// ─────────────────────────────────────────────
// CORE WEBRTC LOGIC
// ─────────────────────────────────────────────

function setupDataHandlers(conn) {
    connections[conn.peer] = conn;
    
    conn.on('open', () => {
        console.log('[WebRTC] Data channel open with:', conn.peer);
        if (isHost) {
            const guestName = conn.metadata?.nickname || 'Unknown Member';
            roomState[conn.peer] = { nickname: guestName, role: 'Member', isTalking: false };
            const peersToCall = Object.keys(roomState).filter(p => p !== conn.peer);
            conn.send({ type: 'welcome', roomState, peersToCall });
            broadcastRoomState();
        }
    });

    conn.on('data', (data) => {
        const peerId = conn.peer;
        if (data.type === 'welcome') {
            roomState = data.roomState;
            updateUIList();
            data.peersToCall.forEach(pid => {
                if (!calls[pid] && pid !== peer.id) initiateCall(pid);
            });
        } else if (data.type === 'update-state') {
            roomState = data.roomState;
            updateUIList();
            Object.entries(roomState).forEach(([pid, state]) => {
                if (pid !== peer.id && state.lat && state.lng && window.updatePeerLocation) {
                    window.updatePeerLocation(pid, state.lat, state.lng, state.nickname);
                }
            });
        } else if (data.type === 'mic-status') {
            if (roomState[peerId]) roomState[peerId].isTalking = data.isActive;
            updateUIList();
        } else if (data.type === 'location') {
            if (roomState[peerId]) {
                roomState[peerId].lat = data.lat;
                roomState[peerId].lng = data.lng;
                if (window.updatePeerLocation) window.updatePeerLocation(peerId, data.lat, data.lng, roomState[peerId].nickname);
            }
        } else if (data.type === 'sos') {
            if (roomState[peerId]) {
                roomState[peerId].isSOS = data.active;
                updateUIList();
                if (data.active && navigator.vibrate) navigator.vibrate([500, 200, 500]);
            }
        }
    });

    conn.on('close', () => handlePeerLeave(conn.peer));
    conn.on('error', () => handlePeerLeave(conn.peer));
}

function handleActiveCall(call) {
    calls[call.peer] = call;
    call.on('stream', (remoteStream) => {
        console.log('[WebRTC] Received stream from:', call.peer);
        
        // [ARCHITECT บัคข้อ 3: Silent Audio Fix] เชื่อมต่อ Web Audio Pipeline โดยตรง
        if (window.TripTalkAudio) {
            window.TripTalkAudio.connectRemoteStream(remoteStream, call.peer);
        }

        // HTML5 Backup (Muted by default to allow autoplay)
        let container = document.getElementById('remoteAudios');
        if (!container) {
            container = document.createElement('div');
            container.id = 'remoteAudios';
            container.style.display = 'none';
            document.body.appendChild(container);
        }

        let audio = document.getElementById(`audio-${call.peer}`);
        if (!audio) {
            audio = document.createElement('audio');
            audio.id = `audio-${call.peer}`;
            audio.autoplay = true;
            audio.setAttribute('playsinline', '');
            audio.muted = true;
            container.appendChild(audio);
        }
        
        audio.srcObject = remoteStream;
        audio.play().then(() => {
            audio.muted = false; 
        }).catch(e => console.warn("[WebRTC] Backup audio blocked, relying on Web Audio Pipeline"));
    });
    call.on('close', () => handlePeerLeave(call.peer));
    call.on('error', () => handlePeerLeave(call.peer));
}

function initiateCall(targetPeerId) {
    if (targetPeerId === peer.id) return;
    console.log('[WebRTC] Initiating call to:', targetPeerId);
    
    const conn = peer.connect(targetPeerId, { 
        metadata: { nickname: myNickname },
        reliable: true 
    });
    setupDataHandlers(conn);

    const call = peer.call(targetPeerId, myStream);
    handleActiveCall(call);
}

function handlePeerLeave(peerId) {
    if (!peerId) return;
    console.log('[WebRTC] Peer left:', peerId);
    delete roomState[peerId];
    delete connections[peerId];
    delete calls[peerId];
    const audio = document.getElementById(`audio-${peerId}`);
    if (audio) audio.remove();
    if (window.removePeerLocation) window.removePeerLocation(peerId);
    updateUIList();
}

// ─────────────────────────────────────────────
// EXPORTED FUNCTIONS
// ─────────────────────────────────────────────

window.ClearWayWebRTC = {
    async joinVoiceRoom(roomId, nickname) {
        try {
            myStream = await navigator.mediaDevices.getUserMedia({ audio: true });
            console.log('[WebRTC] Local stream acquired');
            if (window.VADEngine) {
                window.VADEngine.init(myStream);
            }
        } catch (e) {
            console.error('[WebRTC] Failed to get local stream:', e);
            throw new Error('ไม่สามารถเข้าถึงไมโครโฟนได้');
        }

        myNickname = nickname;
        roomHostId = `triptalk-room-${roomId}`;
        
        const peerConfig = {
            config: { 
                iceServers: RTC_CONFIG.ICE_SERVERS,
                iceTransportPolicy: RTC_CONFIG.ICE_TRANSPORT_POLICY,
                iceCandidatePoolSize: RTC_CONFIG.ICE_CANDIDATE_POOL_SIZE
            },
            debug: 1
        };

        return new Promise((resolve, reject) => {
            peer = new Peer(roomHostId, peerConfig);
            
            peer.on('open', (id) => {
                isHost = true;
                roomState[id] = { nickname: myNickname, role: 'Host', isTalking: false };
                updateUIList();
                updateConnectionStatus('🟢 สร้างห้องแล้ว (Host)', 'active');
                peer.on('connection', setupDataHandlers);
                peer.on('call', (call) => {
                    call.answer(myStream);
                    handleActiveCall(call);
                });
                resolve();
            });

            peer.on('error', (err) => {
                if (err.type === 'unavailable-id') {
                    isHost = false;
                    peer.destroy();
                    peer = new Peer(peerConfig);
                    peer.on('open', (myId) => {
                        updateConnectionStatus('🟡 กำลังเข้าห้อง...', 'muted');
                        initiateCall(roomHostId);
                        resolve();
                    });
                    peer.on('call', (call) => {
                        call.answer(myStream);
                        handleActiveCall(call);
                    });
                    peer.on('connection', setupDataHandlers);
                } else {
                    console.error('[WebRTC] Peer Error:', err);
                    reject(err);
                }
            });
        });
    },

    leaveVoiceRoom() {
        if (peer) {
            peer.disconnect();
            peer.destroy();
            peer = null;
        }
        const container = document.getElementById('remoteAudios');
        if (container) container.innerHTML = '';
        roomState = {};
        connections = {};
        calls = {};
        if (myStream) {
            myStream.getTracks().forEach(track => track.stop());
            myStream = null;
        }
        console.log('[WebRTC] Left room and cleaned up');
    },

    updateMyTalkingState(isActive) {
        if (!peer || !peer.id || !roomState[peer.id]) return;
        roomState[peer.id].isTalking = isActive;
        broadcastToAll({ type: 'mic-status', isActive });
        updateUIList();
    },

    sendLocation(lat, lng) {
        if (!peer || !peer.id || !roomState[peer.id]) return;
        roomState[peer.id].lat = lat;
        roomState[peer.id].lng = lng;
        broadcastToAll({ type: 'location', lat, lng });
    },

    sendSOS(active = true) {
        if (!peer || !peer.id || !roomState[peer.id]) return;
        roomState[peer.id].isSOS = active;
        broadcastToAll({ type: 'sos', active });
        updateUIList();
    }
};

function broadcastToAll(data) {
    Object.values(connections).forEach(conn => {
        if (conn.open) conn.send(data);
    });
}

function broadcastRoomState() {
    broadcastToAll({ type: 'update-state', roomState });
}

function updateUIList() {
    if (window.renderMembersUI) {
        window.renderMembersUI(roomState, peer ? peer.id : null);
    }
}

function updateConnectionStatus(text, type) {
    const badge = document.getElementById('connectionStatusBadge');
    const label = document.getElementById('connectionStatusText');
    if (label) label.innerText = text;
    if (badge) badge.className = `status-badge ${type}`;
}
