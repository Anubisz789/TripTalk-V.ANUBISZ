// asset/js/webRTC.js

// ─────────────────────────────────────────────
// CONFIG
// ─────────────────────────────────────────────
const RTC_CONFIG = {
    BITRATE_SPEAKING:    28000,
    BITRATE_SILENT:      8000,
    BITRATE_UNSTABLE:    16000,
    BITRATE_STEP:        4000,
    STATS_INTERVAL_MS:   2000,
    RECONNECT_DELAY_MS:  3000,
    CONN_TIMEOUT_MS:     10000,
    ICE_SERVERS: [
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:stun1.l.google.com:19302' },
    ],
};

// ─────────────────────────────────────────────
// STATE
// ─────────────────────────────────────────────
let peer                 = null;
let connectedPeers       = {};
let myStream             = null;
let myNickname           = '';
let isHost               = false;
let roomHostId           = '';
let currentRoomId        = '';
let isLeaving            = false;
let reconnectTimer       = null;
let connTimeoutTimer     = null;
let hostDataConnection   = null;
let clientDataConnections= {};
let roomState            = {};

// [ADDED] wasHost — track role ที่แท้จริง ป้องกัน Guest กลายเป็น Host ตอน reconnect
let wasHost              = false;

// Bitrate + Stats
let isSpeaking           = false;
let currentBitrate       = RTC_CONFIG.BITRATE_SILENT;
let targetBitrate        = RTC_CONFIG.BITRATE_SILENT;
let statsInterval        = null;
let lastTotalBytes       = 0;
let lastStatsTime        = 0;

// [ADDED] localStorage keys
const LS_ROOM_ID  = 'triptalk_room_id';
const LS_NICKNAME = 'triptalk_nickname';
const LS_WAS_HOST = 'triptalk_was_host';

// [ADDED] บันทึก session — เรียกตอน join สำเร็จ
function _saveSession(roomId, nickname, asHost) {
    try {
        localStorage.setItem(LS_ROOM_ID,  roomId);
        localStorage.setItem(LS_NICKNAME, nickname);
        localStorage.setItem(LS_WAS_HOST, asHost ? '1' : '0');
    } catch(e) {}
}

// [ADDED] ล้าง session — เรียกเฉพาะตอน user ออกเอง ไม่เรียกตอน reconnect
function _clearSession() {
    try {
        localStorage.removeItem(LS_ROOM_ID);
        localStorage.removeItem(LS_NICKNAME);
        localStorage.removeItem(LS_WAS_HOST);
    } catch(e) {}
}

// ─────────────────────────────────────────────
// AUDIO CONTAINER
// ─────────────────────────────────────────────
const remoteAudioContainer = document.createElement('div');
remoteAudioContainer.id = 'remoteAudios';
remoteAudioContainer.style.display = 'none';
document.body.appendChild(remoteAudioContainer);

// ─────────────────────────────────────────────
// BEEP
// ─────────────────────────────────────────────
function playBeep(type) {
    try {
        const ctx  = new (window.AudioContext || window.webkitAudioContext)();
        const osc  = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.connect(gain);
        gain.connect(ctx.destination);
        gain.gain.setValueAtTime(0.25, ctx.currentTime);
        gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.35);
        osc.frequency.setValueAtTime(type === 'join' ? 660 : 880, ctx.currentTime);
        osc.frequency.setValueAtTime(type === 'join' ? 880 : 440, ctx.currentTime + 0.12);
        osc.start(ctx.currentTime);
        osc.stop(ctx.currentTime + 0.35);
        osc.onended = () => ctx.close();
    } catch(e) {}
}

