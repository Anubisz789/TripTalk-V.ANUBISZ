// asset/js/app.js
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js?v=4.7.3').then(reg => {
      reg.onupdatefound = () => {
        const installingWorker = reg.installing;
        installingWorker.onstatechange = () => {
          if (installingWorker.state === 'installed' && navigator.serviceWorker.controller) window.location.reload();
        };
      };
    });
  });
}

window.wakeLock = null;
window.requestWakeLock = async function() { try { if ('wakeLock' in navigator) window.wakeLock = await navigator.wakeLock.request('screen'); } catch (err) { console.error(err); } };
window.releaseWakeLock = function() { if (window.wakeLock) { window.wakeLock.release(); window.wakeLock = null; } };

// 🔊 SOS ALERT SOUND ENGINE (Web Audio API, Cross-Platform)
window.playSOSAlert = function() {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    if (ctx.state === 'suspended') ctx.resume();
    const osc = ctx.createOscillator(); const gain = ctx.createGain();
    osc.connect(gain); gain.connect(ctx.destination);
    gain.gain.setValueAtTime(0.8, ctx.currentTime);
    osc.frequency.setValueAtTime(880, ctx.currentTime);
    osc.frequency.setValueAtTime(440, ctx.currentTime + 0.2);
    osc.frequency.setValueAtTime(880, ctx.currentTime + 0.4);
    osc.frequency.setValueAtTime(440, ctx.currentTime + 0.6);
    osc.start(ctx.currentTime); osc.stop(ctx.currentTime + 1.0);
    setTimeout(() => ctx.close(), 1500);
  } catch(e) { console.warn('SOS Audio failed:', e); }
};

const PRESETS = {
  city: { name: '🏙️ ในเมือง', hp: 100, gain: 14, threshold: 50, hold: 1200 },
  road: { name: '🛣️ ทริประยะไกล', hp: 250, gain: 18, threshold: 40, hold: 1500 },
  speed: { name: '🏎️ ความเร็วสูง', hp: 450, gain: 22, threshold: 35, hold: 2000 }
};

window.customPresets = JSON.parse(localStorage.getItem('triptalk_presets') || '{}');
function loadPresets() {
  const presetSelector = document.getElementById('presetSelector'); if (!presetSelector) return;
  presetSelector.innerHTML = '<option value="">🎛️ โหลดโปรไฟล์...</option>';
  Object.keys(PRESETS).forEach(k => { const opt = document.createElement('option'); opt.value = k; opt.innerText = PRESETS[k].name; presetSelector.appendChild(opt); });
  Object.keys(window.customPresets).forEach(k => { const opt = document.createElement('option'); opt.value = `custom_${k}`; opt.innerText = `⭐ ${window.customPresets[k].name.replace('⭐', '')}`; presetSelector.appendChild(opt); });
  presetSelector.value = localStorage.getItem('lastSelectedPreset') || presetSelector.options[1]?.value || '';
  presetSelector.dispatchEvent(new Event('change'));
}

function updateSliderLabels() {
  const t = document.getElementById('thresholdSlider'); if (t) document.getElementById('thresholdVal').innerText = `${t.value}%`;
  const h = document.getElementById('holdTimeSlider'); if (h) document.getElementById('holdTimeVal').innerText = `${(h.value / 1000).toFixed(1)}s`;
  const hp = document.getElementById('highpassSlider'); if (hp) document.getElementById('highpassVal').innerText = `${hp.value} Hz`;
  const g = document.getElementById('gainSlider'); if (g) document.getElementById('gainVal').innerText = `${(g.value / 10).toFixed(1)}x`;
  const marker = document.getElementById('thresholdMarker'); if (marker && t) marker.style.left = `${t.value}%`;
}

function savePreset() {
  const nameInput = document.getElementById('customPresetName'); const name = nameInput.value.trim();
  if (!name) return alert('กรุณาใส่ชื่อ Preset');
  if (name.length > 20) return alert('ชื่อ Preset ต้องไม่เกิน 20 ตัวอักษร');
  if (Object.keys(PRESETS).includes(name)) return alert('ชื่อซ้ำกับ Preset ตั้งต้น');
  
  window.customPresets[name] = {
    name: `⭐${name}`, threshold: parseInt(document.getElementById('thresholdSlider').value),
    hold: parseInt(document.getElementById('holdTimeSlider').value), hp: parseInt(document.getElementById('highpassSlider').value),
    gain: parseFloat(document.getElementById('gainSlider').value) / 10
  };
  localStorage.setItem('triptalk_presets', JSON.stringify(window.customPresets));
  nameInput.value = ''; loadPresets(); alert(`Preset "${name}" บันทึกแล้ว!`);
}

