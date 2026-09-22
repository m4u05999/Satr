// <satr-saved-tasks-panel> — تعريف المهام المحفوظة وتشغيل محاولاتها ومراجعة تاريخها.
import { sheet } from '../lib/sheet.js';
import { panelSheet } from '../lib/panel.css.js';
import { applyDir } from '../lib/text-dir.js';
import { renderRunEvent } from '../lib/run-event-renderer.js';

const ownSheet = sheet(`
  :host { width: min(720px, 58vw); min-width: 360px; }
  .layout { display: grid; grid-template-columns: minmax(190px, .72fr) minmax(300px, 1.28fr); min-height: 0; flex: 1; }
  .tasks { border-inline-end: 1px solid var(--border); overflow: auto; }
  .workspace { overflow: auto; padding: var(--space-3); }
  .toolbar, .actions, .criteria-head, .run-head { display:flex; gap:var(--space-2); align-items:center; flex-wrap:wrap; }
  .toolbar { padding: var(--space-2); border-bottom:1px solid var(--border-dim); }
  button, input, textarea, select { font: inherit; }
  button { border:1px solid var(--border); background:var(--surface-2); color:var(--text); border-radius:var(--radius-sm); padding:var(--space-1) var(--space-2); cursor:pointer; }
  button.primary { background:var(--gold); color:var(--on-gold); border-color:var(--gold); font-weight:700; }
  button.danger { color:var(--red); }
  button:disabled { opacity:.5; cursor:not-allowed; }
  .task { display:block; width:100%; text-align:start; border:0; border-bottom:1px solid var(--border-dim); border-radius:0; padding:var(--space-2) var(--space-3); }
  .task[aria-current="true"] { background:var(--gold-soft); }
  .task-title { font-weight:700; }
  .meta, .hint, .status { color:var(--text-dim); font-size:12px; }
  .empty, .error { padding:var(--space-4); color:var(--text-dim); }
  .error { color:var(--red); }
  form { display:grid; gap:var(--space-3); }
  label { display:grid; gap:var(--space-1); font-size:12px; color:var(--text-dim); }
  input, textarea, select { box-sizing:border-box; width:100%; border:1px solid var(--border); border-radius:var(--radius-sm); background:var(--bg); color:var(--text); padding:var(--space-2); }
  textarea { min-height:120px; resize:vertical; }
  .criterion { border:1px solid var(--border); border-radius:var(--radius-md); padding:var(--space-2); display:grid; gap:var(--space-2); }
  .criterion-grid { display:grid; grid-template-columns:1fr 150px; gap:var(--space-2); }
  .approval, .run-card, .report { margin-top:var(--space-3); border:1px solid var(--border); border-radius:var(--radius-md); padding:var(--space-3); }
  .approval { border-color:var(--gold); }
  .tech { direction:ltr; unicode-bidi:embed; font-family:var(--mono); text-align:left; overflow-wrap:anywhere; }
  .project-label, .setting-line { direction:rtl; text-align:start; }
  .project-path, .setting-model { display:inline; direction:ltr; unicode-bidi:isolate; font-family:var(--mono); }
  .snapshot { margin:var(--space-2) 0; padding:var(--space-2); background:var(--bg); border-radius:var(--radius-sm); }
  .check { border-top:1px solid var(--border-dim); padding-top:var(--space-2); margin-top:var(--space-2); }
  .verdict { font-weight:700; }
  .passed { color:var(--green); } .failed { color:var(--red); }
  .not_checked, .needs_review { color:var(--text-dim); }
  .transcript { display:block; margin-top:var(--space-3); min-height:120px; max-height:360px; overflow:auto; }
  .history { margin-top:var(--space-4); }
  .history-item { width:100%; display:flex; justify-content:space-between; text-align:start; margin-top:var(--space-1); }
  .report-event { padding:var(--space-2) 0; border-bottom:1px solid var(--border-dim); white-space:pre-wrap; overflow-wrap:anywhere; }
  [hidden] { display:none !important; }
  @media (max-width: 760px) { :host { width:100%; min-width:0; } .layout { grid-template-columns:1fr; } .tasks { max-height:180px; border-inline-end:0; border-bottom:1px solid var(--border); } }
`);

const ERROR_TEXT = {
  feature_unavailable: 'المهام المحفوظة غير متاحة في هذه النسخة.',
  license_required: 'انتهى الاستحقاق؛ تبقى القراءة والإيقاف وإعادة حفظ النتيجة متاحة.',
  not_entitled: 'انتهى الاستحقاق؛ يمكنك قراءة السجل وإيقاف العمل الجاري، لكن لا يمكن تعديل المهام أو بدء محاولة جديدة.',
  project_required: 'اختر مجلد المشروع أولاً عبر زر المجلد.',
  revision_conflict: 'تغيّرت النسخة المحفوظة. أُعيد تحميلها وبقيت مسودتك في الحقول.',
  approval_invalid: 'انتهت الموافقة أو تغيّر التعريف. راجع اللقطة الجديدة ثم وافق صراحة.',
  busy: 'توجد محاولة محجوزة لهذه المهمة.',
  task_busy: 'توجد محاولة محجوزة لهذه المهمة.',
  storage_pending: 'انتهى التنفيذ لكن حفظ النتيجة يحتاج إعادة المحاولة.',
  completion_unknown: 'لا يوجد إثبات موثوق لانتهاء المحرك؛ يلزم حسم يدوي.',
  manual_recovery_required: 'المحاولة منقطعة أو مجهولة وتحتاج حسم استعادة يدوي.',
  not_found: 'لم يُعثر على السجل المطلوب.',
  bad_report: 'تعذّرت قراءة التقرير بأمان.',
  read_failed: 'تعذّرت قراءة التقرير بأمان.',
  ipc_failed: 'تعذّر الاتصال بالجزء المسؤول عن المهام.',
  unsaved_changes: 'احفظ التعديلات قبل التشغيل.',
};
const FINAL = new Set(['finished', 'failed', 'cancelled']);
const STATE_TEXT = { starting:'يبدأ', running:'جارٍ', stop_requested:'طُلب إيقافه', finished:'انتهى التنفيذ',
  failed:'فشل التنفيذ', cancelled:'أُلغي', interrupted:'منقطع', unknown:'غير معلوم', storage_pending:'الحفظ معلّق' };
