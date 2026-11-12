// صف الكاميرا في بطاقة المشهد داخل استوديو البرومو، ومساعدات تعديل النقاط المفتاحية.
// لا حالة هنا: المكوّن يملك الحالة ويفوّض الأحداث عبر data-field / data-action كبقية البطاقة.

import { CAMERA_EASES, MAX_KEYFRAMES, MAX_ZOOM, planCamera, cameraAt, clampCenter } from './promo-camera.js';

const clamp = (value, min, max) => Math.max(min, Math.min(max, value));

// تنظيف جهة الواجهة. التنقية الملزمة في electron/promostudio.js؛ هذه تمنع فقط أن تحمل
// الواجهة حالة يرفضها main عند الحفظ.
export function cleanCamera(raw, durationMs) {
  const camera = { mode: 'off', cursor: true, keyframes: [] };
  if (!raw || typeof raw !== 'object') return camera;
  camera.mode = ['auto', 'manual', 'off'].includes(raw.mode) ? raw.mode : 'off';
  camera.cursor = raw.cursor !== false;
  let previous = -1;
  for (const item of Array.isArray(raw.keyframes) ? raw.keyframes.slice(0, MAX_KEYFRAMES) : []) {
    if (!item || !Number.isFinite(item.t_ms) || !Number.isFinite(item.x) || !Number.isFinite(item.y) || !Number.isFinite(item.zoom)) continue;
    const t = clamp(Math.round(item.t_ms), 0, durationMs);
    if (t <= previous) continue;
    previous = t;
    camera.keyframes.push({
      t_ms: t, x: clamp(item.x, 0, 1), y: clamp(item.y, 0, 1), zoom: clamp(item.zoom, 1, MAX_ZOOM),
      ease: CAMERA_EASES.includes(item.ease) ? item.ease : 'inOut',
    });
  }
  return camera;
}

// خطة تلقائية من الأحداث، بصيغة التخزين (بلا حقل reason).
export function suggestCamera(events, scene) {
  const keyframes = planCamera(events, { durationMs: scene.duration_ms, sourceStartMs: scene.trim_start_ms || 0 })
    .map(({ t_ms, x, y, zoom, ease }) => ({ t_ms, x, y, zoom, ease }));
  return { mode: 'auto', cursor: scene.camera ? scene.camera.cursor !== false : true, keyframes };
}

// نقطة جديدة عند زمن محلي، تبدأ من حالة الكاميرا الحالية هناك. تعيد فهرسها أو -1.
export function addKeyframe(camera, localMs, durationMs) {
  if (camera.keyframes.length >= MAX_KEYFRAMES) return -1;
  const t = clamp(Math.round(localMs), 0, durationMs);
  if (camera.keyframes.some((key) => key.t_ms === t)) return -1;
  const state = cameraAt({ mode: 'manual', keyframes: camera.keyframes }, t);
  const key = { t_ms: t, x: Math.round(state.x * 10000) / 10000, y: Math.round(state.y * 10000) / 10000, zoom: Math.round(state.zoom * 1000) / 1000, ease: 'inOut' };
  camera.keyframes.push(key);
  camera.keyframes.sort((a, b) => a.t_ms - b.t_ms);
  camera.mode = 'manual';
  return camera.keyframes.indexOf(key);
}

// تعديل حقل في نقطة. الزمن يبقى بين الجارتين، والمركز يُقصّ كي لا تخرج النافذة عن الإطار.
export function editKeyframe(camera, index, field, value, durationMs) {
  const key = camera.keyframes[index];
  if (!key || !Number.isFinite(value)) return false;
  if (field === 't_ms') {
    const min = index > 0 ? camera.keyframes[index - 1].t_ms + 1 : 0;
    const max = index + 1 < camera.keyframes.length ? camera.keyframes[index + 1].t_ms - 1 : durationMs;
    key.t_ms = clamp(Math.round(value), min, Math.max(min, max));
  } else if (field === 'zoom') key.zoom = clamp(Math.round(value * 1000) / 1000, 1, MAX_ZOOM);
  else if (field === 'x' || field === 'y') key[field] = clamp(Math.round(value * 10000) / 10000, 0, 1);
  else return false;
  const center = clampCenter(key.x, key.y, key.zoom);
  key.x = Math.round(center.x * 10000) / 10000; key.y = Math.round(center.y * 10000) / 10000;
  camera.mode = 'manual';
  return true;
}

// بعد تغيير مدة المشهد أو قصّه: النقاط خارج المدة تسقط، والإزاحة تُطرح.
export function shiftKeyframes(camera, shiftMs, durationMs) {
  camera.keyframes = camera.keyframes
    .map((key) => ({ ...key, t_ms: key.t_ms - shiftMs }))
    .filter((key) => key.t_ms >= 0 && key.t_ms <= durationMs);
}

const seconds = (ms) => (ms / 1000).toFixed(1);

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

function numberInput(value, field, min, max, step) {
  const input = element('input', 'cam-num');
  input.type = 'number'; input.value = String(value); input.dataset.field = field;
  input.min = String(min); input.max = String(max); input.step = String(step);
  return input;
}