function deletePreset() {
  const sel = document.getElementById('presetSelector').value;
  if (!sel.startsWith('custom_')) return alert('ไม่สามารถลบ Preset ตั้งต้นได้');
  const key = sel.replace('custom_', '');
  if (!confirm(`ลบ Preset "${key}" ใช่หรือไม่?`)) return;
  delete window.customPresets[key];
  localStorage.setItem('triptalk_presets', JSON.stringify(window.customPresets));
  loadPresets(); alert(`ลบ "${key}" แล้ว`);
}

window.isRiding = false;
window.toggleRide = async function() {
  const startRideBtn = document.getElementById('startRideBtn');
  const leaveBtn = document.getElementById('leaveRoomBtn');
  const nicknameInput = document.getElementById('nicknameInput');
  const roomInput = document.getElementById('roomInput');
  
  if (!window.isRiding) {
    const nick = nicknameInput.value.trim(); const room = roomInput.value.trim();
    if (!nick || !room) return alert('กรุณาใส่ชื่อและรหัสทริป');

    window.isRiding = true;
    startRideBtn.style.display = 'none';
    leaveBtn.style.display = 'flex'; // ✅ แก้ไข: แสดงปุ่มออกห้อง
    
    const testMicBtn = document.getElementById('testMicBtn'); if (testMicBtn) testMicBtn.disabled = true;
    document.getElementById('membersPanel').style.display = 'block';
    document.getElementById('mapDiv').style.display = 'block';
    document.getElementById('networkStatusPanel').style.display = 'flex';
    document.getElementById('sosBtnMain').style.display = 'flex';
    
    try {
      const unlockCtx = new (window.AudioContext || window.webkitAudioContext)();
      await unlockCtx.resume(); // ✅ Resume ก่อนเริ่ม
      const stream = await window.startMainMic();
      window.ClearWayWebRTC.joinVoiceRoom(room, nick, stream);
      window.requestWakeLock(); window.initMap();
    } catch (err) {
      console.error(err); window.isRiding = false; startRideBtn.style.display = 'flex'; leaveBtn.style.display = 'none';
      if (testMicBtn) testMicBtn.disabled = false;
      document.getElementById('membersPanel').style.display = 'none';
      document.getElementById('mapDiv').style.display = 'none';
      document.getElementById('networkStatusPanel').style.display = 'none';
      document.getElementById('sosBtnMain').style.display = 'none';
    }
  } else {
    // กดเริ่มใหม่จะไม่ทำอะไร ต้องกดออกห้องเท่านั้น
  }
};

window.leaveRoom = function() {
  if (!window.isRiding) return;
  window.isRiding = false;
  document.getElementById('startRideBtn').style.display = 'flex';
  document.getElementById('leaveRoomBtn').style.display = 'none';
  document.getElementById('startBtnText').innerText = 'เริ่มสนทนา';
  document.querySelector('#startRideBtn .btn-icon').innerText = '🏍️';
  
  const testMicBtn = document.getElementById('testMicBtn'); if (testMicBtn) testMicBtn.disabled = false;
  document.getElementById('membersPanel').style.display = 'none';
  document.getElementById('mapDiv').style.display = 'none';
  document.getElementById('networkStatusPanel').style.display = 'none';
  document.getElementById('sosBtnMain').style.display = 'none';
  
  window.stopMainMic();
  if (window.ClearWayWebRTC.leaveVoiceRoom) window.ClearWayWebRTC.leaveVoiceRoom();
  window.releaseWakeLock();
};

window.ttMap = null; window.ttMarkers = {};
window.initMap = function() {
  if (window.ttMap) return; const mapDiv = document.getElementById('map'); if (!mapDiv) return;
  window.ttMap = L.map('map').setView([13.7367, 100.5231], 13);
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { attribution: '© OpenStreetMap' }).addTo(window.ttMap);
  setTimeout(() => window.ttMap.invalidateSize(), 500);
};
window.updateMap = function(roomState) {
  if (!window.ttMap) return;
  Object.keys(roomState).forEach(id => {
    const user = roomState[id];
    if (user.location && user.location.lat !== 0) {
      if (!window.ttMarkers[id]) { window.ttMarkers[id] = L.marker([user.location.lat, user.location.lng]).addTo(window.ttMap).bindPopup(user.nickname); }
      else window.ttMarkers[id].setLatLng([user.location.lat, user.location.lng]);
    }
  });
};
window.ClearWayUI = {
  renderMembers: (roomState, myPeerId) => {
    const list = document.getElementById('memberList'); if (!list) return;
    list.innerHTML = '';
    Object.keys(roomState).forEach(id => {
      const user = roomState[id]; const li = document.createElement('li');
      li.className = `member-item ${user.isTalking ? 'talking' : ''} ${user.sos ? 'sos-alert' : ''}`;
      li.innerHTML = `<span class="mic-icon">${user.isTalking ? '🔊' : '🔇'}</span><span class="member-name">${user.nickname} ${id === myPeerId ? '(คุณ)' : ''}</span>${user.sos ? '<span class="sos-tag">🆘 SOS</span>' : ''}`;
      list.appendChild(li);
    });
    window.updateMap(roomState);
  }
};

