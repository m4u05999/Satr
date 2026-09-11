// صفحة fixture لدرع المعاينة (OBS-059) — تشغّل الوحدة الإنتاجية لا نسخةً منها.
import { createPreviewShield, SURFACE_SELECTOR } from '../../src/ui/lib/preview-shield.js';

const calls = [];
let previewRect = null;
let surfaceQueries = 0;
const queryAll = document.querySelectorAll.bind(document);
document.querySelectorAll = (selector) => {
  if (selector === SURFACE_SELECTOR) surfaceQueries++;
  return queryAll(selector);
};
const shield = createPreviewShield({
  onHold: (hold) => calls.push(hold), previewRect: () => previewRect,
});
const rules = new CSSStyleSheet();
rules.replaceSync('.shield-hidden { display: none; } .shield-menu { display: none; } .shield-menu.open { display: block; } .shield-toast { position: fixed; left: 20px; top: 20px; width: 120px; height: 40px; }');
document.adoptedStyleSheets = [...document.adoptedStyleSheets, rules];
shield.start();

// **لا `requestAnimationFrame` هنا**: النافذة في الاختبار `show:false` فلا يُشغَّل rAF
// أصلاً، فيعلّق الانتظار إلى الأبد وتبدو الصفحة «لم تنتهِ». وهي هشاشة مسجَّلة في هذا
// المستودع (جوع rAF في question-dialog). و`MutationObserver` يُستدعى كمَهمة صغرى،
// فنبضة مَهمة كبرى واحدة تكفي لاستقرار الحالة.
const settle = () => new Promise((resolve) => setTimeout(() => setTimeout(resolve, 0), 0));

const notes = document.getElementById('notesDialog');
const results = {};

