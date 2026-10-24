'use strict';

const express = require('express');
const multer = require('multer');
const QRCode = require('qrcode');
const rateLimit = require('express-rate-limit');
const { DatabaseSync } = require('node:sqlite');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// ---------- Config ----------
const PORT = Number(process.env.PORT) || 3000;
const BASE_URL = (process.env.BASE_URL || '').replace(/\/+$/, '');
const MAX_FILE_MB = Number(process.env.MAX_FILE_MB) || 500;
const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(__dirname, 'data'));
const UPLOAD_DIR = path.join(DATA_DIR, 'files');
const CLEANUP_EVERY_MS = 30 * 1000;

// Allowed lifetimes (key -> seconds). The client may only pick from these.
const EXPIRY_OPTIONS = {
  '5m': 5 * 60,
  '10m': 10 * 60,
  '30m': 30 * 60,
  '1h': 60 * 60,
  '6h': 6 * 60 * 60,
  '12h': 12 * 60 * 60,
  '1d': 24 * 60 * 60,
  '3d': 3 * 24 * 60 * 60,
  '7d': 7 * 24 * 60 * 60,
};
const DOWNLOAD_OPTIONS = [1, 2, 3, 4, 5, 10, 25, 50, 100];

fs.mkdirSync(UPLOAD_DIR, { recursive: true });

// ---------- Database ----------
const db = new DatabaseSync(path.join(DATA_DIR, 'dropqr.db'));
db.exec(`
  PRAGMA journal_mode = WAL;
  CREATE TABLE IF NOT EXISTS files (
    id             TEXT PRIMARY KEY,
    stored_name    TEXT NOT NULL,
    original_name  TEXT NOT NULL,
    mime           TEXT NOT NULL,
    size           INTEGER NOT NULL,
    created_at     INTEGER NOT NULL,
    expires_at     INTEGER NOT NULL,
    max_downloads  INTEGER NOT NULL,
    downloads      INTEGER NOT NULL DEFAULT 0,
    delete_token   TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_files_expires ON files(expires_at);
`);

const q = {
  insert: db.prepare(`INSERT INTO files
    (id, stored_name, original_name, mime, size, created_at, expires_at, max_downloads, delete_token)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`),
  get: db.prepare('SELECT * FROM files WHERE id = ?'),
  // Atomically claim one download slot; returns the row only if a slot was available.
  claim: db.prepare(`UPDATE files SET downloads = downloads + 1
    WHERE id = ? AND downloads < max_downloads AND expires_at > ?
    RETURNING *`),
  release: db.prepare('UPDATE files SET downloads = downloads - 1 WHERE id = ? AND downloads > 0'),
  remove: db.prepare('DELETE FROM files WHERE id = ?'),
  expired: db.prepare('SELECT id, stored_name FROM files WHERE expires_at <= ? OR downloads >= max_downloads'),
};

const now = () => Date.now();
const newId = () => crypto.randomBytes(6).toString('base64url'); // 8 chars, ~48 bits
const newToken = () => crypto.randomBytes(24).toString('base64url');

// Files currently being streamed: stored_name -> number of open downloads.
// Deleting the DB row stops new access at once; the file on disk is removed
// only after every running download for it has finished.
const streaming = new Map();
const pendingUnlink = new Set();

function unlinkStored(storedName) {
  if (streaming.get(storedName)) { pendingUnlink.add(storedName); return; }
  pendingUnlink.delete(storedName);
  fs.rm(path.join(UPLOAD_DIR, storedName), { force: true }, () => {});
}

function deleteFile(row) {
  q.remove.run(row.id);
  unlinkStored(row.stored_name);
}

function isActive(row) {
  return row && row.expires_at > now() && row.downloads < row.max_downloads;
}

function publicMeta(row) {
  return {
    id: row.id,
    name: row.original_name,
    size: row.size,
    mime: row.mime,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    maxDownloads: row.max_downloads,
    downloads: row.downloads,
    remaining: Math.max(0, row.max_downloads - row.downloads),
  };
}

// Pick the address used inside share links / QR codes.
// On localhost we swap in the LAN IP so a phone on the same Wi-Fi can scan it.
function lanIp() {
  for (const list of Object.values(os.networkInterfaces())) {
    for (const ni of list || []) {
      if (ni.family === 'IPv4' && !ni.internal) return ni.address;
    }
  }
  return null;
}
function baseUrlFor(req) {
  if (BASE_URL) return BASE_URL;
  const host = req.get('host') || `localhost:${PORT}`;
  const [hostname, port] = host.split(':');
  if (['localhost', '127.0.0.1', '[::1]'].includes(hostname)) {
    const ip = lanIp();
    if (ip) return `${req.protocol}://${ip}${port ? ':' + port : ''}`;
  }
  return `${req.protocol}://${host}`;
}

// ---------- App ----------
const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 1);

app.use((req, res, next) => {
  res.set({
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'X-Frame-Options': 'DENY',
  });
  next();
});

const upload = multer({
  storage: multer.diskStorage({
    destination: UPLOAD_DIR,
    filename: (_req, _file, cb) => cb(null, crypto.randomBytes(16).toString('hex')),
  }),
  limits: { fileSize: MAX_FILE_MB * 1024 * 1024, files: 1 },
});

const uploadLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 30, standardHeaders: true, legacyHeaders: false });
const apiLimiter = rateLimit({ windowMs: 60 * 1000, limit: 120, standardHeaders: true, legacyHeaders: false });

// Used by Railway / Docker to know the app is alive.
app.get('/healthz', (_req, res) => {
  db.prepare('SELECT 1').get();
  res.json({ ok: true });
});

