// <satr-promo-studio> — خط زمني بشري ومُصيّر فوري صفري الاعتماديات لإعلانات المنتج.
import { sheet } from '../lib/sheet.js';
import { renderStoryboard } from '../lib/promo-renderer.js';
import { buildTimeline, MAX_TOTAL_MS } from '../lib/promo/promo-timeline.js';
import { renderFrame } from '../lib/promo/promo-frame.js';
import { pointerTrack, idleGaps } from '../lib/promo/promo-camera.js';
import { TEXT_ANIMATIONS } from '../lib/promo/promo-text.js';
import { safeArea } from '../lib/promo/promo-subtitles.js';
import { EXPORT_PRESETS, probeExportSupport } from '../lib/promo-export/encode.js';
import { buildStageRows, cleanStage, cleanRedactions, suggestRedactions, TRANSITION_IN_VALUES, MAX_REDACTIONS } from '../lib/promo/studio-stage.js';
import { buildTimeline as timelineOf } from '../lib/promo/promo-timeline.js';
import { exportStoryboard, exportGif, renderThumbnail } from '../lib/promo-export/export.js';
import { GIF_MAX_MS } from '../lib/promo-export/gif.js';
import { TEMPLATES, templateById, applyTemplate, applyBrand } from '../lib/promo/promo-templates.js';
import { CAMERA_CSS, buildCameraRow, cleanCamera, suggestCamera, addKeyframe, editKeyframe, shiftKeyframes } from '../lib/promo/studio-camera.js';

// ألوان الرسم على canvas — **من tokens الثيمة أولاً**، لأن المعاينة يجب أن تطابق
// التصيير النهائي الذي يقرأ الـtokens نفسها. والاحتياطات الصلبة هنا ضرورة تقنية لا
// تنسيق: `getPropertyValue` قد يعيد سلسلة فارغة قبل تبنّي الأوراق، و`fillStyle`
// الفارغ يُسقط الرسم صامتاً. جُمّعت في موضع واحد موثّق بدل تكرارها في ستة أسطر.
const CANVAS_FALLBACK = Object.freeze({
  background: '#000000', scrim: 'rgba(0,0,0,0.45)', text: '#ffffff', muted: '#444444', error: '#222222',
});

function canvasColors(styles) {
  const pick = (name, fallback) => (styles.getPropertyValue(name) || '').trim() || fallback;
  return {
    background: pick('--bg-deep', CANVAS_FALLBACK.background),
    captionBackground: pick('--scrim', CANVAS_FALLBACK.scrim),
    captionText: pick('--text', CANVAS_FALLBACK.text),
    accent: pick('--gold', CANVAS_FALLBACK.text),
    // ألوان إطارات الأجهزة من رموز التصميم نفسها.
    chrome: {
      body: pick('--surface-2', CANVAS_FALLBACK.error), bar: pick('--surface', CANVAS_FALLBACK.error),
      pill: pick('--bg', CANVAS_FALLBACK.background), text: pick('--text-dim', CANVAS_FALLBACK.text),
      dots: [pick('--red', CANVAS_FALLBACK.text), pick('--gold', CANVAS_FALLBACK.text), pick('--green', CANVAS_FALLBACK.text)],
      shadow: pick('--scrim', CANVAS_FALLBACK.scrim),
    },
    muted: pick('--text-faint', CANVAS_FALLBACK.muted),
    error: pick('--surface-2', CANVAS_FALLBACK.error),
  };
}

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
  .highlight { width: 110px; unicode-bidi: plaintext; }
  .project { display: grid; gap: var(--space-2); padding: var(--space-3); border: 1px solid var(--gold-border); border-radius: var(--radius-lg); background: var(--surface); }
  .project h3 { margin: var(--space-0); font-size: 13px; color: var(--gold-strong); }
  .project .closing { flex: 1; min-width: 160px; unicode-bidi: plaintext; }
  .duration { width: 92px; direction: ltr; text-align: left; font-family: var(--mono); }
  .trim { width: 92px; direction: ltr; text-align: left; font-family: var(--mono); }
  .fit, .position, .style { min-width: 92px; }
  .music { min-width: 150px; max-width: 260px; direction: ltr; }
  .volume { width: 56px; direction: ltr; text-align: left; font-family: var(--mono); }
  .volume-row input[type=range] { width: 110px; direction: ltr; }
  .scene-actions { margin-inline-start: auto; display: flex; gap: var(--space-1); }
  .scene-actions button { padding: var(--space-1) var(--space-2); }
  .preview { min-height: 0; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: var(--space-2); border: 1px solid var(--border); border-radius: var(--radius-lg); background: var(--bg); overflow: hidden; padding: var(--space-3); }
  canvas { display: block; max-width: 100%; max-height: 58vh; width: auto; height: auto; background: var(--bg-deep); box-shadow: var(--shadow-pop); }
  .scrub { width: 100%; display: flex; align-items: center; gap: var(--space-2); direction: ltr; }
  .scrub input[type=range] { flex: 1; direction: ltr; }
  .scrub time { font: 12px var(--mono); color: var(--text-dim); direction: ltr; min-width: 72px; text-align: center; }
  .empty { color: var(--text-faint); text-align: center; padding: var(--space-6); }
  .missing { color: var(--red); font-size: 12px; }
  .scene.missing-asset { border-color: var(--red-border); background: var(--red-soft); opacity: .75; }
  .status { flex: 1; color: var(--text-dim); font-size: 12px; unicode-bidi: plaintext; }
  .progress { width: min(230px, 32vw); height: var(--space-2); overflow: hidden; border-radius: var(--radius-pill); background: var(--surface-2); }
  .progress span { display: block; width: 0; height: 100%; background: var(--gold); transition: width var(--dur) linear; }
  #approve.approved { color: var(--green); border-color: var(--green-border); background: var(--green-soft); }
  #render { background: var(--gold); color: var(--on-gold); border-color: var(--gold); font-weight: 700; }
  .import-dialog { display: none; position: fixed; inset: var(--space-0); z-index: calc(var(--z-modal) + 1); direction: rtl; }
  .import-dialog[open] { display: block; }
  .import-backdrop { position: absolute; inset: var(--space-0); background: var(--scrim); }
  .import-panel { position: absolute; inset: var(--space-6); max-width: 720px; margin: auto; display: grid; grid-template-rows: auto minmax(0, 1fr) auto; border: 1px solid var(--border); border-radius: var(--radius-xl); background: var(--bg-deep); overflow: hidden; }
  .import-panel header { display: flex; align-items: center; gap: var(--space-2); padding: var(--space-3) var(--space-4); border-bottom: 1px solid var(--border); background: var(--surface); }
  .import-panel h3 { flex: 1; margin: var(--space-0); font-size: 16px; }
  .import-list { overflow: auto; padding: var(--space-3); display: grid; gap: var(--space-2); }
  .import-item { display: flex; align-items: center; gap: var(--space-3); padding: var(--space-2) var(--space-3); border: 1px solid var(--border); border-radius: var(--radius-md); background: var(--surface); cursor: pointer; }
  .import-item:hover { border-color: var(--gold); }
  .import-item .name { flex: 1; direction: ltr; text-align: left; unicode-bidi: plaintext; font: 12px var(--mono); }
  .import-item .type { color: var(--text-dim); font-size: 11px; }
  .import-panel footer { display: flex; align-items: center; gap: var(--space-2); padding: var(--space-3) var(--space-4); border-top: 1px solid var(--border); background: var(--surface); }
  #importStatus { flex: 1; color: var(--text-dim); font-size: 12px; }
  @media (max-width: 860px) {
    .studio { inset: var(--space-2); }
    .body { grid-template-columns: 1fr; overflow: auto; }
    .timeline { overflow: visible; }
    .preview { min-height: 280px; }
    .import-panel { inset: var(--space-2); }
  }
