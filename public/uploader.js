// Resumable uploads. Files above PART_SIZE go up in parts, and every part that
// arrives is remembered in this browser. If the page is closed, reloaded or the
// power goes out, the upload continues from the next missing part (within 24 h)
// once the visitor picks the same files again.
const PART_SIZE = 8 * 1024 * 1024; // storage needs parts of at least 5 MB
const SESSION_KEY = 'dropqr:upload';

const uploadSession = {
  load() {
    try { return JSON.parse(localStorage.getItem(SESSION_KEY) || 'null'); } catch { return null; }
  },
  save(session) {
    // Upload tokens are short-lived and never stored.
    try { localStorage.setItem(SESSION_KEY, JSON.stringify(session, (k, v) => (k === 'token' ? undefined : v))); } catch {}
  },
  clear() {
    try { localStorage.removeItem(SESSION_KEY); } catch {}
  },
};

// How many bytes of a saved upload already reached storage.
function sessionSentBytes(session) {
  return session.files.reduce((sum, f) => {
    if (f.done) return sum + f.size;
    const parts = f.mp ? f.mp.parts.length : 0;
    return sum + Math.min(f.size, parts * PART_SIZE);
  }, 0);
}

async function postJSON(url, body, signal) {
  const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) {
    const err = new Error(errorText(data, 'uploadFailed'));
    err.status = r.status;
    throw err;
  }
  return data;
}

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener('abort', () => { clearTimeout(timer); reject(new DOMException('Aborted', 'AbortError')); }, { once: true });
  });
}

function waitOnline(signal) {
  if (navigator.onLine) return Promise.resolve();
  return new Promise((resolve, reject) => {
    window.addEventListener('online', resolve, { once: true });
    signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
  });
}

// Settles as soon as the upload is cancelled, even if a network call hangs.
function abortable(promise, signal) {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(new DOMException('Aborted', 'AbortError'));
    signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
    promise.then(resolve, reject);
  });
}

// Runs one step again when the connection drops: waits until the device is
// back online, then retries with growing pauses. Cancelling stops it at once.
async function withRetry(step, signal, onWait) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await abortable(step(attempt), signal);
    } catch (err) {
      if (signal.aborted || attempt >= 6 || (err.status >= 400 && err.status < 500)) throw err;
      onWait();
      await waitOnline(signal);
      await sleep(Math.min(30000, 1500 * 2 ** attempt), signal);
    }
  }
}

// Uploads the files of a session; `files[i]` is the File for session.files[i].
// onProgress(sentBytes, totalBytes, fileIndex) is called as bytes go up.
async function runUpload(session, files, { signal, onProgress, onWait }) {
  const total = session.files.reduce((sum, f) => sum + f.size, 0);
  const sent = session.files.map((f) => (f.done ? f.size : Math.min(f.size, (f.mp ? f.mp.parts.length : 0) * PART_SIZE)));
  const report = (i) => onProgress(sent.reduce((a, b) => a + b, 0), total, i);

  for (const [i, sf] of session.files.entries()) {
    if (sf.done) continue;
    const file = files[i];
    const tokenFor = async (fresh) => {
      if (fresh || !sf.token) {
        sf.token = (await postJSON(`/api/uploads/${session.id}/token`, { deleteToken: session.deleteToken, idx: sf.idx }, signal)).token;
      }
      return sf.token;
    };
    const common = { access: 'private', contentType: sf.type || undefined, abortSignal: signal };

    if (sf.size <= PART_SIZE) {
      await withRetry(async (attempt) => {
        try {
          await blobClient.put(sf.pathname, file, {
            ...common, token: await tokenFor(attempt > 0),
            onUploadProgress: (p) => { sent[i] = p.loaded; report(i); },
          });
        } catch (err) {
          // An earlier try may have finished just before the connection dropped.
          if (!/already exists/i.test(err.message)) throw err;
        }
      }, signal, onWait);
    } else {
      await uploadInParts(session, sf, file, { common, tokenFor, signal, onWait, onPart: (bytes) => { sent[i] = bytes; report(i); } });
    }
    sf.done = true;
    sent[i] = sf.size;
    uploadSession.save(session);
    report(i);
  }
}

async function uploadInParts(session, sf, file, { common, tokenFor, signal, onWait, onPart }, restarted = false) {
  const resumed = Boolean(sf.mp);
  try {
    if (!sf.mp) {
      const { key, uploadId } = await withRetry(async (attempt) => blobClient.createMultipartUpload(sf.pathname, {
        ...common, token: await tokenFor(attempt > 0),
      }), signal, onWait);
      sf.mp = { key, uploadId, parts: [] };
      uploadSession.save(session);
    }
    const count = Math.ceil(sf.size / PART_SIZE);
    for (let n = 1; n <= count; n++) {
      if (sf.mp.parts.some((p) => p.partNumber === n)) continue;
      const doneBytes = sf.mp.parts.length * PART_SIZE;
      const body = file.slice((n - 1) * PART_SIZE, Math.min(n * PART_SIZE, sf.size));
      const part = await withRetry(async (attempt) => blobClient.uploadPart(sf.pathname, body, {
        ...common, token: await tokenFor(attempt > 0), key: sf.mp.key, uploadId: sf.mp.uploadId, partNumber: n,
        onUploadProgress: (p) => onPart(doneBytes + p.loaded),
      }), signal, onWait);
      sf.mp.parts.push({ partNumber: part.partNumber, etag: part.etag });
      uploadSession.save(session); // this part is safe now, even if the page closes
      onPart(sf.mp.parts.length * PART_SIZE);
    }
    const parts = sf.mp.parts.slice().sort((a, b) => a.partNumber - b.partNumber);
    await withRetry(async (attempt) => blobClient.completeMultipartUpload(sf.pathname, parts, {
      ...common, token: await tokenFor(attempt > 0), key: sf.mp.key, uploadId: sf.mp.uploadId,
    }), signal, onWait);
  } catch (err) {
    // Storage may have dropped an old unfinished upload; start this file over once.
    if (signal.aborted || !resumed || restarted) throw err;
    sf.mp = null;
    uploadSession.save(session);
    onPart(0);
    return uploadInParts(session, sf, file, { common, tokenFor, signal, onWait, onPart }, true);
  }
}
