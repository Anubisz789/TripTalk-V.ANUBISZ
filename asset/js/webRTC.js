// asset/js/webRTC.js
const RTC_CONFIG = {
  BITRATE_SPEAKING: 28000, BITRATE_SILENT: 8000, BITRATE_UNSTABLE: 16000,
  BITRATE_STEP_DOWN: 3000, BITRATE_STEP_UP: 28000, STATS_INTERVAL_MS: 2000,
  RECONNECT_DELAY_MS: 3000, CONN_TIMEOUT_MS: 15000, RTT_UNSTABLE_THRESHOLD: 0.15,
  PACKET_LOSS_THRESHOLD: 5,
  ICE_SERVERS: [
    { urls: 'stun:stun.l.google.com:19302' }, { urls: 'stun:stun1.l.google.com:19302' },
    { urls: 'stun:stun2.l.google.com:19302' }, { urls: 'stun:stun3.l.google.com:19302' }, { urls: 'stun:stun4.l.google.com:19302' },
    { urls: 'turn:openrelay.metered.ca:443', username: 'openrelayproject', credential: 'openrelayproject' },
    { urls: 'turn:openrelay.metered.ca:80', username: 'openrelayproject', credential: 'openrelayproject' }
  ]
};

let peer = null, connectedPeers = {}, myStream = null, myNickname = '', isHost = false;
let roomHostId = '', currentRoomId = '', isLeaving = false, connTimeoutTimer = null;
let hostDataConnection = null, clientDataConnections = {}, roomState = {};
let myLocation = { lat: 0, lng: 0 }, locationInterval = null, isSpeaking = false, currentBitrate = RTC_CONFIG.BITRATE_SILENT, statsInterval = null;

const remoteAudioContainer = document.createElement('div');
remoteAudioContainer.id = 'remoteAudios'; remoteAudioContainer.style.display = 'none'; document.body.appendChild(remoteAudioContainer);

function playBeep(type) {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)(); const osc = ctx.createOscillator(); const gain = ctx.createGain();
    osc.connect(gain); gain.connect(ctx.destination); gain.gain.setValueAtTime(0.2, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.3);
    osc.frequency.setValueAtTime(type === 'join' ? 660 : 880, ctx.currentTime);
    osc.frequency.setValueAtTime(type === 'join' ? 880 : 440, ctx.currentTime + 0.1);
    osc.start(ctx.currentTime); osc.stop(ctx.currentTime + 0.3); osc.onended = () => ctx.close();
  } catch(e) {}
}

async function _applyBitrate(peers, bitrate) {
  for (const call of Object.values(peers)) {
    try {
      const pc = call.peerConnection; if (!pc) continue;
      const senders = pc.getSenders().filter(s => s.track?.kind === 'audio');
      for (const sender of senders) {
        const params = sender.getParameters(); if (!params.encodings?.length) params.encodings = [{}];
        if (params.encodings[0].maxBitrate !== bitrate) { params.encodings[0].maxBitrate = bitrate; await sender.setParameters(params); }
      }
    } catch(e) { console.warn('Bitrate update failed:', e); }
  }
}

function handleActiveCall(call) {
  if (!call) return; const peerId = call.peer; connectedPeers[peerId] = call;
  call.on('stream', (remoteStream) => {
    let audio = document.getElementById(`audio-${peerId}`);
    if (!audio) { audio = document.createElement('audio'); audio.id = `audio-${peerId}`; audio.autoplay = true; audio.setAttribute('playsinline', ''); remoteAudioContainer.appendChild(audio); }
    audio.srcObject = remoteStream; audio.play().catch(e => console.warn("Autoplay blocked:", e));
  });
  call.on('close', () => { _cleanupPeerAudio(peerId); delete connectedPeers[peerId]; });
  call.on('error', (err) => { console.error(`Call error with ${peerId}:`, err); _cleanupPeerAudio(peerId); });
}

function _cleanupPeerAudio(peerId) {
  const audio = document.getElementById(`audio-${peerId}`);
  if (audio) { audio.pause(); audio.srcObject = null; audio.remove(); }
}

