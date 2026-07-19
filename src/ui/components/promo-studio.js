// <satr-promo-studio> — خط زمني بشري ومُصيّر فوري صفري الاعتماديات لإعلانات المنتج.
import { sheet } from '../lib/sheet.js';
import { renderStoryboard } from '../lib/promo-renderer.js';

const studioSheet = sheet(`
  :host { display: none; position: fixed; inset: var(--space-0); z-index: var(--z-modal); direction: rtl; }
  :host([open]) { display: block; }
  .backdrop { position: absolute; inset: var(--space-0); background: var(--scrim); }
  .studio {
    position: absolute; inset: var(--space-4); display: grid; grid-template-rows: auto minmax(0, 1fr) auto;
    max-width: 1180px; margin: auto; border: 1px solid var(--border); border-radius: var(--radius-xl);
    background: var(--bg-deep); color: var(--text); box-shadow: var(--shadow-modal); overflow: hidden;
  }
  header, footer { display: flex; align-items: center; gap: var(--space-2); padding: var(--space-3) var(--space-4); background: var(--surface); }
  header { border-bottom: 1px solid var(--border); }
  footer { border-top: 1px solid var(--border); flex-wrap: wrap; }
  h2 { flex: 1; margin: var(--space-0); font-size: 17px; color: var(--gold-strong); }
  button, input, select {
    font-family: var(--sans); border: 1px solid var(--border); border-radius: var(--radius-md);
    background: var(--bg); color: var(--text); padding: var(--space-1h) var(--space-2h);
  }
  button { cursor: pointer; }
  button:hover { border-color: var(--gold); }
  button:disabled { opacity: .45; cursor: default; border-color: var(--border); }
  .body { min-height: 0; display: grid; grid-template-columns: minmax(330px, 1fr) minmax(360px, 1.25fr); gap: var(--space-4); padding: var(--space-4); overflow: hidden; }
  .timeline { min-height: 0; overflow: auto; display: flex; flex-direction: column; gap: var(--space-2); }
  .scene { display: grid; grid-template-columns: auto minmax(0, 1fr); gap: var(--space-3); padding: var(--space-3); border: 1px solid var(--border); border-radius: var(--radius-lg); background: var(--surface); }
  .scene-num { width: var(--space-6); height: var(--space-6); display: grid; place-items: center; border-radius: var(--radius-pill); background: var(--gold-soft); color: var(--gold-strong); font-family: var(--mono); }
  .scene-main { min-width: 0; display: grid; gap: var(--space-2); }
  .asset { direction: ltr; text-align: left; unicode-bidi: plaintext; color: var(--text-dim); font: 11px var(--mono); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .row { display: flex; align-items: center; gap: var(--space-2); flex-wrap: wrap; }
  .row label { display: flex; align-items: center; gap: var(--space-1); color: var(--text-dim); font-size: 11.5px; }
  .caption { width: 100%; min-width: 0; unicode-bidi: plaintext; }
  .duration { width: 92px; direction: ltr; text-align: left; font-family: var(--mono); }
  .music { min-width: 150px; max-width: 260px; direction: ltr; }
  .scene-actions { margin-inline-start: auto; display: flex; gap: var(--space-1); }
  .scene-actions button { padding: var(--space-1) var(--space-2); }
  .preview { min-height: 0; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: var(--space-3); border: 1px solid var(--border); border-radius: var(--radius-lg); background: var(--bg); overflow: hidden; padding: var(--space-3); }
  canvas { display: block; max-width: 100%; max-height: 62vh; width: auto; height: auto; background: var(--bg-deep); box-shadow: var(--shadow-pop); }
  .empty { color: var(--text-faint); text-align: center; padding: var(--space-6); }
  .status { flex: 1; color: var(--text-dim); font-size: 12px; unicode-bidi: plaintext; }
  .progress { width: min(230px, 32vw); height: var(--space-2); overflow: hidden; border-radius: var(--radius-pill); background: var(--surface-2); }
  .progress span { display: block; width: 0; height: 100%; background: var(--gold); transition: width var(--dur) linear; }
  #approve.approved { color: var(--green); border-color: var(--green-border); background: var(--green-soft); }
  #render { background: var(--gold); color: var(--on-gold); border-color: var(--gold); font-weight: 700; }
  @media (max-width: 860px) {
    .studio { inset: var(--space-2); }
    .body { grid-template-columns: 1fr; overflow: auto; }
    .timeline { overflow: visible; }
    .preview { min-height: 280px; }
  }
`);

