/** موجز موحّد لهوية «سطر» وأدوات كل محرك وسياسات التنفيذ والمتصفح. */

'use strict';

const runtimeenv = require('./runtimeenv');
const langanchor = require('./langanchor');

const SDK_TOOL_NAMES = Object.freeze([
  'run_in_terminal', 'run_in_background', 'get_background_output', 'wait_for_background_task',
  'list_background_tasks', 'stop_background_task',
  'open_preview', 'close_preview', 'browser_navigate', 'read_page', 'browser_readability', 'browser_snapshot', 'browser_console', 'browser_network',
  'screenshot', 'browser_screenshot_element', 'browser_wait_for', 'browser_scroll', 'browser_hover', 'browser_click',
  'browser_type', 'browser_select_option', 'browser_press_key', 'browser_handoff',
  'browser_fill_form', 'browser_transfer_field', 'browser_request_secret', 'browser_handoff_step',
  'browser_evaluate', 'browser_set_viewport', 'browser_perf', 'browser_back', 'browser_forward',
  'generate_media',
  'promo_record_start', 'promo_record_stop', 'promo_list_segments', 'promo_propose_storyboard',
  'load_skill', 'read_skill_resource', 'verification_config', 'verify_project', 'propose_memory',
]);
const KIMI_EXTRA_TOOL_NAMES = Object.freeze([
  'verification_config', 'verify_project', 'update_task_ledger',
  'propose_memory', 'load_skill', 'read_skill_resource',
]);

function codexToolNames() {
  const codexmcp = require('./codexmcp');
  return codexmcp.buildTools({ preview: {} }).map((tool) => tool.name);
}

function adapterToolNames() {
  const tools = require('./tools');
  return tools.defs().map((def) => def.function.name);
}

function toolNames(engine) {
  if (engine === 'sdk') return Array.from(SDK_TOOL_NAMES);
  if (engine === 'codex') return codexToolNames();
  if (engine === 'kimi-code') return codexToolNames().concat(KIMI_EXTRA_TOOL_NAMES);
  return adapterToolNames();
}

function executionPolicy(engine) {
  const visible = engine === 'adapter' ? 'run_command'
    : engine === 'sdk' ? 'run_in_terminal'
      : engine === 'kimi-code' ? 'أداة Bash المدمجة في Kimi Code بعد إذن المستخدم' : 'أداة exec الأصلية في Codex';
  const afterStart = engine === 'adapter'
    ? '- بعد تشغيل الخادم أخبر المستخدم بعنوانه ليعرضه في معاينة «سطر»، واستعمل get_background_output للاطلاع على السجل لاحقاً.'
    : '- بعد تشغيل الخادم استعمل open_preview للعرض، وget_background_output للاطلاع على السجل لاحقاً.';
  return [
    '## سياسة التنفيذ في سطر',
    '- أوامر التشغيل والبناء والاختبار والتثبيت التي يهم المستخدم رؤيتها: استخدم ' + visible + '، ولا تخفها في Bash داخلي.',
    '- خادم تطوير أو عملية طويلة/مستمرة: استخدم run_in_background حصراً؛ لا تشغّله في Bash خفي ولا تنتظر مهلة 120ث.',
    '- قبل تشغيل خادم استعمل list_background_tasks كي لا تنشئ نسخة ثانية.',
    afterStart,
    '- لا تنتظر مهمة خلفية بحلقة نوم ثم list_background_tasks؛ استعمل wait_for_background_task فيعود لحظة خروجها برمز الخروج وذيل السجل. وإن اختفت مهمة من القائمة فسبب خروجها محفوظ في recent_exits داخل list_background_tasks وفي get_background_output بمعرّفها.',
    '- Bash/exec الداخلي القصير مسموح للفحص السريع مثل git status وقراءة حالة الملفات، لا للخوادم.',
    '- في إعداد المنصات فضّل API/CLI المتاح مثل gh وnetlify عبر الطرفية المرئية؛ استخدم المتصفح فقط حين لا توجد واجهة برمجية سلسة أو تلزم لوحة بصرية.',
    '- توليد الصور ثلاث طبقات: تصميم نصي/هوية بنص عربي (بوست/بطاقة/إعلان) ⇒ ابنه HTML/CSS بخط المشروع والتقطه PNG (نماذج الانتشار المتاحة تشوّه العربية)؛ مشهد توليدي بلا نص داخلي ⇒ أداة generate_media الداخلية (كلفة شفافة قبل التنفيذ وسجل معرض 🖼)؛ وموصّل خارجي مثل Higgsfield فقط إن سمّاه المستخدم صراحةً في طلبه.',
  ].join('\n');
}