// 🔽 แก้ไข: Host Transfer Logic (ลบร่างซ้อน)
function handlePeerLeave(peerId) {
  if (!peerId) return;
  
  // ล้างการเชื่อมต่อและเสียง
  if (clientDataConnections[peerId]) { clientDataConnections[peerId].close(); delete clientDataConnections[peerId]; }
  if (connectedPeers[peerId]) { connectedPeers[peerId].close(); delete connectedPeers[peerId]; }
  if (hostDataConnection && hostDataConnection.peer === peerId) { hostDataConnection.close(); hostDataConnection = null; }
  _cleanupPeerAudio(peerId);
  
  // ลบสถานะออกจากห้อง
  if (roomState[peerId]) {
    // ✅ ถ้าคนที่ออกกำลัง SOS อยู่ ให้หยุดเสียง SOS ทันที
    if (roomState[peerId].sos && typeof window.playSOSAlert === 'function') {
      // ตรวจสอบก่อนว่ายังมีคนอื่น SOS อยู่ไหม ถ้าไม่มีค่อยหยุดเสียงทั้งหมด
      const otherSOS = Object.keys(roomState).some(id => id !== peerId && roomState[id].sos);
      if (!otherSOS) window.playSOSAlert(false);
    }
    delete roomState[peerId];
    playBeep('leave');
  }

  // กรณีเราเป็น Host แล้วคนอื่นออก: ต้องแจ้งทุกคนที่เหลือ
  if (isHost) {
    broadcastRoomState();
  } 
  // กรณี Host ออก (peerId คือ roomHostId): ต้องมีการเลือก Host ใหม่ในฝั่ง Client
    else if (peerId === roomHostId) {
    const remainingIds = Object.keys(roomState).sort();
    if (remainingIds.length > 0) {
      const newHostId = remainingIds[0];
      if (newHostId === peer.id) {
        console.log("Taking over as new Host");
        isHost = true;
        roomState[peer.id].role = 'Host';
        updateConnectionStatus('🟢 คุณคือหัวหน้าทริปคนใหม่', 'active');
        // แจ้งทุกคนที่เหลือว่าเราคือ Host ใหม่
        broadcastRoomState();
      }
    }
  }
  
  updateUIList();
}

function joinVoiceRoom(roomId, nickname, localStream) {
  myStream = localStream; myNickname = nickname; currentRoomId = roomId; roomHostId = `clearway-room-${roomId}`; isLeaving = false;
  updateConnectionStatus('🟡 กำลังเชื่อมต่อเซิร์ฟเวอร์...', 'muted');

  peer = new Peer(roomHostId, { debug: 1, config: { iceServers: RTC_CONFIG.ICE_SERVERS, iceTransportPolicy: 'all', iceCandidatePoolSize: 10 } });

  peer.on('open', (id) => {
    isHost = true; roomState[id] = { nickname: myNickname, role: 'Host', isTalking: false };
    updateUIList(); updateConnectionStatus('🟢 สร้างห้องแล้ว (หัวหน้าทริป)', 'active'); startStatsLoop();

    peer.on('connection', (conn) => {
      clientDataConnections[conn.peer] = conn;
      conn.on('open', () => {
        const guestName = conn.metadata?.nickname || 'Unknown'; roomState[conn.peer] = { nickname: guestName, role: 'Member', isTalking: false };
        const allPeers = Object.keys(roomState).filter(p => p !== conn.peer);
        conn.send({ type: 'welcome', roomState, peersToCall: allPeers }); broadcastRoomState(); updateUIList(); playBeep('join');
      });
      conn.on('data', (data) => {
        if (data.type === 'mic-status') { if (roomState[conn.peer]) roomState[conn.peer].isTalking = data.isActive; broadcastRoomState(); updateUIList(); }
        else if (data.type === 'leave') handlePeerLeave(conn.peer);
        else if (data.type === 'location') { if (roomState[conn.peer]) roomState[conn.peer].location = data.location; broadcastRoomState(); updateUIList(); }
        else if (data.type === 'sos') { 
          if (roomState[conn.peer]) roomState[conn.peer].sos = data.isActive; 
          broadcastRoomState(); updateUIList(); 
          if (typeof window.playSOSAlert === 'function') window.playSOSAlert(data.isActive);
          if (isHost) {
            // กระจาย SOS Alert ให้ทุกคน (ยกเว้นคนส่งมา เพราะเขาเล่นเสียงเองแล้ว)
            Object.values(clientDataConnections).forEach(c => { 
              if (c.open && c.peer !== conn.peer) c.send({ type: 'sos-alert', from: conn.peer, isActive: data.isActive }); 
            });
          }
        }
      });
      conn.on('close', () => handlePeerLeave(conn.peer)); conn.on('error', () => handlePeerLeave(conn.peer));
    });

    peer.on('call', (call) => { call.answer(myStream); handleActiveCall(call); });
  });

  peer.on('error', (err) => {
    if (err.type === 'unavailable-id') {
      isHost = false; peer.destroy(); peer = new Peer({ config: { iceServers: RTC_CONFIG.ICE_SERVERS } });
      peer.on('open', (myId) => {
        updateConnectionStatus('🟡 กำลังเข้าห้อง...', 'muted');
        hostDataConnection = peer.connect(roomHostId, { metadata: { nickname: myNickname }, reliable: true });
        connTimeoutTimer = setTimeout(() => { if (!hostDataConnection.open && !isLeaving) attemptReconnect(); }, RTC_CONFIG.CONN_TIMEOUT_MS);
        hostDataConnection.on('open', () => { clearTimeout(connTimeoutTimer); updateConnectionStatus('🟢 เข้าร่วมทริปแล้ว', 'active'); startStatsLoop(); });
        hostDataConnection.on('data', (data) => {
          if (data.type === 'welcome') { roomState = data.roomState; updateUIList(); data.peersToCall.forEach(otherId => { if (!connectedPeers[otherId]) handleActiveCall(peer.call(otherId, myStream)); }); }
          else if (data.type === 'update-state') { roomState = data.roomState; updateUIList(); }
          else if (data.type === 'leave') { handlePeerLeave(data.peerId); if (data.peerId === roomHostId) alert('หัวหน้าทริปสิ้นสุดการสนทนา'); }
          else if (data.type === 'sos-alert') { if (typeof window.playSOSAlert === 'function') window.playSOSAlert(data.isActive); }
        });
        hostDataConnection.on('close', () => { if (!isLeaving) attemptReconnect(); });
        hostDataConnection.on('error', () => { if (!isLeaving) attemptReconnect(); });
      });
      peer.on('call', (call) => { call.answer(myStream); handleActiveCall(call); });
      peer.on('disconnected', () => { if (!isLeaving) peer.reconnect(); });
    } else { console.error('PeerJS error:', err); if (!isLeaving && err.type !== 'peer-unavailable') updateConnectionStatus('🔴 เชื่อมต่อผิดพลาด', 'disconnected'); }
  });
}