async function run() {
  // ── الحالة الابتدائية: الحوار مخفيّ بأبيه رغم أن role="dialog" عليه ──────────
  results.initialHeld = shield.isHeld();
  results.initialCalls = calls.length;

  // ── فتح حوار «ما الجديد» كما يفعل update-toast حرفياً: hidden = false ───────
  notes.hidden = false;
  await settle();
  results.afterOpen = shield.isHeld();

  notes.hidden = true;
  await settle();
  results.afterClose = shield.isHeld();

  // ── عارض اللقطة المكبّر: <dialog> يُضاف ثم showModal() ──────────────────────
  const lightbox = document.createElement('dialog');
  lightbox.id = 'shot';
  lightbox.textContent = 'لقطة';
  document.body.appendChild(lightbox);
  await settle();
  results.afterAppendClosed = shield.isHeld(); // مُضاف لكنه مغلق ⇒ لا حجب
  lightbox.showModal();
  await settle();
  results.afterShowModal = shield.isHeld();
  lightbox.close();
  await settle();
  results.afterCloseModal = shield.isHeld();
  lightbox.remove();

  // ── سطح عادي لا يحجب ────────────────────────────────────────────────────────
  const plain = document.getElementById('plain');
  plain.hidden = false;
  await settle();
  results.plainHeld = shield.isHeld();

  // ── تراكب: حواران معاً ثم إغلاق أحدهما — يبقى الحجب ────────────────────────
  const second = document.createElement('dialog');
  document.body.appendChild(second);
  notes.hidden = false;
  second.showModal();
  await settle();
  results.bothOpen = shield.isHeld();
  second.close();
  await settle();
  results.oneStillOpen = shield.isHeld(); // الحوار الأول ما زال مفتوحاً ⇒ الحجب باقٍ
  notes.hidden = true;
  await settle();
  results.allClosed = shield.isHeld();
  second.remove();

  // ── لا يُستدعى onHold إلا عند التغيّر ───────────────────────────────────────
  const before = calls.length;
  notes.hidden = true; // لا تغيير فعلي
  await settle();
  results.noRedundantCalls = calls.length === before;
  // المنبثقات لا تحتاج ادّعاء أنها حوار حاجب كي تحتمي من الطبقة الأصلية.
  const overlay = document.createElement('div');
  overlay.dataset.previewOverlay = '';
  overlay.textContent = 'منبثق';
  overlay.hidden = true;
  document.body.appendChild(overlay);
  await settle();
  results.hiddenOverlay = shield.isHeld();
  overlay.hidden = false;
  await settle();
  results.openOverlay = shield.isHeld();
  notes.hidden = false;
  overlay.hidden = true;
  await settle();
  results.dialogOutlivesOverlay = shield.isHeld();
  notes.hidden = true;
  overlay.hidden = false;
  await settle();
  results.overlayOutlivesDialog = shield.isHeld();
  overlay.remove();
  await settle();
  results.removedOverlay = shield.isHeld();

  // قائمتا / و@ تغيّران class، وطي درج الشريط قد يخفي المنبثق بأبيه.
  const wrapper = document.createElement('div');
  const menu = document.createElement('div');
  menu.className = 'shield-menu';
  menu.dataset.previewOverlay = '';
  menu.textContent = 'قائمة';
  wrapper.appendChild(menu); document.body.appendChild(wrapper);
  await settle();
  results.closedClassMenu = shield.isHeld();
  menu.classList.add('open');
  await settle();
  results.openClassMenu = shield.isHeld();
  wrapper.classList.add('shield-hidden');
  await settle();
  results.hiddenAncestorClass = shield.isHeld();
  wrapper.classList.remove('shield-hidden');
  await settle();
  results.restoredAncestorClass = shield.isHeld();
  menu.classList.remove('open');
  await settle();
  results.closedClassMenuAgain = shield.isHeld();

  const beforeNoise = surfaceQueries;
  for (let index = 0; index < 40; index++) {
    plain.classList.toggle('streaming');
    plain.textContent = 'تدفق ' + index;
  }
  await settle();
  results.ignoredClassChurn = beforeNoise === surfaceQueries;
  wrapper.remove();

  // التنبيه غير المتقاطع يبقي الصفحة حية؛ تحرك المعاينة وحدها يعيد القياس.
  const toast = document.createElement('div');
  toast.className = 'shield-toast'; toast.dataset.previewOverlay = 'overlap';
  toast.textContent = 'تنبيه';
  document.body.appendChild(toast);
  const toastRect = toast.getBoundingClientRect();
  const intersectingRect = {
    left: toastRect.left + 10, top: toastRect.top + 10,
    right: toastRect.right + 10, bottom: toastRect.bottom + 10,
    width: toastRect.width, height: toastRect.height,
  };
  previewRect = { left: 400, top: 400, right: 500, bottom: 500, width: 100, height: 100 };
  await settle();
  results.outsideToast = shield.isHeld();
  previewRect = intersectingRect;
  await new Promise((resolve) => setTimeout(resolve, 180));
  results.movedPreviewUnderToast = shield.isHeld();
  previewRect = {
    left: toastRect.right, top: toastRect.top,
    right: toastRect.right + 50, bottom: toastRect.bottom, width: 50, height: toastRect.height,
  };
  window.dispatchEvent(new Event('resize'));
  results.touchingEdges = shield.isHeld();
  previewRect = intersectingRect;
  document.dispatchEvent(new Event('transitionend', { bubbles: true }));
  results.transitionOverlap = shield.isHeld();
  previewRect = null;
  window.dispatchEvent(new Event('resize'));
  results.missingPreview = shield.isHeld();
  toast.remove();
  await settle();

  // مضيف وسلف يتعرّفان بعد القشرة: أنماط Shadow قد تخفيهما بلا طفرة مرصودة.
  const delayed = document.createElement('satr-shield-delayed');
  delayed.dataset.previewOverlay = ''; delayed.textContent = 'سطح قبل الترقية';
  document.body.appendChild(delayed);
  await settle();
  results.beforeUpgrade = shield.isHeld();
  class HiddenHost extends HTMLElement {
    connectedCallback() {
      const shadow = this.attachShadow({ mode: 'open' });
      const styles = new CSSStyleSheet(); styles.replaceSync(':host { display: none; }');
      shadow.adoptedStyleSheets = [styles];
    }
  }
  customElements.define('satr-shield-delayed', HiddenHost);
  await settle();
  results.afterUpgrade = shield.isHeld();
  delayed.remove();
  const delayedParent = document.createElement('satr-shield-parent');
  const delayedChild = document.createElement('div');
  delayedChild.dataset.previewOverlay = ''; delayedChild.textContent = 'ابن قبل الترقية';
  delayedParent.appendChild(delayedChild); document.body.appendChild(delayedParent);
  await settle();
  results.beforeAncestorUpgrade = shield.isHeld();
  customElements.define('satr-shield-parent', class extends HiddenHost {});
  await settle();
  results.afterAncestorUpgrade = shield.isHeld();
  delayedParent.remove();

  // stop يوقف المراقبة والمؤقّت، وstart يعيد قراءة الحالة الفعلية.
  shield.stop();
  overlay.hidden = false; document.body.appendChild(overlay);
  await settle();
  results.stopped = shield.isHeld();
  shield.start();
  results.restarted = shield.isHeld();
  overlay.remove();
  await settle();
  results.finalHeld = shield.isHeld();
  shield.stop();
  results.transitions = calls.slice();

  window.__shieldResult = results;
}

run().catch((error) => { window.__shieldResult = { error: String(error && error.message || error) }; });
