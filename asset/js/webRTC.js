// asset/js/webRTC.js

// ─────────────────────────────────────────────
// CONFIG — Technical Architect Refactor (v4.2)
// ─────────────────────────────────────────────
const RTC_CONFIG = {
    BITRATE_SPEAKING:         28000,  // bps
    BITRATE_SILENT:           8000,   // bps
    BITRATE_UNSTABLE:         16000,  // bps
    BITRATE_STEP_DOWN:        3000,
    BITRATE_STEP_UP:          28000,
    STATS_INTERVAL_MS:        2000,
    RECONNECT_DELAY_MS:       3000,
    CONN_TIMEOUT_MS:          15000,
    RTT_UNSTABLE_THRESHOLD:   0.15,   // 150ms
    PACKET_LOSS_THRESHOLD:    5,      // 5%
    
    // [Architect Fix] เพิ่ม ICE Servers เพื่อรองรับการข้ามผ่าน Symmetric NAT (4G/5G)
    ICE_SERVERS: [
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:stun1.l.google.com:19302' },
        { urls: 'stun:stun2.l.google.com:19302' },
        { urls: 'stun:stun3.l.google.com:19302' },
        { urls: 'stun:stun4.l.google.com:19302' },
        // [Critical] เพิ่ม TURN Server สำหรับเน็ตมือถือ 4G/5G (ใช้ OpenRelay เป็นค่าเริ่มต้น)
        {
            urls: 'turn:openrelay.metered.ca:443',
            username: 'openrelayproject',
            credential: 'openrelayproject'
        },
        {
            urls: 'turn:openrelay.metered.ca:80',
            username: 'openrelayproject',
            credential: 'openrelayproject'
        }
    ],
};

// ─────────────────────────────────────────────
// STATE MANAGEMENT
// ─────────────────────────────────────────────
let peer                  = null;
let connectedPeers        = {}; // { peerId: MediaConnection }
let myStream              = null;
let myNickname            = '';
let isHost                = false;
let roomHostId            = '';
let currentRoomId         = '';
let isLeaving             = false;
let reconnectTimer        = null;
let connTimeoutTimer      = null;
let hostDataConnection    = null; // สำหรับ Guest
let clientDataConnections = {}; // สำหรับ Host
let roomState             = {};

// [v4.7.0] New Feature: SOS & Map
let myLocation        = { lat: 0, lng: 0 };
let locationInterval  = null;

// Bitrate + Stats Control
let isSpeaking            = false;
let currentBitrate        = RTC_CONFIG.BITRATE_SILENT;
let statsInterval         = null;
let lastTotalBytes        = 0;
let lastStatsTime         = 0;

// ─────────────────────────────────────────────
// DOM / AUDIO SETUP
// ─────────────────────────────────────────────
const remoteAudioContainer = document.createElement('div');
remoteAudioContainer.id = 'remoteAudios';
remoteAudioContainer.style.display = 'none';
document.body.appendChild(remoteAudioContainer);

function playBeep(type) {
    try {
        const ctx  = new (window.AudioContext || window.webkitAudioContext)();
        const osc  = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.connect(gain);
        gain.connect(ctx.destination);
        gain.gain.setValueAtTime(0.2, ctx.currentTime);
        gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.3);
        osc.frequency.setValueAtTime(type === 'join' ? 660 : 880, ctx.currentTime);
        osc.frequency.setValueAtTime(type === 'join' ? 880 : 440, ctx.currentTime + 0.1);
        osc.start(ctx.currentTime);
        osc.stop(ctx.currentTime + 0.3);
        osc.onended = () => ctx.close();
    } catch(e) {}
}

// ─────────────────────────────────────────────
// CORE WEBRTC LOGIC
// ─────────────────────────────────────────────

async function _applyBitrate(peers, bitrate) {
    for (const call of Object.values(peers)) {
        try {
            const pc = call.peerConnection;
            if (!pc) continue;
            const senders = pc.getSenders().filter(s => s.track?.kind === 'audio');
            for (const sender of senders) {
                const params = sender.getParameters();
                if (!params.encodings?.length) params.encodings = [{}];
                if (params.encodings[0].maxBitrate !== bitrate) {
                    params.encodings[0].maxBitrate = bitrate;
                    await sender.setParameters(params);
                }
            }
        } catch(e) { console.warn('Bitrate update failed:', e); }
    }
}