// options: { selected: فهرس النقطة المحددة أو -1, hasEvents, gaps: [{start_ms,end_ms}] }
export function buildCameraRow(scene, options) {
  const camera = scene.camera || { mode: 'off', cursor: true, keyframes: [] };
  const wrap = element('div', 'camera');
  const row = element('div', 'row');

  const modeLabel = element('label', null, 'الكاميرا');
  const mode = element('select', 'camera-mode');
  mode.dataset.field = 'camera_mode';
  for (const [value, label] of [['off', 'بدون'], ['auto', 'تلقائية'], ['manual', 'يدوية']]) {
    const option = element('option', null, label); option.value = value; mode.appendChild(option);
  }
  mode.value = camera.mode;
  modeLabel.appendChild(mode);

  const cursorLabel = element('label', null, 'المؤشر');
  const cursor = element('input');
  cursor.type = 'checkbox'; cursor.checked = camera.cursor !== false; cursor.dataset.field = 'camera_cursor';
  cursor.disabled = camera.mode === 'off';
  if (cursor.disabled) cursor.dataset.locked = '1';
  cursorLabel.appendChild(cursor);

  const suggest = element('button', null, 'اقترح كاميرا');
  suggest.type = 'button'; suggest.dataset.action = 'camera-suggest';
  suggest.title = options.hasEvents ? 'ولّد حركة الكاميرا من سجل أحداث التسجيل' : 'لا سجل أحداث لهذا المقطع';
  suggest.disabled = !options.hasEvents;
  if (suggest.disabled) suggest.dataset.locked = '1';

  const add = element('button', null, '＋ نقطة');
  add.type = 'button'; add.dataset.action = 'key-add'; add.title = 'أضف نقطة كاميرا عند زمن المعاينة الحالي';

  row.append(modeLabel, cursorLabel, suggest, add);
  wrap.appendChild(row);

  if (camera.mode !== 'off' && camera.keyframes.length) {
    // الشريط يسير من اليسار إلى اليمين كشريط الزمن في المعاينة.
    const strip = element('div', 'cam-strip');
    strip.setAttribute('role', 'group'); strip.setAttribute('aria-label', 'نقاط الكاميرا على زمن المشهد');
    camera.keyframes.forEach((key, index) => {
      const dot = element('button', 'cam-key' + (index === options.selected ? ' selected' : ''));
      dot.type = 'button'; dot.dataset.action = 'key-select'; dot.dataset.key = String(index);
      dot.style.left = (scene.duration_ms ? key.t_ms / scene.duration_ms * 100 : 0).toFixed(3) + '%';
      dot.title = seconds(key.t_ms) + ' ث · زوم ' + key.zoom.toFixed(2);
      dot.setAttribute('aria-label', 'نقطة كاميرا عند ' + seconds(key.t_ms) + ' ثانية');
      strip.appendChild(dot);
    });
    wrap.appendChild(strip);
    const key = camera.keyframes[options.selected];
    if (key) {
      const editor = element('div', 'row cam-editor');
      const label = (text, control) => { const node = element('label', null, text); node.appendChild(control); return node; };
      const remove = element('button', null, 'حذف النقطة');
      remove.type = 'button'; remove.dataset.action = 'key-remove';
      editor.append(
        label('الزمن ms', numberInput(key.t_ms, 'key_t_ms', 0, scene.duration_ms, 50)),
        label('أفقي', numberInput(key.x, 'key_x', 0, 1, 0.01)),
        label('رأسي', numberInput(key.y, 'key_y', 0, 1, 0.01)),
        label('زوم', numberInput(key.zoom, 'key_zoom', 1, MAX_ZOOM, 0.05)),
        remove,
      );
      wrap.appendChild(editor);
    }
  }

  if (options.gaps && options.gaps.length) {
    const gaps = element('div', 'row cam-gaps');
    gaps.appendChild(element('span', 'cam-hint', 'خمول بلا أحداث:'));
    options.gaps.slice(0, 6).forEach((gap, index) => {
      const button = element('button', null, 'قصّ ' + seconds(gap.start_ms) + '–' + seconds(gap.end_ms) + ' ث');
      button.type = 'button'; button.dataset.action = 'cut-gap'; button.dataset.gap = String(index);
      button.title = 'يقسم المشهد ويحذف هذه الفترة. اقتراح فقط؛ لا يُنفَّذ إلا بضغطك.';
      gaps.appendChild(button);
    });
    wrap.appendChild(gaps);
  }
  return wrap;
}

export const CAMERA_CSS = `
  .camera { display: grid; gap: var(--space-1h); padding-top: var(--space-1h); border-top: 1px dashed var(--border); }
  .camera input[type=checkbox] { padding: var(--space-0); }
  .cam-strip { position: relative; height: var(--space-5); direction: ltr; border-radius: var(--radius-pill); background: var(--surface-2); margin-inline: var(--space-2); }
  .cam-key { position: absolute; top: 50%; width: var(--space-3); height: var(--space-3); padding: var(--space-0); transform: translate(-50%, -50%); border-radius: var(--radius-pill); background: var(--gold); border-color: var(--gold); cursor: grab; touch-action: none; }
  .cam-key.selected { background: var(--text); border-color: var(--text); }
  .cam-num { width: 78px; direction: ltr; text-align: left; font-family: var(--mono); }
  .cam-hint { color: var(--text-dim); font-size: 11.5px; }
`;
