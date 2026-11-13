// المسرح: الخلفية وإطار الجهاز والظل والزوايا حول محتوى المشهد.
// الإطارات مرسومة بمسارات canvas لا بصور. الألوان من سمة الاستوديو (runtime.colors.chrome)
// أو من ألوان يختارها المستخدم ومحفوظة في المشروع؛ لا ألوان صلبة هنا.
//
// النسق: الخلفية على اللوحة كلها ⇒ الجهاز (إطار + محتوى مقصوص بزوايا دائرية) في وسطها
// بحجم نسبي ⇒ الإمالة اختيارية عبر promo-gl.js. دوال التخطيط نقية وتُختبر بـnode.

export const STAGE_FRAMES = Object.freeze(['none', 'browser', 'laptop', 'phone', 'tablet']);
export const STAGE_BACKGROUNDS = Object.freeze(['none', 'color', 'linear', 'radial', 'image']);
export const STAGE_MOTIONS = Object.freeze(['none', 'orbit']);
export const STAGE_SCALE_MIN = 0.78;
export const STAGE_SCALE_MAX = 0.88;
export const STAGE_TILT_MAX = 25;

const clamp = (value, min, max) => Math.max(min, Math.min(max, value));

// هل للمشهد مسرح فعّال؟ مشهد v1 (بلا stage أو بإطار وخلفية «none») يمر بالمسار القديم حرفياً.
export function usesStage(scene) {
  const stage = scene && scene.stage;
  return !!(stage && (stage.frame !== 'none' || (stage.background && stage.background.type !== 'none')));
}

// هوامش إطار الجهاز حول المحتوى، نسبةً إلى القاعدة (أصغر بُعدَي المحتوى). نقية.
export function frameInsets(frame, contentWidth, contentHeight) {
  const base = Math.min(contentWidth, contentHeight);
  if (frame === 'browser') return { top: Math.round(base * 0.075), right: 0, bottom: 0, left: 0, radius: Math.round(base * 0.022), extraBottom: 0 };
  if (frame === 'phone') { const b = Math.round(base * 0.035); return { top: b, right: b, bottom: b, left: b, radius: Math.round(base * 0.11), extraBottom: 0 }; }
  if (frame === 'tablet') { const b = Math.round(base * 0.045); return { top: b, right: b, bottom: b, left: b, radius: Math.round(base * 0.06), extraBottom: 0 }; }
  if (frame === 'laptop') { const b = Math.round(base * 0.03); return { top: b, right: b, bottom: b, left: b, radius: Math.round(base * 0.025), extraBottom: Math.round(base * 0.06) }; }
  return { top: 0, right: 0, bottom: 0, left: 0, radius: Math.round(base * 0.02), extraBottom: 0 };
}

// تخطيط الجهاز داخل اللوحة: المحتوى يحافظ على نسبة المصدر، والجهاز كله داخل scale × اللوحة.
// يعيد { device: {x,y,width,height}, content: {x,y,width,height}, insets } بإحداثيات اللوحة. نقية.
export function stageLayout(stage, sourceWidth, sourceHeight, width, height) {
  const scale = clamp(Number(stage.scale) || 0.84, STAGE_SCALE_MIN, STAGE_SCALE_MAX);
  const boxWidth = width * scale, boxHeight = height * scale;
  const ratio = sourceWidth > 0 && sourceHeight > 0 ? sourceWidth / sourceHeight : width / height;
  // تقريب أول بلا هوامش ثم تصحيح واحد يكفي: الهوامش نسبة إلى المحتوى نفسه.
  let contentWidth = Math.min(boxWidth, boxHeight * ratio), contentHeight = contentWidth / ratio;
  for (let pass = 0; pass < 3; pass += 1) {
    const insets = frameInsets(stage.frame, contentWidth, contentHeight);
    const totalWidth = contentWidth + insets.left + insets.right;
    const totalHeight = contentHeight + insets.top + insets.bottom + insets.extraBottom;
    const shrink = Math.min(1, boxWidth / totalWidth, boxHeight / totalHeight);
    if (shrink >= 0.999) break;
    contentWidth *= shrink; contentHeight = contentWidth / ratio;
  }
  contentWidth = Math.floor(contentWidth); contentHeight = Math.floor(contentHeight);
  const insets = frameInsets(stage.frame, contentWidth, contentHeight);
  const deviceWidth = contentWidth + insets.left + insets.right;
  const deviceHeight = contentHeight + insets.top + insets.bottom + insets.extraBottom;
  const x = Math.round((width - deviceWidth) / 2), y = Math.round((height - deviceHeight) / 2);
  return {
    device: { x, y, width: deviceWidth, height: deviceHeight },
    content: { x: x + insets.left, y: y + insets.top, width: contentWidth, height: contentHeight },
    insets,
  };
}

