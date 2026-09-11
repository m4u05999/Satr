// سطر — درع المعاينة: إزاحة WebContentsView عند ظهور سطح فوقه (OBS-059).
// الحوارات تُكتشف دلالياً، والمنبثقات غير الحاجبة تعلن data-preview-overlay دون
// ادّعاء aria-modal. قيمة overlap مخصّصة لتنبيه عابر لا يحجب إلا عند التقاطع.
// الرؤية محسوبة مع الأسلاف: قد يبقى role="dialog" على ابن أبوه مخفي.

const WATCHED_ATTRIBUTES = ['hidden', 'open', 'role', 'aria-modal', 'inert', 'data-preview-overlay'];
const MODAL_SELECTOR = 'dialog[open], [role="dialog"], [aria-modal="true"]';
const SURFACE_SELECTOR = MODAL_SELECTOR + ', [data-preview-overlay]';
const LAYOUT_INTERVAL = 120;

function visible(element) {
  if (!element) return false;
  if (typeof element.checkVisibility === 'function') {
    return element.checkVisibility({ visibilityProperty: true });
  }
  return !!(element.offsetWidth || element.offsetHeight || element.getClientRects().length);
}

function intersects(a, b) {
  return !!(a && b && a.width > 0 && a.height > 0 && b.width > 0 && b.height > 0
    && a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top);
}

/**
 * @param {{root?:Document|Element, onHold:(hold:boolean)=>void, previewRect?:()=>DOMRect|null}} options
 * الإشعار عند التغيّر فقط. class/style تُراقبان على الأسطح وأسلافها دون بقية الدردشة.
 */
export function createPreviewShield(options) {
  const opts = options || {};
  const root = opts.root || document;
  const doc = root.nodeType === 9 ? root : root.ownerDocument;
  const view = doc.defaultView;
  const onHold = typeof opts.onHold === 'function' ? opts.onHold : () => {};
  let last = null;
  let observer = null;
  let styleObserver = null;
  let watchedStyleNodes = new Set();
  let surfaces = [];
  let layoutTimer = 0;
  const pendingDefinitions = new Set();

  function collectSurfaces() {
    surfaces = [...root.querySelectorAll(SURFACE_SELECTOR)];
    if (root.matches && root.matches(SURFACE_SELECTOR)) surfaces.unshift(root);
    if (!styleObserver) return;
    const next = new Set();
    for (const node of surfaces) {
      for (let ancestor = node; ancestor; ancestor = ancestor.parentElement) {
        next.add(ancestor);
        // القشرة تسبق تعريف المكوّنات. ترقية المضيف قد تطبق display:none في
        // Shadow CSS بلا طفرة على المستند، فلا يجوز حفظ رؤيته قبل الترقية.
        const tag = ancestor.localName;
        if (tag.includes('-') && !view.customElements.get(tag) && !pendingDefinitions.has(tag)) {
          pendingDefinitions.add(tag);
          view.customElements.whenDefined(tag).then(() => { if (observer) check(); });
        }
      }
    }
    if (next.size === watchedStyleNodes.size && [...next].every((node) => watchedStyleNodes.has(node))) return;
    styleObserver.disconnect();
    watchedStyleNodes = next;
    for (const node of next) {
      styleObserver.observe(node, { attributes: true, attributeFilter: ['class', 'style'] });
    }
  }

  function readPreviewRect() {
    try { return typeof opts.previewRect === 'function' ? opts.previewRect() : null; }
    catch { return null; }
  }

  function check() {
    collectSurfaces();
    let hold = false;
    let overlapVisible = false;
    for (const node of surfaces) {
      if (!visible(node)) continue;
      if (node.getAttribute('data-preview-overlay') === 'overlap') {
        overlapVisible = true;
        if (intersects(node.getBoundingClientRect(), readPreviewRect())) hold = true;
      } else hold = true;
    }
    // تغير موضع المعاينة قد يحدث بلا resize: نفحص التنبيه المتقاطع فقط كل 120ms
    // ما دام ظاهراً. الحوارات والمنبثقات الأخرى لا تبقي مؤقّتاً في الخلفية.
    if (observer && overlapVisible && !layoutTimer) {
      layoutTimer = view.setTimeout(() => { layoutTimer = 0; check(); }, LAYOUT_INTERVAL);
    } else if (!overlapVisible && layoutTimer) {
      view.clearTimeout(layoutTimer); layoutTimer = 0;
    }
    if (hold === last) return hold;
    last = hold;
    try { onHold(hold); } catch { /* الدرع لا يكسر الواجهة */ }
    return hold;
  }

  function containsSurface(node) {
    return node && node.nodeType === 1 && (
      (node.matches && node.matches(SURFACE_SELECTOR))
      || surfaces.some((surface) => node === surface || node.contains(surface))
      || (node.querySelector && node.querySelector(SURFACE_SELECTOR))
    );
  }

  function onMutations(records) {
    // شظايا النص وclass في فقاعة الدردشة لا تعيد مسح المستند.
    const changed = records.some((record) => record.type === 'attributes'
      ? containsSurface(record.target)
      : [...record.addedNodes, ...record.removedNodes].some(containsSurface));
    if (changed) check();
  }

  function start() {
    if (observer) return;
    styleObserver = new MutationObserver(check);
    observer = new MutationObserver(onMutations);
    observer.observe(root.nodeType === 9 ? root.documentElement : root, {
      subtree: true, childList: true, attributes: true, attributeFilter: WATCHED_ATTRIBUTES,
    });
    view.addEventListener('resize', check);
    root.addEventListener('transitionend', check, true);
    check();
  }

  function stop() {
    if (observer) { observer.disconnect(); observer = null; }
    if (styleObserver) { styleObserver.disconnect(); styleObserver = null; }
    watchedStyleNodes = new Set();
    if (layoutTimer) { view.clearTimeout(layoutTimer); layoutTimer = 0; }
    view.removeEventListener('resize', check);
    root.removeEventListener('transitionend', check, true);
  }

  return { start, stop, check, isHeld: () => last === true };
}

export { MODAL_SELECTOR, SURFACE_SELECTOR, WATCHED_ATTRIBUTES };