function startStatsLoop() {
  if (statsInterval) clearInterval(statsInterval);
  statsInterval = setInterval(async () => {
    if (!peer || isLeaving) return;
    const targetBitrate = isSpeaking ? RTC_CONFIG.BITRATE_STEP_UP : RTC_CONFIG.BITRATE_STEP_DOWN;
    if (currentBitrate !== targetBitrate) { currentBitrate = targetBitrate; await _applyBitrate(connectedPeers, currentBitrate); }

    const firstCall = Object.values(connectedPeers)[0];
    if (firstCall?.peerConnection) {
      try {
        const stats = await firstCall.peerConnection.getStats();
        let rtt = 0, packetsLost = 0, packetsSent = 0;
        stats.forEach(report => {
          if (report.type === 'candidate-pair' && report.state === 'succeeded') rtt = report.currentRoundTripTime || 0;
          else if (report.type === 'outbound-rtp') packetsSent = report.packetsSent || 0;
          else if (report.type === 'remote-inbound-rtp') packetsLost = report.packetsLost || 0;
        });
        const loss = packetsSent > 0 ? (packetsLost / packetsSent) * 100 : 0;
        const pingEl = document.getElementById('pingValue'); const bitrateEl = document.getElementById('bitrateValue');
        const qualityIcon = document.getElementById('qualityIcon'); const qualityValue = document.getElementById('qualityValue');
        if (pingEl) { pingEl.innerText = rtt > 0 ? `${Math.round(rtt * 1000)} ms` : '-- ms'; pingEl.className = rtt > 0 ? (rtt < RTC_CONFIG.RTT_UNSTABLE_THRESHOLD ? 'net-value good' : 'net-value warn') : 'net-value bad'; }
        if (bitrateEl) bitrateEl.innerText = `${Math.round(currentBitrate / 1000)} kbps`;
        if (qualityIcon && qualityValue) {
          if (rtt > 0 && rtt < 0.1 && loss < RTC_CONFIG.PACKET_LOSS_THRESHOLD) { qualityIcon.innerText = '🟢'; qualityValue.innerText = 'ยอดเยี่ยม'; qualityValue.className = 'net-value good'; }
          else if (rtt > 0 && rtt < 0.25 && loss < RTC_CONFIG.PACKET_LOSS_THRESHOLD * 2) { qualityIcon.innerText = '🟡'; qualityValue.innerText = 'พอใช้'; qualityValue.className = 'net-value warn'; }
          else { qualityIcon.innerText = '🔴'; qualityValue.innerText = 'สัญญาณอ่อน'; qualityValue.className = 'net-value bad'; }
        }
      } catch(e) { console.error('Stats error:', e); }
    }
  }, RTC_CONFIG.STATS_INTERVAL_MS);

  if (locationInterval) clearInterval(locationInterval);
  locationInterval = setInterval(() => {
    if (navigator.geolocation) {
      navigator.geolocation.getCurrentPosition(pos => {
        myLocation = { lat: pos.coords.latitude, lng: pos.coords.longitude };
        if (isHost) { roomState[peer.id].location = myLocation; broadcastRoomState(); }
        else if (hostDataConnection?.open) hostDataConnection.send({ type: 'location', location: myLocation });
      }, null, { enableHighAccuracy: true });
    }
  }, 10000);
}

