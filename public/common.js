// Shared helpers for both pages.
const $ = (s) => document.querySelector(s);

function formatBytes(n) {
  if (n < 1024) return `${n} B`;
  const u = ['KB', 'MB', 'GB'];
  let i = -1;
  do { n /= 1024; i++; } while (n >= 1024 && i < u.length - 1);
  return `${n.toFixed(n < 10 ? 1 : 0)} ${u[i]}`;
}

function formatLeft(ms) {
  if (ms <= 0) return 'Expired';
  const s = Math.floor(ms / 1000);
  const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  if (d) return `${d}d ${h}h`;
  if (h) return `${h}h ${m}m`;
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
