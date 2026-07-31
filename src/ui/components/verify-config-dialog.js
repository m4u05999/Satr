// <satr-verify-config-dialog> — إنشاء .satr/verify.json يدوياً بلا اكتشاف أوامر.
// خطوتان صريحتان: تحرير ثم مراجعة؛ وجود ملف قائم يفرض تأكيد استبدال ثانياً.
import { sheet } from '../lib/sheet.js';
import { controlsSheet } from '../lib/panel.css.js';

const LIMITS = { commands: 6, id: 64, label: 120, command: 1000, timeout: 600, skillName: 64, description: 500, criteriaBytes: 16 * 1024 };
const REVIEW_SKILL_TEMPLATE = `# مهمة المراجعة النوعية

راجع التغيير المقترح وفق سياق هذا المشروع، ولا تنفّذ أوامر ولا تعدّل ملفات.

- افحص صحة السلوك والحالات الحدّية.
- افحص حدود الأمان والبيانات غير الموثوقة.
- افحص وضوح الحل وبساطته وقابليته للصيانة.
- اربط كل ملاحظة بملف أو دليل ظاهر، ولا تخمّن.

اختم بحكم موجز، ثم رتّب الملاحظات من الأعلى خطراً إلى الأدنى.`;

const ownSheet = sheet(`
  :host {
    position: fixed; inset: var(--space-0); display: none; align-items: center; justify-content: center;
    padding: var(--space-4); background: color-mix(in srgb, var(--bg) 72%, transparent); z-index: var(--z-modal);
  }
  :host([open]) { display: flex; }
  .box {
    width: min(48rem, 96vw); max-height: 90vh; overflow: auto;
    display: grid; gap: var(--space-3); padding: var(--space-4);
    border: 1px solid var(--gold-border); border-radius: var(--radius-xl);
    background: var(--surface-2); box-shadow: var(--shadow-modal);
  }
  h2, h3 { margin: var(--space-0); color: var(--gold); font-size: 1rem; }
  .intro, .path, .note, .message { margin: var(--space-0); line-height: 1.7; }
  .intro, .note { color: var(--text-dim); }
  .path, pre, .id, .command, .skill-name, .skill-path { direction: ltr; text-align: left; font-family: var(--mono); }
  .path { color: var(--text); }
  .rows { display: grid; gap: var(--space-3); }
  .row, .skill-step, .skill-review {
    display: grid; gap: var(--space-2); padding: var(--space-3);
    border: 1px solid var(--border); border-radius: var(--radius-lg); background: var(--surface);
  }
  .row-head, .actions { display: flex; align-items: center; gap: var(--space-2); flex-wrap: wrap; }
  .row-title { flex: 1; color: var(--gold); font-weight: 600; }
  .fields { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 2fr) minmax(7rem, .6fr); gap: var(--space-2); }
  label { display: grid; gap: var(--space-1); color: var(--text-dim); font-size: .75rem; }
  .command-field { grid-column: 1 / -1; }
  .skill-fields { display: grid; grid-template-columns: minmax(10rem, .8fr) minmax(0, 2fr); gap: var(--space-2); }
  .criteria-field { grid-column: 1 / -1; }
  .criteria { min-height: 12rem; unicode-bidi: plaintext; }
  .skill-path { color: var(--text-dim); font-size: .75rem; }
  input, textarea {
    width: 100%; box-sizing: border-box; padding: var(--space-2);
    border: 1px solid var(--border); border-radius: var(--radius-md);
    background: var(--bg); color: var(--text); font: inherit; outline: none;
  }
  textarea { min-height: calc(var(--space-7) + var(--space-4)); resize: vertical; }
  input:focus, textarea:focus { border-color: var(--gold); }
  .actions { justify-content: flex-end; }
  .actions .spacer { flex: 1; }
  .review[hidden], .editor[hidden], .skill-review[hidden] { display: none; }
  .review { display: grid; gap: var(--space-3); }
  pre {
    margin: var(--space-0); padding: var(--space-3); max-height: 42vh; overflow: auto;
    border: 1px solid var(--border); border-radius: var(--radius-lg);
    background: var(--bg); color: var(--text); white-space: pre-wrap; overflow-wrap: anywhere;
    unicode-bidi: plaintext;
  }
  .message { color: var(--red); }
  .message[data-kind="success"] { color: var(--green); }
  .danger { color: var(--red); border-color: var(--red); }
  @media (max-width: 42rem) {
    :host { padding: var(--space-2); }
    .box { padding: var(--space-3); }
    .fields { grid-template-columns: 1fr; }
    .skill-fields { grid-template-columns: 1fr; }
    .command-field { grid-column: auto; }
    .criteria-field { grid-column: auto; }
  }
`);

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

