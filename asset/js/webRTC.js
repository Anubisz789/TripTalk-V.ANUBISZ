// asset/js/webRTC.js

let peer;
let connectedPeers = {}; 
let myStream;
let myNickname = '';
let isHost = false;
let roomHostId = '';
let currentRoomId = '';   // เก็บไว้สำหรับ Reconnect
let isLeaving = false;    // ป้องกัน Reconnect ตอนออกห้องจริงๆ
let reconnectTimer = null;

let hostDataConnection = null;
let clientDataConnections = {};
let roomState = {};

const remoteAudioContainer = document.createElement('div');
remoteAudioContainer.id = 'remoteAudios';
remoteAudioContainer.style.display = 'none';
document.body.appendChild(remoteAudioContainer);

// --- เสียงแจ้งเตือนแบบ Web Audio (ไม่ต้องโหลดไฟล์) ---
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
        // ปิด AudioContext หลังเสียงจบ ป้องกัน leak
        osc.onended = () => ctx.close();
    } catch(e) { /* ถ้าเสียงไม่ทำงานก็ข้ามไป */ }
}

function joinVoiceRoom(roomId, nickname, localStream) {
    myStream = localStream;
    myNickname = nickname;
    currentRoomId = roomId;
    roomHostId = `clearway-room-${roomId}`;
    isLeaving = false;

    updateConnectionStatus('🟡 กำลังเชื่อมต่อเซิร์ฟเวอร์...', 'muted');

    peer = new Peer(roomHostId, { debug: 1, config: { 'iceServers': [{ urls: 'stun:stun.l.google.com:19302' }] } });

    // --- กรณีที่ 1: เราได้เป็น Host ---
    peer.on('open', (id) => {
        isHost = true;
        roomState[id] = { nickname: myNickname, role: 'Host', isTalking: false };
        updateUIList();
        updateConnectionStatus('🟢 สร้างห้องแล้ว (หัวหน้าทริป)', 'active');

        peer.on('connection', (conn) => {
            clientDataConnections[conn.peer] = conn;

            conn.on('open', () => {
                const guestName = conn.metadata.nickname || 'Unknown';
                roomState[conn.peer] = { nickname: guestName, role: 'Member', isTalking: false };

                const audioPeers = Object.keys(roomState).filter(p => p !== conn.peer && p !== id);
                conn.send({ type: 'welcome', roomState: roomState, peersToCall: audioPeers });

                broadcastRoomState();
                updateUIList();
                playBeep('join'); // 🔔 มีคนเข้าห้อง
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

    // --- กรณีที่ 2: รหัสซ้ำ (เรากลายเป็น Guest) ---
    peer.on('error', (err) => {
        if (err.type === 'unavailable-id') {
            isHost = false;
            peer.destroy();
            peer = new Peer({ debug: 1 });

            peer.on('open', (guestId) => {
                updateConnectionStatus('🟡 กำลังเข้าห้อง...', 'muted');

                // ✅ แก้ Race Condition: ต่อ Data Channel ก่อน แล้วค่อยโทร Audio ใน open
                hostDataConnection = peer.connect(roomHostId, { metadata: { nickname: myNickname } });

                hostDataConnection.on('open', () => {
                    updateConnectionStatus('🟢 เข้าร่วมทริปแล้ว', 'active');
                    // โทร Audio หลัง Data Channel เปิดแล้วเท่านั้น
                    const call = peer.call(roomHostId, myStream);
                    handleActiveCall(call);
                });

                hostDataConnection.on('data', (data) => {
                    if (data.type === 'welcome') {
                        roomState = data.roomState;
                        updateUIList();
                        data.peersToCall.forEach(otherGuestId => {
                            const guestCall = peer.call(otherGuestId, myStream);
                            handleActiveCall(guestCall);
                        });
                    } else if (data.type === 'update-state') {
                        roomState = data.roomState;
                        updateUIList();
                    } else if (data.type === 'leave') {
                        handlePeerLeave(data.peerId);
                        if (data.peerId === roomHostId) {
                            alert("หัวหน้าทริปสิ้นสุดการสนทนา");
                            location.reload();
                        }
                    }
                });

                hostDataConnection.on('close', () => {
                    // Host หลุด → พยายาม Reconnect
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
            // จัดการ error อื่นๆ ที่ไม่ใช่ unavailable-id
            console.error('PeerJS error:', err);
            updateConnectionStatus(`🔴 เชื่อมต่อไม่ได้ (${err.type})`, 'disconnected');
            if (!isLeaving && err.type !== 'peer-unavailable') {
                attemptReconnect();
            }
        }
    });

    // ดักจับสัญญาณหลุดสำหรับ Host
    peer.on('disconnected', () => {
        if (!isLeaving) {
            updateConnectionStatus('🟡 สัญญาณหลุด กำลังเชื่อมใหม่...', 'muted');
            peer.reconnect();
        }
    });
}

// --- Reconnect อัตโนมัติ ---
function attemptReconnect() {
    if (isLeaving || reconnectTimer) return;
    updateConnectionStatus('🟡 กำลังเชื่อมต่อใหม่...', 'muted');
    reconnectTimer = setTimeout(() => {
        reconnectTimer = null;
        if (isLeaving) return;
        // ทำลาย peer เก่าแล้วเข้าห้องใหม่ด้วยข้อมูลเดิม
        if (peer) { peer.destroy(); peer = null; }
        roomState = {};
        clientDataConnections = {};
        hostDataConnection = null;
        remoteAudioContainer.innerHTML = '';
        connectedPeers = {};
        joinVoiceRoom(currentRoomId, myNickname, myStream);
    }, 3000); // รอ 3 วินาทีแล้วค่อย reconnect
}


function handleActiveCall(call) {
    connectedPeers[call.peer] = call;
    call.on('stream', (remoteStream) => {
        let audioElement = document.getElementById(`audio-${call.peer}`);
        if (!audioElement) {
            audioElement = document.createElement('audio');
            audioElement.id = `audio-${call.peer}`;
            audioElement.autoplay = true;
            if (call.peer !== peer.id) remoteAudioContainer.appendChild(audioElement);
        }
        audioElement.srcObject = remoteStream;
    });
}

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
        playBeep('leave'); // 🔔 มีคนออกห้อง
    }
    broadcastRoomState();
    updateUIList();
}

// Host เป็นคนกระจายรายชื่อให้ทุกคน
function broadcastRoomState() {
    if (!isHost) return;
    Object.values(clientDataConnections).forEach(conn => {
        if (conn.open) conn.send({ type: 'update-state', roomState: roomState });
    });
}

// ถูกเรียกจาก vad.js เวลาระดับเสียงเกิน Threshold
function broadcastMicStatus(isActive) {
    if (!peer || !roomState[peer.id]) return;

    roomState[peer.id].isTalking = isActive;
    updateUIList(); // ให้หลอดไฟตัวเองติด/ดับ

    if (isHost) {
        broadcastRoomState(); // ถ้าเป็น Host ให้โยนลงกล่องกระจายเสียง
    } else if (hostDataConnection && hostDataConnection.open) {
        // ถ้าเป็น Guest ให้ส่ง Data Channel บอก Host
        hostDataConnection.send({ type: 'mic-status', isActive: isActive });
    }
}

// สั่งวาด UI บนหน้าจอ
function updateUIList() {
    if (window.ClearWayUI && window.ClearWayUI.renderMembers) {
        window.ClearWayUI.renderMembers(roomState, peer ? peer.id : null);
    }
}

function leaveVoiceRoom() {
    isLeaving = true;
    if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
    // ⚠️ ส่งสัญญาณบอกเพื่อนก่อนไป
    if (isHost) {
        // ถ้าเราเป็น Host บอกทุกคนในห้อง
        Object.values(clientDataConnections).forEach(conn => {
            if (conn.open) conn.send({ type: 'leave', peerId: peer.id });
        });
    } else if (hostDataConnection && hostDataConnection.open) {
        // ถ้าเป็น Guest บอก Host ให้ช่วยกระจายข่าว
        hostDataConnection.send({ type: 'leave' });
    }

    // รอเสี้ยววินาทีเพื่อให้ข้อมูลถูกส่งออกไป แล้วค่อยทำลาย Peer
    setTimeout(() => {
        if (peer) peer.destroy();
        peer = null;
        roomState = {};
        clientDataConnections = {};
        hostDataConnection = null;
        remoteAudioContainer.innerHTML = '';
        connectedPeers = {};
        updateUIList();
    }, 100);
}

function updateConnectionStatus(text, stateClass) {
    const badge = document.getElementById('connectionStatusBadge');
    const statusText = document.getElementById('connectionStatusText');
    badge.className = `status-badge ${stateClass}`;
    statusText.innerText = text;
}

window.ClearWayWebRTC = { joinVoiceRoom, leaveVoiceRoom, broadcastMicStatus };