const MARKUP = `
  <div class="backdrop"></div>
  <section class="studio" role="document">
    <header><h2>🎬 استوديو البرومو</h2><span id="aspect" dir="ltr">16:9</span><button id="close" type="button">✕</button></header>
    <div class="body">
      <div class="timeline" id="timeline"></div>
      <div class="preview"><canvas id="canvas" width="1920" height="1080"></canvas><div class="empty" id="empty">سجّل مقاطع أو اطلب من الوكيل اقتراح storyboard.</div></div>
    </div>
    <footer>
      <span class="status" id="status">عدّل الخط الزمني ثم اعتمده قبل التصيير.</span>
      <div class="progress" aria-label="تقدم التصيير"><span id="progress"></span></div>
      <button id="approve" type="button">اعتماد الخط الزمني</button>
      <button id="render" type="button" disabled>صيّر MP4</button>
    </footer>
  </section>`;

const ASPECT_SIZE = {
  '16:9': { width: 1920, height: 1080 },
  '9:16': { width: 1080, height: 1920 },
  '1:1': { width: 1080, height: 1080 },
};

function cloneStoryboard(value) {
  const raw = value && typeof value === 'object' ? value : {};
  const aspect = Object.hasOwn(ASPECT_SIZE, raw.aspect) ? raw.aspect : '16:9';
  const scenes = Array.isArray(raw.scenes) ? raw.scenes.slice(0, 40).map((scene, index) => ({
    id: typeof scene.id === 'string' ? scene.id : 'scene_' + String(index + 1),
    asset: typeof scene.asset === 'string' ? scene.asset : '',
    asset_type: scene.asset_type === 'image' ? 'image' : 'video',
    caption: typeof scene.caption === 'string' ? scene.caption.slice(0, 500) : '',
    duration_ms: Number.isInteger(scene.duration_ms) ? Math.max(250, Math.min(120000, scene.duration_ms)) : 3000,
    transition: scene.transition === 'fade' ? 'fade' : 'cut',
    music: typeof scene.music === 'string' ? scene.music : '',
    voice: typeof scene.voice === 'string' ? scene.voice : '',
  })).filter((scene) => scene.asset) : [];
  return { aspect, scenes };
}

function basename(value) {
  return String(value || '').split(/[\\/]/).pop() || '';
}

class SatrPromoStudio extends HTMLElement {
  constructor() {
    super();
    const root = this.attachShadow({ mode: 'open' });
    root.adoptedStyleSheets = [studioSheet];
    root.innerHTML = MARKUP;
    this.storyboard = { aspect: '16:9', scenes: [] };
    this.approved = false;
    this.rendering = false;
    this.rerecordIndex = -1;
    this.rerecording = false;
    this.abortController = null;
  }

