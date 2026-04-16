// asset/js/webRTC.js

// ─────────────────────────────────────────────
// CONFIG — ปรับค่าได้ทั้งหมดที่นี่
// ─────────────────────────────────────────────
const RTC_CONFIG = {
    BITRATE_SPEAKING:         28000,  // bps ตอนพูด
    BITRATE_SILENT:           8000,   // bps ตอนเงียบ (VAD ปิด track อยู่แล้ว)
    BITRATE_UNSTABLE:         16000,  // bps ตอนเน็ตไม่เสถียร
    BITRATE_STEP_DOWN:        3000,   // [MODIFIED] แยก step ขึ้น/ลง — ลดช้า
    BITRATE_STEP_UP:          28000,  // [MODIFIED] เพิ่มทันทีตอนพูด (ไม่รอ smooth)
    STATS_INTERVAL_MS:        2000,   // รวม bitrate + stats ไว้ใน loop เดียว
    RECONNECT_DELAY_MS:       3000,
    CONN_TIMEOUT_MS:          10000,  // timeout รอ hostDataConnection.open
    // [MODIFIED] ปรับ threshold ตาม spec: RTT > 150ms หรือ packet loss > 5%
    RTT_UNSTABLE_THRESHOLD:   0.15,   // วินาที (150ms)
    PACKET_LOSS_THRESHOLD:    5,      // % (5%)
    ICE_SERVERS: [
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:stun1.l.google.com:19302' },
    ],
};

// ─────────────────────────────────────────────
// STATE
// ─────────────────────────────────────────────
let peer                  = null;
let connectedPeers        = {};
let myStream              = null;
let myNickname            = '';
let isHost                = false;
let roomHostId            = '';
let currentRoomId         = '';
let isLeaving             = false;
let reconnectTimer        = null;
let connTimeoutTimer      = null;
let hostDataConnection    = null;
let clientDataConnections = {};
let roomState             = {};

// Bitrate + Stats — รวมใน loop เดียว ไม่ getStats ซ้ำ
let isSpeaking            = false;
let currentBitrate        = RTC_CONFIG.BITRATE_SILENT;
let targetBitrate         = RTC_CONFIG.BITRATE_SILENT;
let statsInterval         = null;
let lastTotalBytes        = 0;
let lastStatsTime         = 0;

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
// BITRATE APPLY — ส่ง maxBitrate ไปยังทุก sender
// ─────────────────────────────────────────────
async function _applyBitrate(peers, bitrate) {
    for (const call of peers) {
        try {
            const senders = call.peerConnection
                ?.getSenders()
                .filter(s => s.track?.kind === 'audio') ?? [];
            for (const sender of senders) {
                const params = sender.getParameters();
                if (!params.encodings?.length) params.encodings = [{}];
                // [FIXED] ตรวจก่อนว่าค่าเปลี่ยนจริงๆ — ป้องกัน unnecessary setParameters call
                if (params.encodings[0].maxBitrate !== bitrate) {
                    params.encodings[0].maxBitrate = bitrate;
                    await sender.setParameters(params);
                }
            }
        } catch(e) { /* setParameters อาจ fail บน browser เก่า */ }
    }
}

