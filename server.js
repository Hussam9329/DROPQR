'use strict';

const express = require('express');
const QRCode = require('qrcode');
const { neon } = require('@neondatabase/serverless');
const { head, del, get, issueSignedToken, presignUrl } = require('@vercel/blob');
const { generateClientTokenFromReadWriteToken } = require('@vercel/blob/client');
const crypto = require('node:crypto');
const path = require('node:path');
const { Readable, pipeline } = require('node:stream');
const { promisify } = require('node:util');
const downloadPage = require('./views/download-page');
const textPage = require('./views/text-page');

const scrypt = promisify(crypto.scrypt);

// ---------- Config ----------
const PORT = Number(process.env.PORT) || 3000;
const BASE_URL = (process.env.BASE_URL || '').replace(/\/+$/, '');
// Limit for one link (all its files together), and how many files it may hold.
const MAX_FILE_MB = Number(process.env.MAX_FILE_MB) || 100;
const MAX_FILES = 20;
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
// An unfinished upload can be resumed this long (after a reload or a power cut);
// after that it is dropped.
const PENDING_TTL_MS = 24 * 60 * 60 * 1000;
// How long one upload token works. A new one is fetched when it runs out.
const UPLOAD_TOKEN_MS = 60 * 60 * 1000;

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

// Abuse handling: a file is hidden after this many reports from different people.
const REPORT_THRESHOLD = Number(process.env.REPORT_THRESHOLD) || 3;
const REPORT_REASONS = {
  malware: 'Malware or virus',
  phishing: 'Phishing or scam',
  illegal: 'Illegal content',
  copyright: 'Copyright infringement',
  other: 'Something else',
};
const ABUSE_EMAIL = process.env.ABUSE_EMAIL || '';

// HTML links: one HTML file becomes a page with a link at /p/<uuid> that stops
// working after the chosen time (same choices as shared files).
const HTML_MAX_BYTES = 10 * 1024 * 1024;

// Secret texts: encrypted in the browser, so the server only ever holds ciphertext.
const TEXT_EXPIRY_OPTIONS = {
  '5m': EXPIRY_OPTIONS['5m'],
  '10m': EXPIRY_OPTIONS['10m'],
  '15m': 15 * 60,
  '30m': EXPIRY_OPTIONS['30m'],
  '1h': EXPIRY_OPTIONS['1h'],
  '6h': EXPIRY_OPTIONS['6h'],
  '1d': EXPIRY_OPTIONS['1d'],
  '7d': EXPIRY_OPTIONS['7d'],
};
// 10,000 characters of UTF-8 plus the AES-GCM tag, as base64url.
const TEXT_MAX_CIPHERTEXT = 40100;
const TEXT_STORAGE_CAP = 50 * 1024 * 1024;
const TEXT_MAX_WRONG = 10;
// A "delete after opening" text stays this long at most after the right password,
// so a connection that drops mid-answer doesn't lose it.
const TEXT_OPEN_WINDOW_SECONDS = 60;
const TEXT_MIN_ITERATIONS = 100000;
const TEXT_MAX_ITERATIONS = 2000000;
// No 0, 1, I or O, so a code is easy to read and type.
const TEXT_CODE_ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';

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
    await query('ALTER TABLE files ADD COLUMN IF NOT EXISTS reports INTEGER NOT NULL DEFAULT 0');
    await query('ALTER TABLE files ADD COLUMN IF NOT EXISTS blocked_at TIMESTAMPTZ');
    await query('ALTER TABLE files ADD COLUMN IF NOT EXISTS password_hash TEXT');
    // One row per person per file, so one person can't push a file over the threshold alone.
    await query(`CREATE TABLE IF NOT EXISTS reports (
      file_id     TEXT NOT NULL REFERENCES files (id) ON DELETE CASCADE,
      reporter    TEXT NOT NULL,
      reason      TEXT NOT NULL,
      details     TEXT NOT NULL DEFAULT '',
      created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (file_id, reporter)
    )`);
    // The files inside each link, in the order they were picked.
    await query(`CREATE TABLE IF NOT EXISTS items (
      file_id   TEXT NOT NULL REFERENCES files (id) ON DELETE CASCADE,
      idx       INTEGER NOT NULL,
      pathname  TEXT NOT NULL UNIQUE,
      name      TEXT NOT NULL,
      size      BIGINT NOT NULL,
      mime      TEXT NOT NULL,
      PRIMARY KEY (file_id, idx)
    )`);
    // Shared counters for rate limits and daily upload quotas, so every server instance sees the same numbers.
    await query(`CREATE TABLE IF NOT EXISTS usage_counters (
      key           TEXT PRIMARY KEY,
      window_start  TIMESTAMPTZ NOT NULL,
      amount        BIGINT NOT NULL
    )`);
    // HTML links: one HTML file per page. upload_id comes from the browser,
    // so retrying the same upload gives back the same page.
    await query(`CREATE TABLE IF NOT EXISTS pages (
      id          TEXT PRIMARY KEY,
      upload_id   TEXT NOT NULL UNIQUE,
      pathname    TEXT NOT NULL UNIQUE,
      name        TEXT NOT NULL,
      size        BIGINT NOT NULL,
      status      TEXT NOT NULL DEFAULT 'pending',
      created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
    )`);
    // Pages made before expiry existed have none and never expire.
    await query('ALTER TABLE pages ADD COLUMN IF NOT EXISTS expiry_seconds INTEGER');
    await query('ALTER TABLE pages ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ');
    // Secret texts. Holds only what the browser encrypted, never the text or its password.
    await query(`CREATE TABLE IF NOT EXISTS texts (
      id              TEXT PRIMARY KEY,
      ciphertext      TEXT NOT NULL,
      iv              TEXT NOT NULL,
      salt            TEXT NOT NULL,
      iterations      INTEGER NOT NULL,
      verifier_hash   TEXT NOT NULL,
      burn            BOOLEAN NOT NULL,
      wrong_attempts  INTEGER NOT NULL DEFAULT 0,
      created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
      expires_at      TIMESTAMPTZ NOT NULL,
      opened_at       TIMESTAMPTZ
    )`);
    await query('CREATE INDEX IF NOT EXISTS idx_texts_expires ON texts (expires_at)');
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

