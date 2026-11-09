const state = { files: [], expiry: '1h', downloads: 4, maxBytes: Infinity, maxFiles: 20, current: null, timer: null, upload: null };

// The last time and download choices are remembered on this device.
const PREFS_KEY = 'dropqr:prefs';
try {
  const saved = JSON.parse(localStorage.getItem(PREFS_KEY) || '{}');
  if (saved.expiry) state.expiry = saved.expiry;
  if (saved.downloads) state.downloads = saved.downloads;
} catch {}
function savePrefs() {
  try { localStorage.setItem(PREFS_KEY, JSON.stringify({ expiry: state.expiry, downloads: state.downloads })); } catch {}
}

// "photo.jpg" or "photo.jpg + 4 more"
function linkLabel(files) {
  return files.length > 1 ? t('moreFiles', { name: files[0].name, n: files.length - 1 }) : files[0].name;
}

// ---------- Option chips ----------
function renderChips(container, values, label, selected, onPick) {
  container.innerHTML = '';
  for (const v of values) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'chip';
    b.textContent = label(v);
    b.setAttribute('aria-pressed', String(v === selected));
    b.onclick = () => {
      container.querySelectorAll('.chip').forEach((c) => c.setAttribute('aria-pressed', 'false'));
      b.setAttribute('aria-pressed', 'true');
      onPick(v);
    };
    container.appendChild(b);
  }
}

function updateHints() {
  $('#expiry-hint').textContent = t(`exp_${state.expiry}`);
  $('#dl-hint').textContent = countText(state.downloads, 'oneDownload', 'nDownloads', 'nDownloadsMany');
}

// The consent line has a link in the middle, so it is built from parts.
(() => {
  const [before, after] = t('consent', { terms: '\u0000' }).split('\u0000');
  const a = document.createElement('a');
  a.href = '/terms.html';
  a.textContent = t('terms');
  $('#consent').replaceChildren(before, a, after || '');
})();

configReady.then((cfg) => {
  if (!cfg.expiryOptions) {
    $('#error').textContent = t('configError');
    return;
  }
  state.maxBytes = cfg.maxFileMb * 1024 * 1024;
  state.maxFiles = cfg.maxFiles || 20;
  if (!cfg.expiryOptions.includes(state.expiry)) state.expiry = '1h';
  if (!cfg.downloadOptions.includes(state.downloads)) state.downloads = 4;
  $('#limit-text').textContent = t('dropLimit', { mb: cfg.maxFileMb, max: state.maxFiles });
  renderChips($('#expiry'), cfg.expiryOptions, (v) => t(`exp_${v}`), state.expiry, (v) => { state.expiry = v; updateHints(); savePrefs(); });
  renderChips($('#downloads'), cfg.downloadOptions, (v) => countText(v, 'oneTime', 'nTimes', 'nTimesMany'), state.downloads, (v) => { state.downloads = v; updateHints(); savePrefs(); });
  updateHints();
  renderPicked();
});

// ---------- File picking ----------
const dz = $('#dropzone');
const input = $('#file');
const totalBytes = () => state.files.reduce((sum, f) => sum + f.size, 0);

function addFiles(list) {
  if (state.upload) return;
  $('#error').textContent = '';
  const room = state.maxFiles - state.files.length;
  const incoming = [...list].filter((f) => f.size > 0);
  if (incoming.length > room) $('#error').textContent = t('tooManyFiles', { max: state.maxFiles });
  state.files.push(...incoming.slice(0, Math.max(0, room)));
  renderPicked();
}

function removeFile(i) {
  state.files.splice(i, 1);
  $('#error').textContent = '';
  renderPicked();
}

