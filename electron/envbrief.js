/** موجز موحّد لهوية «سطر» وأدوات كل محرك وسياسات التنفيذ والمتصفح. */

'use strict';

const runtimeenv = require('./runtimeenv');

const SDK_TOOL_NAMES = Object.freeze([
  'run_in_terminal', 'run_in_background', 'get_background_output', 'list_background_tasks', 'stop_background_task',
  'open_preview', 'browser_navigate', 'read_page', 'browser_snapshot', 'browser_console', 'browser_network',
  'screenshot', 'browser_screenshot_element', 'browser_wait_for', 'browser_scroll', 'browser_hover', 'browser_click',
  'browser_type', 'browser_select_option', 'browser_press_key', 'browser_handoff',
  'load_skill', 'read_skill_resource', 'verification_config', 'verify_project', 'propose_memory',
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
  return adapterToolNames();
}

function executionPolicy(engine) {
  const visible = engine === 'adapter' ? 'run_command' : (engine === 'sdk' ? 'run_in_terminal' : 'أداة exec الأصلية في Codex');
  const afterStart = engine === 'adapter'
    ? '- بعد تشغيل الخادم أخبر المستخدم بعنوانه ليعرضه في معاينة «سطر»، واستعمل get_background_output للاطلاع على السجل لاحقاً.'
    : '- بعد تشغيل الخادم استعمل open_preview للعرض، وget_background_output للاطلاع على السجل لاحقاً.';
  return [
    '## سياسة التنفيذ في سطر',
    '- أوامر التشغيل والبناء والاختبار والتثبيت التي يهم المستخدم رؤيتها: استخدم ' + visible + '، ولا تخفها في Bash داخلي.',
    '- خادم تطوير أو عملية طويلة/مستمرة: استخدم run_in_background حصراً؛ لا تشغّله في Bash خفي ولا تنتظر مهلة 120ث.',
    '- قبل تشغيل خادم استعمل list_background_tasks كي لا تنشئ نسخة ثانية.',
    afterStart,
    '- Bash/exec الداخلي القصير مسموح للفحص السريع مثل git status وقراءة حالة الملفات، لا للخوادم.',
  ].join('\n');
}

function browserPolicy(hasBrowser) {
  if (!hasBrowser) {
    return '## المتصفح\nهذا المحرك لا يملك أدوات تحكم المتصفح مباشرةً. لا تدّعِ أنك فحصت المعاينة؛ اطلب من المستخدم فتحها عند الحاجة.';
  }
  return [
    '## المعاينة والمتصفح',
    '- افتح صفحات الويب داخل معاينة «سطر» بأداة open_preview، لا Chrome/Edge/Firefox ولا أوامر فتح متصفح خارجي.',
    '- افحص ما بنيته عبر read_page وbrowser_snapshot وscreenshot وbrowser_console وbrowser_network.',
    '- خذ browser_snapshot قبل التفاعل، واستعمل refs مع browser_click/browser_type ثم خذ لقطة جديدة لأن refs تتغيّر.',
    '- عند تسجيل الدخول أو كلمة مرور أو 2FA استخدم browser_handoff ولا تطلب السر في المحادثة.',
  ].join('\n');
}

function build(engine, model, options) {
  const normalized = engine === 'sdk' || engine === 'codex' ? engine : 'adapter';
  const names = toolNames(normalized);
  const compact = Boolean(options && options.compact);
  const sections = [
    'أنت تعمل داخل تطبيق «سطر» (Satr)، واجهة سطح مكتب عربية تشغّل الوكيل وتعرض أدواته وأذوناته للمستخدم بشفافية.',
    'تواصل بالعربية افتراضياً في الشرح والردود، وأبقِ الكود والمسارات والأوامر والمصطلحات التقنية بالإنجليزية LTR؛ واتبع لغة أخرى إن طلبها المستخدم صراحةً.',
    'الأدوات المتاحة فعلياً لهذا المحرك: ' + names.join(', ') + '.',
    executionPolicy(normalized),
    browserPolicy(normalized !== 'adapter'),
    'إذا سأل المستخدم عن «سطر» نفسه أو ميزاته أو طريقة استخدامه، حمّل مهارة satr-guide واتبع دليلها قبل الإجابة.',
  ];
  if (normalized === 'sdk') {
    sections.push('استخدم AskUserQuestion حين تحتاج اختياراً واضحاً من المستخدم. استخدم propose_memory لاقتراح ذاكرة دائمة ولا تحفظها مباشرةً.');
  }
  sections.push(runtimeenv.environmentLine(normalized, model));
  return compact ? sections.join('\n') : sections.join('\n\n');
}

module.exports = { SDK_TOOL_NAMES, toolNames, build };
