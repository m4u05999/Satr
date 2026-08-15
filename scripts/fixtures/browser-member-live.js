const previewListeners = [];
const calls = [];
const onePixel = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLzNwAAAABJRU5ErkJggg==';

window.satr = {
  previewBounds: (...args) => { calls.push(['bounds', ...args]); return Promise.resolve({ ok: true }); },
  previewOpen: (url) => { calls.push(['open', url]); return Promise.resolve({ ok: true }); },
  previewNavigate: (url) => { calls.push(['navigate', url]); return Promise.resolve({ ok: true }); },
  previewOpenAgent: (url) => { calls.push(['agent-open', url]); return Promise.resolve({ ok: true }); },
  previewNavigateAgent: (url) => { calls.push(['agent-navigate', url]); return Promise.resolve({ ok: true }); },
  previewAction: (action) => { calls.push(['action', action]); return Promise.resolve({ ok: true }); },
  previewPick: () => Promise.resolve({ ok: true, pick: {
    selector: '#hero', tag: 'button', html: '<button id="hero">ابدأ</button>', text: 'ابدأ',
    box: { w: 120, h: 40, pad: [4, 8, 4, 8], mar: [0, 0, 0, 0] },
    styles: { id: '#hero', cls: 'primary', display: 'block', position: 'static', color: 'rgb(1, 2, 3)', background: 'rgb(4, 5, 6)', font: '16px 600 sans' },
  } }),
  previewPickCancel: () => Promise.resolve({ ok: true }),
  previewFrame: () => Promise.resolve({ ok: true, base64: onePixel, width: 1, height: 1 }),
  previewElementShot: () => Promise.resolve({ ok: true, base64: onePixel }),
  previewClose: () => Promise.resolve({ ok: true }),
  previewActionDone: () => Promise.resolve({ ok: true }),
  devServerInfo: () => Promise.resolve({ ok: true, running: true, record: { command: 'npm run dev' } }),
  devServerRestart: () => Promise.resolve({ ok: true }),
  handoffDone: () => Promise.resolve({ ok: true }),
  onPreview: (callback) => { previewListeners.push(callback); return () => {}; },
  // بوابة اختبارية لبثّ أحداث satr:preview اصطناعياً من runner الحي
  __firePreviewEvent: (event) => previewListeners.forEach((listener) => listener(event)),
};

const violations = [];
document.addEventListener('securitypolicyviolation', (event) => violations.push(event.violatedDirective));
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

(async () => {
  try {
    await import('../../src/ui/components/chat.js');
    await import('../../src/ui/components/preview-panel.js');
    await customElements.whenDefined('satr-chat');
    await customElements.whenDefined('satr-preview-panel');
    const chat = document.querySelector('satr-chat');
    const panel = document.querySelector('satr-preview-panel');
    const root = panel.shadowRoot;

    const block = chat.newAssistantBlock('اختبار');
    block.addScreenshot('data:image/png;base64,' + onePixel, 'page');
    const thumbnail = document.querySelector('.tool.browser-shot .shot-thumb img');
    if (!thumbnail) throw new Error('لم تظهر مصغّرة لقطة الوكيل في بطاقة الأداة');

    let fixed = null;
    panel.addEventListener('preview-fix', (event) => { fixed = event.detail; });
    previewListeners.forEach((listener) => listener({ type: 'console', levelLabel: 'error', message: 'boom', source: 'app.js', line: 9 }));
    root.querySelector('.pc-fix').click();
    if (!fixed || fixed.message !== 'boom' || fixed.line !== 9) throw new Error('زر أصلحه لم يرسل سياق الخطأ');

    panel.openWith('http://localhost:5173');
    await wait(40);
    let wave = null;
    panel.addEventListener('preview-error-wave', (event) => { wave = event.detail; });
    panel.reloadIfLive();
    previewListeners.forEach((listener) => listener({ type: 'netreq', method: 'GET', url: 'http://localhost:5173/api', status: 500, resourceType: 'xhr' }));
    await wait(4300);
    if (!wave || wave.count !== 1) throw new Error('لم يظهر إشعار موجة أخطاء ما بعد التحديث');

    let picked = null;
    panel.addEventListener('preview-edit', (event) => { picked = event.detail; });
    root.getElementById('pvPick').click();
    await wait(20);
    root.getElementById('pbFix').click();
    await wait(30);
    if (!picked || !/أصلح/.test(picked.instruction) || !picked.imageDataUrl.startsWith('data:image/png;base64,')) {
      throw new Error('شريحة 🎯 السريعة لم ترسل طلباً مع لقطة العنصر');
    }

    await panel.refreshServerStatus();
    if (!root.getElementById('pvServerState').classList.contains('running') || root.getElementById('pvServerText').textContent !== 'الخادم يعمل') {
      throw new Error('شارة حالة الخادم لم تعرض الحالة الحية');
    }

    window.__browserMemberResult = { pass: true, violations, calls };
  } catch (error) {
    window.__browserMemberResult = { pass: false, error: error && error.stack ? error.stack : String(error), violations, calls };
  }
})();