function renderPicked() {
  const files = state.files;
  const total = totalBytes();
  const tooBig = total > state.maxBytes;
  dz.style.display = files.length ? 'none' : '';
  $('#picked').hidden = !files.length;
  $('#add-more').hidden = files.length >= state.maxFiles;
  $('#picked-total').textContent = t('filesTotal', {
    files: countText(files.length, 'oneFile', 'nFiles', 'nFilesMany'), size: formatBytes(total),
  });
  // The size message comes and goes as files are added or removed.
  if (tooBig) $('#error').textContent = t('tooBig', { size: formatBytes(total), max: formatBytes(state.maxBytes) });
  else if (state.sizeError) $('#error').textContent = '';
  state.sizeError = tooBig;
  $('#submit').disabled = !files.length || tooBig || state.maxBytes === Infinity;

  const list = $('#file-list');
  list.innerHTML = '';
  files.forEach((f, i) => {
    const row = document.createElement('div');
    row.className = 'file-chip show';
    row.innerHTML = `
      <div class="ficon"></div>
      <div class="meta"><div class="name fname" dir="ltr"></div><div class="size"></div></div>
      <button type="button" class="icon-btn"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 6L6 18M6 6l12 12"/></svg></button>`;
    row.querySelector('.ficon').textContent = extOf(f.name).slice(0, 4);
    row.querySelector('.name').textContent = f.name;
    row.querySelector('.size').textContent = formatBytes(f.size);
    const btn = row.querySelector('button');
    btn.setAttribute('aria-label', `${t('removeFile')}: ${f.name}`);
    btn.onclick = () => removeFile(i);
    list.appendChild(row);
  });
  if (!files.length) input.value = '';
}

input.addEventListener('change', () => { addFiles(input.files); input.value = ''; });
$('#add-more').onclick = () => input.click();
['dragenter', 'dragover'].forEach((e) => dz.addEventListener(e, (ev) => { ev.preventDefault(); dz.classList.add('drag'); }));
['dragleave', 'drop'].forEach((e) => dz.addEventListener(e, (ev) => { ev.preventDefault(); dz.classList.remove('drag'); }));
// Allow dropping anywhere on the page
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('drop', (e) => { e.preventDefault(); if (!state.current && e.dataTransfer.files.length) addFiles(e.dataTransfer.files); });
// Paste a screenshot or copied files (Ctrl+V), unless the visitor is typing in a field.
window.addEventListener('paste', (e) => {
  if (state.current || e.target.closest('input, textarea')) return;
  const files = e.clipboardData && e.clipboardData.files;
  if (!files || !files.length) return;
  e.preventDefault();
  addFiles(files);
  toast(t('pasted'));
});

$('#use-password').addEventListener('change', (e) => {
  $('#password-box').hidden = !e.target.checked;
  if (e.target.checked) $('#password').focus();
});

// ---------- Upload ----------
// 1) reserve a slot  2) upload straight to Blob storage  3) confirm and get the link
async function api(url, body, signal) {
  const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(errorText(data, 'uploadFailed'));
  return data;
}

function setProgress(pct, label) {
  $('#bar').style.width = pct + '%';
  $('#bar-wrap').setAttribute('aria-valuenow', String(Math.round(pct)));
  $('#progress-pct').textContent = Math.round(pct) + '%';
  if (label) $('#progress-label').textContent = label;
}

// "12 MB of 40 MB · 1.2 MB/s · 25s left", from the last few seconds of progress.
function transferText(sent, total, samples) {
  const now = performance.now();
  samples.push([now, sent]);
  while (samples.length > 2 && now - samples[0][0] > 5000) samples.shift();
  const [t0, s0] = samples[0];
  const speed = now - t0 > 500 ? ((sent - s0) / (now - t0)) * 1000 : 0;
  if (!speed) return '';
  const secs = Math.ceil((total - sent) / speed);
  const eta = secs < 90 ? t('etaSec', { n: secs }) : t('etaMin', { n: Math.ceil(secs / 60) });
  return t('progressDetail', { done: formatBytes(sent), total: formatBytes(total), speed: formatBytes(Math.round(speed)), eta });
}

// Keeps a phone screen from locking (which can stop the upload) while files go up.
async function keepAwake() {
  try { return await navigator.wakeLock.request('screen'); } catch { return null; }
}

// Leaving the page would lose an upload that is still running.
window.addEventListener('beforeunload', (e) => {
  if (!state.upload) return;
  e.preventDefault();
  e.returnValue = t('leaveWarning');
});
// On a weak connection, say so instead of looking frozen; the upload retries by itself.
window.addEventListener('offline', () => { if (state.upload) $('#progress-label').textContent = t('waitingNet'); });
window.addEventListener('online', () => { if (state.upload) $('#progress-label').textContent = t('uploading'); });

$('#cancel').onclick = () => state.upload && state.upload.abort();

