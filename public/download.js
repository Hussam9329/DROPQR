const id = decodeURIComponent(location.pathname.split('/').pop());
const box = $('#box');
let meta = null;
let timer = null;

function showGone(title, text) {
  clearInterval(timer);
  document.title = 'Link expired — DropQR';
  box.innerHTML = `
    <div class="state-icon"><svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><circle cx="12" cy="12" r="9"/><path d="M15 9l-6 6M9 9l6 6"/></svg></div>
    <h1></h1><p class="sub"></p>
    <a class="btn btn-primary" href="/">Share a file</a>`;
  box.querySelector('h1').textContent = title;
  box.querySelector('.sub').textContent = text;
}

function render() {
  document.title = `${meta.name} — DropQR`;
  box.innerHTML = `
    <div class="big-icon"></div>
    <h1></h1>
    <p class="sub"></p>
    <div class="stats">
      <div class="stat"><small>Link expires in</small><b id="left">—</b></div>
      <div class="stat"><small>Downloads left</small><b id="dl-left"></b></div>
    </div>
    <a class="btn btn-primary" id="go">
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3"/></svg>
      Download file
    </a>`;
  box.querySelector('.big-icon').textContent = extOf(meta.name).slice(0, 4);
  box.querySelector('h1').textContent = meta.name;
  box.querySelector('.sub').textContent = formatBytes(meta.size);
  $('#dl-left').textContent = `${meta.remaining} of ${meta.maxDownloads}`;
  $('#go').href = `/d/${encodeURIComponent(meta.id)}`;
  $('#go').addEventListener('click', () => {
    toast('Download starting…');
    // Refresh the counter after the server has registered the download.
    setTimeout(load, 1500);
  });
  tick();
  clearInterval(timer);
  timer = setInterval(tick, 1000);
}

function tick() {
  const ms = meta.expiresAt - Date.now();
  if (ms <= 0) return showGone('This link has expired', 'The file was deleted when its time ran out.');
  $('#left').textContent = formatLeft(ms);
}

async function load() {
  try {
    const r = await fetch(`/api/files/${encodeURIComponent(id)}`);
    if (r.status === 404) return showGone('Link not found', 'This link does not exist, or the file was already deleted.');
    if (!r.ok) return showGone('This link has expired', 'It ran out of time or reached its download limit.');
    const fresh = await r.json();
    const first = !meta;
    meta = fresh;
    if (first) render();
    else $('#dl-left').textContent = `${meta.remaining} of ${meta.maxDownloads}`;
  } catch {
    if (!meta) showGone('Connection problem', 'Could not reach the server. Please try again.');
  }
}
load();
