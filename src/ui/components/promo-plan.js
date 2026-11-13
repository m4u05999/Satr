// بطاقة سيناريو الإعلان: الوكيل يقترح خطة مكتوبة (promo_plan_ad)، والمستخدم يعدّلها ويعتمدها
// قبل أي تسجيل. الاعتماد من هنا فقط؛ الوكيل يقرأ النسخة المعتمدة بـ promo_get_ad_plan.

import { sheet } from '../lib/sheet.js';
import { applyDir } from '../lib/text-dir.js';

const MAX_SCENES = 12;
const MAX_TOTAL_S = 180;

const planSheet = sheet(`
  :host { display: none; position: fixed; inset: var(--space-0); z-index: var(--z-modal); direction: rtl; }
  :host([open]) { display: block; }
  .backdrop { position: absolute; inset: var(--space-0); background: var(--scrim); }
  .card {
    position: absolute; inset: var(--space-5); max-width: 860px; margin: auto; display: grid; grid-template-rows: auto minmax(0, 1fr) auto;
    border: 1px solid var(--border); border-radius: var(--radius-xl); background: var(--bg-deep); color: var(--text); box-shadow: var(--shadow-modal); overflow: hidden;
  }
  header, footer { display: flex; align-items: center; gap: var(--space-2); padding: var(--space-3) var(--space-4); background: var(--surface); }
  header { border-bottom: 1px solid var(--border); }
  footer { border-top: 1px solid var(--border); flex-wrap: wrap; }
  h2 { flex: 1; margin: var(--space-0); font-size: 17px; color: var(--gold-strong); }
  .body { overflow: auto; padding: var(--space-4); display: grid; gap: var(--space-3); }
  button, input, select, textarea {
    font-family: var(--sans); border: 1px solid var(--border); border-radius: var(--radius-md);
    background: var(--bg); color: var(--text); padding: var(--space-1h) var(--space-2h);
  }
  button { cursor: pointer; }
  button:hover { border-color: var(--gold); }
  button:disabled { opacity: .45; cursor: default; border-color: var(--border); }
  label { display: grid; gap: var(--space-1); color: var(--text-dim); font-size: 11.5px; }
  .meta { display: grid; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); gap: var(--space-2); }
  .wide { grid-column: 1 / -1; }
  input[type=text], textarea { width: 100%; min-width: 0; box-sizing: border-box; unicode-bidi: plaintext; }
  textarea { resize: vertical; min-height: 56px; line-height: 1.6; }
  .num { width: 88px; direction: ltr; text-align: left; font-family: var(--mono); }
  .scene { display: grid; grid-template-columns: auto minmax(0, 1fr); gap: var(--space-3); padding: var(--space-3); border: 1px solid var(--border); border-radius: var(--radius-lg); background: var(--surface); }
  .scene-num { width: var(--space-6); height: var(--space-6); display: grid; place-items: center; border-radius: var(--radius-pill); background: var(--gold-soft); color: var(--gold-strong); font-family: var(--mono); }
  .scene-main { min-width: 0; display: grid; gap: var(--space-2); }
  .row { display: flex; align-items: end; gap: var(--space-2); flex-wrap: wrap; }
  .row .grow { flex: 1; min-width: 180px; }
  .status { flex: 1; color: var(--text-dim); font-size: 12px; unicode-bidi: plaintext; }
  .status.over { color: var(--red); }
  #approve { background: var(--gold); color: var(--on-gold); border-color: var(--gold); font-weight: 700; }
  .hint { color: var(--text-faint); font-size: 12px; }
`);

const MARKUP = `
  <div class="backdrop"></div>
  <section class="card" role="document">
    <header><h2>🎬 سيناريو الإعلان</h2><button id="close" type="button" title="إغلاق" aria-label="إغلاق بطاقة السيناريو">✕</button></header>
    <div class="body">
      <p class="hint">اقترح الوكيل هذا السيناريو. عدّل ما تشاء ثم اعتمده؛ لن يبدأ أي تسجيل قبل اعتمادك.</p>
      <div class="meta">
        <label class="wide">الهدف<input id="goal" type="text" maxlength="300"></label>
        <label>الجمهور<input id="audience" type="text" maxlength="200"></label>
        <label>النبرة<input id="tone" type="text" maxlength="80"></label>
        <label>المدة المستهدفة (ث)<input id="duration" class="num" type="number" min="10" max="90" step="5"></label>
        <label>المقاس<select id="aspect"><option value="16:9">يوتيوب / X عرضي</option><option value="9:16">سناب / تيك توك / ريلز</option><option value="1:1">إنستقرام مربع</option></select></label>
      </div>
      <div id="scenes"></div>
      <div><button id="add" type="button">＋ مشهد</button></div>
    </div>
    <footer>
      <span class="status" id="status"></span>
      <button id="dismiss" type="button">ارفض السيناريو</button>
      <button id="approve" type="button">اعتمد السيناريو</button>
    </footer>
  </section>`;