  connectedCallback() {
    const root = this.shadowRoot;
    root.getElementById('close').addEventListener('click', () => this.close());
    root.querySelector('.backdrop').addEventListener('click', () => this.close());
    root.getElementById('approve').addEventListener('click', () => {
      if (!this.storyboard.scenes.length || this.rendering) return;
      this.approved = !this.approved;
      this.syncApproval();
    });
    root.getElementById('render').addEventListener('click', () => {
      this.lastRenderPromise = this.render();
      this.lastRenderPromise.catch(() => {});
    });
    root.getElementById('timeline').addEventListener('input', (event) => this.handleEdit(event));
    root.getElementById('timeline').addEventListener('change', (event) => this.handleEdit(event));
    root.getElementById('timeline').addEventListener('click', (event) => this.handleAction(event));
    document.addEventListener('promo-studio-open', (event) => this.open(event.detail && event.detail.storyboard));
    if (typeof window.satr.onPromoCapture === 'function') window.satr.onPromoCapture((event) => {
      if (!event) return;
      if (event.type === 'storyboard_proposed') this.open(event.storyboard);
      if (event.type === 'capture_active' && this.rerecordIndex >= 0) { this.rerecording = true; this.renderTimeline(); }
      if (event.type === 'segment_saved' && this.rerecordIndex >= 0 && event.segment) {
        const scene = this.storyboard.scenes[this.rerecordIndex];
        if (scene) { scene.asset = event.segment.path; scene.asset_type = 'video'; scene.duration_ms = event.segment.duration_ms || scene.duration_ms; }
        this.rerecordIndex = -1;
        this.rerecording = false;
        this.changed();
      }
      if ((event.type === 'capture_failed' || event.type === 'capture_closed') && this.rerecordIndex >= 0) {
        this.rerecordIndex = -1; this.rerecording = false; this.renderTimeline();
      }
    });
    this.renderTimeline();
  }

  async open(storyboard) {
    let next = storyboard;
    if (!next && typeof window.satr.promoStudioState === 'function') {
      const state = await window.satr.promoStudioState();
      next = state && state.storyboard;
      if (!next && state && Array.isArray(state.segments) && state.segments.length) {
        next = { aspect: state.segments[0].aspect || '16:9', scenes: state.segments.map((segment, index) => ({
          id: 'scene_' + String(index + 1), asset: segment.path, asset_type: 'video', caption: '',
          duration_ms: segment.duration_ms || 3000, transition: index ? 'fade' : 'cut', music: '',
        })) };
      }
    }
    if (next) this.storyboard = cloneStoryboard(next);
    this.approved = false;
    this.setAttribute('open', '');
    this.renderTimeline();
    this.dispatchEvent(new CustomEvent('promo-studio-visible', { bubbles: true, detail: true }));
    queueMicrotask(() => this.shadowRoot.getElementById('close').focus());
  }

  close() {
    if (this.rendering && this.abortController) this.abortController.abort();
    if (this.rerecording) window.satr.promoCaptureStop().catch(() => {});
    this.removeAttribute('open');
    this.dispatchEvent(new CustomEvent('promo-studio-visible', { bubbles: true, detail: false }));
  }

  setStoryboard(storyboard) {
    this.storyboard = cloneStoryboard(storyboard);
    this.approved = false;
    this.renderTimeline();
  }

  getStoryboard() {
    return JSON.parse(JSON.stringify(this.storyboard));
  }

  audioOptions() {
    return [...new Set(this.storyboard.scenes.flatMap((scene) => [scene.music, scene.voice]).filter(Boolean))];
  }