function handleActiveCall(call) {
    if (!call) return;
    const peerId = call.peer;
    connectedPeers[peerId] = call;

    call.on('stream', (remoteStream) => {
        let audio = document.getElementById(`audio-${peerId}`);
        if (!audio) {
            audio          = document.createElement('audio');
            audio.id       = `audio-${peerId}`;
            audio.autoplay = true;
            audio.setAttribute('playsinline', ''); // สำคัญสำหรับ iOS
            remoteAudioContainer.appendChild(audio);
        }
        audio.srcObject = remoteStream;
        audio.play().catch(e => console.warn("Autoplay blocked:", e));
    });

    call.on('close', () => {
        _cleanupPeerAudio(peerId);
        delete connectedPeers[peerId];
    });

    call.on('error', (err) => {
        console.error(`Call error with ${peerId}:`, err);
        _cleanupPeerAudio(peerId);
    });
}

function _cleanupPeerAudio(peerId) {
    const audio = document.getElementById(`audio-${peerId}`);
    if (audio) {
        audio.pause();
        audio.srcObject = null;
        audio.remove();
    }
}

function handlePeerLeave(peerId) {
    if (!peerId) return;
    if (clientDataConnections[peerId]) {
        clientDataConnections[peerId].close();
        delete clientDataConnections[peerId];
    }
    if (connectedPeers[peerId]) {
        connectedPeers[peerId].close();
        delete connectedPeers[peerId];
    }
    _cleanupPeerAudio(peerId);
    if (roomState[peerId]) {
        delete roomState[peerId];
        playBeep('leave');
    }
    if (isHost) broadcastRoomState();
    updateUIList();
}

// ─────────────────────────────────────────────
// SIGNALING & ROOM JOIN
// ─────────────────────────────────────────────

