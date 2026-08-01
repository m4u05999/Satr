#!/usr/bin/env node
'use strict';

/**
 * أداة جرد صقل الواجهة — تشخيص بصري لا اختبار.
 *
 * تحمّل واجهة «سطر» الحقيقية (src/) داخل TestSprite harness، تفتح كل سطح بأعراض
 * وأوضاع مختلفة، وتلتقط لقطات إلى dist/ui-audit/ ليراجعها إنسان. لا تؤكّد شيئاً
 * ولا تفشل على اختلاف بصري — لذلك هي **خارج test:full** عمداً؛ حراس الانحدار
 * البصري هم الاختبارات الحية (chatcolumn-layout وterminal-tabs وopsroom-ui-live).
 *
 * التشغيل:
 *   npm run ui:audit              كل المشاهد
 *   npm run ui:audit -- light     المشاهد التي يطابق اسمها «light»
 *   npm run ui:audit -- 07 11     بالأرقام
 *
 * الـharness يُشغَّل تلقائياً على 4173 (أو يُعاد استخدام القائم فلا يُغلق).
 * حدّ معروف: الـharness يحقن window.satr مزيفاً، فالمعاينة الأصلية والطرفية
 * الحقيقية معطّلتان — اللوحات تُفتح بحالتها الفارغة أو المهيّأة يدوياً هنا.
 */

const fs = require('fs');
const path = require('path');
const { app, BrowserWindow } = require('electron');
const harness = require('../electron/testspriteharness');

const OUT = path.join(harness.ROOT, 'dist', 'ui-audit');
const FIXTURES = path.join(__dirname, 'fixtures');
const SETTLE_MS = 450;
const ACTION_MS = 700;

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// تفعيل الوضع الفاتح من الزر نفسه (لا ضبط data-theme يدوياً) كي يمرّ المشهد
// بالمسار الحقيقي: applyTheme + حفظ الاختيار + تحديث أيقونة الزر.
const LIGHT = "document.getElementById('themeToggle').click();";

// تصفير الثيم قبل كل مشهد: نقر الزر يحفظ الاختيار في localStorage، وكتابته غير
// متزامنة فيتسرّب إلى المشاهد التالية تسرّباً غير حتمي (رُصد: مشهد قائمة الأوامر
// خرج فاتحاً بعد مشهد الطرفية الفاتح). الضمان هنا: كل مشهد يبدأ داكناً وبمخزن نظيف.
const RESET_THEME = `
  try { localStorage.removeItem('satr_theme'); } catch (e) {}
  if (document.documentElement.dataset.theme === 'light') {
    document.getElementById('themeToggle').click();
    try { localStorage.removeItem('satr_theme'); } catch (e) {}
  }
`;

// مكتبة قياس تُحقن في مشاهد عيوب الفاتح: تحويل لون CSS (hex/rgb/rgba) إلى قنوات،
// مزج «فوق» قياسي، لمعان نسبي ونسبة تباين WCAG، وقراءة tokens محسوبة على <html>.
// المشهد الذي يعيد مصفوفة نصوص تُطبع سطورها تحت علامته في الملخص.
const MEASURE = `
function parseColor(str) {
  str = String(str || '').trim();
  let m = str.match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/i);
  if (m) {
    let h = m[1];
    if (h.length === 3) h = h.split('').map((c) => c + c).join('');
    return { r: parseInt(h.slice(0, 2), 16), g: parseInt(h.slice(2, 4), 16), b: parseInt(h.slice(4, 6), 16), a: 1 };
  }
  m = str.match(/rgba?\\(([^)]+)\\)/);
  if (m) {
    const p = m[1].split(',').map((s) => parseFloat(s));
    return { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 };
  }
  return null;
}
function lum(c) {
  const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
  return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b);
}
function over(fg, bg) {
  const a = fg.a + bg.a * (1 - fg.a);
  if (a === 0) return { r: 0, g: 0, b: 0, a: 0 };
  return {
    r: (fg.r * fg.a + bg.r * bg.a * (1 - fg.a)) / a,
    g: (fg.g * fg.a + bg.g * bg.a * (1 - fg.a)) / a,
    b: (fg.b * fg.a + bg.b * bg.a * (1 - fg.a)) / a,
    a,
  };
}
function contrast(x, y) {
  const lx = lum(x), ly = lum(y);
  return (Math.max(lx, ly) + 0.05) / (Math.min(lx, ly) + 0.05);
}
function tok(name) {
  return parseColor(getComputedStyle(document.documentElement).getPropertyValue(name).trim());
}
function backdropOf(el) {
  let n = el.parentElement;
  while (n) {
    const b = parseColor(getComputedStyle(n).backgroundColor);
    if (b && b.a > 0) return b;
    n = n.parentElement;
  }
  return { r: 255, g: 255, b: 255, a: 1 };
}
function effBg(el) {
  const b = parseColor(getComputedStyle(el).backgroundColor);
  if (!b) return null;
  return b.a >= 1 ? b : over(b, backdropOf(el));
}
const fmt = (c) => 'rgb(' + Math.round(c.r) + ',' + Math.round(c.g) + ',' + Math.round(c.b) + (c.a < 1 ? '/' + c.a.toFixed(2) : '') + ')';
const out = [];
`;