  renderTimeline() {
    const root = this.shadowRoot;
    const timeline = root.getElementById('timeline');
    timeline.replaceChildren();
    const audioOptions = this.audioOptions();
    this.storyboard.scenes.forEach((scene, index) => {
      const card = document.createElement('article');
      card.className = 'scene'; card.dataset.index = String(index);
      const number = document.createElement('span'); number.className = 'scene-num'; number.textContent = String(index + 1);
      const main = document.createElement('div'); main.className = 'scene-main';
      const asset = document.createElement('div'); asset.className = 'asset'; asset.title = scene.asset; asset.textContent = basename(scene.asset);
      const caption = document.createElement('input'); caption.className = 'caption'; caption.dataset.field = 'caption'; caption.value = scene.caption; caption.maxLength = 500; caption.placeholder = 'عنوان عربي فوق المشهد…';
      const row = document.createElement('div'); row.className = 'row';
      const durationLabel = document.createElement('label'); durationLabel.textContent = 'المدة ms';
      const duration = document.createElement('input'); duration.className = 'duration'; duration.dataset.field = 'duration_ms'; duration.type = 'number'; duration.min = '250'; duration.max = '120000'; duration.step = '250'; duration.value = String(scene.duration_ms); durationLabel.appendChild(duration);
      const transitionLabel = document.createElement('label'); transitionLabel.textContent = 'الانتقال';
      const transition = document.createElement('select'); transition.dataset.field = 'transition';
      for (const value of ['cut', 'fade']) { const option = document.createElement('option'); option.value = value; option.textContent = value === 'fade' ? 'تلاشي' : 'قطع'; transition.appendChild(option); }
      transition.value = scene.transition; transitionLabel.appendChild(transition);
      const musicLabel = document.createElement('label'); musicLabel.textContent = 'الموسيقى';
      const music = document.createElement('select'); music.className = 'music'; music.dataset.field = 'music';
      const none = document.createElement('option'); none.value = ''; none.textContent = 'بدون'; music.appendChild(none);
      for (const value of audioOptions) { const option = document.createElement('option'); option.value = value; option.textContent = basename(value); music.appendChild(option); }
      music.value = scene.music; musicLabel.appendChild(music);
      const voiceLabel = document.createElement('label'); voiceLabel.textContent = 'التعليق';
      const voice = document.createElement('select'); voice.className = 'music'; voice.dataset.field = 'voice';
      const noVoice = document.createElement('option'); noVoice.value = ''; noVoice.textContent = 'بدون'; voice.appendChild(noVoice);
      for (const value of audioOptions) { const option = document.createElement('option'); option.value = value; option.textContent = basename(value); voice.appendChild(option); }
      voice.value = scene.voice; voiceLabel.appendChild(voice);
      const actions = document.createElement('div'); actions.className = 'scene-actions';
      for (const [action, label, title] of [['up', '↑', 'تحريك لأعلى'], ['down', '↓', 'تحريك لأسفل'],
        ['rerecord', this.rerecording && this.rerecordIndex === index ? '⏹' : '⏺', this.rerecording && this.rerecordIndex === index ? 'إيقاف إعادة التسجيل' : 'إعادة تسجيل المشهد'],
        ['remove', '✕', 'حذف المشهد']]) {
        const button = document.createElement('button'); button.type = 'button'; button.dataset.action = action; button.textContent = label; button.title = title; actions.appendChild(button);
      }
      row.append(durationLabel, transitionLabel, musicLabel, voiceLabel, actions);
      main.append(asset, caption, row); card.append(number, main); timeline.appendChild(card);
    });
    root.getElementById('empty').hidden = this.storyboard.scenes.length > 0;
    root.getElementById('aspect').textContent = this.storyboard.aspect;
    const size = ASPECT_SIZE[this.storyboard.aspect];
    const canvas = root.getElementById('canvas'); canvas.width = size.width; canvas.height = size.height;
    this.syncApproval();
  }

  changed() {
    this.approved = false;
    this.renderTimeline();
  }

  syncApproval() {
    const approve = this.shadowRoot.getElementById('approve');
    approve.classList.toggle('approved', this.approved);
    approve.textContent = this.approved ? 'معتمد ✓' : 'اعتماد الخط الزمني';
    approve.disabled = this.rendering || !this.storyboard.scenes.length;
    this.shadowRoot.getElementById('render').disabled = !this.approved || this.rendering || !this.storyboard.scenes.length;
  }

  handleEdit(event) {
    const field = event.target && event.target.dataset && event.target.dataset.field;
    const card = event.target && event.target.closest('.scene');
    const index = card ? Number(card.dataset.index) : -1;
    const scene = this.storyboard.scenes[index];
    if (!scene || !field) return;
    if (field === 'duration_ms') scene.duration_ms = Math.max(250, Math.min(120000, Math.round(Number(event.target.value) || 250)));
    else scene[field] = String(event.target.value || '').slice(0, field === 'caption' ? 500 : 4096);
    this.approved = false;
    this.syncApproval();
  }

