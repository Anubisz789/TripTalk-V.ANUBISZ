// asset/js/app.js - UI Controller for TripTalk v6.0.0

// 🟢 NAVIGATION SYSTEM
function initNavigation() {
  const navItems = document.querySelectorAll('.nav-item');
  const panels = document.querySelectorAll('.view-panel');

  navItems.forEach(item => {
    item.addEventListener('click', () => {
      const targetView = item.getAttribute('data-view');
      
      // Update Active Nav
      navItems.forEach(i => i.classList.remove('active'));
      item.classList.add('active');

      // Show Target Panel
      panels.forEach(p => {
        p.style.display = p.id === targetView ? 'block' : 'none';
        if (p.id === targetView) p.classList.add('active');
        else p.classList.remove('active');
      });

      // Special case for Map: ensure it renders correctly when shown
      if (targetView === 'rideView' && window.ttMap) {
        setTimeout(() => window.ttMap.invalidateSize(), 300);
      }
    });
  });
}

// 🟢 SOS SYSTEM
let sosAudioCtx = null;
let sosInterval = null;

window.playSOSAlert = function(isActive) {
  if (!isActive) {
    const hasOtherSOS = window.roomState ? Object.values(window.roomState).some(u => u.sos) : false;
    if (!hasOtherSOS && sosInterval) { clearInterval(sosInterval); sosInterval = null; }
    return;
  }
  if (sosInterval) return;

  if (!sosAudioCtx) sosAudioCtx = new (window.AudioContext || window.webkitAudioContext)();
  if (sosAudioCtx.state === 'suspended') sosAudioCtx.resume();

  const triggerSound = () => {
    try {
      const osc = sosAudioCtx.createOscillator(); const gain = sosAudioCtx.createGain();
      osc.connect(gain); gain.connect(sosAudioCtx.destination);
      const now = sosAudioCtx.currentTime;
      gain.gain.setValueAtTime(0, now);
      gain.gain.linearRampToValueAtTime(0.8, now + 0.1);
      gain.gain.exponentialRampToValueAtTime(0.01, now + 0.9);
      osc.frequency.setValueAtTime(880, now); 
      osc.frequency.exponentialRampToValueAtTime(440, now + 0.5);
      osc.start(now); osc.stop(now + 1.0);
      if (navigator.vibrate) navigator.vibrate([300, 100, 300]);
    } catch(e) {}
  };
  triggerSound();
  sosInterval = setInterval(triggerSound, 1200);
};

function initSOS() {
  const sosBtn = document.getElementById('sosBtnMain');
  const progressCircle = document.getElementById('sosProgressCircle');
  if (!sosBtn || !progressCircle) return;

  let isSOS = false;
  let sosHoldTimer = null;
  let sosProgressInterval = null;
  const SOS_HOLD_MS = 3000; // Adjusted to 3s for better UX
  const CIRCUMFERENCE = 2 * Math.PI * 45;

  const setProgress = (percent) => {
    const offset = CIRCUMFERENCE - (percent * CIRCUMFERENCE);
    progressCircle.style.strokeDashoffset = offset;
  };

  const startPress = (e) => {
    e.preventDefault();
    const startTime = Date.now();
    sosHoldTimer = setTimeout(() => {
      isSOS = !isSOS;
      sosBtn.classList.toggle('active', isSOS);
      window.playSOSAlert(isSOS);
      if (window.ClearWayWebRTC?.sendSOS) window.ClearWayWebRTC.sendSOS(isSOS);
      cancelPress();
    }, SOS_HOLD_MS);

    sosProgressInterval = setInterval(() => {
      const elapsed = Date.now() - startTime;
      const progress = Math.min(elapsed / SOS_HOLD_MS, 1);
      setProgress(progress);
    }, 50);
  };

  const cancelPress = () => {
    clearTimeout(sosHoldTimer);
    clearInterval(sosProgressInterval);
    setProgress(0);
  };

  sosBtn.addEventListener('pointerdown', startPress);
  ['pointerup', 'pointercancel', 'pointerleave'].forEach(ev => sosBtn.addEventListener(ev, cancelPress));
}

// 🟢 RIDE TOGGLE
window.isRiding = false;
window.toggleRide = async function() {
  const nicknameInput = document.getElementById('nicknameInput');
  const roomInput = document.getElementById('roomInput');
  const navRide = document.getElementById('navRide');
  const sosBtn = document.getElementById('sosBtnMain');

  if (!window.isRiding) {
    const nick = nicknameInput.value.trim();
    const room = roomInput.value.trim();
    if (!nick || !room) return alert('กรุณาใส่ชื่อและรหัสทริป');

    window.isRiding = true;
    
    // UI Transitions
    navRide.style.display = 'flex';
    sosBtn.style.display = 'flex';
    document.getElementById('navRide').click(); // Auto switch to ride view
    
    try {
      const stream = await window.startMainMic();
      if (window.ClearWayWebRTC?.joinVoiceRoom) {
        window.ClearWayWebRTC.joinVoiceRoom(room, nick, stream);
      }
      window.initMap();
    } catch (err) {
      console.error(err);
      window.leaveRoom();
    }
  }
};

