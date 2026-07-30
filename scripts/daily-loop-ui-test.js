#!/usr/bin/env node
'use strict';

const assert = require('assert');
const { app, BrowserWindow } = require('electron');
const harness = require('./testsprite-harness');

const TIMEOUT_MS = 30000;
const IMAGE_DATA_URL = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2z9sAAAAASUVORK5CYII=';

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function evaluate(win, source) {
  return win.webContents.executeJavaScript(source, true);
}

async function waitFor(win, expression, label) {
  const deadline = Date.now() + TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (await evaluate(win, `Boolean(${expression})`)) return;
    await delay(40);
  }
  throw new Error('انتهت مهلة ' + label);
}

async function emit(win, event) {
  await evaluate(win, `window.__SATR_TESTSPRITE_HARNESS__.emitEvent(${JSON.stringify(event)})`);
}

async function setInputAndSend(win, text, image) {
  await evaluate(win, `(() => {
    const input = document.getElementById('input');
    input.value = ${JSON.stringify(text)};
    input.dispatchEvent(new Event('input', { bubbles: true }));
    ${image ? `document.querySelector('satr-composer').addImageData(${JSON.stringify(IMAGE_DATA_URL)});` : ''}
    document.getElementById('send').click();
  })()`);
}

async function completeTurn(win, sessionId) {
  await emit(win, { type: 'result', session_id: sessionId, duration_ms: 12, is_error: false });
  await emit(win, { type: 'proc_done', code: 0 });
  await waitFor(win, "document.getElementById('send').textContent === 'إرسال'", 'اكتمال الدور');
}

