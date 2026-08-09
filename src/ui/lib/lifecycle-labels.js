/**
 * خريطة تعريب حالات lifecycle الظاهرة للمستخدم + مساعدا صياغة مشتركان (الدفعة أ‑2).
 * ملك القائد: المنفذون يستهلكونه ولا يعدلونه — أي نقص مفتاح يُرفع للقائد.
 * البنود: 11+21 (الخريطة الواحدة) · 7 (صيغ العدد) · 6 (القص على حدود الكلمات).
 */

export const LIFECYCLE_LABELS = {
  preparing: 'يجهّز',
  queued: 'في الانتظار',
  starting: 'يبدأ',
  running: 'يعمل',
  working: 'يعمل',
  capturing: 'يجمع النتيجة',
  verifying: 'يتحقق',
  stopping: 'يتوقف',
  pending_confirmation: 'بانتظار التأكيد',
  completed: 'اكتمل',
  passed: 'نجح',
  failed: 'فشل',
  timed_out: 'انتهت المهلة',
  stopped: 'أوقفه المستخدم',
  interrupted: 'انقطع',
  cleanup_failed: 'فشل التنظيف',
  conflict: 'تعارض ملكية',
  approve: 'موافقة',
  reject: 'رفض',
  changes_required: 'تعديلات مطلوبة',
  paused: 'متوقف مؤقتاً',
  active: 'نشط',
  idle: 'خامل',
  partial: 'جزئي',
  cleaning: 'ينظّف',
  budget_exhausted: 'نفدت الميزانية',
  failed_after_n: 'لم ينجح ضمن الدورات',
};

// يعيد التسمية العربية أو الحالة الخام كما هي إن لم تكن معروفة (لا اختراع تسمية).
export function lifecycleLabel(state) {
  return LIFECYCLE_LABELS[state] || String(state == null ? '' : state);
}

// تصريف العدد العربي: واحد/مثنى/3–10 جمعاً/11+ مفرداً معدوداً (many اختيارية تسقط
// إلى plural). الأرقام لاتينية دائماً (قاعدة المشروع).
export function countLabel(count, forms) {
  const n = Math.floor(Number(count) || 0);
  const f = forms || {};
  if (n === 1) return f.one || '';
  if (n === 2) return f.two || '';
  if (n === 0 && typeof f.zero === 'string') return f.zero;
  if (n >= 3 && n <= 10) return n + ' ' + (f.plural || '');
  return n + ' ' + (f.many || f.plural || '');
}

// قص على حدود الكلمات بنقاط Unicode (لا كسر surrogate pairs) مع «…» عند القص.
export function truncateWords(value, maxPoints) {
  const text = String(value == null ? '' : value);
  const limit = Math.max(1, Math.floor(Number(maxPoints) || 0));
  const points = [...text];
  if (points.length <= limit) return text;
  const slice = points.slice(0, limit).join('');
  const cut = slice.replace(/\s+\S*$/u, '');
  return (cut.trim() || slice) + '…';
}
