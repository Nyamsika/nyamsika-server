const fs = require('fs');
const path = require('path');
const os = require('os');
const http = require('http');
const https = require('https');
const crypto = require('crypto');
const { spawnSync } = require('child_process');
const express = require('express');
const multer = require('multer');
const sqlite3 = require('sqlite3').verbose();
const { Server } = require('socket.io');
const QRCode = require('qrcode');

const APP_NAME = 'NYAMSIKA LAN Com';
const HTTP_PORT = Number(process.env.PORT || 3000);
const HTTPS_PORT = Number(process.env.HTTPS_PORT || 3443);
const ROOT_DIR = path.join(__dirname, '..');
const DB_FILE = path.join(ROOT_DIR, 'others', 'nyamsika_lan.sqlite');
const UPLOAD_DIR = path.join(ROOT_DIR, 'others', 'uploads');
const HTML_FILE = path.join(ROOT_DIR, 'html', 'index.html');
const CSS_DIR = path.join(ROOT_DIR, 'css');
const JS_DIR = path.join(ROOT_DIR, 'others', 'js');
const SSL_DIR = path.join(ROOT_DIR, 'others', 'ssl');
const DEFAULT_SSL_KEY = path.join(SSL_DIR, 'localhost-key.pem');
const DEFAULT_SSL_CERT = path.join(SSL_DIR, 'localhost-cert.pem');
const FILE_SIZE_LIMIT = Number(process.env.MAX_FILE_SIZE_MB || 512) * 1024 * 1024;

if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });
if (!fs.existsSync(SSL_DIR)) fs.mkdirSync(SSL_DIR, { recursive: true });

const app = express();
const db = new sqlite3.Database(DB_FILE);
const onlineUsers = new Map();

function run(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function onRun(err) {
      if (err) reject(err);
      else resolve(this);
    });
  });
}

function get(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => {
      if (err) reject(err);
      else resolve(row);
    });
  });
}

function all(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => {
      if (err) reject(err);
      else resolve(rows);
    });
  });
}

