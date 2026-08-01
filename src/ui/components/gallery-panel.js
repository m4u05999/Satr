// <satr-gallery-panel> — لوحة معرض التوليدات 🖼 (الجولة 8 من «ولّد من سطر»).
// شبكة مصغرات من سجل التوليدات عبر IPC كودكس المجمَّدة (§3 من عقد ج8):
// window.satr.generationsList(cwd) → {ok, items:[سجل v1]} و
// window.satr.genThumb(cwd, rel) → {ok, dataUrl}. القناتان تُضافان عند الدمج،
// فحتى then تُختبر اللوحة عبر fixture يحقن window.satr مزيفاً (نمط الـharness).
// لكل عنصر: مصغرة (تحميل كسول عبر IntersectionObserver — السجل حتى 200 عنصر
// والمصغرة حتى 3MiB فالتحميل المسبق الكامل مرفوض)، البرومبت بزر نسخ، الكلفة
// والنموذج/المزوّد LTR، زر «أرسل المسار للمؤلف» (حدث gallery-insert للقشرة —
// تملأ المحرر ولا ترسل)، ونقر الصورة يفتح عرضاً مكبراً داخل اللوحة.
// الفيديو والصوت (الجولة 10 §3 — المؤجل الموثق): زر «▶ شغّل المعاينة»/«▶ شغّل
// المقطع» يطلب window.satr.genMedia(cwd, rel) عند النقر فقط (كسل صارم — لا تحميل
// مسبق)، ثم Blob ← objectURL ← <video/audio controls> (media-src blob: في CSP).
// الفشل/تجاوز السقف ⇒ بطاقة المعلومات القائمة + «تعذّر تحميل المعاينة» صراحةً.
// revokeObjectURL إلزامي عند إغلاق اللوحة/إعادة فتحها/إزالتها (لا تسريب ذاكرة).
// فراغ السجل ⇒ حالة فارغة عربية إرشادية. العقد: open(cwd)/close() + panel-close/panel-refresh.
// قرار مظهر: العرض المكبر **يتبع الثيمة** (ستارة --scrim ثابتة الوضعين + بطاقة
// شرح بأسطح الثيمة) — لا جزيرة داكنة جديدة، فلا حاجة لتوسعة كتلة التثبيت في
// base.css (درس «الجزر الداكنة»: أي سطح داكن دائماً يلزم تثبيت tokens كاملاً).
import { sheet } from '../lib/sheet.js';
import { panelSheet } from '../lib/panel.css.js';

const ownSheet = sheet(`
  .gal-list { padding: var(--space-3); }
  .gal-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(150px, 1fr)); gap: var(--space-3); }
  .gal-card {
    background: var(--surface-2); border: 1px solid var(--border-dim);
    border-radius: var(--radius-md); overflow: hidden; display: flex; flex-direction: column;
  }
  /* المصغرة سطح وسائط: --bg-deep ثابت في الوضعين (لا نص فوقه — لا مشكلة جزيرة) */
  .gal-thumb {
    aspect-ratio: 1; width: 100%; padding: var(--space-0); border: none; border-radius: var(--space-0);
    background: var(--bg-deep); color: var(--text-dim);
    display: flex; flex-direction: column; align-items: center; justify-content: center; gap: var(--space-1);
    font-size: 12px; cursor: zoom-in;
  }
  .gal-thumb img { width: 100%; height: 100%; object-fit: cover; display: block; }
  .gal-thumb .gal-ico { font-size: 24px; }
  /* صناديق المعلومات النصية (فيديو/صوت/فشل) فوقها نص فعلاً — بقاؤها على --bg-deep
     الثابتة جعل نصها --text-dim/--red باهتاً في الفاتح (~1.9:1). تُنقل إلى سطح ثيمة
     يُقلب (--surface-3) فيصير تباينها بمرتبة ميتا البطاقة المقبولة — بلا token جديد */
  .gal-video, .gal-audio, .gal-failed { background: var(--surface-3); cursor: default; }
  .gal-play { font-size: 11px; padding: 2px var(--space-2); }
  .gal-media-err { color: var(--red); font-size: 12px; }
  /* المشغّل داخل صندوق المعلومات: سطح وسائط --bg-deep (لا نص فوقه — لا جزيرة) */
  .gal-player { width: 100%; height: 100%; object-fit: contain; background: var(--bg-deep); display: block; }
  .gal-audio-player { width: 100%; }
  .gal-failed { color: var(--red); }
  .gal-body { padding: var(--space-2); display: flex; flex-direction: column; gap: var(--space-1h); flex: 1; }
  .gal-prompt {
    font-size: 12px; color: var(--text); line-height: 1.5; overflow: hidden;
    display: -webkit-box; -webkit-line-clamp: 3; -webkit-box-orient: vertical;
  }
  .gal-meta {
    direction: ltr; text-align: left; font-family: var(--mono); font-size: 11px;
    color: var(--text-dim); overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  }
  .gal-actions { display: flex; gap: var(--space-1h); margin-top: auto; }
  .gal-actions button { font-size: 11px; padding: 2px var(--space-2); flex: 1; }
  .gal-empty { display: flex; flex-direction: column; gap: var(--space-2); align-items: center; padding: var(--space-5) var(--space-4); }
  .gal-empty .gal-ico { font-size: 28px; }
  /* العرض المكبر: ستارة --scrim (ثابتة في الوضعين) + شرح بأسطح الثيمة — يتبع
     الثيمة عمداً، فلا يحتاج تثبيت جزيرة داكنة (انظر تعليق الرأس) */
  .gal-lightbox {
    position: absolute; inset: var(--space-0); z-index: var(--z-local);
    background: var(--scrim); display: flex; flex-direction: column;
    align-items: center; justify-content: center; gap: var(--space-3); padding: var(--space-4);
  }
  .gal-lightbox img {
    max-width: 100%; max-height: 65%; object-fit: contain;
    border-radius: var(--radius-md); box-shadow: var(--shadow-modal); background: var(--bg-deep);
  }
  .gal-lb-caption {
    background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius-md);
    padding: var(--space-2h) var(--space-3); max-width: 100%;
    display: flex; flex-direction: column; gap: var(--space-1);
  }
  .gal-lb-caption .gal-prompt { -webkit-line-clamp: 6; }
  .gal-lb-close { position: absolute; top: var(--space-3); inset-inline-end: var(--space-3); }
`);

