/**
 * سطر — تجربة فصل السببية: تلويث خارجي أم قفل ذاتي؟ (‏OBS-001، الدفعة 3)
 *
 * السؤال الذي تحسمه: القياس الرجعي أثبت أن الجلسات المنهارة مقفولة على الإنجليزية
 * **من أول ردّ مساعد** — لكن «ارتباط لا سببية» (تحفظ كودكس). ذراعان متسلسلتان
 * بالدور الحقيقي (`--resume`) تفصلان الآليتين:
 *
 *   A) **التلويث الخارجي**: أدوار عربية تتخللها كتل «خرج أدوات» إنجليزية حتمية
 *      متعاظمة (~20k ثم 40k ثم 60k رمز تقديري) — هل يكسر تراكمُ الإنجليزية
 *      **المدخلة** عربيةَ الردود؟
 *   B) **القفل الذاتي**: الدور الأول يطلب الإنجليزية صراحةً (يستغل بند «طلب
 *      المستخدم يجُبّ» في العقد) فيصير أول ردّ مساعد إنجليزياً، ثم أدوار عربية
 *      عادية بلا أي طلب — هل يبقى النموذج مقفولاً على مثاله الأول؟
 *   C) **ضابط**: السلسلة العربية نفسها بلا تلويث ولا قفل.
 *
 * كل دور بموجز `envbrief` الإنتاجي، والقياس بـ`langmetric` الموسوم.
 *
 * **حدود معلنة**: `steer` وما بعد `/ضغط` خارج هذه التجربة — عقدا تطبيقٍ لا
 * يبلغهما `claude -p`، ويُقاسان لاحقاً داخل «سطر» إن لزم. والعيّنة سلسلة واحدة
 * لكل ذراع (تكفي لفصل الآلية لا لتوزيع إحصائي). يستهلك أدواراً مدفوعة —
 * **خارج test:full أبداً**.
 *
 * التشغيل: node scripts/language-drift-probe.js [--model sonnet] [--arm A,B,C]
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const envbrief = require('../electron/envbrief');
const { arabicShare, isSlip, METRIC_VERSION } = require('../electron/langmetric');

const ROOT = path.resolve(__dirname, '..');
const OUT_DIR = path.join(ROOT, 'dist', 'language-probe');
const TURN_TIMEOUT_MS = 420000;

function arg(name, fallback) {
  const index = process.argv.indexOf('--' + name);
  return index !== -1 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

/** حشو إنجليزي تقني **حتمي**: الفقرة نفسها بعدّاد — لا عشوائية فلا تغيّر بين تشغيلين. */
function englishFiller(paragraphs) {
  const out = [];
  for (let i = 1; i <= paragraphs; i++) {
    out.push('[tool-output ' + i + '] The request pipeline validates the incoming payload '
      + 'against the session store before any handler executes, and when the token has '
      + 'expired the refresh flow issues a new pair and retries exactly once. Rate limiting '
      + 'shares a sliding window per client, the cache keeps records for five minutes, and '
      + 'the invalidation channel is not consumed by read replicas so stale reads persist '
      + 'until the TTL expires. Deployment remains blue-green with a liveness-only gate, '
      + 'the connection pool warms lazily producing a spike after every switch, and the '
      + 'request identifier is generated after authentication which leaves middleware '
      + 'failures effectively untraceable across downstream services.');
  }
  return out.join('\n');
}

// ~90 رمزاً تقديرياً للفقرة الواحدة ⇒ الأحجام التقريبية المعلنة في الرأس
const FILLER_SMALL = englishFiller(220);   // ~20k رمز
const FILLER_MEDIUM = englishFiller(440);  // ~40k رمز
const FILLER_LARGE = englishFiller(660);   // ~60k رمز

const QUESTIONS = [
  'ما أهم ثلاثة أخطاء شائعة في التعامل مع الوعود (Promises) في JavaScript؟ باختصار.',
  'اشرح لي متى أستخدم مصفوفة ومتى أستخدم Set في تخزين معرّفات.',
  'ما الفرق بين المهلة (timeout) والإجهاض (abort) في طلبات الشبكة؟',
];

