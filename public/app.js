const state = { file: null, expiry: '1h', downloads: 4, maxBytes: Infinity, current: null, timer: null, upload: null };

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
  $('#limit-text').textContent = t('dropLimit', { mb: cfg.maxFileMb });
  renderChips($('#expiry'), cfg.expiryOptions, (v) => t(`exp_${v}`), state.expiry, (v) => { state.expiry = v; updateHints(); });
  renderChips($('#downloads'), cfg.downloadOptions, (v) => countText(v, 'oneTime', 'nTimes', 'nTimesMany'), state.downloads, (v) => { state.downloads = v; updateHints(); });
  updateHints();
  if (state.file) $('#submit').disabled = false;
});

// ---------- File picking ----------
const dz = $('#dropzone');
const input = $('#file');

function setFile(f) {
  $('#error').textContent = '';
  if (f && f.size > state.maxBytes) {
    $('#error').textContent = t('tooBig', { size: formatBytes(f.size), max: formatBytes(state.maxBytes) });
    f = null;
  }
  state.file = f || null;
  $('#chip').classList.toggle('show', !!f);
  dz.style.display = f ? 'none' : '';
  $('#submit').disabled = !f || state.maxBytes === Infinity;
  if (f) {
    $('#chip-name').textContent = f.name;
    $('#chip-size').textContent = formatBytes(f.size);
    $('#chip-ext').textContent = extOf(f.name).slice(0, 4);
  } else {
    input.value = '';
  }
}

input.addEventListener('change', () => setFile(input.files[0]));
$('#chip-remove').onclick = () => setFile(null);
['dragenter', 'dragover'].forEach((e) => dz.addEventListener(e, (ev) => { ev.preventDefault(); dz.classList.add('drag'); }));
['dragleave', 'drop'].forEach((e) => dz.addEventListener(e, (ev) => { ev.preventDefault(); dz.classList.remove('drag'); }));
dz.addEventListener('drop', (ev) => setFile(ev.dataTransfer.files[0]));
// Allow dropping anywhere on the page
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('drop', (e) => { e.preventDefault(); if (!state.current && !state.upload && e.dataTransfer.files[0]) setFile(e.dataTransfer.files[0]); });

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
  const file = state.file;
  if (!file || state.upload) return;
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
  $('#submit').disabled = true;
  $('#error').textContent = '';
  $('#progress').classList.add('show');
  setProgress(0, t('preparing'));

  try {
    const slot = await api('/api/uploads', {
      name: file.name, size: file.size, type: file.type,
      expiry: state.expiry, maxDownloads: state.downloads, password,
    }, controller.signal);

    setProgress(0, t('uploading'));
    await window.blobUpload(slot.pathname, file, {
      access: 'private',
      handleUploadUrl: '/api/blob-upload',
      clientPayload: slot.id,
      contentType: file.type || undefined,
      // Bigger files go up in parts; a part that fails on a weak connection is
      // sent again on its own instead of restarting the whole file.
      multipart: file.size > 8 * 1024 * 1024,
      abortSignal: controller.signal,
      onUploadProgress: (p) => setProgress(p.percentage, p.percentage >= 100 ? t('finishing') : (navigator.onLine ? t('uploading') : t('waitingNet'))),
    });

    setProgress(100, t('finishing'));
    const data = await api(`/api/uploads/${slot.id}/complete`, { deleteToken: slot.deleteToken }, controller.signal);
    store.set([{ id: data.id, name: data.name, size: data.size, url: data.url, deleteToken: data.deleteToken, expiresAt: data.expiresAt }, ...store.get()]);
    $('#password').value = '';
    showResult(data);
    renderRecent();
  } catch (err) {
    $('#error').textContent = controller.signal.aborted ? t('uploadCancelled') : (err.message || t('uploadFailed'));
    $('#submit').disabled = false;
  } finally {
    state.upload = null;
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
  setFile(null);
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
  // A protected file comes back without its name; this browser still knows it.
  showResult({ ...data, name: data.name ?? item.name, size: data.size ?? item.size ?? 0, deleteToken: item.deleteToken });
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
      <div class="meta"><div class="n" dir="auto"></div><div class="s"></div></div>
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