// ─────────────────────────────────────────────
// STATS LOOP — getStats ครั้งเดียวต่อรอบ
// รวมทั้ง bitrate control + UI update
// ─────────────────────────────────────────────
function startStatsLoop() {
    if (statsInterval) return; // ป้องกัน double interval
    const panel = document.getElementById('networkStatusPanel');
    if (panel) panel.style.display = 'flex';
    lastTotalBytes = 0;
    lastStatsTime  = 0;

    statsInterval = setInterval(async () => {
        const peers = Object.values(connectedPeers);

        if (peers.length === 0) {
            _updateStatsUI(null, null, 0);
            return;
        }

        const now        = Date.now();
        let   ping       = null;
        let   totalBytes = 0;
        let   packetLoss = 0;
        let   rtt        = 0;

        // [FIXED] ใช้ for...of stats.values() แทน stats.forEach
        // stats.forEach ไม่ใช่ standard Array method — อาจไม่ทำงานถูกต้องบนบาง browser
        for (const call of peers) {
            const pc = call.peerConnection;
            if (!pc) continue;
            try {
                const stats = await pc.getStats();
                for (const r of stats.values()) {
                    if (r.type === 'candidate-pair' && r.state === 'succeeded') {
                        if (r.currentRoundTripTime != null && ping == null) {
                            ping = Math.round(r.currentRoundTripTime * 1000);
                            rtt  = r.currentRoundTripTime;
                        }
                    }
                    if (r.type === 'outbound-rtp' && r.kind === 'audio') {
                        totalBytes += r.bytesSent ?? 0;
                    }
                    if (r.type === 'inbound-rtp' && r.kind === 'audio') {
                        totalBytes += r.bytesReceived ?? 0;
                        const total = (r.packetsLost ?? 0) + (r.packetsReceived ?? 0);
                        // [FIXED] หาร total ไม่ใช่ packetsLost อย่างเดียว
                        if (total > 0) packetLoss = Math.round((r.packetsLost / total) * 100);
                    }
                }
            } catch(e) {}
        }

        // คำนวณ kbps จริงจาก byte delta
        let kbps = null;
        if (lastStatsTime > 0) {
            const timeDiff = (now - lastStatsTime) / 1000;
            if (timeDiff > 0) kbps = Math.round(((totalBytes - lastTotalBytes) * 8) / timeDiff / 1000);
        }
        lastTotalBytes = totalBytes;
        lastStatsTime  = now;

        // ── Bitrate control ──
        // [MODIFIED] ใช้ threshold ใหม่: RTT > 150ms หรือ packetLoss > 5%
        const networkUnstable = rtt > RTC_CONFIG.RTT_UNSTABLE_THRESHOLD
                             || packetLoss > RTC_CONFIG.PACKET_LOSS_THRESHOLD;

        // [MODIFIED] target ตาม network state (unstable override speaking)
        const desiredBitrate = networkUnstable
            ? RTC_CONFIG.BITRATE_UNSTABLE
            : (isSpeaking ? RTC_CONFIG.BITRATE_SPEAKING : RTC_CONFIG.BITRATE_SILENT);

        // [MODIFIED] smooth ลงเท่านั้น ขึ้นให้ broadcastMicStatus จัดการแบบทันที
        if (currentBitrate > desiredBitrate) {
            currentBitrate = Math.max(currentBitrate - RTC_CONFIG.BITRATE_STEP_DOWN, desiredBitrate);
            await _applyBitrate(peers, currentBitrate);
        } else if (currentBitrate < desiredBitrate) {
            // ถ้ายังไม่ถึง target (เช่น reconnect loop) ให้ตามทัน
            currentBitrate = desiredBitrate;
            await _applyBitrate(peers, currentBitrate);
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
        pingEl.className   = 'net-value'
            + (ping == null ? '' : ping < 100 ? ' good' : ping < 250 ? ' warn' : ' bad');
    }
    if (bitrateEl) {
        bitrateEl.textContent = kbps != null ? `${kbps} kbps` : '-- kbps';
        bitrateEl.className   = 'net-value' + (isSpeaking ? ' good' : '');
    }
    // [MODIFIED] ใช้ threshold ใหม่สอดคล้องกับ network detection
    const good = ping != null && ping < 150 && packetLoss < RTC_CONFIG.PACKET_LOSS_THRESHOLD;
    const warn = ping != null && ping < 300 && packetLoss < 15;
    if (qualityEl) {
        qualityEl.textContent = ping == null ? '--' : good ? 'ดี' : warn ? 'เตือน' : 'แย่';
        qualityEl.className   = 'net-value'
            + (ping == null ? '' : good ? ' good' : warn ? ' warn' : ' bad');
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
            audio.setAttribute('playsinline', ''); // iOS Safari fix
            remoteAudioContainer.appendChild(audio);
        }
        // [FIXED] re-attach ทุกครั้งแม้ element มีอยู่แล้ว — ป้องกันเสียงหลัง reconnect
        audio.srcObject = remoteStream;
    });

    // [ADDED] cleanup audio element เมื่อ call ปิด — ป้องกัน orphan element
    call.on('close', () => {
        const audio = document.getElementById(`audio-${call.peer}`);
        if (audio) { audio.srcObject = null; audio.remove(); }
        // ไม่ trigger reconnect จากที่นี่ — PeerJS ส่ง close ระหว่าง ICE negotiation ด้วย
    });

    call.on('error', (err) => console.error('Call error:', err));
}

