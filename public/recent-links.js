// "Your recent links" for HTML links and secret texts. The list lives in this
// browser only, and every row is checked against the server, so anything that
// expired or was deleted leaves the list by itself.
(() => {
  const MAX_ITEMS = 20;
  const REFRESH_MS = 60000;

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

  function isOurLink(url) {
    try { return new URL(url).origin === location.origin; } catch { return false; }
  }

  async function copy(text) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      const field = document.createElement('textarea');
      field.value = text;
      document.body.appendChild(field);
      field.select();
      let copied = false;
      try { copied = document.execCommand('copy'); } catch { /* reported below */ }
      field.remove();
      return copied;
    }
  }

  // container: the empty section. apiPath: where a row's status is read.
  // statusText(meta): the row's second line. remove(item): the delete request.
  function mount({ container, storageKey, apiPath, statusText, remove }) {
    const rows = new Map();

    function read() {
      try {
        const list = JSON.parse(localStorage.getItem(storageKey) || '[]');
        return Array.isArray(list) ? list.filter((item) => item && typeof item.id === 'string' && isOurLink(item.url)) : [];
      } catch {
        return [];
      }
    }

    function write(list) {
      try { localStorage.setItem(storageKey, JSON.stringify(list.slice(0, MAX_ITEMS))); } catch { /* the list just isn't kept */ }
    }

    function forget(id) {
      write(read().filter((item) => item.id !== id));
      rows.get(id)?.remove();
      rows.delete(id);
      container.hidden = rows.size === 0;
    }

    const statusUrl = (item, share) => `${apiPath}/${encodeURIComponent(item.id)}${share ? '?share=1' : ''}`;

    async function check(item, line) {
      try {
        const response = await fetch(statusUrl(item), { cache: 'no-store' });
        if (response.status === 404 || response.status === 410) return forget(item.id);
        if (!response.ok) return;
        const meta = await response.json();
        line.textContent = statusText(meta);
      } catch {
        line.textContent = 'تعذر التحقق من الحالة';
      }
    }

    function button(label, className) {
      const element = document.createElement('button');
      element.type = 'button';
      element.className = className;
      element.textContent = label;
      return element;
    }

    function buildRow(item) {
      const row = document.createElement('article');
      row.className = 'recent-item';

      const name = document.createElement('p');
      name.className = 'recent-name';
      name.dir = 'auto';
      name.textContent = item.name;
      const line = document.createElement('p');
      line.className = 'recent-status';
      line.textContent = 'جاري التحقق…';

      const actions = document.createElement('div');
      actions.className = 'recent-actions';
      const open = document.createElement('a');
      open.className = 'recent-btn';
      open.href = item.url;
      open.target = '_blank';
      open.rel = 'noopener noreferrer';
      open.textContent = 'فتح';
      const copyLink = button('نسخ', 'recent-btn');
      const showQr = button('QR', 'recent-btn');
      showQr.setAttribute('aria-expanded', 'false');
      const del = button('حذف', 'recent-btn recent-danger');
      actions.append(open, copyLink, showQr, del);

      const qr = document.createElement('img');
      qr.className = 'recent-qr';
      qr.alt = `رمز QR لفتح ${item.name}`;
      qr.width = 180;
      qr.height = 180;
      qr.hidden = true;

      copyLink.onclick = async () => {
        const copied = await copy(item.url);
        copyLink.textContent = copied ? 'تم ✓' : 'تعذر';
        setTimeout(() => { copyLink.textContent = 'نسخ'; }, 2000);
      };

      showQr.onclick = async () => {
        if (!qr.hidden) {
          qr.hidden = true;
          showQr.setAttribute('aria-expanded', 'false');
          return;
        }
        if (!qr.src) {
          try {
            const response = await fetch(statusUrl(item, true), { cache: 'no-store' });
            if (response.status === 404 || response.status === 410) return forget(item.id);
            if (!response.ok) throw new Error('status failed');
            qr.src = (await response.json()).qrPng;
          } catch {
            line.textContent = 'تعذر عرض رمز QR. حاول مرة ثانية.';
            return;
          }
        }
        qr.hidden = false;
        showQr.setAttribute('aria-expanded', 'true');
      };

      del.onclick = async () => {
        if (!confirm(`تمسح «${item.name}» نهائياً؟`)) return;
        del.disabled = true;
        try {
          const response = await remove(item);
          if (response.ok || response.status === 404) return forget(item.id);
        } catch { /* reported below */ }
        del.disabled = false;
        line.textContent = 'تعذر الحذف. حاول مرة ثانية.';
      };

      row.append(name, line, actions, qr);
      row.check = () => check(item, line);
      return row;
    }

    function render() {
      const list = read();
      rows.clear();
      const heading = document.createElement('h2');
      heading.textContent = 'روابطك الأخيرة';
      const note = document.createElement('small');
      note.textContent = 'محفوظة في هذا المتصفح فقط';
      heading.append(' ', note);
      container.replaceChildren(heading);
      for (const item of list) {
        const row = buildRow(item);
        rows.set(item.id, row);
        container.append(row);
        row.check();
      }
      container.hidden = list.length === 0;
    }

    const refresh = () => { for (const row of rows.values()) row.check(); };
    setInterval(() => { if (!document.hidden) refresh(); }, REFRESH_MS);
    document.addEventListener('visibilitychange', () => { if (!document.hidden) refresh(); });
    render();

    return {
      add(item) {
        write([item, ...read().filter((other) => other.id !== item.id)]);
        render();
      },
    };
  }

  window.RecentLinks = { mount, counted, timeLeft };
})();
