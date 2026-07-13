const violations = [];
const checks = [];
window.__xtermCspProgress = 'loading';

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
    function next() {
      if (--count <= 0) resolve();
      else requestAnimationFrame(next);
    }
    requestAnimationFrame(next);
  });
}

function write(term, data) {
  return new Promise((resolve) => term.write(data, resolve));
}

function sheetSet() {
  return new Set(document.adoptedStyleSheets);
}

function difference(left, right) {
  return new Set([...left].filter((item) => !right.has(item)));
}

function makeTerminal(theme) {
  const host = document.createElement('section');
  host.className = 'terminal-host';
  document.getElementById('terminals').appendChild(host);
  const term = new Terminal({
    cols: 40,
    rows: 10,
    cursorBlink: true,
    scrollback: 100,
    fontFamily: "'Cascadia Mono', Consolas, monospace",
    theme,
  });
  term.open(host);
  return { term, host };
}

async function exercise(term, label) {
  term.focus();
  term.textarea.dispatchEvent(new FocusEvent('focus'));
  await write(term, Array.from({ length: 45 }, (_, index) => `${label}_${index}\r\n`).join(''));
  await write(term, `\x1b[31m${label}_ANSI_RED\x1b[0m`);
  term.resize(48, 12);
  await frames(3);
  assert(term.cols === 48 && term.rows === 12, 'فشل resize في xterm.');
  assert(term.buffer.active.length > term.rows, 'لم يُحفَظ scrollback في xterm.');
  const ansi = term.element.querySelector('.xterm-fg-1');
  assert(ansi && getComputedStyle(ansi).color !== '', 'لم تُطبَّق ألوان ANSI.');
  const rows = term.element.querySelector('.xterm-rows');
  const cursorProbe = document.createElement('span');
  cursorProbe.className = 'xterm-cursor xterm-cursor-blink xterm-cursor-block';
  rows.classList.add('xterm-focus');
  rows.appendChild(cursorProbe);
  const blinkAnimation = getComputedStyle(cursorProbe).animationName;
  cursorProbe.remove();
  assert(blinkAnimation.includes('blink_'), 'لم تُطبَّق قاعدة cursor blink: ' + blinkAnimation);
}

document.addEventListener('DOMContentLoaded', async () => {
  const dark = { background: '#0d0d0c', foreground: '#eeeeec', cursor: '#d9a441' };
  const light = { background: '#fafafa', foreground: '#202020', cursor: '#8a5a00' };
  const baselineSheets = sheetSet();
  const baselineStyleElements = document.querySelectorAll('style').length;
  let first;
  let second;
  let reopened;

  try {
    window.__xtermCspProgress = 'first';
    first = makeTerminal(dark);
    await exercise(first.term, 'FIRST');
    const afterFirst = sheetSet();
    const firstSheets = difference(afterFirst, baselineSheets);
    assert(firstSheets.size >= 3, 'لم يعتمد xterm أوراق CSSStyleSheet المتوقعة للطرفية الأولى.');

    window.__xtermCspProgress = 'second';
    second = makeTerminal(light);
    await exercise(second.term, 'SECOND');
    const afterSecond = sheetSet();
    const secondSheets = difference(afterSecond, afterFirst);
    assert(secondSheets.size >= 3, 'لم تنشئ الطرفية الثانية أوراقاً مستقلة.');
    assert([...firstSheets].every((sheet) => afterSecond.has(sheet)), 'تسرّبت دورة حياة الطرفية الثانية إلى الأولى.');
    checks.push('multiple-terminals');

    window.__xtermCspProgress = 'themes';
    first.term.options.theme = light;
    await frames(3);
    const scrollable = first.term.element.querySelector('.xterm-scrollable-element');
    assert(getComputedStyle(scrollable).backgroundColor === 'rgb(250, 250, 250)', 'لم يُطبَّق الثيم الفاتح عبر CSSOM.');
    first.term.options.theme = dark;
    await frames(3);
    assert(getComputedStyle(scrollable).backgroundColor === 'rgb(13, 13, 12)', 'لم يُستعَد الثيم الداكن عبر CSSOM.');
    checks.push('themes');

    window.__xtermCspProgress = 'dispose-first';
    first.term.dispose();
    first.host.remove();
    first = null;
    await frames(2);
    const afterFirstDispose = sheetSet();
    assert([...firstSheets].every((sheet) => !afterFirstDispose.has(sheet)), 'لم تُزل أوراق الطرفية المغلقة.');
    assert([...secondSheets].every((sheet) => afterFirstDispose.has(sheet)), 'أزال dispose أوراق طرفية أخرى.');

    window.__xtermCspProgress = 'reopen';
    reopened = makeTerminal(dark);
    await exercise(reopened.term, 'REOPENED');
    const afterReopen = sheetSet();
    const reopenedSheets = difference(afterReopen, afterFirstDispose);
    assert(reopenedSheets.size >= 3, 'لم تُنشأ أوراق مستقلة بعد إعادة فتح الطرفية.');
    reopened.term.dispose();
    reopened.host.remove();
    reopened = null;
    await frames(2);
    assert([...reopenedSheets].every((sheet) => !sheetSet().has(sheet)), 'تسرّبت أوراق الطرفية المعاد فتحها.');
    checks.push('dispose-reopen');

    window.__xtermCspProgress = 'dispose-all';
    second.term.dispose();
    second.host.remove();
    second = null;
    await frames(2);
    assert(document.adoptedStyleSheets.length === baselineSheets.size, 'بقيت أوراق xterm بعد إغلاق كل الطرفيات.');
    assert(document.querySelectorAll('style').length === baselineStyleElements, 'أنشأ xterm عنصراً <style> وقت التشغيل.');
    assert(violations.length === 0, 'رُصد securitypolicyviolation أثناء التفاعل مع الطرفية.');
    checks.push('resize', 'cursor-blink', 'ansi', 'scrollback', 'zero-csp-violations');
    window.__xtermCspProgress = 'complete';
    window.__xtermCspResult = { pass: true, checks, violations };
  } catch (error) {
    window.__xtermCspResult = { pass: false, checks, violations, error: error && error.stack ? error.stack : String(error) };
  } finally {
    for (const entry of [first, second, reopened]) {
      if (!entry) continue;
      try { entry.term.dispose(); } catch {}
      entry.host.remove();
    }
  }
});