const VERDICT_TEXT = { passed:'اجتاز', failed:'لم يجتز', not_checked:'لم يُفحص', needs_review:'ينتظر مراجعتك' };
const SOURCE_TEXT = { human:'مراجعة بشرية', verify:'تحقق آلي' };
function errorText(code) { return ERROR_TEXT[code] || 'تعذّر تنفيذ العملية بأمان. حاول التحديث ثم أعد المحاولة.'; }
function fmtTime(value) { return Number.isFinite(value) ? new Date(value).toLocaleString('ar-SA') : '—'; }
function criterionId() {
  const bytes = new Uint8Array(8); crypto.getRandomValues(bytes);
  return 'criterion_' + [...bytes].map((n) => n.toString(16).padStart(2, '0')).join('');
}
function exactOwner(left, right) {
  return !!left && !!right && left.project_id === right.project_id
    && left.task_id === right.task_id && left.run_id === right.run_id;
}

class SatrSavedTasksPanel extends HTMLElement {
  constructor() {
    super();
    const root = this.attachShadow({ mode: 'open' });
    root.adoptedStyleSheets = [panelSheet, ownSheet];
    root.innerHTML =
      '<div class="panel-head"><span>المهام المحفوظة</span><span class="panel-head-actions"><button class="refresh">تحديث</button><button class="close" aria-label="إغلاق">✕</button></span></div>' +
      '<div class="toolbar"><button class="new primary">مهمة جديدة</button><label><input class="show-archived" type="checkbox"> المؤرشفة</label><span class="entitlement status"></span></div>' +
      '<div class="layout"><aside class="tasks"><div class="task-list"></div><button class="more" hidden>المزيد</button></aside>' +
      '<main class="workspace"><div class="message hint">اختر مهمة أو أنشئ مهمة جديدة.</div><section class="editor" hidden>' +
      '<form><div class="saved-context"><div class="project-label"></div><div class="meta">المحرك: Codex</div></div><label>العنوان<input class="title" maxlength="120"></label><label>التعليمات<textarea class="instructions"></textarea></label>' +
      '<div class="criterion-grid"><label>النموذج<select class="model"></select></label><label>جهد التفكير<select class="effort"></select></label></div>' +
      '<div class="criteria-head"><strong>معايير القبول</strong><button type="button" class="add-criterion">إضافة معيار</button></div><div class="criteria"></div>' +
      '<div class="actions"><button type="submit" class="save primary">حفظ</button><button type="button" class="run">تشغيل الآن</button><button type="button" class="archive danger">أرشفة</button></div></form>' +
      '<div class="approval" hidden></div><div class="active-run"></div><section class="history"><div class="run-head"><strong>سجل المحاولات</strong><button class="more-runs" hidden>المزيد</button></div><div class="run-list"></div><div class="run-detail"></div></section>' +
      '</section></main></div>';
    this._root = root;
    this._list = root.querySelector('.task-list');
    this._editor = root.querySelector('.editor');
    this._message = root.querySelector('.message');
    this._criteria = root.querySelector('.criteria');
    this._approval = root.querySelector('.approval');
    this._active = root.querySelector('.active-run');
    this._runList = root.querySelector('.run-list');
    this._runDetail = root.querySelector('.run-detail');
    this._task = null;
    this._tasks = [];
    this._taskCursor = 0;
    this._runCursor = 0;
    this._catalog = [];
    this._models = [];
    this._entitled = false;
    this._chat = null;
    this._controls = null;
    this._runs = new Map();
    this._activeOwner = null;
    this._seenControls = new Set();
    this._dirty = false;
    this._openEpoch = 0;
    this._taskEpoch = 0;
    this._tasksEpoch = 0;
    this._runsEpoch = 0;
    this._detailEpoch = 0;
    this._approvalEpoch = 0;
    this._tasksLoading = false;
    this._runsLoading = false;
    this._project = null;
    root.querySelector('.close').addEventListener('click', () => this.close());
    root.querySelector('.refresh').addEventListener('click', () => this.open(this._options));
    root.querySelector('.new').addEventListener('click', () => this._newTask());
    root.querySelector('.show-archived').addEventListener('change', () => this._renderTasks());
    root.querySelector('.more').addEventListener('click', () => this._loadTasks(false));
    root.querySelector('.more-runs').addEventListener('click', () => this._loadRuns(false));
    root.querySelector('.add-criterion').addEventListener('click', () => this._addCriterion());
    root.querySelector('form').addEventListener('input', () => { this._dirty = true; });
    root.querySelector('form').addEventListener('change', () => { this._dirty = true; });
    root.querySelector('form').addEventListener('submit', (event) => { event.preventDefault(); this._save(); });
    root.querySelector('.run').addEventListener('click', () => this._prepare());
    root.querySelector('.archive').addEventListener('click', () => this._archive());
  }