app.get('/api/config', (_req, res) => {
  res.json({ expiryOptions: Object.keys(EXPIRY_OPTIONS), downloadOptions: DOWNLOAD_OPTIONS, maxFileMb: MAX_FILE_MB });
});

app.post('/api/upload', uploadLimiter, (req, res) => {
  upload.single('file')(req, res, async (err) => {
    if (err) {
      const msg = err.code === 'LIMIT_FILE_SIZE' ? `File is larger than ${MAX_FILE_MB} MB.` : 'Upload failed.';
      return res.status(400).json({ error: msg });
    }
    if (!req.file) return res.status(400).json({ error: 'No file received.' });

    const seconds = EXPIRY_OPTIONS[req.body.expiry];
    const maxDownloads = Number(req.body.maxDownloads);
    if (!seconds || !DOWNLOAD_OPTIONS.includes(maxDownloads)) {
      fs.rm(req.file.path, { force: true }, () => {});
      return res.status(400).json({ error: 'Invalid expiry or download limit.' });
    }

    // multer decodes the filename as latin1; restore UTF-8 (Arabic names etc.)
    const originalName = Buffer.from(req.file.originalname, 'latin1').toString('utf8').slice(0, 255);
    const id = newId();
    const deleteToken = newToken();
    const createdAt = now();
    const expiresAt = createdAt + seconds * 1000;

    q.insert.run(id, req.file.filename, originalName, req.file.mimetype || 'application/octet-stream',
      req.file.size, createdAt, expiresAt, maxDownloads, deleteToken);

    const url = `${baseUrlFor(req)}/f/${id}`;
    const qrOpts = { errorCorrectionLevel: 'M', margin: 1, color: { dark: '#0b1020', light: '#ffffff' } };
    const [qrSvg, qrPng] = await Promise.all([
      QRCode.toString(url, { ...qrOpts, type: 'svg' }),
      QRCode.toDataURL(url, { ...qrOpts, width: 600 }),
    ]);

    res.status(201).json({ ...publicMeta(q.get.get(id)), url, qrSvg, qrPng, deleteToken });
  });
});

app.get('/api/files/:id', apiLimiter, (req, res) => {
  const row = q.get.get(req.params.id);
  if (!row) return res.status(404).json({ error: 'This link does not exist or was removed.' });
  if (!isActive(row)) {
    deleteFile(row);
    return res.status(410).json({ error: 'This link has expired.' });
  }
  res.json(publicMeta(row));
});

app.delete('/api/files/:id', apiLimiter, (req, res) => {
  const row = q.get.get(req.params.id);
  const token = req.get('x-delete-token') || '';
  if (!row) return res.status(404).json({ error: 'Not found.' });
  const a = Buffer.from(token);
  const b = Buffer.from(row.delete_token);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return res.status(403).json({ error: 'Not allowed.' });
  deleteFile(row);
  res.json({ ok: true });
});

// The actual download. Only this route consumes a download slot,
// so link previews / opening the share page do not use one up.
app.get('/d/:id', apiLimiter, (req, res) => {
  const row = q.claim.get(req.params.id, now());
  if (!row) {
    const existing = q.get.get(req.params.id);
    if (existing) deleteFile(existing);
    return res.redirect(303, `/f/${encodeURIComponent(req.params.id)}`);
  }

  const filePath = path.join(UPLOAD_DIR, row.stored_name);
  streaming.set(row.stored_name, (streaming.get(row.stored_name) || 0) + 1);
  let finished = false;
  res.on('finish', () => { finished = true; });
  res.on('close', () => {
    streaming.set(row.stored_name, streaming.get(row.stored_name) - 1);
    if (!finished) q.release.run(row.id); // aborted: give the slot back
    else if (row.downloads >= row.max_downloads) deleteFile(row); // last download done
    if (pendingUnlink.has(row.stored_name)) unlinkStored(row.stored_name);
  });

  res.set('Cache-Control', 'no-store');
  res.download(filePath, row.original_name, { dotfiles: 'deny' }, (err) => {
    if (err && !res.headersSent) res.status(410).send('File is no longer available.');
  });
});

app.get('/f/:id', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'download.html')));
app.use(express.static(path.join(__dirname, 'public'), { extensions: ['html'] }));
app.use((_req, res) => res.status(404).sendFile(path.join(__dirname, 'public', '404.html')));

// ---------- Cleanup ----------
function cleanup() {
  for (const row of q.expired.all(now())) deleteFile(row);
  // Remove orphan files that have no DB row (e.g. crashed mid-upload).
  const known = new Set(db.prepare('SELECT stored_name FROM files').all().map((r) => r.stored_name));
  for (const name of fs.readdirSync(UPLOAD_DIR)) {
    if (known.has(name) || streaming.get(name)) continue;
    const p = path.join(UPLOAD_DIR, name);
    fs.stat(p, (e, st) => { if (!e && now() - st.mtimeMs > 60 * 60 * 1000) fs.rm(p, { force: true }, () => {}); });
  }
}
cleanup();
setInterval(cleanup, CLEANUP_EVERY_MS).unref();

const server = app.listen(PORT, '0.0.0.0', () => {
  const ip = lanIp();
  console.log(`DropQR running:\n  Local:   http://localhost:${PORT}`);
  if (ip && !BASE_URL) console.log(`  Network: http://${ip}:${PORT}`);
  if (BASE_URL) console.log(`  Public:  ${BASE_URL}`);
});
// Large uploads on slow connections can take a while; don't cut them off.
server.requestTimeout = 0;

// Stop cleanly when the host restarts or redeploys the app.
function shutdown(signal) {
  console.log(`${signal} received, shutting down…`);
  server.close(() => { db.close(); process.exit(0); });
  setTimeout(() => process.exit(0), 10_000).unref();
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