document.addEventListener('DOMContentLoaded', () => {
  if (document.getElementById('startRideBtn')) document.getElementById('startRideBtn').addEventListener('click', window.toggleRide);
  
  const presetSelector = document.getElementById('presetSelector');
  if (presetSelector) {
    presetSelector.addEventListener('change', (e) => {
      const val = e.target.value; if (!val) return; localStorage.setItem('lastSelectedPreset', val);
      let p = val.startsWith('custom_') ? window.customPresets[val.replace('custom_', '')] : PRESETS[val];
      if (p) {
        document.getElementById('thresholdSlider').value = p.threshold;
        document.getElementById('holdTimeSlider').value = p.hold;
        document.getElementById('highpassSlider').value = p.hp;
        document.getElementById('gainSlider').value = p.gain;
        if (window.applyPresetToAudio) window.applyPresetToAudio(p.hp, p.gain / 10);
        updateSliderLabels();
      }
    });
  }
  
  ['thresholdSlider', 'holdTimeSlider', 'highpassSlider', 'gainSlider'].forEach(id => {
    const el = document.getElementById(id); if (el) el.addEventListener('input', updateSliderLabels);
  });
  
  if (document.getElementById('savePresetBtn')) document.getElementById('savePresetBtn').addEventListener('click', savePreset);
  if (document.getElementById('deletePresetBtn')) document.getElementById('deletePresetBtn').addEventListener('click', deletePreset);
  
  // 🔽 SOS BUTTON (Mobile & Desktop Compatible)
  const sosBtn = document.getElementById('sosBtnMain');
  if (sosBtn) {
    let isSOS = false;
    sosBtn.addEventListener('click', () => {
      isSOS = !isSOS;
      sosBtn.classList.toggle('active', isSOS);
      window.ClearWayWebRTC.sendSOS(isSOS);
      if (isSOS) window.playSOSAlert(); // ✅ เรียกเสียงทันทีที่กด
    });
  }
  
  const vadToggle = document.getElementById('vadToggle'); const vadContent = document.getElementById('vadContent'); const vadIcon = document.getElementById('vadIcon');
  if (vadToggle && vadContent && vadIcon) { vadToggle.addEventListener('click', () => { vadContent.classList.toggle('collapsed'); vadIcon.innerText = vadContent.classList.contains('collapsed') ? '▶' : '▼'; }); }
  
  // 🔽 LONG-PRESS 5s ENGINE (Robust Touch/Mouse)
  const leaveBtn = document.getElementById('leaveRoomBtn');
  if (leaveBtn) {
    let pressStart = 0, animFrame = null;
    const HOLD_MS = 5000;
    const startPress = (e) => {
      if (e.type === 'touchstart') e.preventDefault();
      pressStart = Date.now(); leaveBtn.classList.add('pressing');
      requestAnimationFrame(animate);
    };
    const cancelPress = () => {
      cancelAnimationFrame(animFrame); leaveBtn.classList.remove('pressing');
      leaveBtn.style.transform = ''; leaveBtn.style.borderColor = ''; leaveBtn.style.background = '';
      leaveBtn.querySelector('.btn-text').innerText = 'ออกจากห้อง';
    };
    const animate = () => {
      const elapsed = Date.now() - pressStart;
      const progress = Math.min(elapsed / HOLD_MS, 1);
      const remain = (1 - progress).toFixed(1);
      leaveBtn.querySelector('.btn-text').innerText = `ค้างไว้ ${remain}s`;
      leaveBtn.style.transform = `scale(${0.97 + progress * 0.03})`;
      leaveBtn.style.borderColor = `var(--danger-color)`;
      leaveBtn.style.background = `rgba(255, 75, 75, ${progress * 0.4})`;
      if (progress < 1) animFrame = requestAnimationFrame(animate);
      else { leaveBtn.classList.remove('pressing'); window.leaveRoom(); }
    };
    leaveBtn.addEventListener('mousedown', startPress);
    leaveBtn.addEventListener('touchstart', startPress, { passive: false });
    leaveBtn.addEventListener('mouseup', cancelPress);
    leaveBtn.addEventListener('mouseleave', cancelPress);
    leaveBtn.addEventListener('touchend', cancelPress);
    leaveBtn.addEventListener('touchcancel', cancelPress);
  }
  
  loadPresets(); updateSliderLabels();
});
