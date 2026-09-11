// توصيلات المشروع داخل لوحة MCP القائمة؛ الأسرار ترسل مباشرة إلى main ثم تمحى من الحقل.
import { sheet } from '../lib/sheet.js';
import { textDir } from '../lib/text-dir.js';

export const connectionSheet = sheet(`
  .connection-intro, .connection-card { padding: var(--space-3) var(--space-4); border-bottom: 1px solid var(--border); }
  .connection-card { display: grid; gap: var(--space-2); }
  .connection-card h3 { font-size: 14px; color: var(--text); }
  .connection-card p, .connection-intro p { color: var(--text-dim); font-size: 12px; line-height: 1.8; overflow-wrap: anywhere; }
  .connection-technical { direction: ltr; unicode-bidi: isolate; font-family: var(--mono); }
  .connection-card .connection-error { color: var(--red); }
  .connection-card .connection-success { color: var(--green); }
  .connection-actions { display: flex; flex-wrap: wrap; gap: var(--space-2); }
  .connection-form { display: grid; gap: var(--space-2); min-width: 0; }
  .connection-form label { font-size: 12px; color: var(--text); line-height: 1.8; }
  .connection-form input[type=password], .connection-form select { width: 100%; min-width: 0; background: var(--bg); color: var(--text); border: 1px solid var(--border); border-radius: var(--radius-md); padding: var(--space-2); font-family: var(--sans); font-size: 13px; }
  .connection-form input:focus-visible, .connection-form select:focus-visible { outline: 2px solid var(--gold); outline-offset: 1px; }
  .connection-form input[type=password] { direction: ltr; font-family: var(--mono); }
  .connection-card button:disabled { cursor: wait; }
  .connection-check { display: flex; align-items: start; gap: var(--space-2); }
  .connection-check input { margin-top: var(--space-1); }
  .connection-legacy summary { padding: var(--space-3) var(--space-4); font-size: 12px; color: var(--text); cursor: pointer; }
`);