// تنسيق الكلفة التقديرية بالدولار — LTR دائماً
function formatCost(value) {
  const n = Number(value);
  if (!isFinite(n)) return '$?';
  return '$' + n.toFixed(3);
}

class SatrGalleryPanel extends HTMLElement {
  constructor() {
    super();
    const r = this.attachShadow({ mode: 'open' });
    r.adoptedStyleSheets = [panelSheet, ownSheet];
    r.innerHTML =
      '<div class="panel-head">' +
        '<span>🖼 معرض التوليدات</span>' +
        '<span class="panel-head-actions">' +
          '<button class="refresh" title="إعادة قراءة السجل">تحديث</button>' +
          '<button class="close" title="إغلاق">✕</button>' +
        '</span>' +
      '</div>' +
      '<div class="panel-list gal-list"></div>' +
      '<div class="gal-lightbox" hidden>' +
        '<button class="gal-lb-close" title="إغلاق العرض">✕</button>' +
        '<img alt="الصورة المولّدة بحجم مكبّر">' +
        '<div class="gal-lb-caption">' +
          '<p class="gal-prompt" dir="auto"></p>' +
          '<div class="gal-meta"></div>' +
        '</div>' +
      '</div>';
    this._list = r.querySelector('.gal-list');
    this._lightbox = r.querySelector('.gal-lightbox');
    this._cwd = '';
    this._itemsById = new Map();
    // عناوين objectURL الحية للمشغّلات — تُسحب كلها عند الإغلاق/إعادة الفتح/الإزالة
    this._mediaUrls = new Set();
    // مراقب الكسل: يحمّل مصغرة البطاقة عند دخولها مجال الرؤية فقط
    this._observer = ('IntersectionObserver' in window)
      ? new IntersectionObserver((entries) => {
          for (const entry of entries) {
            if (!entry.isIntersecting) continue;
            this._observer.unobserve(entry.target);
            this._loadThumb(entry.target);
          }
        }, { root: this._list })
      : null;
    r.querySelector('.close').addEventListener('click', () => this.close());
    r.querySelector('.refresh').addEventListener('click', () =>
      this.dispatchEvent(new CustomEvent('panel-refresh')));
    r.querySelector('.gal-lb-close').addEventListener('click', () => this._closeLightbox());
    this._lightbox.addEventListener('click', (e) => {
      if (e.target === this._lightbox) this._closeLightbox();
    });
    // Escape يغلق العرض المكبر أولاً (capture يمنع وصوله لمعالج القشرة فيغلق اللوحة)
    this._onEsc = (e) => {
      if (e.key === 'Escape' && !this._lightbox.hidden) {
        e.stopPropagation();
        this._closeLightbox();
      }
    };
  }

  connectedCallback() { document.addEventListener('keydown', this._onEsc, true); }
  disconnectedCallback() {
    document.removeEventListener('keydown', this._onEsc, true);
    this._revokeMedia();
  }

  _revokeMedia() {
    for (const url of this._mediaUrls) { try { URL.revokeObjectURL(url); } catch (e) {} }
    this._mediaUrls.clear();
  }

  close() {
    this._closeLightbox();
    this._revokeMedia();
    this.removeAttribute('open');
    this.dispatchEvent(new CustomEvent('panel-close'));
  }

