// <satr-memory-panel> — ذاكرة مشروع شخصية منفصلة عن المحادثة.
// الاقتراح لا يُحفظ إلا من زر «حفظ في الذاكرة» هنا. اللوحة تتيح البحث والتعديل والحذف،
// وتعرض تنبيه نقل المعرفة الجماعية إلى AGENTS.md أو Skill بدلاً من إبقائها شخصية.
import { sheet } from '../lib/sheet.js';
import { panelSheet } from '../lib/panel.css.js';

const ownSheet = sheet(`
  :host { width: 470px; }
  .candidate { padding: 13px; border-bottom: 1px solid var(--gold-border); background: var(--gold-soft); }
  .candidate[hidden] { display: none; }
  .candidate-title { color: var(--gold); font-weight: 700; margin-bottom: 8px; }
  .candidate-note, .status, .empty { color: var(--text-dim); font-size: 12px; line-height: 1.7; }
  .status { min-height: 21px; padding: 0 13px; color: var(--red); }
  .editor { display: grid; gap: 8px; }
  .editor-row { display: flex; gap: 7px; align-items: center; }
  .editor label { color: var(--text-dim); font-size: 11px; }
  .editor select, .editor textarea, .path-input {
    background: var(--bg); border: 1px solid var(--border); color: var(--text); border-radius: var(--radius-md);
    padding: 6px 9px; font-family: var(--sans); font-size: 12px; outline: none;
  }
  .editor select:focus, .editor textarea:focus, .path-input:focus { border-color: var(--gold); }
  .editor textarea { width: 100%; min-height: 82px; resize: vertical; unicode-bidi: plaintext; line-height: 1.6; }
  .editor select { min-width: 105px; }
  .path-input { flex: 1; min-width: 0; direction: ltr; font-family: var(--mono); }
  .share-row { display: flex; align-items: flex-start; gap: 7px; color: var(--text-dim); font-size: 12px; line-height: 1.5; }
  .share-row input { margin-top: 3px; accent-color: var(--gold); }
  .editor-actions { display: flex; gap: 7px; }
  .primary { border-color: var(--gold-border); color: var(--gold); }
  .danger { color: var(--red); }
  .memory { padding: 12px 14px; border-bottom: 1px solid var(--border); }
  .memory:hover { background: var(--surface-2); }
  .memory-head { display: flex; gap: 7px; align-items: center; flex-wrap: wrap; }
  .kind { color: var(--gold); font-size: 11px; font-weight: 700; }
  .badge { color: var(--text-dim); border: 1px solid var(--border); border-radius: var(--radius-sm); padding: 0 5px; font-size: 10px; }
  .memory-actions { display: flex; gap: 5px; margin-inline-start: auto; }
  .memory-actions button { padding: 2px 8px; font-size: 10.5px; }
  .content { margin-top: 7px; font-size: 13px; line-height: 1.7; white-space: pre-wrap; unicode-bidi: plaintext; }
  .meta { margin-top: 6px; color: var(--text-faint); font-size: 10.5px; line-height: 1.6; unicode-bidi: plaintext; }
  .scope-path { direction: ltr; font-family: var(--mono); }
  .share-hint { margin-top: 7px; color: var(--gold); font-size: 11px; line-height: 1.6; }
  .empty { padding: 24px 16px; text-align: center; }
`);

const KIND_LABELS = { fact: 'حقيقة', decision: 'قرار', command: 'أمر', failure: 'درس فشل' };
const CONFIDENCE_LABELS = { low: 'ثقة منخفضة', medium: 'ثقة متوسطة', high: 'ثقة عالية' };

