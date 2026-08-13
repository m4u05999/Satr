/**
 * سطر — بناء ظرف إذن الجوال من رؤية العملية الرئيسية فقط.
 *
 * الوحدة نقية: لا وقت داخلياً ولا عشوائية ولا وصول للقرص أو الشبكة. لا يخرج منها
 * إلا الحقول المجمّدة، ولا تُستعمل حقول النص الحر مثل prompt/reason/taskSummary.
 */

'use strict';

const { scrubSecrets } = require('./secretscrub');
const { computeDiff } = require('./diff');

const SHORT_LIMIT = 160;
const SUMMARY_LIMIT = 600;
const DETAIL_LIMIT = 800;

// حدود بطاقة التغيير (قرار مالك 2026-08-13). القاعدة الحاكمة: الظرف لا يعرض
// تغييراً **جزئياً** أبداً — إمّا التغيير كاملاً أو `unavailable`، لأن عرض 40 سطراً
// من 500 يعيد المستخدم إلى الختم الأعمى الذي جاءت هذه الدفعة لتقتله.
const MAX_CHANGE_LINES = 40;
const MAX_CHANGE_LINE_CHARS = 200;
const MAX_CHANGE_BYTES = 6 * 1024;
const MAX_CHANGE_SOURCE_CHARS = 64 * 1024;
const MAX_INPUT_TEXT = 128 * 1024;
const MAX_INPUT_NODES = 512;
const MAX_INPUT_KEYS = 96;
const MAX_INPUT_DEPTH = 6;