// إمالة الجهاز عند زمن محلي: ثابتة، أو مدار خفيف حولها. نقية.
export function tiltAt(stage, localMs, durationMs) {
  const tilt = stage && stage.tilt ? stage.tilt : { x: 0, y: 0 };
  let x = clamp(Number(tilt.x) || 0, -STAGE_TILT_MAX, STAGE_TILT_MAX);
  let y = clamp(Number(tilt.y) || 0, -STAGE_TILT_MAX, STAGE_TILT_MAX);
  if (stage && stage.motion === 'orbit' && durationMs > 0) {
    // نصف دورة على مدة المشهد: حركة تُلحظ ولا تُدوّخ، وتبدأ وتنتهي عند الإمالة المحفوظة ± 4°.
    const phase = Math.PI * localMs / durationMs;
    y = clamp(y + 4 * Math.cos(phase), -STAGE_TILT_MAX, STAGE_TILT_MAX);
    x = clamp(x + 1.5 * Math.sin(phase * 2), -STAGE_TILT_MAX, STAGE_TILT_MAX);
  }
  return { x, y };
}

function roundedRect(context, x, y, width, height, radius) {
  const r = Math.max(0, Math.min(radius, width / 2, height / 2));
  context.beginPath();
  context.moveTo(x + r, y);
  context.lineTo(x + width - r, y);
  context.arcTo(x + width, y, x + width, y + r, r);
  context.lineTo(x + width, y + height - r);
  context.arcTo(x + width, y + height, x + width - r, y + height, r);
  context.lineTo(x + r, y + height);
  context.arcTo(x, y + height, x, y + height - r, r);
  context.lineTo(x, y + r);
  context.arcTo(x, y, x + r, y, r);
  context.closePath();
}

function chromeOf(colors) {
  const chrome = colors.chrome || {};
  return {
    body: chrome.body || colors.captionBackground,
    bar: chrome.bar || colors.captionBackground,
    pill: chrome.pill || colors.background,
    text: chrome.text || colors.captionText,
    dots: Array.isArray(chrome.dots) && chrome.dots.length === 3 ? chrome.dots : [colors.captionText, colors.captionText, colors.captionText],
    shadow: chrome.shadow || colors.captionBackground,
  };
}

// الخلفية على اللوحة كلها. images: Map مسار ⇒ { source, width, height } لخلفية الصورة.
export function drawBackground(context, stage, width, height, colors, images) {
  const background = stage.background || { type: 'none' };
  const first = background.color || colors.background, second = background.color2 || colors.accent || colors.captionBackground;
  if (background.type === 'linear') {
    const angle = (Number(background.angle) || 0) * Math.PI / 180;
    const dx = Math.cos(angle) * width / 2, dy = Math.sin(angle) * height / 2;
    const gradient = context.createLinearGradient(width / 2 - dx, height / 2 - dy, width / 2 + dx, height / 2 + dy);
    gradient.addColorStop(0, first); gradient.addColorStop(1, second);
    context.fillStyle = gradient; context.fillRect(0, 0, width, height);
  } else if (background.type === 'radial') {
    const gradient = context.createRadialGradient(width / 2, height / 2, 0, width / 2, height / 2, Math.hypot(width, height) / 2);
    gradient.addColorStop(0, second); gradient.addColorStop(1, first);
    context.fillStyle = gradient; context.fillRect(0, 0, width, height);
  } else if (background.type === 'image' && images && images.get(background.image)) {
    const image = images.get(background.image);
    const scale = Math.max(width / image.width, height / image.height);
    const blur = clamp(Number(background.blur) || 0, 0, 40) * height / 1080;
    context.save();
    if (blur > 0) context.filter = 'blur(' + blur.toFixed(2) + 'px)';
    // تكبير طفيف يخفي حواف التغبيش الشفافة.
    const grow = blur > 0 ? 1.08 : 1;
    const drawWidth = image.width * scale * grow, drawHeight = image.height * scale * grow;
    context.drawImage(image.source, (width - drawWidth) / 2, (height - drawHeight) / 2, drawWidth, drawHeight);
    context.restore();
  } else if (background.type === 'color') {
    context.fillStyle = first; context.fillRect(0, 0, width, height);
  }
}

