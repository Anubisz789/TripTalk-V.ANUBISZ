// asset/js/webRTC.js
// ปรับปรุงระบบ WebRTC + Dynamic Bitrate Control สำหรับการขี่มอเตอร์ไซค์

// ─────────────────────────────────────────────
// CONFIG
// ─────────────────────────────────────────────
const RTC_CONFIG = {
    BITRATE_SPEAKING:     32000,  // bps ตอนพูด
    BITRATE_SILENT:       16000,  // bps ตอนเงียบ
    BITRATE_UNSTABLE:     20000,  // bps ตอนเน็ตไม่เสถียร
    BITRATE_STEP:         2000,   // bps ขยับทีละนี้ (smoothing)
    BITRATE_INTERVAL_MS:  500,    // ตรวจสอบ bitrate ทุกกี่ ms
    RECONNECT_DELAY_MS:   3000,   // รอก่อน reconnect
    ICE_SERVERS: [
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:stun1.l.google.com:19302' },
    ],
};

// ─────────────────────────────────────────────
// STATE
// ─────────────────────────────────────────────
let peer;
let connectedPeers       = {};
let myStream;
let myNickname           = '';
let isHost               = false;
let roomHostId           = '';
let currentRoomId        = '';
let isLeaving            = false;
let reconnectTimer       = null;
let hostDataConnection   = null;
let clientDataConnections= {};
let roomState            = {};

// Bitrate control
let isSpeaking           = false;
let currentBitrate       = RTC_CONFIG.BITRATE_SILENT;
let targetBitrate        = RTC_CONFIG.BITRATE_SILENT;
let bitrateInterval      = null;

// ─────────────────────────────────────────────
// AUDIO CONTAINER
// ─────────────────────────────────────────────
const remoteAudioContainer = document.createElement('div');
remoteAudioContainer.id = 'remoteAudios';
remoteAudioContainer.style.display = 'none';
document.body.appendChild(remoteAudioContainer);

// ─────────────────────────────────────────────
// NOTIFICATION BEEP (Web Audio — ไม่ต้องโหลดไฟล์)
// ─────────────────────────────────────────────
function playBeep(type) {
    try {
        const ctx = new (window.AudioContext || window.webkitAudioContext)();
        const osc  = ctx.createOscillator();
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
    } catch(e) { /* browser บางตัวอาจบล็อก */ }
}

// ─────────────────────────────────────────────
// DYNAMIC BITRATE CONTROL
// ─────────────────────────────────────────────

// เรียกจาก VAD เมื่อสถานะการพูดเปลี่ยน
function onSpeakingChanged(speaking) {
    isSpeaking    = speaking;
    targetBitrate = speaking ? RTC_CONFIG.BITRATE_SPEAKING : RTC_CONFIG.BITRATE_SILENT;
}

// ตรวจสอบสภาพเน็ตจาก RTCPeerConnection stats
async function checkNetworkQuality(peerConnection) {
    if (!peerConnection) return false;
    try {
        const stats = await peerConnection.getStats();
        for (const report of stats.values()) {
            if (report.type === 'candidate-pair' && report.state === 'succeeded') {
                // ถ้า RTT สูง ถือว่าเน็ตไม่เสถียร
                if (report.currentRoundTripTime && report.currentRoundTripTime > 0.3) {
                    return true; // unstable
                }
            }
        }
    } catch(e) { /* getStats อาจ fail ได้ */ }
    return false;
}

// ขยับ bitrate ทีละ STEP (smoothing) แล้ว apply ไปยังทุก sender
async function applyBitrateStep() {
    // ตรวจ network quality จาก peer connection ตัวแรกที่มี
    const firstCall = Object.values(connectedPeers)[0];
    const pc = firstCall?.peerConnection;
    const unstable = await checkNetworkQuality(pc);

    if (unstable) {
        targetBitrate = RTC_CONFIG.BITRATE_UNSTABLE;
    }

    // Smooth: ขยับทีละ STEP ไม่กระโดด
    if (currentBitrate < targetBitrate) {
        currentBitrate = Math.min(currentBitrate + RTC_CONFIG.BITRATE_STEP, targetBitrate);
    } else if (currentBitrate > targetBitrate) {
        currentBitrate = Math.max(currentBitrate - RTC_CONFIG.BITRATE_STEP, targetBitrate);
    } else {
        return; // ไม่มีอะไรเปลี่ยน ไม่ต้อง apply
    }

    // Apply ไปยังทุก RTCRtpSender ที่ส่งอยู่
    for (const call of Object.values(connectedPeers)) {
        try {
            const pc = call.peerConnection;
            if (!pc) continue;
            const senders = pc.getSenders().filter(s => s.track?.kind === 'audio');
            for (const sender of senders) {
                const params = sender.getParameters();
                if (!params.encodings || params.encodings.length === 0) {
                    params.encodings = [{}];
                }
                params.encodings[0].maxBitrate = currentBitrate;
                await sender.setParameters(params);
            }
        } catch(e) { /* setParameters อาจ fail บน browser เก่า */ }
    }
}