// ─────────────────────────────────────────────
// STATS LOOP (ไม่แตะ audio/bitrate logic)
// ─────────────────────────────────────────────
function startStatsLoop() {
    if (statsInterval) return;
    const panel = document.getElementById('networkStatusPanel');
    if (panel) panel.style.display = 'flex';
    lastTotalBytes = 0;
    lastStatsTime  = 0;

    statsInterval = setInterval(async () => {
        const peers = Object.values(connectedPeers);
        if (peers.length === 0) { _updateStatsUI(null, null, 0); return; }

        const now      = Date.now();
        let ping       = null;
        let totalBytes = 0;
        let packetLoss = 0;
        let rtt        = 0;

        for (const call of peers) {
            const pc = call.peerConnection;
            if (!pc) continue;
            try {
                const stats = await pc.getStats();
                stats.forEach(r => {
                    if (r.type === 'candidate-pair' && r.state === 'succeeded') {
                        if (r.currentRoundTripTime != null && ping == null) {
                            ping = Math.round(r.currentRoundTripTime * 1000);
                            rtt  = r.currentRoundTripTime;
                        }
                    }
                    if (r.type === 'outbound-rtp' && r.kind === 'audio') totalBytes += r.bytesSent ?? 0;
                    if (r.type === 'inbound-rtp'  && r.kind === 'audio') {
                        totalBytes += r.bytesReceived ?? 0;
                        const total = (r.packetsLost ?? 0) + (r.packetsReceived ?? 0);
                        if (total > 0) packetLoss = (r.packetsLost / total) * 100;
                    }
                });
            } catch(e) {}
        }

        let kbps = null;
        if (lastStatsTime > 0) {
            const timeDiff = (now - lastStatsTime) / 1000;
            kbps = timeDiff > 0 ? Math.round(((totalBytes - lastTotalBytes) * 8) / timeDiff / 1000) : null;
        }
        lastTotalBytes = totalBytes;
        lastStatsTime  = now;

        const unstable = rtt > 0.3;
        targetBitrate  = unstable ? RTC_CONFIG.BITRATE_UNSTABLE : (isSpeaking ? RTC_CONFIG.BITRATE_SPEAKING : RTC_CONFIG.BITRATE_SILENT);

        if (currentBitrate !== targetBitrate) {
            currentBitrate = currentBitrate < targetBitrate
                ? Math.min(currentBitrate + RTC_CONFIG.BITRATE_STEP, targetBitrate)
                : Math.max(currentBitrate - RTC_CONFIG.BITRATE_STEP, targetBitrate);
            for (const call of peers) {
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
        _updateStatsUI(ping, kbps, packetLoss);
    }, RTC_CONFIG.STATS_INTERVAL_MS);
}

function stopStatsLoop() {
    if (statsInterval) { clearInterval(statsInterval); statsInterval = null; }
    currentBitrate = RTC_CONFIG.BITRATE_SILENT;
    targetBitrate  = RTC_CONFIG.BITRATE_SILENT;
    isSpeaking     = false;
    lastTotalBytes = 0;
    lastStatsTime  = 0;
    const panel = document.getElementById('networkStatusPanel');
    if (panel) panel.style.display = 'none';
    ['pingValue','bitrateValue','qualityValue'].forEach(id => {
        const el = document.getElementById(id);
        if (el) { el.textContent = '--'; el.className = 'net-value'; }
    });
    const icon = document.getElementById('qualityIcon');
    if (icon) icon.textContent = '🟢';
}

function _updateStatsUI(ping, kbps, packetLoss) {
    const pingEl      = document.getElementById('pingValue');
    const bitrateEl   = document.getElementById('bitrateValue');
    const qualityEl   = document.getElementById('qualityValue');
    const qualityIcon = document.getElementById('qualityIcon');
    if (pingEl) {
        pingEl.textContent = ping != null ? `${ping} ms` : '-- ms';
        pingEl.className   = 'net-value' + (ping == null ? '' : ping < 100 ? ' good' : ping < 250 ? ' warn' : ' bad');
    }
    if (bitrateEl) {
        bitrateEl.textContent = kbps != null ? `${kbps} kbps` : '-- kbps';
        bitrateEl.className   = 'net-value' + (isSpeaking ? ' good' : '');
    }
    const good = ping != null && ping < 150 && packetLoss < 2;
    const warn = ping != null && ping < 300 && packetLoss < 10;
    if (qualityEl) {
        qualityEl.textContent = ping == null ? '--' : good ? 'ดี' : warn ? 'เตือน' : 'แย่';
        qualityEl.className   = 'net-value' + (ping == null ? '' : good ? ' good' : warn ? ' warn' : ' bad');
    }
    if (qualityIcon) qualityIcon.textContent = good ? '🟢' : warn ? '🟡' : '🔴';
}

// ─────────────────────────────────────────────
// CALL HANDLING
// ─────────────────────────────────────────────
function handleActiveCall(call) {
    connectedPeers[call.peer] = call;
    call.on('stream', (remoteStream) => {
        let audio = document.getElementById(`audio-${call.peer}`);
        if (!audio) {
            audio          = document.createElement('audio');
            audio.id       = `audio-${call.peer}`;
            audio.autoplay = true;
            audio.setAttribute('playsinline', '');
            remoteAudioContainer.appendChild(audio);
        }
        if (audio.srcObject !== remoteStream) audio.srcObject = remoteStream;
    });
    call.on('error', (err) => console.error('Call error:', err));
}

// ─────────────────────────────────────────────
// PEER LEAVE
// ─────────────────────────────────────────────
function handlePeerLeave(peerId) {
    if (!peerId) return;
    if (clientDataConnections[peerId]) delete clientDataConnections[peerId];
    if (connectedPeers[peerId]) { connectedPeers[peerId].close(); delete connectedPeers[peerId]; }
    const audio = document.getElementById(`audio-${peerId}`);
    if (audio) { audio.srcObject = null; audio.remove(); }
    if (roomState[peerId]) { delete roomState[peerId]; playBeep('leave'); }
    broadcastRoomState();
    updateUIList();
}

// ─────────────────────────────────────────────
// [ADDED] GUEST PEER SETUP
// Logic การเชื่อมต่อแบบ Guest แยกออกมาเป็นฟังก์ชัน
// ใช้ได้ทั้งตอน joinVoiceRoom (unavailable-id) และตอน _rejoinAsGuest (reconnect)
// ─────────────────────────────────────────────
function _startGuestPeer() {
    if (peer) { peer.destroy(); peer = null; }

    peer = new Peer({
        debug: 0,
        config: { iceServers: RTC_CONFIG.ICE_SERVERS }
    });

    peer.on('open', () => {
        updateConnectionStatus('🟡 กำลังเข้าห้อง...', 'muted');

        // Data Channel ก่อน — แก้ Race Condition
        hostDataConnection = peer.connect(roomHostId, {
            metadata: { nickname: myNickname }
        });

        // Connection timeout
        connTimeoutTimer = setTimeout(() => {
            if (!isLeaving) {
                console.warn('hostDataConnection timeout');
                attemptReconnect();
            }
        }, RTC_CONFIG.CONN_TIMEOUT_MS);

        hostDataConnection.on('open', () => {
            _clearConnTimeout();
            updateConnectionStatus('🟢 เข้าร่วมทริปแล้ว', 'active');
            startStatsLoop();
            // [ADDED] บันทึก session หลัง join สำเร็จในฐานะ Guest
            _saveSession(currentRoomId, myNickname, false);
            const call = peer.call(roomHostId, myStream);
            handleActiveCall(call);
        });

        hostDataConnection.on('data', (data) => {
            if (data.type === 'welcome') {
                roomState = data.roomState;
                updateUIList();
                data.peersToCall.forEach(otherId => {
                    const call = peer.call(otherId, myStream);
                    handleActiveCall(call);
                });
            } else if (data.type === 'update-state') {
                roomState = data.roomState;
                updateUIList();
            } else if (data.type === 'leave') {
                handlePeerLeave(data.peerId);
                if (data.peerId === roomHostId) {
                    alert('หัวหน้าทริปสิ้นสุดการสนทนา');
                    _clearSession();
                    location.reload();
                }
            }
        });

        hostDataConnection.on('close', () => {
            _clearConnTimeout();
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

    peer.on('error', (err) => {
        _clearConnTimeout();
        console.error('Guest peer error:', err);
        updateConnectionStatus(`🔴 เชื่อมต่อไม่ได้ (${err.type})`, 'disconnected');
        if (!isLeaving && err.type !== 'peer-unavailable') attemptReconnect();
    });
}

// ─────────────────────────────────────────────
// RECONNECT
// [FIXED] Guest reconnect ไปห้องเดิมโดยตรง ไม่พยายามขอ Host ID อีก
// ─────────────────────────────────────────────
function attemptReconnect() {
    if (isLeaving || reconnectTimer) return;
    _clearConnTimeout();
    updateConnectionStatus('🟡 กำลังเชื่อมต่อใหม่...', 'muted');

    reconnectTimer = setTimeout(() => {
        reconnectTimer = null;
        if (isLeaving) return;

        stopStatsLoop();
        if (peer) { peer.destroy(); peer = null; }
        roomState             = {};
        clientDataConnections = {};
        hostDataConnection    = null;
        connectedPeers        = {};
        Array.from(remoteAudioContainer.querySelectorAll('audio'))
             .forEach(a => { a.srcObject = null; });
        remoteAudioContainer.innerHTML = '';

        // [FIXED] ถ้าเคยเป็น Guest → ข้ามการขอ Host ID, เข้าห้องแบบ Guest โดยตรง
        // ถ้าเคยเป็น Host → joinVoiceRoom ปกติ (ขอ Host ID ก่อน)
        if (!wasHost) {
            isLeaving = false;
            isHost    = false;
            _startGuestPeer();
        } else {
            joinVoiceRoom(currentRoomId, myNickname, myStream);
        }

    }, RTC_CONFIG.RECONNECT_DELAY_MS);
}

function _clearConnTimeout() {
    if (connTimeoutTimer) { clearTimeout(connTimeoutTimer); connTimeoutTimer = null; }
}

// ─────────────────────────────────────────────
// JOIN VOICE ROOM
// [MODIFIED] ตั้ง wasHost ตาม role จริง + ใช้ _startGuestPeer()
// ─────────────────────────────────────────────
function joinVoiceRoom(roomId, nickname, localStream) {
    myStream      = localStream;
    myNickname    = nickname;
    currentRoomId = roomId;
    roomHostId    = `clearway-room-${roomId}`;
    isLeaving     = false;
    isHost        = false;

    updateConnectionStatus('🟡 กำลังเชื่อมต่อเซิร์ฟเวอร์...', 'muted');

    peer = new Peer(roomHostId, {
        debug: 0,
        config: { iceServers: RTC_CONFIG.ICE_SERVERS }
    });

    // ── กรณี 1: ID ว่าง → ได้เป็น Host ──
    peer.on('open', (id) => {
        isHost  = true;
        wasHost = true; // [ADDED] จำว่าเป็น Host จริงๆ
        roomState[id] = { nickname: myNickname, role: 'Host', isTalking: false };
        updateUIList();
        updateConnectionStatus('🟢 สร้างห้องแล้ว (หัวหน้าทริป)', 'active');
        startStatsLoop();
        _saveSession(currentRoomId, myNickname, true); // [ADDED]

        peer.on('connection', (conn) => {
            clientDataConnections[conn.peer] = conn;

            conn.on('open', () => {
                const guestName      = conn.metadata?.nickname || 'Unknown';
                roomState[conn.peer] = { nickname: guestName, role: 'Member', isTalking: false };
                const audioPeers     = Object.keys(roomState).filter(p => p !== conn.peer && p !== id);
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

    // ── กรณี 2: ID ถูกใช้อยู่ → เป็น Guest ──
    peer.on('error', (err) => {
        if (err.type === 'unavailable-id') {
            isHost  = false;
            wasHost = false; // [ADDED] จำว่าเป็น Guest จริงๆ
            // [MODIFIED] ใช้ _startGuestPeer() แทนโค้ด inline เดิม
            _startGuestPeer();
        } else {
            console.error('PeerJS error:', err);
            updateConnectionStatus(`🔴 เชื่อมต่อไม่ได้ (${err.type})`, 'disconnected');
            if (!isLeaving) attemptReconnect();
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
// BROADCAST
// ─────────────────────────────────────────────
function broadcastRoomState() {
    if (!isHost) return;
    Object.values(clientDataConnections).forEach(conn => {
        if (conn.open) conn.send({ type: 'update-state', roomState });
    });
}

function broadcastMicStatus(isActive) {
    if (!peer || !roomState[peer.id]) return;
    isSpeaking    = isActive;
    targetBitrate = isActive ? RTC_CONFIG.BITRATE_SPEAKING : RTC_CONFIG.BITRATE_SILENT;
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
// [MODIFIED] ล้าง localStorage และ wasHost เฉพาะตอน user ออกเอง
// ─────────────────────────────────────────────
function leaveVoiceRoom() {
    isLeaving = true;
    wasHost   = false; // [ADDED] reset role
    _clearConnTimeout();
    stopStatsLoop();
    if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }

    if (isHost) {
        Object.values(clientDataConnections).forEach(conn => {
            if (conn.open) conn.send({ type: 'leave', peerId: peer?.id });
        });
    } else if (hostDataConnection?.open) {
        hostDataConnection.send({ type: 'leave' });
    }

    _clearSession(); // [ADDED] ล้างเฉพาะตอนออกเอง ไม่ใช่ reconnect

    setTimeout(() => {
        if (peer) { peer.destroy(); peer = null; }
        isHost                = false;
        roomState             = {};
        clientDataConnections = {};
        hostDataConnection    = null;
        connectedPeers        = {};
        Array.from(remoteAudioContainer.querySelectorAll('audio'))
             .forEach(a => { a.srcObject = null; });
        remoteAudioContainer.innerHTML = '';
        updateUIList();
    }, 300);
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
    const badge = document.getElementById('connectionStatusBadge');
    const span  = document.getElementById('connectionStatusText');
    if (badge) badge.className = `status-badge ${stateClass}`;
    if (span)  span.innerText  = text;
}

// ─────────────────────────────────────────────
// EXPORTS
// ─────────────────────────────────────────────
window.ClearWayWebRTC = { joinVoiceRoom, leaveVoiceRoom, broadcastMicStatus };