function browserPolicy(hasBrowser) {
  if (!hasBrowser) {
    return '## المتصفح\nهذا المحرك لا يملك أدوات تحكم المتصفح مباشرةً. لا تدّعِ أنك فحصت المعاينة؛ اطلب من المستخدم فتحها عند الحاجة.';
  }
  return [
    '## المعاينة والمتصفح',
    '- افتح صفحات الويب داخل معاينة «سطر» بأداة open_preview، لا Chrome/Edge/Firefox ولا أوامر فتح متصفح خارجي.',
    '- ابدأ بـ browser_snapshot لفهم البنية، واستعمل screenshot البصرية للحكم على التخطيط فقط؛ وأكمل الفحص عبر read_page وbrowser_console وbrowser_network.',
    '- لصفحة فيها نصّ بالحرف العربي (عربية/فارسية/دَرية/أردو/بشتو/كردية/سندية/أويغورية) استعمل browser_readability: يقيس رسو اتجاه كل فقرة بالبكسل والتباين والتجاوز الأفقي وتحميل الخط. لا تحكم على الاتجاه بالنظر ولا بـ getComputedStyle — كلاهما يعيد rtl الموروثة بينما الفقرة رست LTR. أصلح ثم أعد القياس، ولا تدّعِ السلامة قبل صفر مخالفات مع ذكر ما لم يُرَ (unseen).',
    '- خذ browser_snapshot قبل التفاعل، واستعمل refs مع browser_click/browser_type. إذا تدخّل المستخدم أو تغيّر/أزيل الهدف بعد اللقطة، لا تكرر الفعل؛ خذ browser_snapshot جديدة وتحقق من الهدف.',
    '- لوحة معاينة «سطر» أضيق وأقصر من متصفح عادي؛ للحكم على تخطيط الصفحة كاملةً استعمل screenshot مع full_page:true، أو اضبط browser_set_viewport أولاً إن كنت تختبر مقاساً بعينه.',
    '- إغلاق المعاينة: زر ✕ في اللوحة (أو أداة close_preview) يدمّر العرض فعلاً — لا يخفيه — لكن الكوكيز تبقى في partition الدائمة، وإعادة فتح 🌐 تستعيد آخر عنوان للمشروع تلقائياً (ميزة «تذكّر آخر مشروع») فقد تبدو الصفحة «عادت». لصفحة نظيفة وجّه المستخدم إلى زر 🧹 مسح التخزين، أو انتقل بنفسك لعنوان آخر. لا تدّعِ أن ✕ «يخفي فقط».',
    '- القراءة حرة في وضع تحكم المتصفح؛ أما الفعل والتنقّل وbrowser_evaluate على نطاق خارجي جديد فتحتاج ثقة المستخدم بالنطاق مرة واحدة. localhost موثوق دائماً.',
    '- الثقة بالنطاق لا تعفي الفعل الحسّاس: الإرسال والحفظ والنشر والحذف والتفويض وbrowser_evaluate تُؤكّد كل مرة، ولا تعتبر وضع تحكّم المتصفح إذناً دائماً لها.',
    '- لا تمرّر مفتاح API أو رمزاً أو كلمة مرور كنص إلى أي أداة أو إلى browser_fill_form. انقل القيمة بين الحقول عبر browser_transfer_field، أو اطلب من المستخدم إدخالها بنفسه عبر browser_request_secret؛ لا تذكر القيمة في الرد أو الذاكرة.',
    '- استعمل browser_fill_form لتعبئة مجموعة حقول غير سرّية من سياق المهمة، واجعل إرسال النموذج فعلاً مستقلاً. عند خطوة بشرية واحدة استعمل browser_handoff_step مع resume_hint واضحاً ثم خذ browser_snapshot جديداً.',
    '- في إعداد متعدد المنصات حدّث Task Ledger بخطة/أداة المهام المتاحة لمحركك بعد كل محطة؛ تصل الواجهة بعقد task_update موضحاً ما اكتمل وما ينتظر المستخدم وما يلي.',
    '- تحقق من التجاوب فعلياً عبر browser_set_viewport، ثم أرفق دليلاً من screenshot أو القيم الفعلية؛ واستعمل browser_perf لتشخيص البطء.',
    '- عند تسجيل الدخول أو كلمة مرور أو 2FA استخدم browser_handoff ولا تطلب السر في المحادثة.',
    '- لتسجيل عرض تسويقي استعمل promo_record_start بعد إذن المستخدم الصريح، قد المنتج بأدوات browser_*، ثم promo_record_stop؛ الالتقاط محصور بنافذة المنتج والملفات تبقى في Downloads بلا رفع.',
    '- بعد التسجيل اقترح storyboard عبر promo_propose_storyboard بمقاطع وأصوات محلية داخل Downloads فقط؛ المستخدم يعدّل ويعتمد الخط الزمني قبل التصيير الفوري في الواجهة.',
    '- إن كانت أداة Higgsfield generate_audio متاحة فاستعملها للموسيقى أو التعليق، نزّل الناتج إلى Downloads أولاً، ثم مرّر المسار المحلي في music أو voice؛ لا تمرّر URL بعيداً للاستوديو.',
  ].join('\n');
}