  _closeLightbox() { this._lightbox.hidden = true; }

  _openLightbox(item, dataUrl) {
    const img = this._lightbox.querySelector('img');
    img.src = dataUrl;
    const caption = this._lightbox.querySelector('.gal-lb-caption');
    caption.querySelector('.gal-prompt').textContent = item.prompt || '—';
    caption.querySelector('.gal-meta').textContent = this._metaText(item);
    this._lightbox.hidden = false;
  }

  _metaText(item) {
    const provider = item.provider || '?';
    const model = item.model || '?';
    return formatCost(item.cost_usd_estimate) + ' · ' + provider + '/' + model;
  }

  async _loadThumb(btn) {
    const rel = btn.dataset.rel;
    const item = this._itemsById.get(btn.dataset.id);
    let thumb = null;
    try { thumb = await window.satr.genThumb(this._cwd, rel); } catch (e) { /* يُعالج أدناه */ }
    if (!btn.isConnected) return; // أُعيد رسم الشبكة أثناء الانتظار
    if (!thumb || !thumb.ok || !thumb.dataUrl) {
      btn.textContent = 'تعذّر تحميل المصغرة';
      btn.style.cursor = 'default'; // CSSOM لا سمة مضمّنة (CSP)
      return;
    }
    btn.textContent = '';
    const img = document.createElement('img');
    img.src = thumb.dataUrl;
    img.alt = '';
    btn.appendChild(img);
    if (item) btn.addEventListener('click', () => this._openLightbox(item, thumb.dataUrl));
  }

