/**
 * سطر — مسبار انزلاق اللغة الحيّ (‏OBS-001، مدخل العصف الثلاثي).
 *
 * يقيس **سلوك «سطر» الإنتاجي لا سلوك CLI عارٍ**: كل دور يحمل موجز `envbrief.build`
 * الحقيقي — بتعليمة العربية الإرشادية نفسها التي أثبت بلاغا المالك (2026-08-13
 * و2026-08-14) أنها لا تكفي — عبر `--append-system-prompt`، وهو مسار محرك SDK نفسه
 * (‏preset claude_code + append).
 *
 * السيناريوهات من نمط الاستعمال الفعلي الذي انزلق في اللقطتين: تقرير مراجعة ·
 * جدول مقارنة · تشخيص خطأ إنجليزي المدخل · خطة خطوات · وسؤال عربي خالص (ضابط).
 *
 * **حدود معلنة**:
 * - يقيس نصّ **الإجابة النهائية** فقط؛ التفكير المعروض (commentary) لا يصل عبر
 *   `claude -p --output-format json` — قياسه يلزمه دور SDK كامل، وهو توسعة لاحقة
 *   إن طلبها العصف.
 * - يستهلك أدواراً حقيقية مدفوعة ⇒ **خارج test:full عمداً** كبقية المسابير الحية.
 * - النتيجة عيّنة يوم واحد لا توزيعاً إحصائياً؛ العصف يقرر إن كانت تكفي أو تلزم
 *   إعادات.
 *
 * التشغيل: node scripts/language-probe.js [--model sonnet] [--scenario report,...]
 * الخرج: جدول + JSON كامل في dist/language-probe/ ليأكله العصف الثلاثي.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const envbrief = require('../electron/envbrief');
const { arabicShare, structuralSlips } = require('../electron/langmetric');

const ROOT = path.resolve(__dirname, '..');
const OUT_DIR = path.join(ROOT, 'dist', 'language-probe');
const TURN_TIMEOUT_MS = 180000;

function arg(name, fallback) {
  const index = process.argv.indexOf('--' + name);
  return index !== -1 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

// برومبتات عربية بالكامل — الانزلاق رغم عربية السؤال هو جوهر البلاغين
const SCENARIOS = [
  {
    id: 'report',
    label: 'تقرير مراجعة كود',
    prompt: 'راجع هذه الدالة واكتب تقريراً موجزاً بالمشاكل التي تراها وترتيبها بالخطورة:\n\n'
      + '```js\nfunction loadUser(id, cb) {\n  fetch("/api/users/" + id).then(r => r.json())\n'
      + '    .then(u => { window.currentUser = u; cb(u); })\n    .catch(e => console.log(e));\n}\n```',
  },
  {
    id: 'table',
    label: 'جدول مقارنة',
    prompt: 'قارن بين WebSocket وlong-polling في جدول من حيث الكمون واستهلاك الموارد وتعقيد التنفيذ ودعم الوسطاء.',
  },
  {
    id: 'error',
    label: 'تشخيص خطأ إنجليزي المدخل',
    prompt: 'لماذا يفشل الاختبار عندي بهذا الخطأ؟ اشرح السبب والعلاج:\n\n'
      + '```\nTypeError: Cannot read properties of undefined (reading \'map\')\n'
      + '    at renderList (src/ui/list.js:42:18)\n    at process.processTicksAndRejections\n```',
  },
  {
    id: 'plan',
    label: 'خطة خطوات',
    prompt: 'اكتب لي خطة من خمس خطوات لترقية مشروع Node.js من الإصدار 18 إلى 22 بأقل مخاطرة.',
  },
  {
    id: 'control',
    label: 'سؤال عربي خالص (ضابط)',
    prompt: 'اشرح لي الفرق بين النسخ العميق والنسخ الضحل للكائنات، بمثال بسيط.',
  },
  {
    id: 'pressure',
    label: 'ضغط سياق إنجليزي كثيف (فرضية الانجراف)',
    // يحاكي منتصف جلسة وكيلية: مادة إنجليزية طويلة (خرج أدوات/توثيق) وسؤال عربي
    // قصير بعدها — نمط لقطتَي المالك. إن صمدت العربية هنا فالانجراف يقع أعمق
    // (تراكم أدوار لا مدخل واحد)، وإن انزلقت فالمدخل الإنجليزي وحده يكفي لجرّها.
    prompt: 'هذا خرج التحليل الذي جمعته من الأدوات:\n\n'
      + 'The authentication middleware validates each incoming request against the '
      + 'session store before any route handler executes. When the token has expired, '
      + 'the refresh flow issues a new pair and retries the original request once. '
      + 'Rate limiting sits in front of both paths and shares a sliding window per '
      + 'client, which means a burst of refresh attempts can starve legitimate '
      + 'traffic. The cache layer keeps user records for five minutes and is '
      + 'invalidated on every profile mutation, but the invalidation message is '
      + 'published on a channel that the read replicas do not subscribe to, so stale '
      + 'reads persist until the TTL expires. Deployment runs blue-green with a '
      + 'health gate that only checks liveness, not readiness, and the connection '
      + 'pool warms up lazily which produces a latency spike for the first hundred '
      + 'requests after every switch. Logging is structured JSON but the request id '
      + 'is generated after the auth step, so failures inside the middleware itself '
      + 'are effectively untraceable across services.\n\n'
      + 'لخّص لي أهم ثلاث مشاكل مرتّبة بالخطورة، واقترح علاجاً لكل واحدة.',
  },
];

function runTurn(prompt, systemAppend, model) {
  const args = ['-p', '--output-format', 'json', '--append-system-prompt', systemAppend];
  if (model) args.push('--model', model);
  const res = spawnSync('claude', args, {
    input: prompt,
    encoding: 'utf8',
    timeout: TURN_TIMEOUT_MS,
    shell: true, // ويندوز: claude ملف .cmd
    windowsHide: true,
    maxBuffer: 8 * 1024 * 1024,
  });
  if (res.error) return { ok: false, error: String(res.error.message || res.error) };
  if (res.status !== 0) {
    return { ok: false, error: 'exit ' + res.status + ': ' + String(res.stderr || '').slice(0, 200) };
  }
  try {
    const parsed = JSON.parse(res.stdout);
    if (parsed && typeof parsed.result === 'string') {
      return {
        ok: true,
        text: parsed.result,
        cost: typeof parsed.total_cost_usd === 'number' ? parsed.total_cost_usd : null,
      };
    }
    return { ok: false, error: 'no result field' };
  } catch {
    return { ok: false, error: 'bad json: ' + String(res.stdout || '').slice(0, 120) };
  }
}

function main() {
  const model = arg('model', '');
  const only = arg('scenario', '').split(',').filter(Boolean);
  const scenarios = only.length ? SCENARIOS.filter((s) => only.includes(s.id)) : SCENARIOS;

  // موجز سطر الإنتاجي الحقيقي لمحرك sdk — لا نسخة مسبار تتقادم
  const brief = envbrief.build('sdk', model || 'default');
  if (!/تواصل بالعربية/.test(brief)) {
    console.error('language-probe: FAIL — موجز envbrief بلا تعليمة العربية؛ العقد تغيّر.');
    process.exit(1);
  }

  console.log('language-probe: ' + scenarios.length + ' سيناريو × محرك sdk'
    + (model ? ' (' + model + ')' : ' (النموذج الافتراضي)')
    + ' — بموجز envbrief الإنتاجي.\n');

  const rows = [];
  let totalCost = 0;
  for (const scenario of scenarios) {
    process.stdout.write('  ' + scenario.id.padEnd(9) + '… ');
    const turn = runTurn(scenario.prompt, brief, model);
    if (!turn.ok) {
      console.log('فشل الدور: ' + turn.error);
      rows.push({ id: scenario.id, label: scenario.label, ok: false, error: turn.error });
      continue;
    }
    const measured = arabicShare(turn.text);
    const slips = structuralSlips(turn.text);
    if (turn.cost) totalCost += turn.cost;
    rows.push({
      id: scenario.id,
      label: scenario.label,
      ok: true,
      arabic: measured.arabic,
      latin: measured.latin,
      share: measured.share,
      structural_slips: slips,
      cost_usd: turn.cost,
      answer_chars: turn.text.length,
      answer: turn.text,
    });
    console.log('حصّة العربية '
      + (measured.share === null ? '—' : (measured.share * 100).toFixed(1) + '%')
      + ' (ع ' + measured.arabic + ' / لا ' + measured.latin + ')'
      + (slips.length ? ' · بنية إنجليزية: ' + slips.length + ' سطراً' : ''));
  }

  console.log('\n──── الخلاصة ────');
  for (const row of rows) {
    if (!row.ok) { console.log('  ' + row.id.padEnd(9) + 'فشل: ' + row.error); continue; }
    console.log('  ' + row.id.padEnd(9)
      + (row.share === null ? '  —  ' : (row.share * 100).toFixed(1).padStart(5) + '%')
      + '  بنية إنجليزية: ' + String(row.structural_slips.length).padStart(2)
      + '  | ' + row.label);
  }
  console.log('\nالكلفة الإجمالية: ~$' + totalCost.toFixed(4));

  fs.mkdirSync(OUT_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const file = path.join(OUT_DIR, stamp + '.json');
  fs.writeFileSync(file, JSON.stringify({
    at: stamp,
    engine: 'sdk',
    model: model || 'default',
    brief_included: true,
    rows,
  }, null, 2), 'utf8');
  console.log('الخرج الكامل: ' + path.relative(ROOT, file));
  console.log('\nالحدود المعلنة: الإجابة النهائية فقط (لا التفكير المعروض)، وعيّنة يوم واحد لا توزيع.');
}

main();
