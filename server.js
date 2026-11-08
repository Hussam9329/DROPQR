'use strict';

const express = require('express');
const QRCode = require('qrcode');
const { neon } = require('@neondatabase/serverless');
const { head, del, issueSignedToken, presignUrl } = require('@vercel/blob');
const { handleUpload } = require('@vercel/blob/client');
const crypto = require('node:crypto');
const path = require('node:path');

// ---------- Config ----------
const PORT = Number(process.env.PORT) || 3000;
const BASE_URL = (process.env.BASE_URL || '').replace(/\/+$/, '');
const MAX_FILE_MB = Number(process.env.MAX_FILE_MB) || 100;
const MAX_FILE_BYTES = MAX_FILE_MB * 1024 * 1024;
// Whole-site storage ceiling and how much one visitor may upload per day.
const STORAGE_CAP_BYTES = (Number(process.env.STORAGE_CAP_GB) || 5) * 1024 ** 3;
const DAILY_UPLOAD_BYTES = (Number(process.env.DAILY_UPLOAD_MB) || 1024) * 1024 ** 2;
// Downloads go straight from storage through a signed link valid this long
// (long enough for a slow connection or a download manager to resume).
const DOWNLOAD_LINK_MS = 15 * 60 * 1000;
// A file stays in storage this long after it stops being downloadable,
// so a download that already started can finish.
const GRACE_MS = DOWNLOAD_LINK_MS + 5 * 60 * 1000;
const PENDING_TTL_MS = 2 * 60 * 60 * 1000; // uploads never finished are dropped after this

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

// ---------- Database (Neon) ----------
const sql = neon(process.env.DATABASE_URL);
const query = (text, params = []) => sql.query(text, params);

// Created once per server instance.
let schemaReady;
function ensureSchema() {
  schemaReady ??= (async () => {
    await query(`CREATE TABLE IF NOT EXISTS files (
      id                TEXT PRIMARY KEY,
      pathname          TEXT NOT NULL UNIQUE,
      original_name     TEXT NOT NULL,
      mime              TEXT NOT NULL,
      size              BIGINT NOT NULL,
      status            TEXT NOT NULL DEFAULT 'pending',
      expiry_seconds    INTEGER NOT NULL,
      max_downloads     INTEGER NOT NULL,
      downloads         INTEGER NOT NULL DEFAULT 0,
      delete_token      TEXT NOT NULL,
      created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
      expires_at        TIMESTAMPTZ,
      last_download_at  TIMESTAMPTZ
    )`);
    await query('CREATE INDEX IF NOT EXISTS idx_files_status_expires ON files (status, expires_at)');
    // Shared counters for rate limits and daily upload quotas, so every server instance sees the same numbers.
    await query(`CREATE TABLE IF NOT EXISTS usage_counters (
      key           TEXT PRIMARY KEY,
      window_start  TIMESTAMPTZ NOT NULL,
      amount        BIGINT NOT NULL
    )`);
  })().catch((err) => { schemaReady = null; throw err; });
  return schemaReady;
}

const newId = () => crypto.randomBytes(6).toString('base64url'); // 8 chars
const newToken = () => crypto.randomBytes(24).toString('base64url');

// Control characters and path separators become "_". Invisible direction and
// zero-width characters are removed, so "invoice<RLO>fdp.exe" cannot pose as a PDF.
function safeFileName(name) {
  const clean = String(name || 'file').normalize('NFC')
    .replace(/[\u061c\u200b-\u200f\u202a-\u202e\u2060-\u2069\ufeff]/g, '')
    .replace(/[\\/\u0000-\u001f\u007f]/g, '_')
    .trim().slice(0, 200);
  return clean || 'file';
}

function publicMeta(row) {
  return {
    id: row.id,
    name: row.original_name,
    size: Number(row.size),
    mime: row.mime,
    createdAt: new Date(row.created_at).getTime(),
    expiresAt: new Date(row.expires_at).getTime(),
    maxDownloads: row.max_downloads,
    downloads: row.downloads,
    remaining: Math.max(0, row.max_downloads - row.downloads),
    serverNow: Date.now(),
  };
}

