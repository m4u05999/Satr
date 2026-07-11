/**
 * سطر Enterprise — سجل الاستهلاك (الدفعة 3.3، نقطة الربط §4.7).
 *
 * يلتقط أحداث `result` من مجرى المراقبة ويدوّن استهلاك الرموز لكل مزوّد وجلسة في
 * `~/.satr/usage/YYYY-MM.jsonl` (سطر JSON لكل دور — صيغة تدقيق قياسية سهلة التحليل).
 * lوحة ⚙ تعرض تجميعات اليوم/الشهر عبر IPC `satr:ee:usage`.
 *
 * أفضل جهد: فشل الكتابة لا يمسّ الدور. محرك SDK يبلّغ total_cost_usd أيضاً فيُدوَّن.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const DIR = path.join(os.homedir(), '.satr', 'usage');

function fileFor(date) {
  const ym = date.toISOString().slice(0, 7); // YYYY-MM
  return path.join(DIR, ym + '.jsonl');
}

// مدوّن الأحداث — يُشترك به في مجرى المراقبة (features.subscribe)
function onEvent(ev, meta) {
  if (!ev || ev.type !== 'result') return;
  try {
    const rec = {
      ts: Date.now(),
      engine: (meta && meta.engine) || 'sdk',
      provider: ev.provider || ((meta && meta.engine) === 'sdk' ? 'claude' : (meta && meta.engine)) || '',
      session: ev.session_id || '',
      is_error: !!ev.is_error,
      duration_ms: ev.duration_ms || 0,
      input_tokens: (ev.usage && ev.usage.input_tokens) || 0,
      output_tokens: (ev.usage && ev.usage.output_tokens) || 0,
      cost_usd: ev.total_cost_usd || 0, // محرك SDK فقط يبلّغها
    };
    fs.mkdirSync(DIR, { recursive: true });
    fs.appendFileSync(fileFor(new Date()), JSON.stringify(rec) + '\n');
  } catch (e) { /* أفضل جهد */ }
}

// تجميعات للوحة ⚙: اليوم والشهر الحالي، لكل مزوّد
function aggregate() {
  const out = { today: {}, month: {}, path: DIR };
  let lines = [];
  try {
    lines = fs.readFileSync(fileFor(new Date()), 'utf8').split('\n').filter(Boolean);
  } catch { return out; } // لا ملف بعد — أصفار
  const dayStart = new Date(); dayStart.setHours(0, 0, 0, 0);
  for (const line of lines) {
    let r;
    try { r = JSON.parse(line); } catch { continue; }
    const key = r.provider || r.engine || '؟';
    const add = (bucket) => {
      if (!bucket[key]) bucket[key] = { turns: 0, input_tokens: 0, output_tokens: 0, cost_usd: 0 };
      bucket[key].turns++;
      bucket[key].input_tokens += r.input_tokens || 0;
      bucket[key].output_tokens += r.output_tokens || 0;
      bucket[key].cost_usd += r.cost_usd || 0;
    };
    add(out.month);
    if (r.ts >= dayStart.getTime()) add(out.today);
  }
  return out;
}

module.exports = { onEvent, aggregate, DIR };
