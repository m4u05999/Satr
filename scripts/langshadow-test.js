/**
 * سطر — اختبار حارس الظلّ اللغوي (قطعي، بلا شبكة ولا قرص حقيقي).
 *
 * يحرس قرارات العصف الملزمة: أرقام بلا نص · الرسالة المكتملة فقط · القصير
 * والكودي خارج التسجيل · القصّ عند السقف · فشل القرص لا يرمي · ووصل نقطة
 * الاختناق الواحدة في `main.js` (فحص ساكن — نمط «موصول لكن غير مربوط»).
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { createShadow, MAX_FILE_BYTES } = require('../electron/langshadow');

let checks = 0;
function ok(cond, msg) { checks += 1; assert(cond, msg); }

/** fs مزيّف في الذاكرة — لا قرص حقيقي في اختبار قطعي. */
function fakeFs() {
  const files = new Map();
  return {
    files,
    mkdirSync() {},
    appendFileSync(file, data) { files.set(file, (files.get(file) || '') + data); },
    readFileSync(file) {
      if (!files.has(file)) { const e = new Error('ENOENT'); e.code = 'ENOENT'; throw e; }
      return files.get(file);
    },
    writeFileSync(file, data) { files.set(file, data); },
    renameSync(from, to) { files.set(to, files.get(from)); files.delete(from); },
    statSync(file) {
      if (!files.has(file)) { const e = new Error('ENOENT'); e.code = 'ENOENT'; throw e; }
      return { size: Buffer.byteLength(files.get(file), 'utf8') };
    },
  };
}

const ARABIC_LONG = 'راجعت الطبقات الثلاث كاملة ووجدت أن معالج الأذونات يبتلع الأخطاء، '
  + 'وأن منطق إعادة المحاولة لا يعمل إطلاقاً، وأن سجل التدقيق لا يحمل معرّفات الأدوات كلها.';
const ENGLISH_LONG = 'The review found three issues in the permission layer. First the '
  + 'handler swallows errors, second the retry logic never fires, and third the audit '
  + 'trail misses tool identifiers entirely across all engines in the pipeline.';

// ── 1) التسجيل: أرقام بلا نص، والانزلاق يُعلَّم ──────────────────────────────
{
  const io = fakeFs();
  const shadow = createShadow({ file: '/shadow/log.jsonl', fs: io });
  shadow.record({ text: ENGLISH_LONG, engine: 'sdk', phase: 'final_answer' });
  shadow.record({ text: ARABIC_LONG, engine: 'codex', phase: 'commentary' });
  const lines = io.files.get('/shadow/log.jsonl').trim().split('\n').map((l) => JSON.parse(l));
  ok(lines.length === 2, 'سطران مسجّلان');
  ok(lines[0].slip === true && lines[0].engine === 'sdk', 'الإنجليزي الطويل انزلاق موسوم بمحركه');
  ok(lines[1].slip === false && lines[1].phase === 'commentary', 'العربي سليم بطوره');
  ok(typeof lines[0].v === 'number', 'كل سطر يحمل إصدار المقياس');
  // **العقد الأخطر**: لا نص في السجل إطلاقاً
  const rawLog = io.files.get('/shadow/log.jsonl');
  ok(!rawLog.includes('review') && !rawLog.includes('راجعت'),
    'لا كلمة من نص الرسالة في السجل — نص في ملف مراقبة = تسريب');
  const keys = Object.keys(lines[0]).sort().join(',');
  ok(keys === 'at,engine,phase,reason,share,slip,strong,v',
    'قائمة حقول السطر مغلقة (وجدنا: ' + keys + ')');
}

// ── 2) القصير والكودي لا يسجَّلان — ضجيج يغرق التقرير ────────────────────────
{
  const io = fakeFs();
  const shadow = createShadow({ file: '/shadow/log.jsonl', fs: io });
  const shortVerdict = shadow.record({ text: 'Done.', engine: 'sdk' });
  const codeVerdict = shadow.record({ text: '```bash\nnpm test\n```', engine: 'sdk' });
  ok(shortVerdict && shortVerdict.reason === 'short', 'القصير يُقاس ولا يُسجَّل');
  ok(codeVerdict && codeVerdict.reason === 'no_prose', 'الكودي كذلك');
  ok(!io.files.has('/shadow/log.jsonl'), 'ولا ملف أُنشئ أصلاً');
}

// ── 3) القصّ عند السقف: سجل ظلّ لا أرشيف ────────────────────────────────────
{
  const io = fakeFs();
  const shadow = createShadow({ file: '/shadow/log.jsonl', fs: io });
  // نملأ فوق السقف بسطر ضخم مزروع ثم نسجّل — يجب أن يُقصّ إلى الذيل
  io.files.set('/shadow/log.jsonl', '{"old":1}\n'.repeat(60000));
  ok(Buffer.byteLength(io.files.get('/shadow/log.jsonl')) > MAX_FILE_BYTES, 'التمهيد فوق السقف فعلاً');
  shadow.record({ text: ENGLISH_LONG, engine: 'sdk' });
  ok(Buffer.byteLength(io.files.get('/shadow/log.jsonl')) <= MAX_FILE_BYTES,
    'الملف قُصّ تحت السقف بعد التسجيل');
}

