// asset/js/webRTC.js - เวอร์ชันแก้ไขสำหรับ Mobile Support

// ─────────────────────────────────────────────
// CONFIG - เพิ่ม TURN Servers สำหรับ Mobile
// ─────────────────────────────────────────────
const RTC_CONFIG = {
    BITRATE_SPEAKING:    32000,
    BITRATE_SILENT:      16000,
    BITRATE_UNSTABLE:    20000,
    BITRATE_STEP:        2000,
    BITRATE_INTERVAL_MS: 500,
    RECONNECT_DELAY_MS:  3000,
    MAX_HOST_CLAIM_TRIES: 3,  // ← ใหม่: ลอง claim host สูงสุด 3 ครั้ง
    
    // PeerServer - Self-host หรือ custom (แทน public peerjs.com)
    PEERSERVER: {
        host: window.location.hostname === 'localhost' ? '0.peerjs.com' : 'peerjs.yourdomain.com',  // ← เปลี่ยนเป็น server ของคุณ
        port: 443,
        path: '/peerjs',
        secure: true,  // HTTPS สำคัญสำหรับ mobile!
        config: {
            iceServers: [
                // Google STUN (เดิม)
                { urls: 'stun:stun.l.google.com:19302' },
                { urls: 'stun:stun1.l.google.com:19302' },
                
                // TURN สำหรับ Mobile/NAT/Firewall (Metered.ca free tier)
                { 
                    urls: 'turn:global.relay.metered.ca:80',
                    username: '87a3a559dd4cff69c4e5eae5',
                    credential: 'O2WMwfz+PFmqp4kV'
                },
                { 
                    urls: 'turn:global.relay.metered.ca:80?transport=tcp',
                    username: '87a3a559dd4cff69c4e5eae5',
                    credential: 'O2WMwfz+PFmqp4kV'
                },
                { 
                    urls: 'turn:global.relay.metered.ca:443',
                    username: '87a3a559dd4cff69c4e5eae5',
                    credential: 'O2WMwfz+PFmqp4kV'
                },
                { 
                    urls: 'turns:global.relay.metered.ca:443?transport=tcp',
                    username: '87a3a559dd4cff69c4e5eae5',
                    credential: 'O2WMwfz+PFmqp4kV'
                }
            ],
            iceTransportPolicy: 'all',  // relay+host
            bundlePolicy: 'max-bundle'
        }
    }
};

// ─────────────────────────────────────────────
// STATE - เพิ่มตัวแปรใหม่
// ─────────────────────────────────────────────
let peer = null;
let connectedPeers = {};
let myStream = null;
let myNickname = '';
let isHost = false;
let roomHostId = '';
let currentRoomId = '';
let isLeaving = false;
let reconnectTimer = null;
let hostDataConnection = null;
let clientDataConnections = {};
let roomState = {};

// Bitrate + Stats (เดิม)
let isSpeaking = false;
let currentBitrate = RTC_CONFIG.BITRATE_SILENT;
let targetBitrate = RTC_CONFIG.BITRATE_SILENT;
let bitrateInterval = null;
let statsInterval = null;
let lastBytesSent = 0;
let lastStatsTime = 0;

// ← ใหม่: Host claim retry
let hostClaimAttempts = 0;

// ─────────────────────────────────────────────
// AUDIO + BEEP (เดิม)
// ─────────────────────────────────────────────
const remoteAudioContainer = document.createElement('div');
remoteAudioContainer.id = 'remoteAudios';
remoteAudioContainer.style.display = 'none';
document.body.appendChild(remoteAudioContainer);

function playBeep(type) {
    try {
        const ctx = new (window.AudioContext || window.webkitAudioContext)();
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.connect(gain);
        gain.connect(ctx.destination);
        gain.gain.setValueAtTime(0.3, ctx.currentTime);
        gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.4);
        if (type === 'join') {
            osc.frequency.setValueAtTime(660, ctx.currentTime);
            osc.frequency.setValueAtTime(880, ctx.currentTime + 0.15);
        } else {
            osc.frequency.setValueAtTime(880, ctx.currentTime);
            osc.frequency.setValueAtTime(440, ctx.currentTime + 0.15);
        }
        osc.start(ctx.currentTime);
        osc.stop(ctx.currentTime + 0.4);
        osc.onended = () => ctx.close();
    } catch(e) {}
}

