// Secret texts. The text is encrypted here, in the browser, with a key made from
// its password. The server receives only the encrypted text and a "verifier",
// which proves the password without revealing the key.
(() => {
  const $ = (id) => document.getElementById(id);
  const ITERATIONS = 600000;
  const MIN_PASSWORD = 4;
  const encoder = new TextEncoder();

  const EXPIRY = [['5m', '5 دقائق'], ['10m', '10 دقائق'], ['15m', '15 دقيقة'], ['30m', '30 دقيقة'], ['1h', 'ساعة'], ['6h', '6 ساعات'], ['1d', 'يوم'], ['7d', '7 أيام']];
  const MESSAGES = {
    rate_limited: 'طلبات كثيرة. انتظر شوية وحاول مرة ثانية.',
    service_full: 'الخدمة ممتلئة هسه. حاول بعدين.',
    too_large: 'النص طويل. الحد الأقصى 10000 حرف.',
    invalid_options: 'اختر مدة صحيحة.',
  };
  const GONE = 'هذا النص غير موجود، أو انتهت مدته، أو انمسح.';

  const fromBase64Url = (text) => Uint8Array.from(atob(text.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));
  // Long texts are encoded in pieces: spreading a very long array into a call can fail.
  function toBase64Url(bytes) {
    let binary = '';
    for (let i = 0; i < bytes.length; i += 8192) binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
    return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }

  // One password gives two independent values: the encryption key and the verifier.
  async function derive(password, salt, iterations) {
    const base = await crypto.subtle.importKey('raw', encoder.encode(password.normalize('NFC')), 'PBKDF2', false, ['deriveBits']);
    const bits = new Uint8Array(await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations }, base, 512));
    const key = await crypto.subtle.importKey('raw', bits.slice(0, 32), 'AES-GCM', false, ['encrypt', 'decrypt']);
    return { key, verifier: toBase64Url(bits.slice(32)) };
  }

  async function api(path, body) {
    const response = await fetch(path, body
      ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }
      : undefined);
    const data = await response.json().catch(() => ({}));
    return { status: response.status, ok: response.ok, data };
  }

  function showError(message) {
    $('error').textContent = message || '';
    $('error').hidden = !message;
  }

  const networkError = () => (navigator.onLine ? 'صار خطأ. حاول مرة ثانية.' : 'انقطع الاتصال. تأكد من النت وحاول مرة ثانية.');
  const formatCode = (code) => `${code.slice(0, 4)}-${code.slice(4)}`;

  function wirePasswordToggle() {
    $('toggle').onclick = () => {
      const show = $('password').type === 'password';
      $('password').type = show ? 'text' : 'password';
      $('toggle').textContent = show ? 'إخفاء' : 'إظهار';
      $('toggle').setAttribute('aria-pressed', String(show));
    };
  }

  async function copyText(text, button, doneLabel) {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      showError('ما گدرت أنسخ تلقائياً. حدد النص وانسخه يدوياً.');
      return;
    }
    showError('');
    const label = button.textContent;
    button.textContent = doneLabel;
    setTimeout(() => { button.textContent = label; }, 2000);
  }

  // Arabic counts: 1 and 11+ take the singular, 3 to 10 the plural.
  const counted = (n, one, two, few) => {
    if (n === 1) return one;
    if (n === 2) return two;
    return `${n} ${n <= 10 ? few : one}`;
  };

  function timeLeft(ms) {
    const minutes = Math.max(1, Math.ceil(ms / 60000));
    if (minutes < 60) return counted(minutes, 'دقيقة', 'دقيقتين', 'دقائق');
    const hours = Math.round(minutes / 60);
    if (hours < 24) return counted(hours, 'ساعة', 'ساعتين', 'ساعات');
    return counted(Math.round(hours / 24), 'يوم', 'يومين', 'أيام');
  }

  // ---------- Write a text ----------
  function startCreate() {
    let expiry = '15m';
    let link = '';
    let code = '';

    $('expiry').replaceChildren(...EXPIRY.map(([key, label]) => {
      const chip = document.createElement('button');
      chip.type = 'button';
      chip.className = 'chip';
      chip.textContent = label;
      chip.setAttribute('aria-pressed', String(key === expiry));
      chip.onclick = () => {
        expiry = key;
        for (const other of $('expiry').children) other.setAttribute('aria-pressed', String(other === chip));
      };
      return chip;
    }));

    wirePasswordToggle();
    $('body').oninput = () => { $('count').textContent = String($('body').value.length); };

    $('create').onsubmit = async (event) => {
      event.preventDefault();
      showError('');
      const text = $('body').value;
      const password = $('password').value;
      if (!text.trim()) return showError('اكتب النص أول.');
      if (password.length < MIN_PASSWORD) return showError('الباسورد لازم يكون 4 أحرف أو أكثر.');
      if (!window.crypto?.subtle) return showError('هذا المتصفح ما يدعم التشفير. افتح الموقع من متصفح حديث.');

      $('submit').disabled = true;
      $('submit').textContent = 'جاري التشفير…';
      try {
        const salt = crypto.getRandomValues(new Uint8Array(16));
        const iv = crypto.getRandomValues(new Uint8Array(12));
        const { key, verifier } = await derive(password, salt, ITERATIONS);
        const sealed = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, encoder.encode(text)));
        const { ok, data } = await api('/api/texts', {
          ciphertext: toBase64Url(sealed), iv: toBase64Url(iv), salt: toBase64Url(salt),
          iterations: ITERATIONS, verifier, expiry, burn: $('burn').checked,
        });
        if (!ok) return showError(MESSAGES[data.code] || 'ما گدرت أنشئ النص. حاول مرة ثانية.');

        link = data.url;
        code = formatCode(data.id);
        $('qr').src = data.qrPng;
        $('copy-code').textContent = code;
        $('url').value = link;
        const left = timeLeft(data.expiresAt - data.serverNow);
        $('made-note').textContent = data.burn
          ? `ينمسح أول ما ينفتح، أو بعد ${left} إذا محد فتحه.`
          : `يبقى ${left}، وينفتح بالباسورد خلال هذي المدة.`;
        $('body').value = '';
        $('password').value = '';
        $('count').textContent = '0';
        $('create').hidden = true;
        $('by-code').hidden = true;
        $('made').hidden = false;
      } catch {
        showError(networkError());
      } finally {
        $('submit').disabled = false;
        $('submit').textContent = 'إنشاء الرابط';
      }
    };

    $('copy-url').onclick = () => copyText(link, $('copy-url'), 'تم النسخ ✓');
    $('copy-code').onclick = () => copyText(code, $('copy-code'), 'تم النسخ ✓');
    $('url').onclick = () => $('url').select();
    $('again').onclick = () => {
      $('made').hidden = true;
      $('create').hidden = false;
      $('by-code').hidden = false;
      showError('');
      $('body').focus();
    };

    $('by-code').onsubmit = (event) => {
      event.preventDefault();
      const typed = $('code-input').value.toUpperCase().replace(/[^0-9A-Z]/g, '');
      if (!/^[2-9A-HJ-NP-Z]{8}$/.test(typed)) return showError('الكود لازم يكون 8 أحرف وأرقام.');
      location.href = `/t/${typed}`;
    };
  }

  // ---------- Open a text ----------
  function startOpen() {
    const code = document.body.dataset.code;

    function gone(message) {
      $('unlock').hidden = true;
      $('status').textContent = 'النص غير متاح';
      showError(message);
      $('home').hidden = false;
    }

    // Tries a few times: if every try fails, the server deletes the text by itself.
    async function burn(verifier) {
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          const { ok } = await api(`/api/texts/${code}/burn`, { verifier });
          if (ok) return;
        } catch { /* try again */ }
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
    }

    async function load() {
      if (!code) return gone(GONE);
      if (!window.crypto?.subtle) return gone('هذا المتصفح ما يدعم فك التشفير. افتح الرابط من متصفح حديث.');
      let meta;
      try {
        meta = await api(`/api/texts/${code}`);
      } catch {
        $('status').textContent = 'تعذر الاتصال';
        return showError(networkError());
      }
      if (!meta.ok) {
        if (meta.status === 429) {
          $('status').textContent = 'انتظر شوية';
          return showError(MESSAGES.rate_limited);
        }
        return gone(GONE);
      }
      const info = meta.data;
      $('status').textContent = `ينتهي بعد ${timeLeft(info.expiresAt - info.serverNow)}`;
      $('burn-note').hidden = !info.burn;
      $('unlock').hidden = false;
      $('password').focus();

      $('unlock').onsubmit = async (event) => {
        event.preventDefault();
        showError('');
        $('submit').disabled = true;
        $('submit').textContent = 'جاري الفتح…';
        try {
          const { key, verifier } = await derive($('password').value, fromBase64Url(info.salt), info.iterations);
          const { ok, status, data } = await api(`/api/texts/${code}/open`, { verifier });
          if (!ok) {
            if (data.code === 'wrong_password') {
              $('password').select();
              return showError(`الباسورد غلط. باقي ${data.attemptsLeft} محاولة وبعدها ينمسح النص.`);
            }
            if (data.code === 'destroyed') return gone('انمسح النص بسبب كثرة المحاولات الغلط.');
            if (status === 429) return showError(MESSAGES.rate_limited);
            if (status === 404 || status === 410) return gone(GONE);
            return showError('صار خطأ. حاول مرة ثانية.');
          }
          const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: fromBase64Url(data.iv) }, key, fromBase64Url(data.ciphertext));
          const text = new TextDecoder().decode(plain);
          $('password').value = '';
          $('unlock').hidden = true;
          $('secret').textContent = text;
          $('shown').hidden = false;
          $('copy-secret').onclick = () => copyText(text, $('copy-secret'), 'تم النسخ ✓');
          if (data.burn) {
            $('status').textContent = 'انمسح من الموقع';
            $('shown-note').textContent = 'انمسح هذا النص من الموقع ولا يمكن فتحه مرة ثانية. انسخه قبل ما تسد الصفحة.';
            burn(verifier);
          } else {
            $('status').textContent = `ينتهي بعد ${timeLeft(data.expiresAt - data.serverNow)}`;
            $('shown-note').textContent = 'يبقى هذا النص متاحاً بالباسورد لحد ما تنتهي مدته.';
          }
          $('home').hidden = false;
        } catch {
          showError(networkError());
        } finally {
          $('submit').disabled = false;
          $('submit').textContent = 'فتح النص';
        }
      };
    }

    wirePasswordToggle();
    load();
  }

  if (document.body.dataset.mode === 'open') startOpen();
  else startCreate();
})();