// جسم مشهدَي بطاقة الحلقة بالمراجعة النوعية (30–31): يفتح الغرفة ويبثّ loop_update
// اصطناعياً عبر خطّاف الـharness فيصل app.js ⇒ opsRoomEl.handleEvent (المسار الحقيقي)
// ثم يقيس تباين نصوص قسم المراجعة على خلفيته. changes_required ⇒ الحالة --red.
const LOOP_REVIEW_BODY = `
  document.querySelector('#opsRoomToggle').click();
  await new Promise((r) => setTimeout(r, 250));
  window.__SATR_TESTSPRITE_HARNESS__.emitEvent({
    type: 'loop_update', state: 'running', iteration: 2, max_iterations: 5,
    review: { configured: true, state: 'changes_required',
      summary: 'منطق الحلقة سليم والتحقق يمرّ، لكن معالجة حالة فشل المراجعة تحتاج تغطية اختبار، ورسالة الخطأ الظاهرة للمستخدم غير معرّبة.' },
  });
  await new Promise((r) => setTimeout(r, 300));
  const root = document.querySelector('satr-ops-room').shadowRoot;
  const card = root.querySelector('.loop-card');
  if (!card) { out.push('✗ لم تظهر بطاقة الحلقة'); return out; }
  const review = card.querySelector('.loop-review');
  if (!review) { out.push('✗ لم يظهر قسم المراجعة النوعية'); return out; }
  const reviewBg = effBg(review);
  const measureLine = (el, label) => {
    if (!el) { out.push(label + ': ✗ العنصر غائب'); return; }
    const c = parseColor(getComputedStyle(el).color);
    out.push(label + ': ' + fmt(c) + ' على ' + fmt(reviewBg) + ' = ' + contrast(c, reviewBg).toFixed(2) + ':1');
  };
  out.push('خلفية قسم المراجعة: ' + fmt(reviewBg));
  measureLine(review.querySelector('.loop-review-title'), 'العنوان');
  const stateEl = review.querySelector('.loop-review-state');
  measureLine(stateEl, 'الحالة (' + (stateEl ? stateEl.textContent : '?') + ')');
  measureLine(review.querySelector('.loop-review-summary'), 'الملخص');
  return out;
`;

// حقن بيانات المعرض في مشهدَي اللوحة (32–33): قنوات generationsList/genThumb
// تُضاف عند الدمج — تُستبدل هنا بدوال fixture على window.satr (الـProxy يسمح
// بالكتابة على الهدف)، فيمرّ المشهد بمسار المكوّن الحقيقي كاملاً.
const GALLERY_FX = require("./fixtures/gallery-fixture.js");
const GALLERY_INJECT = `
  const FX = ${JSON.stringify(GALLERY_FX)};
  window.satr.generationsList = async () => ({ ok: true, items: FX.items.map((it) => ({ ...it })) });
  window.satr.genThumb = async (cwd, rel) => FX.thumbs[rel]
    ? { ok: true, dataUrl: FX.thumbs[rel] } : { ok: false, error: "not_found" };
  // genMedia (ج10): النوع من الامتداد بقائمة سماح — نفس قواعد main.js
  const MEDIA_EXT = { ".mp4": "video/mp4", ".webm": "video/webm", ".wav": "audio/wav", ".mp3": "audio/mpeg" };
  window.satr.genMedia = async (cwd, rel) => {
    const mime = MEDIA_EXT[String(rel).slice(String(rel).lastIndexOf(".")).toLowerCase()];
    const payload = FX.media[rel];
    return (mime && payload) ? { ok: true, mime, dataUrl: payload.dataUrl } : { ok: false, error: "not_found" };
  };
  document.getElementById("cwd").value = "D:/fixture-project"; // الـharness يتركه فارغاً
  document.querySelector("#galleryToggle").click();
  await new Promise((r) => setTimeout(r, 700)); // فتح + تحميل المصغرات الكسولة
`;

