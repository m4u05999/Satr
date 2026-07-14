const MAX_TARGET_LENGTH = 200;
const MAX_TYPED_TEXT_LENGTH = 600;

function clipped(value, limit) {
  const chars = Array.from(String(value || ''));
  if (chars.length <= limit) return { value: chars.join(''), truncated: false };
  return { value: chars.slice(0, limit).join(''), truncated: true };
}

// تفاصيل خاصة بمربع الإذن فقط — لا تُستعمل في بطاقات الأدوات كي لا يبقى النص المكتوب ظاهراً.
export function formatPermissionDetail(tool, input) {
  const name = typeof tool === 'string' ? tool : '';
  if (name !== 'browser_type' && !name.endsWith('__browser_type')) return '';

  const data = input && typeof input === 'object' ? input : {};
  const target = clipped(data.ref || data.selector || '', MAX_TARGET_LENGTH);
  const typed = clipped(data.text || '', MAX_TYPED_TEXT_LENGTH);
  return 'العنصر: ' + (target.value || '(غير محدد)') + (target.truncated ? '…' : '') + '\n' +
    'النص المراد كتابته: ' + JSON.stringify(typed.value) + (typed.truncated ? '…' : '');
}