// يرسم الجهاز (إطار + محتوى) على سياق بحجم الجهاز نفسه، من (0,0). drawContent(context, rect)
// يرسم المحتوى داخل rect وقد قُصّ بزوايا دائرية.
export function drawDevice(context, stage, layout, colors, drawContent) {
  const chrome = chromeOf(colors);
  const { insets } = layout;
  const width = layout.device.width, height = layout.device.height;
  const bodyHeight = height - insets.extraBottom;
  const content = { x: insets.left, y: insets.top, width: layout.content.width, height: layout.content.height };
  const radius = stage.radius === 0 ? 0 : insets.radius;
  context.clearRect(0, 0, width, height);
  context.save();
  if (stage.frame === 'none') {
    roundedRect(context, 0, 0, width, bodyHeight, radius);
    context.clip();
    drawContent(context, content);
    context.restore();
    return;
  }
  // جسم الجهاز
  roundedRect(context, 0, 0, width, bodyHeight, radius);
  context.fillStyle = stage.frame === 'browser' ? chrome.bar : chrome.body;
  context.fill();
  context.restore();

  // المحتوى مقصوصاً: المتصفح يقصّ الزاويتين السفليتين بقوس الجهاز، والبقية بقوس داخلي.
  context.save();
  if (stage.frame === 'browser') {
    roundedRect(context, 0, 0, width, bodyHeight, radius);
    context.clip();
    context.beginPath(); context.rect(content.x, content.y, content.width, content.height); context.clip();
  } else {
    roundedRect(context, content.x, content.y, content.width, content.height, Math.max(0, radius - insets.left));
    context.clip();
  }
  drawContent(context, content);
  context.restore();

  context.save();
  if (stage.frame === 'browser') {
    const bar = insets.top, dot = bar * 0.16;
    chrome.dots.forEach((color, index) => {
      context.beginPath();
      context.arc(bar * 0.5 + index * dot * 3.4, bar / 2, dot, 0, Math.PI * 2);
      context.fillStyle = color; context.fill();
    });
    // حقل الرابط
    const pillX = bar * 0.5 + dot * 3.4 * 3 + bar * 0.2, pillWidth = Math.max(0, width - pillX - bar * 0.6), pillHeight = bar * 0.56;
    roundedRect(context, pillX, (bar - pillHeight) / 2, pillWidth, pillHeight, pillHeight / 2);
    context.fillStyle = chrome.pill; context.fill();
    const label = typeof stage.label === 'string' ? stage.label : '';
    if (label && pillWidth > bar) {
      context.fillStyle = chrome.text;
      context.font = '500 ' + Math.round(pillHeight * 0.5) + 'px "IBM Plex Sans Arabic", sans-serif';
      context.direction = 'ltr'; context.textAlign = 'left'; context.textBaseline = 'middle';
      context.save();
      context.beginPath(); context.rect(pillX, 0, pillWidth - pillHeight * 0.4, bar); context.clip();
      context.fillText(label, pillX + pillHeight * 0.45, bar / 2);
      context.restore();
    }
  } else if (stage.frame === 'phone') {
    // نتوء علوي
    const notchWidth = width * 0.28, notchHeight = insets.top * 0.62;
    roundedRect(context, (width - notchWidth) / 2, insets.top * 0.75, notchWidth, notchHeight, notchHeight / 2);
    context.fillStyle = chrome.body; context.fill();
  } else if (stage.frame === 'tablet') {
    context.beginPath();
    context.arc(width / 2, insets.top / 2, insets.top * 0.16, 0, Math.PI * 2);
    context.fillStyle = chrome.pill; context.fill();
  } else if (stage.frame === 'laptop') {
    // القاعدة: شبه منحرف أعرض من الشاشة قليلاً مع شق الفتح.
    const baseTop = bodyHeight, baseHeight = insets.extraBottom;
    context.beginPath();
    context.moveTo(-width * 0.0, baseTop);
    context.lineTo(width, baseTop);
    context.lineTo(width * 0.96, baseTop + baseHeight);
    context.lineTo(width * 0.04, baseTop + baseHeight);
    context.closePath();
    context.fillStyle = chrome.bar; context.fill();
    roundedRect(context, width * 0.42, baseTop, width * 0.16, baseHeight * 0.3, baseHeight * 0.15);
    context.fillStyle = chrome.pill; context.fill();
  }
  context.restore();
}

// ظل الجهاز تحت موضعه على اللوحة الرئيسية.
export function drawShadow(context, stage, layout, colors, height) {
  const strength = clamp(Number(stage.shadow) || 0, 0, 1);
  if (!strength) return;
  const chrome = chromeOf(colors);
  const { device, insets } = layout;
  context.save();
  context.shadowColor = chrome.shadow;
  context.shadowBlur = height * 0.05 * strength;
  context.shadowOffsetY = height * 0.022 * strength;
  context.globalAlpha = 0.55 + 0.45 * strength;
  roundedRect(context, device.x, device.y, device.width, device.height - insets.extraBottom, stage.radius === 0 ? 0 : insets.radius);
  context.fillStyle = chrome.shadow;
  context.fill();
  context.restore();
}

export { roundedRect };