// حقن حدث generation_done اصطناعي في مشهدَي بطاقة المحادثة (35–36 — عقد ج9 §2):
// يمرّ بمسار القشرة الحقيقي كاملاً (خطّاف الـharness ⇒ app.js ⇒ chat.addGenerationCard
// — نمط بطاقة المراجعة في المشهدين 30–31)، وقنوات generationsList/genThumb تُستبدل
// بدوال fixture كي تعمل المصغرة ويفتح نقرُ البطاقة المعرضَ ببياناته.
const GEN_CARD_INJECT = `
  const FXG = ${JSON.stringify(GALLERY_FX)};
  window.satr.generationsList = async () => ({ ok: true, items: FXG.items.map((it) => ({ ...it })) });
  window.satr.genThumb = async (cwd, rel) => FXG.thumbs[rel]
    ? { ok: true, dataUrl: FXG.thumbs[rel] } : { ok: false, error: "not_found" };
  document.getElementById("cwd").value = "D:/fixture-project"; // الـharness يتركه فارغاً
  window.__SATR_TESTSPRITE_HARNESS__.emitEvent({
    type: "generation_done", kind: "image", files: ["generations/satr-logo-1.png"],
    cost_usd_estimate: 0.04, provider: "fal", model: "gpt-image-2",
  });
  await new Promise((r) => setTimeout(r, 700)); // بناء البطاقة + جلب المصغرة
`;

// نقر زرَّي «▶» في مشهدَي المشغّلين (37–38) — يفترض GALLERY_INJECT قبله (فتح اللوحة)
const GALLERY_PLAY_CLICK = `
  const rootP = document.querySelector("satr-gallery-panel").shadowRoot;
  for (const b of rootP.querySelectorAll(".gal-play")) b.click();
  await new Promise((r) => setTimeout(r, 900)); // genMedia + Blob + objectURL
`;