const LABELS = { github: 'GitHub', netlify: 'Netlify', supabase: 'Supabase' };
const ENGINE_NAMES = { sdk: 'Claude', codex: 'Codex', 'kimi-code': 'Kimi Code' };
const LINKS = {
  github: 'https://github.com/settings/personal-access-tokens/new',
  netlify: 'https://app.netlify.com/user/applications#personal-access-tokens',
  supabase: 'https://supabase.com/dashboard/account/tokens',
};
const GUIDES = {
  github: 'أنشئ رمز Fine-grained واختر مستودعاً واحداً. اجعل Metadata وContents وIssues للقراءة؛ كتابة Issues مطلوبة فقط إذا أردت إنشاء قضايا من المحادثة.',
  netlify: 'اربط رمز وصول شخصياً من حسابك. اختر موقعاً واحداً هنا؛ تشغيل البناء قد ينشر إلى الموقع ويحتاج إذناً في كل مرة.',
  supabase: 'أنشئ رمز وصول لحسابك بصلاحية قراءة إعدادات المشروع وقاعدة البيانات. اختر المشروع المسموح هنا؛ الاستعلامات المتاحة للقراءة فقط.',
};
const ERRORS = {
  bad_cwd: 'اختر مجلد المشروع أولاً.', bad_input: 'تحقق من البيانات المطلوبة.',
  auth_expired: 'انتهت المصادقة أو لم يعد الرمز صالحاً. أعد المصادقة.',
  needs_auth: 'يلزم إعادة المصادقة.', forbidden: 'الحساب لا يملك الصلاحية المطلوبة لهذا المورد.',
  not_found: 'المورد غير متاح لهذا الحساب.', resource_denied: 'هذا المورد غير مسموح في المشروع.',
  disconnected: 'الاتصال مفصول.', no_connection: 'اربط الخدمة أولاً.',
  encryption_unavailable: 'التشفير غير متاح؛ لم يحفظ الرمز.', encryption_failed: 'تعذر تشفير الرمز؛ لم يحفظ.',
  storage_unavailable: 'تعذر فتح مخزن التوصيلات المشفر.', storage_error: 'تعذر حفظ الاتصال المشفر.',
  network: 'تعذر الوصول إلى الخدمة. أعد المحاولة.', invalid_response: 'أعادت الخدمة استجابة غير صالحة.',
  stale_connection: 'تغير الاتصال أثناء الطلب. حدّث اللوحة وأعد المحاولة.',
  cancelled: 'ألغي الطلب.', unsupported: 'هذه العملية غير مدعومة.',
  bad_token: 'رمز الوصول غير صالح.', bad_resource: 'المورد غير محدد أو غير مسموح في المشروع.',
  bad_permissions: 'الصلاحيات المختارة غير صالحة.', not_connected: 'اربط الخدمة أولاً.',
  connection_changed: 'تغير الاتصال أثناء الطلب. حدّث اللوحة وأعد المحاولة.',
  storage_busy: 'تعذّر حجز مخزن التوصيلات؛ لم يُحفظ التغيير.',
  service_failed: 'تعذر إكمال طلب الخدمة. تحقق من الشبكة والصلاحيات.',
  permission_denied: 'لم تمنح موافقة على هذا الفعل.', inactive: 'انتهى الدور قبل اكتمال الطلب.',
};
function element(tag, text, cls) {
  const el = document.createElement(tag);
  if (text !== undefined) { el.textContent = text; el.dir = textDir(String(text)) || 'rtl'; }
  if (cls) el.className = cls;
  return el;
}
function button(label, action) {
  const el = element('button', label); el.type = 'button'; el.addEventListener('click', action); return el;
}
function stamp(value) {
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toLocaleString('ar-SA') : '';
}
export class ConnectionView {
  constructor(host, onPreview) { this.host = host; this.onPreview = onPreview; this.seq = 0; }
  close() {
    this.seq++;
    this.host.querySelectorAll('input[type=password]').forEach((el) => { el.value = ''; });
  }
  async open(cwd, engine) {
    this.cwd = cwd; this.engine = engine;
    const seq = ++this.seq;
    this.host.replaceChildren(element('p', 'جارٍ قراءة توصيلات المشروع…', 'hint'));
    let result;
    try { result = await window.satr.connectionList(cwd, engine); } catch { result = { error: 'storage_unavailable' }; }
    if (seq !== this.seq) return;
    this.host.replaceChildren();
    const intro = element('div', undefined, 'connection-intro');
    intro.append(element('p', 'التوصيلات الأساسية مجانية. كل حساب ومورد وصلاحية تخص هذا المشروع وحده.'), element('p', 'المشروع الحالي:'));
    const projectPath = element('p', cwd || 'لم يختر مجلد', cwd ? 'connection-technical' : '');
    if (cwd) projectPath.dir = 'ltr';
    intro.append(projectPath);
    this.host.append(intro);
    if (!result || !result.ok) { intro.append(element('p', ERRORS[result && result.error] || 'تعذر قراءة التوصيلات.')); return; }
    if (engine === 'cli') intro.append(element('p', 'محرك Claude CLI الاحتياطي لا يدعم أدوات توصيلات سطر. اختر محركاً يدعم الأدوات لاستخدامها.'));
    else if (!ENGINE_NAMES[engine]) intro.append(element('p', 'إتاحة الأدوات تعتمد على دعم المزوّد. نجاح المصادقة لا يثبت أن هذا المحرك استعمل الاتصال.'));
    for (const service of result.services || []) this.host.append(this.card(service, seq));
  }
  card(service, seq) {
    const box = element('section', undefined, 'connection-card');
    box.dataset.service = service.id;
    box.append(element('h3', LABELS[service.id] || service.label));
    const authenticated = service.authStatus === 'authenticated';
    const authText = authenticated ? 'الحساب مصادق عليه' : service.authStatus === 'needs-auth' ? 'يحتاج إعادة المصادقة' : service.authStatus === 'unavailable' ? 'التخزين المشفر غير متاح' : 'لم يربط حساب';
    box.append(element('p', 'المصادقة: ' + authText));
    if (service.account) box.append(element('p', 'الحساب: ' + service.account.label));
    box.append(element('p', 'المورد المسموح: ' + (service.resource ? (service.resource.label !== service.resource.id ? service.resource.label : '') : 'لم يحدد')));
    if (service.resource) {
      // المعرّف التقني كتلة مستقلة كي لا تعيد العربية ترتيب مقاطعه عند الالتفاف.
      const resourceId = element('p', service.resource.id, 'connection-technical');
      resourceId.dir = 'ltr'; box.append(resourceId);
    }
    if (service.resource) box.append(element('p', 'الصلاحيات: ' + (service.permissions && service.permissions.includes('write') ? 'قراءة، وأفعال كتابة بإذن لكل مرة' : 'قراءة فقط')));
    if (service.lastTest) box.append(element('p', 'اختبار الخدمة: ' + (service.lastTest.ok ? 'نجح' : 'تعذر') + ' — ' + stamp(service.lastTest.at)));
    else box.append(element('p', 'اختبار الخدمة: لم ينفذ بعد.'));
    if (service.lastEngineUse) {
      const use = service.lastEngineUse;
      box.append(element('p', 'آخر استخدام من المحرك: ' + (ENGINE_NAMES[use.engine] || use.engine) + ' — ' + stamp(use.at)));
      if (use.engine !== this.engine) box.append(element('p', 'لم يثبت هذا السجل الاستخدام بالمحرك المحدد حالياً.'));
    } else box.append(element('p', 'الاستخدام من المحادثة: لم يسجل بعد. نجاح اختبار الخدمة وحده لا يثبته.'));
    const actions = element('div', undefined, 'connection-actions');
    const body = element('div', undefined, 'connection-form');
    const message = element('p', '', 'connection-message'); message.setAttribute('role', 'status');
    actions.append(button(authenticated ? 'إعادة المصادقة' : 'ربط برمز شخصي', () => this.authForm(service, body, box, message, seq)));
    if (authenticated) actions.append(button('تحديد المورد والصلاحيات', () => this.resourceForm(service, body, box, message, seq)));
    if (authenticated && service.resource) actions.append(button('اختبار قراءة فعلية', () => this.perform(box, message, seq, () => window.satr.connectionTest(this.cwd, service.id), 'نجح اختبار الخدمة. اطلب قراءة المورد من المحادثة لإثبات استخدام المحرك.')));
    if (service.account || service.authStatus === 'needs-auth' || service.authStatus === 'unavailable') actions.append(button('فصل الاتصال', () => {
      if (!window.confirm('تفصل توصيلات سطر لهذه الخدمة عن المشروع الحالي. لا يلغي ذلك الرمز عند الخدمة نفسها. هل تفصل الاتصال؟')) return;
      return this.perform(box, message, seq, () => window.satr.connectionDisconnect(this.cwd, service.id), 'فصل الاتصال عن هذا المشروع.');
    }));
    box.append(actions, body, message);
    return box;
  }
  async perform(box, message, seq, action, success) {
    if (seq !== this.seq) return;
    box.querySelectorAll('button').forEach((el) => { el.disabled = true; });
    message.textContent = 'جارٍ تنفيذ الطلب…'; message.dir = 'rtl'; message.className = 'connection-message';
    let result;
    try { result = await action(); } catch { result = { error: 'network' }; }
    if (seq !== this.seq) return;
    if (result && result.ok) {
      const id = box.dataset.service;
      const refreshedSeq = this.seq + 1;
      await this.open(this.cwd, this.engine);
      if (this.seq !== refreshedSeq) return;
      const target = this.host.querySelector('[data-service="' + id + '"] .connection-message');
      if (target) { target.textContent = success; target.dir = textDir(success) || 'rtl'; target.className = 'connection-message connection-success'; }
    } else {
      message.textContent = ERRORS[result && result.error] || 'تعذر تنفيذ الطلب. حدّث اللوحة وتحقق من الاتصال.';
      message.dir = textDir(message.textContent) || 'rtl'; message.className = 'connection-message connection-error';
      box.querySelectorAll('button').forEach((el) => { el.disabled = false; });
    }
  }
  authForm(service, body, box, message, seq) {
    body.replaceChildren(element('p', GUIDES[service.id]));
    body.append(button('فتح صفحة رمز الوصول', () => this.onPreview(LINKS[service.id])));
    const label = element('label', 'رمز الوصول الشخصي — لا تكتبه في المحادثة');
    const input = document.createElement('input'); input.type = 'password'; input.maxLength = 8192;
    input.autocomplete = 'off'; input.spellcheck = false; input.setAttribute('aria-label', 'رمز الوصول الشخصي');
    const id = 'connection-token-' + service.id; input.id = id; label.htmlFor = id;
    body.append(label, input, button('تحقق من الحساب واحفظ مشفراً', () => {
      const value = input.value; input.value = '';
      return this.perform(box, message, seq, () => window.satr.connectionAuthenticate(this.cwd, service.id, value), 'تم التحقق من الحساب. حدد المورد والصلاحيات ثم اختبر الاتصال.');
    }));
    input.focus();
  }
  async resourceForm(service, body, box, message, seq) {
    body.replaceChildren(element('p', 'جارٍ قراءة الموارد المتاحة لهذا الحساب…'));
    const cwd = this.cwd;
    let result;
    try { result = await window.satr.connectionResources(cwd, service.id); } catch { result = { error: 'network' }; }
    if (seq !== this.seq) return;
    body.replaceChildren();
    if (!result || !result.ok) { body.append(element('p', ERRORS[result && result.error] || 'تعذر سرد الموارد.')); return; }
    if (!result.resources || !result.resources.length) { body.append(element('p', 'لا توجد موارد متاحة. تحقق من صلاحيات الرمز أو موافقة المؤسسة.')); return; }
    if (result.truncated) body.append(element('p', 'القائمة محدودة وليست كل موارد الحساب. استخدم رمزاً أضيق إذا لم يظهر المورد.'));
    const label = element('label', 'اختر مورداً واحداً يسمح لهذا المشروع بالوصول إليه');
    const select = document.createElement('select'); select.dir = 'ltr'; select.id = 'connection-resource-' + service.id; label.htmlFor = select.id;
    for (const resource of result.resources) { const option = element('option', resource.label + ' (' + resource.id + ')'); option.value = resource.id; select.append(option); }
    if (service.resource && result.resources.some((r) => r.id === service.resource.id)) select.value = service.resource.id;
    body.append(label, select);
    const write = document.createElement('input'); write.type = 'checkbox'; write.checked = !!(service.permissions && service.permissions.includes('write'));
    if (service.id !== 'supabase') {
      const check = element('label', undefined, 'connection-check');
      check.append(write, element('span', service.id === 'github' ? 'السماح بإنشاء قضايا بعد إذن مستقل' : 'السماح بتشغيل بناء قد ينشر الموقع بعد إذن مستقل'));
      body.append(check);
    }
    body.append(button('حفظ المورد والصلاحيات', () => this.perform(box, message, seq,
      () => window.satr.connectionSelect(cwd, service.id, select.value, write.checked && service.id !== 'supabase' ? ['read', 'write'] : ['read']),
      'حفظ المورد لهذا المشروع. نفذ اختبار القراءة ثم استخدمه من المحادثة.')));
  }
}