const CONTROL_RE = /[\u0000-\u001f\u007f-\u009f]/g;
const BIDI_RE = /[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/g;

const LABELS = Object.freeze({
  Read: 'قراءة ملف',
  read_file: 'قراءة ملف',
  ReadMediaFile: 'قراءة وسائط',
  ImageView: 'معاينة صورة',
  Glob: 'بحث عن ملفات',
  Grep: 'بحث في المحتوى',
  search_code: 'بحث في الشفرة',
  list_files: 'عرض ملفات المشروع',
  repo_map: 'خريطة المشروع',
  verification_config: 'قراءة إعدادات التحقق',
  get_background_output: 'قراءة مخرجات مهمة',
  list_background_tasks: 'عرض المهام الخلفية',
  load_skill: 'تحميل مهارة',
  read_skill_resource: 'قراءة مورد مهارة',
  Write: 'كتابة ملف',
  Edit: 'تعديل ملف',
  MultiEdit: 'تعديل ملف',
  write_file: 'كتابة ملف',
  edit_file: 'تعديل ملف',
  delete_file: 'حذف ملف',
  apply_patch: 'تطبيق رقعة',
  Bash: 'تنفيذ أمر',
  Shell: 'تنفيذ أمر',
  run_command: 'تنفيذ أمر',
  run_in_terminal: 'تنفيذ أمر',
  run_in_background: 'تشغيل مهمة خلفية',
  stop_background_task: 'إيقاف مهمة خلفية',
  verify_project: 'تشغيل تحقق المشروع',
  generate_media: 'توليد وسائط',
  promo_record_start: 'بدء تسجيل برومو',
  promo_record_stop: 'إيقاف تسجيل برومو',
  WebSearch: 'بحث ويب',
  WebFetch: 'جلب صفحة',
  FetchURL: 'جلب صفحة',
  open_preview: 'فتح المعاينة',
  browser_navigate: 'انتقال في المتصفح',
  read_page: 'قراءة الصفحة',
  browser_snapshot: 'لقطة بنيوية للصفحة',
  browser_console: 'قراءة سجل المتصفح',
  browser_network: 'قراءة شبكة المتصفح',
  screenshot: 'لقطة شاشة',
  browser_screenshot_element: 'لقطة عنصر',
  browser_wait_for: 'انتظار عنصر',
  browser_scroll: 'تمرير الصفحة',
  browser_hover: 'تحويم على عنصر',
  browser_click: 'نقر عنصر',
  browser_type: 'كتابة في حقل',
  browser_select_option: 'اختيار من قائمة',
  browser_press_key: 'ضغط مفتاح',
  browser_evaluate: 'تنفيذ تعبير في الصفحة',
  browser_set_viewport: 'ضبط أبعاد المعاينة',
  browser_perf: 'قياس أداء الصفحة',
  browser_back: 'رجوع في المتصفح',
  browser_forward: 'تقدم في المتصفح',
  browser_fill_form: 'تعبئة نموذج',
  browser_transfer_field: 'نقل قيمة بين حقلين',
  browser_request_secret: 'طلب إدخال سري',
  browser_handoff: 'تسليم المتصفح للمستخدم',
  browser_handoff_step: 'تسليم خطوة للمستخدم',
  mcp_elicitation: 'فتح رابط موصّل',
});

const NO_FIELD_READ = Object.freeze({
  list_files: 'ملفات المشروع',
  verification_config: 'إعدادات التحقق للمشروع',
  list_background_tasks: 'المهام الخلفية',
});

const NO_FIELD_BROWSER = Object.freeze({
  read_page: 'الصفحة المعروضة حالياً',
  browser_snapshot: 'العناصر التفاعلية في الصفحة الحالية',
  browser_console: 'سجل الصفحة الحالية',
  browser_network: 'طلبات شبكة الصفحة الحالية',
  screenshot: 'الصفحة المعروضة حالياً',
  browser_perf: 'أداء الصفحة الحالية',
  browser_back: 'الرجوع إلى الصفحة السابقة',
  browser_forward: 'التقدم إلى الصفحة التالية',
});

// Kimi يبث الاسم المعرّب في permission_request؛ الربط صريح ولا يعتمد على تخمين لغوي.
const KIMI_ALIASES = Object.freeze({
  'قراءة ملف': 'Read',
  'قراءة وسائط': 'ReadMediaFile',
  'كتابة ملف': 'Write',
  'تعديل ملف': 'Edit',
  'بحث عن ملفات': 'Glob',
  'بحث في المحتوى': 'Grep',
  'تنفيذ أمر': 'Bash',
  'بحث ويب': 'WebSearch',
  'جلب صفحة': 'FetchURL',
});

function truncatePoints(value, limit) {
  const points = Array.from(value);
  return points.length <= limit ? value : points.slice(0, limit - 1).join('') + '…';
}

function cleanText(value, limit) {
  if (typeof value !== 'string' && typeof value !== 'number') return '';
  const text = scrubSecrets(String(value))
    .replace(CONTROL_RE, ' ')
    .replace(BIDI_RE, '')
    .replace(/\s+/gu, ' ')
    .trim();
  return truncatePoints(text, limit);
}

function isRecord(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  try {
    const proto = Object.getPrototypeOf(value);
    return proto === Object.prototype || proto === null;
  } catch {
    return false;
  }
}

// فحص محدود يمنع مدخلاً هائلاً/عميقاً أو getters من الوصول إلى مسار الاستخراج.
function safeInput(input) {
  if (!isRecord(input)) return false;
  const seen = new Set();
  let nodes = 0;
  let keys = 0;
  let textUnits = 0;

  function visit(value, depth) {
    nodes += 1;
    if (nodes > MAX_INPUT_NODES || depth > MAX_INPUT_DEPTH) return false;
    if (typeof value === 'string') {
      textUnits += value.length;
      return textUnits <= MAX_INPUT_TEXT;
    }
    // بعض مسارات Codex تبني حقلاً اختيارياً صريحاً بقيمة undefined قبل البث.
    if (value == null || typeof value === 'undefined' || typeof value === 'boolean') return true;
    if (typeof value === 'number') return Number.isFinite(value);
    if (typeof value !== 'object' || seen.has(value)) return false;
    if (!Array.isArray(value) && !isRecord(value)) return false;
    seen.add(value);
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const names = Object.keys(descriptors);
    keys += names.length;
    if (keys > MAX_INPUT_KEYS) return false;
    for (const name of names) {
      const descriptor = descriptors[name];
      if (!Object.prototype.hasOwnProperty.call(descriptor, 'value') || !visit(descriptor.value, depth + 1)) return false;
    }
    return true;
  }

  try { return visit(input, 0); }
  catch { return false; }
}

function basename(value) {
  if (typeof value !== 'string') return '';
  const parts = value.split(/[\\/]+/).filter(Boolean);
  return parts.length ? parts[parts.length - 1] : '';
}

function textField(input, names) {
  for (const name of names) {
    if (typeof input[name] === 'string' && input[name].trim()) return input[name];
  }
  return '';
}

function stringList(value) {
  if (!Array.isArray(value) || !value.length || value.some((item) => typeof item !== 'string' || !item.trim())) return null;
  return value;
}

function normalizedToolName(tool) {
  const prefixes = [
    'mcp__satr-terminal__',
    'mcp__satr-verify__',
    'mcp__satr-skills__',
  ];
  let bare = tool;
  for (const prefix of prefixes) {
    if (tool.startsWith(prefix)) {
      bare = tool.slice(prefix.length);
      break;
    }
  }
  return Object.prototype.hasOwnProperty.call(KIMI_ALIASES, bare) ? KIMI_ALIASES[bare] : bare;
}

function literal(risk, value, detail) {
  return value ? { risk, summary: value, detail } : null;
}

function extractRead(tool, input) {
  if (Object.prototype.hasOwnProperty.call(NO_FIELD_READ, tool)) return literal('read', NO_FIELD_READ[tool]);
  if (tool === 'Read') return literal('read', textField(input, ['file_path']));
  if (tool === 'read_file') return literal('read', textField(input, ['path']));
  if (tool === 'ReadMediaFile' || tool === 'ImageView') return literal('read', textField(input, ['file_path', 'path']));
  if (tool === 'Glob') return literal('read', textField(input, ['pattern']));
  if (tool === 'Grep') return literal('read', textField(input, ['pattern']));
  if (tool === 'search_code' || tool === 'repo_map') return literal('read', textField(input, ['query']) || (tool === 'repo_map' ? 'خريطة المشروع' : ''));
  if (tool === 'get_background_output') return literal('read', textField(input, ['id']));
  if (tool === 'load_skill') return literal('read', textField(input, ['name']));
  if (tool === 'read_skill_resource') return literal('read', textField(input, ['resource']));
  return null;
}

function extractWrite(tool, input) {
  if (tool === 'Write' || tool === 'Edit' || tool === 'MultiEdit') {
    return literal('write', textField(input, ['file_path']));
  }
  if (tool === 'write_file' || tool === 'edit_file' || tool === 'delete_file') {
    return literal('write', textField(input, ['path']));
  }
  if (tool === 'apply_patch') {
    const changes = stringList(input.changes);
    if (!changes) return null;
    return literal('write', changes[0], changes.length > 1 ? changes.join('، ') : undefined);
  }
  return null;
}

function extractExec(tool, input) {
  if (tool === 'Bash' || tool === 'Shell' || tool === 'run_command'
      || tool === 'run_in_terminal' || tool === 'run_in_background') {
    return literal('exec', textField(input, ['command']));
  }
  if (tool === 'stop_background_task') return literal('exec', textField(input, ['id']));
  if (tool === 'verify_project') {
    const checks = input.checks == null ? [] : stringList(input.checks);
    if (checks === null) return null;
    return literal('exec', checks.length ? checks.join('، ') : 'كل فحوص المشروع');
  }
  if (tool === 'generate_media') {
    const kind = textField(input, ['kind']);
    if (!['image', 'video', 'audio'].includes(kind)) return null;
    const parts = [kind];
    if (typeof input.provider === 'string' && input.provider.trim()) parts.push(input.provider);
    if (typeof input.model === 'string' && input.model.trim()) parts.push(input.model);
    if (Number.isInteger(input.count) && input.count > 0) parts.push(String(input.count));
    return literal('exec', parts.join(' · '));
  }
  if (tool === 'promo_record_start') {
    const aspect = textField(input, ['aspect']);
    if (!aspect) return null;
    return literal('exec', textField(input, ['url']) || aspect, textField(input, ['url']) ? aspect : undefined);
  }
  if (tool === 'promo_record_stop') return literal('exec', 'إيقاف تسجيل البرومو الجاري');
  return null;
}

function formRefs(fields) {
  if (!Array.isArray(fields) || !fields.length) return '';
  const refs = [];
  for (const field of fields) {
    if (!isRecord(field)) return '';
    const ref = textField(field, ['ref', 'selector']);
    if (!ref) return '';
    refs.push(ref);
  }
  return refs.join('، ');
}

function extractBrowser(tool, input) {
  if (Object.prototype.hasOwnProperty.call(NO_FIELD_BROWSER, tool)) return literal('browser', NO_FIELD_BROWSER[tool]);
  if (tool === 'WebFetch' || tool === 'FetchURL' || tool === 'open_preview'
      || tool === 'browser_navigate' || tool === 'mcp_elicitation') {
    return literal('browser', textField(input, ['url']));
  }
  if (tool === 'WebSearch') return literal('browser', textField(input, ['query']));
  if (tool === 'browser_screenshot_element' || tool === 'browser_hover' || tool === 'browser_click') {
    return literal('browser', textField(input, ['ref']));
  }
  if (tool === 'browser_wait_for') return literal('browser', textField(input, ['selector', 'text']));
  if (tool === 'browser_scroll') return literal('browser', textField(input, ['direction']) || 'down');
  if (tool === 'browser_type') return literal('browser', textField(input, ['ref']));
  if (tool === 'browser_select_option') {
    const ref = textField(input, ['ref']);
    const value = textField(input, ['value']);
    return ref && value ? literal('browser', ref, value) : null;
  }
  if (tool === 'browser_press_key') return literal('browser', textField(input, ['key']));
  if (tool === 'browser_evaluate') return literal('browser', textField(input, ['expression']));
  if (tool === 'browser_set_viewport') {
    return Number.isInteger(input.width) && Number.isInteger(input.height)
      ? literal('browser', input.width + '×' + input.height) : null;
  }
  if (tool === 'browser_fill_form') return literal('browser', formRefs(input.fields));
  if (tool === 'browser_transfer_field') {
    const from = textField(input, ['from_ref']);
    const to = textField(input, ['to_ref']);
    return from && to ? literal('browser', from + ' → ' + to) : null;
  }
  if (tool === 'browser_request_secret') return literal('browser', textField(input, ['field_ref', 'ref', 'selector']));
  if (tool === 'browser_handoff' || tool === 'browser_handoff_step') return literal('browser', 'تسليم التحكم للمستخدم');
  return null;
}

function extract(tool, input) {
  return extractRead(tool, input)
    || extractWrite(tool, input)
    || extractExec(tool, input)
    || extractBrowser(tool, input);
}

function fallbackSummary(tool) {
  const safeName = cleanText(tool, SHORT_LIMIT);
  return safeName ? 'طلب إذن غير معروف للأداة: ' + safeName : 'طلب إذن غير معروف أو مشوّه';
}

function finiteTimestamp(value) {
  return Number.isFinite(value) && value >= 0 ? Math.floor(value) : 0;
}

/* ─────────────── بطاقة التغيير (F5): «الحكم لا الختم» ───────────────
 * كانت بطاقة `Edit`/`Write` تحمل **مسار الملف وحده**، فيوافق المستخدم من المقهى
 * على ما لا يراه — بينما يرى على سطح المكتب بطاقة فرق كاملة. ذلك تراجع أمني لا
 * نقص تجربة: يجعل «اسمح» أرخص من «افهم». العلاج شقّان: الفرق الحقيقي هنا،
 * وقفل «اسمح» على الهاتف حين لا يكون `status === 'ok'` (‏canAllowFromPhone).
 */

/** أدوات الكتابة التي يجب أن يحمل ظرفها `change` — حضوره هو ما يقفل الزر. */
const CHANGE_TOOLS = new Set([
  'Write', 'Edit', 'MultiEdit', 'write_file', 'edit_file', 'delete_file', 'apply_patch',
]);

function changeUnavailable(reason) {
  return { status: 'unavailable', reason };
}

/** ينظّف سطر فرق: يزيل التحكم/Bidi **ويُبقي المسافة البادئة** (الإزاحة معنى في الكود). */
function cleanDiffLine(value) {
  if (typeof value !== 'string') return '';
  return value.replace(CONTROL_RE, ' ').replace(BIDI_RE, '');
}

/** السرّ يُكشف بأن التنقية غيّرت النص — فنمتنع عن العرض بدل عرض نصٍّ محجوب. */
function carriesSecret(text) {
  return scrubSecrets(text) !== text;
}

function changeText(value) {
  return typeof value === 'string' ? value : null;
}

/** يستخرج أزواج (قبل، بعد) من مدخلات الأداة — بلا قرص ولا تخمين. */
function changePairs(tool, input) {
  if (tool === 'delete_file') return { kind: 'delete', pairs: [] };
  if (tool === 'Write' || tool === 'write_file') {
    const content = changeText(input.content);
    return content == null ? null : { kind: 'write', pairs: [{ before: '', after: content }] };
  }
  if (tool === 'Edit' || tool === 'edit_file') {
    const before = changeText(input.old_string);
    const after = changeText(input.new_string);
    return before == null || after == null ? null : { kind: 'edit', pairs: [{ before, after }] };
  }
  if (tool === 'MultiEdit') {
    const edits = Array.isArray(input.edits) ? input.edits : null;
    if (!edits || !edits.length) return null;
    const pairs = [];
    for (const edit of edits) {
      if (!isRecord(edit)) return null;
      const before = changeText(edit.old_string);
      const after = changeText(edit.new_string);
      if (before == null || after == null) return null;
      pairs.push({ before, after });
    }
    return { kind: 'edit', pairs };
  }
  return null;
}

/**
 * يبني بطاقة التغيير لأداة كتابة.
 * @returns {object|null} `null` لأداة ليست من أدوات الكتابة (فلا يُقفل الزر)،
 *   وإلا `{status:'ok',…}` أو `{status:'unavailable', reason}`.
 */
function buildChange(tool, input) {
  if (!CHANGE_TOOLS.has(tool)) return null;
  if (!isRecord(input)) return changeUnavailable('malformed');
  // رقعة موحّدة: بنيتها ليست زوج (قبل/بعد) فلا نتظاهر بعرضها — فشل مغلق صريح.
  if (tool === 'apply_patch') return changeUnavailable('unsupported_tool');

  const source = changePairs(tool, input);
  if (!source) return changeUnavailable('malformed');
  if (source.kind === 'delete') return { status: 'ok', kind: 'delete', added: 0, removed: 0, lines: [] };

  let sourceChars = 0;
  for (const pair of source.pairs) sourceChars += pair.before.length + pair.after.length;
  if (sourceChars > MAX_CHANGE_SOURCE_CHARS) return changeUnavailable('too_large');

  // الفحص على المصدر كاملاً قبل أي بناء: تغييرٌ يحمل سرّاً **لا يُوافَق عليه من
  // الجوال** — لا يُعرض محجوباً ثم يُطلب حكم على فراغ.
  for (const pair of source.pairs) {
    if (carriesSecret(pair.before) || carriesSecret(pair.after)) return changeUnavailable('secret_redacted');
  }

  const lines = [];
  let added = 0;
  let removed = 0;
  let bytes = 0;
  for (let i = 0; i < source.pairs.length; i += 1) {
    if (i > 0) lines.push({ t: '@' });
    const diff = computeDiff(source.pairs[i].before, source.pairs[i].after);
    if (diff.truncated) return changeUnavailable('too_large');
    added += diff.added;
    removed += diff.removed;
    for (const op of diff.lines) {
      if (lines.length >= MAX_CHANGE_LINES) return changeUnavailable('too_large');
      if (op.t === '@') { lines.push({ t: '@' }); continue; }
      const text = cleanDiffLine(op.text);
      if (text.length > MAX_CHANGE_LINE_CHARS) return changeUnavailable('too_large');
      bytes += Buffer.byteLength(text, 'utf8') + 1;
      if (bytes > MAX_CHANGE_BYTES) return changeUnavailable('too_large');
      lines.push({ t: op.t, text });
    }
  }
  return { status: 'ok', kind: source.kind, added, removed, lines };
}

/** يبني نسخة جديدة كلياً ولا يحتفظ بأي مرجع إلى req أو ctx. */
function buildChecked(req, ctx) {
  const request = isRecord(req) ? req : {};
  const context = isRecord(ctx) ? ctx : {};
  const rawTool = typeof request.tool === 'string' ? request.tool : '';
  const tool = normalizedToolName(rawTool);
  const inputOk = safeInput(request.input);
  const projectSource = basename(request.cwd) || context.project || '';
  const metadataOk = (typeof request.id === 'string' || typeof request.id === 'number')
    && cleanText(request.id, SHORT_LIMIT)
    && typeof request.cwd === 'string'
    && cleanText(basename(request.cwd), SHORT_LIMIT)
    && typeof request.engine === 'string' && cleanText(request.engine, SHORT_LIMIT)
    && cleanText(rawTool, SHORT_LIMIT)
    && Number.isFinite(context.createdAt)
    && context.createdAt >= 0
    && Number.isFinite(context.ttlMs)
    && context.ttlMs >= 0;
  const extracted = inputOk && metadataOk ? extract(tool, request.input) : null;
  const action = extracted && cleanText(extracted.summary, SUMMARY_LIMIT) ? extracted : null;
  const label = Object.prototype.hasOwnProperty.call(LABELS, tool) ? LABELS[tool] : 'أداة غير معروفة';

  const envelope = {
    v: 1,
    envelope_id: cleanText(request.id, SHORT_LIMIT),
    engine: cleanText(request.engine, SHORT_LIMIT),
    project: cleanText(projectSource, SHORT_LIMIT),
    tool: {
      name: cleanText(rawTool, SHORT_LIMIT),
      label: cleanText(label, SHORT_LIMIT),
    },
    risk: action ? action.risk : 'unknown',
    summary: cleanText(action ? action.summary : fallbackSummary(rawTool), SUMMARY_LIMIT),
    created_at: finiteTimestamp(context.createdAt),
    ttl_ms: finiteTimestamp(context.ttlMs),
  };
  if (action && action.detail) {
    const detail = cleanText(action.detail, DETAIL_LIMIT);
    if (detail) envelope.detail = detail;
  }
  // بطاقة التغيير تُبنى من المدخلات المُتحقَّق منها فقط؛ مدخل مرفوض ⇒ `unavailable`
  // لا غياب، كي يبقى الزر مقفلاً بدل أن يُقرأ الغياب سماحاً.
  const change = CHANGE_TOOLS.has(tool)
    ? (inputOk && metadataOk ? buildChange(tool, request.input) : changeUnavailable('malformed'))
    : null;
  if (change) envelope.change = change;
  return envelope;
}

function build(req, ctx) {
  try { return buildChecked(req, ctx); }
  catch {
    return {
      v: 1,
      envelope_id: cleanText('', SHORT_LIMIT),
      engine: cleanText('', SHORT_LIMIT),
      project: cleanText('', SHORT_LIMIT),
      tool: { name: cleanText('', SHORT_LIMIT), label: cleanText('أداة غير معروفة', SHORT_LIMIT) },
      risk: 'unknown',
      summary: cleanText('طلب إذن غير معروف أو مشوّه', SUMMARY_LIMIT),
      created_at: 0,
      ttl_ms: 0,
    };
  }
}

module.exports = { build, buildChange, CHANGE_TOOLS, MAX_CHANGE_LINES };
