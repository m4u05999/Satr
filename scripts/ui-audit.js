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