class SatrMemoryPanel extends HTMLElement {
  constructor() {
    super();
    const root = this.attachShadow({ mode: 'open' });
    root.adoptedStyleSheets = [panelSheet, ownSheet];
    root.innerHTML =
      '<div class="panel-head"><span>ذاكرة المشروع</span><div class="panel-head-actions">' +
        '<button class="refresh" type="button">تحديث</button><button class="close" type="button" title="إغلاق">✕</button>' +
      '</div></div>' +
      '<div class="candidate" hidden><div class="candidate-title">اقتراح جديد — لم يُحفظ بعد</div>' +
        '<div class="candidate-note">راجعه وعدّله إن لزم، ثم وافق صراحةً على الحفظ أو ارفضه.</div><div class="candidate-editor"></div></div>' +
      '<div class="panel-search"><input class="search" type="text" placeholder="ابحث في الحقائق والقرارات والأوامر والفشل…"></div>' +
      '<div class="status" aria-live="polite"></div><div class="panel-list"></div>';
    this._candidateBox = root.querySelector('.candidate');
    this._candidateEditor = root.querySelector('.candidate-editor');
    this._list = root.querySelector('.panel-list');
    this._search = root.querySelector('.search');
    this._status = root.querySelector('.status');
    this._cwd = '';
    this._candidate = null;
    this._timer = null;
    root.querySelector('.close').addEventListener('click', () => this.close());
    root.querySelector('.refresh').addEventListener('click', () => this._load());
    this._search.addEventListener('input', () => {
      clearTimeout(this._timer);
      this._timer = setTimeout(() => this._load(), 180);
    });
  }

  close() { this.removeAttribute('open'); }

  _setStatus(text) {
    this._status.textContent = text || '';
  }

  _option(select, value, label, selected) {
    const option = document.createElement('option');
    option.value = value; option.textContent = label; option.selected = value === selected;
    select.appendChild(option);
  }

  _buildEditor(item, saveLabel, onSave, onCancel) {
    const editor = document.createElement('div'); editor.className = 'editor';
    const content = document.createElement('textarea'); content.dir = 'auto'; content.maxLength = 2000; content.value = item.content || '';
    const row = document.createElement('div'); row.className = 'editor-row';
    const kind = document.createElement('select');
    for (const [value, label] of Object.entries(KIND_LABELS)) this._option(kind, value, label, item.kind);
    const confidence = document.createElement('select');
    for (const [value, label] of Object.entries(CONFIDENCE_LABELS)) this._option(confidence, value, label, item.confidence);
    const scope = document.createElement('select');
    this._option(scope, 'project', 'المشروع كله', item.scope && item.scope.type);
    this._option(scope, 'path', 'مسار محدد', item.scope && item.scope.type);
    row.appendChild(kind); row.appendChild(confidence); row.appendChild(scope);
    const pathInput = document.createElement('input');
    pathInput.type = 'text'; pathInput.className = 'path-input'; pathInput.placeholder = 'src/path';
    pathInput.maxLength = 512; pathInput.value = item.scope && item.scope.path || '';
    const syncPath = () => { pathInput.hidden = scope.value !== 'path'; };
    scope.addEventListener('change', syncPath); syncPath();
    const shareLabel = document.createElement('label'); shareLabel.className = 'share-row';
    const share = document.createElement('input'); share.type = 'checkbox'; share.checked = item.shareable === true;
    const shareText = document.createElement('span');
    shareText.textContent = 'معرفة جماعية قابلة للمشاركة — اقترح نقلها إلى AGENTS.md أو Skill بعد المراجعة';
    shareLabel.appendChild(share); shareLabel.appendChild(shareText);
    const actions = document.createElement('div'); actions.className = 'editor-actions';
    const save = document.createElement('button'); save.type = 'button'; save.className = 'primary'; save.textContent = saveLabel;
    const cancel = document.createElement('button'); cancel.type = 'button'; cancel.textContent = onCancel ? 'إلغاء' : 'رفض الاقتراح';
    save.addEventListener('click', () => onSave({
      kind: kind.value,
      content: content.value.trim(),
      confidence: confidence.value,
      scope: { type: scope.value, path: pathInput.value.trim() },
      shareable: share.checked,
      source: item.source,
    }));
    cancel.addEventListener('click', () => {
      if (onCancel) onCancel(); else { this._candidate = null; this._renderCandidate(); this._setStatus('رُفض الاقتراح ولم يُكتب شيء.'); }
    });
    actions.appendChild(save); actions.appendChild(cancel);
    editor.appendChild(content); editor.appendChild(row); editor.appendChild(pathInput); editor.appendChild(shareLabel); editor.appendChild(actions);
    return editor;
  }

  _renderCandidate() {
    this._candidateBox.hidden = !this._candidate;
    this._candidateEditor.innerHTML = '';
    if (!this._candidate) return;
    this._candidateEditor.appendChild(this._buildEditor(this._candidate, 'حفظ في الذاكرة', async (value) => {
      this._setStatus('');
      const result = await window.satr.memorySave(this._cwd, value);
      if (!result || !result.ok) {
        this._setStatus(result && result.error === 'secret'
          ? 'رُفض الحفظ: المحتوى يشبه سراً أو مفتاحاً ولن يُخزّن.'
          : 'تعذّر حفظ الذاكرة: ' + ((result && result.error) || 'خطأ غير معروف'));
        return;
      }
      this._candidate = null;
      this._renderCandidate();
      this._setStatus('✓ حُفظت الذاكرة بعد موافقتك.');
      await this._load();
    }));
  }