async function initDb() {
  await run(`CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  )`);

  await run(`CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    sender_id TEXT NOT NULL,
    sender_name TEXT NOT NULL,
    target_type TEXT NOT NULL,
    target_id TEXT NOT NULL,
    content_type TEXT NOT NULL,
    text_content TEXT,
    file_name TEXT,
    stored_name TEXT,
    file_path TEXT,
    mime_type TEXT,
    file_size INTEGER DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);

  await run(`CREATE TABLE IF NOT EXISTS devices (
    device_id TEXT PRIMARY KEY,
    display_name TEXT NOT NULL,
    last_seen DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);

  const defaults = {
    access_password: '5680',
    qr_password: '5680',
    delete_password: '5680'
  };

  for (const [key, value] of Object.entries(defaults)) {
    const row = await get('SELECT value FROM settings WHERE key=?', [key]);
    if (!row) await run('INSERT INTO settings(key, value) VALUES(?, ?)', [key, value]);
  }
}

function guessLanIp() {
  const nets = os.networkInterfaces();
  for (const name of Object.keys(nets)) {
    for (const net of nets[name] || []) {
      if (net.family === 'IPv4' && !net.internal) return net.address;
    }
  }
  return '127.0.0.1';
}

function safeFileName(name) {
  return String(name || 'file')
    .replace(/[\\/:*?"<>|]+/g, '_')
    .replace(/\s+/g, ' ')
    .trim();
}

function maskUrl(url) {
  return String(url || '').replace(/(https?:\/\/)([^/]+)/i, '$1••••••••');
}

function publicBaseUrl(req) {
  const protocolHeader = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim();
  const protocol = protocolHeader || (req.secure || req.socket.encrypted ? 'https' : 'http');
  const host = req.headers.host || `${guessLanIp()}:${protocol === 'https' ? HTTPS_PORT : HTTP_PORT}`;
  return `${protocol}://${host}`;
}

function createMessagePayload(row) {
  return {
    id: row.id,
    senderId: row.sender_id,
    senderName: row.sender_name,
    targetType: row.target_type,
    targetId: row.target_id,
    contentType: row.content_type,
    textContent: row.text_content,
    fileName: row.file_name,
    storedName: row.stored_name,
    filePath: row.file_path,
    mimeType: row.mime_type,
    fileSize: row.file_size,
    createdAt: row.created_at
  };
}

async function getSetting(key) {
  const row = await get('SELECT value FROM settings WHERE key=?', [key]);
  return row ? row.value : null;
}

async function setSetting(key, value) {
  await run(
    'INSERT INTO settings(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value',
    [key, value]
  );
}

function onlineSnapshot() {
  const unique = new Map();
  for (const [, user] of onlineUsers) unique.set(user.deviceId, user);
  return [...unique.values()].sort((a, b) => a.name.localeCompare(b.name));
}

function socketsForDevice(deviceId) {
  const ids = [];
  for (const [socketId, user] of onlineUsers.entries()) {
    if (user.deviceId === deviceId) ids.push(socketId);
  }
  return ids;
}

function emitMessageNew(io, message) {
  if (message.targetType === 'group') {
    io.emit('message:new', message);
    return;
  }
  const targets = new Set([
    ...socketsForDevice(message.senderId),
    ...socketsForDevice(message.targetId)
  ]);
  for (const id of targets) io.to(id).emit('message:new', message);
}

function emitMessageDeleted(io, row) {
  const payload = { id: row.id };
  if (row.target_type === 'group') {
    io.emit('message:deleted', payload);
    return;
  }
  const targets = new Set([
    ...socketsForDevice(row.sender_id),
    ...socketsForDevice(row.target_id)
  ]);
  for (const id of targets) io.to(id).emit('message:deleted', payload);
}

async function fetchMessagesForChat(viewer, peer = 'group') {
  if (peer === 'group') {
    return all(`SELECT * FROM messages WHERE target_type='group' ORDER BY id ASC`);
  }
  return all(
    `SELECT * FROM messages
     WHERE target_type='direct'
       AND ((sender_id=? AND target_id=?) OR (sender_id=? AND target_id=?))
     ORDER BY id ASC`,
    [viewer, peer, peer, viewer]
  );
}

async function fetchMessagesForUser(user) {
  return all(
    `SELECT * FROM messages
     WHERE target_type='group'
        OR (target_type='direct' AND ((sender_id=? AND target_id=?) OR (sender_id=? AND target_id=?)))
     ORDER BY id ASC`,
    [user.deviceId, user.deviceId, user.deviceId, user.deviceId]
  );
}

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, UPLOAD_DIR),
  filename: (_req, file, cb) => {
    const unique = `${Date.now()}_${crypto.randomBytes(5).toString('hex')}`;
    cb(null, `${unique}__${safeFileName(file.originalname)}`);
  }
});

const upload = multer({
  storage,
  limits: { fileSize: FILE_SIZE_LIMIT, files: 100 }
});

function loadHtmlTemplate() {
  return fs.readFileSync(HTML_FILE, 'utf8').replace(/__APP_NAME__/g, APP_NAME);
}

function ensureSelfSignedSslIfPossible(keyPath, certPath) {
  if (fs.existsSync(keyPath) && fs.existsSync(certPath)) return true;
  if (process.env.AUTO_GENERATE_SSL === '0') return false;

  const lanIp = guessLanIp();
  const san = `subjectAltName=DNS:localhost,IP:127.0.0.1${lanIp && lanIp !== '127.0.0.1' ? `,IP:${lanIp}` : ''}`;
  const result = spawnSync('openssl', [
    'req', '-x509', '-newkey', 'rsa:2048', '-sha256', '-nodes',
    '-keyout', keyPath,
    '-out', certPath,
    '-days', '365',
    '-subj', '/CN=localhost',
    '-addext', san
  ], { stdio: 'ignore' });

  return result.status === 0 && fs.existsSync(keyPath) && fs.existsSync(certPath);
}

function sslOptionsIfAvailable() {
  const keyPath = process.env.SSL_KEY_PATH || DEFAULT_SSL_KEY;
  const certPath = process.env.SSL_CERT_PATH || DEFAULT_SSL_CERT;
  ensureSelfSignedSslIfPossible(keyPath, certPath);
  if (fs.existsSync(keyPath) && fs.existsSync(certPath)) {
    return {
      key: fs.readFileSync(keyPath),
      cert: fs.readFileSync(certPath),
      keyPath,
      certPath
    };
  }
  return null;
}