` + CAMERA_CSS);

const MARKUP = `
  <div class="backdrop"></div>
  <section class="studio" role="document">
    <header><h2>🎬 استوديو البرومو</h2><span id="aspect" dir="ltr">16:9</span><select id="aspectSelect" aria-label="قالب المقاس"><option value="16:9">يوتيوب / X عرضي</option><option value="9:16">سناب / تيك توك / ريلز</option><option value="1:1">إنستقرام مربع</option></select><button id="close" type="button" title="إغلاق" aria-label="إغلاق استوديو البرومو">✕</button></header>
    <div class="body">
      <div class="timeline" id="timeline"></div>
      <div class="preview">
        <canvas id="canvas" width="1920" height="1080"></canvas>
        <div class="scrub" id="scrub" hidden><time id="scrubTime">0.0 / 0.0 ث</time><input id="scrubRange" type="range" min="0" max="0" step="50" aria-label="الزمن"></div>
        <div class="empty" id="empty">سجّل مقاطع أو اطلب من الوكيل اقتراح storyboard.</div>
      </div>
    </div>
    <footer>
      <span class="status" id="status">عدّل الخط الزمني ثم اعتمده قبل التصيير.</span>
      <div class="progress" role="progressbar" aria-label="تقدم التصيير"><span id="progress"></span></div>
      <button id="import" type="button">＋ استورد</button>
      <button id="projectSave" type="button">حفظ المشروع</button>
      <button id="projectOpen" type="button">فتح مشروع</button>
      <button id="approve" type="button">اعتماد الخط الزمني</button>
      <select id="quality" aria-label="جودة التصدير"></select>
      <button id="render" type="button" disabled>صيّر MP4</button>
      <button id="gif" type="button" disabled title="GIF بلا صوت: 15 ثانية و720p على الأكثر">GIF</button>
      <button id="thumb" type="button" disabled title="احفظ إطار المعاينة الحالي صورة PNG في Downloads">صورة مصغرة</button>
      <button id="cancel" type="button" hidden>إلغاء التصيير</button>
    </footer>
  </section>
  <div class="import-dialog" id="importDialog" hidden>
    <div class="import-backdrop"></div>
    <div class="import-panel">
      <header><h3>اختر وسيطاً من التنزيلات</h3><button id="importClose" type="button" title="إغلاق" aria-label="إغلاق اختيار الوسيط">✕</button></header>
      <div class="import-list" id="importList"></div>
      <footer><span id="importStatus">جارٍ القراءة…</span><button id="importCancel" type="button">إلغاء</button></footer>
    </div>
  </div>`;

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
    asset_missing: scene.asset_missing === true,
    caption: typeof scene.caption === 'string' ? scene.caption.slice(0, 500) : '',
    duration_ms: Number.isInteger(scene.duration_ms) ? Math.max(250, Math.min(120000, scene.duration_ms)) : 3000,
    transition: scene.transition === 'fade' ? 'fade' : 'cut',
    music: typeof scene.music === 'string' ? scene.music : '',
    music_missing: scene.music_missing === true,
    voice: typeof scene.voice === 'string' ? scene.voice : '',
    voice_missing: scene.voice_missing === true,
    trim_start_ms: Number.isInteger(scene.trim_start_ms) ? Math.max(0, Math.min(120000, scene.trim_start_ms)) : 0,
    stage: cleanStage(scene.stage),
    transition_in: index > 0 && TRANSITION_IN_VALUES.includes(scene.transition_in) ? scene.transition_in : 'none',
    redactions: cleanRedactions(scene.redactions, Number.isInteger(scene.duration_ms) ? Math.max(250, Math.min(120000, scene.duration_ms)) : 3000),
    text_style: {
      animation: TEXT_ANIMATIONS.includes(scene.text_style && scene.text_style.animation) ? scene.text_style.animation : 'none',
      highlight: scene.text_style && typeof scene.text_style.highlight === 'string' ? scene.text_style.highlight.trim().split(/\s+/)[0].slice(0, 60) : '',
    },
    voiceover_ar: typeof scene.voiceover_ar === 'string' ? scene.voiceover_ar.slice(0, 2000) : '',
    subtitles: scene.subtitles === true,
    camera: cleanCamera(scene.camera, Number.isInteger(scene.duration_ms) ? Math.max(250, Math.min(120000, scene.duration_ms)) : 3000),
    fit: scene.fit === 'contain' ? 'contain' : 'cover',
    caption_position: ['top', 'center', 'bottom'].includes(scene.caption_position) ? scene.caption_position : 'bottom',
    caption_style: scene.caption_style === 'minimal' ? 'minimal' : 'box',
    clip_volume: typeof scene.clip_volume === 'number' && Number.isFinite(scene.clip_volume) && !Number.isNaN(scene.clip_volume)
      ? Math.max(0, Math.min(1, scene.clip_volume)) : 1,
    music_volume: typeof scene.music_volume === 'number' && Number.isFinite(scene.music_volume) && !Number.isNaN(scene.music_volume)
      ? Math.max(0, Math.min(1, scene.music_volume)) : 0.34,
    voice_volume: typeof scene.voice_volume === 'number' && Number.isFinite(scene.voice_volume) && !Number.isNaN(scene.voice_volume)
      ? Math.max(0, Math.min(1, scene.voice_volume)) : 1,
  })).filter((scene) => scene.asset) : [];
  const board = { aspect, scenes };
  const brand = cleanBrand(raw.brand);
  if (brand) board.brand = brand;
  return board;
}

// هوية المشروع جهة الواجهة؛ التنقية الملزمة في electron/promostudio.js.
function cleanBrand(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const color = (value) => (/^#[0-9a-fA-F]{6}$/.test(value || '') ? value.toLowerCase() : '');
  const text = (value, max) => (typeof value === 'string' ? value.slice(0, max) : '');
  return { name: text(raw.name, 60), primary: color(raw.primary), secondary: color(raw.secondary), accent: color(raw.accent), closing: text(raw.closing, 120), logo: text(raw.logo, 4096) };
}

function basename(value) {
  return String(value || '').split(/[\\/]/).pop() || '';
}

function formatDuration(totalMs) {
  const totalSeconds = Math.round(totalMs / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes > 0) return `${minutes} د ${seconds.toString().padStart(2, '0')} ث`;
  return `${seconds} ث`;
}

function formatSeconds(totalMs) {
  return (totalMs / 1000).toFixed(1) + ' ث';
}

function loadPreviewVisual(url, assetType) {
  return new Promise((resolve, reject) => {
    if (assetType === 'image') {
      const image = new Image();
      image.decoding = 'async';
      const timer = setTimeout(() => reject(new Error('image_timeout')), 15000);
      const finish = () => { clearTimeout(timer); resolve({ kind: 'image', element: image, width: image.naturalWidth, height: image.naturalHeight }); };
      image.addEventListener('load', finish, { once: true });
      image.addEventListener('error', () => { clearTimeout(timer); reject(new Error('image_failed')); }, { once: true });
      image.src = url;
      if (image.complete) finish();
      return;
    }
    const video = document.createElement('video');
    video.preload = 'auto';
    video.playsInline = true;
    video.muted = true;
    video.src = url;
    video.load();
    const timer = setTimeout(() => reject(new Error('video_timeout')), 15000);
    const finish = () => {
      clearTimeout(timer);
      resolve({ kind: 'video', element: video, width: video.videoWidth, height: video.videoHeight });
    };
    if (video.readyState >= 2) { finish(); return; }
    video.addEventListener('loadeddata', finish, { once: true });
    video.addEventListener('error', () => { clearTimeout(timer); reject(new Error('video_failed')); }, { once: true });
  });
}

function makeSelect(value, field, options) {
  const select = document.createElement('select');
  select.dataset.field = field;
  select.className = field.replace(/_/g, '-');
  for (const item of options) {
    const option = document.createElement('option');
    option.value = item.value;
    option.textContent = item.label;
    select.appendChild(option);
  }
  select.value = value;
  return select;
}

function appendLabel(row, text, control, className) {
  const label = document.createElement('label');
  if (className) label.className = className;
  label.append(document.createTextNode(text), control);
  row.appendChild(label);
  return label;
}

function makeNumber(value, field, className, min, max, step) {
  const input = document.createElement('input');
  input.type = 'number'; input.value = String(value); input.dataset.field = field; input.className = className;
  input.min = String(min); input.max = String(max); input.step = String(step);
  return input;
}

function makeVolume(value, field, labelText) {
  const label = document.createElement('label');
  label.className = 'volume-row'; label.appendChild(document.createTextNode(labelText));
  const range = document.createElement('input');
  range.type = 'range'; range.min = '0'; range.max = '1'; range.step = '0.01';
  range.value = String(value); range.dataset.field = field;
  const number = makeNumber(value, field, 'volume', 0, 1, 0.01);
  label.append(range, number);
  return label;
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
    this.previewTime = 0;
    this.previewCache = new Map();
    this.previewDrawPending = false;
    this.projectPath = '';
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
    root.getElementById('timeline').addEventListener('pointerdown', (event) => this.startKeyDrag(event));
    root.getElementById('cancel').addEventListener('click', () => { if (this.abortController) this.abortController.abort(); });
    root.getElementById('gif').addEventListener('click', () => { this.lastRenderPromise = this.renderGif(); this.lastRenderPromise.catch(() => {}); });
    root.getElementById('thumb').addEventListener('click', () => { this.saveThumbnail().catch(() => {}); });
    const quality = root.getElementById('quality');
    for (const [value, preset] of Object.entries(EXPORT_PRESETS)) {
      const option = document.createElement('option'); option.value = value; option.textContent = preset.label; quality.appendChild(option);
    }
    root.getElementById('aspectSelect').addEventListener('change', (event) => {
      if (this.rendering || !Object.hasOwn(ASPECT_SIZE, event.target.value)) return;
      this.storyboard.aspect = event.target.value;
      this.changed();
    });
    root.getElementById('scrubRange').addEventListener('input', (event) => this.handleScrub(event));
    root.getElementById('import').addEventListener('click', () => this.openImport());
    root.getElementById('importClose').addEventListener('click', () => this.closeImport());
    root.getElementById('importCancel').addEventListener('click', () => this.closeImport());
    root.querySelector('.import-backdrop').addEventListener('click', () => this.closeImport());
    root.getElementById('projectSave').addEventListener('click', () => this.saveProject());
    root.getElementById('projectOpen').addEventListener('click', () => this.openProject());
    document.addEventListener('promo-studio-open', (event) => this.open(event.detail && event.detail.storyboard));
    if (typeof window.satr.onPromoCapture === 'function') window.satr.onPromoCapture((event) => {
      if (!event) return;
      if (event.type === 'storyboard_proposed') this.open(event.storyboard, { proposed: true });
      if (event.type === 'capture_active' && this.rerecordIndex >= 0) { this.rerecording = true; this.renderTimeline(); }
      if (event.type === 'segment_saved' && this.rerecordIndex >= 0 && event.segment) {
        const scene = this.storyboard.scenes[this.rerecordIndex];
        if (scene) {
          scene.asset = event.segment.path; scene.asset_type = 'video';
          scene.duration_ms = event.segment.duration_ms || scene.duration_ms;
        }
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

  // options.proposed: الـstoryboard جاء من اقتراح الوكيل لتوّه (لا من ملف ولا من نداء مباشر).
  async open(storyboard, options) {
    let next = storyboard;
    let fresh = false;
    if (!next && typeof window.satr.promoStudioState === 'function') {
      const state = await window.satr.promoStudioState();
      next = state && state.storyboard;
      if (!next && state && Array.isArray(state.segments) && state.segments.length) {
        fresh = true;
        next = { aspect: state.segments[0].aspect || '16:9', scenes: state.segments.map((segment, index) => ({
          id: 'scene_' + String(index + 1), asset: segment.path, asset_type: 'video', caption: '',
          duration_ms: segment.duration_ms || 3000, transition: index ? 'fade' : 'cut', music: '',
        })) };
      }
    }
    // storyboard مبني للتو من مقاطع مسجَّلة يأخذ كاميرا تلقائية؛ المقترح أو المحمَّل يبقى كما جاء.
    if (next) this.storyboard = cloneStoryboard(next);
    this.selectedKey = null;
    this.brandDraftValue = null;
    this.approved = false;
    this.previewTime = 0;
    this.previewCache.clear();
    this.projectPath = '';
    this.primeEvents(fresh, !!(options && options.proposed));
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

  // ── الهوية والقوالب وGIF والصورة المصغرة (الدفعة 9) ──

  // لون إبراز الكلمة من هوية المشروع إن وُجد، وإلا من سمة الاستوديو.
  withBrand(colors) {
    const accent = this.storyboard.brand && this.storyboard.brand.accent;
    return accent ? { ...colors, accent } : colors;
  }

  projectRoot() {
    return typeof this.getProjectRoot === 'function' ? String(this.getProjectRoot() || '').trim() : '';
  }

  buildProjectCard() {
    const brand = this.storyboard.brand || { name: '', primary: '', secondary: '', accent: '', closing: '', logo: '' };
    const card = document.createElement('article'); card.className = 'project';
    const title = document.createElement('h3'); title.textContent = 'القالب والهوية';
    const templateRow = document.createElement('div'); templateRow.className = 'row';
    const template = makeSelect(this.selectedTemplate || TEMPLATES[0].id, 'template', TEMPLATES.map((item) => ({ value: item.id, label: item.label })));
    template.title = (templateById(template.value) || TEMPLATES[0]).hint;
    const applyButton = document.createElement('button'); applyButton.type = 'button'; applyButton.dataset.action = 'template-apply'; applyButton.textContent = 'طبّق القالب';
    applyButton.title = 'يغيّر المقاس والمسرح وحركة العناوين والانتقالات لكل المشاهد. لا يمس المقاطع ولا النصوص ولا الكاميرا ولا التغبيش.';
    appendLabel(templateRow, 'القالب', template);
    templateRow.appendChild(applyButton);
    const brandRow = document.createElement('div'); brandRow.className = 'row';
    const color = (field, value, fallback) => { const input = document.createElement('input'); input.type = 'color'; input.dataset.field = field; input.value = value || fallback; return input; };
    const name = document.createElement('input'); name.className = 'highlight'; name.dataset.field = 'brand_name'; name.value = brand.name; name.maxLength = 60; name.placeholder = 'اسم العلامة';
    appendLabel(brandRow, 'الهوية', name);
    appendLabel(brandRow, 'أساسي', color('brand_primary', brand.primary, this.themeHex('--bg-deep')));
    appendLabel(brandRow, 'ثانوي', color('brand_secondary', brand.secondary, this.themeHex('--gold')));
    appendLabel(brandRow, 'إبراز', color('brand_accent', brand.accent, this.themeHex('--gold')));
    const logos = [{ value: '', label: 'بلا شعار' }].concat(this.imageOptions().concat(brand.logo && !this.imageOptions().includes(brand.logo) ? [brand.logo] : []).map((value) => ({ value, label: basename(value) })));
    appendLabel(brandRow, 'الشعار', makeSelect(brand.logo, 'brand_logo', logos), 'music-label');
    const closingRow = document.createElement('div'); closingRow.className = 'row';
    const closing = document.createElement('input'); closing.className = 'closing'; closing.dataset.field = 'brand_closing'; closing.value = brand.closing; closing.maxLength = 120;
    closing.placeholder = 'عبارة الختام (تظهر مع الشعار في آخر الإعلان)…';
    closingRow.appendChild(closing);
    for (const [action, label, hint] of [['brand-apply', 'طبّق الهوية', 'يلوّن خلفيات المسرح ويضيف بطاقة ختام إن وُجد شعار وعبارة'],
      ['brand-load', 'حمّل هوية المشروع', 'يقرأ ‎.satr/brand.json من مجلد المشروع الحالي'], ['brand-save', 'احفظها للمشروع', 'يكتب ‎.satr/brand.json في مجلد المشروع الحالي']]) {
      const button = document.createElement('button'); button.type = 'button'; button.dataset.action = action; button.textContent = label; button.title = hint;
      closingRow.appendChild(button);
    }
    card.append(title, templateRow, brandRow, closingRow);
    if (this.rendering) card.querySelectorAll('button, input, select').forEach((control) => { control.disabled = true; });
    return card;
  }

  // حقول الهوية تُحفظ في مسودة على المكوّن؛ لا تغيّر المشاهد حتى «طبّق الهوية».
  brandDraft() {
    if (!this.brandDraftValue) this.brandDraftValue = { ...(this.storyboard.brand || { name: '', primary: '', secondary: '', accent: '', closing: '', logo: '' }) };
    return this.brandDraftValue;
  }

  handleProjectEdit(event) {
    const field = event.target && event.target.dataset ? event.target.dataset.field : '';
    if (!field || this.rendering) return;
    const value = String(event.target.value || '');
    if (field === 'template') { this.selectedTemplate = value; const found = templateById(value); if (found) event.target.title = found.hint; return; }
    const draft = this.brandDraft();
    if (field === 'brand_name') draft.name = value.slice(0, 60);
    else if (field === 'brand_closing') draft.closing = value.slice(0, 120);
    else if (field === 'brand_logo') draft.logo = value;
    else if (field === 'brand_primary' || field === 'brand_secondary' || field === 'brand_accent') draft[field.slice(6)] = /^#[0-9a-fA-F]{6}$/.test(value) ? value.toLowerCase() : '';
  }

  handleProjectAction(event) {
    const button = event.target && event.target.closest('button[data-action]');
    if (!button || this.rendering) return;
    const status = this.shadowRoot.getElementById('status');
    const action = button.dataset.action;
    if (action === 'template-apply') {
      const template = templateById(this.selectedTemplate || TEMPLATES[0].id);
      if (!template || !this.storyboard.scenes.length) return;
      applyTemplate(this.storyboard, template, { primary: this.themeHex('--bg-deep'), secondary: this.themeHex('--gold') });
      this.changed();
      status.textContent = 'طُبّق قالب «' + template.label + '» على ' + this.storyboard.scenes.length + ' مشهداً. راجع المعاينة ثم اعتمد.';
    } else if (action === 'brand-apply') {
      const draft = this.brandDraft();
      // لون لم يختره المستخدم يأخذ قيمة الحقل الظاهرة (لون السمة)، فما يراه هو ما يُطبَّق.
      const card = button.closest('.project');
      for (const key of ['primary', 'secondary', 'accent']) {
        const input = card.querySelector('[data-field="brand_' + key + '"]');
        if (!draft[key] && input) draft[key] = String(input.value || '').toLowerCase();
      }
      const result = applyBrand(this.storyboard, draft);
      this.brandDraftValue = null;
      this.changed();
      status.textContent = result.closing === 'added' ? 'طُبّقت الهوية وأضيفت بطاقة الختام.' : result.closing === 'updated' ? 'طُبّقت الهوية وحُدّثت بطاقة الختام.'
        : draft.closing && !draft.logo ? 'طُبّقت الهوية. بطاقة الختام تحتاج شعاراً من صور المشروع.' : 'طُبّقت الهوية على خلفيات المشاهد.';
    } else if (action === 'brand-load' || action === 'brand-save') {
      this.syncBrandFile(action === 'brand-save').catch(() => {});
    }
  }

  async syncBrandFile(save) {
    const status = this.shadowRoot.getElementById('status');
    const cwd = this.projectRoot();
    const api = save ? window.satr.promoBrandSave : window.satr.promoBrandLoad;
    if (!cwd || typeof api !== 'function') { status.textContent = 'اختر مجلد المشروع أولاً؛ الهوية تُحفظ في ‎.satr/brand.json داخله.'; return null; }
    try {
      const result = save ? await window.satr.promoBrandSave(cwd, this.brandDraft()) : await window.satr.promoBrandLoad(cwd);
      if (!result || !result.ok) throw new Error(result && result.error ? result.error : 'brand_failed');
      if (save) status.textContent = 'حُفظت هوية المشروع في ‎.satr/brand.json.';
      else if (!result.exists) status.textContent = 'لا ملف هوية في هذا المشروع بعد. املأ الحقول ثم «احفظها للمشروع».';
      else {
        this.brandDraftValue = cleanBrand(result.brand);
        this.storyboard.brand = cleanBrand(result.brand);
        this.renderTimeline();
        status.textContent = 'حُمّلت هوية المشروع. اضغط «طبّق الهوية» لتلوين المشاهد.';
      }
      return result;
    } catch (error) {
      status.textContent = (save ? 'تعذّر حفظ الهوية: ' : 'تعذّر تحميل الهوية: ') + (error && error.message ? error.message : error);
      return null;
    }
  }

  // خيارات التصدير المشتركة بين GIF والصورة المصغرة.
  async exportOptions() {
    const styles = getComputedStyle(this);
    try { await Promise.all([700, 500].map((weight) => document.fonts.load(weight + ' 48px "IBM Plex Sans Arabic"', 'ع A ٢'))); } catch (error) {}
    return {
      scenes: await this.resolvedScenes(), aspect: this.storyboard.aspect, pointers: this.pointerTracks(),
      colors: this.withBrand({ background: styles.getPropertyValue('--bg-deep'), captionBackground: styles.getPropertyValue('--scrim'), captionText: styles.getPropertyValue('--text'), accent: styles.getPropertyValue('--gold'), chrome: canvasColors(styles).chrome }),
      readAsset: (assetPath, offset, length) => window.satr.promoAssetRead(assetPath, offset, length),
    };
  }

  // GIF بلا صوت. يبدأ بنقرة المستخدم وبعد اعتماد الخط الزمني، كالتصيير.
  async renderGif() {
    if (!this.approved || this.rendering) throw new Error('approval_required');
    if (this.hasMissingAssets()) throw new Error('missing_assets');
    this.rendering = true;
    this.abortController = new AbortController();
    this.renderTimeline();
    const root = this.shadowRoot;
    const status = root.getElementById('status'), progress = root.getElementById('progress');
    root.getElementById('cancel').hidden = false;
    status.textContent = 'جارٍ تحضير GIF…';
    let lastHandle = '';
    try {
      const result = await exportGif({
        ...(await this.exportOptions()), signal: this.abortController.signal,
        writer: {
          begin: async (kind) => { const begun = await window.satr.promoExportBegin(kind); if (begun && begun.ok) lastHandle = begun.handle; return begun; },
          chunk: (handle, seq, bytes) => window.satr.promoExportChunk(handle, seq, bytes),
          finish: (handle) => window.satr.promoExportFinish(handle),
          abort: (handle) => window.satr.promoExportAbort(handle),
        },
        onProgress: (value) => {
          progress.style.width = Math.min(100, value.frame / value.frames * 100).toFixed(2) + '%';
          status.textContent = value.stage === 'finalize' ? 'جارٍ إنهاء الملف…' : 'جارٍ تصدير GIF: إطار ' + value.frame + ' من ' + value.frames;
        },
      });
      status.textContent = 'اكتمل GIF إلى Downloads: ' + result.filename + ' (' + (result.bytes / 1048576).toFixed(1) + ' م.ب)';
      progress.style.width = '100%';
      this.dispatchEvent(new CustomEvent('promo-rendered', { bubbles: true, detail: { ...result } }));
      return result;
    } catch (error) {
      if (lastHandle) { try { await window.satr.promoExportAbort(lastHandle); } catch (ignored) {} }
      status.textContent = error && error.message === 'render_cancelled' ? 'أُلغي تصدير GIF.'
        : error && error.message === 'gif_too_long' ? 'GIF محدود بـ15 ثانية.' : 'تعذّر تصدير GIF: ' + String(error && error.message || error).slice(0, 80);
      throw error;
    } finally {
      root.getElementById('cancel').hidden = true;
      this.rendering = false;
      this.abortController = null;
      root.getElementById('timeline').querySelectorAll('button, input, select').forEach((control) => { control.disabled = control.dataset.locked === '1'; });
      this.syncApproval();
    }
  }

  // صورة مصغرة PNG من إطار المعاينة الحالي بمقاس التصدير الكامل، بلا خطوط المساحة الآمنة.
  async saveThumbnail() {
    const status = this.shadowRoot.getElementById('status');
    if (this.rendering || !this.storyboard.scenes.length || this.hasMissingAssets()) return null;
    const button = this.shadowRoot.getElementById('thumb');
    button.disabled = true;
    try {
      const bytes = await renderThumbnail(await this.exportOptions(), this.previewTime);
      const result = await window.satr.promoThumbnailSave(bytes);
      if (!result || !result.ok) throw new Error(result && result.error ? result.error : 'thumbnail_failed');
      status.textContent = 'حُفظت الصورة المصغرة في Downloads: ' + result.filename;
      this.dispatchEvent(new CustomEvent('promo-thumbnail-saved', { bubbles: true, detail: { filename: result.filename, bytes: result.bytes } }));
      return result;
    } catch (error) {
      status.textContent = 'تعذّر حفظ الصورة المصغرة: ' + String(error && error.message || error).slice(0, 80);
      throw error;
    } finally {
      this.syncApproval();
    }
  }

  // ── الإخراج البصري (الدفعة 7) ──

  // صور المشروع الصالحة خلفيةً: أصول المشاهد التي هي صور.
  imageOptions() {
    return [...new Set(this.storyboard.scenes.filter((scene) => scene.asset_type === 'image' && !scene.asset_missing).map((scene) => scene.asset))];
  }

  // رمز لون من السمة بصيغة #rrggbb لحقل input[type=color].
  themeHex(name) {
    const value = getComputedStyle(this).getPropertyValue(name).trim();
    if (/^#[0-9a-fA-F]{6}$/.test(value)) return value.toLowerCase();
    if (/^#[0-9a-fA-F]{3}$/.test(value)) return '#' + value.slice(1).split('').map((c) => c + c).join('').toLowerCase();
    return '#' + '0'.repeat(6);
  }

  // صور خلفيات المسرح المحمَّلة: Map مسار ⇒ { source, width, height }.
  async stageImages() {
    if (!this.stageImageCache) this.stageImageCache = new Map();
    for (const scene of this.storyboard.scenes) {
      const background = scene.stage.background;
      if (background.type !== 'image' || !background.image || this.stageImageCache.has(background.image)) continue;
      try {
        const resolved = await window.satr.promoAssetUrl(background.image);
        if (!resolved || !resolved.ok) throw new Error('bad_asset');
        const image = new Image();
        image.src = resolved.url;
        await image.decode();
        this.stageImageCache.set(background.image, { source: image, width: image.naturalWidth, height: image.naturalHeight });
      } catch { this.stageImageCache.set(background.image, null); }
    }
    return this.stageImageCache;
  }

  // لقطة آخر إطار من مشهد سابق لمعاينة انتقال الدخول. تُحسب عند الطلب وتُخزَّن بمفتاح المشهد.
  async sceneSnapshot(index, canvas, colors, images) {
    const scene = this.storyboard.scenes[index];
    if (!scene || scene.asset_missing) return null;
    if (!this.snapshotCache) this.snapshotCache = new Map();
    const key = canvas.width + 'x' + canvas.height + JSON.stringify(scene);
    if (this.snapshotCache.has(key)) return this.snapshotCache.get(key);
    try {
      const resolved = await window.satr.promoAssetUrl(scene.asset);
      if (!resolved || !resolved.ok) return null;
      const visual = await loadPreviewVisual(resolved.url, scene.asset_type);
      if (visual.kind === 'video' && Number.isFinite(visual.element.duration)) {
        visual.element.currentTime = Math.min(Math.max(0, (scene.trim_start_ms + scene.duration_ms) / 1000 - 0.04), Math.max(0, visual.element.duration - 0.05));
        await new Promise((resolve) => { visual.element.addEventListener('seeked', resolve, { once: true }); setTimeout(resolve, 400); });
      }
      const copy = document.createElement('canvas'); copy.width = canvas.width; copy.height = canvas.height;
      const single = timelineOf({ scenes: [scene] });
      renderFrame(copy.getContext('2d', { alpha: false }), { width: copy.width, height: copy.height, colors, timeline: single, aspect: this.storyboard.aspect, images },
        scene.duration_ms - 1, new Map([[0, { source: visual.element, width: visual.width, height: visual.height }]]));
      if (this.snapshotCache.size > 12) this.snapshotCache.clear();
      this.snapshotCache.set(key, copy);
      return copy;
    } catch { return null; }
  }

  handleStageEdit(scene, index, field, event) {
    const stage = scene.stage;
    const value = event.target.value;
    const numeric = Number(value);
    let rebuild = false;
    if (field === 'stage_frame') { stage.frame = value; rebuild = true; }
    else if (field === 'stage_background') { stage.background.type = value; rebuild = true; }
    else if (field === 'stage_color') stage.background.color = /^#[0-9a-fA-F]{6}$/.test(value) ? value : '';
    else if (field === 'stage_color2') stage.background.color2 = /^#[0-9a-fA-F]{6}$/.test(value) ? value : '';
    else if (field === 'stage_image') stage.background.image = String(value || '');
    else if (field === 'stage_blur') stage.background.blur = Math.max(0, Math.min(40, numeric || 0));
    else if (field === 'stage_scale') stage.scale = Math.max(0.78, Math.min(0.88, (numeric || 84) / 100));
    else if (field === 'stage_tilt_x') stage.tilt.x = Math.max(-25, Math.min(25, numeric || 0));
    else if (field === 'stage_tilt_y') stage.tilt.y = Math.max(-25, Math.min(25, numeric || 0));
    else if (field === 'stage_motion') stage.motion = value === 'orbit' ? 'orbit' : 'none';
    else if (field === 'stage_shadow') stage.shadow = Math.max(0, Math.min(1, numeric || 0));
    else if (field === 'stage_label') stage.label = String(value || '').slice(0, 60);
    else if (field === 'transition_in') scene.transition_in = index > 0 && TRANSITION_IN_VALUES.includes(value) ? value : 'none';
    else if (field.startsWith('redact_')) {
      const row = event.target.closest('[data-redaction]');
      const region = row && scene.redactions[Number(row.dataset.redaction)];
      if (!region || !Number.isFinite(numeric)) return;
      const key = field.slice(7);
      const unit = Math.max(0, Math.min(1, numeric / 100));
      if (key === 'x') region.x = Math.min(unit, 1 - region.width);
      else if (key === 'y') region.y = Math.min(unit, 1 - region.height);
      else if (key === 'width') region.width = Math.max(0.005, Math.min(unit, 1 - region.x));
      else if (key === 'height') region.height = Math.max(0.005, Math.min(unit, 1 - region.y));
      region.auto = false;
    }
    this.approved = false;
    // تغيير نوع الإطار أو الخلفية يبدّل الحقول الظاهرة فيلزم إعادة بناء البطاقة.
    if (rebuild && event.type === 'change') this.renderTimeline();
    else { this.syncApproval(); this.drawPreview(); }
  }

  // تعيد true إن تغيّر المشروع ولزم changed().
  handleRedactAction(action, index, button) {
    const scene = this.storyboard.scenes[index];
    const status = this.shadowRoot.getElementById('status');
    if (action === 'redact-suggest') {
      const regions = suggestRedactions(this.eventsFor(scene), scene);
      if (!regions.length) { status.textContent = 'لا حقول حساسة في سجل هذا المقطع.'; return false; }
      scene.redactions = scene.redactions.filter((item) => !item.auto).concat(regions).slice(0, MAX_REDACTIONS);
      status.textContent = 'غُبّشت ' + regions.length + ' منطقة حساسة. راجع المعاينة: ما لم يُكتشف (بريد أو مفاتيح معروضة نصاً) يُغبَّش يدوياً.';
      return true;
    }
    if (action === 'redact-add') {
      if (scene.redactions.length >= MAX_REDACTIONS) { status.textContent = 'بلغ المشهد حد مناطق التغبيش.'; return false; }
      scene.redactions.push({ x: 0.35, y: 0.42, width: 0.3, height: 0.08, start_ms: 0, end_ms: scene.duration_ms, auto: false });
      return true;
    }
    if (action === 'redact-remove') {
      const at = Number(button.dataset.redaction);
      if (!scene.redactions[at]) return false;
      scene.redactions.splice(at, 1);
      return true;
    }
    return false;
  }

  // ── محرك التصدير (الدفعة 6): ما يدعمه هذا الجهاز لمقاس المشروع ──
  async refreshExportSupport() {
    const aspect = this.storyboard.aspect;
    if (!this.exportSupport) this.exportSupport = new Map();
    if (!this.exportSupport.has(aspect)) {
      let support = { video: {}, audio: false, engine: false };
      try { support = await probeExportSupport(aspect); } catch {}
      // بلا قنوات الكتابة في preload لا محرك جديد مهما دعم المتصفح.
      if (typeof window.satr.promoExportBegin !== 'function' || typeof window.satr.promoAssetRead !== 'function') support.engine = false;
      this.exportSupport.set(aspect, support);
    }
    if (aspect !== this.storyboard.aspect) return;
    const support = this.exportSupport.get(aspect);
    const quality = this.shadowRoot.getElementById('quality');
    for (const option of quality.options) {
      // الخيار غير المدعوم مقفل؛ لا يُخفى كي يعرف المستخدم أنه موجود ولماذا لا يعمل.
      option.disabled = !support.engine || !support.video[option.value];
      option.title = option.disabled ? 'غير مدعوم على هذا الجهاز' : '';
    }
    if (quality.selectedOptions[0] && quality.selectedOptions[0].disabled) quality.value = '1080p30';
    quality.disabled = this.rendering || !support.engine;
    quality.title = support.engine ? 'جودة التصدير' : 'المحرك الجديد غير متاح على هذا الجهاز؛ سيُستعمل التصيير الفوري';
  }

  // التصدير إطاراً بإطار عبر WebCodecs. يعيد النتيجة، أو يرمي إن تعذّر (فيُجرَّب المسار القديم).
  async renderWithEngine(colors, progress, status) {
    let lastHandle = '';
    const writer = {
      begin: async (kind) => { const result = await window.satr.promoExportBegin(kind); if (result && result.ok) lastHandle = result.handle; return result; },
      chunk: (handle, seq, bytes) => window.satr.promoExportChunk(handle, seq, bytes),
      finish: (handle, header) => window.satr.promoExportFinish(handle, header),
      abort: (handle) => window.satr.promoExportAbort(handle),
    };
    try {
      return await exportStoryboard({
        scenes: await this.resolvedScenes(), aspect: this.storyboard.aspect, preset: this.shadowRoot.getElementById('quality').value,
        colors, pointers: this.pointerTracks(), signal: this.abortController.signal, writer,
        readAsset: (assetPath, offset, length) => window.satr.promoAssetRead(assetPath, offset, length),
        onProgress: (value) => {
          progress.style.width = Math.min(100, value.frame / value.frames * 100).toFixed(2) + '%';
          status.textContent = value.stage === 'audio' ? 'جارٍ مزج الصوت…'
            : value.stage === 'finalize' ? 'جارٍ إنهاء الملف…' : 'جارٍ التصدير: إطار ' + value.frame + ' من ' + value.frames;
        },
      });
    } catch (error) {
      if (lastHandle) { try { await window.satr.promoExportAbort(lastHandle); } catch {} }
      throw error;
    }
  }

  // خطوط المساحة الآمنة للمنصة: في المعاينة فقط، ولا تدخل التصدير.
  drawSafeArea(context, canvas, colors) {
    if (this.rendering) return;
    const safe = safeArea(this.storyboard.aspect);
    context.save();
    context.strokeStyle = colors.muted;
    context.lineWidth = Math.max(2, Math.round(canvas.height / 540));
    context.setLineDash([canvas.width / 60, canvas.width / 90]);
    for (const y of [canvas.height * safe.top, canvas.height * (1 - safe.bottom)]) {
      context.beginPath(); context.moveTo(0, Math.round(y)); context.lineTo(canvas.width, Math.round(y)); context.stroke();
    }
    context.restore();
  }

  // ── الكاميرا الذكية (الدفعة 2 من مخرج الإعلانات) ──

  // أحداث مقطع من الذاكرة المؤقتة: مصفوفة، أو null إن لم تُحمَّل أو لم يوجد سجل.
  eventsFor(scene) {
    if (!this.eventCache) this.eventCache = new Map();
    const cached = this.eventCache.get(scene.asset);
    return Array.isArray(cached) ? cached : null;
  }

  // يحمّل سجلات أحداث كل المقاطع مرة، ثم يعيد رسم الخط الزمني. autoPlan: خطّط للمشاهد الجديدة.
  // proposed: اقتراح وكيل — تُملأ الكاميرا التي طلبها تلقائية، وتُغبَّش الحقول الحساسة افتراضياً.
  async primeEvents(autoPlan, proposed) {
    if (!this.eventCache) this.eventCache = new Map();
    if (typeof window.satr.promoSegmentEvents !== 'function') return;
    const token = this.eventToken = (this.eventToken || 0) + 1;
    let loaded = false;
    for (const asset of [...new Set(this.storyboard.scenes.filter((scene) => !scene.asset_missing).map((scene) => scene.asset))]) {
      if (this.eventCache.has(asset)) continue;
      let result = null;
      try { result = await window.satr.promoSegmentEvents(asset); } catch {}
      if (token !== this.eventToken) return;
      this.eventCache.set(asset, result && result.ok && Array.isArray(result.events) ? result.events : false);
      loaded = true;
    }
    if (proposed) {
      for (const scene of this.storyboard.scenes) {
        const events = this.eventsFor(scene);
        if (!events) continue;
        // الوكيل طلب كاميرا تلقائية بلا نقاط: نقاطها تُحسب هنا من سجل أحداث المقطع.
        if (scene.camera.mode === 'auto' && !scene.camera.keyframes.length && events.length) {
          scene.camera = suggestCamera(events, scene);
          loaded = true;
        }
        // الوكيل لا يقرر ما يُكشف من بيانات المستخدم: الحقول الحساسة تُغبَّش، والمستخدم يزيل ما يشاء.
        if (!scene.redactions.length) {
          const regions = suggestRedactions(events, scene);
          if (regions.length) { scene.redactions = regions; loaded = true; }
        }
      }
    }
    if (autoPlan) {
      for (const scene of this.storyboard.scenes) {
        const events = this.eventsFor(scene);
        if (events && events.length && scene.camera.mode === 'off' && !scene.camera.keyframes.length) {
          const planned = suggestCamera(events, scene);
          if (planned.keyframes.length > 1) { scene.camera = planned; loaded = true; }
        }
        // الحقول الحساسة تُغبَّش افتراضياً في المقاطع الجديدة؛ المستخدم يزيل ما لا يريده.
        if (events && !scene.redactions.length) {
          const regions = suggestRedactions(events, scene);
          if (regions.length) { scene.redactions = regions; loaded = true; }
        }
      }
    }
    if (loaded) this.renderTimeline();
  }

  // مسارات المؤشر لكل مشهد كاميرته مفعّلة؛ تُشتق من الأحداث ولا تُحفظ في المشروع.
  pointerTracks() {
    const tracks = new Map();
    this.storyboard.scenes.forEach((scene, index) => {
      if (!scene.camera || scene.camera.mode === 'off' || scene.camera.cursor === false) return;
      const events = this.eventsFor(scene);
      if (events) tracks.set(index, pointerTrack(events, { durationMs: scene.duration_ms, sourceStartMs: scene.trim_start_ms }));
    });
    return tracks;
  }

  // بعد تغيير المدة أو بداية القص: التلقائية تُعاد من الأحداث، واليدوية تُزاح وتُقصّ.
  refreshCamera(scene, shiftMs) {
    // مناطق التغبيش تتبع المشهد: تُزاح مع بداية القص وتُقصّ عند المدة الجديدة.
    scene.redactions = cleanRedactions(scene.redactions.map((item) => ({ ...item, start_ms: item.start_ms - shiftMs, end_ms: item.auto ? scene.duration_ms : item.end_ms - shiftMs })), scene.duration_ms);
    if (!scene.camera) return;
    const events = this.eventsFor(scene);
    if (scene.camera.mode === 'auto' && events) scene.camera = suggestCamera(events, scene);
    else shiftKeyframes(scene.camera, shiftMs, scene.duration_ms);
    this.selectedKey = null;
  }

  handleCameraEdit(scene, index, field, event) {
    const camera = scene.camera;
    if (field === 'camera_mode') {
      const mode = String(event.target.value);
      const events = this.eventsFor(scene);
      if (mode === 'auto') {
        if (!events || !events.length) {
          this.shadowRoot.getElementById('status').textContent = 'لا سجل أحداث لهذا المقطع؛ الكاميرا التلقائية تحتاج مقطعاً سُجّل من سطر.';
          event.target.value = camera.mode;
          return;
        }
        scene.camera = suggestCamera(events, scene);
      } else camera.mode = mode === 'manual' ? 'manual' : 'off';
      this.selectedKey = null;
      this.changed();
      return;
    }
    if (field === 'camera_cursor') { camera.cursor = !!event.target.checked; this.approved = false; this.syncApproval(); this.drawPreview(); return; }
    const selected = this.selectedKey && this.selectedKey.scene === index ? this.selectedKey.key : -1;
    if (selected < 0) return;
    if (!editKeyframe(camera, selected, field.slice(4), Number(event.target.value), scene.duration_ms)) return;
    // لا إعادة بناء للبطاقة أثناء الكتابة كي لا يضيع التركيز؛ نحرّك النقطة ونحدّث المعاينة فقط.
    const card = event.target.closest('.scene');
    const dot = card && card.querySelector('.cam-key[data-key="' + selected + '"]');
    if (dot) dot.style.left = (camera.keyframes[selected].t_ms / scene.duration_ms * 100).toFixed(3) + '%';
    const modeSelect = card && card.querySelector('[data-field="camera_mode"]');
    if (modeSelect) modeSelect.value = camera.mode;
    this.approved = false;
    this.syncApproval();
    this.drawPreview();
  }

  // تعيد true إن تغيّر المشروع ولزم changed().
  handleCameraAction(action, index, button) {
    const scene = this.storyboard.scenes[index];
    const status = this.shadowRoot.getElementById('status');
    if (action === 'key-select') {
      this.selectedKey = { scene: index, key: Number(button.dataset.key) };
      const start = this.storyboard.scenes.slice(0, index).reduce((sum, item) => sum + item.duration_ms, 0);
      const key = scene.camera.keyframes[this.selectedKey.key];
      if (key) this.previewTime = start + key.t_ms;
      this.renderTimeline();
      return false;
    }
    if (action === 'camera-suggest') {
      const events = this.eventsFor(scene);
      if (!events || !events.length) { status.textContent = 'لا سجل أحداث لهذا المقطع.'; return false; }
      scene.camera = suggestCamera(events, scene);
      this.selectedKey = null;
      status.textContent = scene.camera.keyframes.length > 1
        ? 'اقتُرحت كاميرا من ' + scene.camera.keyframes.length + ' نقطة. اسحب النقاط أو احذفها.'
        : 'لا أحداث نقر أو كتابة داخل هذا المشهد؛ الكاميرا ثابتة.';
      return true;
    }
    if (action === 'key-add') {
      const placement = this.sceneAtTime(this.previewTime);
      const local = placement && placement.index === index ? placement.localTime : 0;
      const added = addKeyframe(scene.camera, local, scene.duration_ms);
      if (added < 0) { status.textContent = 'توجد نقطة عند هذا الزمن، أو بلغ المشهد حد النقاط.'; return false; }
      this.selectedKey = { scene: index, key: added };
      return true;
    }
    if (action === 'key-remove') {
      if (!this.selectedKey || this.selectedKey.scene !== index) return false;
      scene.camera.keyframes.splice(this.selectedKey.key, 1);
      scene.camera.mode = 'manual';
      this.selectedKey = null;
      return true;
    }
    if (action === 'cut-gap') {
      const events = this.eventsFor(scene);
      const gap = events && idleGaps(events, { durationMs: scene.duration_ms, sourceStartMs: scene.trim_start_ms })[Number(button.dataset.gap)];
      if (!gap) return false;
      const tail = scene.duration_ms - gap.end_ms;
      if (gap.start_ms < 250) {
        // الخمول في أول المشهد: نقدّم بداية القص فقط.
        scene.trim_start_ms = Math.min(120000, scene.trim_start_ms + gap.end_ms);
        scene.duration_ms = Math.max(250, tail);
        this.refreshCamera(scene, gap.end_ms);
      } else if (tail < 250) {
        scene.duration_ms = gap.start_ms;
        this.refreshCamera(scene, 0);
      } else {
        if (this.storyboard.scenes.length >= 40) { status.textContent = 'بلغ المشروع حد 40 مشهداً؛ لا يمكن التقسيم.'; return false; }
        const rest = JSON.parse(JSON.stringify(scene));
        rest.id = String(scene.id || 'scene').slice(0, 60) + '_cut_' + Date.now().toString(36);
        rest.trim_start_ms = Math.min(120000, scene.trim_start_ms + gap.end_ms);
        rest.duration_ms = tail;
        rest.transition = 'cut';
        scene.duration_ms = gap.start_ms;
        this.storyboard.scenes.splice(index + 1, 0, rest);
        this.refreshCamera(scene, 0);
        this.refreshCamera(rest, gap.end_ms);
      }
      this.selectedKey = null;
      status.textContent = 'قُصّت فترة الخمول. راجع المعاينة.';
      return true;
    }
    return false;
  }

  // سحب نقطة كاميرا أفقياً على شريطها يغيّر زمنها.
  startKeyDrag(event) {
    const dot = event.target && event.target.closest && event.target.closest('.cam-key');
    const card = dot && dot.closest('.scene');
    if (!dot || !card || this.rendering) return;
    const index = Number(card.dataset.index), keyIndex = Number(dot.dataset.key);
    const scene = this.storyboard.scenes[index];
    const strip = dot.parentElement;
    if (!scene || !scene.camera.keyframes[keyIndex]) return;
    let moved = false;
    const move = (moveEvent) => {
      const box = strip.getBoundingClientRect();
      if (!box.width) return;
      const t = (moveEvent.clientX - box.left) / box.width * scene.duration_ms;
      if (!editKeyframe(scene.camera, keyIndex, 't_ms', t, scene.duration_ms)) return;
      moved = true;
      dot.style.left = (scene.camera.keyframes[keyIndex].t_ms / scene.duration_ms * 100).toFixed(3) + '%';
    };
    const end = () => {
      strip.removeEventListener('pointermove', move);
      strip.removeEventListener('pointerup', end);
      strip.removeEventListener('pointercancel', end);
      if (moved) { this.selectedKey = { scene: index, key: keyIndex }; this.changed(); }
    };
    try { strip.setPointerCapture(event.pointerId); } catch {}
    strip.addEventListener('pointermove', move);
    strip.addEventListener('pointerup', end);
    strip.addEventListener('pointercancel', end);
  }

  totalDuration() {
    return this.storyboard.scenes.reduce((sum, scene) => sum + scene.duration_ms, 0);
  }

  sceneAtTime(timeMs) {
    let cursor = 0;
    for (let index = 0; index < this.storyboard.scenes.length; index += 1) {
      const scene = this.storyboard.scenes[index];
      const end = cursor + scene.duration_ms;
      if (timeMs >= cursor && timeMs < end) return { scene, index, localTime: timeMs - cursor, start: cursor };
      cursor = end;
    }
    if (!this.storyboard.scenes.length) return null;
    const last = this.storyboard.scenes[this.storyboard.scenes.length - 1];
    return { scene: last, index: this.storyboard.scenes.length - 1, localTime: last.duration_ms, start: this.totalDuration() - last.duration_ms };
  }

  updateScrub() {
    const root = this.shadowRoot;
    const total = this.totalDuration();
    const scrub = root.getElementById('scrub');
    const range = root.getElementById('scrubRange');
    const time = root.getElementById('scrubTime');
    if (!total) { scrub.hidden = true; return; }
    scrub.hidden = false;
    range.max = String(total);
    range.value = String(Math.min(total, Math.max(0, this.previewTime)));
    time.textContent = formatSeconds(this.previewTime) + ' / ' + formatSeconds(total);
  }

  handleScrub(event) {
    this.previewTime = Number(event.target.value) || 0;
    this.updateScrub();
    this.drawPreview();
  }

  async drawPreview() {
    if (this.previewDrawPending) return;
    this.previewDrawPending = true;
    try {
      await this._drawPreviewFrame();
    } finally {
      this.previewDrawPending = false;
    }
  }

  async _drawPreviewFrame() {
    const root = this.shadowRoot;
    const canvas = root.getElementById('canvas');
    const context = canvas.getContext('2d', { alpha: false });
    const placement = this.sceneAtTime(this.previewTime);
    const styles = getComputedStyle(this);
    const colors = this.withBrand(canvasColors(styles));
    if (!placement) {
      context.fillStyle = colors.background;
      context.fillRect(0, 0, canvas.width, canvas.height);
      return;
    }
    const { scene, localTime } = placement;
    context.fillStyle = colors.background;
    context.fillRect(0, 0, canvas.width, canvas.height);
    if (scene.asset_missing) {
      context.fillStyle = colors.muted;
      context.font = '700 48px "IBM Plex Sans Arabic", sans-serif';
      context.textAlign = 'center';
      context.fillText('الأصل مفقود', canvas.width / 2, canvas.height / 2);
      return;
    }
    if (!scene.asset) return;
    let visual;
    try {
      const resolved = await window.satr.promoAssetUrl(scene.asset);
      if (!resolved || !resolved.ok) throw new Error('bad_asset');
      const cacheKey = scene.asset + '|' + scene.asset_type;
      if (!this.previewCache.has(cacheKey)) this.previewCache.set(cacheKey, await loadPreviewVisual(resolved.url, scene.asset_type));
      visual = this.previewCache.get(cacheKey);
      if (visual.kind === 'video') {
        const target = Math.max(0, (scene.trim_start_ms + localTime) / 1000);
        if (Number.isFinite(visual.element.duration)) {
          visual.element.currentTime = Math.min(target, Math.max(0, visual.element.duration - 0.05));
          await new Promise((resolve) => {
            const onSeeked = () => { visual.element.removeEventListener('seeked', onSeeked); resolve(); };
            visual.element.addEventListener('seeked', onSeeked, { once: true });
            setTimeout(() => { visual.element.removeEventListener('seeked', onSeeked); resolve(); }, 150);
          });
        }
      }
      // الإطار جاهز عند الزمن المطلوب؛ الرسم نفسه في renderFrame المشتركة مع التصدير.
      const timeline = buildTimeline(this.storyboard);
      const images = await this.stageImages();
      const snapshots = new Map();
      if (placement.index > 0 && scene.transition_in !== 'none' && localTime < 600) {
        const snapshot = await this.sceneSnapshot(placement.index - 1, canvas, colors, images);
        if (snapshot) snapshots.set(placement.index, snapshot);
      }
      renderFrame(context, { width: canvas.width, height: canvas.height, colors, timeline, pointers: this.pointerTracks(), aspect: this.storyboard.aspect, images, snapshots },
        placement.start + Math.min(localTime, scene.duration_ms - 0.001),
        new Map([[placement.index, { source: visual.element, width: visual.width, height: visual.height }]]));
      this.drawSafeArea(context, canvas, colors);
    } catch (error) {
      context.fillStyle = colors.error;
      context.fillRect(0, 0, canvas.width, canvas.height);
    }
  }

  async openImport() {
    const root = this.shadowRoot;
    const dialog = root.getElementById('importDialog');
    const list = root.getElementById('importList');
    const status = root.getElementById('importStatus');
    list.replaceChildren();
    dialog.setAttribute('open', '');
    status.textContent = 'جارٍ القراءة…';
    try {
      if (typeof window.satr.promoListDownloads !== 'function') throw new Error('unavailable');
      const result = await window.satr.promoListDownloads(['.mp4', '.webm', '.png', '.jpg', '.jpeg', '.webp']);
      if (!result || !result.ok) throw new Error(result && result.error ? result.error : 'read_failed');
      status.textContent = 'عدد الملفات: ' + result.files.length;
      for (const file of result.files) {
        const item = document.createElement('div');
        item.className = 'import-item';
        item.dataset.path = file.path;
        item.dataset.type = file.type;
        const name = document.createElement('span'); name.className = 'name'; name.textContent = file.name;
        const type = document.createElement('span'); type.className = 'type'; type.textContent = file.type === 'image' ? 'صورة' : file.type === 'video' ? 'فيديو' : 'صوت';
        item.append(name, type);
        item.addEventListener('click', () => { this.addImportedScene(file); this.closeImport(); });
        list.appendChild(item);
      }
    } catch (error) {
      status.textContent = 'تعذّر قراءة التنزيلات: ' + (error && error.message ? error.message : error);
    }
  }

  closeImport() {
    this.shadowRoot.getElementById('importDialog').removeAttribute('open');
  }

  addImportedScene(file) {
    if (file.type === 'audio') return;
    const scene = {
      id: 'scene_' + String(this.storyboard.scenes.length + 1) + '_' + Date.now().toString(36),
      asset: file.path,
      asset_type: file.type === 'image' ? 'image' : 'video',
      caption: '',
      duration_ms: file.type === 'image' ? 3000 : 5000,
      transition: this.storyboard.scenes.length ? 'fade' : 'cut',
      music: '',
      voice: '',
      trim_start_ms: 0,
      fit: 'cover',
      caption_position: 'bottom',
      caption_style: 'box',
      clip_volume: 1,
      music_volume: 0.34,
      voice_volume: 1,
    };
    this.storyboard.scenes.push(scene);
    this.changed();
  }

  async saveProject() {
    if (!this.storyboard.scenes.length) {
      this.shadowRoot.getElementById('status').textContent = 'لا يوجد مشهد لحفظه.';
      return;
    }
    try {
      if (typeof window.satr.promoProjectPick !== 'function' || typeof window.satr.promoProjectSave !== 'function') {
        throw new Error('unavailable');
      }
      const picked = this.projectPath
        ? { ok: true, path: this.projectPath }
        : await window.satr.promoProjectPick('save');
      if (!picked || !picked.ok) return;
      const result = await window.satr.promoProjectSave(picked.path, this.getStoryboard());
      if (!result || !result.ok) throw new Error(result && result.error ? result.error : 'save_failed');
      this.projectPath = result.path;
      this.shadowRoot.getElementById('status').textContent = 'حُفظ المشروع: ' + basename(result.path);
    } catch (error) {
      this.shadowRoot.getElementById('status').textContent = 'تعذّر الحفظ: ' + (error && error.message ? error.message : error);
    }
  }

  async openProject() {
    try {
      if (typeof window.satr.promoProjectPick !== 'function' || typeof window.satr.promoProjectLoad !== 'function') {
        throw new Error('unavailable');
      }
      const picked = await window.satr.promoProjectPick('open');
      if (!picked || !picked.ok) return;
      const result = await window.satr.promoProjectLoad(picked.path);
      if (!result || !result.ok) throw new Error(result && result.error ? result.error : 'load_failed');
      this.storyboard = cloneStoryboard(result.storyboard);
      this.projectPath = picked.path;
      this.approved = false;
      this.previewTime = 0;
      this.previewCache.clear();
      this.renderTimeline();
      const status = this.shadowRoot.getElementById('status');
      if (result.missing && result.missing.length) {
        status.textContent = 'فُتح المشروع مع أصول مفقودة: ' + result.missing.map(basename).join('، ');
      } else {
        status.textContent = 'فُتح المشروع: ' + basename(picked.path);
      }
    } catch (error) {
      this.shadowRoot.getElementById('status').textContent = 'تعذّر الفتح: ' + (error && error.message ? error.message : error);
    }
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
    const audioSelectOptions = [{ value: '', label: 'بدون' }]
      .concat(audioOptions.map((value) => ({ value, label: basename(value) })));
    timeline.appendChild(this.buildProjectCard());
    this.storyboard.scenes.forEach((scene, index) => {
      const card = document.createElement('article');
      card.className = 'scene' + (scene.asset_missing ? ' missing-asset' : ''); card.dataset.index = String(index);
      const number = document.createElement('span'); number.className = 'scene-num'; number.textContent = String(index + 1);
      const main = document.createElement('div'); main.className = 'scene-main';
      const asset = document.createElement('div'); asset.className = 'asset'; asset.title = scene.asset; asset.textContent = basename(scene.asset);
      if (scene.asset_missing) {
        const missing = document.createElement('span'); missing.className = 'missing'; missing.textContent = ' (مفقود)';
        asset.appendChild(missing);
      }
      const caption = document.createElement('input');
      caption.className = 'caption'; caption.dataset.field = 'caption'; caption.value = scene.caption;
      caption.maxLength = 500; caption.placeholder = 'عنوان عربي فوق المشهد…';
      if (scene.asset_missing) caption.disabled = true;

      const primary = document.createElement('div'); primary.className = 'row';
      appendLabel(primary, 'المدة ms', makeNumber(scene.duration_ms, 'duration_ms', 'duration', 250, 120000, 250));
      appendLabel(primary, 'الانتقال', makeSelect(scene.transition, 'transition', [
        { value: 'cut', label: 'قطع' }, { value: 'fade', label: 'تلاشي' },
      ]));
      appendLabel(primary, 'الموسيقى', makeSelect(scene.music, 'music', audioSelectOptions), 'music-label');
      appendLabel(primary, 'التعليق', makeSelect(scene.voice, 'voice', audioSelectOptions), 'music-label');

      const visual = document.createElement('div'); visual.className = 'row';
      appendLabel(visual, 'بداية القص ms', makeNumber(scene.trim_start_ms, 'trim_start_ms', 'trim', 0, 120000, 100));
      appendLabel(visual, 'الملاءمة', makeSelect(scene.fit, 'fit', [
        { value: 'cover', label: 'ملء الإطار' }, { value: 'contain', label: 'احتواء كامل' },
      ]));
      appendLabel(visual, 'موضع العنوان', makeSelect(scene.caption_position, 'caption_position', [
        { value: 'top', label: 'أعلى' }, { value: 'center', label: 'وسط' }, { value: 'bottom', label: 'أسفل' },
      ]));
      appendLabel(visual, 'نمط العنوان', makeSelect(scene.caption_style, 'caption_style', [
        { value: 'box', label: 'صندوق' }, { value: 'minimal', label: 'بسيط' },
      ]));

      const titles = document.createElement('div'); titles.className = 'row';
      appendLabel(titles, 'حركة العنوان', makeSelect(scene.text_style.animation, 'text_animation', [
        { value: 'none', label: 'ثابت' }, { value: 'words', label: 'كلمة بكلمة' },
        { value: 'slide', label: 'انزلاق' }, { value: 'zoom', label: 'تكبير خفيف' },
      ]));
      const highlight = document.createElement('input');
      highlight.className = 'highlight'; highlight.dataset.field = 'text_highlight'; highlight.value = scene.text_style.highlight;
      highlight.maxLength = 60; highlight.placeholder = 'كلمة';
      appendLabel(titles, 'إبراز كلمة', highlight);
      const subtitles = document.createElement('input');
      subtitles.type = 'checkbox'; subtitles.dataset.field = 'subtitles'; subtitles.checked = scene.subtitles;
      appendLabel(titles, 'ترجمة على الشاشة', subtitles);
      const voiceover = document.createElement('input');
      voiceover.className = 'caption'; voiceover.dataset.field = 'voiceover_ar'; voiceover.value = scene.voiceover_ar;
      voiceover.maxLength = 2000; voiceover.placeholder = 'نص التعليق الصوتي لهذا المشهد (يُعرض ترجمةً على الشاشة)…';

      const volumes = document.createElement('div'); volumes.className = 'row';
      volumes.append(
        makeVolume(scene.clip_volume, 'clip_volume', 'صوت المقطع'),
        makeVolume(scene.music_volume, 'music_volume', 'الموسيقى'),
        makeVolume(scene.voice_volume, 'voice_volume', 'التعليق'),
      );

      const actions = document.createElement('div'); actions.className = 'scene-actions';
      for (const [action, label, title] of [['up', '↑', 'تحريك لأعلى'], ['down', '↓', 'تحريك لأسفل'],
        ['duplicate', '⧉', 'تكرار المشهد'],
        ['rerecord', this.rerecording && this.rerecordIndex === index ? '⏹' : '⏺', this.rerecording && this.rerecordIndex === index ? 'إيقاف إعادة التسجيل' : 'إعادة تسجيل المشهد'],
        ['remove', '✕', 'حذف المشهد']]) {
        const button = document.createElement('button');
        button.type = 'button'; button.dataset.action = action; button.textContent = label; button.title = title;
        actions.appendChild(button);
      }
      primary.appendChild(actions);
      main.append(asset, caption, primary, visual, titles, voiceover, volumes);
      if (!scene.asset_missing) {
        const events = this.eventsFor(scene);
        main.appendChild(buildCameraRow(scene, {
          selected: this.selectedKey && this.selectedKey.scene === index ? this.selectedKey.key : -1,
          hasEvents: !!(events && events.length),
          gaps: events ? idleGaps(events, { durationMs: scene.duration_ms, sourceStartMs: scene.trim_start_ms }) : [],
        }));
      }
      if (!scene.asset_missing) {
        const events = this.eventsFor(scene);
        main.appendChild(buildStageRows(scene, {
          imageOptions: this.imageOptions(), isFirst: index === 0,
          fallbackColor: this.themeHex('--bg-deep'), fallbackColor2: this.themeHex('--gold'),
          canSuggestRedactions: !!(events && events.some((event) => event.sensitive === true)),
        }));
      }
      card.append(number, main); timeline.appendChild(card);
      // عناصر عطّلها صف الكاميرا عمداً (data-locked) تبقى معطّلة.
      if (this.rendering) card.querySelectorAll('button, input, select').forEach((control) => { control.disabled = true; });
    });
    root.getElementById('empty').hidden = this.storyboard.scenes.length > 0;
    root.getElementById('aspect').textContent = this.storyboard.aspect;
    root.getElementById('aspectSelect').value = this.storyboard.aspect;
    root.getElementById('aspectSelect').disabled = this.rendering;
    this.refreshExportSupport();
    const size = ASPECT_SIZE[this.storyboard.aspect];
    const canvas = root.getElementById('canvas'); canvas.width = size.width; canvas.height = size.height;
    this.previewCache.clear();
    this.previewTime = Math.min(this.previewTime, this.totalDuration());
    this.updateScrub();
    this.updateStatus();
    this.syncApproval();
    this.drawPreview();
  }

  updateStatus() {
    if (this.rendering) return;
    const total = this.storyboard.scenes.reduce((sum, scene) => sum + scene.duration_ms, 0);
    // سقف الإعلان يُفرض في main أيضاً؛ هنا نشرحه قبل أن يصطدم به المستخدم عند الحفظ.
    this.shadowRoot.getElementById('status').textContent = total > MAX_TOTAL_MS
      ? 'المدة الإجمالية ' + formatDuration(total) + ' تتجاوز الحد (' + formatDuration(MAX_TOTAL_MS) + '). قصّر المشاهد أو احذف بعضها.'
      : this.storyboard.scenes.length
      ? 'المدة الإجمالية: ' + formatDuration(total) + ' · عدّل الخط الزمني ثم اعتمده.'
      : 'أضف مشهداً أو اطلب من الوكيل اقتراح storyboard.';
  }

  changed() {
    this.approved = false;
    this.renderTimeline();
  }

  hasMissingAssets() {
    return this.storyboard.scenes.some((scene) => scene.asset_missing);
  }

  syncApproval() {
    const approve = this.shadowRoot.getElementById('approve');
    const hasMissing = this.hasMissingAssets() || buildTimeline(this.storyboard).overLimit;
    approve.classList.toggle('approved', this.approved);
    approve.textContent = this.approved ? 'معتمد ✓' : 'اعتماد الخط الزمني';
    approve.disabled = this.rendering || !this.storyboard.scenes.length || hasMissing;
    this.shadowRoot.getElementById('render').disabled = !this.approved || this.rendering || !this.storyboard.scenes.length || hasMissing;
    // GIF والصورة المصغرة يمران بكاتب main، فيلزمهما المحرك الجديد. GIF بعد الاعتماد كالتصيير.
    const engine = typeof window.satr.promoExportBegin === 'function' && typeof window.satr.promoAssetRead === 'function';
    const gif = this.shadowRoot.getElementById('gif'), thumb = this.shadowRoot.getElementById('thumb');
    const tooLong = this.totalDuration() > GIF_MAX_MS;
    gif.disabled = !engine || !this.approved || this.rendering || !this.storyboard.scenes.length || hasMissing || tooLong;
    gif.title = tooLong ? 'GIF محدود بـ15 ثانية؛ هذا الإعلان أطول' : 'GIF بلا صوت: 15 ثانية و720p على الأكثر';
    thumb.disabled = !engine || this.rendering || !this.storyboard.scenes.length || hasMissing || typeof window.satr.promoThumbnailSave !== 'function';
  }

  handleEdit(event) {
    if (event.target && event.target.closest && event.target.closest('.project')) { this.handleProjectEdit(event); return; }
    const field = event.target && event.target.dataset && event.target.dataset.field;
    const card = event.target && event.target.closest('.scene');
    const index = card ? Number(card.dataset.index) : -1;
    const scene = this.storyboard.scenes[index];
    if (!scene || !field || this.rendering) return;
    if (field.startsWith('camera_') || field.startsWith('key_')) { this.handleCameraEdit(scene, index, field, event); return; }
    if (field.startsWith('stage_') || field.startsWith('redact_') || field === 'transition_in') { this.handleStageEdit(scene, index, field, event); return; }
    if (field === 'duration_ms') {
      scene.duration_ms = Math.max(250, Math.min(120000, Math.round(Number(event.target.value) || 250)));
      this.refreshCamera(scene, 0);
    } else if (field === 'trim_start_ms') {
      const before = scene.trim_start_ms;
      scene.trim_start_ms = Math.max(0, Math.min(120000, Math.round(Number(event.target.value) || 0)));
      this.refreshCamera(scene, scene.trim_start_ms - before);
    }
    else if (field === 'clip_volume' || field === 'music_volume' || field === 'voice_volume') {
      scene[field] = Math.max(0, Math.min(1, Number(event.target.value) || 0));
      card.querySelectorAll(`[data-field="${field}"]`).forEach((control) => {
        if (control !== event.target) control.value = String(scene[field]);
      });
    } else if (field === 'caption') scene.caption = String(event.target.value || '').slice(0, 500);
    else if (field === 'text_animation') scene.text_style.animation = TEXT_ANIMATIONS.includes(event.target.value) ? event.target.value : 'none';
    else if (field === 'text_highlight') scene.text_style.highlight = String(event.target.value || '').trim().split(/\s+/)[0].slice(0, 60);
    else if (field === 'voiceover_ar') scene.voiceover_ar = String(event.target.value || '').slice(0, 2000);
    else if (field === 'subtitles') scene.subtitles = !!event.target.checked;
    else if (field === 'music' || field === 'voice') scene[field] = String(event.target.value || '').slice(0, 4096);
    else scene[field] = String(event.target.value || '');
    this.approved = false;
    this.updateStatus();
    this.syncApproval();
  }

  handleAction(event) {
    if (event.target && event.target.closest && event.target.closest('.project')) { this.handleProjectAction(event); return; }
    const button = event.target && event.target.closest('button[data-action]');
    const card = button && button.closest('.scene');
    const index = card ? Number(card.dataset.index) : -1;
    if (!button || !this.storyboard.scenes[index] || this.rendering) return;
    const action = button.dataset.action;
    if (action === 'up' && index > 0) [this.storyboard.scenes[index - 1], this.storyboard.scenes[index]] = [this.storyboard.scenes[index], this.storyboard.scenes[index - 1]];
    else if (action === 'down' && index + 1 < this.storyboard.scenes.length) [this.storyboard.scenes[index + 1], this.storyboard.scenes[index]] = [this.storyboard.scenes[index], this.storyboard.scenes[index + 1]];
    else if (action === 'duplicate' && this.storyboard.scenes.length < 40) {
      const copy = JSON.parse(JSON.stringify(this.storyboard.scenes[index]));
      const base = String(copy.id || 'scene').slice(0, 60);
      copy.id = base + '_copy_' + Date.now().toString(36);
      this.storyboard.scenes.splice(index + 1, 0, copy);
    } else if (action === 'remove') { this.storyboard.scenes.splice(index, 1); this.selectedKey = null; }
    else if (action === 'redact-suggest' || action === 'redact-add' || action === 'redact-remove') {
      if (!this.handleRedactAction(action, index, button)) return;
    }
    else if (action === 'camera-suggest' || action === 'key-add' || action === 'key-select' || action === 'key-remove' || action === 'cut-gap') {
      if (!this.handleCameraAction(action, index, button)) return;
    }
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
      stageImageSrc: scene.stage.background.type === 'image' && scene.stage.background.image ? await resolve(scene.stage.background.image).catch(() => '') : '',
    });
    return scenes;
  }

  // المسار القديم: تسجيل اللوحة بزمن حقيقي عبر MediaRecorder. يبقى احتياطياً (قيد الخطة 7).
  async renderLegacy(styles, progress) {
    const root = this.shadowRoot;
    const result = await renderStoryboard({
      canvas: root.getElementById('canvas'), scenes: await this.resolvedScenes(), signal: this.abortController.signal,
      pointers: this.pointerTracks(), aspect: this.storyboard.aspect, images: await this.stageImages(),
      colors: this.withBrand({ background: styles.getPropertyValue('--bg-deep'), captionBackground: styles.getPropertyValue('--scrim'), captionText: styles.getPropertyValue('--text'), accent: styles.getPropertyValue('--gold'), chrome: canvasColors(styles).chrome }),
      onProgress: (value) => { progress.style.width = Math.min(100, value.elapsed_ms / value.total_ms * 100).toFixed(2) + '%'; },
    });
    const timestamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
    const filename = 'satr-promo-final-' + timestamp + '.' + result.format.ext;
    const url = URL.createObjectURL(result.blob);
    const anchor = document.createElement('a'); anchor.href = url; anchor.download = filename;
    document.body.appendChild(anchor); anchor.click(); anchor.remove(); setTimeout(() => URL.revokeObjectURL(url), 10000);
    return { ...result, filename };
  }

  async render() {
    if (!this.approved || this.rendering) throw new Error('approval_required');
    if (this.hasMissingAssets()) throw new Error('missing_assets');
    this.rendering = true;
    this.abortController = new AbortController();
    this.renderTimeline();
    const root = this.shadowRoot;
    const status = root.getElementById('status');
    const progress = root.getElementById('progress');
    status.textContent = 'جارٍ التحضير للتصدير…';
    root.getElementById('cancel').hidden = false;
    try {
      const styles = getComputedStyle(this);
      // العناوين تُقاس بالخط نفسه في DOM واللوحة؛ خط لم يُحمَّل بعد يُسقط حارس التطابق.
      try {
        await Promise.all([700, 500].map((weight) => document.fonts.load(weight + ' 48px "IBM Plex Sans Arabic"', 'ع A ٢')));
      } catch (error) {}
      const colors = this.withBrand({ background: styles.getPropertyValue('--bg-deep'), captionBackground: styles.getPropertyValue('--scrim'), captionText: styles.getPropertyValue('--text'), accent: styles.getPropertyValue('--gold'), chrome: canvasColors(styles).chrome });
      // الفحص غير متزامن ويبدأ عند فتح الاستوديو؛ ننتظره هنا كي لا يسبقه ضغط «صيّر».
      await this.refreshExportSupport();
      const support = this.exportSupport && this.exportSupport.get(this.storyboard.aspect);
      let result = null, filename = '', engineNote = '';
      if (support && support.engine && !this.forceLegacyExport) {
        try {
          result = await this.renderWithEngine(colors, progress, status);
          filename = result.filename;
        } catch (error) {
          if (error && error.message === 'render_cancelled') throw error;
          // المحرك الجديد تعذّر بعد إعادة المحاولة برمجياً: المسار القديم يبقى صمام الأمان.
          engineNote = ' (استُعمل التصيير الفوري: ' + String(error && error.message || error).slice(0, 60) + ')';
          progress.style.width = '0';
        }
      } else if (!this.forceLegacyExport) engineNote = ' (هذا الجهاز لا يدعم التصدير السريع؛ استُعمل التصيير الفوري)';
      if (!result) {
        status.textContent = 'جارٍ التصيير الفوري… إبقاء الاستوديو مفتوحاً مطلوب.';
        result = await this.renderLegacy(styles, progress);
        filename = result.filename;
      }
      status.textContent = 'اكتمل التصيير إلى Downloads: ' + filename + engineNote;
      progress.style.width = '100%';
      this.dispatchEvent(new CustomEvent('promo-rendered', { bubbles: true,
        detail: { ...result, blob: undefined, bytes: result.blob ? result.blob.size : result.bytes, filename } }));
      return result;
    } catch (error) {
      if (error && error.message === 'render_cancelled') status.textContent = 'أُلغي التصيير.';
      else if (error && error.message === 'missing_assets') status.textContent = 'تعذّر التصيير: هناك أصول مفقودة في المشروع.';
      else status.textContent = 'تعذّر التصيير. افحص المقاطع والصوت المحلي.';
      throw error;
    } finally {
      root.getElementById('cancel').hidden = true;
      this.rendering = false;
      this.abortController = null;
      root.getElementById('timeline').querySelectorAll('button, input, select').forEach((control) => { control.disabled = control.dataset.locked === '1'; });
      this.syncApproval();
    }
  }
}

customElements.define('satr-promo-studio', SatrPromoStudio);