  handleAction(event) {
    const button = event.target && event.target.closest('button[data-action]');
    const card = button && button.closest('.scene');
    const index = card ? Number(card.dataset.index) : -1;
    if (!button || !this.storyboard.scenes[index]) return;
    const action = button.dataset.action;
    if (action === 'up' && index > 0) [this.storyboard.scenes[index - 1], this.storyboard.scenes[index]] = [this.storyboard.scenes[index], this.storyboard.scenes[index - 1]];
    else if (action === 'down' && index + 1 < this.storyboard.scenes.length) [this.storyboard.scenes[index + 1], this.storyboard.scenes[index]] = [this.storyboard.scenes[index], this.storyboard.scenes[index + 1]];
    else if (action === 'remove') this.storyboard.scenes.splice(index, 1);
    else if (action === 'rerecord') {
      if (this.rerecording && this.rerecordIndex === index) {
        window.satr.promoCaptureStop().catch(() => {});
        this.shadowRoot.getElementById('status').textContent = 'جارٍ إيقاف المقطع وحفظه في Downloads…';
        return;
      }
      this.rerecordIndex = index;
      window.satr.promoCaptureStart(this.storyboard.aspect, '', true).catch(() => {});
      this.shadowRoot.getElementById('status').textContent = 'بدأت إعادة التسجيل؛ أوقفها من زر ⏹ في المعاينة.';
      return;
    } else return;
    this.changed();
  }

  async resolvedScenes() {
    const cache = new Map();
    const resolve = async (asset) => {
      if (!asset) return '';
      if (cache.has(asset)) return cache.get(asset);
      const result = await window.satr.promoAssetUrl(asset);
      if (!result || !result.ok) throw new Error('bad_asset');
      cache.set(asset, result.url);
      return result.url;
    };
    const scenes = [];
    for (const scene of this.storyboard.scenes) scenes.push({
      ...scene, src: await resolve(scene.asset), musicSrc: await resolve(scene.music), voiceSrc: await resolve(scene.voice),
    });
    return scenes;
  }

  async render() {
    if (!this.approved || this.rendering) throw new Error('approval_required');
    this.rendering = true;
    this.abortController = new AbortController();
    this.syncApproval();
    const root = this.shadowRoot;
    const status = root.getElementById('status');
    const progress = root.getElementById('progress');
    status.textContent = 'جارٍ التصيير الفوري… إبقاء الاستوديو مفتوحاً مطلوب.';
    try {
      const styles = getComputedStyle(this);
      const result = await renderStoryboard({
        canvas: root.getElementById('canvas'), scenes: await this.resolvedScenes(), signal: this.abortController.signal,
        colors: { background: styles.getPropertyValue('--bg-deep'), captionBackground: styles.getPropertyValue('--scrim'), captionText: styles.getPropertyValue('--text') },
        onProgress: (value) => { progress.style.width = Math.min(100, value.elapsed_ms / value.total_ms * 100).toFixed(2) + '%'; },
      });
      const timestamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
      const filename = 'satr-promo-final-' + timestamp + '.' + result.format.ext;
      const url = URL.createObjectURL(result.blob);
      const anchor = document.createElement('a'); anchor.href = url; anchor.download = filename;
      document.body.appendChild(anchor); anchor.click(); anchor.remove(); setTimeout(() => URL.revokeObjectURL(url), 10000);
      status.textContent = 'اكتمل التصيير إلى Downloads: ' + filename;
      progress.style.width = '100%';
      this.dispatchEvent(new CustomEvent('promo-rendered', { bubbles: true,
        detail: { ...result, blob: undefined, bytes: result.blob.size, filename } }));
      return result;
    } catch (error) {
      status.textContent = error && error.message === 'render_cancelled' ? 'أُلغي التصيير.' : 'تعذّر التصيير. افحص المقاطع والصوت المحلي.';
      throw error;
    } finally {
      this.rendering = false;
      this.abortController = null;
      this.syncApproval();
    }
  }
}

customElements.define('satr-promo-studio', SatrPromoStudio);