  setChat(chat) { this._chat = chat; }
  setControlBridge(bridge) { this._controls = bridge; }
  close() { this.removeAttribute('open'); this.dispatchEvent(new CustomEvent('panel-close')); }

  async open(options = {}) {
    const epoch=++this._openEpoch;
    this._options = options;
    this._models = Array.isArray(options.models) ? options.models : [];
    this._effortLabels = options.effortLabels && typeof options.effortLabels==='object' ? options.effortLabels : {};
    this.setAttribute('open', '');
    let availability;
    try { availability = await window.satr.savedTasksAvailability(); }
    catch { availability = { ok: false, error: 'feature_unavailable' }; }
    if(epoch!==this._openEpoch)return;
    if (!availability || !availability.ok || availability.available !== true) {
      this._showError(availability && availability.error || 'feature_unavailable');
      return;
    }
    const trusted=availability.project;
    if(!trusted||typeof trusted.project_id!=='string'||typeof trusted.path!=='string'){
      this._project=null;this._root.querySelector('.project-label').textContent='المشروع: غير محدد';
      this._showError('project_required');return;
    }
    if(this._project&&this._project.project_id!==trusted.project_id){
      if(this._activeOwner&&this._controls)this._controls.closeOwner(this._activeOwner);
      this._task=null;this._tasks=[];this._runs.clear();this._active.textContent='';this.replaceChildren();
      this._taskEpoch+=1;this._runsEpoch+=1;this._detailEpoch+=1;this._approvalEpoch+=1;this._activeOwner=null;
    }
    this._project=Object.freeze({project_id:trusted.project_id,path:trusted.path});
    const project=this._root.querySelector('.project-label');project.textContent='';
    const projectLabel=document.createElement('span');projectLabel.textContent='المشروع: ';
    const projectPath=document.createElement('bdi');projectPath.className='project-path';projectPath.dir='ltr';projectPath.textContent=trusted.path;project.append(projectLabel,projectPath);    this._entitled = availability.entitled === true;
    this._root.querySelector('.entitlement').textContent = this._entitled ? 'الاستحقاق نشط' : 'وضع القراءة بعد انتهاء الاستحقاق';
    this._syncMutationControls();
    try {
      const catalog = await window.satr.savedTasksVerificationCatalog();
      if(epoch!==this._openEpoch)return;
      this._catalog = catalog && catalog.ok && Array.isArray(catalog.checks) ? catalog.checks : [];
    } catch { this._catalog = []; }
    await this._loadTasks(true);
  }

  _hasExecutionChoice() {
    const model=this._root.querySelector('.model'),effort=this._root.querySelector('.effort');
    return !!(model&&model.selectedOptions[0]&&!model.selectedOptions[0].disabled&&effort&&effort.selectedOptions[0]&&!effort.selectedOptions[0].disabled);
  }
  invalidateProjectInput() {
    this._openEpoch+=1;this._taskEpoch+=1;this._runsEpoch+=1;this._detailEpoch+=1;this._approvalEpoch+=1;
    this._approval.hidden=true;this.close();
  }
  _syncMutationControls() {
    for (const selector of ['.new', '.archive', '.add-criterion']) {
      const button = this._root.querySelector(selector); if (button) button.disabled = !this._entitled;
    }
    const executable=this._entitled&&this._hasExecutionChoice();
    this._root.querySelector('.save').disabled=!executable;
    this._root.querySelector('.run').disabled=!executable||!!(this._task&&this._task.archived);
  }
  _showError(code, target = this._message) {
    target.hidden = false; target.className = 'message error'; target.textContent = errorText(code);
  }

  async _loadTasks(reset) {
    if(this._tasksLoading&&!reset)return;
    const generation=reset?++this._tasksEpoch:this._tasksEpoch;
    const openEpoch=this._openEpoch;
    if (reset) { this._taskCursor = 0; this._tasks = []; }
    const cursor=this._taskCursor;
    this._tasksLoading=true;this._root.querySelector('.more').disabled=true;
    let result;
    try { result = await window.satr.savedTasksList({ cursor, limit: 50 }); }
    catch { result = { ok: false, error: 'ipc_failed' }; }
    if(openEpoch!==this._openEpoch||generation!==this._tasksEpoch)return;
    this._tasksLoading=false;this._root.querySelector('.more').disabled=false;
    if (!result || !result.ok) { this._showError(result && result.error); return; }
    this._tasks.push(...(result.items || []));
    this._taskCursor = result.next_cursor;
    this._root.querySelector('.more').hidden = result.next_cursor == null;
    this._renderTasks();
  }

  _renderTasks() {
    const archived = this._root.querySelector('.show-archived').checked;
    this._list.textContent = '';
    const visible = this._tasks.filter((task) => task.archived === archived);
    for (const task of visible) {
      const button = document.createElement('button'); button.className = 'task';
      button.setAttribute('aria-current', String(this._task && this._task.task_id === task.task_id));
      const title = document.createElement('span'); title.className = 'task-title'; title.textContent = task.title; applyDir(title, task.title);
      const meta = document.createElement('span'); meta.className = 'meta tech'; meta.textContent = 'r' + task.revision;
      button.append(title, meta); button.addEventListener('click', () => this._selectTask(task.task_id));
      this._list.appendChild(button);
    }
    if (!visible.length) { const empty = document.createElement('div'); empty.className = 'empty'; empty.textContent = archived ? 'لا مهام مؤرشفة في هذه الصفحة.' : 'لا مهام محفوظة.'; this._list.appendChild(empty); }
  }