async function main() {
  const server = harness.createHarnessServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, harness.HOST, resolve);
  });
  const port = server.address().port;
  await app.whenReady();
  const consoleErrors = [];
  const win = new BrowserWindow({
    show: false,
    width: 1280,
    height: 900,
    webPreferences: {
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
      partition: 'daily-loop-ui-' + Date.now(),
    },
  });
  win.webContents.on('console-message', (_event, level, message) => {
    if (level >= 2 || /securitypolicyviolation|content security policy|uncaught|unhandled/i.test(String(message))) {
      consoleErrors.push(String(message));
    }
  });

  try {
    await win.loadURL(`http://${harness.HOST}:${port}/`);
    await waitFor(win,
      "window.__SATR_TESTSPRITE_HARNESS__ && customElements.get('satr-chat') && customElements.get('satr-composer') && !document.querySelector('satr-gate').hasAttribute('open')",
      'إقلاع واجهة الحلقة اليومية');
    await evaluate(win, `(() => {
      const h = window.__SATR_TESTSPRITE_HARNESS__;
      h.setAutoRespond(false);
      h.clearCalls();
      const effort = document.getElementById('effort');
      effort.value = '';
      effort.dispatchEvent(new Event('change', { bubbles: true }));
      const permission = document.getElementById('perm');
      permission.value = 'default';
      permission.dispatchEvent(new Event('change', { bubbles: true }));
    })()`);

    const awareness = await evaluate(win, `(() => {
      document.getElementById('awarenessEffort').click();
      document.getElementById('awarenessPerm').click();
      const bar = document.getElementById('awarenessBar');
      return {
        // دفعة الصقل: «model:» أُزيل من الشريط (مكرّر مع منتقي النموذج بجواره)
        modelChipRemoved: !document.getElementById('awarenessModel'),
        modelSelectPresent: !!document.getElementById('model'),
        barText: bar.textContent,
        effort: document.getElementById('effort').value,
        effortText: document.getElementById('awarenessEffort').textContent,
        permission: document.getElementById('perm').value,
        permissionText: document.getElementById('awarenessPerm').textContent,
        warning: document.getElementById('awarenessPerm').classList.contains('mode-warning'),
      };
    })()`);
    assert.strictEqual(awareness.modelChipRemoved, true, 'رجع «model:» المكرّر إلى شريط الوعي');
    assert.strictEqual(awareness.modelSelectPresent, true, 'منتقي النموذج غاب عن المؤلّف');
    // القاعدة 3: تسميات الشريط عربية — لا model:/effort:/thinking:/context: إنجليزية
    for (const latin of ['model:', 'effort:', 'thinking:', 'context:']) {
      assert(!awareness.barText.includes(latin), 'تسمية إنجليزية في شريط الوعي: ' + latin);
    }
    assert.strictEqual(awareness.effort, 'low');
    assert(awareness.effortText.includes('الجهد: منخفض'), 'تسمية الجهد العربية غائبة');
    assert.strictEqual(awareness.permission, 'acceptEdits');
    assert(awareness.permissionText.includes('قبول التعديلات'));
    assert.strictEqual(awareness.warning, true);
    await evaluate(win, "document.getElementById('awarenessContext').click()");
    await waitFor(win, "document.getElementById('awarenessContext').textContent.includes('42%')", 'تحديث مؤشر السياق');
    assert.strictEqual(await evaluate(win, "document.querySelector('satr-context-panel').hasAttribute('open')"), true);

    await evaluate(win, `(() => {
      const engine = document.getElementById('engine');
      engine.value = 'kimi-code';
      engine.dispatchEvent(new Event('change', { bubbles: true }));
      const input = document.getElementById('input');
      input.value = '/';
      input.dispatchEvent(new Event('input', { bubbles: true }));
    })()`);
    await waitFor(win,
      "document.getElementById('slashMenu').classList.contains('open')",
      'قائمة أوامر Kimi');
    const kimiParity = await evaluate(win, `(() => {
      const commands = [...document.getElementById('slashMenu').querySelectorAll('.slash-item')]
        .map((item) => item.dataset.command);
      document.getElementById('awarenessContext').click();
      return {
        model: document.getElementById('model').value,
        effortDisabled: document.getElementById('effort').disabled,
        awarenessDisabled: document.getElementById('awarenessEffort').disabled,
        awarenessText: document.getElementById('awarenessEffort').textContent,
        commands,
      };
    })()`);
    assert.strictEqual(kimiParity.model, 'k3');
    assert.strictEqual(kimiParity.effortDisabled, true);
    assert.strictEqual(kimiParity.awarenessDisabled, true);
    assert(kimiParity.awarenessText.includes('الجهد: افتراضي ACP'),
      'تسمية الجهد غير المدعوم لـKimi يجب أن تبقى عربية');
    assert(kimiParity.commands.includes('/سياق') && kimiParity.commands.includes('/ضغط'));
    assert(!kimiParity.commands.includes('/مهارات'));
    await waitFor(win,
      "window.__SATR_TESTSPRITE_HARNESS__.calls.some((call) => call.name === 'contextUsage' && call.args[2] === 'kimi-code')",
      'توجيه سياق Kimi');
    await evaluate(win, `(() => {
      const engine = document.getElementById('engine');
      engine.value = 'sdk';
      engine.dispatchEvent(new Event('change', { bubbles: true }));
      const input = document.getElementById('input'); input.value = ''; input.dispatchEvent(new Event('input', { bubbles: true }));
    })()`);

    const draftState = await evaluate(win, `(() => {
      const first = 'C:\\\\مشروع\\\\أ';
      const second = 'C:\\\\مشروع\\\\ب';
      const cwd = document.getElementById('cwd');
      const input = document.getElementById('input');
      localStorage.setItem('satr_draft', 'مسودة قديمة');
      cwd.value = first; cwd.dispatchEvent(new Event('change', { bubbles: true }));
      const migrated = input.value;
      input.value = 'مسودة المشروع الأول'; input.dispatchEvent(new Event('input', { bubbles: true }));
      cwd.value = second; cwd.dispatchEvent(new Event('change', { bubbles: true }));
      const secondInitially = input.value;
      input.value = 'مسودة المشروع الثاني'; input.dispatchEvent(new Event('input', { bubbles: true }));
      cwd.value = first; cwd.dispatchEvent(new Event('change', { bubbles: true }));
      return {
        migrated,
        restored: input.value,
        secondInitially,
        firstSaved: localStorage.getItem('satr_draft::' + first),
        secondSaved: localStorage.getItem('satr_draft::' + second),
        legacy: localStorage.getItem('satr_draft'),
        spellcheck: input.spellcheck,
      };
    })()`);
    assert.strictEqual(draftState.migrated, 'مسودة قديمة');
    assert.strictEqual(draftState.restored, 'مسودة المشروع الأول');
    assert.strictEqual(draftState.secondInitially, '');
    assert.strictEqual(draftState.firstSaved, 'مسودة المشروع الأول');
    assert.strictEqual(draftState.secondSaved, 'مسودة المشروع الثاني');
    assert.strictEqual(draftState.legacy, null);
    assert.strictEqual(draftState.spellcheck, true);

    await setInputAndSend(win, 'طلب فيه خطأ مطبعي', true);
    await waitFor(win, "window.__SATR_TESTSPRITE_HARNESS__.calls.filter((call) => call.name === 'send').length === 1", 'إرسال الطلب المصوّر');
    await completeTurn(win, 'daily-session');
    const edited = await evaluate(win, `(() => {
      const original = document.querySelector('.msg.user');
      original.querySelector('.msg-user-edit').click();
      const composer = document.querySelector('satr-composer');
      return {
        superseded: original.classList.contains('superseded'),
        badge: original.textContent.includes('مُعدَّلة/متجاوَزة'),
        text: document.getElementById('input').value,
        images: composer.getImages().map((image) => image.dataUrl),
      };
    })()`);
    assert.strictEqual(edited.superseded, true);
    assert.strictEqual(edited.badge, true);
    assert.strictEqual(edited.text, 'طلب فيه خطأ مطبعي');
    assert.deepStrictEqual(edited.images, [IMAGE_DATA_URL]);

    await setInputAndSend(win, 'طلب مصحّح', false);
    await waitFor(win, "window.__SATR_TESTSPRITE_HARNESS__.calls.filter((call) => call.name === 'send').length === 2", 'إعادة إرسال الرسالة المعدلة');
    const correctedPayload = await evaluate(win, `(() => {
      const calls = window.__SATR_TESTSPRITE_HARNESS__.calls.filter((call) => call.name === 'send');
      return calls[calls.length - 1].args[0];
    })()`);
    assert.strictEqual(correctedPayload.prompt, 'طلب مصحّح');
    assert.strictEqual(correctedPayload.images.length, 1);
    await completeTurn(win, 'daily-session');

    await setInputAndSend(win, 'طلب ينتهي بخطأ', false);
    await waitFor(win, "window.__SATR_TESTSPRITE_HARNESS__.calls.filter((call) => call.name === 'send').length === 3", 'إرسال طلب result خطأ');
    await emit(win, { type: 'result', session_id: 'daily-session', duration_ms: 8, is_error: true, result: 'فشل الدور' });
    await emit(win, { type: 'proc_done', code: 1 });
    await waitFor(win, "Boolean(document.querySelector('.retry-card button')) && document.body.innerText.includes('فشل الدور')", 'إعادة المحاولة بعد result خطأ');

    await setInputAndSend(win, 'طلب يفشل', false);
    await waitFor(win, "window.__SATR_TESTSPRITE_HARNESS__.calls.filter((call) => call.name === 'send').length === 4", 'إرسال الطلب الفاشل');
    assert.strictEqual(await evaluate(win, "Boolean(document.querySelector('.retry-card'))"), false, 'زر result السابق لم يختف عند بدء دور جديد');
    await emit(win, { type: 'spawn_error', text: 'تعذّر الاتصال بالخادم' });
    await waitFor(win, "Boolean(document.querySelector('.retry-card button'))", 'ظهور زر إعادة المحاولة');
    await evaluate(win, "document.querySelector('.retry-card button').click()");
    await waitFor(win, "window.__SATR_TESTSPRITE_HARNESS__.calls.filter((call) => call.name === 'send').length === 5", 'إعادة إرسال آخر طلب');
    const retryState = await evaluate(win, `(() => {
      const calls = window.__SATR_TESTSPRITE_HARNESS__.calls.filter((call) => call.name === 'send');
      return { prompt: calls[calls.length - 1].args[0].prompt, retryVisible: Boolean(document.querySelector('.retry-card')) };
    })()`);
    assert.strictEqual(retryState.prompt, 'طلب يفشل');
    assert.strictEqual(retryState.retryVisible, false, 'زر الإعادة لم يختف عند بدء الدور الجديد');

    const shortcutState = await evaluate(win, `(() => {
      const input = document.getElementById('input');
      input.focus();
      const editKey = new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, bubbles: true, cancelable: true });
      input.dispatchEvent(editKey);
      const stopKey = new KeyboardEvent('keydown', { key: 's', ctrlKey: true, altKey: true, bubbles: true, cancelable: true });
      document.dispatchEvent(stopKey);
      return { editPrevented: editKey.defaultPrevented, stopPrevented: stopKey.defaultPrevented };
    })()`);
    assert.strictEqual(shortcutState.editPrevented, false, 'ابتُلع اختصار تحرير عادي');
    assert.strictEqual(shortcutState.stopPrevented, true);
    await waitFor(win, "document.body.innerText.includes('⏹ أُوقِف الدور') && Boolean(document.querySelector('.retry-card'))", 'وضوح إيقاف الدور');
    assert.strictEqual(await evaluate(win, "window.__SATR_TESTSPRITE_HARNESS__.calls.some((call) => call.name === 'stop')"), true);

    await setInputAndSend(win, 'غيّر الملفات', false);
    await waitFor(win, "window.__SATR_TESTSPRITE_HARNESS__.calls.filter((call) => call.name === 'send').length === 6", 'بدء دور تغييرات الجلسة');
    await emit(win, { type: 'file_edit', id: 'edit-1', rel: 'src/a.js', added: 3, removed: 1, tool: 'Edit', lines: [{ t: '+', new: 1, text: 'const a = 1;' }] });
    await emit(win, { type: 'file_edit', id: 'edit-2', rel: 'src/a.js', added: 2, removed: 0, tool: 'Edit', lines: [{ t: '+', new: 2, text: 'const b = 2;' }] });
    await emit(win, { type: 'file_edit', id: 'edit-3', rel: 'src/b.js', added: 1, removed: 0, isNew: true, tool: 'Write', lines: [{ t: '+', new: 1, text: 'export {};' }] });
    const changes = await evaluate(win, `(() => {
      document.getElementById('sessionChangesToggle').click();
      const rows = [...document.querySelectorAll('.session-change-row')];
      const before = document.querySelectorAll('.diff').length;
      rows.find((row) => row.textContent.includes('src/a.js')).click();
      return {
        count: document.getElementById('sessionChangesCount').textContent,
        rows: rows.map((row) => row.textContent),
        before,
        after: document.querySelectorAll('.diff').length,
      };
    })()`);
    assert.strictEqual(changes.count, '2');
    assert(changes.rows.some((row) => row.includes('src/a.js') && row.includes('+5') && row.includes('−1')));
    assert.strictEqual(changes.after, changes.before + 1, 'النقر على ملخص الملف لم يفتح بطاقة الفرق القائمة');
    await completeTurn(win, 'daily-session');

    const searchState = await evaluate(win, `(() => {
      const main = document.getElementById('main');
      main.focus();
      const openKey = new KeyboardEvent('keydown', { key: 'f', ctrlKey: true, bubbles: true, cancelable: true });
      document.dispatchEvent(openKey);
      const search = document.getElementById('threadSearchInput');
      search.value = 'طلب';
      search.dispatchEvent(new Event('input', { bubbles: true }));
      const first = document.getElementById('threadSearchCount').textContent;
      document.getElementById('threadSearchNext').click();
      const next = document.getElementById('threadSearchCount').textContent;
      search.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
      return {
        prevented: openKey.defaultPrevented,
        hits: document.querySelectorAll('mark.thread-hit').length,
        first,
        next,
        closed: document.getElementById('threadSearch').hidden,
      };
    })()`);
    assert.strictEqual(searchState.prevented, true);
    assert.notStrictEqual(searchState.first, '0/0');
    assert.notStrictEqual(searchState.next, searchState.first);
    assert.strictEqual(searchState.hits, 0, 'علامات البحث لم تُنظّف عند الإغلاق');
    assert.strictEqual(searchState.closed, true);

    await evaluate(win, `(() => {
      const now = Date.now();
      window.__SATR_TESTSPRITE_HARNESS__.setSessions([
        { id: 'session-new', title: 'جلسة أحدث', cwd: 'C:\\\\مشروع\\\\أ', mtime: now },
        { id: 'session-old', title: 'جلسة أقدم', cwd: 'C:\\\\مشروع\\\\ب', mtime: now - 10000 },
      ]);
    })()`);
    await evaluate(win, "document.querySelector('satr-sessions-panel').open([])");
    await waitFor(win, "document.querySelector('satr-sessions-panel').shadowRoot.querySelectorAll('.sess').length === 2", 'تحميل جلسات الميتاداتا');
    await evaluate(win, `(() => {
      const root = document.querySelector('satr-sessions-panel').shadowRoot;
      const oldRow = [...root.querySelectorAll('.sess')].find((row) => row.textContent.includes('جلسة أقدم'));
      oldRow.querySelector('.pin').click();
    })()`);
    await waitFor(win, "document.querySelector('satr-sessions-panel').shadowRoot.querySelector('.sess').textContent.includes('جلسة أقدم')", 'ترتيب الجلسة المثبتة');
    await evaluate(win, `(() => {
      window.prompt = () => 'عنوان مخصّص';
      const root = document.querySelector('satr-sessions-panel').shadowRoot;
      root.querySelector('.sess .rename').click();
    })()`);
    await waitFor(win, "document.querySelector('satr-sessions-panel').shadowRoot.querySelector('.sess .t').textContent === 'عنوان مخصّص'", 'إعادة تسمية الجلسة');

    const panels = await evaluate(win, `(() => {
      const key = (value) => document.dispatchEvent(new KeyboardEvent('keydown', {
        key: value, ctrlKey: true, altKey: true, bubbles: true, cancelable: true,
      }));
      key('i');
      const focused = document.activeElement === document.getElementById('input');
      key('t');
      const termOpened = !document.getElementById('termPanel').hidden;
      key('t');
      const termClosed = document.getElementById('termPanel').hidden;
      key('p');
      const previewOpened = document.querySelector('satr-preview-panel').hasAttribute('open');
      key('p');
      const previewClosed = !document.querySelector('satr-preview-panel').hasAttribute('open');
      key('n');
      return {
        focused, termOpened, termClosed, previewOpened, previewClosed,
        empty: Boolean(document.querySelector('#thread .empty')),
        changes: document.getElementById('sessionChangesCount').textContent,
      };
    })()`);
    assert.deepStrictEqual(panels, {
      focused: true,
      termOpened: true,
      termClosed: true,
      previewOpened: true,
      previewClosed: true,
      empty: true,
      changes: '0',
    });

    assert.deepStrictEqual(consoleErrors, [], 'ظهرت أخطاء console/CSP: ' + consoleErrors.join(' | '));
    console.log('daily-loop-ui: نجح — الوعي وتكافؤ Kimi، التعديل/الإعادة، المسودات، البحث، التغييرات، الجلسات، الإيقاف والاختصارات؛ صفر CSP/console.');
  } finally {
    if (!win.isDestroyed()) win.destroy();
    await new Promise((resolve) => server.close(resolve));
  }
}

main().then(() => app.quit()).catch((error) => {
  console.error('daily-loop-ui:', error && error.stack ? error.stack : error);
  app.exit(1);
});
