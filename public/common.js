// Shared helpers for both pages.
const $ = (s) => document.querySelector(s);

// Wrapped in direction isolates so "2.0 MB" never flips inside Arabic text.
function formatBytes(n) {
  return `⁦${formatSize(n)}⁩`;
}

function formatSize(n) {
  if (n < 1024) return `${n} B`;
  const u = ['KB', 'MB', 'GB'];
  let i = -1;
  do { n /= 1024; i++; } while (n >= 1024 && i < u.length - 1);
  return `${n.toFixed(n < 10 ? 1 : 0)} ${u[i]}`;
}

function formatLeft(ms) {
  if (ms <= 0) return t('expired');
  const s = Math.floor(ms / 1000);
  const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  if (d) return `${d}${t('unitD')} ${h}${t('unitH')}`;
  if (h) return `${h}${t('unitH')} ${m}${t('unitM')}`;
  return `${m}:${String(sec).padStart(2, '0')}`;
}

function extOf(name) {
  const m = /\.([a-z0-9]{1,5})$/i.exec(name || '');
  return m ? m[1] : 'file';
}

function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => t.classList.remove('show'), 1800);
}

// Server time minus this device's time, so countdowns stay right even if the device clock is off.
let clockOffset = 0;
function syncClock(meta) { if (meta && meta.serverNow) clockOffset = meta.serverNow - Date.now(); }
const nowMs = () => Date.now() + clockOffset;

const store = {
  get() { try { return JSON.parse(localStorage.getItem('dropqr:links') || '[]'); } catch { return []; } },
  set(list) { try { localStorage.setItem('dropqr:links', JSON.stringify(list.slice(0, 20))); } catch {} },
};

// Site settings from the server, loaded once per page.
const configReady = fetch('/api/config').then((r) => r.json()).catch(() => ({}));

// Shows the abuse contact wherever the page has a .abuse-email slot.
configReady.then((cfg) => {
  document.querySelectorAll('.abuse-email').forEach((el) => {
    if (!cfg.abuseEmail) { (el.closest('.abuse-contact') || el).hidden = true; return; }
    const inFooter = !!el.closest('.legal');
    const a = document.createElement('a');
    a.href = `mailto:${cfg.abuseEmail}`;
    a.textContent = inFooter ? t('reportAbuse') : cfg.abuseEmail;
    el.replaceChildren(inFooter ? ' · ' : '', a);
  });
});

// Translate the page, and wire the language switch.
applyI18n();
document.querySelectorAll('.lang-toggle').forEach((b) => {
  b.textContent = t('switchLang');
  b.onclick = () => setLang(LANG === 'ar' ? 'en' : 'ar');
});