// ── 4) فشل القرص لا يرمي — أفضل جهد مطلق ────────────────────────────────────
{
  const shadow = createShadow({
    file: '/shadow/log.jsonl',
    fs: { mkdirSync() { throw new Error('disk'); }, appendFileSync() { throw new Error('disk'); }, statSync() { throw new Error('disk'); } },
  });
  let threw = false;
  try { shadow.record({ text: ENGLISH_LONG, engine: 'sdk' }); } catch { threw = true; }
  ok(!threw, 'فشل القرص مبتلَع — الظلّ لا يمسّ الدور');
}

// ── 5) الوصل الساكن في main.js — نمط «موصول لكن غير مربوط» ──────────────────
{
  const main = fs.readFileSync(path.join(__dirname, '..', 'electron', 'main.js'), 'utf8');
  ok(/function emitToWindow[\s\S]{0,600}?shadowMeasureAssistant\(/.test(main),
    'الظلّ مستدعى من emitToWindow — نقطة الاختناق الواحدة بقرار العصف');
  ok(/obj\.type !== 'assistant'/.test(main),
    'ويقيس أحداث assistant المكتملة فقط (لا stream_text)');
  // الثابت هو الاحتواء داخل try لا شكل السطر: كانت الكتلة سطراً واحداً قبل أن يضاف
  // بثّ تلميح العرض (‏OBS-001 الخروج من الظلّ)، فصار نمط السطر الواحد يكسر حارساً
  // معناه سليم. تُقرأ الكتلة من `try {` إلى أول `} catch` ويُطلب أن تحويه.
  const block = main.slice(main.indexOf('function emitToWindow'));
  const tryBlock = block.slice(block.indexOf('try {'), block.indexOf('} catch'));
  ok(tryBlock.includes('shadowMeasureAssistant('),
    'والاستدعاء داخل try — فشله لا يسقط البث');
  ok(tryBlock.includes("send('satr:event', hint)"),
    'وبثّ تلميح العرض داخل الحماية نفسها — تلميحٌ يُسقط دوراً أسوأ من تلميح ضائع');
}

// ── 6) المرساة (دفعة 4) — وصلها الساكن في المحرّكين ─────────────────────────
{
  const agent = fs.readFileSync(path.join(__dirname, '..', 'electron', 'agent.js'), 'utf8');
  const codex = fs.readFileSync(path.join(__dirname, '..', 'electron', 'codex.js'), 'utf8');
  const envbriefSource = fs.readFileSync(path.join(__dirname, '..', 'electron', 'envbrief.js'), 'utf8');
  ok(/langanchor\.anchor\(\{ strong: !sessionId \|\| compactedSessions\.delete\(sessionId\) \}\)/.test(agent),
    'مرساة SDK ذيلية بقوية الدور الأول وما بعد الضغط');
  ok(/internalPolicy\s*\?\s*''\s*:\s*langanchor\.anchor/.test(agent),
    'والتشغيلات المعزولة خارجها');
  ok(/langanchor\.anchor\(\{ strong: !sessionId \|\| compactedThreads\.delete\(threadId\) \}\)/.test(codex),
    'مرساة Codex آخر عنصر إدخال بالتكافؤ نفسه');
  ok(/langanchor\.CONTRACT_LINE/.test(envbriefSource),
    'envbrief يستهلك نص العقد من مصدره الواحد');
  const { CONTRACT_LINE, anchor } = require('../electron/langanchor');
  ok(/تواصل بالعربية/.test(CONTRACT_LINE) && /سرد العمل بين استدعاءات الأدوات/.test(CONTRACT_LINE),
    'نص العقد الموسَّع يسمّي سرد العمل صراحةً — جوهر تشخيص الدفعة 3');
  ok(anchor({ strong: true }).length > anchor({}).length
    && anchor({}).includes('<satr_lang>'),
    'المرساة موسومة والقوية أطول من العادية');
}

// ── الخروج من الظلّ (‏OBS-001) — العرض المعايَر وممنوعاته المجمَّدة ──────────
{
  const main = fs.readFileSync(path.join(__dirname, '..', 'electron', 'main.js'), 'utf8');
  const app = fs.readFileSync(path.join(__dirname, '..', 'src', 'ui', 'app.js'), 'utf8');

  // ── المعايرة سلوكياً (لا نصّياً): قرار العرض دالة نقية في langshadow ────────
  const { visibleSlip } = require('../electron/langshadow');
  const verdictOf = (reason) => ({ slip: true, reason });
  ok(visibleSlip(verdictOf('share'), false) === true, 'الحصّة المنهارة تُعرض');
  ok(visibleSlip(verdictOf('script'), false) === true, 'والخط غير العربي يُعرض');
  // 11 من 20 انزلاقة كانت `structure` بحصص 0.90–0.95 — عربيةٌ في جوهرها وقد يكون
  // سطراها البنيويان جدولاً تقنياً مشروعاً. عرضها يعيد خطر الإنذار الكاذب.
  ok(visibleSlip(verdictOf('structure'), false) === false,
    'والبنية تبقى في الظلّ حتى يُتحقَّق منها بنصّ فعلي');
  ok(visibleSlip({ slip: false, reason: 'ok' }, false) === false, 'وغير المنزلق لا يُعرض');
  ok(visibleSlip(null, false) === false && visibleSlip(undefined, false) === false,
    'والحكم الغائب لا يُعرض (fail-closed)');
  // التجاوز يقمع **كل** الأسباب — لا استثناء
  for (const reason of ['share', 'script', 'structure']) {
    ok(visibleSlip(verdictOf(reason), true) === false,
      'التجاوز الصريح يقمع سبب «' + reason + '» — زرٌّ على ردٍّ طلبه المستخدم بنفسه'
        + ' أسوأ إنذار كاذب ممكن لأنه يعرف يقيناً أنه خاطئ');
  }
  ok(/VISIBLE_SLIP_REASONS = new Set\(\['share', 'script'\]\)/.test(
    fs.readFileSync(path.join(__dirname, '..', 'electron', 'langshadow.js'), 'utf8')),
  'وقائمة المعروض مغلقة صراحةً');

  // حقل override كان موثَّقاً وميتاً — وصلُه شرطُ ألّا يظهر الزر على ردٍّ طُلب بلغة أخرى
  ok(/langshadow\.record\(\{[\s\S]{0,200}?override,/.test(main),
    'علم التجاوز يصل السجل فعلاً (كان موثَّقاً بلا مستدعٍ)');
  ok(/langshadow\.visibleSlip\(verdict, override\)/.test(main),
    'وmain يستهلك الدالة النقية لا ينسخ منطقها');
  ok(/noteShadowOverride\(runEngine, activeSessionId, prompt\)/.test(main),
    'ويُرصد من نصّ المستخدم الخام عند الإرسال');
  // `sessionOverride` مستهلِكة للحالة — استدعاؤها من main يُفسد حالة المحرك
  ok(!/langoverride\.sessionOverride/.test(main),
    'وmain لا يستدعي sessionOverride المستهلِكة — الكاشف النقي وحده');
  ok(/shadowOverrides\.delete\(pending\)/.test(main),
    'وتبنّي المعلّق مطبَّق — بلا،ه يسقط القمع في أول دور وهو أشيع الحالات');

  // الممنوعات المجمَّدة: النقر هو الفعل، ولا ترجمة آلية
  ok(/ev\.type === 'lang_slip'/.test(app), 'الواجهة تستهلك الحدث');
  ok(/addActionNotice\(/.test(app.slice(app.indexOf("ev.type === 'lang_slip'"))),
    'وتعرضه إشعارَ فعلٍ لا حجباً');
  const handler = app.slice(app.indexOf("ev.type === 'lang_slip'"), app.indexOf("ev.type === 'lang_slip'") + 900);
  ok(/onAct|\(\) => \{/.test(handler) && /send\(\);/.test(handler),
    'والإرسال داخل معالج النقر لا خارجه — لا إعادة توليد تلقائية');
  ok(/الكود والمسارات والأوامر والمصطلحات التقنية بالإنجليزية/.test(handler),
    'ونصّ الطلب يحفظ عقد «سطر» نفسه فلا يُعرّب الكود');

  // حدث منسَّق: أرقام بلا نص، ولا يدخل مجرى المراقبة ولا أنواع المحركات
  ok(/type: 'lang_slip',\s*\n\s*schema_version: 1,/.test(main), 'الحدث موسوم بإصداره');
  ok(!/lang_slip[\s\S]{0,80}text/.test(main), 'ولا نص فيه — قاعدة «أرقام بلا نص» سارية بعد العرض');
  const known = fs.readFileSync(path.join(__dirname, '..', 'electron', 'main.js'), 'utf8')
    .match(/KNOWN_EVENT_TYPES[\s\S]{0,600}?\]/);
  ok(!known || !/lang_slip/.test(known[0]), 'وليس نوع حدث محرك (منسَّق نظير loop_update)');
}

console.log('langshadow-test: ok — ' + checks
  + ' فحصاً (أرقام بلا نص، القصّ، فشل القرص، ووصل الظلّ والمرساة، '
  + 'والخروج المعايَر من الظلّ بممنوعاته).');
