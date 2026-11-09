// The download page (/f/:id). Built by the server so chat apps (WhatsApp,
// Telegram…) can show the file name and a picture when the link is shared.
// Everything else on the page is filled in by public/download.js.
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

module.exports = function downloadPage({ title, description, url, image }) {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="robots" content="noindex">
  <title>${esc(title)}</title>
  <meta name="description" content="${esc(description)}">
  <meta property="og:type" content="website">
  <meta property="og:site_name" content="DropQR">
  <meta property="og:title" content="${esc(title)}">
  <meta property="og:description" content="${esc(description)}">
  <meta property="og:url" content="${esc(url)}">
  <meta property="og:image" content="${esc(image)}">
  <meta property="og:image:width" content="1200">
  <meta property="og:image:height" content="630">
  <meta name="twitter:card" content="summary_large_image">
  <link rel="icon" href="/logo.svg" type="image/svg+xml">
  <link rel="apple-touch-icon" href="/apple-touch-icon.png">
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&family=IBM+Plex+Sans+Arabic:wght@400;500;600;700&display=swap" rel="stylesheet">
  <link rel="stylesheet" href="/styles.css">
</head>
<body>
  <header class="nav">
    <a class="brand" href="/">
      <img class="brand-mark" src="/logo.svg" alt="" width="34" height="34">
      DropQR
    </a>
    <button class="btn btn-ghost lang-toggle" type="button"></button>
  </header>

  <main>
    <section class="card dl" id="box" aria-live="polite">
      <div class="skeleton" style="width:76px;height:76px;border-radius:22px"></div>
      <div class="skeleton" style="width:60%"></div>
      <div class="skeleton" style="width:40%"></div>
    </section>
  </main>

  <footer>
    <span data-i18n="footerShared"></span> <a href="/" data-i18n="footerOwn"></a>
    <nav class="legal"><a href="/terms.html" data-i18n="terms"></a> · <a href="/privacy.html" data-i18n="privacy"></a><span class="abuse-email"></span></nav>
  </footer>
  <div class="toast" id="toast" role="status" aria-live="polite"></div>
  <script src="/i18n.js"></script>
  <script src="/common.js"></script>
  <script src="/download.js"></script>
</body>
</html>`;
};
