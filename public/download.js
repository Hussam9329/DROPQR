const id = decodeURIComponent(location.pathname.split('/').pop());
const box = $('#box');
let meta = null;
let password = ''; // kept only in this page, for protected files
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
  document.title = `${meta.name} — DropQR`;
  const ext = extOf(meta.name).toLowerCase();
  box.innerHTML = `
    <div class="big-icon"></div>
    <h1 dir="auto"></h1>
    <p class="sub"></p>
    <div class="stats">
      <div class="stat"><small></small><b id="left">—</b></div>
      <div class="stat"><small></small><b id="dl-left"></b></div>
    </div>
    <p class="notice warn" id="risky" hidden></p>
    <p class="notice" id="last" hidden></p>
    <button class="btn btn-primary" id="go" type="button">
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3"/></svg>
      <span></span>
    </button>
    <details class="report">
      <summary></summary>
      <form id="report-form">
        <label for="report-reason"></label>
        <select id="report-reason" required><option value=""></option></select>
        <textarea id="report-details" maxlength="1000" rows="3"></textarea>
        <button class="btn btn-ghost" type="submit"></button>
      </form>
    </details>`;
  box.querySelector('.big-icon').textContent = ext.slice(0, 4);
  box.querySelector('h1').textContent = meta.name;
  // The real type is shown on its own, so a misleading name can't hide it.
  box.querySelector('.sub').textContent = `${formatBytes(meta.size)} · ⁦.${ext}⁩ · ${t('sharedAgo', { ago: timeAgo(meta.createdAt) })}`;
  const [s1, s2] = box.querySelectorAll('.stat small');
  s1.textContent = t('linkExpiresIn');
  s2.textContent = t('downloadsLeft');
  $('#go span').textContent = t('downloadFile');
  if (RISKY.has(ext)) {
    $('#risky').textContent = t('riskyFile', { ext: `⁦.${ext}⁩` });
    $('#risky').hidden = false;
  }
  box.querySelector('.report summary').textContent = t('reportFile');
  box.querySelector('label[for="report-reason"]').textContent = t('reportQuestion');
  box.querySelector('#report-reason option').textContent = t('chooseReason');
  $('#report-details').placeholder = t('reportDetails');
  box.querySelector('#report-form button').textContent = t('sendReport');
  updateCount();
  $('#go').addEventListener('click', download);
  setUpReport();
  tick();
  clearInterval(timer);
  timer = setInterval(tick, 1000);
}

function updateCount() {
  $('#dl-left').textContent = t('nOfM', { n: meta.remaining, m: meta.maxDownloads });
  $('#last').textContent = t('lastDownload');
  $('#last').hidden = meta.remaining !== 1;
}

// One click = one download: the button stays disabled while the request runs,
// so a double tap can't use up two downloads.
async function download() {
  const btn = $('#go');
  if (btn.disabled) return;
  btn.disabled = true;
  btn.querySelector('span').textContent = t('preparing');
  try {
    const r = await fetch(`/api/files/${encodeURIComponent(meta.id)}/download`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password }),
    });
    const data = await r.json().catch(() => ({}));
    if ([404, 410, 451].includes(r.status)) return goneFor(r.status);
    if (!r.ok) throw new Error(errorText(data, 'downloadFailed'));
    location.href = data.url; // saved as a file; this page stays open
    meta.remaining = data.remaining;
    updateCount();
    toast(t('downloadStarted'));
  } catch (err) {
    toast(err.message || t('downloadFailed'));
  }
  // Short pause before another download can be started.
  setTimeout(() => {
    if (!$('#go')) return;
    btn.querySelector('span').textContent = t('downloadFile');
    btn.disabled = meta.remaining <= 0;
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