// ─────────────────────────────────────────────
// BITRATE + STATS (เดิม - ไม่เปลี่ยน)
// ─────────────────────────────────────────────
function onSpeakingChanged(speaking) {
    isSpeaking = speaking;
    targetBitrate = speaking ? RTC_CONFIG.BITRATE_SPEAKING : RTC_CONFIG.BITRATE_SILENT;
}

async function applyBitrateStep() {
    const firstCall = Object.values(connectedPeers)[0];
    const pc = firstCall?.peerConnection;
    let unstable = false;
    if (pc) {
        try {
            const stats = await pc.getStats();
            for (const r of stats.values()) {
                if (r.type === 'candidate-pair' && r.state === 'succeeded' && r.currentRoundTripTime > 0.3) {
                    unstable = true;
                    break;
                }
            }
        } catch(e) {}
    }
    targetBitrate = unstable
        ? Math.min(isSpeaking ? RTC_CONFIG.BITRATE_SPEAKING : RTC_CONFIG.BITRATE_SILENT, RTC_CONFIG.BITRATE_UNSTABLE)
        : (isSpeaking ? RTC_CONFIG.BITRATE_SPEAKING : RTC_CONFIG.BITRATE_SILENT);

    if (currentBitrate === targetBitrate) return;
    currentBitrate = currentBitrate < targetBitrate
        ? Math.min(currentBitrate + RTC_CONFIG.BITRATE_STEP, targetBitrate)
        : Math.max(currentBitrate - RTC_CONFIG.BITRATE_STEP, targetBitrate);

    for (const call of Object.values(connectedPeers)) {
        try {
            const senders = call.peerConnection?.getSenders().filter(s => s.track?.kind === 'audio') ?? [];
            for (const sender of senders) {
                const params = sender.getParameters();
                if (!params.encodings?.length) params.encodings = [{}];
                params.encodings[0].maxBitrate = currentBitrate;
                await sender.setParameters(params);
            }
        } catch(e) {}
    }
}

function startBitrateControl() {
    if (bitrateInterval) return;
    bitrateInterval = setInterval(applyBitrateStep, RTC_CONFIG.BITRATE_INTERVAL_MS);
}

function stopBitrateControl() {
    if (bitrateInterval) { clearInterval(bitrateInterval); bitrateInterval = null; }
    currentBitrate = RTC_CONFIG.BITRATE_SILENT;
    targetBitrate = RTC_CONFIG.BITRATE_SILENT;
    isSpeaking = false;
}

// Network Stats (เดิม)
function startNetworkStats() { /* ... เดิม ... */ }
function stopNetworkStats() { /* ... เดิม ... */ }

// ─────────────────────────────────────────────
// CALL + PEER LEAVE (เดิม)
// ─────────────────────────────────────────────
function handleActiveCall(call) {
    connectedPeers[call.peer] = call;
    call.on('stream', (remoteStream) => {
        let audio = document.getElementById(`audio-${call.peer}`);
        if (!audio) {
            audio = document.createElement('audio');
            audio.id = `audio-${call.peer}`;
            audio.autoplay = true;
            audio.playsInline = true;  // ← สำคัญสำหรับ iOS
            remoteAudioContainer.appendChild(audio);
        }
        if (audio.srcObject !== remoteStream) audio.srcObject = remoteStream;
    });
    call.on('error', (err) => console.error('Call error:', err));
}

function handlePeerLeave(peerId) {
    if (clientDataConnections[peerId]) delete clientDataConnections[peerId];
    if (connectedPeers[peerId]) {
        connectedPeers[peerId].close();
        delete connectedPeers[peerId];
    }
    const audio = document.getElementById(`audio-${peerId}`);
    if (audio) audio.remove();
    if (roomState[peerId]) { delete roomState[peerId]; playBeep('leave'); }
    broadcastRoomState();
    updateUIList();
}

