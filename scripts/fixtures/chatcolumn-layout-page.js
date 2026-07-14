const violations = [];
const checks = [];
const cases = [];
window.__chatcolumnLayoutProgress = 'loading';

window.satr = {
  killBgProc: async () => ({ ok: true }),
  listBgProcs: async () => [],
  listCommands: async () => ({ ok: true, commands: [] }),
  listFiles: async () => Array.from({ length: 39 }, (_, index) => `src/ui/file-${index + 1}.js`),
};

window.addEventListener('securitypolicyviolation', (event) => {
  violations.push({
    directive: event.effectiveDirective,
    blockedURI: event.blockedURI,
    sourceFile: event.sourceFile,
  });
});

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function frames(count = 2) {
  return new Promise((resolve) => {
    let settled = false;
    const fallback = setTimeout(finish, Math.max(100, count * 40));
    function finish() {
      if (settled) return;
      settled = true;
      clearTimeout(fallback);
      resolve();
    }
    function next() {
      if (settled) return;
      if (--count <= 0) finish();
      else requestAnimationFrame(next);
    }
    requestAnimationFrame(next);
  });
}

function rect(element) {
  const bounds = element.getBoundingClientRect();
  return {
    left: Math.round(bounds.left),
    top: Math.round(bounds.top),
    right: Math.round(bounds.right),
    bottom: Math.round(bounds.bottom),
    width: Math.round(bounds.width),
    height: Math.round(bounds.height),
  };
}

function assertContained(element, container, label) {
  const child = rect(element);
  const parent = rect(container);
  assert(child.left >= parent.left - 1, `${label}: تجاوز الحافة اليسرى.`);
  assert(child.right <= parent.right + 1, `${label}: تجاوز الحافة اليمنى.`);
}

function assertNoHorizontalOverflow(element, label) {
  assert(element.scrollWidth <= element.clientWidth + 1,
    `${label}: overflow أفقي ${element.scrollWidth - element.clientWidth}px.`);
}

async function attachImage(input, composer) {
  composer.clearImages();
  const binary = atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZVZkAAAAASUVORK5CYII=');
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  const transfer = new DataTransfer();
  transfer.items.add(new File([bytes], 'pixel.png', { type: 'image/png' }));
  input.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, clipboardData: transfer }));
  await frames(3);
  assert(composer.getImages().length === 1, 'لم تُعرض حالة المرفق الفعلية.');
}

async function openSlash(input) {
  input.value = '/';
  input.setSelectionRange(1, 1);
  input.dispatchEvent(new Event('input', { bubbles: true }));
  await frames(2);
  const menu = document.getElementById('slashMenu');
  assert(menu.classList.contains('open'), 'لم تُفتح قائمة /.');
  return menu;
}

async function openFiles(input) {
  input.value = '@src';
  input.setSelectionRange(4, 4);
  input.dispatchEvent(new Event('input', { bubbles: true }));
  await frames(4);
  const menu = document.getElementById('fileMenu');
  assert(menu.classList.contains('open'), 'لم تُفتح قائمة @.');
  assert(menu.children.length === 39, `عدد نتائج @ غير متوقع: ${menu.children.length}.`);
  return menu;
}

