// asset/js/webRTC.js

// ─────────────────────────────────────────────
// CONFIG — Technical Architect Refactor (v4.5 Final Fix)
// ─────────────────────────────────────────────
const RTC_CONFIG = {
    ICE_SERVERS: [
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:stun1.l.google.com:19302' },
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
            
            // Full Mesh: Host tells the new guest who else is in the room
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
            // Guest calls everyone else in the room
            data.peersToCall.forEach(pid => {
                if (!calls[pid] && pid !== peer.id) {
                    initiateCall(pid);
                }
            });
        } else if (data.type === 'update-state') {
            roomState = data.roomState;
            updateUIList();
        } else if (data.type === 'mic-status') {
            if (roomState[peerId]) roomState[peerId].isTalking = data.isActive;
            updateUIList();
        } else if (data.type === 'location') {
            if (roomState[peerId]) {
                roomState[peerId].lat = data.lat;
                roomState[peerId].lng = data.lng;
                if (window.ClearWayUI && window.ClearWayUI.updateMap) {
                    window.ClearWayUI.updateMap(roomState);
                }
            }
        } else if (data.type === 'sos') {
            if (roomState[peerId]) {
                roomState[peerId].isSOS = data.active;
                if (window.ClearWayUI && window.ClearWayUI.onSOS) {
                    window.ClearWayUI.onSOS(peerId, roomState[peerId].nickname, data.active);
                }
                updateUIList();
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
        let audio = document.getElementById(`audio-${call.peer}`);
        if (!audio) {
            audio = document.createElement('audio');
            audio.id = `audio-${call.peer}`;
            audio.autoplay = true;
            audio.setAttribute('playsinline', '');
            document.getElementById('remoteAudios').appendChild(audio);
        }
        audio.srcObject = remoteStream;
        
        // Force play for mobile browsers
        const playPromise = audio.play();
        if (playPromise !== undefined) {
            playPromise.catch(error => {
                console.warn("[WebRTC] Autoplay blocked, waiting for interaction:", error);
                // We'll retry playing on next user click via app.js
            });
        }
    });
    call.on('close', () => handlePeerLeave(call.peer));
    call.on('error', () => handlePeerLeave(call.peer));
}

function initiateCall(targetPeerId) {
    if (targetPeerId === peer.id) return;
    console.log('[WebRTC] Initiating call to:', targetPeerId);
    
    // 1. Data Connection
    const conn = peer.connect(targetPeerId, { 
        metadata: { nickname: myNickname },
        reliable: true 
    });
    setupDataHandlers(conn);

    // 2. Audio Call
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
    updateUIList();
}

// ─────────────────────────────────────────────
// EXPORTED FUNCTIONS
// ─────────────────────────────────────────────

window.ClearWayWebRTC = {
    joinVoiceRoom(roomId, nickname, localStream) {
        myStream = localStream;
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

        // Try to be Host
        peer = new Peer(roomHostId, peerConfig);
        
        peer.on('open', (id) => {
            isHost = true;
            roomState[id] = { nickname: myNickname, role: 'Host', isTalking: false };
            updateUIList();
            updateConnectionStatus('🟢 สร้างห้องแล้ว (Host)', 'active');
            
            peer.on('connection', setupDataHandlers);
            peer.on('call', (call) => {
                console.log('[WebRTC] Incoming call as Host from:', call.peer);
                call.answer(myStream);
                handleActiveCall(call);
            });
        });

        peer.on('error', (err) => {
            if (err.type === 'unavailable-id') {
                // Room exists, join as Guest
                isHost = false;
                peer.destroy();
                peer = new Peer(peerConfig);
                peer.on('open', (myId) => {
                    updateConnectionStatus('🟡 กำลังเข้าห้อง...', 'muted');
                    initiateCall(roomHostId);
                });
                peer.on('call', (call) => {
                    console.log('[WebRTC] Incoming call as Guest from:', call.peer);
                    call.answer(myStream);
                    handleActiveCall(call);
                });
                peer.on('connection', setupDataHandlers);
            } else {
                console.error('[WebRTC] Peer Error:', err);
            }
        });
    },

    leaveVoiceRoom() {
        if (peer) peer.destroy();
        document.getElementById('remoteAudios').innerHTML = '';
        roomState = {};
        connections = {};
        calls = {};
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
        if (window.ClearWayUI && window.ClearWayUI.updateMap) {
            window.ClearWayUI.updateMap(roomState);
        }
    },

    sendSOS(active) {
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
    if (window.ClearWayUI) {
        window.ClearWayUI.renderMembers(roomState, peer ? peer.id : null);
    }
}

function updateConnectionStatus(text, type) {
    const badge = document.getElementById('connectionStatusBadge');
    const label = document.getElementById('connectionStatusText');
    if (label) label.innerText = text;
    if (badge) {
        badge.className = `status-badge ${type}`;
    }
}