const SHOTS = [
  // ---------- الأسطح اليومية ----------
  { out: '01-daily-1440', w: 1440, h: 900 },
  { out: '02-daily-1100', w: 1100, h: 820 },
  { out: '03-daily-820', w: 820, h: 780 },
  { out: '04-daily-light', w: 1440, h: 900, js: LIGHT },

  // ---------- محادثة فيها محتوى ----------
  {
    out: '05-chat', w: 1440, h: 900,
    js: `
      const input = document.querySelector('#input');
      input.value = 'اشرح كيف يعمل نظام الأذونات، واذكر الملفات مثل electron/autogate.js';
      document.querySelector('#send').click();
    `,
  },
  {
    out: '06-chat-light', w: 1440, h: 900,
    js: LIGHT + `
      const input = document.querySelector('#input');
      input.value = 'راجع التباين والطبقات في الوضع الفاتح';
      document.querySelector('#send').click();
    `,
  },

  // ---------- اللوحات الجانبية (أسطح flex داخل #midRow) ----------
  { out: '07-files', w: 1440, h: 900, js: "document.querySelector('#filesToggle').click()" },
  { out: '08-git', w: 1440, h: 900, js: "document.querySelector('#gitToggle').click()" },
  { out: '09-git-700', w: 700, h: 780, js: "document.querySelector('#gitToggle').click()" },
  { out: '10-ops', w: 1440, h: 900, js: "document.querySelector('#opsRoomToggle').click()" },
  { out: '11-ops-drawer', w: 700, h: 820, js: "document.querySelector('#opsRoomToggle').click()" },
  { out: '12-settings', w: 1440, h: 900, js: "document.querySelector('#settingsBtn').click()" },
  { out: '13-settings-light', w: 1440, h: 900, js: LIGHT + "document.querySelector('#settingsBtn').click()" },
  { out: '14-shortcuts', w: 1440, h: 900, js: "document.querySelector('#shortcutsToggle').click()" },

  // ---------- الطرفية (سطح كود داكن في الوضعين) ----------
  { out: '15-terminal', w: 1440, h: 900, js: "document.querySelector('#termToggle').click()" },
  { out: '16-terminal-light', w: 1440, h: 900, js: LIGHT + "document.querySelector('#termToggle').click()" },

  // ---------- المعاينة: الرأس ودرج الأدوات وأثر المهمة ----------
  // الـharness يعطّل previewOpen، فتُفتح اللوحة مباشرةً ويُهيّأ الأثر يدوياً
  {
    out: '17-preview-head', w: 1100, h: 560,
    js: `
      const panel = document.querySelector('satr-preview-panel');
      panel.setAttribute('open', ''); panel.style.width = '100%';
      await new Promise((r) => setTimeout(r, 250));
      const root = panel.shadowRoot;
      root.getElementById('pvMore').click();
      const trace = root.getElementById('pvTaskTrace');
      trace.classList.add('show');
      root.getElementById('traceLast').textContent = 'عبّأ النموذج · لوحة Brevo — إنشاء حملة';
    `,
  },

  // ---------- قائمة الأوامر وسطحان معاً ----------
  {
    out: '18-slash-menu', w: 1440, h: 900,
    js: `
      const input = document.querySelector('#input');
      input.focus(); input.value = '/';
      input.dispatchEvent(new Event('input', { bubbles: true }));
    `,
  },
  {
    out: '19-two-surfaces', w: 1600, h: 900,
    js: "document.querySelector('#opsRoomToggle').click(); document.querySelector('#previewToggle').click()",
  },

  // العمود المضيّق بسطح جانبي: الحالة الفارغة يجب أن تسعه بلا تمرير ولا زر قفز
  {
    out: '21-empty-narrow', w: 1440, h: 900,
    js: "document.querySelector('#opsRoomToggle').click()",
  },


  // ---------- مشاهد عيوب الوضع الفاتح المقاسة (دفعة إصلاح الفاتح) ----------
  // كل مشهد يطبع قيماً محسوبة (تباين/ألوان فعلية) فإن عاد العيب ظهر في سطور «▸».
  // فقاعة رد المساعد: تدرّج من --chat-answer-surface فوق محيط المحادثة إلى --surface
  {
    out: '22-light-answer-bubble', w: 1440, h: 900,
    js: LIGHT + MEASURE + `
      const input = document.querySelector('#input');
      input.value = 'اشرح نظام الأذونات باختصار';
      document.querySelector('#send').click();
      await new Promise((r) => setTimeout(r, 400)); // ردّ الـharness المحاكى (later=20ms)
      const bubble = document.querySelector('.answer-wrap .bubble');
      if (!bubble) { out.push('✗ لم تظهر فقاعة مساعد'); return out; }
      const chatBg = backdropOf(bubble);
      const stopA = over(tok('--chat-answer-surface'), chatBg); // الطرف الشفاف فوق المحيط
      const stopB = tok('--surface');                            // الطرف المعتم
      const mid = { r: (stopA.r + stopB.r) / 2, g: (stopA.g + stopB.g) / 2, b: (stopA.b + stopB.b) / 2, a: 1 };
      out.push('فقاعة الرد: طرف ' + fmt(stopA) + ' · وسط ' + fmt(mid) + ' · سطح ' + fmt(stopB) + ' على محيط ' + fmt(chatBg));
      out.push('تباين فقاعة/محيط: طرف ' + contrast(stopA, chatBg).toFixed(2) + ':1 · وسط ' + contrast(mid, chatBg).toFixed(2) + ':1');
      return out;
    `,
  },

  // سلّم الأسطح والحدود: فصل الطبقات المتتالية ووضوح الحدود عليها
  {
    out: '23-light-surfaces', w: 1440, h: 900,
    js: LIGHT + MEASURE + `
      document.querySelector('#filesToggle').click();
      const bg = tok('--bg'), s1 = tok('--surface'), s2 = tok('--surface-2'), s3 = tok('--surface-3');
      const bd = tok('--border-dim'), b = tok('--border');
      out.push('السلّم: bg ' + fmt(bg) + ' · surface ' + fmt(s1) + ' · surface-2 ' + fmt(s2) + ' · surface-3 ' + fmt(s3));
      out.push('فصل الأسطح: bg/surface ' + contrast(bg, s1).toFixed(2) + ':1 · surface/2 ' + contrast(s1, s2).toFixed(2) + ':1 · 2/3 ' + contrast(s2, s3).toFixed(2) + ':1');
      out.push('الحدود على surface: border-dim ' + contrast(bd, s1).toFixed(2) + ':1 · border ' + contrast(b, s1).toFixed(2) + ':1');
      return out;
    `,
  },

  // --text-faint: طابع .meta في المحادثة + الـtoken على bg وsurface (المعيار 4.5:1)
  {
    out: '24-light-text-faint', w: 1440, h: 900,
    js: LIGHT + MEASURE + `
      const input = document.querySelector('#input');
      input.value = 'اعرض الطوابع';
      document.querySelector('#send').click();
      await new Promise((r) => setTimeout(r, 400));
      const faint = tok('--text-faint');
      out.push('--text-faint ' + fmt(faint) + ' على bg ' + contrast(faint, tok('--bg')).toFixed(2) + ':1 · على surface ' + contrast(faint, tok('--surface')).toFixed(2) + ':1 (المعيار ≥4.5:1)');
      const meta = document.querySelector('.meta');
      if (meta) {
        const c = parseColor(getComputedStyle(meta).color);
        const behind = backdropOf(meta);
        out.push('.meta فعلياً: ' + fmt(c) + ' على ' + fmt(behind) + ' = ' + contrast(c, behind).toFixed(2) + ':1');
      }
      return out;
    `,
  },

  // شريط النجاح: نص --green على --green-soft ممزوجة فوق ما خلف الشريط
  {
    out: '25-light-banner-ok', w: 1440, h: 900,
    js: LIGHT + MEASURE + `
      const banner = document.getElementById('banner');
      banner.className = 'ok';
      banner.textContent = 'تم حفظ المفتاح بنجاح';
      await new Promise((r) => setTimeout(r, 50));
      const fg = parseColor(getComputedStyle(banner).color);
      const bgEff = effBg(banner);
      out.push('#banner.ok: نص ' + fmt(fg) + ' على ' + fmt(bgEff) + ' = ' + contrast(fg, bgEff).toFixed(2) + ':1 (المعيار ≥4.5:1)');
      return out;
    `,
  },

  // حقل مفتاح API: يجب أن يطابق أنماط الحقول العامة (كان بلا قاعدة فيبدو معطّلاً)
  {
    out: '26-light-api-key', w: 1440, h: 900,
    js: LIGHT + MEASURE + `
      document.querySelector('#settingsBtn').click();
      await new Promise((r) => setTimeout(r, 100));
      const key = document.getElementById('keyValue');
      key.value = 'sk-probe-1234567890';
      const ks = getComputedStyle(key);
      const rs = getComputedStyle(document.getElementById('keyProvider')); // select تحت القاعدة العامة
      out.push('keyValue: خلفية ' + ks.backgroundColor + ' · حد ' + ks.borderTopColor + ' · نص ' + ks.color);
      out.push((ks.backgroundColor === rs.backgroundColor && ks.borderTopColor === rs.borderTopColor)
        ? '✓ يطابق أنماط الحقول العامة' : '✗ يختلف عن أنماط الحقول العامة');
      return out;
    `,
  },


  // ---------- الجزر الداكنة خارج كتلة التثبيت (دفعة متابعة الفاتح) ----------
  // اللقطة المكبرة: حوار --bg-deep يجب أن يكون جزيرة داكنة متّسقة (نص/زر/تمرير)
  {
    out: '27-light-shot-lightbox', w: 1440, h: 900,
    js: LIGHT + MEASURE + `
      const dialog = document.createElement('dialog');
      dialog.className = 'shot-lightbox';
      const close = document.createElement('button');
      close.type = 'button'; close.className = 'shot-close'; close.textContent = '✕'; close.title = 'إغلاق';
      const img = document.createElement('img');
      img.src = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAEklEQVR4nGP8z8DwnwEKmBgQAAA9+AEDu11sjwAAAABJRU5ErkJggg==';
      img.alt = 'لقطة الوكيل';
      dialog.appendChild(close); dialog.appendChild(img); document.body.appendChild(dialog); dialog.showModal();
      const ds = getComputedStyle(dialog);
      const bg = parseColor(ds.backgroundColor), fg = parseColor(ds.color);
      const cs = getComputedStyle(close);
      out.push('lightbox: خلفية ' + fmt(bg) + ' · نص ' + fmt(fg) + ' = ' + contrast(fg, bg).toFixed(2) + ':1 · color-scheme ' + ds.colorScheme);
      out.push('زر الإغلاق: خلفية ' + cs.backgroundColor + ' · نص ' + cs.color + ' · حد ' + cs.borderTopColor);
      return out;
    `,
  },

  // سجلّ Console المعاينة: أسطر --text-dim/--text-faint/--red فوق --bg-deep
  {
    out: '28-light-preview-console', w: 1440, h: 900,
    js: LIGHT + MEASURE + `
      const panel = document.querySelector('satr-preview-panel');
      panel.setAttribute('open', ''); panel.style.width = '46%';
      await new Promise((r) => setTimeout(r, 200));
      const root = panel.shadowRoot;
      root.getElementById('pvConsole').classList.add('show');
      const log = root.getElementById('pcLog');
      const samples = [['log', 'console.log: رسالة عادية'], ['error', 'Uncaught Error: خطأ'], ['warning', 'تحذير'], ['netreq', 'GET /api/data 200']];
      for (const [cls, txt] of samples) {
        const d = document.createElement('div');
        d.className = 'pc-line ' + cls; d.dataset.cat = cls === 'netreq' ? 'net' : 'console'; d.textContent = txt;
        log.appendChild(d);
      }
      const cons = root.getElementById('pvConsole');
      const cs = getComputedStyle(cons);
      const bg = parseColor(cs.backgroundColor);
      out.push('pvConsole: خلفية ' + fmt(bg) + ' · color-scheme ' + cs.colorScheme);
      for (const line of log.querySelectorAll('.pc-line')) {
        const c = parseColor(getComputedStyle(line).color);
        out.push('سطر .' + line.className.replace('pc-line ', '') + ': ' + fmt(c) + ' = ' + contrast(c, bg).toFixed(2) + ':1');
      }
      const head = root.querySelector('#pvConsole .pc-title');
      const hb = effBg(head.parentElement);
      out.push('رأس السجل: ' + fmt(parseColor(getComputedStyle(head).color)) + ' على ' + fmt(hb) + ' = ' + contrast(parseColor(getComputedStyle(head).color), hb).toFixed(2) + ':1');
      return out;
    `,
  },

  // استوديو البرومو: سطح وسائط داكن — اتساق النصوص + ألوان المُصيّر (caption)
  {
    out: '29-light-promo-studio', w: 1440, h: 900,
    js: LIGHT + MEASURE + `
      const st = document.querySelector('satr-promo-studio');
      st.setAttribute('open', '');
      await new Promise((r) => setTimeout(r, 200));
      const root = st.shadowRoot;
      const studio = root.querySelector('.studio');
      const ss = getComputedStyle(studio);
      const sbg = parseColor(ss.backgroundColor), sfg = parseColor(ss.color);
      out.push('studio: خلفية ' + fmt(sbg) + ' · نص ' + fmt(sfg) + ' = ' + contrast(sfg, sbg).toFixed(2) + ':1 · color-scheme ' + ss.colorScheme);
      const h2 = root.querySelector('h2');
      const hbg = effBg(root.querySelector('header'));
      out.push('الترويسة: عنوان ' + fmt(parseColor(getComputedStyle(h2).color)) + ' على ' + fmt(hbg) + ' = ' + contrast(parseColor(getComputedStyle(h2).color), hbg).toFixed(2) + ':1');
      const hostStyles = getComputedStyle(st);
      const capText = parseColor(hostStyles.getPropertyValue('--text').trim());
      const capBg = over(parseColor(hostStyles.getPropertyValue('--scrim').trim()), parseColor(hostStyles.getPropertyValue('--bg-deep').trim()));
      out.push('مُصيّر الفيديو: caption ' + fmt(capText) + ' على scrim/bg-deep ' + fmt(capBg) + ' = ' + contrast(capText, capBg).toFixed(2) + ':1');
      return out;
    `,
  },


  // ---------- بطاقة الحلقة بحقل المراجعة النوعية (داكن/فاتح) ----------
  { out: '30-ops-loop-review', w: 1440, h: 900, js: MEASURE + LOOP_REVIEW_BODY },
  { out: '31-ops-loop-review-light', w: 1440, h: 900, js: LIGHT + MEASURE + LOOP_REVIEW_BODY },

  // ---------- لوحة معرض التوليدات 🖼 (الجولة 8 + بطاقة الصوت من ج9 §4) ----------
  // الداكن: الشبكة كاملة (صورتان + فيديو مؤجل + صوت مؤجل + فاشلة) ببيانات fixture
  { out: '32-gallery', w: 1440, h: 900, js: GALLERY_INJECT },
  // الحالة الفارغة الإرشادية — تُختبر بصرياً لا منطقياً فقط (درس «زر الأحدث»)
  { out: '34-gallery-empty', w: 1440, h: 900,
    js: "window.satr.generationsList = async () => ({ ok: true, items: [] }); document.getElementById('cwd').value = 'D:" + String.fromCharCode(92) + String.fromCharCode(92) + "fixture-project'; document.querySelector('#galleryToggle').click();" },
  // ---------- بطاقة «توليد مكتمل» في المحادثة (الجولة 9 §2) ----------
  // الداكن: البطاقة بمصغرتها عبر المسار الحقيقي كاملاً (emitEvent ⇒ app.js ⇒ chat.js)
  { out: '35-gen-card', w: 1440, h: 900, js: GEN_CARD_INJECT },
  // الفاتح: قياس تباين نصوص البطاقة + نقرها يفتح المعرض وفيه بطاقة الصوت (بصرياً)
  {
    out: '36-gen-card-light', w: 1440, h: 900,
    js: LIGHT + MEASURE + GEN_CARD_INJECT + `
      const card = document.querySelector(".gen-card");
      if (!card) { out.push("✗ لم تظهر بطاقة التوليد في المحادثة"); return out; }
      out.push("مصغرة محمّلة: " + card.querySelectorAll(".gen-thumb img").length);
      const headBg = effBg(card.querySelector(".work-card-head"));
      const title = card.querySelector(".work-card-title");
      out.push("العنوان: " + fmt(parseColor(getComputedStyle(title).color)) + " على " + fmt(headBg) + " = " + contrast(parseColor(getComputedStyle(title).color), headBg).toFixed(2) + ":1");
      const state = card.querySelector(".work-card-state");
      out.push("المزوّد/النموذج: " + fmt(parseColor(getComputedStyle(state).color)) + " على " + fmt(headBg) + " = " + contrast(parseColor(getComputedStyle(state).color), headBg).toFixed(2) + ":1");
      const footBg = effBg(card.querySelector(".work-card-foot"));
      const tech = card.querySelector(".work-card-tech");
      out.push("الكلفة/المسار: " + fmt(parseColor(getComputedStyle(tech).color)) + " على " + fmt(footBg) + " = " + contrast(parseColor(getComputedStyle(tech).color), footBg).toFixed(2) + ":1 · اتجاه " + getComputedStyle(tech).direction);
      // نقر البطاقة يفتح المعرض بالمسار الحقيقي — وفيه بطاقة الصوت
      card.click();
      await new Promise((r) => setTimeout(r, 600));
      const panel = document.querySelector("satr-gallery-panel");
      out.push(panel.hasAttribute("open") ? "✓ نقر البطاقة فتح لوحة المعرض" : "✗ نقر البطاقة لم يفتح اللوحة");
      const audioBox2 = panel.shadowRoot.querySelector(".gal-audio");
      out.push(audioBox2 ? "✓ بطاقة الصوت في المعرض: «" + audioBox2.textContent.trim() + "»" : "✗ غابت بطاقة الصوت من المعرض");
      return out;
    `,
  },

  // ---------- مشغّلا الوسائط في المعرض (الجولة 10 §3) ----------
  // الداكن: نقر «▶» في البطاقتين ⇒ <video/audio controls> بـ objectURL من fixture
  { out: '37-gallery-players', w: 1440, h: 900, js: GALLERY_INJECT + GALLERY_PLAY_CLICK },
  // الفاتح مقاساً: تباين زر التشغيل ونص البطاقة قبل النقر + بناء المشغّلين بعده
  {
    out: '38-gallery-players-light', w: 1440, h: 900,
    js: LIGHT + MEASURE + GALLERY_INJECT + `
      const panel = document.querySelector("satr-gallery-panel");
      const root = panel.shadowRoot;
      const plays = [...root.querySelectorAll(".gal-play")];
      if (plays.length !== 2) { out.push("✗ غاب زر تشغيل: " + plays.length); return out; }
      const playBg = effBg(plays[0]);
      out.push("زر التشغيل: نص " + fmt(parseColor(getComputedStyle(plays[0]).color)) + " على " + fmt(playBg) + " = " + contrast(parseColor(getComputedStyle(plays[0]).color), playBg).toFixed(2) + ":1");
      const audioBox = root.querySelector(".gal-audio");
      const audioBg = effBg(audioBox);
      out.push("بطاقة الصوت قبل التشغيل: «" + audioBox.textContent.trim() + "» — نص " + fmt(parseColor(getComputedStyle(audioBox).color)) + " على " + fmt(audioBg) + " = " + contrast(parseColor(getComputedStyle(audioBox).color), audioBg).toFixed(2) + ":1");
      for (const b of plays) b.click();
      await new Promise((r) => setTimeout(r, 900));
      const vids = root.querySelectorAll("video.gal-player");
      const auds = root.querySelectorAll("audio.gal-audio-player");
      if (!vids.length || !auds.length) { out.push("✗ لم يُبنَ المشغّلان بعد النقر: فيديو " + vids.length + " صوت " + auds.length); return out; }
      out.push("✓ مشغّل فيديو + مشغّل صوت بُنيا بعد النقر — مصدر " + vids[0].src.slice(0, 5) + " · controls " + (vids[0].controls && auds[0].controls));
      return out;
    `,
  },

  // الفاتح: قياس تباين البرومبت/الميتا + شرح العرض المكبر (يتبع الثيمة — لا جزيرة داكنة)
  {
    out: '33-gallery-light', w: 1440, h: 900,
    js: LIGHT + MEASURE + GALLERY_INJECT + `
      const panel = document.querySelector("satr-gallery-panel");
      const root = panel.shadowRoot;
      const cards = [...root.querySelectorAll(".gal-card")];
      if (!cards.length) { out.push("✗ لم تُرسم بطاقات المعرض"); return out; }
      out.push("بطاقات: " + cards.length + " · مصغرات محمّلة: " + root.querySelectorAll(".gal-thumb img").length);
      const promptEl = cards[0].querySelector(".gal-prompt");
      const metaEl = cards[0].querySelector(".gal-meta");
      const cardBg = effBg(cards[0]);
      out.push("البرومبت: " + fmt(parseColor(getComputedStyle(promptEl).color)) + " على " + fmt(cardBg) + " = " + contrast(parseColor(getComputedStyle(promptEl).color), cardBg).toFixed(2) + ":1");
      out.push("الميتا: " + fmt(parseColor(getComputedStyle(metaEl).color)) + " على " + fmt(cardBg) + " = " + contrast(parseColor(getComputedStyle(metaEl).color), cardBg).toFixed(2) + ":1");
      // بطاقة الصوت (ج9): معلومات بلا مشغّل على سطح ثيمة يُقلب (لا سطح وسائط ثابت)
      const audioBox = cards[3] && cards[3].querySelector(".gal-audio");
      if (!audioBox) { out.push("✗ غابت بطاقة الصوت من المعرض"); return out; }
      const audioBg = effBg(audioBox);
      out.push("بطاقة الصوت: «" + audioBox.textContent.trim() + "» — نص " + fmt(parseColor(getComputedStyle(audioBox).color)) + " على " + fmt(audioBg) + " = " + contrast(parseColor(getComputedStyle(audioBox).color), audioBg).toFixed(2) + ":1");
      // العرض المكبر في الفاتح: بطاقة الشرح تتبع الثيمة (قرار موثّق — لا جزيرة داكنة)
      cards[0].querySelector("button.gal-thumb").click();
      await new Promise((r) => setTimeout(r, 300));
      const lb = root.querySelector(".gal-lightbox");
      if (lb.hidden) { out.push("✗ لم يُفتح العرض المكبر"); return out; }
      const cap = lb.querySelector(".gal-lb-caption");
      const capBg = effBg(cap);
      const capFg = parseColor(getComputedStyle(cap.querySelector(".gal-prompt")).color);
      out.push("شرح العرض المكبر: نص " + fmt(capFg) + " على " + fmt(capBg) + " = " + contrast(capFg, capBg).toFixed(2) + ":1");
      return out;
    `,
  },

  // ---------- مقارنة اتجاه نصوص الطرفية (fixture مستقل) ----------
  { out: '20-bidi-compare', w: 720, h: 520, file: path.join(FIXTURES, 'ui-audit-bidi.html') },
];