async function exerciseLayout(spec) {
  window.__chatcolumnLayoutProgress = spec.name;
  document.body.className = spec.className;
  const composer = document.querySelector('satr-composer');
  const chatColumn = document.getElementById('chatColumn');
  const footer = document.querySelector('footer');
  const tools = document.querySelector('.composer-tools');
  const composerRow = document.querySelector('.composer');
  const input = document.getElementById('input');
  const browserControl = document.getElementById('browserCtl');
  const send = document.getElementById('send');
  const status = document.querySelector('.statusline');
  const terminal = document.getElementById('termPanel');
  const midRow = document.getElementById('midRow');

  composer.clearImages();
  composer.setBgProcs([{ id: 'layout-check', command: 'npm start', count: 1, startedAt: Date.now() - 65000 }]);
  composer.setCommands([{ cmd: '/new', en: '/new', desc: 'جلسة جديدة', run: () => {} }]);
  input.value = 'السطر الأول\nالسطر الثاني\nالسطر الثالث';
  input.dispatchEvent(new Event('input', { bubbles: true }));
  await attachImage(input, composer);
  await frames(3);

  assert(Math.abs(rect(chatColumn).width - spec.width) <= 1,
    `${spec.name}: عرض العمود ${rect(chatColumn).width} بدل ${spec.width}.`);
  assert(getComputedStyle(document.querySelector('satr-chat')).display === 'contents',
    `${spec.name}: satr-chat لم يبق display:contents.`);
  assert(getComputedStyle(composer).display === 'contents',
    `${spec.name}: satr-composer لم يبق display:contents.`);
  assert(footer.parentElement === composer && composer.parentElement === chatColumn,
    `${spec.name}: خرج المؤلّف من عمود الدردشة.`);
  assert(rect(footer).left === rect(chatColumn).left && rect(footer).right === rect(chatColumn).right,
    `${spec.name}: عرض المؤلّف لا يطابق العمود.`);
  assert(document.getElementById('bgBar').classList.contains('open'),
    `${spec.name}: شريط العمليات غير ظاهر.`);
  assert(document.getElementById('attachments').classList.contains('open'),
    `${spec.name}: شريط المرفقات غير ظاهر.`);
  assert(rect(input).height > 52, `${spec.name}: لم يتمدد المحرّر.`);

  for (const [element, label] of [
    [footer, 'footer'], [tools, 'composer-tools'], [composerRow, 'composer'],
    [input, 'textarea'], [browserControl, 'browserCtl'], [send, 'send'], [status, 'statusline'],
  ]) {
    assertContained(element, chatColumn, `${spec.name}/${label}`);
  }
  for (const [element, label] of [[footer, 'footer'], [tools, 'composer-tools'], [composerRow, 'composer']]) {
    assertNoHorizontalOverflow(element, `${spec.name}/${label}`);
  }
  assert(rect(send).bottom <= rect(footer).bottom && rect(status).bottom <= rect(footer).bottom,
    `${spec.name}: خرجت الأزرار أو الحالة عمودياً من المؤلّف.`);

  const slashMenu = await openSlash(input);
  assertContained(slashMenu, chatColumn, `${spec.name}/slashMenu`);
  const slashWidth = rect(slashMenu).width;
  const fileMenu = await openFiles(input);
  assertContained(fileMenu, chatColumn, `${spec.name}/fileMenu`);

  const toolsDisplay = getComputedStyle(tools).display;
  const composerDisplay = getComputedStyle(composerRow).display;
  assert(toolsDisplay === spec.toolsDisplay,
    `${spec.name}: عرض الأدوات ${toolsDisplay} بدل ${spec.toolsDisplay}.`);
  assert(composerDisplay === spec.composerDisplay,
    `${spec.name}: عرض صف الإدخال ${composerDisplay} بدل ${spec.composerDisplay}.`);
  const labelDisplay = getComputedStyle(tools.querySelector('.ct-label')).display;
  assert((labelDisplay === 'none') === spec.hideLabels,
    `${spec.name}: حالة عناوين الأدوات لا تطابق container query.`);
  if (spec.composerDisplay === 'grid') {
    assert(rect(browserControl).top >= rect(input).bottom,
      `${spec.name}: أزرار العرض الضيق لم تنتقل أسفل المحرّر.`);
    assert(Math.abs(rect(browserControl).width - rect(send).width) <= 1,
      `${spec.name}: زرا الصف السفلي غير متوازنين.`);
  } else {
    assert(rect(browserControl).bottom === rect(input).bottom && rect(send).bottom === rect(input).bottom,
      `${spec.name}: أزرار الصف المرن لا تحاذي أسفل المحرّر.`);
  }

  assert(terminal.parentElement.parentElement === document.body,
    `${spec.name}: الطرفية ليست شقيقة للصف الأوسط.`);
  assert(rect(terminal).left === 0 && rect(terminal).right === document.documentElement.clientWidth,
    `${spec.name}: الطرفية ليست كاملة العرض.`);
  assert(rect(terminal).top >= rect(midRow).bottom,
    `${spec.name}: الطرفية ليست أسفل الصف الأوسط.`);

  cases.push({
    name: spec.name,
    width: rect(chatColumn).width,
    toolsDisplay,
    composerDisplay,
    slashWidth,
    fileWidth: rect(fileMenu).width,
  });
  checks.push(spec.name);
}

document.addEventListener('DOMContentLoaded', async () => {
  try {
    await customElements.whenDefined('satr-composer');
    await frames(3);
    for (const spec of [
      { name: 'layout-806', className: 'layout-806', width: 806, toolsDisplay: 'flex', composerDisplay: 'flex', hideLabels: false },
      { name: 'layout-504', className: 'layout-504', width: 504, toolsDisplay: 'flex', composerDisplay: 'flex', hideLabels: true },
      { name: 'layout-381', className: 'layout-381', width: 381, toolsDisplay: 'grid', composerDisplay: 'grid', hideLabels: true },
    ]) await exerciseLayout(spec);
    assert(violations.length === 0, 'رُصد securitypolicyviolation أثناء اختبار التخطيط.');
    checks.push('composer-states', 'menus-contained', 'terminal-full-width', 'zero-csp-violations');
    window.__chatcolumnLayoutProgress = 'complete';
    window.__chatcolumnLayoutResult = { pass: true, checks, cases, violations };
  } catch (error) {
    window.__chatcolumnLayoutResult = {
      pass: false, checks, cases, violations,
      error: error && error.stack ? error.stack : String(error),
    };
  }
});
