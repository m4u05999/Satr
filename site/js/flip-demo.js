'use strict';

/**
 * المشهد 3 حيّاً: إعادة رسم لصورة app-chat.png تُشغَّل مرة عند الوصول.
 * سؤال عربي يُكتب ويُرسل ← مربع الإذن العربي ← «موافقة» ← بطاقة الفرق ← جواب
 * عربي فيه كود LTR يظهر كلمة كلمة. قواعد main.js نفسها: transform/opacity،
 * إلا تبادلاً واحداً للارتفاع (المربع ينطوي والفرق ينفتح في اللحظة نفسها، فلا
 * يبقى فراغ مكانه)، والكلمة العربية لا تُقطَّع (الكشف بالكلمة)،
 * وprefers-reduced-motion يُبقي الصورة الثابتة كما هي.
 */

(function () {
  const frame = document.getElementById('flipFrame');
  const demo = document.getElementById('flipDemo');
  if (!frame || !demo) return;
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  if (typeof gsap === 'undefined' || typeof ScrollTrigger === 'undefined') return;

  const $ = (sel) => demo.querySelector(sel);
  const question = $('.fd-q');
  const permWrap = $('.fd-perm-wrap');
  const perm = $('.fd-perm');
  const okBtn = $('.fd-ok');
  const diffWrap = $('.fd-diff-wrap');
  const diff = $('.fd-diff');
  const answer = $('.fd-a');
  const typed = $('.fd-typed');
  const typedRef = $('.fd-typed-ref');
  const caret = $('.fd-caret');
  const send = $('.fd-send');

  // نص السؤال من المشهد نفسه: الجزء العربي ثم المسار في عزله LTR (فلا تنفصل @)
  const ref = question.querySelector('.fd-ref').textContent;
  const text = question.textContent.replace(ref, '').trim() + ' ';

  // الجواب كلمة كلمة: نصوصه تُلفّ بالكلمة، ورموز الكود تبقى وحدة واحدة باتجاهها
  const words = [];
  Array.from(answer.childNodes).forEach((node) => {
    if (node.nodeType === Node.TEXT_NODE) {
      const frag = document.createDocumentFragment();
      node.textContent.split(/(\s+)/).forEach((part) => {
        if (!part) return;
        if (/^\s+$/.test(part)) { frag.append(part); return; }
        const w = document.createElement('span');
        w.className = 'fd-w';
        w.textContent = part;
        frag.append(w);
        words.push(w);
      });
      node.replaceWith(frag);
    } else {
      node.classList.add('fd-w');
      words.push(node);
    }
  });

  // المشهد يحلّ محل الصورة بصرياً؛ الصورة باقية لقارئ الشاشة (alt هو الوصف)
  demo.hidden = false;
  frame.classList.add('is-live');

  // الحالة الأولى: كل عنصر في موضعه النهائي، غير ظاهر
  gsap.set([question, diff], { autoAlpha: 0, y: 14 });
  // المربع داخل غلاف يقصّ (لينطوي)، فيدخل بتكبير طفيف لا بإزاحة تُقصّ حافته
  gsap.set(perm, { autoAlpha: 0, scale: .97, transformOrigin: '50% 100%' });
  gsap.set(diffWrap, { height: 0 });
  gsap.set(words, { autoAlpha: 0 });

  const tl = gsap.timeline({
    defaults: { ease: 'expo.out' },
    scrollTrigger: { trigger: frame, start: 'top 65%', once: true },
  });

  // ١. يُكتب السؤال: العربي ثم المسار
  const total = text.length + ref.length;
  const typing = { i: 0 };
  tl.to(typing, {
    i: total,
    duration: total * .034,
    ease: 'none',
    snap: { i: 1 },
    onUpdate: () => {
      typed.textContent = text.slice(0, typing.i);
      typedRef.textContent = ref.slice(0, Math.max(0, typing.i - text.length));
    },
  }, '+=.5');

  // ٢. إرسال: ضغطة على الزر، يفرغ المحرّر، وتصل الرسالة إلى الخيط
  tl.to(send, { scale: .94, duration: .08, ease: 'power2.out' }, '+=.35');
  tl.to(send, { scale: 1, duration: .25 });
  tl.add(() => {
    typed.textContent = '';
    typedRef.textContent = '';
    caret.classList.add('is-off');
  }, '<');
  tl.to(question, { autoAlpha: 1, y: 0, duration: .6 }, '<');

  // ٣. مربع الإذن العربي — قبل أي تعديل
  tl.to(perm, { autoAlpha: 1, scale: 1, duration: .55 }, '+=.8');

  // ٤. «موافقة»
  tl.to(okBtn, { scale: .94, duration: .08, ease: 'power2.out' }, '+=1.2');
  tl.add(() => { okBtn.classList.add('is-pressed'); }, '<');
  tl.to(okBtn, { scale: 1, duration: .25 });

  // ٥. بطاقة الفرق تنفتح تحت المربع أولاً، ثم ينطوي المربع — لا لحظة فارغة
  tl.to(diffWrap, { height: 'auto', duration: .6, ease: 'power3.inOut' }, '+=.1');
  tl.to(diff, { autoAlpha: 1, y: 0, duration: .6 }, '<+=.1');
  tl.to(perm, { autoAlpha: 0, duration: .3, ease: 'power2.in' }, '<+=.3');
  tl.to(permWrap, { height: 0, duration: .5, ease: 'power3.inOut' }, '<+=.1');

  // ٦. الجواب كلمة كلمة، كل كلمة في موضعها النهائي (لا إعادة تدفق)
  tl.to(words, { autoAlpha: 1, duration: .25, ease: 'none', stagger: .07 }, '+=.5');
})();