async function capture(win, shot, url) {
  win.setSize(shot.w, shot.h);
  if (shot.file) await win.loadFile(shot.file);
  else await win.loadURL(url);
  await win.webContents.executeJavaScript('document.fonts.ready.then(() => true)', true);
  await delay(SETTLE_MS);
  if (!shot.file) {
    await win.webContents.executeJavaScript('(() => {' + RESET_THEME + '})()', true);
    await delay(120); // التصفير قد يقلب اللوحة، واللقطة الفورية تصوّر ما قبل إعادة الرسم
  }
  let measures = null;
  if (shot.js) {
    measures = await win.webContents.executeJavaScript('(async () => { ' + shot.js + ' })()', true);
    await delay(ACTION_MS);
  }
  let image = await win.webContents.capturePage();
  if (image.isEmpty()) {
    // بعض البيئات لا ترسم offscreen — إظهار النافذة خارج الشاشة لحظةً
    win.setPosition(-4000, -4000); win.show();
    await delay(600);
    image = await win.webContents.capturePage();
  }
  if (image.isEmpty()) throw new Error('لقطة فارغة');
  fs.mkdirSync(OUT, { recursive: true });
  fs.writeFileSync(path.join(OUT, shot.out + '.png'), image.toPNG());
  const size = image.getSize();
  if (Array.isArray(measures)) for (const line of measures) console.log('  ▸', line);
  return size.width + 'x' + size.height;
}

