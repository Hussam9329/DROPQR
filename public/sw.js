// Service worker. Its only job: receive files that someone shares to DropQR
// from the phone's Share menu, keep them for the upload page, and open it.
// It does not cache pages, so the site is always the latest version.
importScripts('/share-store.js');

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (event.request.method !== 'POST' || url.pathname !== '/share-target') return;
  event.respondWith((async () => {
    const form = await event.request.formData();
    const files = form.getAll('files').filter((f) => f instanceof File && f.size > 0);
    // Sharing a link or some text (no file): keep it as a small text file.
    if (!files.length) {
      const text = [form.get('title'), form.get('text'), form.get('url')].filter(Boolean).join('\n');
      if (text) files.push(new File([text], 'shared-text.txt', { type: 'text/plain' }));
    }
    await putSharedFiles(files);
    return Response.redirect('/?shared=1', 303);
  })());
});
