// Runs the real server against a local in-memory Postgres (PGlite) and a fake
// Blob store, so tests never touch the production database or storage.
// Run with: npm test
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { PGlite } = require('@electric-sql/pglite');

process.env.CRON_SECRET = 'test-secret';
process.env.STORAGE_CAP_GB = String(3 / 1024); // 3 MB for the whole site
process.env.DAILY_UPLOAD_MB = '1'; // 1 MB per visitor per day
process.env.ADMIN_SECRET = 'admin-pass';
process.env.VERCEL = '1'; // visitors are told apart by the x-real-ip header

delete process.env.DATABASE_URL;

const pg = new PGlite();
const blobs = new Map(); // pathname -> { size, contentType }
const blobFailures = { del: false };

function mock(name, exports) {
  const file = require.resolve(name);
  require.cache[file] = { id: file, filename: file, loaded: true, exports };
}
mock('@neondatabase/serverless', {
  neon: () => ({ query: async (text, params) => (await pg.query(text, params)).rows }),
});
mock('@vercel/blob', {
  head: async (p) => {
    const b = blobs.get(p);
    if (!b) throw new Error('not found');
    return b;
  },
  del: async (p) => {
    if (blobFailures.del) throw new Error('storage down');
    for (const x of [].concat(p)) blobs.delete(x);
  },
  issueSignedToken: async ({ pathname, operations }) => ({ delegationToken: `d:${pathname}:${operations}`, clientSigningToken: 'c' }),
  presignUrl: async (_t, { pathname }) => ({
    presignedUrl: `https://store.private.blob.vercel-storage.com/${pathname}?vercel-blob-signature=sig`,
  }),
});

// Two copies of the app = two serverless instances sharing one database.
const serverPath = path.join(__dirname, '..', 'server.js');
function loadApp() {
  delete require.cache[serverPath];
  return require(serverPath);
}
const apps = [loadApp(), loadApp()];
const bases = [];
const servers = [];

test.before(async () => {
  for (const app of apps) {
    await new Promise((resolve) => {
      const srv = app.listen(0, () => { bases.push(`http://127.0.0.1:${srv.address().port}`); resolve(); });
      servers.push(srv);
    });
  }
});
test.after(() => servers.forEach((s) => s.close()));

let turn = 0;
const base = () => bases[turn++ % bases.length]; // alternate instances
const json = (method, url, body, headers = {}) => fetch(base() + url, {
  method, redirect: 'manual',
  headers: { 'content-type': 'application/json', 'x-real-ip': '10.0.0.1', ...headers },
  body: body && JSON.stringify(body),
});

async function share({ name = 'note.txt', size = 1000, maxDownloads = 4, password } = {}) {
  const r = await json('POST', '/api/uploads', { name, size, type: 'text/plain', expiry: '1h', maxDownloads, password });
  const res = { status: r.status, body: await r.json() };
  if (r.status !== 201) return res;
  blobs.set(res.body.pathname, { size, contentType: 'text/plain' }); // the browser's direct upload
  const c = await json('POST', `/api/uploads/${res.body.id}/complete`, { deleteToken: res.body.deleteToken });
  return { status: c.status, body: await c.json() };
}

test('upload, then the link works', async () => {
  const { status, body } = await share();
  assert.equal(status, 200);
  assert.equal(body.remaining, 4);
  const meta = await (await json('GET', `/api/files/${body.id}`)).json();
  assert.equal(meta.name, 'note.txt');
});

