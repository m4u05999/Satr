'use strict';

/**
 * غرفة العمليات حيّة: إعادة رسم لصورة app-ops.png تُشغَّل مرة عند الوصول.
 * عاملان يكتبان في الوقت نفسه، كلٌّ في ملفاته وبعدّاد كتابته وإيقاعه — التوازي
 * الذي لا تقوله صورة ثابتة — ثم تتقدّم المراحل وتقف عند بوابة الدمج بانتظارك.
 * كل عنصر محجوز في مكانه من البداية: تتبدّل النصوص والألوان والشفافية فقط،
 * وprefers-reduced-motion يُبقي الصورة الثابتة كما هي.
 */

(function () {
  const frame = document.getElementById('opsFrame');
  const demo = document.getElementById('opsDemo');
  if (!frame || !demo) return;
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  if (typeof gsap === 'undefined' || typeof ScrollTrigger === 'undefined') return;

  const stages = demo.querySelectorAll('.od-stage');
  const station = demo.querySelector('.od-station-text');
  const nextRun = demo.querySelector('.od-next-run');
  const nextGate = demo.querySelector('.od-next-gate');

  // لكل عامل نصّه: الملفات التي يمرّ بها داخل ملكيته، وكم يكتب، وكم يستغرق
  const plans = [
    { files: ['src/pages/orders/tracking.jsx', 'src/pages/orders/status-badge.jsx'], writes: 24, secs: 96, dur: 4.4 },
    { files: ['tests/orders/status.test.js', 'tests/orders/tracking.test.js'], writes: 17, secs: 72, dur: 3.2 },
  ];

  const workers = Array.from(demo.querySelectorAll('.od-worker')).map((el, i) => ({
    el,
    plan: plans[i],
    state: el.querySelector('.od-w-state'),
    file: el.querySelector('.od-file'),
    count: el.querySelector('.od-count'),
    time: el.querySelector('.od-time'),
    bar: el.querySelector('.od-bar i'),
  }));

  const clock = (s) => Math.floor(s / 60) + ':' + String(Math.floor(s % 60)).padStart(2, '0');

  demo.hidden = false;
  frame.classList.add('is-live');

  gsap.set(workers.map((w) => w.bar), { scaleX: 0 });
  gsap.set(nextGate, { autoAlpha: 0 });

  const tl = gsap.timeline({
    defaults: { ease: 'expo.out' },
    scrollTrigger: { trigger: frame, start: 'top 70%', once: true },
  });

  // ١. التوازي: العاملان يبدآن معاً، وكلٌّ يتقدّم بإيقاعه
  tl.addLabel('run', '+=.5');
  workers.forEach((w) => {
    const p = { writes: 0, secs: 0 };
    tl.to(p, {
      writes: w.plan.writes,
      secs: w.plan.secs,
      duration: w.plan.dur,
      ease: 'none',
      onUpdate: () => {
        w.count.textContent = Math.round(p.writes) + '/30';
        w.time.textContent = clock(p.secs);
      },
    }, 'run');
    tl.to(w.bar, { scaleX: w.plan.writes / 30, duration: w.plan.dur, ease: 'none' }, 'run');

    // ينتقل إلى ملفه الثاني في منتصف عمله — داخل مجلده لا يخرج عنه
    tl.to(w.file, { autoAlpha: 0, duration: .15, ease: 'power1.in' }, 'run+=' + (w.plan.dur * .5));
    tl.add(() => { w.file.textContent = w.plan.files[1]; }, '>');
    tl.to(w.file, { autoAlpha: 1, duration: .25 }, '>');

    // ينهي حين ينهي، لا حين ينهي زميله
    tl.add(() => {
      w.state.textContent = 'أنهى';
      w.el.classList.add('is-done');
    }, 'run+=' + w.plan.dur);
  });

  // ٢. المراحل تتقدّم بعد أن ينهي الاثنان
  const finish = Math.max.apply(null, plans.map((p) => p.dur));
  const steps = [
    'مراجعة — محرّك ثانٍ يراجع',
    'تحقق — الاختبارات تمر',
    'دمج — بانتظار موافقتك',
  ];
  steps.forEach((text, i) => {
    const at = 'run+=' + (finish + .7 + i * 1.1);
    tl.add(() => {
      stages[i + 1].classList.replace('is-active', 'is-done');
      stages[i + 2].classList.add('is-active');
      station.textContent = text;
    }, at);
    tl.fromTo(stages[i + 2], { scale: .94 }, { scale: 1, duration: .5 }, at);
  });

  // ٣. البوابة: السطر الأخير يتبدّل في مكانه، وزر الموافقة لا يُضغط — القرار لك
  const gate = finish + .7 + 2 * 1.1 + .2;
  tl.to(nextRun, { autoAlpha: 0, duration: .25, ease: 'power1.in' }, 'run+=' + gate);
  tl.to(nextGate, { autoAlpha: 1, duration: .5 }, 'run+=' + (gate + .2));
})();