function sendSOS(isActive) {
  const data = { type: 'sos', isActive };
  
  // เล่นเสียงที่เครื่องตัวเองทันทีไม่ว่าเป็น Host หรือ Member
  if (typeof window.playSOSAlert === 'function') {
    window.playSOSAlert(isActive);
  }

  if (isHost) { 
    if (peer && roomState[peer.id]) roomState[peer.id].sos = isActive; 
    // ส่ง alert ให้ลูกข่ายทุกคน และอัปเดต UI ตัวเอง
    broadcastRoomState(); 
    updateUIList();
  } else {
    // ถ้าเป็น Member ส่งให้ Host เพื่อให้ Host กระจายต่อ
    if (hostDataConnection?.open) {
      hostDataConnection.send(data);
    }
    // อัปเดตสถานะตัวเองในเครื่องตัวเองด้วย
    if (peer && roomState[peer.id]) {
      roomState[peer.id].sos = isActive;
      updateUIList();
    }
  }
}

function broadcastRoomState() { if (!isHost) return; Object.values(clientDataConnections).forEach(conn => { if (conn.open) conn.send({ type: 'update-state', roomState }); }); }
function broadcastMicStatus(isActive) { if (!peer || !roomState[peer.id]) return; isSpeaking = isActive; roomState[peer.id].isTalking = isActive; updateUIList(); if (isHost) broadcastRoomState(); else if (hostDataConnection && hostDataConnection.open) hostDataConnection.send({ type: 'mic-status', isActive }); }
function updateUIList() { if (window.ClearWayUI?.renderMembers) window.ClearWayUI.renderMembers(roomState, peer ? peer.id : null); }
function attemptReconnect() { if (isLeaving) return; updateConnectionStatus('🟡 สัญญาณหลุด กำลังเชื่อมใหม่...', 'muted'); setTimeout(() => { if (!isLeaving) joinVoiceRoom(currentRoomId, myNickname, myStream); }, RTC_CONFIG.RECONNECT_DELAY_MS); }

function leaveVoiceRoom() {
  isLeaving = true;
  // ✅ หยุดเสียง SOS ของตัวเองก่อนออก
  if (typeof window.playSOSAlert === 'function') window.playSOSAlert(false);
  
  if (isHost) Object.values(clientDataConnections).forEach(conn => { if (conn.open) conn.send({ type: 'leave', peerId: peer.id }); });
  else if (hostDataConnection && hostDataConnection.open) hostDataConnection.send({ type: 'leave' });
  if (statsInterval) clearInterval(statsInterval);
  setTimeout(() => { if (peer) peer.destroy(); peer = null; roomState = {}; clientDataConnections = {}; hostDataConnection = null; Object.keys(connectedPeers).forEach(id => _cleanupPeerAudio(id)); connectedPeers = {}; updateUIList(); }, 200);
}

function updateConnectionStatus(text, stateClass) {
  const badge = document.getElementById('connectionStatusBadge'); const statusText = document.getElementById('connectionStatusText');
  if (badge) badge.className = `status-badge ${stateClass}`;
  if (statusText) statusText.innerText = text;
}

window.ClearWayWebRTC = { joinVoiceRoom, leaveVoiceRoom, broadcastMicStatus, sendSOS };
