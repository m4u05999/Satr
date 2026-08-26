// سطر — درع المعاينة: حجبٌ تلقائي لطبقة العرض الأصلي عند ظهور أي سطح حواري (OBS-059).
//
// **لماذا بنيوي لا تسجيلي**: `WebContentsView` طبقةُ نظامٍ فوق كل DOM، فبُني
// `holdForDialog` حين اختبأ مربع الإذن خلفها. لكن الحماية كانت **تُكتسب بالتسجيل**:
// ستة أسطح تستدعي `surfaceCoordinator.setDialog`، وكلُّ سطحٍ جديد يُفتح بـ`hidden=false`
// أو `showModal()` يسقط منها صامتاً. وقع ذلك فعلاً مرتين — حوار «ما الجديد» (رصدته
// لقطة مالك على 2.16.11 المنشورة: صفحة المعاينة ترتسم من خلاله) وعارض اللقطة المكبّر.
// فالدرع يقلب القاعدة: الحجب افتراضٌ يُشتقّ من DOM، والتسجيل يبقى لما يحتاج أكثر من
// الحجب (تعليق اللوحات وإعادة التركيز) لا لأصل الحماية.
//
// **الرؤية الفعلية لا السمة**: `#notesCard` يحمل `role="dialog"` دائماً بينما المخفيّ
// أبوه `#notesDialog` — ففحص `[hidden]` على العنصر نفسه كان سيراه ظاهراً أبداً.
// `checkVisibility()` يقرأ الحساب النهائي فيصيب الحالتين.

// السمات المرصودة: تكفي للحالتين المرصودتين ولكل سطح يتبع الأعراف، وتتجنّب ضجيج
// `class`/`style` الذي يتغيّر مع كل شظية بثّ في المحادثة.
const WATCHED_ATTRIBUTES = ['hidden', 'open', 'role', 'aria-modal', 'inert'];
const MODAL_SELECTOR = 'dialog[open], [role="dialog"], [aria-modal="true"]';

/** أهذا العنصر مرئيٌّ فعلاً؟ `checkVisibility` أدق من `hidden` لأنه يقرأ الأب أيضاً. */
function visible(element) {
  if (!element) return false;
  if (typeof element.checkVisibility === 'function') return element.checkVisibility();
  return !!(element.offsetWidth || element.offsetHeight || element.getClientRects().length);
}

/**
 * @param {{root?:Document|Element, onHold:(hold:boolean)=>void}} options
 * `onHold` يُستدعى **عند التغيّر فقط** — لا مع كل طفرة DOM.
 */
export function createPreviewShield(options) {
  const opts = options || {};
  const root = opts.root || document;
  const onHold = typeof opts.onHold === 'function' ? opts.onHold : () => {};
  let last = null;
  let observer = null;

  function anyModalVisible() {
    let nodes;
    try { nodes = root.querySelectorAll(MODAL_SELECTOR); } catch { return false; }
    for (const node of nodes) if (visible(node)) return true;
    return false;
  }

  function check() {
    const hold = anyModalVisible();
    if (hold === last) return hold;
    last = hold;
    try { onHold(hold); } catch { /* الدرع لا يكسر الواجهة */ }
    return hold;
  }

  function start() {
    if (observer) return;
    observer = new MutationObserver(check);
    observer.observe(root === document ? document.documentElement : root, {
      subtree: true, childList: true, attributes: true, attributeFilter: WATCHED_ATTRIBUTES,
    });
    check();
  }

  function stop() {
    if (observer) { observer.disconnect(); observer = null; }
  }

  return { start, stop, check, isHeld: () => last === true };
}

export { MODAL_SELECTOR, WATCHED_ATTRIBUTES };