$('#form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const files = state.files.slice();
  if (!files.length || state.upload) return;
  const password = $('#use-password').checked ? $('#password').value : '';
  if ($('#use-password').checked && (password.length < 4 || password.length > 100)) {
    $('#error').textContent = t('err_bad_password');
    $('#password').focus();
    return;
  }
  if (!navigator.onLine) {
    $('#error').textContent = t('offline');
    return;
  }

  const controller = new AbortController();
  state.upload = controller;
  const wakeLock = await keepAwake();
  $('#submit').disabled = true;
  $('#error').textContent = '';
  $('#progress').classList.add('show');
  setProgress(0, t('preparing'));

  try {
    const slot = await api('/api/uploads', {
      files: files.map((f) => ({ name: f.name, size: f.size, type: f.type })),
      expiry: state.expiry, maxDownloads: state.downloads, password,
    }, controller.signal);

    // One file after another, with one progress bar for all of them.
    const total = totalBytes();
    const samples = [];
    let done = 0;
    for (const [i, f] of files.entries()) {
      const step = files.length > 1 ? `${t('fileOfFiles', { i: i + 1, n: files.length })} · ` : '';
      await window.blobUpload(slot.items[i].pathname, f, {
        access: 'private',
        handleUploadUrl: '/api/blob-upload',
        clientPayload: slot.id,
        contentType: f.type || undefined,
        // Bigger files go up in parts; a part that fails on a weak connection is
        // sent again on its own instead of restarting the whole file.
        multipart: f.size > 8 * 1024 * 1024,
        abortSignal: controller.signal,
        onUploadProgress: (p) => {
          const sent = done + p.loaded;
          const detail = navigator.onLine ? (transferText(sent, total, samples) || t('uploading')) : t('waitingNet');
          setProgress((sent / total) * 100, step + detail);
        },
      });
      done += f.size;
    }

    setProgress(100, t('finishing'));
    const data = await api(`/api/uploads/${slot.id}/complete`, { deleteToken: slot.deleteToken }, controller.signal);
    data.name = linkLabel(data.files);
    store.set([{ id: data.id, name: data.name, size: data.size, url: data.url, deleteToken: data.deleteToken, expiresAt: data.expiresAt }, ...store.get()]);
    $('#password').value = '';
    showResult(data);
    renderRecent();
  } catch (err) {
    $('#error').textContent = controller.signal.aborted ? t('uploadCancelled') : (err.message || t('uploadFailed'));
    $('#submit').disabled = false;
  } finally {
    state.upload = null;
    if (wakeLock) wakeLock.release().catch(() => {});
    $('#progress').classList.remove('show');
    setProgress(0);
  }
});

// ---------- Result ----------
function showResult(data) {
  syncClock(data);
  state.current = data;
  $('#form').style.display = 'none';
  $('#result').classList.add('show');
  $('#result-name').textContent = `${data.name} · ${formatBytes(data.size)}`;
  $('#qr').innerHTML = data.qrSvg; // generated by our own server
  $('#qr-dl').href = data.qrPng;
  $('#link').value = data.url;
  $('#open-page').href = data.url;
  $('#r-left').textContent = t('nOfM', { n: data.remaining, m: data.maxDownloads });
  setShareLinks(data);
  tick();
  clearInterval(state.timer);
  state.timer = setInterval(tick, 1000);
  pollStats();
}

// WhatsApp, Telegram and email work everywhere; "More…" opens the phone's own share menu.
function setShareLinks(data) {
  // A protected file's name stays out of the message too.
  const text = data.hasPassword ? t('shareTextLocked') : t('shareText', { name: data.name });
  $('#share-wa').href = `https://wa.me/?text=${encodeURIComponent(`${text} ${data.url}`)}`;
  $('#share-tg').href = `https://t.me/share/url?url=${encodeURIComponent(data.url)}&text=${encodeURIComponent(text)}`;
  $('#share-mail').href = `mailto:?subject=${encodeURIComponent(data.hasPassword ? 'DropQR' : data.name)}&body=${encodeURIComponent(`${text}\n${data.url}`)}`;
  $('#share').hidden = !navigator.share;
}

function tick() {
  if (!state.current) return;
  $('#r-expires').textContent = formatLeft(state.current.expiresAt - nowMs());
}

