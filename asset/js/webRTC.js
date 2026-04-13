// asset/js/webRTC.js

// ─────────────────────────────────────────────
// CONFIG
// ─────────────────────────────────────────────
const RTC_CONFIG = {
    BITRATE_SPEAKING:    32000,
    BITRATE_SILENT:      16000,
    BITRATE_UNSTABLE:    20000,
    BITRATE_STEP:        2000,
    BITRATE_INTERVAL_MS: 500,
    RECONNECT_DELAY_MS:  3000,
    ICE_SERVERS: [
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:stun1.l.google.com:19302' },
    ],
};

// ─────────────────────────────────────────────
// STATE — ทุกตัวแปร declare ครบที่นี่
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
let hostDataConnection   = null;
let clientDataConnections= {};
let roomState            = {};

// Bitrate
let isSpeaking           = false;
let currentBitrate       = RTC_CONFIG.BITRATE_SILENT;
let targetBitrate        = RTC_CONFIG.BITRATE_SILENT;
let bitrateInterval      = null;

// Network stats
let statsInterval        = null;   // ← declare ชัดเจน ไม่ให้เป็น implicit global
let lastBytesSent        = 0;
let lastBytesReceived    = 0;
let lastStatsTime        = 0;

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
// BITRATE CONTROL
// ─────────────────────────────────────────────
function onSpeakingChanged(speaking) {
    isSpeaking    = speaking;
    targetBitrate = speaking ? RTC_CONFIG.BITRATE_SPEAKING : RTC_CONFIG.BITRATE_SILENT;
}

async function applyBitrateStep() {
    const firstCall = Object.values(connectedPeers)[0];
    const pc = firstCall?.peerConnection;

    // ตรวจ RTT
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
    targetBitrate  = RTC_CONFIG.BITRATE_SILENT;
    isSpeaking     = false;
}

// ─────────────────────────────────────────────
// NETWORK STATS UI
// ─────────────────────────────────────────────
function startNetworkStats() {
    const panel = document.getElementById('networkStatusPanel');
    if (panel) panel.style.display = 'flex';

    if (statsInterval) { clearInterval(statsInterval); statsInterval = null; }
    lastBytesSent = 0;
    lastBytesReceived = 0;
    lastStatsTime = 0;

    statsInterval = setInterval(async () => {
        const pingEl      = document.getElementById('pingValue');
        const bitrateEl   = document.getElementById('bitrateValue');
        const qualityEl   = document.getElementById('qualityValue');
        const qualityIcon = document.getElementById('qualityIcon');

        // ตรวจสอบ Peers ทั้งหมด
        const peers = Object.values(connectedPeers);
        if (peers.length === 0) {
            if (pingEl) pingEl.textContent = '-- ms';
            if (bitrateEl) bitrateEl.textContent = '0 kbps';
            if (qualityEl) qualityEl.textContent = 'รอการเชื่อมต่อ';
            return;
        }

        try {
            const now = Date.now();
            let totalBytes = 0;
            let currentPing = 0;
            let packetLoss = 0;

            // วนลูปเก็บสถิติจากทุก Connection เพื่อหาค่ารวมของเครื่องเราเอง
            for (const call of peers) {
                const pc = call.peerConnection;
                if (!pc) continue;
                
                const stats = await pc.getStats();
                stats.forEach(r => {
                    // หา Ping จาก Connection ที่สำเร็จ
                    if (currentPing === 0 && r.type === 'candidate-pair' && r.state === 'succeeded' && r.currentRoundTripTime != null) {
                        currentPing = Math.round(r.currentRoundTripTime * 1000);
                    }
                    // รวม Bytes ทั้งหมด (เข้า+ออก) ที่ผ่านเครื่องเรา
                    if (r.type === 'inbound-rtp' || r.type === 'outbound-rtp') {
                        totalBytes += (r.bytesReceived || 0) + (r.bytesSent || 0);
                    }
                    // ดูค่า Packet Loss ของเสียงที่รับมา
                    if (r.type === 'inbound-rtp' && r.kind === 'audio') {
                        const total = (r.packetsLost ?? 0) + (r.packetsReceived ?? 0);
                        if (total > 0) packetLoss = (r.packetsLost / total) * 100;
                    }
                });
            }

            // คำนวณ Bitrate (kbps)
            let kbps = 0;
            if (lastStatsTime > 0) {
                const timeDiff = (now - lastStatsTime) / 1000;
                kbps = Math.round(((totalBytes - (lastBytesSent + lastBytesReceived)) * 8) / timeDiff / 1000);
            }
            
            lastBytesSent = totalBytes; 
            lastBytesReceived = 0; 
            lastStatsTime = now;

            // แสดงผล Ping และสีสถานะ
            if (pingEl) {
                pingEl.textContent = `${currentPing} ms`;
                pingEl.className = 'net-value ' + (currentPing < 150 ? 'good' : currentPing < 300 ? 'warn' : 'bad');
            }

            // แสดงผล Bitrate (ขยับตามการใช้งานเน็ตจริงของเครื่อง)
            if (bitrateEl) {
                bitrateEl.textContent = `${kbps} kbps`;
            }

            // แสดงผล Status ภาษาไทย
            const isGood = currentPing > 0 && currentPing < 150 && packetLoss < 2;
            const isWarn = currentPing < 300 && packetLoss < 10;

            if (qualityEl) {
                if (isGood) {
                    qualityEl.textContent = 'ดี';
                    qualityEl.className = 'net-value good';
                } else if (isWarn) {
                    qualityEl.textContent = 'เตือน';
                    qualityEl.className = 'net-value warn';
                } else {
                    qualityEl.textContent = 'แย่';
                    qualityEl.className = 'net-value bad';
                }
            }
            if (qualityIcon) qualityIcon.textContent = isGood ? '🟢' : isWarn ? '🟡' : '🔴';

        } catch (e) { console.error("Stats Error:", e); }
    }, 2000);
}

