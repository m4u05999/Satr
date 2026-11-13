// قوالب جاهزة لاستوديو البرومو وتطبيق هوية المشروع على المشاهد. دوال نقية تُختبر بـnode.
// القالب إعدادات مظهر فقط (مسرح، نص، انتقالات، مقاس): لا يمس الأصول ولا المدد ولا النصوص ولا
// الكاميرا ولا مناطق التغبيش.

const frozen = (value) => Object.freeze(value);
const FONT_IDS = ['plex', 'cairo', 'naskh'];

// ألوان القوالب الافتراضية تأتي من هوية المشروع إن وُجدت، وإلا من سمة الاستوديو (fallback).
export const TEMPLATES = frozen([
  frozen({
    id: 'app-launch', label: 'إطلاق تطبيق', aspect: '9:16',
    hint: 'جوال مائل على تدرج، عناوين كلمة بكلمة، تلاشٍ متقاطع.',
    stage: frozen({ frame: 'phone', background: 'linear', angle: 160, shadow: 0.8, scale: 0.82, firstTilt: frozen({ x: 4, y: -14 }), tilt: frozen({ x: 0, y: 0 }), motion: 'none' }),
    text: frozen({ animation: 'words', position: 'bottom', style: 'box', font: 'cairo' }), transition_in: 'crossfade', subtitles: false,
  }),
  frozen({
    id: 'new-feature', label: 'ميزة جديدة', aspect: '16:9',
    hint: 'نافذة متصفح على تدرج، أول مشهد مائل بمدار خفيف، انزلاق بين المشاهد.',
    stage: frozen({ frame: 'browser', background: 'linear', angle: 135, shadow: 0.7, scale: 0.84, firstTilt: frozen({ x: 3, y: -12 }), tilt: frozen({ x: 0, y: 0 }), firstMotion: 'orbit', motion: 'none' }),
    text: frozen({ animation: 'slide', position: 'bottom', style: 'box' }), transition_in: 'slide', subtitles: false,
  }),
  frozen({
    id: 'store-offer', label: 'عرض متجر', aspect: '1:1',
    hint: 'جوال على تدرج شعاعي، عناوين بتكبير خفيف في الأعلى، تكبير عابر.',
    stage: frozen({ frame: 'phone', background: 'radial', angle: 0, shadow: 0.9, scale: 0.8, firstTilt: frozen({ x: 0, y: 0 }), tilt: frozen({ x: 0, y: 0 }), motion: 'none' }),
    text: frozen({ animation: 'zoom', position: 'top', style: 'box', font: 'cairo' }), transition_in: 'zoom', subtitles: false,
  }),
  frozen({
    id: 'how-to', label: 'شرح خطوات', aspect: '16:9',
    hint: 'المحتوى بلا إطار جهاز على لون هادئ، ترجمة على الشاشة، قطع مباشر.',
    stage: frozen({ frame: 'none', background: 'color', angle: 0, shadow: 0.5, scale: 0.88, firstTilt: frozen({ x: 0, y: 0 }), tilt: frozen({ x: 0, y: 0 }), motion: 'none' }),
    text: frozen({ animation: 'none', position: 'top', style: 'minimal' }), transition_in: 'none', subtitles: true,
  }),
  frozen({
    id: 'laptop-demo', label: 'عرض على لابتوب', aspect: '16:9',
    hint: 'لابتوب على تدرج، عناوين كلمة بكلمة، تغبيش عابر.',
    stage: frozen({ frame: 'laptop', background: 'linear', angle: 200, shadow: 0.8, scale: 0.82, firstTilt: frozen({ x: 6, y: 0 }), tilt: frozen({ x: 0, y: 0 }), motion: 'none' }),
    text: frozen({ animation: 'words', position: 'bottom', style: 'box' }), transition_in: 'blur', subtitles: false,
  }),
]);

export function templateById(id) {
  return TEMPLATES.find((template) => template.id === id) || null;
}

const COLOR = /^#[0-9a-fA-F]{6}$/;
const pick = (...values) => values.find((value) => COLOR.test(value || '')) || '';