test('download returns a signed direct link that saves as a file', async () => {
  const { body } = await share({ name: 'doc.txt', maxDownloads: 2 });
  const r = await json('POST', `/api/files/${body.id}/download`);
  assert.equal(r.status, 200);
  const d = await r.json();
  assert.match(d.url, /^https:\/\/store\.private\.blob\.vercel-storage\.com\/f\//);
  assert.equal(new URL(d.url).searchParams.get('download'), '1');
  assert.equal(new URL(d.url).searchParams.get('vercel-blob-signature'), 'sig');
  assert.equal(d.remaining, 1);
});

test('opening /d/ links or the page never uses a download', async () => {
  const { body } = await share({ maxDownloads: 1 });
  for (let i = 0; i < 3; i++) {
    const r = await json('GET', `/d/${body.id}`);
    assert.equal(r.status, 303);
    assert.equal(r.headers.get('location'), `/f/${body.id}`);
  }
  const meta = await (await json('GET', `/api/files/${body.id}`)).json();
  assert.equal(meta.remaining, 1);
});

test('download limit holds under parallel clicks, across instances', async () => {
  const { body } = await share({ maxDownloads: 4 });
  const codes = await Promise.all(Array.from({ length: 10 }, () => json('POST', `/api/files/${body.id}/download`).then((r) => r.status)));
  assert.equal(codes.filter((c) => c === 200).length, 4);
  assert.equal(codes.filter((c) => c === 410).length, 6);
  assert.equal((await json('GET', `/api/files/${body.id}`)).status, 410);
});

test('a used download is never handed back', async () => {
  const { body } = await share({ maxDownloads: 1 });
  assert.equal((await json('POST', `/api/files/${body.id}/download`)).status, 200);
  // A cut-off transfer used to refund the slot; now a second request is refused.
  assert.equal((await json('POST', `/api/files/${body.id}/download`)).status, 410);
});

test('hidden direction characters are stripped from file names', async () => {
  const { body } = await share({ name: 'invoice‮fdp.exe' });
  assert.equal(body.name, 'invoicefdp.exe');
  const { body: b2 } = await share({ name: 'a​b⁦c﻿.pdf' });
  assert.equal(b2.name, 'abc.pdf');
  const { body: b3 } = await share({ name: 'تقرير ١.pdf' });
  assert.equal(b3.name, 'تقرير ١.pdf');
});

test('delete keeps the file when storage fails, then succeeds', async () => {
  const { body } = await share();
  blobFailures.del = true;
  const bad = await json('DELETE', `/api/files/${body.id}`, null, { 'x-delete-token': body.deleteToken });
  assert.equal(bad.status, 500);
  assert.equal((await json('GET', `/api/files/${body.id}`)).status, 200);
  blobFailures.del = false;
  const ok = await json('DELETE', `/api/files/${body.id}`, null, { 'x-delete-token': body.deleteToken });
  assert.equal(ok.status, 200);
  assert.equal((await json('GET', `/api/files/${body.id}`)).status, 404);
});

test('cleanup waits for the grace period before deleting', async () => {
  const a = (await share()).body;
  const b = (await share()).body;
  await pg.query("UPDATE files SET expires_at = now() - interval '2 minutes' WHERE id = $1", [a.id]); // inside grace
  await pg.query("UPDATE files SET expires_at = now() - interval '1 hour' WHERE id = $1", [b.id]); // past grace
  const r = await json('GET', '/api/cron/cleanup', null, { authorization: 'Bearer test-secret' });
  assert.equal(r.status, 200);
  const rows = (await pg.query('SELECT id FROM files WHERE id = ANY($1)', [[a.id, b.id]])).rows.map((x) => x.id);
  assert.deepEqual(rows, [a.id]);
  assert.equal(blobs.has(b.pathname), false);
  assert.equal((await json('GET', `/api/files/${a.id}`)).status, 410); // expired files still can't be downloaded
});

test('daily upload quota per visitor, refused uploads are not counted', async () => {
  await pg.query('DELETE FROM usage_counters');
  const mb = 1024 * 1024;
  assert.equal((await share({ size: Math.round(0.6 * mb) })).status, 200);
  const over = await share({ size: Math.round(0.6 * mb) });
  assert.equal(over.status, 429);
  assert.match(over.body.error, /today's upload limit/);
  assert.equal((await share({ size: Math.round(0.3 * mb) })).status, 200); // the refused 0.6 MB didn't count
});

test('whole-site storage cap', async () => {
  await pg.query('DELETE FROM usage_counters');
  const r = await share({ size: 3 * 1024 * 1024 });
  assert.equal(r.status, 503);
  assert.match(r.body.error, /full/);
});

test('rate limit is shared by all instances', async () => {
  await pg.query('DELETE FROM usage_counters');
  const codes = [];
  for (let i = 0; i < 32; i++) {
    const r = await json('POST', '/api/uploads', { name: 'x.txt', size: 10, expiry: '5m', maxDownloads: 1 });
    codes.push(r.status);
  }
  // 30 allowed in 15 minutes, counted together even though requests alternate between two instances.
  assert.equal(codes.filter((c) => c === 201).length, 30);
  assert.deepEqual(codes.slice(30), [429, 429]);
});

// ---------- Stage 2: reports, admin ----------
const admin = (method, url) => json(method, url, null, { authorization: 'Bearer admin-pass' });
const report = (id, ip, reason = 'malware', details = '') => json('POST', `/api/files/${id}/report`, { reason, details }, { 'x-real-ip': ip });

test('config lists the report reasons', async () => {
  const cfg = await (await json('GET', '/api/config')).json();
  assert.equal(cfg.reportReasons.malware, 'Malware or virus');
});

test('reports: one per person, file hidden at 3 different people', async () => {
  await pg.query('DELETE FROM usage_counters');
  const { body } = await share();
  assert.equal((await report(body.id, '1.1.1.1', 'nonsense')).status, 400);
  assert.equal((await report(body.id, '1.1.1.1')).status, 200);
  assert.equal((await report(body.id, '1.1.1.1', 'phishing')).status, 200); // same person again: not counted
  assert.equal((await report(body.id, '2.2.2.2', 'other', 'looks fake')).status, 200);
  assert.equal((await json('GET', `/api/files/${body.id}`)).status, 200); // 2 people: still live
  assert.equal((await report(body.id, '3.3.3.3')).status, 200);
  const gone = await json('GET', `/api/files/${body.id}`);
  assert.equal(gone.status, 451);
  assert.equal((await json('POST', `/api/files/${body.id}/download`)).status, 451);
  assert.equal((await report(body.id, '4.4.4.4')).status, 404); // already hidden
});

test('admin: wrong password is refused', async () => {
  assert.equal((await json('GET', '/api/admin/files')).status, 401);
  assert.equal((await json('GET', '/api/admin/files', null, { authorization: 'Bearer nope' })).status, 401);
});

test('admin: review, unblock, block, link and delete', async () => {
  await pg.query('DELETE FROM usage_counters');
  const { body } = await share({ name: 'suspicious.exe' });
  await report(body.id, '5.5.5.5', 'malware', 'my antivirus flagged it');
  const listed = await (await admin('GET', '/api/admin/files')).json();
  const f = listed.files.find((x) => x.id === body.id);
  assert.equal(f.status, 'ready');
  assert.equal(f.reports.length, 1);
  assert.equal(f.reports[0].details, 'my antivirus flagged it');

  assert.equal((await admin('POST', `/api/admin/files/${body.id}/block`)).status, 200);
  assert.equal((await json('GET', `/api/files/${body.id}`)).status, 451);
  const link = await (await admin('POST', `/api/admin/files/${body.id}/link`)).json();
  assert.match(link.url, /suspicious.exe/);

  assert.equal((await admin('POST', `/api/admin/files/${body.id}/unblock`)).status, 200);
  assert.equal((await json('GET', `/api/files/${body.id}`)).status, 200);
  const after = await (await admin('GET', `/api/admin/files?id=${body.id}`)).json();
  assert.equal(after.files[0].reports.length, 0); // false alarm: reports cleared

  assert.equal((await admin('DELETE', `/api/admin/files/${body.id}`)).status, 200);
  assert.equal((await json('GET', `/api/files/${body.id}`)).status, 404);
  assert.equal(blobs.has(body.pathname), false);
  const reportsLeft = await pg.query('SELECT 1 FROM reports WHERE file_id = $1', [body.id]);
  assert.equal(reportsLeft.rows.length, 0);
});

test('blocked files are cleaned up after they expire', async () => {
  await pg.query('DELETE FROM usage_counters');
  const { body } = await share();
  await admin('POST', `/api/admin/files/${body.id}/block`);
  await pg.query("UPDATE files SET expires_at = now() - interval '1 hour' WHERE id = $1", [body.id]);
  await json('GET', '/api/cron/cleanup', null, { authorization: 'Bearer test-secret' });
  assert.equal((await pg.query('SELECT 1 FROM files WHERE id = $1', [body.id])).rows.length, 0);
  assert.equal(blobs.has(body.pathname), false);
});

test('a saved link can be reopened with its QR code', async () => {
  await pg.query('DELETE FROM usage_counters');
  const { body } = await share({ name: 'photo.jpg' });
  const plain = await (await json('GET', `/api/files/${body.id}`)).json();
  assert.equal(plain.qrSvg, undefined); // normal lookups stay small
  const r = await json('GET', `/api/files/${body.id}?share=1`);
  assert.equal(r.status, 200);
  const d = await r.json();
  assert.equal(d.name, 'photo.jpg');
  assert.ok(d.url.endsWith(`/f/${body.id}`));
  assert.match(d.qrSvg, /^<svg/);
  assert.match(d.qrPng, /^data:image\/png;base64,/);
  assert.equal(d.deleteToken, undefined); // never handed out again
});

// ---------- Stage 3: password, error codes, download page ----------
test('password: hidden details, wrong guesses refused, right one works', async () => {
  await pg.query('DELETE FROM usage_counters');
  const short = await json('POST', '/api/uploads', { name: 'x.txt', size: 10, expiry: '5m', maxDownloads: 1, password: 'abc' });
  assert.equal(short.status, 400);
  assert.equal((await short.json()).code, 'bad_password');

  const { status, body } = await share({ name: 'salary.xlsx', password: 'sesame-42' });
  assert.equal(status, 200);
  assert.equal(body.name, 'salary.xlsx'); // the uploader sees everything
  const meta = await (await json('GET', `/api/files/${body.id}`)).json();
  assert.equal(meta.hasPassword, true);
  assert.equal(meta.name, null);
  assert.equal(meta.size, null);

  const wrong = await json('POST', `/api/files/${body.id}/unlock`, { password: 'nope' });
  assert.equal(wrong.status, 403);
  assert.equal((await wrong.json()).code, 'wrong_password');
  assert.equal((await json('POST', `/api/files/${body.id}/download`, { password: 'nope' })).status, 403);
  assert.equal((await (await json('GET', `/api/files/${body.id}`)).json()).remaining, 4); // nothing used

  const ok = await (await json('POST', `/api/files/${body.id}/unlock`, { password: 'sesame-42' })).json();
  assert.equal(ok.name, 'salary.xlsx');
  const dl = await json('POST', `/api/files/${body.id}/download`, { password: 'sesame-42' });
  assert.equal(dl.status, 200);
  const row = (await pg.query('SELECT password_hash FROM files WHERE id = $1', [body.id])).rows[0];
  assert.match(row.password_hash, /^scrypt:/); // never stored as plain text
  assert.ok(!row.password_hash.includes('sesame'));
});

test('password guessing is capped per visitor', async () => {
  await pg.query('DELETE FROM usage_counters');
  const { body } = await share({ password: 'right-one' });
  const codes = [];
  for (let i = 0; i < 11; i++) {
    const r = await json('POST', `/api/files/${body.id}/unlock`, { password: `guess${i}` }, { 'x-real-ip': '9.9.9.9' });
    codes.push(r.status);
  }
  assert.equal(codes.filter((c) => c === 403).length, 10);
  assert.equal(codes[10], 429);
  // Even the right password waits now, for this visitor only.
  assert.equal((await json('POST', `/api/files/${body.id}/unlock`, { password: 'right-one' }, { 'x-real-ip': '9.9.9.9' })).status, 429);
  assert.equal((await json('POST', `/api/files/${body.id}/unlock`, { password: 'right-one' }, { 'x-real-ip': '8.8.8.8' })).status, 200);
});

test('errors carry a code for translation', async () => {
  const r = await json('POST', '/api/uploads', { name: 'x', size: 200 * 1024 * 1024, expiry: '5m', maxDownloads: 1 });
  const d = await r.json();
  assert.equal(d.code, 'too_large');
  assert.equal(d.mb, 100);
  assert.equal((await (await json('GET', '/api/files/doesnotexist')).json()).code, 'not_found');
});

test('download page: link preview shows the file, never a protected one', async () => {
  await pg.query('DELETE FROM usage_counters');
  const open = (await share({ name: 'trip <photos>.zip', size: 5 * 1024 })).body;
  const html = await (await json('GET', `/f/${open.id}`)).text();
  assert.ok(html.includes('<meta property="og:title" content="trip &lt;photos&gt;.zip">'));
  assert.ok(html.includes('og:description" content="5.0 KB · Download before the link expires'));
  assert.match(html, /og:image" content="http:\/\/127\.0\.0\.1:\d+\/og\.png"/);

  const locked = (await share({ name: 'secret-plan.pdf', password: 'hunter22' })).body;
  const html2 = await (await json('GET', `/f/${locked.id}`)).text();
  assert.ok(!html2.includes('secret-plan'));
  assert.match(html2, /Protected file — DropQR/);

  const missing = await (await json('GET', '/f/nothing00')).text();
  assert.match(missing, /Download a file — DropQR/);
  assert.equal((await (await json('GET', `/api/files/${open.id}`)).json()).remaining, 4); // page views are free
});