function stopNetworkStats() {
    if (statsInterval) { clearInterval(statsInterval); statsInterval = null; }
    const panel = document.getElementById('networkStatusPanel');
    if (panel) panel.style.display = 'none';
    ['pingValue','bitrateValue','qualityValue'].forEach(id => {
        const el = document.getElementById(id);
        if (el) { el.textContent = '--'; el.className = 'net-value'; }
    });
    const icon = document.getElementById('qualityIcon');
    if (icon) icon.textContent = '🟢';
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
            remoteAudioContainer.appendChild(audio);
        }
        if (audio.srcObject !== remoteStream) audio.srcObject = remoteStream;
    });

    // ⚠️ ไม่ trigger reconnect จาก call.on('close') เพราะ PeerJS ส่ง close
    // ระหว่าง ICE negotiation ปกติด้วย — ให้ใช้ peer.on('disconnected') แทน
    call.on('error', (err) => {
        console.error('Call error:', err);
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
    if (roomState[peerId]) { delete roomState[peerId]; playBeep('leave'); }
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
        stopNetworkStats();
        if (peer) { peer.destroy(); peer = null; }
        roomState             = {};
        clientDataConnections = {};
        hostDataConnection    = null;
        connectedPeers        = {};
        remoteAudioContainer.innerHTML = '';
        joinVoiceRoom(currentRoomId, myNickname, myStream);
    }, RTC_CONFIG.RECONNECT_DELAY_MS);
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

    // ลอง join เป็น Host ก่อน
    peer = new Peer(roomHostId, {
        debug: 0,
        config: { iceServers: RTC_CONFIG.ICE_SERVERS }
    });

    // ── กรณี 1: ได้เป็น Host (ID ว่างอยู่) ──
    peer.on('open', (id) => {
        isHost        = true;
        roomState[id] = { nickname: myNickname, role: 'Host', isTalking: false };
        updateUIList();
        updateConnectionStatus('🟢 สร้างห้องแล้ว (หัวหน้าทริป)', 'active');
        startBitrateControl();
        startNetworkStats();

        // รับ Data Channel จาก Guest
        peer.on('connection', (conn) => {
            clientDataConnections[conn.peer] = conn;

            conn.on('open', () => {
                const guestName = conn.metadata?.nickname || 'Unknown';
                roomState[conn.peer] = { nickname: guestName, role: 'Member', isTalking: false };

                // บอก Guest ว่ามีใครอยู่บ้าง
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

        // รับสาย Audio จาก Guest
        peer.on('call', (call) => {
            call.answer(myStream);
            handleActiveCall(call);
        });
    });

    // ── กรณี 2: ID ถูกใช้อยู่ → เป็น Guest ──
    peer.on('error', (err) => {
        if (err.type === 'unavailable-id') {
            // ID ถูกใช้อยู่ = ห้องมีคนสร้างไว้แล้ว → เข้าแบบ Guest
            isHost = false;
            if (peer) { peer.destroy(); peer = null; }

            peer = new Peer({
                debug: 0,
                config: { iceServers: RTC_CONFIG.ICE_SERVERS }
            });

            peer.on('open', (guestId) => {
                updateConnectionStatus('🟡 กำลังเข้าห้อง...', 'muted');
                startBitrateControl();

                // ── ต่อ Data Channel ก่อน (แก้ Race Condition) ──
                hostDataConnection = peer.connect(roomHostId, {
                    metadata: { nickname: myNickname }
                });

                hostDataConnection.on('open', () => {
                    updateConnectionStatus('🟢 เข้าร่วมทริปแล้ว', 'active');
                    startNetworkStats();
                    // โทร Audio หลัง Data Channel เปิดแล้วเท่านั้น
                    const call = peer.call(roomHostId, myStream);
                    handleActiveCall(call);
                });

                hostDataConnection.on('data', (data) => {
                    if (data.type === 'welcome') {
                        roomState = data.roomState;
                        updateUIList();
                        // โทรหา Guest คนอื่นที่อยู่ในห้องแล้ว
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
                console.error('Guest peer error:', err2);
                updateConnectionStatus(`🔴 เชื่อมต่อไม่ได้ (${err2.type})`, 'disconnected');
                if (!isLeaving && err2.type !== 'peer-unavailable') attemptReconnect();
            });

        } else {
            // error อื่นๆ เช่น network-error, server-error
            console.error('PeerJS error:', err);
            updateConnectionStatus(`🔴 เชื่อมต่อไม่ได้ (${err.type})`, 'disconnected');
            if (!isLeaving) attemptReconnect();
        }
    });

    // Host peer disconnected จาก PeerJS server
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
    onSpeakingChanged(isActive);
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
    stopNetworkStats();
    if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }

    // แจ้งเพื่อนก่อนออก
    if (isHost) {
        Object.values(clientDataConnections).forEach(conn => {
            if (conn.open) conn.send({ type: 'leave', peerId: peer?.id });
        });
    } else if (hostDataConnection?.open) {
        hostDataConnection.send({ type: 'leave' });
    }

    // destroy หลังส่งข้อมูลเสร็จ
    setTimeout(() => {
        if (peer) { peer.destroy(); peer = null; }
        isHost                = false;
        roomState             = {};
        clientDataConnections = {};
        hostDataConnection    = null;
        connectedPeers        = {};
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
    const badge  = document.getElementById('connectionStatusBadge');
    const span   = document.getElementById('connectionStatusText');
    if (badge) badge.className  = `status-badge ${stateClass}`;
    if (span)  span.innerText   = text;
}

// ─────────────────────────────────────────────
// EXPORTS
// ─────────────────────────────────────────────
window.ClearWayWebRTC = { joinVoiceRoom, leaveVoiceRoom, broadcastMicStatus };