// يطبّق قالباً على storyboard (يعدّله في مكانه ويعيده). colors: { primary, secondary } افتراضية
// حين لا هوية. لا يمس ما ليس مظهراً.
export function applyTemplate(storyboard, template, colors) {
  if (!storyboard || !Array.isArray(storyboard.scenes) || !template) return storyboard;
  const brand = storyboard.brand || {};
  const primary = pick(brand.primary, colors && colors.primary), secondary = pick(brand.secondary, colors && colors.secondary);
  storyboard.aspect = template.aspect;
  storyboard.scenes.forEach((scene, index) => {
    if (!scene || scene.asset_missing) return;
    const stage = template.stage;
    const previous = scene.stage || {};
    scene.stage = {
      frame: stage.frame,
      background: { type: stage.background, color: primary, color2: secondary, angle: stage.angle, image: '', blur: 0 },
      shadow: stage.shadow, scale: stage.scale, radius: 1,
      tilt: { ...(index === 0 ? stage.firstTilt : stage.tilt) },
      motion: index === 0 && stage.firstMotion ? stage.firstMotion : stage.motion,
      // نص حقل الرابط كتبه المستخدم؛ يبقى.
      label: typeof previous.label === 'string' ? previous.label : '',
    };
    scene.text_style = {
      animation: template.text.animation,
      // خط الهوية إن وُجد، وإلا خط القالب، وإلا ما اختاره المستخدم للمشهد.
      font: FONT_IDS.includes(brand.font) && brand.font !== 'plex' ? brand.font : template.text.font || (scene.text_style && FONT_IDS.includes(scene.text_style.font) ? scene.text_style.font : 'plex'),
      highlight: scene.text_style && typeof scene.text_style.highlight === 'string' ? scene.text_style.highlight : '',
    };
    scene.caption_position = template.text.position;
    scene.caption_style = template.text.style;
    scene.transition_in = index === 0 ? 'none' : template.transition_in;
    // الترجمة تُفعَّل فقط حيث يوجد نص تعليق.
    scene.subtitles = !!(template.subtitles && scene.voiceover_ar);
  });
  return storyboard;
}

export const BRAND_CLOSING_ID = 'brand_closing';

// يطبّق الهوية: ألوان الخلفيات، وبطاقة ختام (شعار + عبارة) في آخر الإعلان إن وُجد شعار وعبارة.
// يعيد { storyboard, closing: 'added' | 'updated' | 'removed' | 'none' }.
export function applyBrand(storyboard, brandInput) {
  const brand = brandInput && typeof brandInput === 'object' ? brandInput : {};
  const result = { storyboard, closing: 'none' };
  if (!storyboard || !Array.isArray(storyboard.scenes)) return result;
  storyboard.brand = {
    name: typeof brand.name === 'string' ? brand.name : '', primary: pick(brand.primary), secondary: pick(brand.secondary), accent: pick(brand.accent),
    closing: typeof brand.closing === 'string' ? brand.closing : '', font: FONT_IDS.includes(brand.font) ? brand.font : 'plex', logo: typeof brand.logo === 'string' ? brand.logo : '',
  };
  const { primary, secondary, closing, logo, font } = storyboard.brand;
  for (const scene of storyboard.scenes) {
    // خط الهوية يسري على عناوين كل المشاهد.
    if (scene && scene.id !== BRAND_CLOSING_ID) scene.text_style = { animation: 'none', highlight: '', ...(scene.text_style || {}), font };
    const background = scene && scene.stage && scene.stage.background;
    if (!background || scene.id === BRAND_CLOSING_ID) continue;
    if (['color', 'linear', 'radial'].includes(background.type)) {
      if (primary) background.color = primary;
      if (secondary) background.color2 = secondary;
    }
  }
  const at = storyboard.scenes.findIndex((scene) => scene && scene.id === BRAND_CLOSING_ID);
  if (logo && closing) {
    const card = {
      id: BRAND_CLOSING_ID, asset: logo, asset_type: 'image', caption: closing, duration_ms: 2500,
      transition: 'cut', transition_in: storyboard.scenes.length > (at >= 0 ? 1 : 0) ? 'crossfade' : 'none', music: '', voice: '', trim_start_ms: 0, fit: 'contain',
      caption_position: 'bottom', caption_style: 'minimal', clip_volume: 1, music_volume: 0.34, voice_volume: 1,
      camera: { mode: 'off', cursor: true, keyframes: [] }, redactions: [], voiceover_ar: '', subtitles: false,
      text_style: { animation: 'words', font, highlight: '' },
      stage: { frame: 'none', background: { type: primary || secondary ? 'radial' : 'none', color: primary, color2: secondary, angle: 0, image: '', blur: 0 },
        shadow: 0, scale: 0.78, radius: 1, tilt: { x: 0, y: 0 }, motion: 'none', label: '' },
    };
    if (at >= 0) { storyboard.scenes.splice(at, 1); storyboard.scenes.push(card); result.closing = 'updated'; }
    else if (storyboard.scenes.length < 40) { storyboard.scenes.push(card); result.closing = 'added'; }
  } else if (at >= 0) {
    storyboard.scenes.splice(at, 1);
    result.closing = 'removed';
  }
  return result;
}