  _newTask() {
    this._taskEpoch+=1;this._runsEpoch+=1;this._detailEpoch+=1;this._approvalEpoch+=1;
    this._task = null;
    this._message.hidden = true; this._editor.hidden = false; this._approval.hidden = true;
    this._root.querySelector('.title').value = '';
    this._root.querySelector('.instructions').value = '';
    this._fillModels('', '');
    this._criteria.textContent = ''; this._addCriterion();
    this._root.querySelector('.archive').hidden = true;
    this._runList.textContent = ''; this._runDetail.textContent = '';
    this._renderTasks();
  }

  _fillModels(selectedModel, selectedEffort) {
    const model = this._root.querySelector('.model'); model.textContent = '';
    for (const item of this._models) {
      if (!item || !item.value) continue;
      const option = document.createElement('option'); option.value = item.value; option.textContent = item.label || item.value; model.appendChild(option);
    }
    if (selectedModel && ![...model.options].some((item) => item.value === selectedModel)) {
      const option = document.createElement('option'); option.value = selectedModel;
      option.textContent = selectedModel + ' (محفوظ وغير متاح حالياً)'; option.disabled = true; model.appendChild(option);
    }
    if ([...model.options].some((item) => item.value === selectedModel)) model.value = selectedModel;
    model.onchange = () => this._fillEfforts(model.value, '');
    this._fillEfforts(model.value, selectedEffort);
  }
  _fillEfforts(modelValue, selected) {
    const effort = this._root.querySelector('.effort'); effort.textContent = '';
    const item = this._models.find((entry) => entry.value === modelValue);
    const values = item && Array.isArray(item.efforts) ? item.efforts : [];
    for (const value of values) { const option = document.createElement('option'); option.value = value; option.textContent = this._effortLabels[value] || value; effort.appendChild(option); }
    if (selected && ![...effort.options].some((option) => option.value === selected)) {
      const option=document.createElement('option'); option.value=selected;
      option.textContent=(this._effortLabels[selected]||selected)+' (محفوظ وغير متاح حالياً)'; option.disabled=true; effort.appendChild(option);
    }
    if ([...effort.options].some((option) => option.value === selected)) effort.value = selected;
    this._syncMutationControls();
  }

  async _selectTask(taskId) {
    const epoch=++this._taskEpoch,openEpoch=this._openEpoch;
    let result;
    try { result = await window.satr.savedTasksGet({ task_id: taskId }); } catch { result = { ok:false, error:'ipc_failed' }; }
    if(epoch!==this._taskEpoch||openEpoch!==this._openEpoch)return;
    if (!result || !result.ok) { this._showError(result && result.error); return; }
    this._task = result.task; this._message.hidden = true; this._editor.hidden = false; this._approval.hidden = true;
    this._root.querySelector('.title').value = this._task.title;
    this._root.querySelector('.instructions').value = this._task.instructions;
    this._fillModels(this._task.model, this._task.effort);
    this._criteria.textContent = '';
    for (const criterion of this._task.criteria) this._addCriterion(criterion);
    const archive = this._root.querySelector('.archive'); archive.hidden = this._task.archived; archive.textContent = 'أرشفة';
    this._syncMutationControls();
    this._dirty = false; this._renderTasks(); await this._loadRuns(true);
  }

  _addCriterion(value = {}) {
    if (this._criteria.children.length >= 12) return;
    const row = document.createElement('div'); row.className = 'criterion'; row.dataset.id = value.criterion_id || criterionId();
    const description = document.createElement('input'); description.maxLength = 1000; description.placeholder = 'وصف المعيار'; description.value = value.description || '';
    const grid = document.createElement('div'); grid.className = 'criterion-grid';
    const source = document.createElement('select');
    for (const pair of [['human','مراجعة بشرية'],['verify','تحقق آلي']]) { const option=document.createElement('option'); option.value=pair[0]; option.textContent=pair[1]; source.appendChild(option); }
    source.value = value.verification_source || 'human';
    const verify = document.createElement('select');
    for (const check of this._catalog) { const option=document.createElement('option'); option.value=check.id; option.textContent=check.label + ' (' + check.id + ')'; verify.appendChild(option); }
    if (value.verify_id && ![...verify.options].some((item) => item.value === value.verify_id)) { const option=document.createElement('option'); option.value=value.verify_id; option.textContent=value.verify_id + ' (لم يعد متاحاً)'; verify.appendChild(option); }
    if (value.verify_id) verify.value = value.verify_id;
    const remove = document.createElement('button'); remove.type='button'; remove.className='danger'; remove.textContent='حذف المعيار'; remove.disabled=!this._entitled; remove.addEventListener('click',()=>row.remove());
    const sync = () => { verify.hidden = source.value !== 'verify'; }; source.addEventListener('change', sync); sync();
    grid.append(source, verify); row.append(description, grid, remove); this._criteria.appendChild(row);
  }

