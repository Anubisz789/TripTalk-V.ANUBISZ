// asset/js/webRTC.js

let peer;
let connectedPeers = {}; 
let myStream;
let myNickname = '';
let isHost = false;
let roomHostId = '';

// ตัวแปรสำหรับ Data Channel ควบคุม UI
let hostDataConnection = null; // ท่อส่งข้อมูลกรณีเราเป็น Guest
let clientDataConnections = {}; // ท่อส่งข้อมูลกรณีเราเป็น Host
let roomState = {}; // แหล่งเก็บข้อมูลรายชื่อทั้งหมด { peerId: { nickname, role, isTalking } }

const remoteAudioContainer = document.createElement('div');
remoteAudioContainer.id = 'remoteAudios';
remoteAudioContainer.style.display = 'none';
document.body.appendChild(remoteAudioContainer);

function joinVoiceRoom(roomId, nickname, localStream) {
    myStream = localStream;
    myNickname = nickname;
    roomHostId = `clearway-room-${roomId}`;

    updateConnectionStatus('🟡 กำลังเชื่อมต่อเซิร์ฟเวอร์...', 'muted');

    peer = new Peer(roomHostId, { debug: 1, config: { 'iceServers': [{ urls: 'stun:stun.l.google.com:19302' }] } });

    // --- กรณีที่ 1: เราได้เป็น Host ---
    peer.on('open', (id) => {
        isHost = true;
        // บันทึกตัวเองลงใน State แล้วสั่ง Render UI
        roomState[id] = { nickname: myNickname, role: 'Host', isTalking: false };
        updateUIList();
        updateConnectionStatus('🟢 สร้างห้องแล้ว (หัวหน้าทริป)', 'active');

        // รับการเชื่อมต่อ Data Channel จากเพื่อนๆ
        peer.on('connection', (conn) => {
            clientDataConnections[conn.peer] = conn;

            conn.on('open', () => {
                // บันทึกชื่อเพื่อนคนใหม่ลงใน State
                const guestName = conn.metadata.nickname || 'Unknown';
                roomState[conn.peer] = { nickname: guestName, role: 'Member', isTalking: false };

                // ส่งรายชื่อให้ Guest รู้ว่าต้องโทร Audio หาใครบ้าง
                const audioPeers = Object.keys(roomState).filter(p => p !== conn.peer && p !== id);
                conn.send({ type: 'welcome', roomState: roomState, peersToCall: audioPeers });

                // อัปเดต UI ให้ทุกคนเห็นสมาชิกใหม่
                broadcastRoomState();
                updateUIList();
            });

            // ดักฟังว่าเพื่อนคนไหนไฟ VAD ติด
            conn.on('data', (data) => {
                if (data.type === 'mic-status') {
                    roomState[conn.peer].isTalking = data.isActive;
                    broadcastRoomState(); // Relay ข้อมูลต่อให้ทุกคน
                    updateUIList();
                } else if (data.type === 'leave') {
        // ⚠️ เมื่อได้รับสัญญาณลาจาก Guest
        handlePeerLeave(conn.peer);
    }
            });

            conn.on('close', () => handlePeerLeave(conn.peer));
        });

        // รับสาย Audio จากเพื่อนๆ
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

                // 1. โทร Audio หา Host
                const call = peer.call(roomHostId, myStream);
                handleActiveCall(call);

                // 2. ต่อ Data Channel หา Host พร้อมส่งชื่อตัวเองไป
                hostDataConnection = peer.connect(roomHostId, { metadata: { nickname: myNickname } });

                hostDataConnection.on('open', () => {
                    updateConnectionStatus('🟢 เข้าร่วมทริปแล้ว', 'active');
                });

                // ฟังคำสั่งจาก Host (รายชื่อเพื่อน, สถานะไฟไมค์)
                hostDataConnection.on('data', (data) => {
                    if (data.type === 'welcome') {
                        roomState = data.roomState;
                        updateUIList();
                        // โทร Audio หาเพื่อนคนอื่นๆ ที่อยู่ในห้องอยู่แล้ว
                        data.peersToCall.forEach(otherGuestId => {
                            const guestCall = peer.call(otherGuestId, myStream);
                            handleActiveCall(guestCall);
                        });
                    } else if (data.type === 'update-state') {
                        roomState = data.roomState;
                        updateUIList();
                    } else if (data.type === 'leave') {
                        // ⚠️ เมื่อได้รับสัญญาณลาจากเพื่อน (ที่ Host ส่งต่อมาให้) หรือจาก Host เอง
                        handlePeerLeave(data.peerId);
                        // ถ้า Host เป็นคนลาเอง ห้องจะแตก
                        if (data.peerId === roomHostId) {
                            alert("หัวหน้าทริปสิ้นสุดการสนทนา");
                            location.reload(); // รีเฟรชหน้าเว็บเพื่อเคลียร์สถานะทั้งหมด
                        }
                    }
                });
            });

            // รับสาย Audio จากเพื่อนๆ ที่เข้ามาทีหลังเรา
            peer.on('call', (call) => {
                call.answer(myStream);
                handleActiveCall(call);
            });
        }
    });
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

// เมื่อเพื่อนหลุด ให้เตะออกจาก List
function handlePeerLeave(peerId) {
    if (clientDataConnections[peerId]) delete clientDataConnections[peerId];
    if (connectedPeers[peerId]) {
        connectedPeers[peerId].close();
        delete connectedPeers[peerId];
    }
    const audio = document.getElementById(`audio-${peerId}`);
    if (audio) audio.remove();

    if (roomState[peerId]) delete roomState[peerId];
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