function isActive(row) {
  return row && row.status === 'ready' && new Date(row.expires_at).getTime() > Date.now()
    && row.downloads < row.max_downloads;
}

function baseUrlFor(req) {
  if (BASE_URL) return BASE_URL;
  return `${req.protocol}://${req.get('host')}`;
}

// Storage first: if that fails the row stays, so the delete can be retried.
async function removeFile(row) {
  await del(row.pathname);
  await query('DELETE FROM files WHERE id = $1', [row.id]);
}

// Visitors are counted by a keyed hash of their IP, never the raw address.
function visitorKey(req) {
  const ip = (process.env.VERCEL && req.get('x-real-ip')) || req.ip || '';
  return crypto.createHmac('sha256', process.env.CRON_SECRET || 'dropqr').update(ip).digest('base64url').slice(0, 22);
}

// Adds `amount` to a counter that resets every `windowSec`, and returns the new total.
async function addUsage(key, windowSec, amount) {
  const [row] = await query(`INSERT INTO usage_counters (key, window_start, amount) VALUES ($1, now(), $3)
    ON CONFLICT (key) DO UPDATE SET
      amount = CASE WHEN usage_counters.window_start <= now() - make_interval(secs => $2)
                    THEN $3 ELSE usage_counters.amount + $3 END,
      window_start = CASE WHEN usage_counters.window_start <= now() - make_interval(secs => $2)
                    THEN now() ELSE usage_counters.window_start END
    RETURNING amount`, [key, windowSec, amount]);
  return Number(row.amount);
}

// Wraps async handlers so errors reach the error handler.
const h = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

function limit(bucket, windowSec, max) {
  return h(async (req, res, next) => {
    const hits = await addUsage(`${bucket}:${visitorKey(req)}`, windowSec, 1);
    if (hits <= max) return next();
    res.set('Retry-After', String(windowSec));
    res.status(429).json({ error: 'Too many requests. Please wait a little and try again.' });
  });
}

// Deletes expired, used-up and abandoned files. Runs from the daily cron
// and, at most once a minute, alongside normal traffic.
let lastCleanup = 0;
async function cleanup() {
  lastCleanup = Date.now();
  await query("DELETE FROM usage_counters WHERE window_start <= now() - interval '1 day'");
  const rows = await query(`SELECT id, pathname FROM files
    WHERE (status = 'ready' AND expires_at <= now() - make_interval(secs => $1))
       OR (status = 'ready' AND downloads >= max_downloads
           AND (last_download_at IS NULL OR last_download_at <= now() - make_interval(secs => $1)))
       OR (status = 'pending' AND created_at <= now() - make_interval(secs => $2))
    LIMIT 500`, [GRACE_MS / 1000, PENDING_TTL_MS / 1000]);
  if (!rows.length) return 0;
  // Keep the rows if storage deletion fails, so the next run retries them.
  await del(rows.map((r) => r.pathname));
  await query('DELETE FROM files WHERE id = ANY($1)', [rows.map((r) => r.id)]);
  return rows.length;
}
function cleanupSoon() {
  if (Date.now() - lastCleanup > 60 * 1000) cleanup().catch((e) => console.error('cleanup failed', e));
}

// ---------- App ----------
const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 1);
app.use(express.json({ limit: '64kb' }));

app.use((req, res, next) => {
  res.set({
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'X-Frame-Options': 'DENY',
  });
  next();
});

app.use('/api', async (_req, _res, next) => {
  try { await ensureSchema(); next(); } catch (err) { next(err); }
});

const uploadLimiter = limit('upload', 15 * 60, 30);
const blobTokenLimiter = limit('blob', 15 * 60, 60);
const completeLimiter = limit('complete', 15 * 60, 30);
const downloadLimiter = limit('download', 15 * 60, 60);
const apiLimiter = limit('api', 60, 120);

app.get('/api/config', (_req, res) => {
  res.json({ expiryOptions: Object.keys(EXPIRY_OPTIONS), downloadOptions: DOWNLOAD_OPTIONS, maxFileMb: MAX_FILE_MB });
});

app.get('/api/health', h(async (_req, res) => {
  await query('SELECT 1');
  res.json({ ok: true });
}));