  _definition() {
    const criteria = [...this._criteria.children].map((row) => {
      const selects = row.querySelectorAll('select');
      const item = { criterion_id: row.dataset.id, description: row.querySelector('input').value,
        verification_source: selects[0].value };
      if (item.verification_source === 'verify') item.verify_id = selects[1].value;
      return item;
    });
    return { title:this._root.querySelector('.title').value, instructions:this._root.querySelector('.instructions').value,
      engine:'codex', model:this._root.querySelector('.model').value, effort:this._root.querySelector('.effort').value, criteria };
  }

  async _save() {
    if (!this._entitled) return;
    const draft = this._definition();
    const taskEpoch=this._taskEpoch,openEpoch=this._openEpoch,taskId=this._task&&this._task.task_id;
    let result;
    try {
      result = this._task
        ? await window.satr.savedTasksUpdate({ task_id:this._task.task_id, revision:this._task.revision, definition:draft })
        : await window.satr.savedTasksCreate(draft);
    } catch { result={ok:false,error:'ipc_failed'}; }
    if(taskEpoch!==this._taskEpoch||openEpoch!==this._openEpoch||(taskId&&(!this._task||this._task.task_id!==taskId)))return;
    if (!result || !result.ok) {
      this._showError(result && result.error);
      if (result && result.error === 'revision_conflict' && this._task) {
        const latest = await window.satr.savedTasksGet({task_id:this._task.task_id});
        if (latest && latest.ok) this._task = latest.task;
      }
      return;
    }
    this._task = result.task; this._dirty = false; await this._loadTasks(true); await this._selectTask(this._task.task_id);
    this._message.hidden=false; this._message.className='message status'; this._message.textContent='حُفظت المهمة وأُعيدت قراءتها.';
  }

  async _archive() {
    if (!this._task || !this._entitled) return;
    const taskEpoch=this._taskEpoch,openEpoch=this._openEpoch,taskId=this._task.task_id,revision=this._task.revision;
    let result; try { result = await window.satr.savedTasksArchive({ task_id:taskId, revision, archived:true }); } catch { result={ok:false,error:'ipc_failed'}; }
    if(taskEpoch!==this._taskEpoch||openEpoch!==this._openEpoch||!this._task||this._task.task_id!==taskId)return;
    if (result && result.ok) { this._task=result.task; await this._loadTasks(true); await this._selectTask(result.task.task_id); }
    else this._showError(result && result.error);
  }

  async _prepare() {
    if (!this._task || !this._entitled || this._task.archived) return;
    if (this._dirty) {
      this._showError('unsaved_changes');
      this._message.textContent='احفظ تعديلاتك قبل إعداد التشغيل؛ التشغيل يستخدم النسخة المحفوظة فقط.';
      return;
    }
    const approvalEpoch=++this._approvalEpoch,taskId=this._task.task_id,revision=this._task.revision,openEpoch=this._openEpoch;
    let result; try { result = await window.satr.savedTasksPrepareStart({task_id:taskId,revision}); }
    catch { result={ok:false,error:'ipc_failed'}; }
    if(approvalEpoch!==this._approvalEpoch||openEpoch!==this._openEpoch||!this._task||this._task.task_id!==taskId||this._task.revision!==revision)return;
    if (!result || !result.ok) { this._showError(result && result.error); return; }
    if(!this._project||!result.project||result.project.project_id!==this._project.project_id||result.project.path!==this._project.path||result.task.project_id!==this._project.project_id){this._showError('project_required');return;}
    this._renderApproval(result,approvalEpoch);
  }

  _renderApproval(prepared,approvalEpoch) {
    this._approval.textContent=''; this._approval.hidden=false;
    const title=document.createElement('strong'); title.textContent='راجع اللقطة قبل التشغيل';
    const project=document.createElement('div'); project.className='meta project-label';
    const projectLabel=document.createElement('span');projectLabel.textContent='المشروع: ';
    const projectPath=document.createElement('bdi');projectPath.className='project-path';projectPath.dir='ltr';projectPath.textContent=prepared.project.path;project.append(projectLabel,projectPath);
    const settings=document.createElement('div'); settings.className='meta setting-line';
    const modelLabel=document.createElement('span');modelLabel.textContent='النموذج: ';
    const model=document.createElement('bdi');model.className='setting-model';model.dir='ltr';model.textContent=prepared.task.model;
    const effort=document.createElement('span');effort.textContent=' · الجهد: '+(this._effortLabels[prepared.task.effort]||prepared.task.effort);
    settings.append(modelLabel,model,effort);
    const definition=document.createElement('div'); definition.className='snapshot'; definition.textContent=prepared.task.title + '\n' + prepared.task.instructions; applyDir(definition, definition.textContent);
    const fixed=document.createElement('div'); fixed.className='meta'; fixed.textContent='محاولة مستقلة · أذونات افتراضية · بلا جلسة سابقة · تحكم المتصفح يطلب موافقة كل مرة';
    this._approval.append(title,project,settings,definition,fixed);
    for(const criterion of prepared.task.criteria||[]){
      const row=document.createElement('p');
      row.textContent=(SOURCE_TEXT[criterion.verification_source]||criterion.verification_source)+': '+criterion.description;
      applyDir(row,row.textContent); this._approval.appendChild(row);
    }
    for(const check of prepared.verification_snapshot.checks || []) {
      const row=document.createElement('div'); row.className='check';
      const label=document.createElement('div'); label.textContent=check.label + ' (' + check.id + ')';
      const command=document.createElement('pre'); command.className='tech'; command.textContent=check.command;
      row.append(label,command); this._approval.appendChild(row);
    }
    const actions=document.createElement('div'); actions.className='actions';
    const confirm=document.createElement('button'); confirm.className='primary'; confirm.textContent='أوافق وأبدأ';
    const cancel=document.createElement('button'); cancel.textContent='إلغاء';
    confirm.addEventListener('click',async()=>{ confirm.disabled=true;
      let result; try { result=await window.satr.savedTasksConfirmStart({approval_token:prepared.approval_token}); }
      catch { result={ok:false,error:'ipc_failed'}; }
      if(approvalEpoch!==this._approvalEpoch)return;
      if(!result||!result.ok){this._showError(result&&result.error,this._approval); if(result&&result.error==='approval_invalid') await this._prepare();} else {this._approval.hidden=true; this._attachRun(result.run);} });
    cancel.addEventListener('click',()=>{this._approvalEpoch+=1;this._approval.hidden=true;});
    actions.append(confirm,cancel); this._approval.appendChild(actions);
  }