  _renderItem(item) {
    const card = document.createElement('article'); card.className = 'memory';
    const head = document.createElement('div'); head.className = 'memory-head';
    const kind = document.createElement('span'); kind.className = 'kind'; kind.textContent = KIND_LABELS[item.kind] || item.kind;
    const confidence = document.createElement('span'); confidence.className = 'badge'; confidence.textContent = CONFIDENCE_LABELS[item.confidence] || item.confidence;
    const scope = document.createElement('span'); scope.className = 'badge' + (item.scope && item.scope.type === 'path' ? ' scope-path' : '');
    scope.textContent = item.scope && item.scope.type === 'path' ? item.scope.path : 'المشروع';
    const actions = document.createElement('div'); actions.className = 'memory-actions';
    const edit = document.createElement('button'); edit.type = 'button'; edit.textContent = 'تعديل';
    const remove = document.createElement('button'); remove.type = 'button'; remove.className = 'danger'; remove.textContent = 'حذف';
    actions.appendChild(edit); actions.appendChild(remove);
    head.appendChild(kind); head.appendChild(confidence); head.appendChild(scope); head.appendChild(actions);
    const content = document.createElement('div'); content.className = 'content'; content.dir = 'auto'; content.textContent = item.content;
    const meta = document.createElement('div'); meta.className = 'meta';
    const source = item.source && item.source.detail ? item.source.detail : (item.source && item.source.engine) || 'مصدر غير محدد';
    meta.textContent = 'المصدر: ' + source + ' · آخر تحديث: ' + new Date(item.updated_at).toLocaleString('ar-SA');
    card.appendChild(head); card.appendChild(content); card.appendChild(meta);
    if (item.shareable) {
      const hint = document.createElement('div'); hint.className = 'share-hint';
      hint.textContent = '↗ معرفة جماعية: انقلها صراحةً إلى AGENTS.md أو Skill بدلاً من إبقائها شخصية فقط.';
      card.appendChild(hint);
    }
    edit.addEventListener('click', () => {
      card.innerHTML = '';
      card.appendChild(this._buildEditor(item, 'حفظ التعديل', async (value) => {
        const result = await window.satr.memoryUpdate(this._cwd, item.id, value);
        if (!result || !result.ok) {
          this._setStatus(result && result.error === 'secret' ? 'رُفض التعديل لأنه يشبه سراً.' : 'تعذّر تعديل الذاكرة.');
          return;
        }
        this._setStatus('✓ حُفظ التعديل.'); await this._load();
      }, () => this._load()));
    });
    remove.addEventListener('click', async () => {
      if (!confirm('حذف هذه الذاكرة نهائياً؟')) return;
      const result = await window.satr.memoryDelete(this._cwd, item.id);
      if (!result || !result.ok) { this._setStatus('تعذّر حذف الذاكرة.'); return; }
      this._setStatus('حُذفت الذاكرة.'); await this._load();
    });
    return card;
  }

  async _load() {
    if (!this._cwd) return;
    this._list.innerHTML = '<div class="hint">جارٍ التحميل…</div>';
    let result;
    try { result = await window.satr.memoryList(this._cwd, this._search.value); }
    catch { result = null; }
    this._list.innerHTML = '';
    if (!result || !result.ok) { this._list.innerHTML = '<div class="empty">تعذّر قراءة ذاكرة المشروع.</div>'; return; }
    if (!result.items.length) {
      this._list.innerHTML = '<div class="empty">لا توجد ذاكرة مطابقة. لا يُحفظ شيء من المحادثة تلقائياً.</div>';
      return;
    }
    for (const item of result.items) this._list.appendChild(this._renderItem(item));
  }

  async open(cwd, candidate) {
    this._cwd = typeof cwd === 'string' ? cwd : '';
    if (candidate) this._candidate = candidate;
    this.setAttribute('open', '');
    this._renderCandidate();
    await this._load();
  }
}

customElements.define('satr-memory-panel', SatrMemoryPanel);
