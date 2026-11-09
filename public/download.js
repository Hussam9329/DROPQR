const id = decodeURIComponent(location.pathname.split('/').pop());
const box = $('#box');
let meta = null;
let password = ''; // kept only in this page, for protected files
// Signed links from the last download, valid for a short time. While they are
// valid, saving more files from this link doesn't use up another download.
let links = null;
let timer = null;

// File types that can run programs when opened.
const RISKY = new Set(['exe', 'msi', 'bat', 'cmd', 'com', 'scr', 'pif', 'vbs', 'vbe', 'js', 'jse', 'wsf', 'ps1',
  'hta', 'jar', 'apk', 'xapk', 'lnk', 'reg', 'dll', 'iso', 'img', 'dmg', 'pkg', 'app', 'sh', 'html', 'htm', 'svg', 'xlsm', 'docm']);

function showGone(titleKey, textKey) {
  clearInterval(timer);
  document.title = `${t(titleKey)} — DropQR`;
  box.innerHTML = `
    <div class="state-icon"><svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><circle cx="12" cy="12" r="9"/><path d="M15 9l-6 6M9 9l6 6"/></svg></div>
    <h1></h1><p class="sub"></p>
    <a class="btn btn-primary" href="/"></a>`;
  box.querySelector('h1').textContent = t(titleKey);
  box.querySelector('.sub').textContent = t(textKey);
  box.querySelector('a').textContent = t('shareAFile');
}

function goneFor(status) {
  if (status === 404) return showGone('goneNotFoundTitle', 'goneNotFoundText');
  if (status === 451) return showGone('goneRemovedTitle', 'goneRemovedText');
  return showGone('goneExpiredTitle', 'goneExpiredText');
}

function timeAgo(ms) {
  const min = Math.floor((nowMs() - ms) / 60000);
  if (min < 1) return t('agoNow');
  if (min < 60) return t('agoMin', { n: min });
  if (min < 1440) return t('agoHour', { n: Math.floor(min / 60) });
  return t('agoDay', { n: Math.floor(min / 1440) });
}

// Protected file: ask for the password before showing anything about it.
function renderLocked() {
  document.title = `${t('protectedTitle')} — DropQR`;
  box.innerHTML = `
    <div class="big-icon lock"><svg width="30" height="30" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="4" y="10" width="16" height="11" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3"/></svg></div>
    <h1></h1>
    <p class="sub"></p>
    <form id="unlock-form" class="unlock">
      <input type="password" id="pw" required autocomplete="off">
      <button class="btn btn-primary" type="submit"></button>
    </form>`;
  box.querySelector('h1').textContent = t('protectedTitle');
  box.querySelector('.sub').textContent = t('protectedText');
  $('#pw').placeholder = t('passwordLabel');
  $('#pw').setAttribute('aria-label', t('passwordLabel'));
  box.querySelector('#unlock-form button').textContent = t('unlock');
  $('#pw').focus();
  $('#unlock-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = e.target.querySelector('button');
    btn.disabled = true;
    try {
      const r = await fetch(`/api/files/${encodeURIComponent(id)}/unlock`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: $('#pw').value }),
      });
      const data = await r.json().catch(() => ({}));
      if ([404, 410, 451].includes(r.status)) return goneFor(r.status);
      if (!r.ok) throw new Error(errorText(data, 'wrongPassword'));
      password = $('#pw').value;
      syncClock(data);
      meta = data;
      render();
    } catch (err) {
      toast(err.message);
      btn.disabled = false;
      $('#pw').select();
    }
  });
}

function render() {
  const files = meta.files;
  const many = files.length > 1;
  const first = files[0];
  document.title = `${many ? t('moreFiles', { name: first.name, n: files.length - 1 }) : first.name} — DropQR`;
  box.innerHTML = `
    <div class="big-icon"></div>
    <h1></h1>
    <p class="sub"></p>
    <div class="stats">
      <div class="stat"><small></small><b id="left">—</b></div>
      <div class="stat"><small></small><b id="dl-left"></b></div>
    </div>
    <div class="dl-files" id="dl-files" hidden></div>
    <p class="notice warn" id="risky" hidden></p>
    <p class="notice" id="last" hidden></p>
    <button class="btn btn-primary" id="go" type="button">
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3"/></svg>
      <span></span>
    </button>
    <p class="saved-hint" id="saved-hint" hidden></p>
    <details class="report">
      <summary></summary>
      <form id="report-form">
        <label for="report-reason"></label>
        <select id="report-reason" required><option value=""></option></select>
        <textarea id="report-details" maxlength="1000" rows="3"></textarea>
        <button class="btn btn-ghost" type="submit"></button>
      </form>
    </details>`;

  const exts = files.map((f) => extOf(f.name).toLowerCase());
  box.querySelector('.big-icon').textContent = many ? String(files.length) : exts[0].slice(0, 4);
  box.querySelector('h1').textContent = many ? countText(files.length, 'oneFile', 'nFiles', 'nFilesMany') : first.name;
  if (!many) box.querySelector('h1').dir = 'ltr'; // a file name reads left to right, like in Windows
  // The real type is shown on its own, so a misleading name can't hide it.
  const kind = many ? '' : ` · \u2066.${exts[0]}\u2069`;
  box.querySelector('.sub').textContent = `${formatBytes(meta.size)}${kind} · ${t('sharedAgo', { ago: timeAgo(meta.createdAt) })}`;
  const [s1, s2] = box.querySelectorAll('.stat small');
  s1.textContent = t('linkExpiresIn');
  s2.textContent = t('downloadsLeft');
  $('#go span').textContent = many ? t('downloadAll', { n: files.length }) : t('downloadFile');
  $('#saved-hint').textContent = t('savedHint');

  const risky = [...new Set(exts.filter((e) => RISKY.has(e)))];
  if (risky.length) {
    $('#risky').textContent = t('riskyFile', { ext: `\u2066${risky.map((e) => `.${e}`).join(' ')}\u2069` });
    $('#risky').hidden = false;
  }

  if (many) {
    const list = $('#dl-files');
    list.hidden = false;
    for (const f of files) {
      const row = document.createElement('div');
      row.className = 'dl-file';
      row.innerHTML = `
        <div class="ficon"></div>
        <div class="meta"><div class="n fname" dir="ltr"></div><div class="s"></div></div>
        <button class="btn btn-ghost" type="button"></button>`;
      row.querySelector('.ficon').textContent = extOf(f.name).slice(0, 4);
      row.querySelector('.n').textContent = f.name;
      row.querySelector('.s').textContent = formatBytes(f.size);
      const btn = row.querySelector('button');
      btn.textContent = t('downloadOne');
      btn.addEventListener('click', () => download([f.idx], btn));
      list.appendChild(row);
    }
  }

  box.querySelector('.report summary').textContent = t('reportFile');
  box.querySelector('label[for="report-reason"]').textContent = t('reportQuestion');
  box.querySelector('#report-reason option').textContent = t('chooseReason');
  $('#report-details').placeholder = t('reportDetails');
  box.querySelector('#report-form button').textContent = t('sendReport');
  updateCount();
  $('#go').addEventListener('click', () => download(files.map((f) => f.idx), $('#go')));
  setUpReport();
  tick();
  clearInterval(timer);
  timer = setInterval(tick, 1000);
}