function joinVoiceRoom(roomId, nickname, localStream) {
    myStream      = localStream;
    myNickname    = nickname;
    currentRoomId = roomId;
    roomHostId    = `clearway-room-${roomId}`;
    isLeaving     = false;

    updateConnectionStatus('🟡 กำลังเชื่อมต่อเซิร์ฟเวอร์...', 'muted');

    const peerConfig = {
        debug: 1,
        config: { 
            iceServers: RTC_CONFIG.ICE_SERVERS,
            iceTransportPolicy: 'all',
            iceCandidatePoolSize: 10
        }
    };

    peer = new Peer(roomHostId, peerConfig);

    // Case 1: เป็น Host (ID ว่าง)
    peer.on('open', (id) => {
        isHost = true;
        roomState[id] = { nickname: myNickname, role: 'Host', isTalking: false };
        updateUIList();
        updateConnectionStatus('🟢 สร้างห้องแล้ว (หัวหน้าทริป)', 'active');
        startStatsLoop();

        peer.on('connection', (conn) => {
            clientDataConnections[conn.peer] = conn;
            conn.on('open', () => {
                const guestName = conn.metadata?.nickname || 'Unknown';
                roomState[conn.peer] = { nickname: guestName, role: 'Member', isTalking: false };
                
                // [Architect Fix] ส่งรายชื่อทุกคนรวมถึง Host เองให้ Guest ใหม่ (Full Mesh)
                const allPeers = Object.keys(roomState).filter(p => p !== conn.peer);
                conn.send({ type: 'welcome', roomState, peersToCall: allPeers });
                
                broadcastRoomState();
                updateUIList();
                playBeep('join');
            });

            conn.on('data', (data) => {
                if (data.type === 'mic-status') {
                    if (roomState[conn.peer]) roomState[conn.peer].isTalking = data.isActive;
                    broadcastRoomState();
                    updateUIList();
                } else if (data.type === 'leave') {
                    handlePeerLeave(conn.peer);
                } else if (data.type === 'location') {
                    if (roomState[conn.peer]) roomState[conn.peer].location = data.location;
                    broadcastRoomState();
                    updateUIList();
                } else if (data.type === 'sos') {
                    if (roomState[conn.peer]) roomState[conn.peer].sos = data.isActive;
                    broadcastRoomState();
                    updateUIList();
                    if (data.isActive && typeof window.playSOSAlert === 'function') window.playSOSAlert();
                }
            });

            conn.on('close', () => handlePeerLeave(conn.peer));
            conn.on('error', () => handlePeerLeave(conn.peer));
        });

        peer.on('call', (call) => {
            call.answer(myStream);
            handleActiveCall(call);
        });
    });

    // Case 2: เป็น Guest (ID ถูกใช้แล้ว)
    peer.on('error', (err) => {
        if (err.type === 'unavailable-id') {
            isHost = false;
            peer.destroy();
            
            peer = new Peer(peerConfig);

            peer.on('open', (myId) => {
                updateConnectionStatus('🟡 กำลังเข้าห้อง...', 'muted');
                hostDataConnection = peer.connect(roomHostId, { 
                    metadata: { nickname: myNickname },
                    reliable: true
                });

                connTimeoutTimer = setTimeout(() => {
                    if (!hostDataConnection.open && !isLeaving) attemptReconnect();
                }, RTC_CONFIG.CONN_TIMEOUT_MS);

                hostDataConnection.on('open', () => {
                    clearTimeout(connTimeoutTimer);
                    updateConnectionStatus('🟢 เข้าร่วมทริปแล้ว', 'active');
                    startStatsLoop();
                });

                hostDataConnection.on('data', (data) => {
                    if (data.type === 'welcome') {
                        roomState = data.roomState;
                        updateUIList();
                        // [Architect Fix] โทรหาทุกคนที่อยู่ในห้อง (Full Mesh)
                        data.peersToCall.forEach(otherId => {
                            if (!connectedPeers[otherId]) {
                                const call = peer.call(otherId, myStream);
                                handleActiveCall(call);
                            }
                        });
                    } else if (data.type === 'update-state') {
                        roomState = data.roomState;
                        updateUIList();
                    } else if (data.type === 'leave') {
                        handlePeerLeave(data.peerId);
                        if (data.peerId === roomHostId) {
                            alert('หัวหน้าทริปสิ้นสุดการสนทนา');
                            location.reload();
                        }
                    } else if (data.type === 'sos-alert') {
                        if (typeof window.playSOSAlert === 'function') window.playSOSAlert();
                    }
                });

                hostDataConnection.on('close', () => {
                    if (!isLeaving) attemptReconnect();
                });
                
                hostDataConnection.on('error', () => {
                    if (!isLeaving) attemptReconnect();
                });
            });

            // [Architect Fix] Guest ต้องรับสายจาก Guest คนอื่นที่เข้าห้องมาทีหลังด้วย
            peer.on('call', (call) => {
                call.answer(myStream);
                handleActiveCall(call);
            });

            peer.on('disconnected', () => { if (!isLeaving) peer.reconnect(); });
        } else {
            console.error('PeerJS error:', err);
            if (!isLeaving && err.type !== 'peer-unavailable') {
                updateConnectionStatus('🔴 เชื่อมต่อผิดพลาด', 'disconnected');
            }
        }
    });
}

// ─────────────────────────────────────────────
// STATS & BITRATE CONTROL
// ─────────────────────────────────────────────