// ─────────────────────────────────────────────
// PEER LEAVE
// ─────────────────────────────────────────────
function handlePeerLeave(peerId) {
    if (!peerId) return;
    if (clientDataConnections[peerId]) delete clientDataConnections[peerId];
    if (connectedPeers[peerId]) {
        connectedPeers[peerId].close();
        delete connectedPeers[peerId];
    }
    // [FIXED] null srcObject ก่อน remove — ป้องกัน memory leak บน mobile
    const audio = document.getElementById(`audio-${peerId}`);
    if (audio) { audio.srcObject = null; audio.remove(); }
    if (roomState[peerId]) { delete roomState[peerId]; playBeep('leave'); }
    broadcastRoomState();
    updateUIList();
}

// ─────────────────────────────────────────────
// RECONNECT
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
        // [FIXED] null srcObject ทุก audio element ก่อน clear — ป้องกัน memory leak
        Array.from(remoteAudioContainer.querySelectorAll('audio'))
             .forEach(a => { a.srcObject = null; });
        remoteAudioContainer.innerHTML = '';
        // myStream ยังใช้ได้ — ไม่ต้องขอ mic ใหม่
        joinVoiceRoom(currentRoomId, myNickname, myStream);
    }, RTC_CONFIG.RECONNECT_DELAY_MS);
}

function _clearConnTimeout() {
    if (connTimeoutTimer) { clearTimeout(connTimeoutTimer); connTimeoutTimer = null; }
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
    isHost        = false;

    updateConnectionStatus('🟡 กำลังเชื่อมต่อเซิร์ฟเวอร์...', 'muted');

    peer = new Peer(roomHostId, {
        debug: 0,
        config: { iceServers: RTC_CONFIG.ICE_SERVERS }
    });

    // ── กรณี 1: ได้เป็น Host (ID ว่าง) ──
    peer.on('open', (id) => {
        isHost        = true;
        roomState[id] = { nickname: myNickname, role: 'Host', isTalking: false };
        updateUIList();
        updateConnectionStatus('🟢 สร้างห้องแล้ว (หัวหน้าทริป)', 'active');
        startStatsLoop();

        peer.on('connection', (conn) => {
            clientDataConnections[conn.peer] = conn;

            conn.on('open', () => {
                const guestName      = conn.metadata?.nickname || 'Unknown';
                roomState[conn.peer] = { nickname: guestName, role: 'Member', isTalking: false };
                // บอก Guest ว่ามีใครอยู่บ้าง และต้องโทรหาใคร
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

    // ── กรณี 2: ID ถูกใช้อยู่ → Guest ──
    peer.on('error', (err) => {
        if (err.type === 'unavailable-id') {
            isHost = false;
            if (peer) { peer.destroy(); peer = null; }

            peer = new Peer({
                debug: 0,
                config: { iceServers: RTC_CONFIG.ICE_SERVERS }
            });

            peer.on('open', () => {
                updateConnectionStatus('🟡 กำลังเข้าห้อง...', 'muted');

                // ✅ Data Channel ก่อน แก้ Race Condition
                hostDataConnection = peer.connect(roomHostId, {
                    metadata: { nickname: myNickname }
                });

                // Connection timeout — ถ้า open ไม่ fire ภายใน CONN_TIMEOUT_MS
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
                    // โทร Audio หลัง Data Channel เปิดแล้วเท่านั้น
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
                            location.reload();
                        }
                    }
                });

                hostDataConnection.on('close', () => {
                    _clearConnTimeout();
                    if (!isLeaving) attemptReconnect();
                });
            });

            // รับสาย Audio จาก Guest คนอื่น
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

            peer.on('error', (err2) => {
                _clearConnTimeout();
                console.error('Guest peer error:', err2);
                updateConnectionStatus(`🔴 เชื่อมต่อไม่ได้ (${err2.type})`, 'disconnected');
                if (!isLeaving && err2.type !== 'peer-unavailable') attemptReconnect();
            });

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

    isSpeaking = isActive;

    // [MODIFIED] เพิ่ม bitrate ทันทีตอนพูด — ไม่รอ smooth loop (2s ช้าเกินไป)
    // ลด bitrate ผ่าน smooth loop ตามปกติ
    if (isActive) {
        currentBitrate = RTC_CONFIG.BITRATE_SPEAKING;
        const peers = Object.values(connectedPeers);
        if (peers.length > 0) _applyBitrate(peers, currentBitrate);
    }
    // ตอนหยุดพูด ปล่อยให้ stats loop ค่อยๆ ลด

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

    setTimeout(() => {
        if (peer) { peer.destroy(); peer = null; }
        isHost                = false;
        roomState             = {};
        clientDataConnections = {};
        hostDataConnection    = null;
        connectedPeers        = {};
        // [FIXED] null srcObject ก่อน clear HTML — ป้องกัน memory leak
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