// ── صدق تسمية الوكلاء الفرعيين (OBS-012 بند ج) ───────────────────────────────────
// بلاغ مالك بلقطة (2026-08-17): وكيل SDK أطلق ثلاثة وكلاء فرعيين — وهم Claude نفسه
// بسياقات معزولة — **وسمّاهم «كودكس/كيمي/أوبس»** بشخصيات، فبدت للمستخدم نماذجَ
// مختلفة حقيقية؛ اكتشف الخداع بحدسه لا من الواجهة. تنويعٌ أسلوبي بيع تنويعَ نماذج.
// هذا عيب **صدق** لا نقص ميزة، ولذلك التوجيه صريح ويحمل البديل الحقيقي معه.
const SUBAGENT_NAMING_LINE = 'صدق تسمية الوكلاء الفرعيين: وكلاؤك الفرعيون هم أنت '
  + 'بسياقات معزولة، لا نماذج أخرى. لا تسمّهم باسم محرّك آخر (كودكس/كيمي/جيميني…) ولا '
  + 'تنسب إليهم آراء «نماذج مختلفة» — تنوّع الأسلوب ليس تنوّع النماذج. إن أراد المستخدم '
  + 'رأي نماذج حقيقية متعددة فاعرض عليه الطرق أدناه بدل تمثيلها.';

// ── العصف متعدد الآراء: اعرض الطرق القائمة (OBS-012 بند أ) ───────────────────────
// بلاغ مالك (2026-08-14): طُلب من الوكيل «عصف ثلاثي كما يفعله القائد» فأجاب أن كيمي
// وكودكس «محرّكان يُقادان من غرفة العمليات لا أدوات تُستدعى من داخل جلسة» — جوابٌ
// صحيح معمارياً لكنه **اختار الوصف بدل الحلّ**، والطرق الثلاث كانت متاحة كلها.
// الفجوة معرفية لا قدرة نموذج، فعلاجها أن يعرف الوكيل الطرق ويعرضها.
const MULTI_OPINION_LINE = 'العصف متعدد الآراء: حين يطلب المستخدم آراءً متعددة أو '
  + 'قراراً عالي الأثر، اعرض الطرق المتاحة فعلاً بدل الاكتفاء بوصف ما لا تستطيع: '
  + '(1) مهارة satr-diverge — فروع متوازية معزولة ثم نقد ومراجعة خصومية، وتُحمَّل '
  + 'بـload_skill؛ (2) عصف غرفة العمليات — آراء مستقلة من Claude وCodex (وKimi Code '
  + 'ثالثاً حين يكون جاهزاً) كلٌّ في مجلد فارغ بلا أدوات؛ (3) تشغيل محرّك آخر من '
  + 'الطرفية المرئية بأعلامه الصحيحة (docs/AGENT-CLI-FLAGS.md) والتصريح بأن هذا ما فعلته.';

function build(engine, model, options) {
  const normalized = engine === 'sdk' || engine === 'codex' || engine === 'kimi-code' ? engine : 'adapter';
  const names = toolNames(normalized);
  const compact = Boolean(options && options.compact);
  const sections = [
    'أنت تعمل داخل تطبيق «سطر» (Satr)، واجهة سطح مكتب عربية تشغّل الوكيل وتعرض أدواته وأذوناته للمستخدم بشفافية.',
    // نص عقد اللغة من مصدره الواحد (OBS-001 دفعة 4): الصياغة القديمة «في الشرح
    // والردود» كانت تُفهَم على الإجابات فيسقط سرد العمل الوكيلي إلى الإنجليزية
    // من أول سطر — التشخيص المقيس في docs/LANGUAGE-CONTRACT.md.
    langanchor.CONTRACT_LINE,
    'الأدوات المتاحة فعلياً لهذا المحرك: ' + names.join(', ') + '.',
    executionPolicy(normalized),
    browserPolicy(normalized !== 'adapter'),
    'إذا سأل المستخدم عن «سطر» نفسه أو ميزاته أو طريقة استخدامه، حمّل مهارة satr-guide واتبع دليلها قبل الإجابة.',
  ];
  // المحرّكات الأصيلة الثلاثة وحدها تملك وكلاء فرعيين فعلاً (Task/spawn_agent/Agent)،
  // فلا يُثقَل موجز المحوّلات بسطر عن قدرة لا يملكونها. **حدّ مُصرَّح به**: محوّل
  // claude-cli الاحتياطي يُطبَّع 'adapter' فلا يصله السطر رغم امتلاكه Task — مسار
  // احتياطي نادر، ولم نوسّع التطبيع لأجله كي لا نغيّر تصنيفاً يستهلكه جرد الأدوات.
  if (normalized !== 'adapter') sections.push(SUBAGENT_NAMING_LINE);
  // طرق العصف متاحة لكل محرك: satr-diverge مهارة محمولة تعلنها كل الأسطح، وغرفة
  // العمليات سطح تطبيق لا قدرة محرك — فالسطر ينفع المحوّلات أيضاً.
  sections.push(MULTI_OPINION_LINE);
  if (normalized === 'sdk' || normalized === 'kimi-code') {
    sections.push('استخدم AskUserQuestion حين تحتاج اختياراً واضحاً من المستخدم. استخدم propose_memory لاقتراح ذاكرة دائمة ولا تحفظها مباشرةً.');
  }
  sections.push(runtimeenv.environmentLine(normalized, model));
  return compact ? sections.join('\n') : sections.join('\n\n');
}

module.exports = { SDK_TOOL_NAMES, toolNames, build };