  // data URL ← Blob بلا fetch (connect-src 'none' في fixtures — فكّ base64 يدوياً)
  _dataUrlToBlob(dataUrl, mime) {
    const base64 = String(dataUrl).slice(String(dataUrl).indexOf(',') + 1);
    const bin = atob(base64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new Blob([bytes], { type: mime || 'application/octet-stream' });
  }

  // صندوق وسائط (ج10 §3): بطاقة معلومات بأيقونة + زر تشغيل كسول — genMedia عند
  // النقر فقط، ثم <video/audio controls> بـ objectURL مُسجَّل للسحب عند الإغلاق
  _buildMediaBox(item, rel) {
    const isVideo = item.kind === 'video';
    const box = document.createElement('div');
    box.className = 'gal-thumb ' + (isVideo ? 'gal-video' : 'gal-audio');
    const ico = document.createElement('span'); ico.className = 'gal-ico';
    ico.textContent = isVideo ? '🎬' : '🎵';
    const tx = document.createElement('span'); tx.textContent = isVideo ? 'فيديو' : 'صوت';
    box.appendChild(ico); box.appendChild(tx);
    if (!rel) {
      const nofile = document.createElement('span'); nofile.textContent = 'لا ملف';
      box.appendChild(nofile);
      return box;
    }
    const play = document.createElement('button');
    play.type = 'button'; play.className = 'gal-play';
    play.textContent = isVideo ? '▶ شغّل المعاينة' : '▶ شغّل المقطع';
    play.addEventListener('click', () => this._loadMedia(box, play, item.kind, rel));
    box.appendChild(play);
    return box;
  }

  // الفشل/تجاوز السقف ⇒ بطاقة المعلومات القائمة + رسالة عربية صريحة (لا فشل صامت)
  _failMedia(box, btn) {
    if (btn && btn.isConnected) btn.remove();
    if (box.querySelector('.gal-media-err')) return;
    const err = document.createElement('span');
    err.className = 'gal-media-err';
    err.textContent = 'تعذّر تحميل المعاينة';
    box.appendChild(err);
  }

  async _loadMedia(box, btn, kind, rel) {
    btn.disabled = true; btn.textContent = '…';
    let res = null;
    try { res = await window.satr.genMedia(this._cwd, rel); } catch (e) { /* يُعالج أدناه */ }
    if (!box.isConnected) return; // أُعيد رسم الشبكة أثناء الانتظار
    if (!res || !res.ok || !res.dataUrl) { this._failMedia(box, btn); return; }
    let url = '';
    try {
      url = URL.createObjectURL(this._dataUrlToBlob(res.dataUrl, res.mime));
    } catch (e) { this._failMedia(box, btn); return; }
    this._mediaUrls.add(url);
    const media = document.createElement(kind === 'video' ? 'video' : 'audio');
    media.controls = true;
    media.src = url;
    media.className = kind === 'video' ? 'gal-player' : 'gal-audio-player';
    box.textContent = '';
    box.appendChild(media);
  }

  // بطاقة عنصر واحد من سجل v1: {id, kind, provider, model, prompt, files, cost_usd_estimate, status, error_code?}
  _renderCard(item) {
    const card = document.createElement('article');
    card.className = 'gal-card';
    card.dataset.id = item.id || '';

    const firstFile = Array.isArray(item.files) && item.files.length ? item.files[0] : '';
    if (item.status === 'failed') {
      const box = document.createElement('div');
      box.className = 'gal-thumb gal-failed';
      const ico = document.createElement('span'); ico.className = 'gal-ico'; ico.textContent = '✗';
      const tx = document.createElement('span');
      tx.textContent = 'فشل التوليد' + (item.error_code ? ' (' + item.error_code + ')' : '');
      box.appendChild(ico); box.appendChild(tx);
      card.appendChild(box);
    } else if (item.kind === 'video' || item.kind === 'audio') {
      card.appendChild(this._buildMediaBox(item, firstFile));
    } else {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'gal-thumb';
      btn.title = 'عرض مكبّر';
      btn.dataset.rel = firstFile;
      btn.dataset.id = item.id || '';
      btn.textContent = '…';
      card.appendChild(btn);
      if (firstFile) {
        if (this._observer) this._observer.observe(btn);
        else this._loadThumb(btn);
      } else {
        btn.textContent = 'لا ملف';
        btn.style.cursor = 'default';
      }
    }

    const body = document.createElement('div');
    body.className = 'gal-body';
    const prompt = document.createElement('p');
    prompt.className = 'gal-prompt';
    prompt.dir = 'auto';
    prompt.textContent = item.prompt || '—';
    const meta = document.createElement('div');
    meta.className = 'gal-meta';
    meta.textContent = this._metaText(item);
    const actions = document.createElement('div');
    actions.className = 'gal-actions';

    const copy = document.createElement('button');
    copy.type = 'button';
    copy.textContent = 'نسخ البرومبت';
    copy.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(item.prompt || '');
        copy.textContent = '✓ نُسخ';
      } catch (e) {
        copy.textContent = 'تعذّر النسخ';
      }
      setTimeout(() => { copy.textContent = 'نسخ البرومبت'; }, 1200);
    });
    actions.appendChild(copy);

    // «أرسل المسار للمؤلف»: حدث DOM للقشرة — تملأ المحرر بالمسار ولا ترسل
    if (firstFile && item.status !== 'failed') {
      const send = document.createElement('button');
      send.type = 'button';
      send.textContent = 'أرسل المسار للمؤلف';
      send.title = firstFile;
      send.addEventListener('click', () =>
        this.dispatchEvent(new CustomEvent('gallery-insert', { detail: { rel: firstFile, kind: item.kind } })));
      actions.appendChild(send);
    }

    body.appendChild(prompt); body.appendChild(meta); body.appendChild(actions);
    card.appendChild(body);
    return card;
  }

  async open(cwd) {
    this._cwd = cwd || '';
    this.setAttribute('open', '');
    this._closeLightbox();
    this._revokeMedia(); // الشبكة تُبنى من جديد — اسحب عناوين المشغّلات السابقة
    if (this._observer) this._observer.disconnect();
    if (!this._cwd) {
      this._list.innerHTML = '<div class="hint">اختر مجلد المشروع أولاً 📁</div>';
      return;
    }
    this._list.innerHTML = '<div class="hint">جارٍ قراءة سجل التوليدات…</div>';
    let res = null;
    try { res = await window.satr.generationsList(this._cwd); } catch (e) { /* يُعالج أدناه */ }
    if (!this.hasAttribute('open')) return; // أُغلقت اللوحة أثناء الانتظار
    if (!res || !res.ok || !Array.isArray(res.items)) {
      this._list.innerHTML = '<div class="hint">تعذّرت قراءة سجل التوليدات — جرّب «تحديث»</div>';
      return;
    }
    const items = res.items;
    this._itemsById = new Map();
    for (const item of items) if (item && item.id) this._itemsById.set(item.id, item);
    if (!items.length) {
      // حالة فارغة إرشادية (لا زر ميت): تشرح كيف تُملأ اللوحة
      const empty = document.createElement('div');
      empty.className = 'hint gal-empty';
      const ico = document.createElement('span'); ico.className = 'gal-ico'; ico.textContent = '🖼';
      const tx = document.createElement('span');
      tx.textContent = 'لا توليدات بعد في هذا المشروع. اطلب من الوكيل أن يولّد لك صورة — مثلاً: «ولّد صورة شعار لمشروعي» — وستظهر هنا مع برومبتها وكلفتها.';
      empty.appendChild(ico); empty.appendChild(tx);
      this._list.innerHTML = '';
      this._list.appendChild(empty);
      return;
    }
    const grid = document.createElement('div');
    grid.className = 'gal-grid';
    for (const item of items) grid.appendChild(this._renderCard(item));
    this._list.innerHTML = '';
    this._list.appendChild(grid);
  }
}

customElements.define('satr-gallery-panel', SatrGalleryPanel);