const ARMS = {
  A: {
    label: 'التلويث الخارجي',
    turns: [
      { id: 'A1-control', prompt: QUESTIONS[0] },
      { id: 'A2-small', prompt: 'هذا خرج الأدوات الذي جمعته:\n\n' + FILLER_SMALL + '\n\n' + QUESTIONS[1] },
      { id: 'A3-medium', prompt: 'وهذا خرج إضافي:\n\n' + FILLER_MEDIUM + '\n\n' + QUESTIONS[2] },
      { id: 'A4-large', prompt: 'وخرج أخير:\n\n' + FILLER_LARGE + '\n\nلخّص لي بالمجمل ما ناقشناه في هذه الجلسة.' },
    ],
  },
  B: {
    label: 'القفل الذاتي',
    turns: [
      { id: 'B1-seed-en', prompt: QUESTIONS[0] + '\n\nأجب بالإنجليزية هذه المرة فقط.' },
      { id: 'B2-plain', prompt: QUESTIONS[1] },
      { id: 'B3-plain', prompt: QUESTIONS[2] },
      { id: 'B4-plain', prompt: 'لخّص لي بالمجمل ما ناقشناه في هذه الجلسة.' },
    ],
  },
  C: {
    label: 'الضابط',
    turns: [
      { id: 'C1', prompt: QUESTIONS[0] },
      { id: 'C2', prompt: QUESTIONS[1] },
      { id: 'C3', prompt: QUESTIONS[2] },
      { id: 'C4', prompt: 'لخّص لي بالمجمل ما ناقشناه في هذه الجلسة.' },
    ],
  },
};

function runTurn(prompt, systemAppend, model, resumeId) {
  const args = ['-p', '--output-format', 'json', '--append-system-prompt', systemAppend];
  if (model) args.push('--model', model);
  if (resumeId) args.push('--resume', resumeId);
  const res = spawnSync('claude', args, {
    input: prompt,
    encoding: 'utf8',
    timeout: TURN_TIMEOUT_MS,
    shell: true,
    windowsHide: true,
    maxBuffer: 16 * 1024 * 1024,
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
        sessionId: typeof parsed.session_id === 'string' ? parsed.session_id : null,
        cost: typeof parsed.total_cost_usd === 'number' ? parsed.total_cost_usd : null,
      };
    }
    return { ok: false, error: 'no result field' };
  } catch {
    return { ok: false, error: 'bad json' };
  }
}

function main() {
  const model = arg('model', '');
  const only = arg('arm', '').split(',').filter(Boolean);
  const armNames = only.length ? only : ['A', 'B', 'C'];
  const brief = envbrief.build('sdk', model || 'default');

  console.log('language-drift-probe: الأذرع ' + armNames.join('،')
    + (model ? ' (' + model + ')' : ' (النموذج الافتراضي)') + ' — metric v' + METRIC_VERSION + '\n');

  const results = [];
  let totalCost = 0;

  for (const armName of armNames) {
    const armDef = ARMS[armName];
    if (!armDef) continue;
    console.log('── الذراع ' + armName + ' (' + armDef.label + ') ──');
    let sessionId = null;
    for (const turn of armDef.turns) {
      process.stdout.write('  ' + turn.id.padEnd(11) + '… ');
      const outcome = runTurn(turn.prompt, brief, model, sessionId);
      if (!outcome.ok) {
        console.log('فشل: ' + outcome.error);
        results.push({ arm: armName, id: turn.id, ok: false, error: outcome.error });
        break; // السلسلة انقطعت — لا معنى لأدوارها التالية
      }
      sessionId = outcome.sessionId || sessionId;
      const measured = arabicShare(outcome.text);
      const verdict = isSlip(outcome.text);
      if (outcome.cost) totalCost += outcome.cost;
      results.push({
        arm: armName,
        id: turn.id,
        ok: true,
        share: measured.share,
        arabic: measured.arabic,
        latin: measured.latin,
        slip: verdict.slip,
        slip_reason: verdict.reason,
        cost_usd: outcome.cost,
        prompt_chars: turn.prompt.length,
        answer: outcome.text,
      });
      console.log((measured.share === null ? '—' : (measured.share * 100).toFixed(1) + '%')
        + (verdict.slip ? '  ⚠ انزلاق (' + verdict.reason + ')' : '')
        + '  $' + (outcome.cost || 0).toFixed(3));
    }
  }

  console.log('\n──── الخلاصة ────');
  for (const armName of armNames) {
    const rows = results.filter((r) => r.arm === armName && r.ok);
    if (!rows.length) continue;
    console.log('  ' + armName + ': ' + rows.map((r) =>
      r.share === null ? '—' : Math.round(r.share * 100) + '%').join(' → '));
  }
  console.log('الكلفة الإجمالية: ~$' + totalCost.toFixed(4));

  fs.mkdirSync(OUT_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const file = path.join(OUT_DIR, 'drift-' + stamp + '.json');
  fs.writeFileSync(file, JSON.stringify({
    at: stamp,
    kind: 'drift-causal-separation',
    engine: 'sdk',
    model: model || 'default',
    metric_version: METRIC_VERSION,
    declared_limits: 'steer وما بعد /ضغط خارج التجربة (عقدا تطبيق لا يبلغهما claude -p)؛ سلسلة واحدة لكل ذراع',
    total_cost_usd: totalCost,
    results,
  }, null, 2), 'utf8');
  console.log('الخرج الكامل: ' + path.relative(ROOT, file));
}

main();