// Step 1: reserve an id and a storage path for the file.
app.post('/api/uploads', uploadLimiter, h(async (req, res) => {
  const { name, size, type, expiry, maxDownloads } = req.body || {};
  const seconds = EXPIRY_OPTIONS[expiry];
  const max = Number(maxDownloads);
  const bytes = Number(size);
  if (!seconds || !DOWNLOAD_OPTIONS.includes(max)) return res.status(400).json({ error: 'Invalid expiry or download limit.' });
  if (!Number.isSafeInteger(bytes) || bytes <= 0) return res.status(400).json({ error: 'Empty files cannot be shared.' });
  if (bytes > MAX_FILE_BYTES) return res.status(400).json({ error: `File is larger than ${MAX_FILE_MB} MB.` });

  // Unfinished reservations count too, so storage can't be filled by starting many uploads.
  const [{ used }] = await query("SELECT COALESCE(SUM(size), 0) AS used FROM files WHERE status IN ('pending', 'ready')");
  if (Number(used) + bytes > STORAGE_CAP_BYTES) {
    return res.status(503).json({ error: 'The service is full right now. Please try again later.' });
  }
  const quotaKey = `bytes:${visitorKey(req)}`;
  if (await addUsage(quotaKey, 24 * 60 * 60, bytes) > DAILY_UPLOAD_BYTES) {
    await addUsage(quotaKey, 24 * 60 * 60, -bytes); // a refused upload doesn't use up the quota
    return res.status(429).json({ error: "You reached today's upload limit. Please try again tomorrow." });
  }

  const id = newId();
  const fileName = safeFileName(name);
  const pathname = `f/${id}/${fileName}`;
  const deleteToken = newToken();
  await query(`INSERT INTO files (id, pathname, original_name, mime, size, expiry_seconds, max_downloads, delete_token)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
  [id, pathname, fileName, String(type || 'application/octet-stream').slice(0, 200), bytes, seconds, max, deleteToken]);

  cleanupSoon();
  res.status(201).json({ id, pathname, deleteToken });
}));

// Step 2: the browser asks for a one-time token and uploads straight to Blob storage.
app.post('/api/blob-upload', blobTokenLimiter, h(async (req, res) => {
  try {
    const result = await handleUpload({
      body: req.body,
      request: req,
      onBeforeGenerateToken: async (pathname, clientPayload) => {
        const [row] = await query("SELECT * FROM files WHERE id = $1 AND status = 'pending'", [clientPayload]);
        if (!row || row.pathname !== pathname) throw new Error('Upload not allowed.');
        return {
          maximumSizeInBytes: Number(row.size),
          addRandomSuffix: false,
          allowOverwrite: false,
          validUntil: Date.now() + 60 * 60 * 1000,
        };
      },
      // Finalising happens in /complete, so nothing is needed here.
      onUploadCompleted: async () => {},
    });
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err.message || 'Upload failed.' });
  }
}));

// Step 3: confirm the file landed, start its timer, and return the link + QR code.
app.post('/api/uploads/:id/complete', completeLimiter, h(async (req, res) => {
  const [row] = await query('SELECT * FROM files WHERE id = $1', [req.params.id]);
  if (!row || row.delete_token !== String(req.body?.deleteToken || '')) return res.status(404).json({ error: 'Upload not found.' });
  if (row.status !== 'pending') return res.status(409).json({ error: 'Upload already finished.' });

  const blob = await head(row.pathname).catch(() => null);
  if (!blob) return res.status(400).json({ error: 'The file did not finish uploading. Please try again.' });

  const [ready] = await query(`UPDATE files SET status = 'ready', size = $2, mime = $3,
      created_at = now(), expires_at = now() + make_interval(secs => expiry_seconds)
    WHERE id = $1 AND status = 'pending' RETURNING *`, [row.id, blob.size, blob.contentType || row.mime]);
  if (!ready) return res.status(409).json({ error: 'Upload already finished.' });

  const url = `${baseUrlFor(req)}/f/${ready.id}`;
  const qrOpts = { errorCorrectionLevel: 'M', margin: 1, color: { dark: '#0b1020', light: '#ffffff' } };
  const [qrSvg, qrPng] = await Promise.all([
    QRCode.toString(url, { ...qrOpts, type: 'svg' }),
    QRCode.toDataURL(url, { ...qrOpts, width: 600 }),
  ]);
  res.json({ ...publicMeta(ready), url, qrSvg, qrPng, deleteToken: ready.delete_token });
}));

app.get('/api/files/:id', apiLimiter, h(async (req, res) => {
  const [row] = await query('SELECT * FROM files WHERE id = $1', [req.params.id]);
  if (!row || row.status !== 'ready') return res.status(404).json({ error: 'This link does not exist or was removed.' });
  if (!isActive(row)) return res.status(410).json({ error: 'This link has expired.' });
  res.json(publicMeta(row));
}));

app.delete('/api/files/:id', apiLimiter, h(async (req, res) => {
  const [row] = await query('SELECT * FROM files WHERE id = $1', [req.params.id]);
  if (!row) return res.status(404).json({ error: 'Not found.' });
  const a = Buffer.from(req.get('x-delete-token') || '');
  const b = Buffer.from(row.delete_token);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return res.status(403).json({ error: 'Not allowed.' });
  await removeFile(row);
  res.json({ ok: true });
}));

// The actual download. Only this POST (sent by the Download button) uses up a
// download, so link previews, mail scanners and opening the page never count.
// It returns a short-lived signed link, so the file comes straight from storage:
// no function time limit, and download managers can pause and resume.
app.post('/api/files/:id/download', downloadLimiter, h(async (req, res) => {
  const [row] = await query(`UPDATE files SET downloads = downloads + 1, last_download_at = now()
    WHERE id = $1 AND status = 'ready' AND downloads < max_downloads AND expires_at > now()
    RETURNING *`, [req.params.id]);
  if (!row) return res.status(410).json({ error: 'This link has expired.' });

  try {
    const validUntil = Date.now() + DOWNLOAD_LINK_MS;
    // The token is store-wide ("*") because Vercel's scope check garbles non-ASCII
    // (e.g. Arabic) paths. Safe: the link's signature still covers this exact path,
    // and the signing key never leaves the server.
    const token = await issueSignedToken({ pathname: '*', operations: ['get'], validUntil });
    const { presignedUrl } = await presignUrl(token, { operation: 'get', pathname: row.pathname, validUntil, access: 'private' });
    const url = new URL(presignedUrl);
    url.searchParams.set('download', '1'); // save as a file instead of opening it
    res.json({ url: url.toString(), remaining: Math.max(0, row.max_downloads - row.downloads) });
  } catch (err) {
    await query('UPDATE files SET downloads = downloads - 1 WHERE id = $1 AND downloads > 0', [row.id]);
    throw err;
  }
}));

// Old-style direct links open the download page instead of using up a download.
app.get('/d/:id', (req, res) => res.redirect(303, `/f/${encodeURIComponent(req.params.id)}`));

// Daily safety-net cleanup (Vercel Cron sends the CRON_SECRET as a bearer token).
app.get('/api/cron/cleanup', h(async (req, res) => {
  const secret = process.env.CRON_SECRET;
  if (!secret || req.get('authorization') !== `Bearer ${secret}`) return res.status(401).json({ error: 'Unauthorized' });
  let total = 0;
  for (let n; (n = await cleanup()) > 0;) total += n;
  res.json({ deleted: total });
}));

// Local development only: on Vercel these are served by the CDN / vercel.json.
app.get('/f/:id', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'download.html')));
app.use(express.static(path.join(__dirname, 'public'), { extensions: ['html'] }));
const NOT_FOUND_PAGE = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Not found — DropQR</title><link rel="stylesheet" href="/styles.css"></head><body><main>
<section class="card dl" style="margin-top:80px"><h1>Page not found</h1><p class="sub">The page you are looking for does not exist.</p>
<a class="btn btn-primary" href="/">Go home</a></section></main></body></html>`;
app.use((_req, res) => res.status(404).type('html').send(NOT_FOUND_PAGE));

app.use((err, _req, res, _next) => {
  console.error(err);
  if (!res.headersSent) res.status(500).json({ error: 'Something went wrong. Please try again.' });
});

module.exports = app;

if (require.main === module) {
  app.listen(PORT, () => console.log(`DropQR running on http://localhost:${PORT}`));
}