// The files in a link. Links from before multi-file sharing have one file,
// stored on the link row itself.
async function itemsOf(row) {
  const rows = await query('SELECT idx, pathname, name, size, mime FROM items WHERE file_id = $1 ORDER BY idx', [row.id]);
  return rows.length ? rows : [{ idx: 0, pathname: row.pathname, name: row.original_name, size: row.size, mime: row.mime }];
}

// A protected link shows no names, sizes or types until the password is given.
function publicMeta(row, items, unlocked = false) {
  const hidden = Boolean(row.password_hash) && !unlocked;
  return {
    id: row.id,
    hasPassword: Boolean(row.password_hash),
    name: hidden ? null : row.original_name,
    size: hidden ? null : Number(row.size),
    mime: hidden ? null : row.mime,
    files: hidden ? null : items.map((it) => ({ idx: it.idx, name: it.name, size: Number(it.size), mime: it.mime })),
    createdAt: new Date(row.created_at).getTime(),
    expiresAt: new Date(row.expires_at).getTime(),
    maxDownloads: row.max_downloads,
    downloads: row.downloads,
    remaining: Math.max(0, row.max_downloads - row.downloads),
    serverNow: Date.now(),
  };
}

// Errors carry a stable code so the page can show them in the visitor's language.
function fail(res, status, code, error, extra = {}) {
  return res.status(status).json({ error, code, ...extra });
}

const MIN_PASSWORD = 4;
const MAX_PASSWORD = 100;

async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = await scrypt(password, salt, 32);
  return `scrypt:${salt.toString('base64')}:${hash.toString('base64')}`;
}

async function passwordMatches(password, stored) {
  const [, salt, hash] = String(stored).split(':');
  const given = await scrypt(String(password), Buffer.from(salt, 'base64'), 32);
  return crypto.timingSafeEqual(given, Buffer.from(hash, 'base64'));
}

// For a protected file: true if the password is right. Wrong guesses are
// limited per visitor and file, so a password can't be guessed by brute force.
async function checkFilePassword(req, res, row) {
  if (!row.password_hash) return true;
  const tries = await addUsage(`pw:${row.id}:${visitorKey(req)}`, 15 * 60, 1);
  if (tries > 10) {
    fail(res, 429, 'too_many_attempts', 'Too many wrong passwords. Please wait 15 minutes.');
    return false;
  }
  if (!(await passwordMatches(req.body?.password || '', row.password_hash))) {
    fail(res, 403, 'wrong_password', 'Wrong password.');
    return false;
  }
  return true;
}

function formatBytes(n) {
  if (n < 1024) return `${n} B`;
  const u = ['KB', 'MB', 'GB'];
  let i = -1;
  do { n /= 1024; i++; } while (n >= 1024 && i < u.length - 1);
  return `${n.toFixed(n < 10 ? 1 : 0)} ${u[i]}`;
}