function emptyScene() {
  return { purpose: '', steps_to_perform: [], caption_ar: '', voiceover_ar: '', duration_s: 5 };
}

function clonePlan(raw) {
  const plan = raw && typeof raw === 'object' ? raw : {};
  const text = (value, max) => (typeof value === 'string' ? value.slice(0, max) : '');
  const scenes = (Array.isArray(plan.scenes) ? plan.scenes : []).slice(0, MAX_SCENES).map((scene) => ({
    purpose: text(scene && scene.purpose, 200),
    steps_to_perform: (Array.isArray(scene && scene.steps_to_perform) ? scene.steps_to_perform : []).slice(0, 8).map((step) => text(step, 200)).filter(Boolean),
    caption_ar: text(scene && scene.caption_ar, 500),
    voiceover_ar: text(scene && scene.voiceover_ar, 2000),
    duration_s: Number.isInteger(scene && scene.duration_s) ? Math.max(1, Math.min(60, scene.duration_s)) : 5,
  }));
  return {
    goal: text(plan.goal, 300), audience: text(plan.audience, 200), tone: text(plan.tone, 80),
    duration_s: Number.isInteger(plan.duration_s) ? Math.max(10, Math.min(90, plan.duration_s)) : 30,
    aspect: ['16:9', '9:16', '1:1'].includes(plan.aspect) ? plan.aspect : '16:9',
    scenes: scenes.length ? scenes : [emptyScene()],
  };
}