function updateCount() {
  $('#dl-left').textContent = t('nOfM', { n: meta.remaining, m: meta.maxDownloads });
  $('#last').textContent = t('lastDownload');
  // Once the links are in hand, the remaining files don't need another download.
  $('#last').hidden = meta.remaining !== 1 || Boolean(links);
}

// Uses up one download (only when there are no valid links yet) and returns
// the signed link of every file in this share.
async function getLinks() {
  if (links && links.until > Date.now()) return links.urls;
  const r = await fetch(`/api/files/${encodeURIComponent(meta.id)}/download`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password }),
  });
  const data = await r.json().catch(() => ({}));
  if ([404, 410, 451].includes(r.status)) {
    goneFor(r.status);
    return null;
  }
  if (!r.ok) throw new Error(errorText(data, 'downloadFailed'));
  links = { urls: data.urls || [{ idx: 0, url: data.url }], until: Date.now() + (data.validFor || 15 * 60 * 1000) - 30 * 1000 };
  meta.remaining = data.remaining;
  updateCount();
  return links.urls;
}

// Saves a file without leaving the page; several files go one after another,
// because browsers ignore downloads started all at the same moment.
function save(url, i) {
  setTimeout(() => {
    const frame = document.createElement('iframe');
    frame.hidden = true;
    frame.src = url;
    document.body.appendChild(frame);
    setTimeout(() => frame.remove(), 60 * 1000);
  }, i * 900);
}

// One click = one request: the button stays disabled while it runs, so a
// double tap can't use up two downloads.
async function download(idxs, btn) {
  if (btn.disabled) return;
  btn.disabled = true;
  const label = btn.querySelector('span') || btn;
  const before = label.textContent;
  label.textContent = t('preparing');
  try {
    const urls = await getLinks();
    if (!urls) return;
    const chosen = urls.filter((u) => idxs.includes(u.idx));
    if (chosen.length === 1) location.href = chosen[0].url; // saved as a file; this page stays open
    else chosen.forEach((u, i) => save(u.url, i));
    $('#saved-hint').hidden = false;
    toast(t('downloadStarted'));
  } catch (err) {
    toast(err.message || t('downloadFailed'));
  }
  // Short pause before the same button can be pressed again.
  setTimeout(() => {
    if (!btn.isConnected) return;
    label.textContent = before;
    btn.disabled = meta.remaining <= 0 && !(links && links.until > Date.now());
  }, 3000);
}

function setUpReport() {
  configReady.then((cfg) => {
    for (const value of Object.keys(cfg.reportReasons || {})) {
      $('#report-reason').append(new Option(t(`reason_${value}`), value));
    }
  });
  $('#report-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = e.target.querySelector('button');
    btn.disabled = true;
    try {
      const r = await fetch(`/api/files/${encodeURIComponent(meta.id)}/report`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reason: $('#report-reason').value, details: $('#report-details').value }),
      });
      const data = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(errorText(data, 'reportFailed'));
      const done = document.createElement('p');
      done.className = 'report-done';
      done.textContent = t('reportThanks');
      $('.report').replaceChildren(done);
    } catch (err) {
      toast(err.message || t('reportFailed'));
      btn.disabled = false;
    }
  });
}

function tick() {
  const ms = meta.expiresAt - nowMs();
  if (ms <= 0) return showGone('goneExpiredTitle', 'goneTimeText');
  $('#left').textContent = formatLeft(ms);
}

async function load() {
  try {
    const r = await fetch(`/api/files/${encodeURIComponent(id)}`);
    if (!r.ok) return goneFor(r.status);
    const fresh = await r.json();
    syncClock(fresh);
    meta = fresh;
    if (meta.hasPassword) renderLocked();
    else render();
  } catch {
    showGone('goneNetTitle', 'goneNetText');
  }
}
load();