window.leaveRoom = function() {
  window.isRiding = false;
  document.getElementById('navRide').style.display = 'none';
  document.getElementById('sosBtnMain').style.display = 'none';
  document.getElementById('navHome').click();
  
  window.stopMainMic();
  if (window.ClearWayWebRTC?.leaveVoiceRoom) window.ClearWayWebRTC.leaveVoiceRoom();
};

// 🟢 MAP SYSTEM
window.ttMap = null; window.ttMarkers = {};
window.initMap = function() {
  if (window.ttMap) return;
  const mapDiv = document.getElementById('map'); if (!mapDiv) return;
  window.ttMap = L.map('map').setView([13.7367, 100.5231], 13);
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { attribution: '© OSM' }).addTo(window.ttMap);
  setTimeout(() => window.ttMap.invalidateSize(), 500);
};

window.updateMap = function(roomState) {
  if (!window.ttMap) return;
  Object.keys(roomState).forEach(id => {
    const user = roomState[id];
    if (user.location && user.location.lat !== 0) {
      if (!window.ttMarkers[id]) { 
        window.ttMarkers[id] = L.marker([user.location.lat, user.location.lng]).addTo(window.ttMap).bindPopup(user.nickname); 
      } else {
        window.ttMarkers[id].setLatLng([user.location.lat, user.location.lng]);
      }
    }
  });
};

// 🟢 UI RENDERER (Called by WebRTC.js)
window.ClearWayUI = {
  renderMembers: (roomState, myPeerId) => {
    const list = document.getElementById('memberList'); if (!list) return;
    list.innerHTML = '';
    Object.keys(roomState).forEach(id => {
      const user = roomState[id];
      const li = document.createElement('li');
      li.className = `member-item ${user.isTalking ? 'talking' : ''} ${user.sos ? 'sos-alert' : ''}`;
      li.innerHTML = `
        <div class="mic-status-icon">${user.sos ? '🆘' : (user.isTalking ? '🔊' : '🔇')}</div>
        <div class="member-info">
          <span class="member-name">${user.nickname} ${id === myPeerId ? '(คุณ)' : ''}</span>
          <span class="member-role">${user.role}</span>
        </div>
      `;
      list.appendChild(li);
    });
    window.updateMap(roomState);
  }
};

// 🟢 THEME & SETTINGS
const THEMES = {
  '': '🌙', 'light': '☀️', 'dark': '🌑', 'night-rider': '🏍️', 
  'high-contrast': '⚪', 'ocean': '🌊', 'tropical': '🌴', 'gaming': '🎮'
};

function initSettings() {
  const switcher = document.getElementById('themeSwitcher');
  if (!switcher) return;

  Object.entries(THEMES).forEach(([key, icon]) => {
    const btn = document.createElement('button');
    btn.className = 'theme-btn';
    btn.textContent = icon;
    btn.dataset.theme = key;
    if ((localStorage.getItem('triptalk_theme') || '') === key) btn.classList.add('active');
    
    btn.addEventListener('click', () => {
      document.querySelectorAll('.theme-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      if (key) document.documentElement.setAttribute('data-theme', key);
      else document.documentElement.removeAttribute('data-theme');
      localStorage.setItem('triptalk_theme', key);
    });
    switcher.appendChild(btn);
  });

  // Font Size
  const fsSlider = document.getElementById('fontSizeSlider');
  fsSlider.value = localStorage.getItem('triptalk_fontSize') || '100';
  document.documentElement.style.fontSize = `${fsSlider.value}%`;
  fsSlider.addEventListener('input', (e) => {
    document.documentElement.style.fontSize = `${e.target.value}%`;
    localStorage.setItem('triptalk_fontSize', e.target.value);
  });
}

// 🟢 LEAVE LONG PRESS
function initLeaveBtn() {
  const leaveBtn = document.getElementById('leaveRoomBtn');
  if (!leaveBtn) return;
  let timer = null;
  const HOLD_MS = 3000;

  const startPress = (e) => {
    e.preventDefault();
    leaveBtn.style.background = 'rgba(255, 75, 75, 0.2)';
    timer = setTimeout(() => { window.leaveRoom(); }, HOLD_MS);
  };
  const cancelPress = () => {
    clearTimeout(timer);
    leaveBtn.style.background = '';
  };

  leaveBtn.addEventListener('pointerdown', startPress);
  ['pointerup', 'pointercancel', 'pointerleave'].forEach(ev => leaveBtn.addEventListener(ev, cancelPress));
}

// 🟢 INITIALIZATION
document.addEventListener('DOMContentLoaded', () => {
  initNavigation();
  initSOS();
  initSettings();
  initLeaveBtn();
  
  const startBtn = document.getElementById('startRideBtn');
  if (startBtn) startBtn.addEventListener('click', window.toggleRide);

  // VAD Slider Labels Sync (Simple version for v6)
  ['thresholdSlider', 'holdTimeSlider', 'highpassSlider'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.addEventListener('input', () => {
      if (id === 'thresholdSlider' && document.getElementById('thresholdMarker')) {
        document.getElementById('thresholdMarker').style.left = `${el.value}%`;
      }
    });
  });

  // Load Initial Theme
  const savedTheme = localStorage.getItem('triptalk_theme');
  if (savedTheme) document.documentElement.setAttribute('data-theme', savedTheme);
});
