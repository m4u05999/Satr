'use strict';

/**
 * سطر — صفحة الهبوط: نظام الحركة
 * الفكرة المركزية «السطر الذي يلتئم»: حروف معزولة معكوسة (العطل الذي يحله
 * المنتج) تلتئم إلى «سطر» متصلة. القواعد: تحريك transform/opacity فقط (60fps)،
 * لا تقطيع للحرف العربي المتصل (الالتزام بالكلمة/القناع — التفكيك في الافتتاحية
 * مقصود لأنه هو العطل المروي)، وprefers-reduced-motion يعرض كل شيء ثابتاً.
 */

const REDUCED = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

const TAGLINE = 'البيت العربي لأدوات الذكاء الاصطناعي في سطر الأوامر';

// محاكاة طرفية بلا BiDi: الحروف بترتيبها المنطقي تُرسم LTR (انعكاس بصري)
// وZWNJ يفصل الحروف فيمنع اتصالها — نفس ما يراه المستخدم في conhost فعلاً.
function breakArabic(text) {
  return Array.from(text).join('\u200C');
}

const TERM_COMMAND = 'claude "لماذا يفشل تسجيل الدخول؟"';
const TERM_OUTPUT = [
  'بعد فحص الكود وجدت ثلاث مشاكل محتملة:',
  '١. دالة التحقق تقارن كلمة المرور قبل التشفير',
  '٢. انتهاء صلاحية الرمز لا يُفحص في الخادم',
  '٣. رأس Authorization يُرسل فارغاً عند التحديث',
];

// ---------- بناء محتوى الطرفية ----------
function buildTerminal(instant) {
  const body = document.getElementById('termBody');
  if (!body) return null;
  body.textContent = '';

  const promptLine = document.createElement('div');
  promptLine.className = 'term-line';
  const prompt = document.createElement('span');
  prompt.className = 'term-prompt';
  prompt.textContent = 'PS D:\\my-app> ';
  const cmd = document.createElement('span');
  cmd.className = 'term-broken';
  const cursor = document.createElement('span');
  cursor.className = 'term-cursor';
  promptLine.append(prompt, cmd, cursor);
  body.append(promptLine);

  const outLines = TERM_OUTPUT.map(() => {
    const line = document.createElement('div');
    line.className = 'term-line term-broken';
    body.append(line);
    return line;
  });

  const brokenCommand = breakArabic(TERM_COMMAND);
  if (instant) {
    cmd.textContent = brokenCommand;
    outLines.forEach((line, i) => { line.textContent = breakArabic(TERM_OUTPUT[i]); });
    return null;
  }
  return { cmd, cursor, outLines, brokenCommand };
}

// ---------- إزاحة المراسي: مشتقّة من ارتفاع الرأس الفعلي ----------
// الرأس `position: fixed` ويلتفّ على الشاشات الضيقة (‏151px عند 390px مقابل 73px
// عند 1280px — مقيسان)، فالإزاحة الثابتة `-60` كانت تُبقي 91px من رأس المقطع خلفه على الجوال —
// ‏OBS-071. تُقاس عند النقر لا عند التحميل كي تتبع الالتفاف وتغيّر حجم النافذة.
const ANCHOR_GAP = 12; // هامش تنفّس بين حافة الرأس السفلى ورأس المقطع

function anchorOffset() {
  const header = document.querySelector('.site-header');
  return -((header ? header.offsetHeight : 0) + ANCHOR_GAP);
}

// مشتركة بين مساري الحركة وreduced-motion: الأول يمرّر تمرير Lenis السلس،
// والثاني قفزة فورية — والإزاحة واحدة في الحالتين.
function initAnchors(scrollTo) {
  document.querySelectorAll('a[href^="#"]').forEach((link) => {
    link.addEventListener('click', (event) => {
      const target = document.querySelector(link.getAttribute('href'));
      if (!target) return;
      event.preventDefault();
      scrollTo(target, anchorOffset());
    });
  });
}

