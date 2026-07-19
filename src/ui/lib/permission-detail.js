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
  const data = input && typeof input === 'object' ? input : {};
  const bare = name.replace(/^.*__/, '');
  if (bare === 'browser_fill_form') {
    const fields = Array.isArray(data.fields) ? data.fields.slice(0, 20) : [];
    if (!fields.length) return 'لا توجد حقول صالحة للتعبئة.';
    return fields.map((field, index) => {
      const target = clipped(field && (field.ref || field.selector) || '', MAX_TARGET_LENGTH);
      const value = clipped(field && field.value || '', MAX_TYPED_TEXT_LENGTH);
      return `${index + 1}. ${target.value || '(غير محدد)'}${target.truncated ? '…' : ''}: ${JSON.stringify(value.value)}${value.truncated ? '…' : ''}`;
    }).join('\n');
  }
  if (bare === 'browser_transfer_field') {
    return 'نقل قيمة بلا كشفها بين: ' + [data.from_ref, data.to_ref, data.transfer_id].filter(Boolean).join(' ← ');
  }
  if (bare === 'browser_request_secret') {
    return 'سيُطلب منك إدخال القيمة بنفسك في الحقل: ' + String(data.field_ref || data.selector || '(غير محدد)') +
      (data.reason ? '\nالسبب: ' + clipped(data.reason, MAX_TYPED_TEXT_LENGTH).value : '');
  }
  if (bare !== 'browser_type') return '';

  const target = clipped(data.ref || data.selector || '', MAX_TARGET_LENGTH);
  const typed = clipped(data.text || '', MAX_TYPED_TEXT_LENGTH);
  return 'العنصر: ' + (target.value || '(غير محدد)') + (target.truncated ? '…' : '') + '\n' +
    'النص المراد كتابته: ' + JSON.stringify(typed.value) + (typed.truncated ? '…' : '');
}
