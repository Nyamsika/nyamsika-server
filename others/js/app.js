const APP_NAME = window.__APP_NAME__ || 'NYAMSIKA LAN Com';
const state = {
  socket: null,
  user: null,
  currentChat: 'group',
  messages: [],
  online: [],
  selectedIds: new Set(),
  config: null,
  pendingFiles: []
};

let peerConnection = null;
let localStream = null;
let isCallActive = false;
let currentCallPeer = null;
let currentCallType = null;
let mediaRecorder = null;
let audioChunks = [];
let recordingStartTime = null;
let recordingTimer = null;
let pendingRemoteCandidates = [];

const $ = (id) => document.getElementById(id);

function randomId() {
  const existing = localStorage.getItem('ny_device_id');
  if (existing) return existing;
  const id = `dev_${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;
  localStorage.setItem('ny_device_id', id);
  return id;
}

function isMobileView() {
  return window.innerWidth <= 980;
}

function openSidePanel() {
  if (!isMobileView()) return;
  $('sidePanel').classList.add('show');
  $('mobileMask').classList.add('show');
}

function closeSidePanel() {
  $('sidePanel').classList.remove('show');
  $('mobileMask').classList.remove('show');
}

function toast(message, type = 'success') {
  const box = $('notice');
  box.className = `notice show${type === 'error' ? ' error' : ''}`;
  box.textContent = message;
  clearTimeout(window.__toastTimer);
  window.__toastTimer = setTimeout(() => {
    box.className = 'notice';
  }, 2600);
}

function escapeHtml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function bytesToSize(bytes = 0) {
  if (!bytes) return '0 B';
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  return `${(bytes / Math.pow(1024, i)).toFixed(i > 1 ? 2 : 0)} ${sizes[i]}`;
}

function timeOnly(v) {
  const d = new Date(v);
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

async function api(url, options = {}) {
  const response = await fetch(url, {
    headers: {
      ...(options.body instanceof FormData ? {} : { 'Content-Type': 'application/json' }),
      ...(options.headers || {})
    },
    ...options
  });
  let data = {};
  try {
    data = await response.json();
  } catch (_error) {
    data = {};
  }
  if (!response.ok) throw new Error(data.message || 'Request failed');
  return data;
}

async function loadConfig() {
  state.config = await api('/api/config');
}

function showModal(html, large = false) {
  $('modalBox').className = `modal${large ? ' large' : ''}`;
  $('modalBox').innerHTML = html;
  $('overlay').classList.add('show');
}

function closeModal() {
  $('overlay').classList.remove('show');
  $('modalBox').innerHTML = '';
}

function updateSelectionBar() {
  const count = state.selectedIds.size;
  $('selectionCountText').textContent = `${count} selected`;
  $('selectionBar').classList.toggle('hidden', count === 0);
}

function adjustTextareaHeight() {
  const ta = $('messageInput');
  ta.style.height = '20px';
  ta.style.height = `${Math.min(ta.scrollHeight, 100)}px`;
}

function toggleVisibility(id, btn) {
  const el = $(id);
  const hidden = el.type === 'password';
  el.type = hidden ? 'text' : 'password';
  btn.textContent = hidden ? 'Hide' : 'Show';
}

function updateSelectedFilesInfo() {
  const count = state.pendingFiles.length;
  const infoDiv = $('selectedFilesInfo');
  const countSpan = $('selectedFilesCount');
  if (count > 0) {
    countSpan.textContent = `${count} file(s) selected`;
    infoDiv.classList.add('show');
  } else {
    infoDiv.classList.remove('show');
  }
}

function clearSelectedFiles() {
  state.pendingFiles = [];
  $('fileInput').value = '';
  updateSelectedFilesInfo();
  toast('Files cleared');
}

function handleFileSelect() {
  const input = $('fileInput');
  state.pendingFiles = [...(input.files || [])];
  updateSelectedFilesInfo();
}

async function sendFilesOnly() {
  if (!state.pendingFiles.length || !state.user) return false;
  try {
    const fd = new FormData();
    fd.append('senderId', state.user.deviceId);
    fd.append('senderName', state.user.name);
    fd.append('targetType', state.currentChat === 'group' ? 'group' : 'direct');
    fd.append('targetId', state.currentChat === 'group' ? 'group' : state.currentChat);
    state.pendingFiles.forEach((file) => fd.append('files', file));
    const res = await fetch('/api/upload', { method: 'POST', body: fd });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.message || 'Upload failed');
    state.pendingFiles = [];
    $('fileInput').value = '';
    updateSelectedFilesInfo();
    toast('File(s) sent successfully');
    setTimeout(() => scrollToBottom(true), 60);
    return true;
  } catch (error) {
    toast(error.message || 'File send failed', 'error');
    return false;
  }
}

async function sendTextOnly() {
  const input = $('messageInput');
  const text = input.value.trim();
  if (!text || !state.socket || !state.user) return false;
  state.socket.emit('message:text', {
    senderId: state.user.deviceId,
    senderName: state.user.name,
    targetType: state.currentChat === 'group' ? 'group' : 'direct',
    targetId: state.currentChat === 'group' ? 'group' : state.currentChat,
    textContent: text
  });
  input.value = '';
  adjustTextareaHeight();
  setTimeout(() => scrollToBottom(true), 60);
  return true;
}

async function sendMessage() {
  let sent = false;
  if (state.pendingFiles.length > 0) {
    await sendFilesOnly();
    sent = true;
  }
  if ($('messageInput').value.trim().length > 0) {
    await sendTextOnly();
    sent = true;
  }
  if (!sent) toast('Type a message or select files first', 'error');
}

function openMobileMenu() {
  showModal(`
    <div class="modal-head">
      <div><h3>Menu</h3><div class="muted small">Select an option</div></div>
      <button class="btn btn-soft" onclick="closeModal()">Close</button>
    </div>
    <div style="display:flex;flex-direction:column;gap:10px;">
      <button class="btn btn-primary menu-item" onclick="closeModal(); openQrGuard();">📱 Open QR</button>
      <button class="btn btn-primary menu-item" onclick="closeModal(); openPasswordManager();">🔑 Change Passwords</button>
      <button class="btn btn-danger menu-item" onclick="closeModal(); logout();">🚪 Exit</button>
    </div>
  `);
}

async function openQrGuard() {
  if (!state.config) await loadConfig();
  showModal(`
    <div class="modal-head">
      <div><h3>Protected QR join</h3><div class="muted small">Show QR only after correct password</div></div>
      <button class="btn btn-soft" onclick="closeModal()">Close</button>
    </div>
    <div class="field">
      <label>QR password</label>
      <div class="password-wrap">
        <input id="qrPasswordInput" class="input" type="password" placeholder="Enter QR password" />
        <button type="button" class="toggle-eye" onclick="toggleVisibility('qrPasswordInput', this)">Show</button>
      </div>
    </div>
    <div class="row" style="margin-top:14px;"><button class="btn btn-primary" onclick="unlockQr()">Unlock QR</button></div>
    <div class="field"><label>LAN address</label><div class="input" style="background:#f8fcff;">${escapeHtml(state.config.baseUrlMasked)}</div></div>
    <div id="qrHiddenState" class="qr-box">
      <div style="text-align:center;"><div style="font-size:46px;margin-bottom:8px;">🔒</div><div style="font-weight:800;">QR locked</div><div class="muted small">Join address hidden until unlocked</div></div>
    </div>
  `);
}

async function unlockQr() {
  try {
    const password = $('qrPasswordInput').value;
    await api('/api/verify-password', { method: 'POST', body: JSON.stringify({ area: 'qr', password }) });
    $('qrHiddenState').innerHTML = `
      <div style="width:100%;text-align:center;">
        <img src="${state.config.qrDataUrl}" alt="Join QR" />
        <div style="margin-top:12px;font-weight:800;color:#1565c0;">Scan to open app</div>
        <div class="muted small">Other device still needs access password</div>
      </div>
    `;
    toast('QR unlocked successfully');
  } catch (error) {
    toast(error.message || 'Wrong password', 'error');
  }
}

function openPasswordManager() {
  const areas = ['access', 'qr', 'delete'];
  let cards = '';
  for (const area of areas) {
    cards += `
      <div class="tool-card">
        <div style="display:flex;justify-content:space-between;gap:12px;align-items:center;">
          <div>
            <div style="font-weight:800;text-transform:capitalize;">${area} password</div>
            <div class="muted small">Change ${area} password</div>
          </div>
          <span class="chip">Protected</span>
        </div>
        <div class="row" style="margin-top:12px;">
          <div class="field" style="margin-top:0;"><label>Previous password</label><input id="${area}_prev" class="input" type="password" placeholder="Previous password" /></div>
          <div class="field" style="margin-top:0;"><label>New password</label><input id="${area}_new" class="input" type="password" placeholder="New password" /></div>
        </div>
        <div style="margin-top:12px;"><button class="btn btn-primary" onclick="changePassword('${area}')">Save ${area} password</button></div>
      </div>
    `;
  }

  showModal(`
    <div class="modal-head">
      <div><h3>Change protected passwords</h3><div class="muted small">Enter old password before saving a new one</div></div>
      <button class="btn btn-soft" onclick="closeModal()">Close</button>
    </div>
    <div style="display:grid;gap:12px;margin-top:12px;">${cards}</div>
  `, true);
}

async function changePassword(area) {
  try {
    await api('/api/change-password', {
      method: 'POST',
      body: JSON.stringify({
        area,
        previousPassword: $(`${area}_prev`).value,
        newPassword: $(`${area}_new`).value
      })
    });
    $(`${area}_prev`).value = '';
    $(`${area}_new`).value = '';
    toast(`${area} password updated`);
  } catch (error) {
    toast(error.message || 'Password change failed', 'error');
  }
}

async function enterApp() {
  try {
    const displayName = $('displayName').value.trim();
    const password = $('accessPassword').value;
    if (!displayName) return toast('Please enter your display name', 'error');
    await api('/api/verify-password', { method: 'POST', body: JSON.stringify({ area: 'access', password }) });
    state.user = { deviceId: randomId(), name: displayName };
    localStorage.setItem('ny_display_name', displayName);
    $('authScreen').classList.add('hidden');
    $('appScreen').classList.remove('hidden');
    $('myIdentity').textContent = displayName;
    $('accessPassword').value = '';
    connectSocket();
    toast(`Welcome to ${APP_NAME}`);
  } catch (error) {
    toast(error.message || 'Access denied', 'error');
  }
}

function cleanupPeerConnection() {
  if (peerConnection) {
    try {
      peerConnection.onicecandidate = null;
      peerConnection.ontrack = null;
      peerConnection.onconnectionstatechange = null;
      peerConnection.oniceconnectionstatechange = null;
      peerConnection.close();
    } catch (_error) {
      // ignore close errors
    }
  }
  peerConnection = null;
  pendingRemoteCandidates = [];
}

function cleanupLocalMedia() {
  if (localStream) {
    localStream.getTracks().forEach((track) => track.stop());
  }
  localStream = null;
  $('localVideo').srcObject = null;
  $('remoteVideo').srcObject = null;
  $('remoteAudio').srcObject = null;
}

function hideCallUi() {
  $('callContainer').classList.remove('show');
  $('localVideo').style.display = 'none';
}

async function flushPendingCandidates() {
  if (!peerConnection || !peerConnection.remoteDescription) return;
  const queue = [...pendingRemoteCandidates];
  pendingRemoteCandidates = [];
  for (const candidate of queue) {
    try {
      await peerConnection.addIceCandidate(new RTCIceCandidate(candidate));
    } catch (error) {
      console.error('ICE flush error:', error);
    }
  }
}

function applyRemoteStream(stream) {
  const hasVideo = stream.getVideoTracks().length > 0;
  $('remoteAudio').srcObject = stream;
  if (hasVideo || currentCallType === 'video') {
    $('remoteVideo').srcObject = stream;
  } else {
    $('remoteVideo').srcObject = null;
  }
}

function createPeerConnection() {
  const configuration = {
    iceServers: [
      { urls: 'stun:stun.l.google.com:19302' },
      { urls: 'stun:stun1.l.google.com:19302' }
    ]
  };

  peerConnection = new RTCPeerConnection(configuration);

  peerConnection.ontrack = (event) => {
    if (event.streams && event.streams[0]) applyRemoteStream(event.streams[0]);
  };

  peerConnection.onicecandidate = (event) => {
    if (!event.candidate || !state.socket || !currentCallPeer || !state.user) return;
    state.socket.emit('call:signal', {
      to: currentCallPeer,
      from: state.user.deviceId,
      signal: event.candidate,
      type: 'candidate'
    });
  };

  peerConnection.onconnectionstatechange = () => {
    const stateName = peerConnection?.connectionState;
    if (['failed', 'closed', 'disconnected'].includes(stateName)) {
      toast('Call ended');
      hangUp(false);
    }
  };

  peerConnection.oniceconnectionstatechange = () => {
    const iceState = peerConnection?.iceConnectionState;
    if (['failed', 'closed', 'disconnected'].includes(iceState)) {
      toast('Call connection lost');
      hangUp(false);
    }
  };

  if (localStream) {
    localStream.getTracks().forEach((track) => {
      peerConnection.addTrack(track, localStream);
    });
  }
}

async function prepareLocalMedia(callType) {
  const constraints = { audio: true, video: callType === 'video' };
  localStream = await navigator.mediaDevices.getUserMedia(constraints);
  if (callType === 'video') {
    $('localVideo').srcObject = localStream;
    $('localVideo').style.display = 'block';
  } else {
    $('localVideo').style.display = 'none';
  }
  $('callContainer').classList.add('show');
}

async function initCall(callType) {
  try {
    if (state.currentChat === 'group') {
      toast('Calls only available for direct chats', 'error');
      return;
    }
    if (!state.user || !state.socket) {
      toast('Connect first before starting a call', 'error');
      return;
    }
    if (isCallActive) hangUp(false);

    currentCallType = callType;
    currentCallPeer = state.currentChat;
    toast('Requesting camera/microphone access...');
    await prepareLocalMedia(callType);
    createPeerConnection();

    const offer = await peerConnection.createOffer({ offerToReceiveAudio: true, offerToReceiveVideo: callType === 'video' });
    await peerConnection.setLocalDescription(offer);

    state.socket.emit('call:start', {
      to: state.currentChat,
      from: state.user.deviceId,
      fromName: state.user.name,
      offer,
      callType
    });

    isCallActive = true;
    toast('Calling...');
  } catch (error) {
    console.error('Call init error:', error);
    hangUp(false);
    const secureHint = window.location.protocol === 'https:' || window.location.hostname === 'localhost'
      ? 'Please check browser permissions.'
      : 'Chrome requires HTTPS or localhost for camera and microphone access.';
    toast(`Could not access camera/microphone. ${secureHint}`, 'error');
  }
}

function startVoiceCall() {
  initCall('audio');
}

function startVideoCall() {
  initCall('video');
}

function toggleMute() {
  if (!localStream) return;
  const audioTrack = localStream.getAudioTracks()[0];
  if (!audioTrack) return;
  audioTrack.enabled = !audioTrack.enabled;
  toast(audioTrack.enabled ? 'Microphone on' : 'Microphone off');
}

function toggleLocalVideo() {
  if (!localStream) return;
  const videoTrack = localStream.getVideoTracks()[0];
  if (!videoTrack) {
    toast('No camera enabled for this call', 'error');
    return;
  }
  videoTrack.enabled = !videoTrack.enabled;
  toast(videoTrack.enabled ? 'Camera on' : 'Camera off');
}

function hangUp(notifyPeer = true) {
  const peerToNotify = currentCallPeer;
  cleanupPeerConnection();
  cleanupLocalMedia();
  hideCallUi();
  if (notifyPeer && isCallActive && peerToNotify && state.socket && state.user) {
    state.socket.emit('call:end', { to: peerToNotify, from: state.user.deviceId });
  }
  isCallActive = false;
  currentCallPeer = null;
  currentCallType = null;
}

async function handleIncomingCall(data) {
  const accepted = window.confirm(`${data.fromName} is calling you for a ${data.callType === 'video' ? 'video' : 'voice'} call. Accept?`);
  if (!accepted) {
    state.socket.emit('call:reject', { to: data.from, from: state.user.deviceId });
    return;
  }

  try {
    if (isCallActive) hangUp(false);
    currentCallPeer = data.from;
    currentCallType = data.callType;
    await prepareLocalMedia(data.callType);
    createPeerConnection();
    await peerConnection.setRemoteDescription(new RTCSessionDescription(data.offer));
    await flushPendingCandidates();
    const answer = await peerConnection.createAnswer();
    await peerConnection.setLocalDescription(answer);
    state.socket.emit('call:accept', {
      to: data.from,
      from: state.user.deviceId,
      answer,
      callType: data.callType
    });
    isCallActive = true;
    toast('Call connected');
  } catch (error) {
    console.error('Accept call error:', error);
    hangUp(false);
    const secureHint = window.location.protocol === 'https:' || window.location.hostname === 'localhost'
      ? 'Please check browser permissions.'
      : 'Chrome requires HTTPS or localhost for camera and microphone access.';
    toast(`Could not accept call. ${secureHint}`, 'error');
  }
}

async function handleSignal(data) {
  if (!data || data.type !== 'candidate' || !data.signal) return;
  if (!peerConnection || !peerConnection.remoteDescription) {
    pendingRemoteCandidates.push(data.signal);
    return;
  }
  try {
    await peerConnection.addIceCandidate(new RTCIceCandidate(data.signal));
  } catch (error) {
    console.error('ICE candidate error:', error);
  }
}

async function startVoiceRecording() {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    const mimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus') ? 'audio/webm;codecs=opus' : 'audio/webm';
    mediaRecorder = new MediaRecorder(stream, { mimeType });
    audioChunks = [];

    mediaRecorder.ondataavailable = (event) => {
      if (event.data && event.data.size > 0) audioChunks.push(event.data);
    };

    mediaRecorder.onstop = async () => {
      const audioBlob = new Blob(audioChunks, { type: mimeType.includes('opus') ? 'audio/webm' : mimeType });
      const audioFile = new File([audioBlob], `voice_${Date.now()}.webm`, { type: 'audio/webm' });
      state.pendingFiles.push(audioFile);
      updateSelectedFilesInfo();
      toast('Voice message recorded and added to files');
      stream.getTracks().forEach((track) => track.stop());
    };

    mediaRecorder.start();
    recordingStartTime = Date.now();
    recordingTimer = setInterval(updateRecordingTime, 1000);
    $('voiceRecordBtn').classList.add('recording');
    $('voiceRecordingIndicator').classList.add('show');
    toast('Recording voice message... Click again to stop');
  } catch (_error) {
    const secureHint = window.location.protocol === 'https:' || window.location.hostname === 'localhost'
      ? 'Please check browser permissions.'
      : 'Chrome requires HTTPS or localhost for microphone access.';
    toast(`Microphone access denied. ${secureHint}`, 'error');
  }
}

function updateRecordingTime() {
  const elapsed = Math.floor((Date.now() - recordingStartTime) / 1000);
  const minutes = Math.floor(elapsed / 60);
  const seconds = elapsed % 60;
  $('recordingTime').textContent = `${minutes}:${String(seconds).padStart(2, '0')}`;
}

function stopVoiceRecording() {
  if (mediaRecorder && mediaRecorder.state === 'recording') {
    mediaRecorder.stop();
    clearInterval(recordingTimer);
    $('voiceRecordBtn').classList.remove('recording');
    $('voiceRecordingIndicator').classList.remove('show');
  }
}

function toggleVoiceRecording() {
  if (mediaRecorder && mediaRecorder.state === 'recording') stopVoiceRecording();
  else startVoiceRecording();
}

function updateOnlineUsers() {
  $('onlineCount').textContent = state.online.length;
  const users = state.online || [];

  $('onlineUsers').innerHTML = users.map((user) => {
    const active = state.currentChat === user.deviceId ? ' active' : '';
    const me = state.user && user.deviceId === state.user.deviceId;
    const initials = (user.name || '?').slice(0, 2).toUpperCase();
    return `
      <div class="device${active}" onclick="selectChat('${user.deviceId}')">
        <div class="device-left">
          <div class="avatar">${escapeHtml(initials)}</div>
          <div style="min-width:0;">
            <div style="font-weight:800;">${escapeHtml(user.name)} ${me ? '<span class="tiny muted">(You)</span>' : ''}</div>
          </div>
        </div>
        <span class="chip blue">●</span>
      </div>
    `;
  }).join('') || '<div class="muted small">No device online yet.</div>';

  document.querySelectorAll('.side .device[data-chat="group"]').forEach((el) => {
    el.classList.toggle('active', state.currentChat === 'group');
  });
}

function selectChat(target) {
  state.currentChat = target;
  state.selectedIds.clear();
  updateSelectionBar();
  document.querySelectorAll('.side .device').forEach((el) => el.classList.remove('active'));
  const groupBtn = document.querySelector('.side .device[data-chat="group"]');
  if (target === 'group' && groupBtn) groupBtn.classList.add('active');

  const callButtons = $('callButtons');
  if (target === 'group') callButtons.style.display = 'none';
  else callButtons.style.display = 'flex';

  updateOnlineUsers();
  const peer = state.online.find((u) => u.deviceId === target);
  const title = target === 'group' ? 'Group' : (peer ? peer.name : 'Direct');
  $('chatTitle').textContent = title;
  $('chatSubtitle').textContent = '';
  $('selectedChatChip').textContent = `To: ${title}`;
  $('chatAvatar').textContent = target === 'group' ? 'G' : ((peer?.name || '?').slice(0, 2).toUpperCase());
  refreshMessages();
  if (isMobileView()) closeSidePanel();
}

async function refreshMessages() {
  if (!state.user) return;
  try {
    const data = await api(`/api/messages?viewer=${encodeURIComponent(state.user.deviceId)}&peer=${encodeURIComponent(state.currentChat)}`);
    state.messages = data.messages || [];
    renderMessages();
  } catch (error) {
    toast(error.message || 'Unable to refresh', 'error');
  }
}

function visibleMessages() {
  if (!state.user) return [];
  if (state.currentChat === 'group') return state.messages.filter((m) => m.targetType === 'group');
  return state.messages.filter((m) => m.targetType === 'direct' && (
    (m.senderId === state.user.deviceId && m.targetId === state.currentChat) ||
    (m.senderId === state.currentChat && m.targetId === state.user.deviceId)
  ));
}

function messageMediaHtml(m) {
  const safeName = escapeHtml(m.fileName || 'file');
  const mimeType = m.mimeType || '';
  const icon = mimeType.startsWith('image/') ? '🖼️' : mimeType.startsWith('video/') ? '🎬' : mimeType.startsWith('audio/') ? '🎵' : '📎';
  const card = `
    <div class="file-card">
      <div style="font-size:22px;">${icon}</div>
      <div style="min-width:0;flex:1;">
        <div class="file-name">${safeName}</div>
        <div class="small muted">${escapeHtml(bytesToSize(m.fileSize || 0))}</div>
      </div>
      <a class="btn btn-soft" href="${m.filePath}" download="${safeName}" style="padding:6px 10px;font-size:11px;">Open</a>
    </div>
  `;
  if (mimeType.startsWith('image/')) {
    return `${card}<div class="thumb" onclick="openImage('${m.filePath}', '${safeName}')"><img src="${m.filePath}" alt="${safeName}" /></div>`;
  }
  if (mimeType.startsWith('video/')) {
    return `${card}<div class="video-preview"><video controls playsinline src="${m.filePath}"></video></div>`;
  }
  if (mimeType.startsWith('audio/')) {
    return `${card}<div class="audio-preview"><audio controls src="${m.filePath}"></audio></div>`;
  }
  return card;
}

function renderMessages(forceBottom = false) {
  const box = $('messages');
  const list = visibleMessages();
  updateSelectionBar();
  if (!list.length) {
    box.innerHTML = '<div class="empty"><div><div style="font-size:40px;margin-bottom:8px;">💬</div><p class="muted">No messages yet</p></div></div>';
    return;
  }

  let html = '';
  for (const m of list) {
    const mine = state.user && m.senderId === state.user.deviceId;
    const checked = state.selectedIds.has(Number(m.id)) ? 'checked' : '';
    html += `
      <div class="bubble-wrap ${mine ? 'me' : 'other'}">
        <div class="bubble-row">
          <input class="selector" type="checkbox" ${checked} onchange="toggleSelect(${Number(m.id)}, this.checked)" />
          <div class="bubble ${mine ? 'me' : 'other'}">
            <div class="sender-label">${escapeHtml(mine ? 'You' : m.senderName)}</div>
            ${m.contentType === 'text' ? `<div class="msg-text">${escapeHtml(m.textContent || '')}</div>` : messageMediaHtml(m)}
            <div class="bubble-footer"><span>${escapeHtml(timeOnly(m.createdAt))}</span></div>
          </div>
        </div>
      </div>
    `;
  }
  box.innerHTML = html;
  const nearBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 140;
  if (forceBottom || nearBottom) setTimeout(() => scrollToBottom(true), 20);
}

function toggleSelect(id, checked) {
  if (checked) state.selectedIds.add(Number(id));
  else state.selectedIds.delete(Number(id));
  updateSelectionBar();
}

function requestDeleteSelected() {
  const ids = [...state.selectedIds];
  if (!ids.length) return toast('Select item(s) to delete first', 'error');
  showModal(`
    <div class="modal-head">
      <div><h3>Delete selected item(s)</h3><div class="muted small">This removes database record and stored file permanently</div></div>
      <button class="btn btn-soft" onclick="closeModal()">Close</button>
    </div>
    <div class="field">
      <label>Delete password</label>
      <div class="password-wrap">
        <input id="deletePasswordInput" class="input" type="password" placeholder="Enter delete password" />
        <button type="button" class="toggle-eye" onclick="toggleVisibility('deletePasswordInput', this)">Show</button>
      </div>
    </div>
    <div class="row" style="margin-top:14px;"><button class="btn btn-danger" onclick="confirmDeleteItems([${ids.join(',')}])">Confirm delete</button></div>
  `);
}

async function confirmDeleteItems(ids) {
  try {
    const password = $('deletePasswordInput').value;
    for (const id of ids) {
      const res = await fetch(`/api/messages/${id}`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password })
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.message || 'Delete failed');
    }
    state.selectedIds.clear();
    updateSelectionBar();
    closeModal();
    toast('Item(s) permanently deleted');
  } catch (error) {
    toast(error.message || 'Delete failed', 'error');
  }
}

function openImage(src, name) {
  showModal(`
    <div class="modal-head">
      <div><h3>${escapeHtml(name)}</h3><div class="muted small">Expanded image preview</div></div>
      <button class="btn btn-soft" onclick="closeModal()">Close</button>
    </div>
    <div style="text-align:center;"><img class="img-view" src="${src}" alt="${escapeHtml(name)}" /></div>
  `, true);
}

function scrollToBottom(force) {
  const box = $('messages');
  if (!box) return;
  box.scrollTop = box.scrollHeight;
  if (force) $('scrollBottomBtn').classList.add('hidden');
}

function connectSocket() {
  if (state.socket) state.socket.disconnect();
  const socket = io({ transports: ['websocket', 'polling'] });
  state.socket = socket;

  socket.on('connect', () => socket.emit('register', state.user));
  socket.on('connect_error', () => toast('Realtime connection failed', 'error'));
  socket.on('error:server', (payload) => toast(payload?.message || 'Server error', 'error'));
  socket.on('sync:init', (payload) => {
    state.online = payload.online || [];
    state.messages = payload.messages || [];
    updateOnlineUsers();
    renderMessages();
  });
  socket.on('presence:update', (payload) => {
    state.online = payload.online || [];
    updateOnlineUsers();
  });
  socket.on('message:new', (message) => {
    state.messages.push(message);
    renderMessages(true);
  });
  socket.on('message:deleted', ({ id }) => {
    state.messages = state.messages.filter((m) => Number(m.id) !== Number(id));
    state.selectedIds.delete(Number(id));
    renderMessages();
  });
  socket.on('call:incoming', handleIncomingCall);
  socket.on('call:accepted', async (data) => {
    try {
      if (!peerConnection) return;
      currentCallPeer = data.from || currentCallPeer;
      await peerConnection.setRemoteDescription(new RTCSessionDescription(data.answer));
      await flushPendingCandidates();
      toast('Call connected');
    } catch (error) {
      console.error('Accept response error:', error);
      toast('Could not establish call', 'error');
      hangUp(false);
    }
  });
  socket.on('call:signal', handleSignal);
  socket.on('call:rejected', () => {
    toast('Call rejected');
    hangUp(false);
  });
  socket.on('call:ended', () => {
    toast('Call ended');
    hangUp(false);
  });
}

function logout() {
  if (state.socket) state.socket.disconnect();
  hangUp(false);
  state.socket = null;
  state.user = null;
  state.online = [];
  state.messages = [];
  state.selectedIds.clear();
  state.pendingFiles = [];
  $('messages').innerHTML = '';
  $('appScreen').classList.add('hidden');
  $('authScreen').classList.remove('hidden');
  closeSidePanel();
  updateSelectionBar();
  updateSelectedFilesInfo();
  toast('Logged out');
}

window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    closeModal();
    closeSidePanel();
  }
});

window.addEventListener('resize', () => {
  if (!isMobileView()) closeSidePanel();
  adjustTextareaHeight();
});

$('overlay').addEventListener('click', (e) => {
  if (e.target.id === 'overlay') closeModal();
});

$('messageInput').addEventListener('input', adjustTextareaHeight);
$('messageInput').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    sendMessage();
  }
});
$('messages').addEventListener('scroll', () => {
  const box = $('messages');
  const nearBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 120;
  $('scrollBottomBtn').classList.toggle('hidden', nearBottom || $('appScreen').classList.contains('hidden'));
});

window.enterApp = enterApp;
window.logout = logout;
window.openQrGuard = openQrGuard;
window.unlockQr = unlockQr;
window.changePassword = changePassword;
window.openPasswordManager = openPasswordManager;
window.selectChat = selectChat;
window.refreshMessages = refreshMessages;
window.sendMessage = sendMessage;
window.handleFileSelect = handleFileSelect;
window.clearSelectedFiles = clearSelectedFiles;
window.requestDeleteSelected = requestDeleteSelected;
window.confirmDeleteItems = confirmDeleteItems;
window.openImage = openImage;
window.scrollToBottom = scrollToBottom;
window.toggleSelect = toggleSelect;
window.closeModal = closeModal;
window.toggleVisibility = toggleVisibility;
window.openSidePanel = openSidePanel;
window.closeSidePanel = closeSidePanel;
window.openMobileMenu = openMobileMenu;
window.toggleVoiceRecording = toggleVoiceRecording;
window.startVoiceCall = startVoiceCall;
window.startVideoCall = startVideoCall;
window.toggleMute = toggleMute;
window.toggleLocalVideo = toggleLocalVideo;
window.hangUp = hangUp;

(async function bootstrap() {
  try {
    await loadConfig();
    const savedName = localStorage.getItem('ny_display_name');
    if (savedName) $('displayName').value = savedName;
    adjustTextareaHeight();
    if (state.config && !state.config.isSecure && window.location.hostname !== 'localhost') {
      toast('For Chrome mic/camera on LAN, use HTTPS with SSL files', 'error');
    }
  } catch (_error) {
    toast('Could not load app configuration', 'error');
  }
})();