// ---------- مسار الحركة الكاملة ----------
function initAnimations() {
  gsap.registerPlugin(ScrollTrigger);

  // تمرير سلس + مزامنة ScrollTrigger (الوصفة القياسية)
  const lenis = new Lenis({ duration: 1.15 });
  lenis.on('scroll', ScrollTrigger.update);
  gsap.ticker.add((time) => { lenis.raf(time * 1000); });
  gsap.ticker.lagSmoothing(0);

  // الروابط الداخلية تستعمل Lenis (سلاسة + إزاحة الرأس المشتقّة)
  initAnchors((target, offset) => { lenis.scrollTo(target, { offset }); });

  // الخيط الذهبي: تقدم القراءة
  gsap.to('#goldLine', {
    scaleY: 1,
    ease: 'none',
    scrollTrigger: { trigger: document.body, start: 'top top', end: 'bottom bottom', scrub: .4 },
  });

  // ---------- المشهد 1: الالتئام ----------
  const glyphs = gsap.utils.toArray('.glyph');
  const hero = gsap.timeline({ defaults: { ease: 'expo.out' } });

  // مواضع التبعثر عبر transform حصراً (قاعدة 60fps: لا تحريك خصائص layout)
  const spread = ['-24vw', '2vw', '24vw'];
  gsap.set(glyphs, { xPercent: -50, x: (i) => spread[i] });

  // الحروف المعزولة تصل مبعثرة كما يطبعها جهاز معطوب
  hero.from(glyphs, {
    opacity: 0,
    y: () => gsap.utils.random(-110, 110),
    rotation: () => gsap.utils.random(-22, 22),
    duration: 1.1,
    stagger: .18,
  });
  // ارتجاف قصير — كأنها عالقة في شبكة الطرفية
  hero.to(glyphs, {
    y: '+=7',
    rotation: '+=2.5',
    duration: .09,
    repeat: 7,
    yoyo: true,
    ease: 'steps(1)',
    stagger: .04,
  });
  // الالتئام: تتقارب نحو المركز وتذوب في نقطة توهج…
  hero.to(glyphs, {
    x: 0,
    y: 0,
    rotation: 0,
    opacity: 0,
    filter: 'blur(9px)',
    scale: .55,
    duration: .8,
    ease: 'expo.in',
    stagger: .05,
  }, '+=.25');
  // …فتولد منها الكلمة المتصلة
  hero.fromTo('.hero-word',
    { opacity: 0, scale: .82, filter: 'blur(14px)' },
    { opacity: 1, scale: 1, filter: 'blur(0px)', duration: 1.1, ease: 'expo.out' },
    '-=.15');
  hero.to('.hero-cursor', { opacity: 1, duration: .01 });
  hero.to('.hero-cursor', { opacity: 0, repeat: 5, yoyo: true, duration: .42, ease: 'steps(1)' });

  // الشعار يكتب نفسه
  const taglineEl = document.getElementById('taglineText');
  const typing = { i: 0 };
  hero.to(typing, {
    i: TAGLINE.length,
    duration: TAGLINE.length * .035,
    ease: 'none',
    snap: { i: 1 },
    onUpdate: () => { taglineEl.textContent = TAGLINE.slice(0, typing.i); },
  }, '-=1.8');
  hero.to('.hero-sub', { opacity: 1, duration: .8 }, '-=.4');
  hero.to('.hero-ctas', { opacity: 1, y: 0, duration: .8 }, '-=.5');
  hero.to('.scroll-hint', { opacity: 1, duration: .8 }, '-=.3');

  // ---------- المشهد 2: الطرفية المكسورة ----------
  const term = buildTerminal(false);
  if (term) {
    const termTl = gsap.timeline({
      scrollTrigger: { trigger: '#problem .terminal', start: 'top 70%', once: true },
    });
    const cmdTyping = { i: 0 };
    termTl.to(cmdTyping, {
      i: term.brokenCommand.length,
      duration: 2.2,
      ease: 'none',
      snap: { i: 1 },
      onUpdate: () => { term.cmd.textContent = term.brokenCommand.slice(0, cmdTyping.i); },
    }, '+=.3');
    termTl.add(() => { term.cursor.remove(); }, '+=.35');
    term.outLines.forEach((line, i) => {
      termTl.add(() => { line.textContent = breakArabic(TERM_OUTPUT[i]); }, '+=' + (i === 0 ? .4 : .22));
    });
  }

  // ---------- كشف المقاطع ----------
  gsap.utils.toArray('[data-reveal]').forEach((el) => {
    gsap.to(el, {
      opacity: 1,
      y: 0,
      duration: 1,
      ease: 'expo.out',
      scrollTrigger: { trigger: el, start: 'top 85%', once: true },
    });
  });

  // ---------- شريط المحرّكات ----------
  const marquee = document.getElementById('marquee');
  if (marquee) {
    // دورة كاملة = عرض المحتوى + فجوة واحدة (قبل التكرار) — حلقة بلا قفزة
    const gap = parseFloat(getComputedStyle(marquee).columnGap) || 0;
    const cycle = marquee.scrollWidth + gap;
    marquee.innerHTML += marquee.innerHTML; // نسخة ثانية لحلقة لا نهائية
    gsap.to(marquee, { x: -cycle, duration: 26, ease: 'none', repeat: -1 });
  }
}

// ---------- مسار reduced-motion: الحالة النهائية فوراً ----------
function initStatic() {
  const taglineEl = document.getElementById('taglineText');
  if (taglineEl) taglineEl.textContent = TAGLINE;
  buildTerminal(true);
  const cursor = document.querySelector('.hero-cursor');
  if (cursor) cursor.style.opacity = '1';
  // بلا Lenis هنا: القفزة الأصلية للمتصفح تضع رأس المقطع عند حافة النافذة تماماً
  // فيبتلعه الرأس الثابت. القفزة الفورية نفسها لكن بالإزاحة المشتقّة.
  initAnchors((target, offset) => {
    const top = target.getBoundingClientRect().top + window.scrollY + offset;
    window.scrollTo({ top: Math.max(0, top), behavior: 'auto' });
  });
}

// ---------- زر نسخ winget ----------
function initCopy() {
  const btn = document.getElementById('wingetCopy');
  const cmd = document.getElementById('wingetCmd');
  if (!btn || !cmd) return;
  btn.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(cmd.textContent);
      btn.textContent = 'نُسخ ✓';
      setTimeout(() => { btn.textContent = 'نسخ'; }, 1600);
    } catch (e) { /* بيئة بلا clipboard — لا شيء */ }
  });
}

if (REDUCED) initStatic();
else initAnimations();
initCopy();
