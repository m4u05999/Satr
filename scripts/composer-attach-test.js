#!/usr/bin/env node
'use strict';

/**
 * حارس إرفاق أي ملف في المؤلّف (دفعة 2026-09-17 — طلب المالك) — Chromium حيّ على حاضن TestSprite.
 *
 * يمرّر ملفات File حقيقية بمسار الإرفاق الإنتاجي (`composer.addFile` وحدث `drop` على المحرّر):
 *  (١) ملف نصّي صغير ⇒ رقاقة «📄» ومحتواه في `getAttachments()` بنوع text.
 *  (٢) ملف ثنائي (فيه بايت NUL) ⇒ يمرّ بـ`window.satr.saveAttachment` (مزيّف الحاضن) ورقاقة «📦»
 *      بمسار `.satr/attachments/<اسم>` — والاسم يُنظَّف من فواصل المسار في المزيّف نفسه.
 *  (٣) إفلات ملف نصّي على المحرّر يُنتج رقاقة ثالثة (السحب والإفلات مسار حقيقي لا API).
 *  (٤) الإرسال: حمولة `send` المحفوظة في المزيّف تحمل `attachments` بالثلاثة، وفقاعة المستخدم تعرض
 *      أسماءها، والرقائق تُصفَّر بعد الإرسال.
 *  (٥) إزالة رقاقة منسوخة تستدعي `removeAttachment`.
 *
 * ⚠️ حدّ مُصرَّح به: القرص لا يُلمس (المزيّف يعيد مساراً بلا كتابة)؛ الكتابة والحذف الحقيقيان يثبتهما
 * `test:attachments` القطعي على مجلد مؤقت. ولا يُقاس حوار اختيار الملفات نفسه (نظامي).
 */
const assert = require('assert');
const { app, BrowserWindow } = require('electron');
const harness = require('./testsprite-harness');

const TIMEOUT_MS = 15000;
const watchdog = setTimeout(() => { console.error('composer-attach: انتهت المهلة الكلية.'); app.exit(1); }, 90000);
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const evaluate = (win, code) => win.webContents.executeJavaScript(code, true);

async function waitFor(win, expression, label) {
  const deadline = Date.now() + TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (await evaluate(win, 'Boolean(' + expression + ')')) return;
    await pause(30);
  }
  throw new Error('انتهت مهلة ' + label);
}

