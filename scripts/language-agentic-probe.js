/**
 * سطر — التحقق الحيّ من مرساة اللغة على سردٍ وكيلي حقيقي (‏OBS-001، بوابة الدفعة 4).
 *
 * التشخيص المقيس (دفعة 3): الانهيار في **سرد العمل بين استدعاءات الأدوات** في
 * الجلسات الوكيلية تحديداً — لا في الإجابات. فلا يُجمَّد العلاج قبل إثبات أثره على
 * هذا النمط بعينه: مهمة حقيقية بأدوات (قراءة/تعديل ملفات) بذراعين —
 * **بلا مرساة** و**بالمرساة الذيلية القوية** — وقياس النثر لكل رسالة مساعد
 * (‏stream-json يعطي الرسائل كلها لا النهائية وحدها).
 *
 * يستهلك دورين وكيليين مدفوعين ⇒ خارج test:full أبداً.
 * التشغيل: node scripts/language-agentic-probe.js [--model sonnet]
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const envbrief = require('../electron/envbrief');
const langanchor = require('../electron/langanchor');
const { arabicShare, METRIC_VERSION } = require('../electron/langmetric');

const ROOT = path.resolve(__dirname, '..');
const TURN_TIMEOUT_MS = 480000;

function arg(name, fallback) {
  const index = process.argv.indexOf('--' + name);
  return index !== -1 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

/** مشروع خدش صغير بعطل مزروع — يفرض عدة استدعاءات أدوات وسرداً بينها. */
function makeFixture(tag) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'satr-lang-agentic-' + tag + '-'));
  fs.writeFileSync(path.join(dir, 'validate.js'),
    'function validateUser(user) {\n'
    + '  return user.name.trim().length > 0; // يتعطل حين user بلا name\n'
    + '}\nmodule.exports = { validateUser };\n', 'utf8');
  fs.writeFileSync(path.join(dir, 'app.js'),
    "const { validateUser } = require('./validate');\n"
    + "console.log(validateUser({ name: 'أحمد' }));\n"
    + 'console.log(validateUser({}));\n', 'utf8');
  fs.writeFileSync(path.join(dir, 'README.md'),
    '# تجربة\nمشروع تجريبي صغير لفحص التحقق.\n', 'utf8');
  return dir;
}

const TASK = 'اقرأ ملفات هذا المجلد، وشغّل node app.js لترى الخطأ، ثم أصلح دالة التحقق'
  + ' كي لا تتعطل مع كائن بلا name، وتأكد بإعادة التشغيل، وأخبرني بما فعلت.';

function runAgentic(cwd, prompt, systemAppend, model) {
  const args = ['-p', '--output-format', 'stream-json', '--verbose',
    '--permission-mode', 'acceptEdits', '--append-system-prompt', systemAppend];
  if (model) args.push('--model', model);
  const res = spawnSync('claude', args, {
    cwd,
    input: prompt,
    encoding: 'utf8',
    timeout: TURN_TIMEOUT_MS,
    shell: true,
    windowsHide: true,
    maxBuffer: 32 * 1024 * 1024,
  });
  if (res.error) return { ok: false, error: String(res.error.message || res.error) };
  const messages = [];
  let cost = null;
  for (const line of String(res.stdout || '').split('\n')) {
    if (!line.trim()) continue;
    let parsed;
    try { parsed = JSON.parse(line); } catch { continue; }
    if (parsed.type === 'assistant' && parsed.message && Array.isArray(parsed.message.content)) {
      let text = '';
      for (const block of parsed.message.content) {
        if (block && block.type === 'text' && typeof block.text === 'string') text += block.text;
      }
      if (text.trim()) messages.push(text);
    }
    if (parsed.type === 'result' && typeof parsed.total_cost_usd === 'number') cost = parsed.total_cost_usd;
  }
  return { ok: true, messages, cost };
}

function measureArm(label, withAnchor, model) {
  const dir = makeFixture(withAnchor ? 'anchor' : 'plain');
  const brief = envbrief.build('sdk', model || 'default');
  const prompt = withAnchor ? TASK + '\n\n' + langanchor.anchor({ strong: true }) : TASK;
  const run = runAgentic(dir, prompt, brief, model);
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* أفضل جهد */ }
  if (!run.ok) return { label, ok: false, error: run.error };

  // السرد = كل رسائل المساعد عدا الأخيرة (الإجابة الختامية) — موضع التشخيص بالضبط
  const narration = run.messages.slice(0, -1);
  const final = run.messages[run.messages.length - 1] || '';
  const measure = (texts) => {
    let arabic = 0; let latin = 0;
    for (const text of texts) {
      const m = arabicShare(text);
      arabic += m.arabic; latin += m.latin;
    }
    return { arabic, latin, share: arabic + latin ? arabic / (arabic + latin) : null };
  };
  return {
    label,
    ok: true,
    messages: run.messages.length,
    narration_messages: narration.length,
    narration: measure(narration),
    final: measure([final]),
    per_message: run.messages.map((t) => {
      const m = arabicShare(t);
      return m.share === null ? null : Math.round(m.share * 100);
    }),
    cost: run.cost,
  };
}

function fmt(share) {
  return share === null ? '—' : (share * 100).toFixed(1) + '%';
}

function main() {
  const model = arg('model', '');
  console.log('language-agentic-probe: مهمة وكيلية حقيقية بذراعين — metric v' + METRIC_VERSION
    + (model ? ' (' + model + ')' : ' (النموذج الافتراضي)') + '\n');

  const plain = measureArm('بلا مرساة', false, model);
  const anchored = measureArm('بالمرساة القوية', true, model);

  let total = 0;
  for (const arm of [plain, anchored]) {
    if (!arm.ok) { console.log('  ' + arm.label + ': فشل — ' + arm.error); continue; }
    total += arm.cost || 0;
    console.log('  ' + arm.label + ':');
    console.log('    رسائل: ' + arm.messages + ' (سرد: ' + arm.narration_messages + ')'
      + ' · حصّة السرد: ' + fmt(arm.narration.share)
      + ' · حصّة الختام: ' + fmt(arm.final.share)
      + ' · $' + (arm.cost || 0).toFixed(3));
    console.log('    تسلسل الرسائل: ' + arm.per_message.map((v) => v === null ? '·' : v).join(' '));
  }
  console.log('\nالكلفة: ~$' + total.toFixed(3));

  const outDir = path.join(ROOT, 'dist', 'language-probe');
  fs.mkdirSync(outDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  fs.writeFileSync(path.join(outDir, 'agentic-' + stamp + '.json'), JSON.stringify({
    at: stamp, kind: 'agentic-anchor-validation', model: model || 'default',
    metric_version: METRIC_VERSION, arms: [plain, anchored],
  }, null, 2), 'utf8');
  console.log('الخرج: dist/language-probe/agentic-' + stamp + '.json');
}

main();
