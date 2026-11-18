// The secret text pages: /text (write one) and /t/:code (open one).
// Built by the server so they can carry a strict Content-Security-Policy.
// Everything on them is driven by public/text.js.
const createView = `
    <header class="heading">
      <img src="/logo.svg" alt="" width="44" height="44">
      <div><h1>نص سري</h1><p>يتشفر بجهازك قبل ما يطلع منه</p></div>
    </header>

    <form id="create" autocomplete="off">
      <label class="field">
        <span>النص</span>
        <textarea id="body" rows="7" maxlength="10000" dir="auto" required placeholder="اكتب النص هنا"></textarea>
        <small class="count" dir="ltr"><span id="count">0</span> / 10000</small>
      </label>

      <label class="field">
        <span>اسم للتذكير (اختياري)</span>
        <input id="label" maxlength="60" dir="auto" autocomplete="off" placeholder="مثلاً: يوزر العمل">
        <small>يظهر بقائمتك فقط، وينحفظ بهذا المتصفح وما يوصل للسيرفر.</small>
      </label>

      <label class="field">
        <span>الباسورد</span>
        <span class="password">
          <input id="password" type="password" minlength="4" maxlength="100" required autocomplete="new-password" placeholder="4 أحرف أو أكثر">
          <button id="toggle" class="reveal" type="button" aria-pressed="false">إظهار</button>
        </span>
        <small class="warn">إذا نسيت الباسورد ماكو أي طريقة لاسترجاع النص.</small>
      </label>

      <div class="field">
        <span id="expiry-label">يبقى لمدة</span>
        <div id="expiry" class="chips" role="group" aria-labelledby="expiry-label"></div>
      </div>

      <label class="switch">
        <input id="burn" type="checkbox" checked>
        <span><b>يختفي بعد أول فتح</b><small>ينمسح من الموقع أول ما ينفتح بالباسورد الصحيح.</small></span>
      </label>

      <button id="submit" class="primary" type="submit">إنشاء الرابط</button>
    </form>

    <section id="made" class="made" aria-live="polite" hidden>
      <h2>النص جاهز</h2>
      <img id="qr" class="qr" alt="رمز QR لفتح النص" width="200" height="200">
      <p class="label">الكود</p>
      <button id="copy-code" class="code" type="button" dir="ltr"></button>
      <p class="label">الرابط</p>
      <input id="url" class="url" readonly dir="ltr" aria-label="رابط النص">
      <button id="copy-url" class="primary" type="button">نسخ الرابط</button>
      <p id="made-note" class="note"></p>
      <button id="again" class="ghost" type="button">نص جديد</button>
    </section>

    <form id="by-code" class="by-code" autocomplete="off">
      <label for="code-input">عندك كود؟</label>
      <span class="code-row">
        <input id="code-input" dir="ltr" maxlength="12" autocapitalize="characters" spellcheck="false" placeholder="K7M2-QX9P" required>
        <button class="secondary" type="submit">فتح</button>
      </span>
    </form>

    <p id="error" class="error" role="alert" hidden></p>`;

const openView = `
    <header class="heading">
      <img src="/logo.svg" alt="" width="44" height="44">
      <div><h1>نص سري</h1><p id="status">جاري التحقق…</p></div>
    </header>

    <form id="unlock" autocomplete="off" hidden>
      <p id="burn-note" class="notice" hidden>هذا النص ينمسح نهائياً أول ما ينفتح. جهز مكان تنسخه بيه.</p>
      <label class="field">
        <span>الباسورد</span>
        <span class="password">
          <input id="password" type="password" maxlength="100" required autocomplete="off">
          <button id="toggle" class="reveal" type="button" aria-pressed="false">إظهار</button>
        </span>
      </label>
      <button id="submit" class="primary" type="submit">فتح النص</button>
    </form>

    <section id="shown" class="shown" hidden>
      <div id="secret" class="secret" dir="auto" tabindex="0"></div>
      <button id="copy-secret" class="primary" type="button">نسخ النص</button>
      <p id="shown-note" class="notice"></p>
    </section>

    <p id="error" class="error" role="alert" hidden></p>
    <a id="home" class="ghost link" href="/text" hidden>إنشاء نص جديد</a>`;

module.exports = function textPage({ mode, code }) {
  return `<!doctype html>
<html lang="ar" dir="rtl">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="robots" content="noindex">
  <meta name="theme-color" content="#090d16">
  <title>نص سري — DropQR</title>
  <meta name="description" content="نص محمي بباسورد، ينمسح تلقائياً.">
  <meta property="og:site_name" content="DropQR">
  <meta property="og:title" content="نص سري — DropQR">
  <meta property="og:description" content="نص محمي بباسورد، ينمسح تلقائياً.">
  <link rel="icon" href="/logo.svg" type="image/svg+xml">
  <link rel="stylesheet" href="/text.css">
  <link rel="stylesheet" href="/recent-links.css">
</head>
<body data-mode="${mode}" data-code="${code}">
  <main class="shell">
    <section class="card">${mode === 'open' ? openView : createView}
    </section>${mode === 'open' ? '' : '\n    <section id="recent" class="recent-links" hidden></section>'}
    <a class="back" href="/">DropQR</a>
  </main>
  <script src="/recent-links.js"></script>
  <script src="/text.js"></script>
</body>
</html>`;
};