// Refresh the download count every few seconds while the result is open.
async function pollStats() {
  const cur = state.current;
  if (!cur) return;
  try {
    const r = await fetch(`/api/files/${cur.id}`);
    if (state.current !== cur) return;
    if (r.ok) {
      const m = await r.json();
      syncClock(m);
      $('#r-left').textContent = t('nOfM', { n: m.remaining, m: m.maxDownloads });
    } else {
      $('#r-left').textContent = t('expiredLeft');
      $('#r-expires').textContent = t('expired');
      clearInterval(state.timer);
      return;
    }
  } catch {}
  setTimeout(pollStats, 4000);
}

async function copyText(text) {
  try { await navigator.clipboard.writeText(text); }
  catch {
    const tmp = Object.assign(document.createElement('textarea'), { value: text });
    document.body.appendChild(tmp);
    tmp.select();
    document.execCommand('copy');
    tmp.remove();
  }
  toast(t('linkCopied'));
}

$('#copy').onclick = () => copyText($('#link').value);
$('#share').onclick = () => navigator.share({ title: state.current.hasPassword ? 'DropQR' : state.current.name, url: state.current.url }).catch(() => {});
$('#link').onclick = (e) => e.target.select();

$('#delete').onclick = async () => {
  if (!state.current || !confirm(t('confirmDelete'))) return;
  if (await deleteLink(state.current.id, state.current.deleteToken)) reset();
};

$('#again').onclick = reset;

function reset() {
  state.current = null;
  clearInterval(state.timer);
  $('#result').classList.remove('show');
  $('#form').style.display = '';
  state.files = [];
  renderPicked();
}

// Returns true once the file is gone. On failure the link and its delete
// token stay saved, so the user can try again.
async function deleteLink(id, token) {
  const r = await fetch(`/api/files/${id}`, { method: 'DELETE', headers: { 'X-Delete-Token': token } }).catch(() => null);
  if (!r || (!r.ok && r.status !== 404)) {
    toast(t('deleteFailed'));
    return false;
  }
  store.set(store.get().filter((x) => x.id !== id));
  renderRecent();
  toast(t('deleted'));
  return true;
}

// Shows a saved link's card again: QR code, link, time and downloads left.
async function reopen(item) {
  const r = await fetch(`/api/files/${encodeURIComponent(item.id)}?share=1`).catch(() => null);
  if (!r) return toast(t('noServer'));
  if (!r.ok) {
    toast(t('err_expired'));
    return renderRecent();
  }
  const data = await r.json();
  // A protected link comes back without its names; this browser still knows them.
  const name = data.files ? linkLabel(data.files) : item.name;
  showResult({ ...data, name, size: data.size ?? item.size ?? 0, deleteToken: item.deleteToken });
  $('.uploader').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

// ---------- Recent links (this browser only) ----------
async function renderRecent() {
  const list = store.get().filter((x) => x.expiresAt > nowMs());
  store.set(list);
  const box = $('#recent-list');
  $('#recent').hidden = !list.length;
  box.innerHTML = '';

  for (const item of list) {
    const row = document.createElement('div');
    row.className = 'recent-row';
    row.innerHTML = `
      <div class="ficon"></div>
      <div class="meta"><div class="n fname" dir="ltr"></div><div class="s"></div></div>
      <button class="btn btn-ghost q" type="button"></button>
      <button class="btn btn-ghost c" type="button"></button>
      <button class="icon-btn d" type="button"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 6h18M8 6V4h8v2M6 6l1 14h10l1-14"/></svg></button>`;
    row.querySelector('.ficon').textContent = extOf(item.name).slice(0, 4);
    row.querySelector('.n').textContent = item.name;
    row.querySelector('.s').textContent = t('loading');
    row.querySelector('.q').textContent = t('qr');
    row.querySelector('.c').textContent = t('copy');
    row.querySelector('.d').setAttribute('aria-label', t('deleteLabel'));
    row.querySelector('.q').onclick = () => reopen(item);
    row.querySelector('.c').onclick = () => copyText(item.url);
    row.querySelector('.d').onclick = () => confirm(t('confirmDeleteNamed', { name: item.name })) && deleteLink(item.id, item.deleteToken);
    box.appendChild(row);

    fetch(`/api/files/${item.id}`).then(async (r) => {
      const s = row.querySelector('.s');
      if (!r.ok) { s.textContent = t('expired'); return; }
      const m = await r.json();
      syncClock(m);
      s.textContent = t('recentStats', { d: m.downloads, m: m.maxDownloads, left: formatLeft(m.expiresAt - nowMs()) });
    }).catch(() => {});
  }
}
renderRecent();
