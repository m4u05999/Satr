// صفحة fixture لدرع المعاينة (OBS-059) — تشغّل الوحدة الإنتاجية لا نسخةً منها.
import { createPreviewShield } from '../../src/ui/lib/preview-shield.js';

const calls = [];
const shield = createPreviewShield({ onHold: (hold) => calls.push(hold) });
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
  results.transitions = calls.slice();

  window.__shieldResult = results;
}

run().catch((error) => { window.__shieldResult = { error: String(error && error.message || error) }; });