class SatrVerifyConfigDialog extends HTMLElement {
  constructor() {
    super();
    const root = this.attachShadow({ mode: 'open' });
    root.adoptedStyleSheets = [controlsSheet, ownSheet];
    const box = element('section', 'box'); box.setAttribute('role', 'dialog'); box.setAttribute('aria-modal', 'true');
    box.setAttribute('aria-label', 'إنشاء إعداد التحقق');
    box.appendChild(element('h2', '', 'إعداد التحقق التكاملي'));
    box.appendChild(element('p', 'intro', 'أدخل الأوامر يدوياً. لن يكتشف «سطر» أو يخمّن أي أمر من المشروع.'));
    this._path = element('p', 'path', '.satr/verify.json'); box.appendChild(this._path);

    this._editor = element('section', 'editor');
    this._rows = element('div', 'rows'); this._editor.appendChild(this._rows);
    this._skillStep = element('section', 'skill-step');
    this._skillStep.appendChild(element('h3', '', 'مهارة مراجعة نوعية — اختيارية'));
    this._skillStep.appendChild(element('p', 'note', 'عرّف مراجعة تناسب مشروعك. إدراج المرجع يعرضه أولاً داخل JSON، وإنشاء ملف المهارة يحتاج نقرة مستقلة بعد المراجعة.'));
    const skillFields = element('div', 'skill-fields');
    this._skillName = document.createElement('input'); this._skillName.className = 'skill-name';
    this._skillName.maxLength = LIMITS.skillName; this._skillName.dir = 'ltr';
    this._skillDescription = document.createElement('input'); this._skillDescription.className = 'skill-description';
    this._skillDescription.maxLength = LIMITS.description;
    this._skillCriteria = document.createElement('textarea'); this._skillCriteria.className = 'criteria';
    const skillField = (caption, input, className) => {
      const holder = element('label', className || ''); holder.appendChild(element('span', '', caption)); holder.appendChild(input); return holder;
    };
    skillFields.appendChild(skillField('اسم المهارة', this._skillName));
    skillFields.appendChild(skillField('الوصف', this._skillDescription));
    skillFields.appendChild(skillField('معايير المراجعة — نص عربي قابل للتحرير', this._skillCriteria, 'criteria-field'));
    this._skillStep.appendChild(skillFields);
    const skillActions = element('div', 'actions');
    this._includeSkill = element('button', 'include-skill', 'أدرج review_skill في JSON'); this._includeSkill.type = 'button';
    skillActions.appendChild(element('span', 'spacer')); skillActions.appendChild(this._includeSkill);
    this._skillStep.appendChild(skillActions); this._editor.appendChild(this._skillStep);
    const editorActions = element('div', 'actions');
    this._add = element('button', 'add', '＋ أضف أمراً'); this._add.type = 'button';
    this._cancel = element('button', 'cancel', 'إلغاء'); this._cancel.type = 'button';
    this._reviewButton = element('button', 'review-button', 'راجع JSON بلا مهارة'); this._reviewButton.type = 'button';
    editorActions.appendChild(this._add); editorActions.appendChild(element('span', 'spacer'));
    editorActions.appendChild(this._cancel); editorActions.appendChild(this._reviewButton);
    this._editor.appendChild(editorActions); box.appendChild(this._editor);

    this._review = element('section', 'review'); this._review.hidden = true;
    this._review.appendChild(element('p', 'note', 'راجع الملف أدناه. الكتابة لا تشغّل الأوامر، لكنها تعتمدها للتحقق لاحقاً بعد إضافتها إلى HEAD.'));
    this._preview = element('pre'); this._review.appendChild(this._preview);
    this._skillReview = element('section', 'skill-review'); this._skillReview.hidden = true;
    this._skillReview.appendChild(element('h3', '', 'ملف مهارة المراجعة'));
    this._skillPath = element('p', 'skill-path'); this._skillReview.appendChild(this._skillPath);
    this._skillReview.appendChild(element('p', 'note', 'هذا زر كتابة مستقل. لا يُنشأ الملف بمجرد إدراج review_skill في JSON.'));
    const createSkillActions = element('div', 'actions');
    this._createSkill = element('button', 'create-skill', 'أنشئ ملف المهارة'); this._createSkill.type = 'button';
    createSkillActions.appendChild(element('span', 'spacer')); createSkillActions.appendChild(this._createSkill);
    this._skillReview.appendChild(createSkillActions); this._review.appendChild(this._skillReview);
    const reviewActions = element('div', 'actions');
    this._back = element('button', 'back', 'رجوع للتعديل'); this._back.type = 'button';
    this._write = element('button', 'write', 'اكتب الملف'); this._write.type = 'button';
    reviewActions.appendChild(this._back); reviewActions.appendChild(element('span', 'spacer')); reviewActions.appendChild(this._write);
    this._review.appendChild(reviewActions); box.appendChild(this._review);

    this._message = element('p', 'message'); this._message.hidden = true; this._message.setAttribute('aria-live', 'polite');
    box.appendChild(this._message); root.appendChild(box);
    this._root = root;
    this._box = box;
    this._commandRows = [];
    this._cwd = '';
    this._reviewCommands = [];
    this._reviewSkill = null;
    this._overwriteRequired = false;
    this._skillOverwriteRequired = false;
    this._skillCreated = false;
    this._sending = false;
    this._add.addEventListener('click', () => this._addRow());
    this._cancel.addEventListener('click', () => this.close());
    this._reviewButton.addEventListener('click', () => this._showReview(false));
    this._includeSkill.addEventListener('click', () => this._showReview(true));
    this._back.addEventListener('click', () => this._showEditor());
    this._createSkill.addEventListener('click', () => this._writeSkill());
    this._write.addEventListener('click', () => this._writeConfig());
    root.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && !this._sending) { event.preventDefault(); this.close(); }
      else if (event.key === 'Tab') this._trapFocus(event);
    });
  }

  open(cwd) {
    if (typeof cwd !== 'string' || !cwd.trim()) return;
    this._cwd = cwd.trim();
    this._commandRows = [];
    this._rows.textContent = '';
    this._reviewCommands = [];
    this._reviewSkill = null;
    this._overwriteRequired = false;
    this._skillOverwriteRequired = false;
    this._skillCreated = false;
    this._sending = false;
    this._skillName.value = 'quality-review';
    this._skillDescription.value = 'يراجع جودة التغيير وفق معايير هذا المشروع قبل اعتماده.';
    this._skillCriteria.value = REVIEW_SKILL_TEMPLATE;
    this._setMessage('');
    this._showEditor();
    this._addRow({ id: 'test', label: 'الاختبارات', command: '', timeout_seconds: 120 });
    this.setAttribute('open', '');
    this.dispatchEvent(new CustomEvent('verify-dialog-visible', { bubbles: true, detail: true }));
    queueMicrotask(() => this._commandRows[0].command.focus());
  }

  close() {
    if (this._sending) return;
    this.removeAttribute('open');
    this.dispatchEvent(new CustomEvent('verify-dialog-visible', { bubbles: true, detail: false }));
  }

  _addRow(value) {
    if (this._commandRows.length >= LIMITS.commands) return;
    const row = element('section', 'row');
    const head = element('div', 'row-head');
    const title = element('span', 'row-title');
    const remove = element('button', 'remove', 'حذف'); remove.type = 'button';
    head.appendChild(title); head.appendChild(remove); row.appendChild(head);
    const fields = element('div', 'fields');
    const id = document.createElement('input'); id.className = 'id'; id.maxLength = LIMITS.id; id.dir = 'ltr';
    const label = document.createElement('input'); label.className = 'label'; label.maxLength = LIMITS.label;
    const timeout = document.createElement('input'); timeout.className = 'timeout'; timeout.type = 'number';
    timeout.min = '1'; timeout.max = String(LIMITS.timeout); timeout.step = '1';
    const command = document.createElement('textarea'); command.className = 'command'; command.maxLength = LIMITS.command;
    const field = (caption, input, className) => {
      const holder = element('label', className || ''); holder.appendChild(element('span', '', caption)); holder.appendChild(input); return holder;
    };
    fields.appendChild(field('المعرّف', id)); fields.appendChild(field('الاسم العربي', label));
    fields.appendChild(field('المهلة بالثواني', timeout)); fields.appendChild(field('الأمر — سطر واحد فقط', command, 'command-field'));
    row.appendChild(fields); this._rows.appendChild(row);
    const item = { row, title, remove, id, label, timeout, command };
    this._commandRows.push(item);
    const initial = value || {};
    id.value = initial.id || 'check-' + this._commandRows.length;
    label.value = initial.label || '';
    timeout.value = String(initial.timeout_seconds || 120);
    command.value = initial.command || '';
    remove.addEventListener('click', () => {
      if (this._commandRows.length <= 1) return;
      this._commandRows = this._commandRows.filter((candidate) => candidate !== item);
      row.remove(); this._syncRows();
    });
    this._syncRows();
  }

  _syncRows() {
    this._commandRows.forEach((item, index) => {
      item.title.textContent = 'أمر ' + (index + 1);
      item.remove.disabled = this._commandRows.length <= 1;
    });
    this._add.disabled = this._commandRows.length >= LIMITS.commands;
  }

  _collect() {
    const commands = [];
    const seen = new Set();
    for (const item of this._commandRows) {
      const id = item.id.value.trim();
      const label = item.label.value.trim();
      const command = item.command.value.trim();
      const timeout = Number(item.timeout.value);
      if (!/^[A-Za-z0-9_.:-]{1,64}$/.test(id) || seen.has(id)) return { error: 'استخدم معرّفاً فريداً بحروف لاتينية أو أرقام أو . _ : -.' };
      if (!label || label.length > LIMITS.label || /[\u0000-\u001F\u007F]/.test(label)) return { error: 'اكتب اسماً عربياً صالحاً لكل أمر.' };
      if (!command || command.length > LIMITS.command || /[\r\n\0]/.test(command)) return { error: 'كل أمر مطلوب في سطر واحد بطول لا يتجاوز 1000 محرف.' };
      if (!Number.isInteger(timeout) || timeout < 1 || timeout > LIMITS.timeout) return { error: 'المهلة يجب أن تكون عدداً صحيحاً بين 1 و600 ثانية.' };
      seen.add(id); commands.push({ id, label, command, timeout_seconds: timeout });
    }
    return { commands };
  }

  _collectReviewSkill() {
    const name = this._skillName.value.trim();
    const description = this._skillDescription.value.trim();
    const criteria = this._skillCriteria.value.trim();
    if (!/^[A-Za-z0-9._-]{1,64}$/.test(name) || name === '.' || name === '..') return { error: 'اسم المهارة يجب أن يكون بحروف لاتينية أو أرقام أو . _ - فقط.' };
    if (!description || Array.from(description).length > LIMITS.description || /[\u0000-\u001F\u007F\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069]/.test(description)) {
      return { error: 'اكتب وصفاً صالحاً بلا محارف تحكم.' };
    }
    if (!criteria || new TextEncoder().encode(criteria).length > LIMITS.criteriaBytes
        || /[\u0000-\u0009\u000B-\u001F\u007F\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069]/.test(criteria)) {
      return { error: 'معايير المراجعة مطلوبة، بلا محارف تحكم، وبحجم لا يتجاوز 16KiB.' };
    }
    return { skill: { name, description, criteria } };
  }

  _showReview(includeSkill) {
    const collected = this._collect();
    if (collected.error) { this._setMessage(collected.error); return; }
    const skill = includeSkill ? this._collectReviewSkill() : { skill: null };
    if (skill.error) { this._setMessage(skill.error); return; }
    this._reviewCommands = collected.commands;
    this._reviewSkill = skill.skill;
    this._overwriteRequired = false;
    this._skillOverwriteRequired = false;
    this._skillCreated = false;
    this._write.textContent = 'اكتب الملف'; this._write.classList.remove('danger');
    this._createSkill.textContent = 'أنشئ ملف المهارة'; this._createSkill.classList.remove('danger');
    this._skillReview.hidden = !this._reviewSkill;
    this._createSkill.disabled = !this._reviewSkill;
    this._skillPath.textContent = this._reviewSkill ? '.agents/skills/' + this._reviewSkill.name + '/SKILL.md' : '';
    const preview = { version: 1, commands: this._reviewCommands };
    if (this._reviewSkill) preview.review_skill = { name: this._reviewSkill.name };
    this._preview.textContent = JSON.stringify(preview, null, 2);
    this._editor.hidden = true; this._review.hidden = false; this._setMessage('');
    this._write.focus();
  }

  _showEditor() {
    if (this._sending) return;
    this._review.hidden = true; this._editor.hidden = false; this._setMessage('');
  }

  async _writeConfig() {
    if (this._sending || !this._reviewCommands.length) return;
    this._sending = true; this._setBusy(true); this._setMessage('');
    let result = null;
    try {
      const reviewSkill = this._reviewSkill ? { name: this._reviewSkill.name } : null;
      result = await window.satr.verifyConfigCreate(this._cwd, this._reviewCommands, this._overwriteRequired, true, reviewSkill);
    } catch {}
    this._sending = false; this._setBusy(false);
    if (result && result.ok) {
      const overwritten = result.overwritten === true;
      this.dispatchEvent(new CustomEvent('verify-config-created', { bubbles: true, detail: result }));
      this.dispatchEvent(new CustomEvent('notice', { bubbles: true, detail: overwritten
        ? 'استُبدل .satr/verify.json. راجعه وأضفه إلى Git قبل بدء الدمج.'
        : 'أُنشئ .satr/verify.json. راجعه وأضفه إلى Git قبل بدء الدمج.' }));
      this.close(); return;
    }
    if (result && result.error === 'exists' && !this._overwriteRequired) {
      this._overwriteRequired = true;
      this._write.textContent = 'استبدل الملف القائم'; this._write.classList.add('danger');
      this._setMessage('الملف موجود. راجع المحتوى، ثم اضغط «استبدل الملف القائم» لتأكيد الاستبدال صراحةً.');
      return;
    }
    const labels = {
      bad_input: 'رفضت العملية الرئيسية المدخلات.', bad_cwd: 'مجلد المشروع غير صالح.',
      symlink: 'رُفض المسار لأنه رابط رمزي.', outside: 'رُفض مسار يخرج من مجلد المشروع.',
      bad_command: 'أحد الأوامر غير صالح.', bad_label: 'أحد الأسماء غير صالح.',
      bad_timeout: 'إحدى المهل خارج النطاق.', write_failed: 'تعذّرت كتابة الملف بأمان.',
    };
    this._setMessage(labels[result && result.error] || 'تعذّر إنشاء ملف التحقق.');
  }

  async _writeSkill() {
    if (this._sending || !this._reviewSkill || this._skillCreated) return;
    this._sending = true; this._setBusy(true); this._setMessage('');
    let result = null;
    try {
      result = await window.satr.reviewSkillCreate(this._cwd, this._reviewSkill, this._skillOverwriteRequired, true);
    } catch {}
    this._sending = false; this._setBusy(false);
    if (result && result.ok) {
      this._skillCreated = true;
      this._createSkill.textContent = result.overwritten === true ? 'استُبدل ملف المهارة' : 'أُنشئ ملف المهارة';
      this._createSkill.classList.remove('danger'); this._createSkill.disabled = true;
      this.dispatchEvent(new CustomEvent('notice', { bubbles: true, detail: result.overwritten === true
        ? 'استُبدل ملف مهارة المراجعة. راجعه وأضفه إلى Git.'
        : 'أُنشئ ملف مهارة المراجعة. راجعه وأضفه إلى Git.' }));
      this._setMessage('اكتملت كتابة ملف المهارة. ما زال verify.json ينتظر زر الكتابة المستقل.', 'success');
      return;
    }
    if (result && result.error === 'exists' && !this._skillOverwriteRequired) {
      this._skillOverwriteRequired = true;
      this._createSkill.textContent = 'استبدل ملف المهارة القائم'; this._createSkill.classList.add('danger');
      this._setMessage('ملف المهارة موجود. اضغط «استبدل ملف المهارة القائم» لتأكيد الاستبدال صراحةً.');
      return;
    }
    const labels = {
      confirmation_required: 'لم يصل تأكيد صريح لإنشاء المهارة.', bad_input: 'رفضت العملية الرئيسية المدخلات.',
      bad_cwd: 'مجلد المشروع غير صالح.', bad_skill: 'بيانات المهارة غير صالحة.', bad_name: 'اسم المهارة غير صالح.',
      bad_description: 'وصف المهارة غير صالح.', bad_criteria: 'معايير المراجعة غير صالحة أو تتجاوز السقف.',
      secret: 'رُفضت المعايير لأنها تبدو محتوية على سر.', symlink: 'رُفض المسار لأنه رابط رمزي أو junction.',
      outside: 'رُفض مسار يخرج من مجلد المشروع.', unsafe_target: 'هدف المهارة القائم غير آمن.',
      write_failed: 'تعذّرت كتابة ملف المهارة بأمان.',
    };
    this._setMessage(labels[result && result.error] || 'تعذّر إنشاء ملف مهارة المراجعة.');
  }

  _setBusy(busy) {
    for (const button of [this._add, this._cancel, this._reviewButton, this._includeSkill, this._back, this._write, this._createSkill]) button.disabled = busy;
    if (!busy) {
      this._syncRows();
      this._createSkill.disabled = !this._reviewSkill || this._skillCreated;
    }
  }

  _setMessage(message, kind) {
    this._message.textContent = message || '';
    this._message.hidden = !message;
    if (kind) this._message.dataset.kind = kind;
    else delete this._message.dataset.kind;
  }

  _trapFocus(event) {
    const items = [...this._root.querySelectorAll('input, textarea, button:not(:disabled)')].filter((item) => !item.closest('[hidden]'));
    if (!items.length) return;
    const current = items.indexOf(this._root.activeElement);
    const next = event.shiftKey ? items[(current <= 0 ? items.length : current) - 1] : items[(current + 1) % items.length];
    event.preventDefault(); next.focus();
  }
}

customElements.define('satr-verify-config-dialog', SatrVerifyConfigDialog);