class SatrPromoPlan extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: 'open' });
    this.shadowRoot.adoptedStyleSheets = [planSheet];
    this.shadowRoot.innerHTML = MARKUP;
    this.plan = clonePlan(null);
    this.busy = false;
  }

  connectedCallback() {
    const root = this.shadowRoot;
    root.getElementById('close').addEventListener('click', () => this.close());
    root.querySelector('.backdrop').addEventListener('click', () => this.close());
    root.getElementById('dismiss').addEventListener('click', () => this.dismiss());
    root.getElementById('approve').addEventListener('click', () => { this.approve().catch(() => {}); });
    root.getElementById('add').addEventListener('click', () => {
      if (this.plan.scenes.length >= MAX_SCENES) return;
      this.plan.scenes.push(emptyScene());
      this.renderScenes();
    });
    for (const [id, field] of [['goal', 'goal'], ['audience', 'audience'], ['tone', 'tone']]) {
      root.getElementById(id).addEventListener('input', (event) => { this.plan[field] = String(event.target.value || ''); applyDir(event.target, this.plan[field]); this.sync(); });
    }
    root.getElementById('duration').addEventListener('input', (event) => { this.plan.duration_s = Math.max(10, Math.min(90, Math.round(Number(event.target.value) || 30))); this.sync(); });
    root.getElementById('aspect').addEventListener('change', (event) => { this.plan.aspect = event.target.value; });
    root.getElementById('scenes').addEventListener('input', (event) => this.handleSceneEdit(event));
    root.getElementById('scenes').addEventListener('click', (event) => this.handleSceneAction(event));
    this.addEventListener('keydown', (event) => { if (event.key === 'Escape') this.close(); });
    if (window.satr && typeof window.satr.onPromoCapture === 'function') {
      this.unsubscribe = window.satr.onPromoCapture((event) => {
        if (event && event.type === 'ad_plan_proposed') this.open(event.plan);
      });
    }
  }

  disconnectedCallback() {
    if (typeof this.unsubscribe === 'function') this.unsubscribe();
  }

  open(plan) {
    this.plan = clonePlan(plan);
    this.busy = false;
    const root = this.shadowRoot;
    for (const id of ['goal', 'audience', 'tone']) { const input = root.getElementById(id); input.value = this.plan[id]; applyDir(input, this.plan[id]); }
    root.getElementById('duration').value = String(this.plan.duration_s);
    root.getElementById('aspect').value = this.plan.aspect;
    this.renderScenes();
    this.setAttribute('open', '');
    this.dispatchEvent(new CustomEvent('promo-plan-visible', { bubbles: true, detail: true }));
    queueMicrotask(() => root.getElementById('goal').focus());
  }

  close() {
    if (!this.hasAttribute('open')) return;
    this.removeAttribute('open');
    this.dispatchEvent(new CustomEvent('promo-plan-visible', { bubbles: true, detail: false }));
  }

  totalSeconds() {
    return this.plan.scenes.reduce((sum, scene) => sum + scene.duration_s, 0);
  }

  sync() {
    const root = this.shadowRoot;
    const total = this.totalSeconds();
    const status = root.getElementById('status');
    const over = total > MAX_TOTAL_S;
    status.classList.toggle('over', over);
    status.textContent = over ? 'مجموع المشاهد ' + total + ' ث يتجاوز الحد (' + MAX_TOTAL_S + ' ث).'
      : 'مجموع المشاهد: ' + total + ' ث · المستهدف: ' + this.plan.duration_s + ' ث';
    root.getElementById('approve').disabled = this.busy || over || !this.plan.goal.trim() || !this.plan.scenes.length;
    root.getElementById('add').disabled = this.plan.scenes.length >= MAX_SCENES;
  }

  renderScenes() {
    const container = this.shadowRoot.getElementById('scenes');
    container.replaceChildren();
    const field = (labelText, control, className) => {
      const label = document.createElement('label');
      if (className) label.className = className;
      label.append(document.createTextNode(labelText), control);
      return label;
    };
    this.plan.scenes.forEach((scene, index) => {
      const card = document.createElement('article'); card.className = 'scene'; card.dataset.index = String(index);
      const number = document.createElement('span'); number.className = 'scene-num'; number.textContent = String(index + 1);
      const main = document.createElement('div'); main.className = 'scene-main';
      const purpose = document.createElement('input'); purpose.type = 'text'; purpose.maxLength = 200; purpose.dataset.field = 'purpose'; purpose.value = scene.purpose;
      purpose.placeholder = 'ما الذي يثبته هذا المشهد؟';
      const steps = document.createElement('textarea'); steps.dataset.field = 'steps'; steps.value = scene.steps_to_perform.join('\n');
      steps.placeholder = 'خطوة في كل سطر: ما سيفعله الوكيل في التطبيق';
      const caption = document.createElement('input'); caption.type = 'text'; caption.maxLength = 500; caption.dataset.field = 'caption_ar'; caption.value = scene.caption_ar;
      const voiceover = document.createElement('textarea'); voiceover.dataset.field = 'voiceover_ar'; voiceover.maxLength = 2000; voiceover.value = scene.voiceover_ar;
      const duration = document.createElement('input'); duration.type = 'number'; duration.className = 'num'; duration.min = '1'; duration.max = '60'; duration.step = '1';
      duration.dataset.field = 'duration_s'; duration.value = String(scene.duration_s);
      const remove = document.createElement('button'); remove.type = 'button'; remove.dataset.action = 'remove'; remove.textContent = 'حذف المشهد';
      remove.disabled = this.plan.scenes.length <= 1;
      for (const control of [purpose, steps, caption, voiceover]) applyDir(control, control.value);
      const row = document.createElement('div'); row.className = 'row';
      row.append(field('العنوان على الشاشة', caption, 'grow'), field('المدة (ث)', duration), remove);
      main.append(field('الغرض', purpose), field('الخطوات', steps), row, field('نص التعليق الصوتي', voiceover));
      card.append(number, main);
      container.appendChild(card);
    });
    this.sync();
  }

  handleSceneEdit(event) {
    const control = event.target;
    const card = control && control.closest('.scene');
    const scene = card ? this.plan.scenes[Number(card.dataset.index)] : null;
    const field = control && control.dataset ? control.dataset.field : '';
    if (!scene || !field) return;
    const value = String(control.value || '');
    if (field === 'steps') scene.steps_to_perform = value.split('\n').map((line) => line.trim().slice(0, 200)).filter(Boolean).slice(0, 8);
    else if (field === 'duration_s') scene.duration_s = Math.max(1, Math.min(60, Math.round(Number(value) || 1)));
    else scene[field] = value;
    if (control.tagName !== 'INPUT' || control.type === 'text') applyDir(control, value);
    this.sync();
  }

  handleSceneAction(event) {
    const button = event.target && event.target.closest('button[data-action="remove"]');
    const card = button && button.closest('.scene');
    if (!button || !card || this.plan.scenes.length <= 1) return;
    this.plan.scenes.splice(Number(card.dataset.index), 1);
    this.renderScenes();
  }

  getPlan() {
    return JSON.parse(JSON.stringify(this.plan));
  }

  async approve() {
    if (this.busy) return null;
    const status = this.shadowRoot.getElementById('status');
    this.busy = true;
    this.sync();
    try {
      const result = await window.satr.promoAdPlanApprove(this.getPlan());
      if (!result || !result.ok) throw new Error(result && result.error ? result.error : 'approve_failed');
      this.close();
      this.dispatchEvent(new CustomEvent('promo-plan-approved', { bubbles: true, detail: { plan: result.plan } }));
      return result;
    } catch (error) {
      status.classList.add('over');
      status.textContent = 'تعذّر اعتماد السيناريو: ' + (error && error.message ? error.message : error);
      throw error;
    } finally {
      this.busy = false;
      if (this.hasAttribute('open')) this.shadowRoot.getElementById('approve').disabled = false;
    }
  }

  async dismiss() {
    try { await window.satr.promoAdPlanDismiss(); } catch (error) {}
    this.close();
    this.dispatchEvent(new CustomEvent('promo-plan-dismissed', { bubbles: true }));
  }
}

customElements.define('satr-promo-plan', SatrPromoPlan);