// The public link plus its QR code (SVG for the page, PNG for saving).
async function shareLink(req, id) {
  const url = `${baseUrlFor(req)}/f/${id}`;
  const qrOpts = { errorCorrectionLevel: 'M', margin: 1, color: { dark: '#0b1020', light: '#ffffff' } };
  const [qrSvg, qrPng] = await Promise.all([
    QRCode.toString(url, { ...qrOpts, type: 'svg' }),
    QRCode.toDataURL(url, { ...qrOpts, width: 600 }),
  ]);
  return { url, qrSvg, qrPng };
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
  await del((await itemsOf(row)).map((it) => it.pathname));
  await query('DELETE FROM files WHERE id = $1', [row.id]); // its items go with it
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

// Bytes held in storage by shared files and HTML pages, unfinished uploads included.
async function storageUsed() {
  const [{ used }] = await query(`SELECT
    (SELECT COALESCE(SUM(size), 0) FROM files WHERE status IN ('pending', 'ready'))
    + (SELECT COALESCE(SUM(size), 0) FROM pages) AS used`);
  return Number(used);
}

// Wraps async handlers so errors reach the error handler.
const h = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

// Short-lived links that download files straight from storage.
// The token is store-wide ("*") because Vercel's scope check garbles non-ASCII
// (e.g. Arabic) paths. Safe: each link's signature still covers its exact path,
// and the signing key never leaves the server.
async function signedDownloadUrls(items) {
  const validUntil = Date.now() + DOWNLOAD_LINK_MS;
  const token = await issueSignedToken({ pathname: '*', operations: ['get'], validUntil });
  return Promise.all(items.map(async (it) => {
    const { presignedUrl } = await presignUrl(token, { operation: 'get', pathname: it.pathname, validUntil, access: 'private' });
    const url = new URL(presignedUrl);
    url.searchParams.set('download', '1'); // save as a file instead of opening it
    return { idx: it.idx, url: url.toString() };
  }));
}

function sameSecret(given, expected) {
  const a = Buffer.from(String(given));
  const b = Buffer.from(String(expected));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function limit(bucket, windowSec, max) {
  return h(async (req, res, next) => {
    const hits = await addUsage(`${bucket}:${visitorKey(req)}`, windowSec, 1);
    if (hits <= max) return next();
    res.set('Retry-After', String(windowSec));
    fail(res, 429, 'rate_limited', 'Too many requests. Please wait a little and try again.');
  });
}

// Deletes expired, used-up and abandoned files. Runs from the daily cron
// and, at most once a minute, alongside normal traffic.
let lastCleanup = 0;
async function cleanup() {
  lastCleanup = Date.now();
  await query("DELETE FROM usage_counters WHERE window_start <= now() - interval '1 day'");
  await query('DELETE FROM texts WHERE expires_at <= now()');
  const pages = await query(`SELECT id, pathname FROM pages
    WHERE (status = 'pending' AND created_at <= now() - make_interval(secs => $1))
       OR (status = 'ready' AND expires_at <= now())
    LIMIT 500`, [PENDING_TTL_MS / 1000]);
  if (pages.length) {
    await del(pages.map((r) => r.pathname));
    await query('DELETE FROM pages WHERE id = ANY($1)', [pages.map((r) => r.id)]);
  }
  const rows = await query(`SELECT id, pathname FROM files
    WHERE (status = 'ready' AND expires_at <= now() - make_interval(secs => $1))
       OR (status = 'ready' AND downloads >= max_downloads
           AND (last_download_at IS NULL OR last_download_at <= now() - make_interval(secs => $1)))
       OR (status = 'blocked' AND expires_at <= now() - make_interval(secs => $1))
       OR (status = 'pending' AND created_at <= now() - make_interval(secs => $2))
    LIMIT 500`, [GRACE_MS / 1000, PENDING_TTL_MS / 1000]);
  if (!rows.length) return 0;
  const ids = rows.map((r) => r.id);
  const items = await query('SELECT pathname FROM items WHERE file_id = ANY($1)', [ids]);
  // Keep the rows if storage deletion fails, so the next run retries them.
  await del([...new Set([...rows, ...items].map((r) => r.pathname))]);
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
const tokenLimiter = limit('blob', 15 * 60, 120);
const completeLimiter = limit('complete', 15 * 60, 30);
const downloadLimiter = limit('download', 15 * 60, 60);
const apiLimiter = limit('api', 60, 120);
const reportLimiter = limit('report', 60 * 60, 10);
const adminLimiter = limit('admin', 15 * 60, 60);
const textCreateLimiter = limit('text-create', 15 * 60, 30);
const textOpenLimiter = limit('text-open', 15 * 60, 40);

function requireAdmin(req, res, next) {
  const secret = process.env.ADMIN_SECRET;
  if (!secret || !sameSecret(req.get('authorization') || '', `Bearer ${secret}`)) {
    return res.status(401).json({ error: 'Wrong admin password.' });
  }
  next();
}

app.get('/api/config', (_req, res) => {
  res.json({
    expiryOptions: Object.keys(EXPIRY_OPTIONS),
    downloadOptions: DOWNLOAD_OPTIONS,
    maxFileMb: MAX_FILE_MB,
    maxFiles: MAX_FILES,
    reportReasons: REPORT_REASONS,
    abuseEmail: ABUSE_EMAIL,
  });
});

app.get('/api/health', h(async (_req, res) => {
  await query('SELECT 1');
  res.json({ ok: true });
}));

// Step 1: reserve an id and a storage path for each file.
// Body: { files: [{ name, size, type }], expiry, maxDownloads, password? }
// (a single { name, size, type } is still accepted).
app.post('/api/uploads', uploadLimiter, h(async (req, res) => {
  const { name, size, type, expiry, maxDownloads, password } = req.body || {};
  const list = Array.isArray(req.body?.files) ? req.body.files : [{ name, size, type }];
  const seconds = EXPIRY_OPTIONS[expiry];
  const max = Number(maxDownloads);
  if (!seconds || !DOWNLOAD_OPTIONS.includes(max)) return fail(res, 400, 'invalid_options', 'Invalid expiry or download limit.');
  if (list.length < 1 || list.length > MAX_FILES) {
    return fail(res, 400, 'too_many_files', `You can share up to ${MAX_FILES} files at once.`, { max: MAX_FILES });
  }
  if (!list.every((f) => Number.isSafeInteger(Number(f?.size)) && Number(f.size) > 0)) {
    return fail(res, 400, 'empty_file', 'Empty files cannot be shared.');
  }
  const bytes = list.reduce((sum, f) => sum + Number(f.size), 0);
  if (bytes > MAX_FILE_BYTES) return fail(res, 400, 'too_large', `Files are larger than ${MAX_FILE_MB} MB.`, { mb: MAX_FILE_MB });
  const wantsPassword = password !== undefined && password !== null && password !== '';
  if (wantsPassword && (typeof password !== 'string' || password.length < MIN_PASSWORD || password.length > MAX_PASSWORD)) {
    return fail(res, 400, 'bad_password', `The password must be ${MIN_PASSWORD} to ${MAX_PASSWORD} characters.`);
  }

  // Unfinished reservations count too, so storage can't be filled by starting many uploads.
  if (await storageUsed() + bytes > STORAGE_CAP_BYTES) {
    return fail(res, 503, 'service_full', 'The service is full right now. Please try again later.');
  }
  const quotaKey = `bytes:${visitorKey(req)}`;
  if (await addUsage(quotaKey, 24 * 60 * 60, bytes) > DAILY_UPLOAD_BYTES) {
    await addUsage(quotaKey, 24 * 60 * 60, -bytes); // a refused upload doesn't use up the quota
    return fail(res, 429, 'daily_limit', "You reached today's upload limit. Please try again tomorrow.");
  }

  const id = newId();
  // Each file gets its own folder, so two files with the same name can't clash
  // and the saved file keeps its real name (the last part of the path).
  const items = list.map((f, idx) => {
    const fileName = safeFileName(f.name);
    return {
      idx, name: fileName, size: Number(f.size),
      mime: String(f.type || 'application/octet-stream').slice(0, 200),
      pathname: `f/${id}/${idx}/${fileName}`,
    };
  });
  const deleteToken = newToken();
  const passwordHash = wantsPassword ? await hashPassword(password) : null;
  await query(`INSERT INTO files (id, pathname, original_name, mime, size, expiry_seconds, max_downloads, delete_token, password_hash)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
  [id, items[0].pathname, items[0].name, items.length > 1 ? 'multiple' : items[0].mime, bytes, seconds, max, deleteToken, passwordHash]);
  for (const it of items) {
    await query('INSERT INTO items (file_id, idx, pathname, name, size, mime) VALUES ($1, $2, $3, $4, $5, $6)',
      [id, it.idx, it.pathname, it.name, it.size, it.mime]);
  }

  cleanupSoon();
  res.status(201).json({
    id, deleteToken, pathname: items[0].pathname,
    items: items.map((it) => ({ idx: it.idx, pathname: it.pathname })),
  });
}));

// An upload that is still in progress, for the browser that started it
// (it proves this with the delete token it was given).
async function pendingUpload(req, res) {
  const [row] = await query('SELECT * FROM files WHERE id = $1', [req.params.id]);
  if (!row || !sameSecret(String(req.body?.deleteToken || ''), row.delete_token)) {
    fail(res, 404, 'upload_not_found', 'Upload not found.');
    return null;
  }
  return row;
}

// Step 2: a token that lets the browser upload one file straight to storage,
// in one go or in parts. Asked again after a reload or when it runs out.
app.post('/api/uploads/:id/token', tokenLimiter, h(async (req, res) => {
  const row = await pendingUpload(req, res);
  if (!row) return;
  if (row.status !== 'pending') return fail(res, 409, 'upload_done', 'Upload already finished.');
  const item = (await itemsOf(row)).find((it) => it.idx === Number(req.body?.idx));
  if (!item) return fail(res, 404, 'upload_not_found', 'Upload not found.');
  const token = await generateClientTokenFromReadWriteToken({
    pathname: item.pathname,
    maximumSizeInBytes: Number(item.size),
    addRandomSuffix: false,
    allowOverwrite: false,
    validUntil: Date.now() + UPLOAD_TOKEN_MS,
  });
  res.json({ token, pathname: item.pathname });
}));

// Which files of an unfinished upload already reached storage, so a resumed
// upload skips them.
app.post('/api/uploads/:id/status', tokenLimiter, h(async (req, res) => {
  const row = await pendingUpload(req, res);
  if (!row) return;
  const items = await itemsOf(row);
  const done = row.status === 'pending'
    ? await Promise.all(items.map((it) => head(it.pathname).then(() => true, () => false)))
    : items.map(() => true);
  res.json({ status: row.status, items: items.map((it, i) => ({ idx: it.idx, uploaded: done[i] })) });
}));

// Step 3: confirm the file landed, start its timer, and return the link + QR code.
app.post('/api/uploads/:id/complete', completeLimiter, h(async (req, res) => {
  const [row] = await query('SELECT * FROM files WHERE id = $1', [req.params.id]);
  if (!row || row.delete_token !== String(req.body?.deleteToken || '')) return res.status(404).json({ error: 'Upload not found.' });
  if (row.status !== 'pending') return res.status(409).json({ error: 'Upload already finished.' });

  const items = await itemsOf(row);
  const blobs = await Promise.all(items.map((it) => head(it.pathname).catch(() => null)));
  if (blobs.some((b) => !b)) return fail(res, 400, 'upload_incomplete', 'The file did not finish uploading. Please try again.');

  // Sizes and types as storage actually received them.
  for (const [i, it] of items.entries()) {
    await query('UPDATE items SET size = $3, mime = $4 WHERE file_id = $1 AND idx = $2',
      [row.id, it.idx, blobs[i].size, blobs[i].contentType || it.mime]);
  }
  const total = blobs.reduce((sum, b) => sum + Number(b.size), 0);
  const [ready] = await query(`UPDATE files SET status = 'ready', size = $2, mime = $3,
      created_at = now(), expires_at = now() + make_interval(secs => expiry_seconds)
    WHERE id = $1 AND status = 'pending' RETURNING *`,
  [row.id, total, items.length > 1 ? 'multiple' : (blobs[0].contentType || row.mime)]);
  if (!ready) return res.status(409).json({ error: 'Upload already finished.' });

  res.json({ ...publicMeta(ready, await itemsOf(ready), true), ...(await shareLink(req, ready.id)), deleteToken: ready.delete_token });
}));

// Loads a link that can still be downloaded, or answers why it can't.
async function activeFile(req, res) {
  const [row] = await query('SELECT * FROM files WHERE id = $1', [req.params.id]);
  if (row?.status === 'blocked') {
    fail(res, 451, 'removed', 'This file was removed after being reported as harmful.');
    return null;
  }
  if (!row || row.status !== 'ready') {
    fail(res, 404, 'not_found', 'This link does not exist or was removed.');
    return null;
  }
  if (!isActive(row)) {
    fail(res, 410, 'expired', 'This link has expired.');
    return null;
  }
  return row;
}

// Link details. With ?share=1 it also returns the link and QR code, so the
// uploader can reopen them from "Your recent links".
app.get('/api/files/:id', apiLimiter, h(async (req, res) => {
  const row = await activeFile(req, res);
  if (!row) return;
  const meta = publicMeta(row, await itemsOf(row));
  res.json(req.query.share ? { ...meta, ...(await shareLink(req, row.id)) } : meta);
}));

// A protected file's name, size and type, once the right password is given.
app.post('/api/files/:id/unlock', apiLimiter, h(async (req, res) => {
  const row = await activeFile(req, res);
  if (!row || !(await checkFilePassword(req, res, row))) return;
  res.json(publicMeta(row, await itemsOf(row), true));
}));

app.delete('/api/files/:id', apiLimiter, h(async (req, res) => {
  const [row] = await query('SELECT * FROM files WHERE id = $1', [req.params.id]);
  if (!row) return res.status(404).json({ error: 'Not found.' });
  if (!sameSecret(req.get('x-delete-token') || '', row.delete_token)) return res.status(403).json({ error: 'Not allowed.' });
  await removeFile(row);
  res.json({ ok: true });
}));

// The actual download. Only this POST (sent by a Download button) uses up a
// download, so link previews, mail scanners and opening the page never count.
// One download = the whole link: it returns short-lived signed links for every
// file in it, so the visitor can save one, some or all of them within 15 minutes.
// Files come straight from storage: no function time limit, and download
// managers can pause and resume.
app.post('/api/files/:id/download', downloadLimiter, h(async (req, res) => {
  const file = await activeFile(req, res);
  if (!file || !(await checkFilePassword(req, res, file))) return;
  const [row] = await query(`UPDATE files SET downloads = downloads + 1, last_download_at = now()
    WHERE id = $1 AND status = 'ready' AND downloads < max_downloads AND expires_at > now()
    RETURNING *`, [file.id]);
  if (!row) return fail(res, 410, 'expired', 'This link has expired.');

  try {
    const urls = await signedDownloadUrls(await itemsOf(row));
    res.json({ url: urls[0].url, urls, validFor: DOWNLOAD_LINK_MS, remaining: Math.max(0, row.max_downloads - row.downloads) });
  } catch (err) {
    await query('UPDATE files SET downloads = downloads - 1 WHERE id = $1 AND downloads > 0', [row.id]);
    throw err;
  }
}));

// Anyone can report a file. Each person counts once; at REPORT_THRESHOLD
// reports the file is hidden until an admin reviews it.
app.post('/api/files/:id/report', reportLimiter, h(async (req, res) => {
  const reason = String(req.body?.reason || '');
  if (!Object.hasOwn(REPORT_REASONS, reason)) return fail(res, 400, 'report_reason', 'Please choose a reason.');
  const details = String(req.body?.details || '').trim().slice(0, 1000);
  const [row] = await query("SELECT id FROM files WHERE id = $1 AND status = 'ready'", [req.params.id]);
  if (!row) return fail(res, 404, 'not_found', 'This link does not exist or was removed.');

  const added = await query(`INSERT INTO reports (file_id, reporter, reason, details) VALUES ($1, $2, $3, $4)
    ON CONFLICT DO NOTHING RETURNING file_id`, [row.id, visitorKey(req), reason, details]);
  if (added.length) {
    await query(`UPDATE files SET reports = reports + 1,
        status = CASE WHEN reports + 1 >= $2 THEN 'blocked' ELSE status END,
        blocked_at = CASE WHEN reports + 1 >= $2 THEN now() ELSE blocked_at END
      WHERE id = $1 AND status = 'ready'`, [row.id, REPORT_THRESHOLD]);
  }
  res.json({ ok: true });
}));

// ---------- Admin (protected by ADMIN_SECRET) ----------
app.use('/api/admin', adminLimiter, requireAdmin);

// Reported or blocked files, or one file by id.
app.get('/api/admin/files', h(async (req, res) => {
  const id = String(req.query.id || '').trim();
  const files = await query(`SELECT id, original_name, size, status, reports, downloads, max_downloads,
      created_at, expires_at, blocked_at
    FROM files
    WHERE ${id ? 'id = $1' : "status = 'blocked' OR (status = 'ready' AND reports > 0)"}
    ORDER BY blocked_at DESC NULLS LAST, reports DESC, created_at DESC
    LIMIT 200`, id ? [id] : []);
  const reports = files.length
    ? await query(`SELECT file_id, reason, details, created_at FROM reports
        WHERE file_id = ANY($1) ORDER BY created_at DESC`, [files.map((f) => f.id)])
    : [];
  res.json({
    reasons: REPORT_REASONS,
    files: files.map((f) => ({
      ...f,
      size: Number(f.size),
      reports: reports.filter((r) => r.file_id === f.id).map(({ file_id, ...r }) => r),
    })),
  });
}));

app.post('/api/admin/files/:id/block', h(async (req, res) => {
  const [row] = await query(`UPDATE files SET status = 'blocked', blocked_at = now()
    WHERE id = $1 AND status = 'ready' RETURNING id`, [req.params.id]);
  if (!row) return res.status(404).json({ error: 'No active file with this id.' });
  res.json({ ok: true });
}));

// A false alarm: the file works again and its reports are cleared.
app.post('/api/admin/files/:id/unblock', h(async (req, res) => {
  const [row] = await query(`UPDATE files SET status = 'ready', blocked_at = NULL, reports = 0
    WHERE id = $1 AND status IN ('blocked', 'ready') RETURNING id`, [req.params.id]);
  if (!row) return res.status(404).json({ error: 'File not found.' });
  await query('DELETE FROM reports WHERE file_id = $1', [row.id]);
  res.json({ ok: true });
}));

app.delete('/api/admin/files/:id', h(async (req, res) => {
  const [row] = await query('SELECT * FROM files WHERE id = $1', [req.params.id]);
  if (!row) return res.status(404).json({ error: 'File not found.' });
  await removeFile(row);
  res.json({ ok: true });
}));

// Lets the admin check a reported file without using up its downloads.
app.post('/api/admin/files/:id/link', h(async (req, res) => {
  const [row] = await query("SELECT * FROM files WHERE id = $1 AND status IN ('ready', 'blocked')", [req.params.id]);
  if (!row) return res.status(404).json({ error: 'File not found.' });
  const urls = await signedDownloadUrls(await itemsOf(row));
  res.json({ url: urls[0].url, urls });
}));

// ---------- HTML links ----------
// Step 1: reserve a page and get a token to upload the file straight to storage.
// Body: { name, size, uploadId, expiry }. The same uploadId always gives the same page,
// so a retry after a dropped connection doesn't make a second one.
app.post('/api/html', uploadLimiter, h(async (req, res) => {
  const uploadId = String(req.body?.uploadId || '');
  const name = safeFileName(req.body?.name);
  const size = Number(req.body?.size);
  const seconds = EXPIRY_OPTIONS[req.body?.expiry];
  if (!seconds) return fail(res, 400, 'invalid_options', 'Invalid expiry.');
  if (!/^[0-9a-f-]{36}$/.test(uploadId)) return fail(res, 400, 'bad_request', 'Invalid upload.');
  if (!/\.html?$/i.test(name)) return fail(res, 400, 'not_html', 'Choose an HTML file.');
  if (!Number.isSafeInteger(size) || size <= 0) return fail(res, 400, 'empty_file', 'Empty files cannot be shared.');
  if (size > HTML_MAX_BYTES) return fail(res, 400, 'too_large', 'The file is larger than 10 MB.', { mb: 10 });

  let [row] = await query('SELECT * FROM pages WHERE upload_id = $1', [uploadId]);
  if (row?.status === 'ready') return res.json({ done: true, ...pageResult(row) });
  if (row && (row.name !== name || Number(row.size) !== size)) return fail(res, 409, 'bad_request', 'Invalid upload.');
  if (!row) {
    if (await storageUsed() + size > STORAGE_CAP_BYTES) {
      return fail(res, 503, 'service_full', 'The service is full right now. Please try again later.');
    }
    const quotaKey = `bytes:${visitorKey(req)}`;
    if (await addUsage(quotaKey, 24 * 60 * 60, size) > DAILY_UPLOAD_BYTES) {
      await addUsage(quotaKey, 24 * 60 * 60, -size);
      return fail(res, 429, 'daily_limit', "You reached today's upload limit. Please try again tomorrow.");
    }
    const id = crypto.randomUUID();
    [row] = await query(`INSERT INTO pages (id, upload_id, pathname, name, size, expiry_seconds) VALUES ($1, $2, $3, $4, $5, $6)
      ON CONFLICT (upload_id) DO NOTHING RETURNING *`, [id, uploadId, `p/${id}/${name}`, name, size, seconds]);
    if (!row) [row] = await query('SELECT * FROM pages WHERE upload_id = $1', [uploadId]); // a parallel retry won
  }
  const token = await generateClientTokenFromReadWriteToken({
    pathname: row.pathname,
    maximumSizeInBytes: Number(row.size),
    addRandomSuffix: false,
    allowOverwrite: false,
    validUntil: Date.now() + UPLOAD_TOKEN_MS,
  });
  cleanupSoon();
  res.json({ id: row.id, pathname: row.pathname, token });
}));

// What the page shows once a link is made.
function pageResult(row) {
  return { path: `/p/${row.id}`, name: row.name, expiresAt: row.expires_at ? new Date(row.expires_at).getTime() : null };
}

// Step 2: once the file is in storage, the page goes live and its timer starts.
app.post('/api/html/:id/complete', completeLimiter, h(async (req, res) => {
  const [row] = await query('SELECT * FROM pages WHERE id = $1 AND upload_id = $2', [req.params.id, String(req.body?.uploadId || '')]);
  if (!row) return fail(res, 404, 'upload_not_found', 'Upload not found.');
  let page = row;
  if (row.status !== 'ready') {
    const blob = await head(row.pathname).catch(() => null);
    if (!blob) return fail(res, 400, 'upload_incomplete', 'The file did not finish uploading. Please try again.');
    [page] = await query(`UPDATE pages SET status = 'ready', size = $2,
        expires_at = now() + make_interval(secs => COALESCE(expiry_seconds, 0))
      WHERE id = $1 RETURNING *`, [row.id, blob.size]);
  }
  res.json(pageResult(page));
}));

// The page itself. It runs in a sandbox (its own blank origin), so its scripts
// can't reach DropQR's API, cookies or browser storage.
app.get('/p/:id', h(async (req, res) => {
  await ensureSchema();
  const [row] = /^[0-9a-f-]{36}$/.test(req.params.id)
    ? await query("SELECT * FROM pages WHERE id = $1 AND status = 'ready'", [req.params.id])
    : [];
  const left = row?.expires_at ? new Date(row.expires_at).getTime() - Date.now() : Infinity;
  if (row && left <= 0) {
    cleanupSoon();
    return res.status(410).set('Cache-Control', 'no-store').type('html').send(EXPIRED_PAGE);
  }
  const blob = row && await get(row.pathname, { access: 'private' });
  if (!blob) return res.status(404).type('html').send(NOT_FOUND_PAGE);
  res.set({
    'Content-Type': 'text/html; charset=utf-8',
    'Content-Security-Policy': 'sandbox allow-scripts allow-forms allow-popups allow-popups-to-escape-sandbox allow-modals allow-downloads',
    // Never cached past the moment the link expires.
    'Cache-Control': `private, max-age=${Math.max(0, Math.min(300, Math.floor(left / 1000)))}`,
  });
  res.removeHeader('X-Frame-Options');
  pipeline(Readable.fromWeb(blob.stream), res, (err) => { if (err) console.error('page stream failed', err); });
}));

// ---------- Secret texts ----------
// The browser encrypts the text with a key made from the password, and sends a
// separate "verifier" made from the same password. The server can check the
// verifier but can't get the key from it, so it can never read a text.
const isBase64Url = (value, bytes) => typeof value === 'string'
  && value.length === Math.ceil(bytes * 4 / 3) && /^[A-Za-z0-9_-]+$/.test(value);

function newTextCode() {
  return Array.from(crypto.randomBytes(8), (b) => TEXT_CODE_ALPHABET[b & 31]).join('');
}

// Accepts a code however it was typed: "k7m2-qx9p" is "K7M2QX9P".
const textCode = (value) => String(value || '').toUpperCase().replace(/[^0-9A-Z]/g, '');

// Loads a text that can still be opened, or answers why it can't.
async function activeText(req, res) {
  const [row] = await query('SELECT * FROM texts WHERE id = $1', [textCode(req.params.id)]);
  if (!row) {
    fail(res, 404, 'not_found', 'This text does not exist or was deleted.');
    return null;
  }
  if (new Date(row.expires_at).getTime() <= Date.now()) {
    await query('DELETE FROM texts WHERE id = $1', [row.id]);
    fail(res, 410, 'expired', 'This text has expired.');
    return null;
  }
  return row;
}

// True if the verifier is right. Wrong guesses are counted on the text itself,
// whoever sends them, and the last allowed one deletes it.
async function checkTextVerifier(req, res, row) {
  const verifier = req.body?.verifier;
  if (isBase64Url(verifier, 32) && await passwordMatches(verifier, row.verifier_hash)) return true;
  const [counted] = await query('UPDATE texts SET wrong_attempts = wrong_attempts + 1 WHERE id = $1 RETURNING wrong_attempts', [row.id]);
  if (!counted) {
    fail(res, 404, 'not_found', 'This text does not exist or was deleted.');
    return false;
  }
  if (counted.wrong_attempts >= TEXT_MAX_WRONG) {
    await query('DELETE FROM texts WHERE id = $1', [row.id]);
    fail(res, 410, 'destroyed', 'Too many wrong passwords. This text was deleted.');
    return false;
  }
  fail(res, 403, 'wrong_password', 'Wrong password.', { attemptsLeft: TEXT_MAX_WRONG - counted.wrong_attempts });
  return false;
}

app.use('/api/texts', (_req, res, next) => {
  res.set('Cache-Control', 'no-store');
  next();
});

// Body: { ciphertext, iv, salt, iterations, verifier, expiry, burn }, all made in the browser.
app.post('/api/texts', textCreateLimiter, h(async (req, res) => {
  const { ciphertext, iv, salt, iterations, verifier, expiry, burn } = req.body || {};
  const seconds = Object.hasOwn(TEXT_EXPIRY_OPTIONS, String(expiry)) ? TEXT_EXPIRY_OPTIONS[expiry] : 0;
  if (!seconds || typeof burn !== 'boolean') return fail(res, 400, 'invalid_options', 'Invalid expiry.');
  if (typeof ciphertext !== 'string' || !/^[A-Za-z0-9_-]+$/.test(ciphertext) || ciphertext.length < 23) {
    return fail(res, 400, 'bad_request', 'Invalid text.');
  }
  if (ciphertext.length > TEXT_MAX_CIPHERTEXT) return fail(res, 400, 'too_large', 'The text is too long.');
  if (!isBase64Url(iv, 12) || !isBase64Url(salt, 16) || !isBase64Url(verifier, 32)
    || !Number.isInteger(iterations) || iterations < TEXT_MIN_ITERATIONS || iterations > TEXT_MAX_ITERATIONS) {
    return fail(res, 400, 'bad_request', 'Invalid text.');
  }
  const [{ used }] = await query('SELECT COALESCE(SUM(length(ciphertext)), 0) AS used FROM texts');
  if (Number(used) + ciphertext.length > TEXT_STORAGE_CAP) {
    return fail(res, 503, 'service_full', 'The service is full right now. Please try again later.');
  }

  const verifierHash = await hashPassword(verifier);
  let row;
  for (let tries = 0; !row && tries < 5; tries++) {
    [row] = await query(`INSERT INTO texts (id, ciphertext, iv, salt, iterations, verifier_hash, burn, expires_at)
      VALUES ($1, $2, $3, $4, $5, $6, $7, now() + make_interval(secs => $8))
      ON CONFLICT (id) DO NOTHING RETURNING id, expires_at`,
    [newTextCode(), ciphertext, iv, salt, iterations, verifierHash, burn, seconds]);
  }
  if (!row) throw new Error('could not reserve a text code');

  cleanupSoon();
  const url = `${baseUrlFor(req)}/t/${row.id}`;
  const qrPng = await QRCode.toDataURL(url, { errorCorrectionLevel: 'M', margin: 1, width: 600, color: { dark: '#0b1020', light: '#ffffff' } });
  res.status(201).json({ id: row.id, url, qrPng, burn, expiresAt: new Date(row.expires_at).getTime(), serverNow: Date.now() });
}));

// What the browser needs to ask for the password. Reveals nothing about the text.
app.get('/api/texts/:id', apiLimiter, h(async (req, res) => {
  const row = await activeText(req, res);
  if (!row) return;
  res.json({
    id: row.id, salt: row.salt, iterations: row.iterations, burn: row.burn,
    expiresAt: new Date(row.expires_at).getTime(), serverNow: Date.now(),
  });
}));

// The right password gets the encrypted text. A "delete after opening" text then
// has a short window left, and the browser ends it early with /burn once it has the text.
app.post('/api/texts/:id/open', textOpenLimiter, h(async (req, res) => {
  const found = await activeText(req, res);
  if (!found || !(await checkTextVerifier(req, res, found))) return;
  cleanupSoon();
  const [row] = found.burn
    ? await query(`UPDATE texts SET opened_at = COALESCE(opened_at, now()),
        expires_at = LEAST(expires_at, COALESCE(opened_at, now()) + make_interval(secs => $2))
      WHERE id = $1 AND expires_at > now() RETURNING *`, [found.id, TEXT_OPEN_WINDOW_SECONDS])
    : [found];
  if (!row) return fail(res, 410, 'expired', 'This text has expired.');
  res.json({
    ciphertext: row.ciphertext, iv: row.iv, burn: row.burn,
    expiresAt: new Date(row.expires_at).getTime(), serverNow: Date.now(),
  });
}));

// The browser has the text: a "delete after opening" text is gone from here on.
// Safe to repeat: a text that is already gone counts as done.
app.post('/api/texts/:id/burn', textOpenLimiter, h(async (req, res) => {
  const [row] = await query('SELECT * FROM texts WHERE id = $1', [textCode(req.params.id)]);
  if (!row) return res.json({ ok: true, deleted: true });
  if (!(await checkTextVerifier(req, res, row))) return;
  if (row.burn) await query('DELETE FROM texts WHERE id = $1', [row.id]);
  res.json({ ok: true, deleted: row.burn });
}));

// The pages hold no secrets: the text is only fetched after the password is given,
// so link previews and scanners can't open or use up a text.
function sendTextPage(res, mode, code = '') {
  res.set({
    'Cache-Control': 'no-store',
    'X-Robots-Tag': 'noindex',
    'Content-Security-Policy': "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  });
  res.type('html').send(textPage({ mode, code }));
}
app.get('/text', (_req, res) => sendTextPage(res, 'create'));
app.get('/t/:id', (req, res) => {
  const code = textCode(req.params.id);
  sendTextPage(res, 'open', /^[2-9A-HJ-NP-Z]{8}$/.test(code) ? code : '');
});

// Phone "Share to DropQR": the service worker normally answers this itself.
// Without it (e.g. the very first open) the visitor still lands on the upload page.
app.post('/share-target', (_req, res) => res.redirect(303, '/?shared=1'));

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

// The download page. Chat apps read its title and picture for the link preview;
// a protected file never shows its name there.
app.get('/f/:id', h(async (req, res) => {
  await ensureSchema();
  const [row] = await query('SELECT * FROM files WHERE id = $1', [req.params.id]);
  let title = 'Download a file — DropQR';
  let description = 'A file shared with DropQR. The link expires on its own.';
  if (isActive(row) && row.password_hash) {
    title = 'Protected file — DropQR';
    description = 'This file needs a password. The link expires on its own.';
  } else if (isActive(row)) {
    const count = (await itemsOf(row)).length;
    title = count > 1 ? `${row.original_name} + ${count - 1} more` : row.original_name;
    description = `${count > 1 ? `${count} files · ` : ''}${formatBytes(Number(row.size))} · Download before the link expires · DropQR`;
  }
  const base = baseUrlFor(req);
  res.set('Cache-Control', 'no-store');
  res.type('html').send(downloadPage({ title, description, url: `${base}/f/${req.params.id}`, image: `${base}/og.png` }));
}));

// Local development only: on Vercel the CDN serves public/.
app.use(express.static(path.join(__dirname, 'public'), { extensions: ['html'] }));
const NOT_FOUND_PAGE = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Not found — DropQR</title><link rel="stylesheet" href="/styles.css"></head><body><main>
<section class="card dl" style="margin-top:80px"><h1>Page not found</h1><p class="sub">The page you are looking for does not exist.</p>
<a class="btn btn-primary" href="/">Go home</a></section></main></body></html>`;
const EXPIRED_PAGE = `<!doctype html><html lang="ar" dir="rtl"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>انتهى الرابط — DropQR</title><link rel="stylesheet" href="/styles.css"></head><body><main>
<section class="card dl" style="margin-top:80px"><h1>انتهت صلاحية هذا الرابط</h1><p class="sub">This link has expired.</p>
<a class="btn btn-primary" href="/html.html">رابط HTML</a></section></main></body></html>`;
app.use((_req, res) => res.status(404).type('html').send(NOT_FOUND_PAGE));

app.use((err, _req, res, _next) => {
  console.error(err);
  if (!res.headersSent) res.status(500).json({ error: 'Something went wrong. Please try again.' });
});

module.exports = app;

if (require.main === module) {
  app.listen(PORT, () => console.log(`DropQR running on http://localhost:${PORT}`));
}