// تحقق تشخيصي سريع: هل يقلب زر الثيم خلفية المستند فعلاً؟ يُطبع مع الملخص
async function themeCheck(win, url) {
  await win.loadURL(url);
  await delay(SETTLE_MS);
  return win.webContents.executeJavaScript(`(() => {
    ${RESET_THEME}
    const body = () => getComputedStyle(document.body).backgroundColor;
    const dark = { theme: document.documentElement.dataset.theme, bg: body() };
    document.getElementById('themeToggle').click();
    const light = { theme: document.documentElement.dataset.theme, bg: body() };
    // إعادة الحالة داكنة ومسح الاختيار: وإلا بقي 'light' على القرص فبدأ التشغيل
    // التالي فاتحاً (partition الافتراضية مشتركة بين التشغيلات)
    document.getElementById('themeToggle').click();
    try { localStorage.removeItem('satr_theme'); } catch (e) {}
    return { dark, light, flipped: dark.bg !== light.bg && dark.theme === 'dark' && light.theme === 'light' };
  })()`, true);
}

async function main() {
  const filters = process.argv.slice(2).filter((arg) => !arg.startsWith('-'));
  const selected = filters.length
    ? SHOTS.filter((shot) => filters.some((needle) => shot.out.includes(needle)))
    : SHOTS;
  if (!selected.length) {
    console.error('ui-audit: لا مشهد يطابق ' + filters.join(' '));
    return 1;
  }

  await app.whenReady();
  const server = await harness.start(harness.DEFAULT_PORT);
  const win = new BrowserWindow({
    show: false, width: 1440, height: 900, frame: false,
    webPreferences: { offscreen: true, contextIsolation: true, sandbox: true, backgroundThrottling: false },
  });
  const errors = [];
  win.webContents.on('console-message', (event, level, message) => {
    if (level >= 2) errors.push(message);
  });

  let failed = 0;
  try {
    for (const shot of selected) {
      try {
        const size = await capture(win, shot, server.url);
        console.log('✓', shot.out, size);
      } catch (error) {
        failed++;
        console.log('✗', shot.out, error && error.message ? error.message : error);
      }
    }
    if (!filters.length) {
      const theme = await themeCheck(win, server.url);
      console.log('\nفحص الثيم: ' + (theme.flipped ? '✓ الزر يقلب اللوحة' : '✗ الزر لا يقلب اللوحة')
        + ' — داكن ' + theme.dark.bg + ' ⇐ فاتح ' + theme.light.bg);
    }
  } finally {
    if (!win.isDestroyed()) win.destroy();
    if (server.owned) await server.close();
  }

  console.log('\nالمخرجات: ' + path.relative(harness.ROOT, OUT));
  if (errors.length) {
    console.log('أخطاء console (' + errors.length + '):');
    for (const error of errors.slice(0, 20)) console.log('  •', error);
  } else {
    console.log('صفر أخطاء console.');
  }
  return failed ? 1 : 0;
}

main().then((code) => app.exit(code)).catch((error) => {
  console.error('ui-audit:', error && error.stack ? error.stack : error);
  app.exit(1);
});
