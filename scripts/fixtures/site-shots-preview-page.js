'use strict';
// لقطة لوحة المعاينة لصفحة الهبوط — مكوّن preview-panel الإنتاجي؛ الجسر المزيف
// يلتقط previewBounds (المستطيل الذي يبلّغه المكوّن للعرض الأصلي) فنركّب iframe
// المتجر التجريبي فوقه بالضبط — نفس هندسة التطبيق الحقيقي بلا WebContentsView.
let bounds = null;

window.satr = {
  previewOpen: async () => ({ ok: true }),
  previewNavigate: async () => ({ ok: true }),
  previewAction: async () => ({ ok: true }),
  previewClose: async () => ({ ok: true }),
  previewBounds: (x, y, width, height) => { bounds = { x, y, width, height }; placeFrame(); },
  previewPick: async () => ({ ok: true, cancelled: true }),
  previewPickCancel: async () => ({ ok: true }),
  onPreview: () => {},
};

function placeFrame() {
  const frame = document.getElementById('storeFrame');
  if (!frame || !bounds) return;
  frame.style.left = bounds.x + 'px';
  frame.style.top = bounds.y + 'px';
  frame.style.width = bounds.width + 'px';
  frame.style.height = bounds.height + 'px';
}

document.addEventListener('DOMContentLoaded', async () => {
  try {
    await customElements.whenDefined('satr-preview-panel');
    const pv = document.getElementById('pv');
    if (pv.openWith) pv.openWith('http://localhost:3000/');

    await document.fonts.ready;
    await new Promise((resolve) => setTimeout(resolve, 500));
    placeFrame();
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    window.__shotsReady = true;
  } catch (error) {
    window.__shotsError = error && error.stack ? error.stack : String(error);
  }
});