app.set('trust proxy', true);
app.use(express.json({ limit: '100mb' }));
app.use(express.urlencoded({ extended: true, limit: '100mb' }));
app.use('/css', express.static(CSS_DIR, {
  etag: false,
  setHeaders: (res) => res.setHeader('Cache-Control', 'no-store')
}));
app.use('/others/js', express.static(JS_DIR, {
  etag: false,
  setHeaders: (res) => res.setHeader('Cache-Control', 'no-store')
}));
app.use('/uploads', express.static(UPLOAD_DIR, {
  etag: false,
  setHeaders: (res) => res.setHeader('Cache-Control', 'no-store')
}));

app.get('/', (_req, res) => {
  res.type('html').send(loadHtmlTemplate());
});

app.get('/api/config', async (req, res) => {
  try {
    const baseUrl = publicBaseUrl(req);
    const qrDataUrl = await QRCode.toDataURL(baseUrl, {
      margin: 1,
      color: { dark: '#1d1e1fdc', light: '#ffffff' },
      width: 280
    });
    res.json({
      appName: APP_NAME,
      baseUrl,
      baseUrlMasked: maskUrl(baseUrl),
      qrDataUrl,
      maxFileSizeMb: Math.round(FILE_SIZE_LIMIT / 1024 / 1024),
      isSecure: baseUrl.startsWith('https://')
    });
  } catch (error) {
    res.status(500).json({ ok: false, message: error.message || 'Unable to prepare QR data.' });
  }
});

app.post('/api/verify-password', async (req, res) => {
  try {
    const { area, password } = req.body || {};
    const map = { access: 'access_password', qr: 'qr_password', delete: 'delete_password' };
    const key = map[area];
    if (!key) return res.status(400).json({ ok: false, message: 'Unknown protected area.' });
    const saved = await getSetting(key);
    if (String(password || '') === String(saved || '')) return res.json({ ok: true });
    return res.status(401).json({ ok: false, message: 'Wrong password.' });
  } catch (error) {
    return res.status(500).json({ ok: false, message: error.message || 'Password verification failed.' });
  }
});

app.post('/api/change-password', async (req, res) => {
  try {
    const { area, previousPassword, newPassword } = req.body || {};
    const map = { access: 'access_password', qr: 'qr_password', delete: 'delete_password' };
    const key = map[area];
    if (!key) return res.status(400).json({ ok: false, message: 'Unknown password area.' });
    if (!newPassword || !String(newPassword).trim()) {
      return res.status(400).json({ ok: false, message: 'New password cannot be empty.' });
    }
    const saved = await getSetting(key);
    if (String(previousPassword || '') !== String(saved || '')) {
      return res.status(401).json({ ok: false, message: 'Previous password is wrong.' });
    }
    await setSetting(key, String(newPassword));
    return res.json({ ok: true, message: `${area} password changed successfully.` });
  } catch (error) {
    return res.status(500).json({ ok: false, message: error.message || 'Password change failed.' });
  }
});

function buildAbsoluteUploadPath(storedName) {
  return path.join(UPLOAD_DIR, storedName);
}

let io = null;