  _attachRun(run) {
    if (!run || !run.run_id) return;
    const owner={project_id:run.project_id,task_id:run.task_id,run_id:run.run_id};
    let entry=this._runs.get(run.run_id);
    if(!entry) {
      const card=document.createElement('section'); card.className='run-card';
      const head=document.createElement('div'); head.className='run-head';
      const state=document.createElement('strong'); state.textContent='المحاولة جارية';
      const stop=document.createElement('button'); stop.className='danger'; stop.textContent='إيقاف'; stop.addEventListener('click',()=>this._stop(owner));
      head.append(state,stop);
      const transcript=document.createElement('div'); transcript.className='transcript'; transcript.slot='run-'+run.run_id;
      const transcriptSlot=document.createElement('slot'); transcriptSlot.name=transcript.slot; transcriptSlot.className='transcript-slot';
      const result=document.createElement('div'); result.className='run-result';
      card.append(head,transcriptSlot,result); this._active.prepend(card); this.appendChild(transcript);
      const block=this._chat&&this._chat.newAssistantBlock
        ? this._chat.newAssistantBlock('Codex · مهمة محفوظة',{mount:transcript,isolated:true}) : null;
      entry={owner,run,card,state,stop,transcript,result,block}; this._runs.set(run.run_id,entry);
      this._activeOwner=owner;
    } else if(!entry.block||entry.block.done!==true) entry.run=run;
    return entry;
  }

  async _stop(owner) {
    let result; try { result=await window.satr.savedTasksStop({run_id:owner.run_id}); } catch { result={ok:false,error:'ipc_failed'}; }
    const entry=this._runs.get(owner.run_id);if(!entry||!exactOwner(entry.owner,owner))return;
    if(!result||!result.ok) this._showError(result&&result.error);
  }

  async retryFinish(runId) {
    const runEpoch=this._runsEpoch;
    let result; try { result=await window.satr.savedTasksRetryFinish({run_id:runId}); } catch { result={ok:false,error:'ipc_failed'}; }
    if(runEpoch!==this._runsEpoch)return;
    if(!result||!result.ok) this._showError(result&&result.error);
    else await this._loadRuns(true);
  }

  handleEvent(envelope) {
    if(!envelope||!envelope.owner||!envelope.event) return false;
    const owner=envelope.owner, event=envelope.event;
    let entry=this._runs.get(owner.run_id);
    if(event.type==='saved_task_started') entry=this._attachRun(event.run);
    if(!entry||!exactOwner(entry.owner,owner)) return false;
    if(['permission_request','question_request','handoff_request'].includes(event.type)) {
      if(!this._activeOwner||!exactOwner(this._activeOwner,owner)||!entry.block||entry.block.done) return false;
      const key=owner.run_id+':'+event.type+':'+String(event.id||'');
      if(this._seenControls.has(key)) return false;
      this._seenControls.add(key);
      if(event.type==='permission_request'&&this._controls)this._controls.permission(owner,event);
      if(event.type==='question_request'&&this._controls)this._controls.question(owner,event);
      if(event.type==='handoff_request'&&this._controls)this._controls.handoff(owner,event);
      return true;
    }
    if(event.type==='handoff_end') { if(this._controls) this._controls.handoffEnd(owner,event); return true; }
    if(event.type==='preview_open') {
      if(!this._activeOwner||!exactOwner(this._activeOwner,owner)) return false;
      if(this._controls)this._controls.preview(owner,event); return true;
    }
    if(event.type==='saved_task_storage_pending') {
      this._syncPending(entry,event.error||'storage_pending');
      return true;
    }
    if(event.type==='saved_task_finished') {
      entry.run=event.run; entry.state.textContent='انتهى التنفيذ — راجع نتائج المعايير'; entry.stop.disabled=true;
      if(entry.block){entry.block.finish(null);entry.block.done=true;}
      if(this._controls)this._controls.closeOwner(owner);
      if(this._activeOwner&&exactOwner(this._activeOwner,owner))this._activeOwner=null;
      this._renderRun(event.run,entry.result); this._loadRuns(true); return true;
    }
    return renderRunEvent(entry.block,event);
  }

