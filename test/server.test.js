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
delete process.env.VERCEL;
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
  headers: { 'content-type': 'application/json', ...headers },
  body: body && JSON.stringify(body),
});

async function share({ name = 'note.txt', size = 1000, maxDownloads = 4 } = {}) {
  const r = await json('POST', '/api/uploads', { name, size, type: 'text/plain', expiry: '1h', maxDownloads });
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