app.post('/api/upload', upload.array('files', 100), async (req, res) => {
  try {
    const senderId = String(req.body.senderId || '').trim();
    const senderName = String(req.body.senderName || '').trim();
    const targetType = String(req.body.targetType || 'group').trim() === 'direct' ? 'direct' : 'group';
    const targetId = String(req.body.targetId || 'group').trim();

    if (!senderId || !senderName) {
      return res.status(400).json({ ok: false, message: 'Missing sender details.' });
    }

    const inserted = [];
    for (const file of (req.files || [])) {
      const result = await run(
        `INSERT INTO messages (
          sender_id, sender_name, target_type, target_id, content_type,
          file_name, stored_name, file_path, mime_type, file_size
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          senderId,
          senderName,
          targetType,
          targetId,
          'file',
          safeFileName(file.originalname),
          file.filename,
          `/uploads/${file.filename}`,
          file.mimetype,
          file.size
        ]
      );
      const row = await get('SELECT * FROM messages WHERE id=?', [result.lastID]);
      inserted.push(createMessagePayload(row));
    }

    for (const message of inserted) emitMessageNew(io, message);
    return res.json({ ok: true, messages: inserted });
  } catch (error) {
    return res.status(500).json({ ok: false, message: error.message || 'Upload failed.' });
  }
});

app.get('/api/messages', async (req, res) => {
  try {
    const viewer = String(req.query.viewer || '').trim();
    const peer = String(req.query.peer || 'group').trim();
    if (!viewer) return res.status(400).json({ ok: false, message: 'Missing viewer.' });
    const rows = await fetchMessagesForChat(viewer, peer);
    return res.json({ ok: true, messages: rows.map(createMessagePayload) });
  } catch (error) {
    return res.status(500).json({ ok: false, message: error.message || 'Unable to read messages.' });
  }
});

app.delete('/api/messages/:id', async (req, res) => {
  try {
    const id = Number(req.params.id);
    const { password } = req.body || {};
    const saved = await getSetting('delete_password');
    if (String(password || '') !== String(saved || '')) {
      return res.status(401).json({ ok: false, message: 'Wrong delete password.' });
    }

    const row = await get('SELECT * FROM messages WHERE id=?', [id]);
    if (!row) return res.status(404).json({ ok: false, message: 'Item not found.' });

    await run('DELETE FROM messages WHERE id=?', [id]);
    if (row.stored_name) {
      const absolute = buildAbsoluteUploadPath(row.stored_name);
      if (fs.existsSync(absolute)) {
        try {
          fs.unlinkSync(absolute);
        } catch (_error) {
          // ignore unlink errors
        }
      }
    }

    emitMessageDeleted(io, row);
    return res.json({ ok: true, message: 'Item permanently deleted.' });
  } catch (error) {
    return res.status(500).json({ ok: false, message: error.message || 'Delete failed.' });
  }
});

function attachSocketHandlers(socketServer) {
  socketServer.on('connection', (socket) => {
    socket.on('register', async (user) => {
      try {
        if (!user || !user.deviceId || !user.name) return;
        const clean = {
          socketId: socket.id,
          deviceId: String(user.deviceId),
          name: String(user.name).slice(0, 32)
        };
        onlineUsers.set(socket.id, clean);
        await run(
          `INSERT INTO devices(device_id, display_name, last_seen)
           VALUES(?,?,CURRENT_TIMESTAMP)
           ON CONFLICT(device_id)
           DO UPDATE SET display_name=excluded.display_name,last_seen=CURRENT_TIMESTAMP`,
          [clean.deviceId, clean.name]
        );
        const messages = await fetchMessagesForUser(clean);
        socket.emit('sync:init', {
          self: clean,
          online: onlineSnapshot(),
          messages: messages.map(createMessagePayload)
        });
        socketServer.emit('presence:update', { online: onlineSnapshot() });
      } catch (error) {
        socket.emit('error:server', { message: error.message || 'Registration failed.' });
      }
    });

    socket.on('message:text', async (payload) => {
      try {
        if (!payload || !payload.senderId || !payload.senderName) return;
        const targetType = String(payload.targetType || 'group').trim() === 'direct' ? 'direct' : 'group';
        const targetId = String(payload.targetId || 'group');
        const result = await run(
          `INSERT INTO messages (
            sender_id, sender_name, target_type, target_id, content_type, text_content
          ) VALUES (?, ?, ?, ?, 'text', ?)`,
          [
            String(payload.senderId),
            String(payload.senderName),
            targetType,
            targetId,
            String(payload.textContent || '')
          ]
        );
        const row = await get('SELECT * FROM messages WHERE id=?', [result.lastID]);
        emitMessageNew(socketServer, createMessagePayload(row));
      } catch (error) {
        socket.emit('error:server', { message: error.message || 'Message send failed.' });
      }
    });

    socket.on('call:start', (data) => {
      const targetSockets = socketsForDevice(data.to);
      targetSockets.forEach((socketId) => {
        socketServer.to(socketId).emit('call:incoming', {
          from: data.from,
          fromName: data.fromName,
          offer: data.offer,
          callType: data.callType
        });
      });
    });

    socket.on('call:accept', (data) => {
      const targetSockets = socketsForDevice(data.to);
      targetSockets.forEach((socketId) => {
        socketServer.to(socketId).emit('call:accepted', {
          from: data.from,
          answer: data.answer,
          callType: data.callType
        });
      });
    });

    socket.on('call:signal', (data) => {
      const targetSockets = socketsForDevice(data.to);
      targetSockets.forEach((socketId) => {
        socketServer.to(socketId).emit('call:signal', {
          from: data.from,
          signal: data.signal,
          type: data.type
        });
      });
    });

    socket.on('call:reject', (data) => {
      const targetSockets = socketsForDevice(data.to);
      targetSockets.forEach((socketId) => {
        socketServer.to(socketId).emit('call:rejected', { from: data.from });
      });
    });

    socket.on('call:end', (data) => {
      if (!data || !data.to) return;
      const targetSockets = socketsForDevice(data.to);
      targetSockets.forEach((socketId) => {
        socketServer.to(socketId).emit('call:ended', { from: data.from });
      });
    });

    socket.on('disconnect', () => {
      onlineUsers.delete(socket.id);
      socketServer.emit('presence:update', { online: onlineSnapshot() });
    });
  });
}

function createMainServer() {
  const ssl = sslOptionsIfAvailable();
  if (ssl) {
    const httpsServer = https.createServer({ key: ssl.key, cert: ssl.cert }, app);
    const redirectServer = http.createServer((req, res) => {
      const hostHeader = req.headers.host || `${guessLanIp()}:${HTTP_PORT}`;
      const hostname = hostHeader.replace(/:\d+$/, '');
      const httpsHost = `${hostname}:${HTTPS_PORT}`;
      res.writeHead(301, { Location: `https://${httpsHost}${req.url}` });
      res.end();
    });
    return { server: httpsServer, redirectServer, ssl };
  }
  return { server: http.createServer(app), redirectServer: null, ssl: null };
}

(async () => {
  try {
    await initDb();
    const { server, redirectServer, ssl } = createMainServer();

    io = new Server(server, {
      maxHttpBufferSize: FILE_SIZE_LIMIT,
      cors: { origin: '*' }
    });

    attachSocketHandlers(io);

    const listenPort = ssl ? HTTPS_PORT : HTTP_PORT;
    server.listen(listenPort, '0.0.0.0', () => {
      const lan = guessLanIp();
      console.log('==============================================');
      console.log(`${APP_NAME} is running`);
      if (ssl) {
        console.log(`HTTPS Local: https://localhost:${HTTPS_PORT}`);
        console.log(`HTTPS LAN:   https://${lan}:${HTTPS_PORT}`);
        console.log(`HTTP redirect: http://${lan}:${HTTP_PORT} -> HTTPS`);
        console.log(`SSL key:  ${ssl.keyPath}`);
        console.log(`SSL cert: ${ssl.certPath}`);
      } else {
        console.log(`Local:   http://localhost:${HTTP_PORT}`);
        console.log(`LAN:     http://${lan}:${HTTP_PORT}`);
        console.log('HTTPS disabled: add SSL cert/key files or install OpenSSL for auto-generated certs.');
      }
      console.log(`SQLite:  ${DB_FILE}`);
      console.log(`Uploads: ${UPLOAD_DIR}`);
      console.log('Default passwords: 5680');
      console.log('==============================================');
      console.log('NEW FEATURES:');
      console.log('- Voice calls: Click VOICE CALL button next to user name in direct chat');
      console.log('- Video calls: Click VID CALL button next to user name in direct chat');
      console.log('- Voice recording: Click VOICE REC button in composer, then press SEND');
      console.log('==============================================');
    });

    if (redirectServer) {
      redirectServer.listen(HTTP_PORT, '0.0.0.0');
    }
  } catch (error) {
    console.error('Failed to start app:', error);
    process.exit(1);
  }
})();