async function main() {
  const server = harness.createHarnessServer();
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, harness.HOST, resolve); });
  await app.whenReady();
  const errors = [];
  const win = new BrowserWindow({
    show: false, width: 1280, height: 800,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, offscreen: true, backgroundThrottling: false, partition: 'composer-attach-' + Date.now() },
  });
  win.webContents.on('console-message', (_event, _level, message) => {
    if (/content security policy|uncaught|unhandled/i.test(String(message))) errors.push(String(message));
  });
  try {
    await win.loadURL('http://' + harness.HOST + ':' + server.address().port + '/');
    await waitFor(win, "customElements.get('satr-composer') && document.querySelector('satr-gate').hidden", 'إقلاع القشرة');
    const result = await evaluate(win, `(async () => {
      const composer = document.querySelector('satr-composer');
      const input = document.getElementById('input');
      const bar = document.getElementById('attachments');
      const harnessApi = window.__SATR_TESTSPRITE_HARNESS__;
      harnessApi.clearCalls();
      document.getElementById('cwd').value = 'D:\\\\satr-harness-project';
      const out = {};
      // (١) نصّي
      await composer.addFile(new File(['# خطة\\nسطر ثانٍ'], 'plan.md', { type: 'text/markdown' }));
      // (٢) ثنائي: بايت NUL في أول 8 ك.ب ⇒ ليس نصّاً ⇒ يُنسخ
      const bin = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x00, 0x01, 0x02, 0xff]);
      await composer.addFile(new File([bin], 'sub/dir/report.pdf', { type: 'application/pdf' }));
      // (٣) إفلات
      const transfer = new DataTransfer();
      transfer.items.add(new File(['a,b\\n1,2'], 'data.csv', { type: 'text/csv' }));
      input.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: transfer }));
      await new Promise((r) => setTimeout(r, 120));
      out.chips = [...bar.querySelectorAll('.attach-file')].map((c) => ({ kind: c.dataset.kind, name: c.querySelector('.attach-name').textContent, size: c.querySelector('.attach-size').textContent }));
      out.open = bar.classList.contains('open');
      out.attachments = composer.getAttachments();
      out.saveCalls = harnessApi.calls.filter((c) => c.name === 'saveAttachment').map((c) => c.args);
      // (٥) إزالة المنسوخ ⇒ removeAttachment
      const removeBtn = bar.querySelector('.attach-file[data-kind="file"] .rm');
      removeBtn.click();
      await new Promise((r) => setTimeout(r, 50));
      out.afterRemove = composer.getAttachments().map((a) => a.name);
      out.removeCalled = harnessApi.calls.some((c) => c.name === 'removeAttachment');
      // نعيد المنسوخ للإرسال
      await composer.addFile(new File([bin], 'report.pdf', { type: 'application/pdf' }));
      // (٤) الإرسال بلا نصّ — المرفقات وحدها تكفي
      input.value = '';
      harnessApi.clearCalls();
      document.getElementById('send').click();
      await new Promise((r) => setTimeout(r, 400));
      const sendCall = harnessApi.calls.find((c) => c.name === 'send');
      out.payloadAttachments = sendCall ? sendCall.args[0].attachments : null;
      out.userChips = [...document.querySelectorAll('.msg.user .msg-attachment')].map((c) => c.textContent);
      out.clearedAfterSend = composer.getAttachments().length === 0 && !bar.classList.contains('open');
      return JSON.stringify(out);
    })()`);
    const r = JSON.parse(result);
    assert.strictEqual(r.open, true, 'شريط المرفقات لم يُفتح');
    assert.deepStrictEqual(r.chips.map((c) => c.kind + ':' + c.name), ['text:plan.md', 'file:sub_dir_report.pdf', 'text:data.csv'],
      'الرقائق الثلاث (نصّي/منسوخ/مُفلَت): ' + JSON.stringify(r.chips));
    assert.strictEqual(r.attachments[0].text, '# خطة\nسطر ثانٍ', 'محتوى النصّي في getAttachments');
    assert.strictEqual(r.attachments[1].rel, '.satr/attachments/sub_dir_report.pdf', 'مسار المنسوخ من المزيّف');
    assert.strictEqual(r.saveCalls.length, 1, 'saveAttachment استُدعي مرة للثنائي وحده: ' + JSON.stringify(r.saveCalls));
    assert.ok(r.saveCalls[0][1] > 0, 'base64 غير فارغ وصل المزيّف');
    assert.deepStrictEqual(r.afterRemove, ['plan.md', 'data.csv'], 'إزالة الرقاقة المنسوخة');
    assert.strictEqual(r.removeCalled, true, 'إزالة المنسوخ تستدعي removeAttachment');
    assert.ok(Array.isArray(r.payloadAttachments) && r.payloadAttachments.length === 3, 'حمولة send تحمل المرفقات الثلاثة: ' + JSON.stringify(r.payloadAttachments));
    assert.deepStrictEqual(r.payloadAttachments.map((a) => a.kind), ['text', 'text', 'file']);
    assert.deepStrictEqual(r.userChips, ['📄 plan.md', '📄 data.csv', '📦 report.pdf'], 'فقاعة المستخدم تعرض الأسماء: ' + JSON.stringify(r.userChips));
    assert.strictEqual(r.clearedAfterSend, true, 'الرقائق تُصفَّر بعد الإرسال');
    assert.strictEqual(errors.length, 0, 'صفر خطأ JavaScript أو CSP: ' + errors.join('\n'));
    console.log('composer-attach: نجح — نصّي محقون + ثنائي منسوخ عبر saveAttachment + إفلات + إرسال بلا نصّ بثلاثة مرفقات + إزالة تستدعي removeAttachment؛ صفر CSP.');
  } finally {
    if (!win.isDestroyed()) win.destroy();
    await new Promise((resolve) => server.close(resolve));
  }
}

main().then(() => { clearTimeout(watchdog); app.exit(0); }).catch((error) => {
  console.error('composer-attach:', error && error.stack ? error.stack : error);
  app.exit(1);
});