  async _syncPending(entry,error) {
    const runRevision=entry.run&&entry.run.revision;
    let result; try { result=await window.satr.savedTaskRunsGet({run_id:entry.owner.run_id}); } catch { result=null; }
    if(this._runs.get(entry.owner.run_id)!==entry||entry.block&&entry.block.done||entry.run&&entry.run.revision!==runRevision)return;
    const run=result&&result.ok?result.run:null;
    const retry=run&&run.recovery_action==='retry_finish';
    entry.state.textContent=retry?errorText('storage_pending'):errorText(error==='completion_unknown'?'completion_unknown':'manual_recovery_required');
    entry.stop.disabled=retry;
    if(!retry&&this._controls){
      this._controls.closeOwner(entry.owner);
      if(this._activeOwner&&exactOwner(this._activeOwner,entry.owner))this._activeOwner=null;
    }
    if(retry&&!entry.card.querySelector('.retry-finish')){
      const button=document.createElement('button'); button.className='retry-finish'; button.textContent='إعادة حفظ النتيجة';
      button.addEventListener('click',()=>this.retryFinish(entry.owner.run_id)); entry.card.appendChild(button);
    }
  }

  async _loadRuns(reset) {
    if(!this._task||this._runsLoading&&!reset) return;
    const generation=reset?++this._runsEpoch:this._runsEpoch;
    const taskId=this._task.task_id,openEpoch=this._openEpoch,cursor=reset?0:this._runCursor;
    if(reset){this._runCursor=0;this._runList.textContent='';}
    this._runsLoading=true;this._root.querySelector('.more-runs').disabled=true;
    let result; try { result=await window.satr.savedTaskRunsList({task_id:taskId,page:{cursor,limit:30}}); } catch { result={ok:false,error:'ipc_failed'}; }
    if(openEpoch!==this._openEpoch||generation!==this._runsEpoch||!this._task||this._task.task_id!==taskId)return;
    this._runsLoading=false;this._root.querySelector('.more-runs').disabled=false;
    if(!result||!result.ok){this._showError(result&&result.error);return;}
    for(const run of result.items||[]) {
      const button=document.createElement('button'); button.className='history-item';
      const id=document.createElement('span'); id.className='tech'; id.textContent=run.run_id.slice(0,14)+'…';
      const state=document.createElement('span'); state.textContent=(STATE_TEXT[run.runtime_state||run.state]||'حالة غير معروفة')+' · '+fmtTime(run.started_at);
      button.append(state,id); button.addEventListener('click',()=>this._showRun(run.run_id)); this._runList.appendChild(button);
    }
    this._runCursor=result.next_cursor; this._root.querySelector('.more-runs').hidden=result.next_cursor==null;
  }

  async _showRun(runId) {
    const epoch=++this._detailEpoch,openEpoch=this._openEpoch;
    let result; try { result=await window.satr.savedTaskRunsGet({run_id:runId}); } catch { result={ok:false,error:'ipc_failed'}; }
    if(epoch!==this._detailEpoch||openEpoch!==this._openEpoch)return;
    if(!result||!result.ok){this._showError(result&&result.error);return;}
    this._renderRun(result.run,this._runDetail);
  }

  _renderRun(run,target) {
    target.textContent='';
    const card=document.createElement('section'); card.className='run-card';
    const heading=document.createElement('strong'); heading.textContent='نتيجة المحاولة: '+(STATE_TEXT[run.runtime_state||run.state]||'حالة غير معروفة');
    const time=document.createElement('div'); time.className='meta'; time.textContent=fmtTime(run.started_at)+(run.ended_at?' — '+fmtTime(run.ended_at):'');
    card.append(heading,time);
    for(const result of run.criteria_results||[]) {
      const row=document.createElement('div'); row.className='check';
      const definition=(run.definition_snapshot.criteria||[]).find((item)=>item.criterion_id===result.criterion_id);
      const label=document.createElement('div'); label.textContent=definition?definition.description:result.criterion_id; applyDir(label,label.textContent);
      const verdict=document.createElement('div'); verdict.className='verdict '+result.verdict; verdict.textContent=(VERDICT_TEXT[result.verdict]||'حكم غير معروف')+' · '+(SOURCE_TEXT[result.verification_source]||'مصدر غير معروف');
      const reason=document.createElement('div'); reason.className='meta'; reason.textContent=result.reason||'بلا سبب محفوظ'; applyDir(reason,reason.textContent);
      const evidenceRefs=Array.isArray(result.evidence_refs)?result.evidence_refs:[];
      const evidence=document.createElement('div'); evidence.className=evidenceRefs.length?'meta tech':'meta'; evidence.textContent=evidenceRefs.join('\n')||'لا دليل محفوظ';
      if(!evidenceRefs.length)applyDir(evidence,evidence.textContent);
      row.append(label,verdict,reason,evidence); card.appendChild(row);
    }
    if(run.state==='failed'&&typeof run.technical_reason==='string'&&run.technical_reason.trim()){const technical=document.createElement('div');technical.className='error';technical.textContent='سبب الفشل: '+run.technical_reason;applyDir(technical,technical.textContent);card.appendChild(technical);}
    if(['unknown','interrupted'].includes(run.runtime_state)){const warning=document.createElement('div');warning.className='error';warning.textContent=errorText('manual_recovery_required');card.appendChild(warning);}
    if(run.recovery_action==='retry_finish'){const retry=document.createElement('button');retry.textContent='إعادة حفظ النتيجة';retry.addEventListener('click',()=>this.retryFinish(run.run_id));card.appendChild(retry);}
    if(FINAL.has(run.state)&&this._entitled){
      const review=document.createElement('div');review.className='actions';
      for(const decision of ['approved','rejected']){const button=document.createElement('button');button.textContent=decision==='approved'?'اعتماد المراجعة':'رفض المراجعة';button.addEventListener('click',()=>this._review(run,decision));review.appendChild(button);}
      const remove=document.createElement('button');remove.className='danger';remove.textContent='حذف هذه المحاولة';
      remove.addEventListener('click',()=>this._deleteRun(run,target));review.appendChild(remove);card.appendChild(review);
    }
    const reviews=document.createElement('div');reviews.className='meta';reviews.textContent=(run.reviews||[]).map((item)=>'مراجعة بشرية: '+(item.decision==='approved'?'اعتمدها المستخدم':'رفضها المستخدم')+' · r'+item.revision+' · '+fmtTime(item.decided_at)).join('\n');applyDir(reviews,reviews.textContent);card.appendChild(reviews);
    const report=document.createElement('button');report.textContent='قراءة تقرير المحاولة';report.addEventListener('click',()=>this._readReport(run.run_id,card));card.appendChild(report);
    target.appendChild(card);
  }