// ─────────────────────────────────────────────
// RECONNECT (เดิม)
// ─────────────────────────────────────────────
function attemptReconnect() {
    if (isLeaving || reconnectTimer) return;
    updateConnectionStatus('🟡 กำลังเชื่อมต่อใหม่...', 'muted');
    reconnectTimer = setTimeout(() => {
        reconnectTimer = null;
        if (isLeaving) return;
        stopBitrateControl();
        stopNetworkStats();
        if (peer) { peer.destroy(); peer = null; }
        roomState = {};
        clientDataConnections = {};
        hostDataConnection = null;
        connectedPeers = {};
        remoteAudioContainer.innerHTML = '';
        joinVoiceRoom(currentRoomId, myNickname, myStream);
    }, RTC_CONFIG.RECONNECT_DELAY_MS);
}

// ─────────────────────────────────────────────
// JOIN VOICE ROOM - แก้ไขหลักทั้งหมด!
// ─────────────────────────────────────────────
function joinVoiceRoom(roomId, nickname, localStream) {
    myStream = localStream;
    myNickname = nickname;
    currentRoomId = roomId;
    roomHostId = `clearway-room-${roomId}`;
    isLeaving = false;
    isHost = false;
    hostClaimAttempts = 0;  // ← Reset

    updateConnectionStatus('🟡 กำลังเชื่อมต่อเซิร์ฟเวอร์...', 'muted');
    console.log('🚀 Joining room:', roomId, 'UserAgent:', navigator.userAgent);  // Debug

    // ฟังก์ชัน helper สร้าง Peer
    function createPeer(id = null, isHostAttempt = false) {
        const peerConfig = {
            debug: 2,  // ← เพิ่ม log สำหรับ debug
            config: RTC_CONFIG.PEERSERVER.config,
            ...(id ? { id } : {}),
            host: RTC_CONFIG.PEERSERVER.host,
            port: RTC_CONFIG.PEERSERVER.port,
            path: RTC_CONFIG.PEERSERVER.path,
            secure: RTC_CONFIG.PEERSERVER.secure
        };

        console.log('🔧 Creating Peer:', id || 'random', peerConfig);
        return new Peer(id, peerConfig);
    }

    // ลองเป็น Host (retry 3 ครั้ง)
    function tryClaimHost() {
        hostClaimAttempts++;
        console.log(`👑 Host claim attempt ${hostClaimAttempts}/${RTC_CONFIG.MAX_HOST_CLAIM_TRIES}`);
        
        peer = createPeer(roomHostId, true);

        peer.on('open', (id) => {
            console.log('🟢 SUCCESS: Became Host!', id);
            isHost = true;
            roomState[id] = { nickname: myNickname, role: 'Host', isTalking: false };
            updateUIList();
            updateConnectionStatus('🟢 สร้างห้องแล้ว (หัวหน้าทริป)', 'active');
            startBitrateControl();
            startNetworkStats();

            // Host handlers (เดิม)
            peer.on('connection', (conn) => {
                clientDataConnections[conn.peer] = conn;
                conn.on('open', () => {
                    const guestName = conn.metadata?.nickname || 'Unknown';
                    roomState[conn.peer] = { nickname: guestName, role: 'Member', isTalking: false };
                    const audioPeers = Object.keys(roomState).filter(p => p !== conn.peer && p !== id);
                    conn.send({ type: 'welcome', roomState: roomState, peersToCall: audioPeers });
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
                    }
                });
                conn.on('close', () => handlePeerLeave(conn.peer));
            });

            peer.on('call', (call) => {
                call.answer(myStream);
                handleActiveCall(call);
            });
        });

        peer.on('disconnected', () => {
            if (!isLeaving) {
                console.log('🔌 Peer disconnected, reconnecting...');
                peer.reconnect();
            }
        });

        // ← สำคัญ: Handle unavailable-id + retry logic
        peer.on('error', (err) => {
            console.error('❌ Peer ERROR:', err.type, err.message);
            
            if (err.type === 'unavailable-id' && hostClaimAttempts < RTC_CONFIG.MAX_HOST_CLAIM_TRIES) {
                console.log('🔄 Host ID taken, retrying...');
                if (peer) peer.destroy();
                setTimeout(tryClaimHost, 1000 * hostClaimAttempts);  // Backoff
                return;
            } else if (err.type === 'unavailable-id') {
                console.log('🏠 Host taken, fallback to Guest mode');
                fallbackToGuest();
                return;
            }

            // Other errors
            updateConnectionStatus(`🔴 Error: ${err.type}`, 'disconnected');
            if (!isLeaving) setTimeout(attemptReconnect, 2000);
        });
    }

    // Fallback เป็น Guest (ปรับปรุง)
    function fallbackToGuest() {
        isHost = false;
        if (peer) { peer.destroy(); peer = null; }

        peer = createPeer();  // Random ID

        peer.on('open', (guestId) => {
            console.log('👤 Guest ID:', guestId);
            updateConnectionStatus('🟡 กำลังเข้าห้อง...', 'muted');
            startBitrateControl();

            // DataChannel ก่อนเสมอ (แก้ race condition)
            hostDataConnection = peer.connect(roomHostId, {
                metadata: { nickname: myNickname },
                reliable: true  // ← สำคัญสำหรับ mobile
            });

            hostDataConnection.on('open', () => {
                console.log('📡 DataChannel to Host OK');
                updateConnectionStatus('🟢 เข้าร่วมทริปแล้ว', 'active');
                startNetworkStats();
                const call = peer.call(roomHostId, myStream);
                handleActiveCall(call);
            });

            hostDataConnection.on('open', () => { /* ... */ });
            hostDataConnection.on('data', (data) => { /* เดิม */ });
            hostDataConnection.on('close', () => {
                if (!isLeaving) attemptReconnect();
            });
            hostDataConnection.on('error', (err) => {
                console.error('DataChannel ERROR:', err);
                updateConnectionStatus('🔴 DataChannel fail', 'disconnected');
            });
        });

        peer.on('call', (call) => {
            call.answer(myStream);
            handleActiveCall(call);
        });

        peer.on('disconnected', () => {
            if (!isLeaving) {
                updateConnectionStatus('🟡 สัญญาณหลุด กำลังเชื่อมใหม่...', 'muted');
                peer.reconnect();
            }
        });

        peer.on('error', (err) => {
            console.error('Guest peer error:', err);
            if (!isLeaving && err.type !== 'peer-unavailable') attemptReconnect();
        });
    }

    // Start!
    tryClaimHost();
}

