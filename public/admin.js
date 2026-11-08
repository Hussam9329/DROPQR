// Admin page: review reported files, then block, unblock or delete them.
// The password stays in this tab only (sessionStorage).
const KEY = 'dropqr:admin';
let secret = '';
try { secret = sessionStorage.getItem(KEY) || ''; } catch {}

async function adminApi(method, url) {
  const r = await fetch(url, { method, headers: { Authorization: `Bearer ${secret}` } });
  const data = await r.json().catch(() => ({}));
  if (r.status === 401) { signOut(); throw new Error('Wrong admin password.'); }
  if (!r.ok) throw new Error(data.error || 'Something went wrong.');
  return data;
}

function signOut() {
  secret = '';
  try { sessionStorage.removeItem(KEY); } catch {}
  $('#panel').hidden = true;
  $('#logout').hidden = true;
  $('#login').hidden = false;
}

const STATUS = { ready: 'Live', blocked: 'Blocked' };

async function load(id = '') {
  const data = await adminApi('GET', `/api/admin/files${id ? `?id=${encodeURIComponent(id)}` : ''}`);
  $('#login').hidden = true;
  $('#panel').hidden = false;
  $('#logout').hidden = false;
  $('#list-title').textContent = id ? 'Search result' : 'Reported files';
  const list = $('#list');
  list.innerHTML = '';
  if (!data.files.length) {
    list.innerHTML = '<p class="admin-empty"></p>';
    list.firstChild.textContent = id ? 'No file with this id.' : 'Nothing reported. All clear.';
    return;
  }
  for (const f of data.files) list.appendChild(fileCard(f, data.reasons));
}

function fileCard(f, reasons) {
  const el = document.createElement('article');
  el.className = 'card admin-file';
  el.innerHTML = `
    <div class="admin-head">
      <div class="ficon"></div>
      <div class="meta"><b class="n"></b><small class="s"></small></div>
      <span class="badge"></span>
    </div>
    <ul class="admin-reports"></ul>
    <div class="row-actions">
      <button class="btn btn-ghost" data-act="link" type="button">Get file</button>
      <button class="btn btn-ghost" data-act="toggle" type="button"></button>
      <button class="btn btn-danger" data-act="delete" type="button">Delete</button>
    </div>`;
  el.querySelector('.ficon').textContent = extOf(f.original_name).slice(0, 4);
  el.querySelector('.n').textContent = f.original_name;
  el.querySelector('.s').textContent = [
    f.id, formatBytes(f.size), `${f.downloads}/${f.max_downloads} downloads`,
    `expires ${new Date(f.expires_at).toLocaleString()}`,
  ].join(' · ');
  const badge = el.querySelector('.badge');
  badge.textContent = STATUS[f.status] || f.status;
  badge.dataset.status = f.status;

  const ul = el.querySelector('.admin-reports');
  if (!f.reports.length) ul.remove();
  for (const r of f.reports) {
    const li = document.createElement('li');
    const b = document.createElement('b');
    b.textContent = reasons[r.reason] || r.reason;
    li.append(b, ` · ${new Date(r.created_at).toLocaleString()}`);
    if (r.details) {
      const p = document.createElement('p');
      p.textContent = r.details;
      li.appendChild(p);
    }
    ul.appendChild(li);
  }

  const toggle = el.querySelector('[data-act="toggle"]');
  toggle.textContent = f.status === 'blocked' ? 'Unblock (false alarm)' : 'Block';
  el.querySelector('.row-actions').addEventListener('click', async (e) => {
    const act = e.target.dataset.act;
    if (!act) return;
    try {
      if (act === 'link') {
        const { url } = await adminApi('POST', `/api/admin/files/${f.id}/link`);
        location.href = url; // doesn't use up the file's downloads
        return;
      }
      if (act === 'delete' && !confirm(`Delete "${f.original_name}" for good?`)) return;
      if (act === 'delete') await adminApi('DELETE', `/api/admin/files/${f.id}`);
      else await adminApi('POST', `/api/admin/files/${f.id}/${f.status === 'blocked' ? 'unblock' : 'block'}`);
      toast('Done');
      await load($('#list-title').textContent === 'Search result' ? f.id : '');
    } catch (err) {
      toast(err.message);
    }
  });
  return el;
}

$('#login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  secret = $('#secret').value;
  $('#login-error').textContent = '';
  try {
    await load();
    try { sessionStorage.setItem(KEY, secret); } catch {}
    $('#secret').value = '';
  } catch (err) {
    $('#login-error').textContent = err.message;
  }
});

$('#search-form').addEventListener('submit', (e) => {
  e.preventDefault();
  // Accepts a full link (…/f/abc123) or just the id.
  const id = $('#search').value.trim().split('/').filter(Boolean).pop() || '';
  load(id).catch((err) => toast(err.message));
});
$('#show-reported').onclick = () => { $('#search').value = ''; load().catch((err) => toast(err.message)); };
$('#logout').onclick = signOut;

if (secret) load().catch(() => signOut());
