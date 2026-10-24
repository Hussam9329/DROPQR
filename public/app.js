const EXPIRY_LABELS = {
  '5m': '5 min', '10m': '10 min', '30m': '30 min', '1h': '1 hour', '6h': '6 hours',
  '12h': '12 hours', '1d': '1 day', '3d': '3 days', '7d': '7 days',
};

const state = { file: null, expiry: '1h', downloads: 4, maxBytes: Infinity, current: null, timer: null };

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
  $('#expiry-hint').textContent = EXPIRY_LABELS[state.expiry];
  $('#dl-hint').textContent = state.downloads === 1 ? '1 download' : `${state.downloads} downloads`;
}

fetch('/api/config').then((r) => r.json()).then((cfg) => {
  state.maxBytes = cfg.maxFileMb * 1024 * 1024;
  $('#limit-text').textContent = `Any file type · up to ${cfg.maxFileMb} MB`;
  renderChips($('#expiry'), cfg.expiryOptions, (v) => EXPIRY_LABELS[v] || v, state.expiry, (v) => { state.expiry = v; updateHints(); });
  renderChips($('#downloads'), cfg.downloadOptions, (v) => (v === 1 ? '1 time' : `${v} times`), state.downloads, (v) => { state.downloads = v; updateHints(); });
  updateHints();
});

// ---------- File picking ----------
const dz = $('#dropzone');
const input = $('#file');

function setFile(f) {
  $('#error').textContent = '';
  if (f && f.size > state.maxBytes) {
    $('#error').textContent = `That file is ${formatBytes(f.size)} — the limit is ${formatBytes(state.maxBytes)}.`;
    f = null;
  }
  state.file = f || null;
  $('#chip').classList.toggle('show', !!f);
  dz.style.display = f ? 'none' : '';
  $('#submit').disabled = !f;
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
window.addEventListener('drop', (e) => { e.preventDefault(); if (!state.current && e.dataTransfer.files[0]) setFile(e.dataTransfer.files[0]); });

// ---------- Upload ----------
// 1) reserve a slot  2) upload straight to Blob storage  3) confirm and get the link
async function api(url, body) {
  const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || 'Upload failed. Please try again.');
  return data;
}

function setProgress(pct, label) {
  $('#bar').style.width = pct + '%';
  $('#progress-pct').textContent = Math.round(pct) + '%';
  if (label) $('#progress-label').textContent = label;
}

$('#form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const file = state.file;
  if (!file) return;

  $('#submit').disabled = true;
  $('#error').textContent = '';
  $('#progress').classList.add('show');
  setProgress(0, 'Preparing…');

  try {
    const slot = await api('/api/uploads', {
      name: file.name, size: file.size, type: file.type,
      expiry: state.expiry, maxDownloads: state.downloads,
    });

    setProgress(0, 'Uploading…');
    await window.blobUpload(slot.pathname, file, {
      access: 'private',
      handleUploadUrl: '/api/blob-upload',
      clientPayload: slot.id,
      contentType: file.type || undefined,
      multipart: file.size > 50 * 1024 * 1024,
      onUploadProgress: (p) => setProgress(p.percentage, p.percentage >= 100 ? 'Finishing…' : 'Uploading…'),
    });

    setProgress(100, 'Finishing…');
    const data = await api(`/api/uploads/${slot.id}/complete`, { deleteToken: slot.deleteToken });
    store.set([{ id: data.id, name: data.name, url: data.url, deleteToken: data.deleteToken, expiresAt: data.expiresAt }, ...store.get()]);
    showResult(data);
    renderRecent();
  } catch (err) {
    $('#error').textContent = err.message || 'Upload failed. Please try again.';
    $('#submit').disabled = false;
  } finally {
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
  $('#r-left').textContent = `${data.remaining} of ${data.maxDownloads}`;
  $('#share').hidden = !navigator.share;
  tick();
  clearInterval(state.timer);
  state.timer = setInterval(tick, 1000);
  pollStats();
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
      $('#r-left').textContent = `${m.remaining} of ${m.maxDownloads}`;
    } else {
      $('#r-left').textContent = '0 — link expired';
      $('#r-expires').textContent = 'Expired';
      clearInterval(state.timer);
      return;
    }
  } catch {}
  setTimeout(pollStats, 4000);
}

$('#copy').onclick = async () => {
  try { await navigator.clipboard.writeText($('#link').value); }
  catch { $('#link').select(); document.execCommand('copy'); }
  toast('Link copied');
};
$('#share').onclick = () => navigator.share({ title: state.current.name, url: state.current.url }).catch(() => {});
$('#link').onclick = (e) => e.target.select();

$('#delete').onclick = async () => {
  if (!state.current || !confirm('Delete this file now? The link will stop working.')) return;
  await deleteLink(state.current.id, state.current.deleteToken);
  toast('File deleted');
  reset();
};

$('#again').onclick = reset;

function reset() {
  state.current = null;
  clearInterval(state.timer);
  $('#result').classList.remove('show');
  $('#form').style.display = '';
  setFile(null);
}

async function deleteLink(id, token) {
  await fetch(`/api/files/${id}`, { method: 'DELETE', headers: { 'X-Delete-Token': token } }).catch(() => {});
  store.set(store.get().filter((x) => x.id !== id));
  renderRecent();
}

// ---------- Recent links (this browser only) ----------
async function renderRecent() {
  const list = store.get().filter((x) => x.expiresAt > nowMs());
  store.set(list);
  const box = $('#recent-list');
  $('#recent').style.display = list.length ? '' : 'none';
  box.innerHTML = '';

  for (const item of list) {
    const row = document.createElement('div');
    row.style.cssText = 'display:flex;align-items:center;gap:12px;padding:12px 20px;border-bottom:1px solid var(--border)';
    row.innerHTML = `
      <div class="ficon" style="width:36px;height:36px;border-radius:9px;background:var(--accent-soft);color:var(--accent);display:grid;place-items:center;font-size:10px;font-weight:700;text-transform:uppercase;flex:none"></div>
      <div style="min-width:0;flex:1">
        <div class="n" style="font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis"></div>
        <div class="s" style="color:var(--muted);font-size:13px">Loading…</div>
      </div>
      <button class="btn btn-ghost c" style="padding:8px 12px;font-size:13px">Copy</button>
      <button class="icon-btn d" aria-label="Delete"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 6h18M8 6V4h8v2M6 6l1 14h10l1-14"/></svg></button>`;
    row.querySelector('.ficon').textContent = extOf(item.name).slice(0, 4);
    row.querySelector('.n').textContent = item.name;
    row.querySelector('.c').onclick = () => navigator.clipboard.writeText(item.url).then(() => toast('Link copied'));
    row.querySelector('.d').onclick = () => confirm(`Delete "${item.name}"?`) && deleteLink(item.id, item.deleteToken);
    box.appendChild(row);

    fetch(`/api/files/${item.id}`).then(async (r) => {
      const s = row.querySelector('.s');
      if (!r.ok) { s.textContent = 'Expired'; return; }
      const m = await r.json();
      syncClock(m);
      s.textContent = `${m.downloads}/${m.maxDownloads} downloads · expires in ${formatLeft(m.expiresAt - nowMs())}`;
    }).catch(() => {});
  }
  if (box.lastElementChild) box.lastElementChild.style.borderBottom = '0';
}
renderRecent();