// ─────────────────────────────────────────────
// BROADCAST + LEAVE + UI (เดิม)
// ─────────────────────────────────────────────
function broadcastRoomState() {
    if (!isHost) return;
    Object.values(clientDataConnections).forEach(conn => {
        if (conn.open) conn.send({ type: 'update-state', roomState });
    });
}

function broadcastMicStatus(isActive) {
    if (!peer || !roomState[peer.id]) return;
    onSpeakingChanged(isActive);
    roomState[peer.id].isTalking = isActive;
    updateUIList();
    if (isHost) {
        broadcastRoomState();
    } else if (hostDataConnection?.open) {
        hostDataConnection.send({ type: 'mic-status', isActive });
    }
}

function leaveVoiceRoom() {
    isLeaving = true;
    stopBitrateControl();
    stopNetworkStats();
    if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }

    if (isHost) {
        Object.values(clientDataConnections).forEach(conn => {
            if (conn.open) conn.send({ type: 'leave', peerId: peer?.id });
        });
    } else if (hostDataConnection?.open) {
        hostDataConnection.send({ type: 'leave' });
    }

    setTimeout(() => {
        if (peer) { peer.destroy(); peer = null; }
        isHost = false;
        roomState = {};
        clientDataConnections = {};
        hostDataConnection = null;
        connectedPeers = {};
        remoteAudioContainer.innerHTML = '';
        updateUIList();
    }, 300);
}

function updateUIList() {
    if (window.ClearWayUI?.renderMembers) {
        window.ClearWayUI.renderMembers(roomState, peer?.id ?? null);
    }
}

function updateConnectionStatus(text, stateClass) {
    const badge = document.getElementById('connectionStatusBadge');
    const span = document.getElementById('connectionStatusText');
    if (badge) badge.className = `status-badge ${stateClass}`;
    if (span) span.innerText = text;
}

// ─────────────────────────────────────────────
// EXPORTS
// ─────────────────────────────────────────────
window.ClearWayWebRTC = { joinVoiceRoom, leaveVoiceRoom, broadcastMicStatus };