  async _deleteRun(run,target) {
    const detailEpoch=this._detailEpoch,confirm=this._options&&this._options.confirm;
    const approved=typeof confirm==='function'
      ? await confirm({source:this,title:'حذف محاولة منتهية',confirmLabel:'احذف المحاولة',
        description:'سيُحذف سجل هذه المحاولة فقط. لا تُحذف المهمة ولا بقية التاريخ.',
        items:[run.run_id,'الحالة: '+(STATE_TEXT[run.state]||'منتهية')]})
      : false;
    if(!approved)return;
    let result;try{result=await window.satr.savedTaskRunsDelete({run_id:run.run_id,revision:run.revision,confirmed:true});}
    catch{result={ok:false,error:'ipc_failed'};}
    if(!result||!result.ok){this._showError(result&&result.error);return;}
    target.textContent='';const live=this._runs.get(run.run_id);
    if(live){live.card.remove();live.transcript.remove();this._runs.delete(run.run_id);}
    await this._loadRuns(true);
  }

  async _review(run,decision) {
    const detailEpoch=this._detailEpoch;
    let result; try { result=await window.satr.savedTaskRunsReview({run_id:run.run_id,revision:run.revision,decision}); } catch { result={ok:false,error:'ipc_failed'}; }
    if(detailEpoch!==this._detailEpoch)return;
    if(!result||!result.ok)this._showError(result&&result.error);else this._renderRun(result.run,this._runDetail);
  }

  async _readReport(runId,card) {
    const detailEpoch=this._detailEpoch;
    let result; try { result=await window.satr.savedTaskRunsReadReport({run_id:runId}); } catch { result={ok:false,error:'ipc_failed'}; }
    if(detailEpoch!==this._detailEpoch||!card.isConnected)return;
    let report=card.querySelector('.report'); if(!report){report=document.createElement('div');report.className='report';card.appendChild(report);} report.textContent='';
    if(!result||!result.ok){const error=document.createElement('div');error.className='error';error.textContent=errorText(result&&result.error);report.appendChild(error);return;}
    const value=result.report;
    const meta=document.createElement('div');meta.className='meta';meta.textContent=(value.redacted?'حُجب التقرير لاحتوائه سراً ظاهراً. ':'')+(value.truncated?'التقرير مقتطع.':'');report.appendChild(meta);
    // يبقى البث غير المكتمل، وتستبدله النهاية المناظرة للمرحلة نفسها فقط.
    const rows=[];const pendingStreams=new Map();
    for(const event of value.events||[]){
      if(event.type==='stream_text'&&typeof event.text==='string'){
        const phase=event.phase==='commentary'?'commentary':'final_answer';let row=pendingStreams.get(phase);
        if(!row){row={text:'',phase};pendingStreams.set(phase,row);rows.push(row);}row.text+=event.text;continue;
      }
      if(event.type==='assistant'&&event.message&&Array.isArray(event.message.content)){
        const completed=new Map();
        for(const item of event.message.content){if(!item||item.type!=='text'||typeof item.text!=='string')continue;const phase=(item.phase||event.phase)==='commentary'?'commentary':'final_answer';completed.set(phase,(completed.get(phase)||[]).concat(item.text));}
        for(const [phase,texts] of completed){const text=texts.join('\n');const streamed=pendingStreams.get(phase);if(streamed){streamed.text=text;pendingStreams.delete(phase);}else rows.push({text,phase});}
        continue;
      }
      let text='';
      if(typeof event.text==='string')text=event.text;
      else if(event.type==='result')text=event.is_error===true?'انتهى المحرك بخطأ.':'انتهى المحرك.';
      else if(event.type==='spawn_error')text='تعذّر بدء المحرك.';
      if(text)rows.push({text});
    }
    for(const item of rows){
      if(!item.text)continue;const row=document.createElement('div');row.className='report-event';row.textContent=item.text;applyDir(row,item.text);report.appendChild(row);
    }
    if(!value.events.length&&!value.redacted){const empty=document.createElement('div');empty.className='hint';empty.textContent='لا أحداث قابلة للعرض في التقرير.';report.appendChild(empty);}
  }
}
customElements.define('satr-saved-tasks-panel',SatrSavedTasksPanel);