function startStatsLoop() {
    if (statsInterval) clearInterval(statsInterval);
    statsInterval = setInterval(async () => {
        if (!peer || isLeaving) return;

        // 1. Bitrate Adjustment based on Voice Activity
        const targetBitrate = isSpeaking ? RTC_CONFIG.BITRATE_STEP_UP : RTC_CONFIG.BITRATE_STEP_DOWN;
        if (currentBitrate !== targetBitrate) {
            currentBitrate = targetBitrate;
            await _applyBitrate(connectedPeers, currentBitrate);
        }

        // 2. Network Quality Check (Sampling first peer for simplicity)
        const firstCall = Object.values(connectedPeers)[0];
        if (firstCall?.peerConnection) {
            try {
                const stats = await firstCall.peerConnection.getStats();
                let rtt = 0;
                let loss = 0;
                stats.forEach(report => {
                    if (report.type === 'remote-inbound-rtp') {
                        rtt = report.roundTripTime || 0;
                        loss = report.packetsLost || 0;
                    }
                });
                
                // Update UI Network Status if elements exist
                const pingEl = document.getElementById('pingValue');
                if (pingEl) {
                    pingEl.innerText = `${Math.round(rtt * 1000)} ms`;
                    pingEl.className = rtt < RTC_CONFIG.RTT_UNSTABLE_THRESHOLD ? 'net-value good' : 'net-value warn';
                }
            } catch(e) {}
        }
    }, RTC_CONFIG.STATS_INTERVAL_MS);

    // [v4.7.0] Location Broadcast
    if (locationInterval) clearInterval(locationInterval);
    locationInterval = setInterval(() => {
        if (navigator.geolocation) {
            navigator.geolocation.getCurrentPosition(pos => {
                myLocation = { lat: pos.coords.latitude, lng: pos.coords.longitude };
                const data = { type: 'location', location: myLocation };
                if (isHost) {
                    if (peer && roomState[peer.id]) roomState[peer.id].location = myLocation;
                    broadcastRoomState();
                } else if (hostDataConnection?.open) {
                    hostDataConnection.send(data);
                }
            }, null, { enableHighAccuracy: true });
        }
    }, 10000);
}

function sendSOS(isActive) {
    const data = { type: 'sos', isActive };
    if (isHost) {
        if (peer && roomState[peer.id]) roomState[peer.id].sos = isActive;
        broadcastRoomState();
        if (isActive) {
            Object.values(clientDataConnections).forEach(conn => {
                if (conn.open) conn.send({ type: 'sos-alert' });
            });
        }
    } else if (hostDataConnection?.open) {
        hostDataConnection.send(data);
    }
}

// ─────────────────────────────────────────────
// UTILS & CLEANUP
// ─────────────────────────────────────────────

function broadcastRoomState() {
    if (!isHost) return;
    Object.values(clientDataConnections).forEach(conn => {
        if (conn.open) conn.send({ type: 'update-state', roomState });
    });
}

function broadcastMicStatus(isActive) {
    if (!peer || !roomState[peer.id]) return;
    isSpeaking = isActive;
    
    roomState[peer.id].isTalking = isActive;
    updateUIList();

    if (isHost) {
        broadcastRoomState();
    } else if (hostDataConnection && hostDataConnection.open) {
        hostDataConnection.send({ type: 'mic-status', isActive });
    }
}

function updateUIList() {
    if (window.ClearWayUI?.renderMembers) {
        window.ClearWayUI.renderMembers(roomState, peer ? peer.id : null);
    }
}

// ─────────────────────────────────────────────
// EXPORTED API
// ─────────────────────────────────────────────
window.ClearWayWebRTC = {
    joinVoiceRoom,
    leaveVoiceRoom,
    broadcastMicStatus,
    sendSOS
};

function attemptReconnect() {
    if (isLeaving) return;
    updateConnectionStatus('🟡 สัญญาณหลุด กำลังเชื่อมใหม่...', 'muted');
    setTimeout(() => {
        if (!isLeaving) joinVoiceRoom(currentRoomId, myNickname, myStream);
    }, RTC_CONFIG.RECONNECT_DELAY_MS);
}

function leaveVoiceRoom() {
    isLeaving = true;
    if (isHost) {
        Object.values(clientDataConnections).forEach(conn => {
            if (conn.open) conn.send({ type: 'leave', peerId: peer.id });
        });
    } else if (hostDataConnection && hostDataConnection.open) {
        hostDataConnection.send({ type: 'leave' });
    }

    if (statsInterval) clearInterval(statsInterval);
    
    setTimeout(() => {
        if (peer) peer.destroy();
        peer = null;
        roomState = {};
        clientDataConnections = {};
        hostDataConnection = null;
        Object.keys(connectedPeers).forEach(id => _cleanupPeerAudio(id));
        connectedPeers = {};
        updateUIList();
    }, 200);
}

function updateConnectionStatus(text, stateClass) {
    const badge = document.getElementById('connectionStatusBadge');
    const statusText = document.getElementById('connectionStatusText');
    if (badge) badge.className = `status-badge ${stateClass}`;
    if (statusText) statusText.innerText = text;
}

window.ClearWayWebRTC = { joinVoiceRoom, leaveVoiceRoom, broadcastMicStatus, sendSOS };