function startBitrateControl() {
    if (bitrateInterval) return;
    bitrateInterval = setInterval(applyBitrateStep, RTC_CONFIG.BITRATE_INTERVAL_MS);
}

function stopBitrateControl() {
    if (bitrateInterval) { clearInterval(bitrateInterval); bitrateInterval = null; }
    currentBitrate = RTC_CONFIG.BITRATE_SILENT;
    targetBitrate  = RTC_CONFIG.BITRATE_SILENT;
}

// ─────────────────────────────────────────────
// JOIN VOICE ROOM
// ─────────────────────────────────────────────
function joinVoiceRoom(roomId, nickname, localStream) {
    myStream      = localStream;
    myNickname    = nickname;
    currentRoomId = roomId;
    roomHostId    = `clearway-room-${roomId}`;
    isLeaving     = false;

    updateConnectionStatus('🟡 กำลังเชื่อมต่อเซิร์ฟเวอร์...', 'muted');

    peer = new Peer(roomHostId, {
        debug: 1,
        config: { iceServers: RTC_CONFIG.ICE_SERVERS }
    });

    // ── กรณี 1: ได้เป็น Host ──
    peer.on('open', (id) => {
        isHost = true;
        roomState[id] = { nickname: myNickname, role: 'Host', isTalking: false };
        updateUIList();
        updateConnectionStatus('🟢 สร้างห้องแล้ว (หัวหน้าทริป)', 'active');
        startBitrateControl();

        peer.on('connection', (conn) => {
            clientDataConnections[conn.peer] = conn;

            conn.on('open', () => {
                const guestName = conn.metadata.nickname || 'Unknown';
                roomState[conn.peer] = { nickname: guestName, role: 'Member', isTalking: false };

                const audioPeers = Object.keys(roomState).filter(p => p !== conn.peer && p !== id);
                conn.send({ type: 'welcome', roomState: roomState, peersToCall: audioPeers });

                broadcastRoomState();
                updateUIList();
                playBeep('join');
            });

            conn.on('data', (data) => {
                if (data.type === 'mic-status') {
                    roomState[conn.peer].isTalking = data.isActive;
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

    // ── กรณี 2: ID ซ้ำ → กลายเป็น Guest ──
    peer.on('error', (err) => {
        if (err.type === 'unavailable-id') {
            isHost = false;
            peer.destroy();
            peer = new Peer({ debug: 1, config: { iceServers: RTC_CONFIG.ICE_SERVERS } });

            peer.on('open', () => {
                updateConnectionStatus('🟡 กำลังเข้าห้อง...', 'muted');
                startBitrateControl();

                // ✅ Data Channel ก่อน แล้วค่อยโทร Audio (แก้ Race Condition)
                hostDataConnection = peer.connect(roomHostId, {
                    metadata: { nickname: myNickname }
                });

                hostDataConnection.on('open', () => {
                    updateConnectionStatus('🟢 เข้าร่วมทริปแล้ว', 'active');
                    const call = peer.call(roomHostId, myStream);
                    handleActiveCall(call);
                });

                hostDataConnection.on('data', (data) => {
                    if (data.type === 'welcome') {
                        roomState = data.roomState;
                        updateUIList();
                        data.peersToCall.forEach(otherPeerId => {
                            const call = peer.call(otherPeerId, myStream);
                            handleActiveCall(call);
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
                    }
                });

                hostDataConnection.on('close', () => {
                    if (!isLeaving) attemptReconnect();
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

        } else {
            console.error('PeerJS error:', err);
            updateConnectionStatus(`🔴 เชื่อมต่อไม่ได้ (${err.type})`, 'disconnected');
            if (!isLeaving && err.type !== 'peer-unavailable') attemptReconnect();
        }
    });

    peer.on('disconnected', () => {
        if (!isLeaving) {
            updateConnectionStatus('🟡 สัญญาณหลุด กำลังเชื่อมใหม่...', 'muted');
            peer.reconnect();
        }
    });
}

// ─────────────────────────────────────────────
// CALL HANDLING
// ─────────────────────────────────────────────
function handleActiveCall(call) {
    connectedPeers[call.peer] = call;

    call.on('stream', (remoteStream) => {
        // ป้องกัน duplicate audio element
        let audio = document.getElementById(`audio-${call.peer}`);
        if (!audio) {
            audio = document.createElement('audio');
            audio.id       = `audio-${call.peer}`;
            audio.autoplay = true;
            remoteAudioContainer.appendChild(audio);
        }
        // Re-attach stream ถูกต้องแม้หลัง reconnect
        if (audio.srcObject !== remoteStream) {
            audio.srcObject = remoteStream;
        }
    });

    call.on('close', () => {
        // call ถูกปิด — ถ้าไม่ใช่ตอนออกห้อง ให้ reconnect
        if (!isLeaving) attemptReconnect();
    });
}

// ─────────────────────────────────────────────
// PEER LEAVE
// ─────────────────────────────────────────────
function handlePeerLeave(peerId) {
    if (clientDataConnections[peerId]) delete clientDataConnections[peerId];
    if (connectedPeers[peerId]) {
        connectedPeers[peerId].close();
        delete connectedPeers[peerId];
    }
    const audio = document.getElementById(`audio-${peerId}`);
    if (audio) audio.remove();

    if (roomState[peerId]) {
        delete roomState[peerId];
        playBeep('leave');
    }
    broadcastRoomState();
    updateUIList();
}

// ─────────────────────────────────────────────
// RECONNECT
// ─────────────────────────────────────────────
function attemptReconnect() {
    if (isLeaving || reconnectTimer) return;
    updateConnectionStatus('🟡 กำลังเชื่อมต่อใหม่...', 'muted');
    reconnectTimer = setTimeout(() => {
        reconnectTimer = null;
        if (isLeaving) return;
        stopBitrateControl();
        if (peer) { peer.destroy(); peer = null; }
        roomState            = {};
        clientDataConnections= {};
        hostDataConnection   = null;
        connectedPeers       = {};
        remoteAudioContainer.innerHTML = '';
        // myStream ยังคงใช้ได้ — ไม่ต้องขอ mic ใหม่
        joinVoiceRoom(currentRoomId, myNickname, myStream);
    }, RTC_CONFIG.RECONNECT_DELAY_MS);
}

// ─────────────────────────────────────────────
// BROADCAST
// ─────────────────────────────────────────────
function broadcastRoomState() {
    if (!isHost) return;
    Object.values(clientDataConnections).forEach(conn => {
        if (conn.open) conn.send({ type: 'update-state', roomState });
    });
}

// เรียกจาก vad.js เมื่อสถานะไมค์เปลี่ยน
function broadcastMicStatus(isActive) {
    if (!peer || !roomState[peer.id]) return;

    onSpeakingChanged(isActive); // อัปเดต bitrate target

    roomState[peer.id].isTalking = isActive;
    updateUIList();

    if (isHost) {
        broadcastRoomState();
    } else if (hostDataConnection?.open) {
        hostDataConnection.send({ type: 'mic-status', isActive });
    }
}

// ─────────────────────────────────────────────
// LEAVE
// ─────────────────────────────────────────────
function leaveVoiceRoom() {
    isLeaving = true;
    stopBitrateControl();
    if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }

    if (isHost) {
        Object.values(clientDataConnections).forEach(conn => {
            if (conn.open) conn.send({ type: 'leave', peerId: peer.id });
        });
    } else if (hostDataConnection?.open) {
        hostDataConnection.send({ type: 'leave' });
    }

    setTimeout(() => {
        if (peer) peer.destroy();
        peer                 = null;
        roomState            = {};
        clientDataConnections= {};
        hostDataConnection   = null;
        connectedPeers       = {};
        remoteAudioContainer.innerHTML = '';
        updateUIList();
    }, 100);
}

// ─────────────────────────────────────────────
// UI HELPERS
// ─────────────────────────────────────────────
function updateUIList() {
    if (window.ClearWayUI?.renderMembers) {
        window.ClearWayUI.renderMembers(roomState, peer?.id ?? null);
    }
}

function updateConnectionStatus(text, stateClass) {
    const badge      = document.getElementById('connectionStatusBadge');
    const statusText = document.getElementById('connectionStatusText');
    badge.className  = `status-badge ${stateClass}`;
    statusText.innerText = text;
}

// ─────────────────────────────────────────────
// EXPORTS
// ─────────────────────────────────────────────
window.ClearWayWebRTC = { joinVoiceRoom, leaveVoiceRoom, broadcastMicStatus };
