# خطة حمية الرموز وتوجيه النماذج — مواصفة تنفيذ كاملة لوكيل سطر

> **الحالة:** قرار مالك 2026-09-10 · **المنفّذ:** وكيل Claude Code داخل سطر (أي نموذج من Sonnet فأعلى يكفي —
> الكود مكتوب ومتحقَّق منه؛ عملك دمجه وإثباته على ويندوز) · **المرجع الأعلى عند التعارض:** `AGENTS.md`.
>
> **ما هذه الوثيقة:** ثلاث حزم عمل مرتّبة (‏01 الطقم الصامت والخطّاف → 02 حمية `CLAUDE.md` → 03 سياسة
> توجيه النماذج) كل واحدة بملفاتها الحرفية، وحرّاسها، وأدلة قضمها، ومعايير قبولها، وقالب تقرير PR.
> كل كود هنا **شُغّل فعلاً** في نسخة من `main` عند `f230c98` (‏2.16.21) على لينكس: الطقم الكامل 104 مجموعات
> مرّ في الوضع الصامت (‏292 سطر كونسول مقابل 1,933 في السجل)، والحرّاس الأربعة الجدد عضّوا عند الزرع.
> ما لم يُشغَّل هنا هو **ويندوز** — وهذا عملك.
>
> **القاعدة الذهبية:** تنفّذ كما هو مكتوب؛ وحين يخالف الواقعُ الوثيقةَ (سطر تغيّر، اختبار سقط لسبب لا تفهمه)
> **توقّف وسجّل ولا تخمّن** — راجع قسم «نقاط التوقف».

---

## 0. الخلاصة التنفيذية

**المشكلة المقيسة:** رصيد الأسبوع (‏Claude Max + ChatGPT Pro) ينفد في يومين لأن كل رمز يمرّ عبر أغلى مسارين
(‏Fable 5.1 وGPT‑6 Astra) مع كلفة ثابتة ضخمة في كل دور:

| العلّة | القياس | الحزمة التي تعالجها |
|---|---|---|
| `CLAUDE.md` ‏476 ك.ب / 335 ألف محرف / 4,279 سطراً يُحمَّل كاملاً في كل جلسة Claude Code **وفي محرك SDK داخل سطر** (‏`electron/agent.js` يمرّر `settingSources: ['user','project','local']`) | تحذير Claude Code الرسمي عند 40 ألف محرف، والتوصية ≤ 200 سطر؛ تقدير ~100–120 ألف رمز قبل أول سؤال | **02** |
| الطقم الكامل يبثّ خرجه حرفياً إلى سياق الوكيل ويُعاد إرساله في كل دور تالٍ | 1,933 سطراً/160 ك.ب لكل تشغيل (لينكس؛ على ويندوز أكثر) | **01** |
| Fable مسقوفة عند 50٪ من الحد الأسبوعي وتستهلكه أسرع؛ Astra تستنزف رصيد Codex أسرع من 5.6 | توثيق Anthropic وOpenAI (المراجع في الملحق ج) | **03** |
| من 14 سبتمبر 2026 الحدود الأسبوعية −17٪ عمّا كانت خلال عرض +50٪ | إعلان Anthropic | **03** (إيقاع الأسبوع) |

**المبدأ:** الغالي يقرّر ويراجع، الرخيص ينفّذ، والطقم يحكم.

**النتيجة المتوقعة (بصدق):** الحزمتان 01 و02 تخفضان الكلفة الثابتة لكل دور على جانب Claude إلى النصف تقريباً
(‏`CLAUDE.md` من 476 ك.ب إلى ~17 ك.ب، والطقم من ~2,000 سطر إلى ~300)؛ والحزمة 03 تنقل معظم ما بقي خارج مسارَي
Fable وAstra. الحكم النهائي بالقياس في القسم 7 لا بالتقدير.

---

## 1. قواعد ملزمة للمنفّذ

1. **لا تدفع إلى `main` أبداً.** كل حزمة على فرعها، وPR لكل فرع، والمالك يدمج بالترتيب 01 → 02 → 03.
2. **الفروع متراكبة (stacked):** `diet/01-suite-quiet` من `main` · `diet/02-claude-md-diet` من 01 ·
   `diet/03-model-routing` من 02. (السبب: 02 يسجّل اختباره في `scripts/full-suite.js` بعد تعديل 01، و03 يشير
   إلى خطّاف 01 ويوسّع `.claude/settings.json` الذي أنشأه 01.) الـPRs الثلاثة قاعدتها `main`؛ يظهر في 02 و03
   ما قبلهما حتى يُدمج — اذكر ذلك في وصف الـPR. إن كان لمستودعكم عرف تسمية آخر فاتبعه.
3. **أول التزام في الفرع 01 هو هذه الوثيقة نفسها** في `docs/TOKEN-DIET-PLAN.md` (المالك يضعها هناك؛ إن لم
   تكن فيه فانسخها من حيث أعطاك إياها).
4. **الطقم قبل كل التزام:** `npm run test:full:evidence -- --quiet` (بعد الحزمة 01؛ قبلها `npm run test:full`).
   أخضر أو لا التزام. المتخطّى بحدّ معلَن مقبول؛ الأحمر لا.
5. **عرف العضّة** (‏`AGENTS.md`): لكل حارس جديد — ازرع، عدّ قبل/بعد، أثبت السقوط بنصّه الحرفي، أعِد. **استدلال
   بلا إخراج = عضّة غير مثبتة تُعاد.** أوامر الزرع مكتوبة لك في كل حزمة (‏`node -e` كي تعمل على ويندوز).
6. **لا تلخّص ولا «تحسّن» ما يُنقل.** الحزمة 02 نقل **حرفي** بايتاً ببايت يثبته سكربت؛ النص الوحيد الذي يُؤلَّف هو
   نواة `CLAUDE.md` الجديدة، وهي مكتوبة لك أدناه.
7. **لا تلمس إعدادات جهاز المالك** (‏`~/.codex/config.toml`، `~/.claude/settings.json`) — ما يخصّها يُكتب في
   المستند فقط ويقرّره هو.
8. **الكود بالإنجليزية والتعليقات بالعربية**، وبأسلوب الملف المحيط. لا اعتماديات جديدة (لا حزمة npm واحدة).
9. **اختبر على ويندوز ذهنياً وفعلياً:** مسارات `\`، `cmd`، UTF-8. كل السكربتات هنا Node خالص بلا bash.
10. **نموذجك أثناء التنفيذ:** `sonnet` (أو `opusplan`) بجهد `medium` — هذا العمل T2 بحسب السياسة التي تنفّذها.
    اصعد إلى نموذج أعلى فقط عند «نقطة توقف» لا تُحلّ.
11. **تقرير PR بنمط منفّذينا** (الملحق ب): ما نُفّذ بالملفات والسطور · الخواتم المشغَّلة وخاتمة إخراجها الحرفية ·
    تغيير لزم في ملف لا أملكه (مذكوراً لا منفَّذاً) · المخاطر وما لم أتحقق منه · أدلة العضّة.

### نقاط التوقف (توقّف، سجّل في التقرير، واسأل المالك)

- سطر «ابحث عن» في هذه الوثيقة غير موجود في الملف أو موجود أكثر من مرة.
- حارس قائم سقط بعد تعديلك ولم تفهم السبب خلال محاولتين.
- `_verify-split.js` قال «غير مطابق».
- Claude Code لم يحمّل `.claude/settings.json` أو الخطّاف (‏`/hooks` لا يعرضه) بعد إعادة التشغيل.
- أي شيء يستدعي حزمة npm جديدة أو تغييراً في `electron/`.

---

## 2. خط الأساس — قِس قبل أن تلمس (يُكتب في تقرير الحزمة 01)

نفّذ هذه القياسات على جهاز المالك **قبل أول تعديل** وسجّل أرقامها حرفياً:

1. في جلسة Claude Code داخل مستودع سطر: `/context` — سجّل حجم «Memory files» (‏`CLAUDE.md`) ومجموع السياق عند
   الإقلاع. ثم `/usage` — سجّل الأشرطة (الجلسة/الأسبوع، وشريط Fable/Opus إن ظهر) وأعلام السلوك (سياق طويل، إخفاقات كاش).
2. حجم النواة الحالي:
   `node -e "const s=require('fs').readFileSync('CLAUDE.md','utf8');console.log('chars',s.length,'lines',s.split('\n').length,'bytes',Buffer.byteLength(s))"`
   (المتوقع قبل: ~335,547 محرفاً · 4,279 سطراً · 476,157 بايتاً.)
3. الطقم المفصّل مرة واحدة: `npm run test:full:evidence` — ثم عدّ أسطر السجل:
   `node -e "const fs=require('fs');const d='dist/test-runs/';const r=fs.readdirSync(d).sort().pop();const s=fs.readFileSync(d+r+'/full-suite.log','utf8');console.log(r,'lines',s.split('\n').length,'bytes',Buffer.byteLength(s))"`
   هذا رقم «قبل» للحزمة 01 (على لينكس كان 1,933 سطراً/160 ك.ب).
4. إصدارات: `claude --version` · `codex --version` · `node --version` (لتقرير الحزمة).

---

## 3. الحزمة 01 — الطقم الصامت والخطّاف (`diet/01-suite-quiet`)

**الهدف:** تشغيل الطقم الكامل من داخل الوكيل بلا إغراق السياق: مشغّل الأدلة `scripts/full-suite-evidence.js`
يكتسب وضع `--quiet` (السجل الكامل في الملف كما هو، والكونسول رؤوس المجموعات وأسطر المشغّل والخاتمة وذيل
الساقط فقط)، وخطّاف PreToolUse لـClaude Code يعيد كتابة `npm run test:full` إلى `npm run test:full:evidence -- --quiet`
تلقائياً. **لا تعديل على `scripts/full-suite.js` إلا تسجيل اختبارين في `SUITE`** — المشغّل نفسه يحرسه
`test:suite-coverage` سلوكياً ولا نلمسه.

**الملفات:** `scripts/full-suite-evidence.js` (تعديل) · `scripts/full-suite-quiet-test.js` (جديد) ·
`scripts/hooks/filter-test-output.js` (جديد) · `scripts/filter-test-output-hook-test.js` (جديد) ·
`.claude/settings.json` (جديد) · `package.json` و`scripts/full-suite.js` (تسجيل).

### 3.1 تعديل `scripts/full-suite-evidence.js` — ستّ لمسات

**(أ) بعد** السطرين:

````js
const TAIL_LINE_COUNT = 200;
const INTERRUPT_EXIT_CODE = 130;
````

**أضف** الكتلة التالية كاملة (ثابت + دالة `createQuietPrinter`):


````js
// الوضع الصامت: كم سطراً من خرج المجموعة الساقطة يُطبع على الكونسول (السجل الكامل في الملف).
const QUIET_TAIL_LINES = 40;

/**
 * مرشّح الكونسول للوضع الصامت (‏`--quiet`) — **السجل الكامل يبقى في الملف حرفياً**،
 * والكونسول لا يرى إلا ما يحتاجه القارئ (بشراً كان أم وكيلاً) ليحكم:
 *   - كل ما قبل أول رأس مجموعة (إعلان البدء والمستبعَدين).
 *   - رأس كل مجموعة `[i/N] npm run …` أو `[i/N] ⏭ …`.
 *   - أسطر المشغّل نفسه `full-suite:` (المهلة، الإعادة، الخاتمة).
 *   - كل شيء من جدول «أبطأ ثماني مجموعات» إلى النهاية (الخاتمة مقتضبة أصلاً).
 *   - وبعد انتهاء البث: آخر QUIET_TAIL_LINES سطراً من كل مجموعة ذُكرت في كتلة الفشل.
 * السبب مقيس (2026-09-10، لينكس تحت xvfb، 104 مجموعات): الوضع المفصّل 1,933 سطراً/160 ك.ب على
 * الكونسول مقابل 292 سطراً صامتاً — وكل سطر يدخل سياق الوكيل يُعاد إرساله في كل دور تالٍ،
 * فالوضع المفصّل يُنفق رصيداً على ضجيج لا حكم فيه (وعلى ويندوز تعمل مجموعات أكثر فالفرق أكبر).
 */
function createQuietPrinter(write, tailLimit = QUIET_TAIL_LINES) {
  const HEADER = /^\[(\d+)\/(\d+)\] (?:npm run |⏭ )(\S+)/;
  const SUMMARY_START = /^full-suite: أبطأ ثماني مجموعات/;
  const FAILURE_ROW = /^- (\S+): /;
  const carry = { stdout: '', stderr: '' };
  const tails = new Map();
  let current = null;
  let inSummary = false;
  let inFailures = false;
  const failed = [];

  const remember = (line) => {
    if (!current) return;
    const bucket = tails.get(current);
    if (bucket.length >= tailLimit) bucket.shift();
    bucket.push(line);
  };

  const onLine = (line) => {
    if (inSummary) {
      write(line + '\n');
      if (/^full-suite: فشلت المجموعات التالية:/.test(line)) inFailures = true;
      else if (inFailures) {
        const row = line.match(FAILURE_ROW);
        if (row && tails.has(row[1])) failed.push(row[1]); else inFailures = false;
      }
      return;
    }
    const head = line.match(HEADER);
    if (head) {
      current = head[3];
      if (!tails.has(current)) tails.set(current, []);
      write('\n' + line + '\n');
      return;
    }
    if (SUMMARY_START.test(line)) {
      inSummary = true;
      write('\n' + line + '\n');
      return;
    }
    if (!current || /^full-suite: /.test(line)) {
      write(line + '\n');
      if (current) remember(line);
      return;
    }
    remember(line);
  };

  return {
    feed(chunk, source) {
      const key = source === 'stderr' ? 'stderr' : 'stdout';
      const combined = carry[key] + chunk;
      const parts = combined.split('\n');
      carry[key] = parts.pop();
      for (const part of parts) onLine(part.endsWith('\r') ? part.slice(0, -1) : part);
    },
    finish() {
      for (const key of ['stdout', 'stderr']) {
        if (carry[key] !== '') { onLine(carry[key]); carry[key] = ''; }
      }
      for (const name of failed) {
        const lines = tails.get(name) || [];
        write(`\n── آخر ${lines.length} سطراً من «${name}» (السجل الكامل في ملف الأدلة) ──\n`);
        for (const line of lines) write(line + '\n');
      }
      return { failed: failed.slice(), suites: tails.size };
    },
  };
}
````

**(ب) في أول `run(options = {})`** — ابحث عن:

````js
  const folderName = timestampToFolderName(startedAt);
````

**وأضف بعده مباشرة:**

````js
  // الوضع الصامت: الكونسول مرشَّح والملف كامل. الافتراضي مفصّل كما كان (CI يقرأ الكونسول).
  const quiet = !!options.quiet;
  const consoleWrite = options.consoleWrite || ((text) => process.stdout.write(text));
  const quietPrinter = quiet ? createQuietPrinter(consoleWrite) : null;
````

**(ج) في `headerLines`** — ابحث عن السطر `` `command: npm run test:full`, `` **وأضف بعده:**

````js
      `console_mode: ${quiet ? 'quiet' : 'verbose'}`,
````

**(د) في ردّ نداء `spawnStreaming`** — ابحث عن:

````js
    }, async (chunk, source) => {
      process.stdout.write(chunk);
      enqueueLogWrite(chunk);
      consumeLines(chunk, source);
    });
````

**واستبدله بـ:**

````js
    }, async (chunk, source) => {
      if (quietPrinter) quietPrinter.feed(chunk, source);
      else consoleWrite(chunk);
      enqueueLogWrite(chunk);
      consumeLines(chunk, source);
    });
````

ثم **بعد** السطرين `flushLineCarry('stdout');` و`flushLineCarry('stderr');` أضف:

````js
    if (quietPrinter) quietPrinter.finish();
````

**(هـ) في كائن `summary`** — ابحث عن `reported_suite_total: status === 'passed' ? reportedTotal : null,` **وأضف بعده:**

````js
      console_mode: quiet ? 'quiet' : 'verbose',
````

**(و) في آخر الملف** — استبدل دالة `main` القديمة:

````js
async function main() {
  const result = await run();
  process.exitCode = result.exitCode;
}
````

**بـ:**

````js
/** `--quiet` من سطر الأوامر أو `SATR_SUITE_QUIET=1` من البيئة — أي وسيط آخر يُرفض صراحةً. */
function parseCliOptions(argv = process.argv.slice(2), env = process.env) {
  const options = { quiet: env.SATR_SUITE_QUIET === '1' };
  for (const arg of argv) {
    if (arg === '--quiet') options.quiet = true;
    else throw new Error(`وسيط غير معروف: ${arg} (المسموح: --quiet)`);
  }
  return options;
}

async function main() {
  let options;
  try {
    options = parseCliOptions();
  } catch (error) {
    console.error(`full-suite-evidence: ${error.message}`);
    process.exitCode = 2;
    return;
  }
  const result = await run(options);
  process.exitCode = result.exitCode;
}
````

وفي `module.exports` أضف بعد `createDefaultRunner,`:

````js
  createQuietPrinter,
  parseCliOptions,
  QUIET_TAIL_LINES,
````

تحقّق: `node --check scripts/full-suite-evidence.js` ثم `npm run test:full-evidence` (الاختبار القائم، 26 ✓ — يجب
ألّا يتغيّر لأن الافتراضي مفصّل كما كان).

### 3.2 الاختبار الجديد للوضع الصامت


**`scripts/full-suite-quiet-test.js`** — انسخه كاملاً كما هو:

````js
#!/usr/bin/env node
'use strict';

/**
 * سطر — حارس الوضع الصامت لمشغّل الأدلة (‏`npm run test:full:evidence -- --quiet`).
 *
 * ما يعضّ عليه: (١) الكونسول الصامت يطبع رؤوس المجموعات وأسطر المشغّل والخاتمة، ولا يطبع
 * ضجيج المجموعات الناجحة؛ (٢) المجموعة الساقطة تصل ذيلُها (آخر QUIET_TAIL_LINES سطراً)
 * بعد الخاتمة، لا أولُها؛ (٣) السجل في ملف الأدلة **كامل** حرفياً رغم صمت الكونسول؛
 * (٤) `summary.json` يعلن الوضع (`console_mode`)؛ (٥) الوضع المفصّل الافتراضي لم يتغيّر؛
 * (٦) `parseCliOptions` يقبل `--quiet` و`SATR_SUITE_QUIET=1` ويرفض وسيطاً مجهولاً.
 *
 * قطعي بلا شبكة وبلا npm فعلي: المشغّل الفرعي محقون (runner مزيّف يبثّ نصاً مصطنعاً).
 */

const assert = require('assert');
const fs = require('fs');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');

// المشغّل يشترط npm_execpath (يضبطه npm run)؛ عند التشغيل المباشر بـnode نزوّده قيمة اسمية —
// المشغّل المزيّف أدناه لا ينفّذ الأمر أصلاً.
if (!process.env.npm_execpath) process.env.npm_execpath = 'npm-cli.js';

const evidence = require('./full-suite-evidence');

let checks = 0;
function ok(condition, message) { assert.ok(condition, message); checks += 1; }

/** نص مصطنع بصيغة full-suite.js: مجموعة ناجحة، ومتخطّاة، وساقطة بخمسين سطراً. */
function buildTranscript() {
  const lines = [];
  lines.push('full-suite: بدء 3 مجموعة اختبار قطعية/حية بالتسلسل.');
  lines.push('مستبعدة عمداً (1، بأسباب موثّقة في EXCLUDED_FROM_SUITE): test:full.');
  lines.push('');
  lines.push('[1/3] npm run test:alpha');
  for (let i = 1; i <= 30; i++) lines.push(`alpha noise ${i}`);
  lines.push('');
  lines.push('[2/3] ⏭ test:beta — متخطّاة على linux: سبب معلَن');
  lines.push('');
  lines.push('[3/3] npm run test:gamma');
  for (let i = 1; i <= 50; i++) lines.push(`gamma noise ${i}`);
  lines.push('');
  lines.push('full-suite: أبطأ ثماني مجموعات (ثانية) — أساس معايرة المهل:');
  lines.push('  test:gamma                       1.2');
  lines.push('  test:alpha                       0.4');
  lines.push('');
  lines.push('full-suite: فشلت المجموعات التالية:');
  lines.push('- test:gamma: 1');
  return lines.join('\n') + '\n';
}

function createFakeRunner(transcript, exitCode) {
  return {
    async spawnForOutput() { return { stdout: 'deadbeef', stderr: '', exitCode: 0 }; },
    async spawnStreaming(command, args, options, onData) {
      // يُبثّ على دفعات غير محاذية للأسطر عمداً — المرشّح يجب أن يعيد تجميعها.
      for (let offset = 0; offset < transcript.length; offset += 7) {
        await onData(transcript.slice(offset, offset + 7), 'stdout');
      }
      await onData('full-suite: ⚠ سطر من stderr\n', 'stderr');
      return { exitCode, signal: null, interrupted: false };
    },
  };
}

async function withTemp(fn) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'satr-quiet-'));
  try { return await fn(dir); } finally { await fsp.rm(dir, { recursive: true, force: true }); }
}

async function main() {
  // ── (٦) تحليل الوسائط ──
  assert.deepStrictEqual(evidence.parseCliOptions([], {}), { quiet: false }); checks += 1;
  assert.deepStrictEqual(evidence.parseCliOptions(['--quiet'], {}), { quiet: true }); checks += 1;
  assert.deepStrictEqual(evidence.parseCliOptions([], { SATR_SUITE_QUIET: '1' }), { quiet: true }); checks += 1;
  assert.throws(() => evidence.parseCliOptions(['--loud'], {}), /وسيط غير معروف/); checks += 1;

  // ── (١)(٢) المرشّح وحدة ──
  {
    let out = '';
    const printer = evidence.createQuietPrinter((text) => { out += text; }, 5);
    printer.feed(buildTranscript(), 'stdout');
    const result = printer.finish();
    ok(out.includes('[1/3] npm run test:alpha'), 'رأس المجموعة الناجحة يظهر');
    ok(out.includes('[2/3] ⏭ test:beta'), 'رأس المجموعة المتخطّاة يظهر');
    ok(!out.includes('alpha noise'), 'ضجيج المجموعة الناجحة لا يظهر');
    ok(out.includes('full-suite: فشلت المجموعات التالية:'), 'كتلة الفشل تظهر');
    ok(out.includes('  test:gamma                       1.2'), 'جدول الأبطأ يمرّ كاملاً');
    ok(out.includes('gamma noise 50') && out.includes('gamma noise 47'), 'ذيل الساقطة يظهر');
    ok(!out.includes('gamma noise 46'), 'الذيل مقيَّد بالحدّ (5 أسطر هنا: 47–50 والسطر الفارغ) — لا يُطبع ما قبله');
    ok(out.indexOf('gamma noise 50') > out.indexOf('- test:gamma: 1'), 'الذيل بعد الخاتمة لا قبلها');
    assert.deepStrictEqual(result.failed, ['test:gamma']); checks += 1;
  }

  // ── (٣)(٤) سلوكياً عبر run() ──
  await withTemp(async (temp) => {
    let out = '';
    const transcript = buildTranscript();
    const result = await evidence.run({
      runner: createFakeRunner(transcript, 1),
      env: process.env,
      artifactRoot: temp,
      quiet: true,
      consoleWrite: (text) => { out += text; },
    });
    ok(result.status === 'failed' && result.exitCode === 1, 'حالة الفشل تمرّ كما هي');
    ok(!out.includes('alpha noise 1'), 'الكونسول الصامت بلا ضجيج الناجحة');
    ok(out.includes('gamma noise 50'), 'الكونسول الصامت يحمل ذيل الساقطة');
    ok(out.includes('full-suite: ⚠ سطر من stderr'), 'أسطر المشغّل على stderr تمرّ');
    const log = fs.readFileSync(path.join(result.artifactDir, 'full-suite.log'), 'utf8');
    ok(log.includes('alpha noise 1') && log.includes('gamma noise 1'), 'السجل في الملف كامل');
    ok(log.includes('console_mode: quiet'), 'رأس السجل يعلن الوضع');
    const summary = JSON.parse(fs.readFileSync(path.join(result.artifactDir, 'summary.json'), 'utf8'));
    ok(summary.console_mode === 'quiet', 'summary.json يعلن console_mode=quiet');
  });

  // ── (٥) الوضع المفصّل الافتراضي لم يتغيّر ──
  await withTemp(async (temp) => {
    let out = '';
    const result = await evidence.run({
      runner: createFakeRunner(buildTranscript(), 0),
      env: process.env,
      artifactRoot: temp,
      consoleWrite: (text) => { out += text; },
    });
    ok(out.includes('alpha noise 1') && out.includes('gamma noise 1'), 'المفصّل يبثّ كل شيء');
    const summary = JSON.parse(fs.readFileSync(path.join(result.artifactDir, 'summary.json'), 'utf8'));
    ok(summary.console_mode === 'verbose', 'summary.json يعلن console_mode=verbose');
  });

  console.log(`full-suite-quiet-test: ok — ${checks} فحصاً`);
}

main().catch((error) => {
  console.error('full-suite-quiet-test: FAIL');
  console.error(error && error.stack ? error.stack : error);
  process.exit(1);
});
````

### 3.3 الخطّاف واختباره


**`scripts/hooks/filter-test-output.js`** — انسخه كاملاً كما هو:

````js
#!/usr/bin/env node
'use strict';

/**
 * خطّاف PreToolUse لـClaude Code — «الطقم الكامل يُشغَّل صامتاً من داخل الوكيل».
 *
 * يقرأ حمولة الخطّاف من stdin (JSON فيه `tool_input.command`)، وإن كان الأمر هو الطقم
 * الكامل بصيغته المفصّلة أعاد كتابته إلى مشغّل الأدلة بالوضع الصامت:
 *     npm run test:full            →  npm run test:full:evidence -- --quiet
 *     npm run test:full:evidence   →  npm run test:full:evidence -- --quiet
 * وكل أمر آخر يمرّ كما هو (`{}`) — بما فيه أمر يحمل `--quiet` أصلاً.
 *
 * لماذا خطّاف لا تعليمة في CLAUDE.md: التعليمة سياق قد يُنسى بعد /compact، والخطّاف يُنفَّذ
 * قبل كل أمر Bash/PowerShell مهما قرّر النموذج (قياس 2026-09-10 على لينكس: المفصّل 1,933 سطراً
 * مقابل 292 صامتاً لطقم من 104 مجموعات، وكل سطر يدخل السياق يُعاد إرساله في كل دور تالٍ).
 *
 * العقد: لا يقرّر إذناً (لا permissionDecision) — مربع الإذن يبقى كما هو؛ يخرج بـ0 دائماً
 * ويطبع `{}` عند أي عطب، فلا يعطّل أمراً أبداً (fail-open). بلا اعتماديات، ويعمل بـnode
 * على ويندوز ولينكس (لا bash).
 */

const FULL_SUITE = /^\s*npm\s+run\s+test:full(?::evidence)?\s*$/;
const QUIET_COMMAND = 'npm run test:full:evidence -- --quiet';

/** يعيد الأمر المعدَّل أو null إن لم يكن الأمر من شأن الخطّاف. */
function rewriteCommand(command) {
  if (typeof command !== 'string') return null;
  if (!FULL_SUITE.test(command)) return null;
  return QUIET_COMMAND;
}

/** يبني ردّ الخطّاف من الحمولة الخام (نصّ JSON). أي عطب ⇒ `{}`. */
function respond(rawInput) {
  try {
    const payload = JSON.parse(rawInput);
    const command = payload && payload.tool_input && payload.tool_input.command;
    const updated = rewriteCommand(command);
    if (!updated) return {};
    return {
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        updatedInput: { ...payload.tool_input, command: updated },
      },
    };
  } catch {
    return {};
  }
}

function main() {
  const chunks = [];
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => chunks.push(chunk));
  process.stdin.on('end', () => {
    process.stdout.write(JSON.stringify(respond(chunks.join(''))) + '\n');
  });
  process.stdin.on('error', () => process.stdout.write('{}\n'));
}

if (require.main === module) main();

module.exports = { rewriteCommand, respond, QUIET_COMMAND, FULL_SUITE };
````

**`scripts/filter-test-output-hook-test.js`** — انسخه كاملاً كما هو:

````js
#!/usr/bin/env node
'use strict';

/**
 * سطر — حارس خطّاف الطقم الصامت (‏scripts/hooks/filter-test-output.js).
 *
 * ما يعضّ عليه: (١) `npm run test:full` و`npm run test:full:evidence` يُعاد توجيههما إلى
 * الوضع الصامت مع الإبقاء على بقية حقول tool_input؛ (٢) أمر يحمل `--quiet` أصلاً وأي أمر
 * آخر (git، اختبار مفرد، أمر مركّب) يمرّ بلا تغيير `{}`؛ (٣) لا يُصدر الخطّاف قرار إذن
 * أبداً؛ (٤) حمولة تالفة أو فارغة ⇒ `{}` ورمز خروج 0 (fail-open)؛ (٥) العملية الحقيقية عبر
 * stdin تطابق الدالة النقية — لا اختبار «يقارن الشيء بنفسه».
 */

const assert = require('assert');
const path = require('path');
const { spawnSync } = require('child_process');

const hook = require('./hooks/filter-test-output');
const HOOK_FILE = path.join(__dirname, 'hooks', 'filter-test-output.js');

let checks = 0;
function ok(condition, message) { assert.ok(condition, message); checks += 1; }

// ── (١) إعادة الكتابة ──
assert.strictEqual(hook.rewriteCommand('npm run test:full'), hook.QUIET_COMMAND); checks += 1;
assert.strictEqual(hook.rewriteCommand('  npm run test:full  '), hook.QUIET_COMMAND); checks += 1;
assert.strictEqual(hook.rewriteCommand('npm run test:full:evidence'), hook.QUIET_COMMAND); checks += 1;

// ── (٢) ما يمرّ كما هو ──
for (const command of [
  hook.QUIET_COMMAND,
  'npm run test:full:evidence -- --quiet',
  'npm run test:skills',
  'npm run test:full && echo done',
  'git status',
  'npm run test:full-quiet',
  '',
]) {
  assert.strictEqual(hook.rewriteCommand(command), null, `يجب أن يمرّ كما هو: «${command}»`); checks += 1;
}
assert.strictEqual(hook.rewriteCommand(undefined), null); checks += 1;

// ── (٣) بنية الردّ ──
{
  const reply = hook.respond(JSON.stringify({
    tool_name: 'Bash',
    tool_input: { command: 'npm run test:full', description: 'الطقم', timeout: 600000 },
  }));
  ok(reply.hookSpecificOutput && reply.hookSpecificOutput.hookEventName === 'PreToolUse', 'hookEventName صحيح');
  ok(reply.hookSpecificOutput.updatedInput.command === hook.QUIET_COMMAND, 'الأمر أُعيدت كتابته');
  ok(reply.hookSpecificOutput.updatedInput.description === 'الطقم', 'بقية الحقول محفوظة');
  ok(reply.hookSpecificOutput.updatedInput.timeout === 600000, 'المهلة محفوظة');
  ok(!('permissionDecision' in reply.hookSpecificOutput), 'لا قرار إذن — مربع الإذن كما هو');
}
assert.deepStrictEqual(hook.respond(JSON.stringify({ tool_input: { command: 'git status' } })), {}); checks += 1;

// ── (٤) fail-open ──
assert.deepStrictEqual(hook.respond('{not json'), {}); checks += 1;
assert.deepStrictEqual(hook.respond(''), {}); checks += 1;
assert.deepStrictEqual(hook.respond(JSON.stringify({ tool_input: {} })), {}); checks += 1;

// ── (٥) العملية الحقيقية عبر stdin ──
function runHook(input) {
  const result = spawnSync(process.execPath, [HOOK_FILE], { input, encoding: 'utf8' });
  return { status: result.status, out: result.stdout.trim() };
}
{
  const real = runHook(JSON.stringify({ tool_input: { command: 'npm run test:full' } }));
  ok(real.status === 0, 'رمز الخروج 0 عند إعادة الكتابة');
  assert.deepStrictEqual(JSON.parse(real.out), hook.respond(JSON.stringify({ tool_input: { command: 'npm run test:full' } }))); checks += 1;
}
{
  const real = runHook('garbage');
  ok(real.status === 0 && real.out === '{}', 'حمولة تالفة ⇒ {} ورمز 0');
}
{
  const real = runHook(JSON.stringify({ tool_input: { command: 'npm run test:skills' } }));
  ok(real.status === 0 && real.out === '{}', 'أمر خارج النطاق ⇒ {} ورمز 0');
}

console.log(`filter-test-output-hook-test: ok — ${checks} فحصاً`);
````

### 3.4 تسجيل الخطّاف — `.claude/settings.json` (ملف جديد، يُلتزم)

الملف غير موجود اليوم (‏`.claude/` فيه `agents/` فقط). أنشئه بهذا المحتوى — **الحزمة 03 ستضيف إليه مفاتيح النموذج**:

````json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Bash|PowerShell",
        "hooks": [
          {
            "type": "command",
            "command": "node \"${CLAUDE_PROJECT_DIR}/scripts/hooks/filter-test-output.js\"",
            "timeout": 10
          }
        ]
      }
    ]
  }
}
````

ملاحظات: الصيغة «الصدفية» بعلامتَي اقتباس حول المسار هي الموثّقة لويندوز (‏Claude Code يستبدل
`${CLAUDE_PROJECT_DIR}` بنفسه؛ الصدفة على ويندوز Git Bash إن وُجد وإلا PowerShell). الخطّاف **لا يقرّر إذناً**
(لا `permissionDecision`) فمربع الإذن يبقى كما هو. بعد الحفظ أعد تشغيل جلسة Claude Code وتحقق بـ`/hooks` أن
الخطّاف ظاهر تحت PreToolUse؛ إن سألك Claude Code عن الثقة بإعدادات المشروع فوافق (هذا مستودع المالك).

### 3.5 التسجيل في `package.json` و`SUITE`

في `package.json` بعد السطر `"test:full-evidence": "node scripts/full-suite-evidence-test.js",` أضف:

````json
    "test:full-quiet": "node scripts/full-suite-quiet-test.js",
    "test:filter-hook": "node scripts/filter-test-output-hook-test.js",
````

وفي `scripts/full-suite.js` داخل `SUITE` بعد `'test:full-evidence',` أضف:

````js
  'test:full-quiet',
  'test:filter-hook',
````

ثم `npm run test:suite-coverage` — المتوقع: «ولا يتيم» (كان 309 فحصاً و130 سكربتاً؛ يصير ~310/131 مع كل إضافة).

### 3.6 التحقق والعضّات

**التحقق:**

````text
node --check scripts/full-suite-evidence.js
npm run test:full-evidence          # 26 ✓ كما كان
npm run test:full-quiet             # full-suite-quiet-test: ok — 22 فحصاً
npm run test:filter-hook            # filter-test-output-hook-test: ok — 24 فحصاً
npm run test:suite-coverage         # … ولا يتيم
npm run test:full:evidence -- --quiet   # الطقم كله صامتاً — سجّل عدد أسطر الكونسول مقابل أسطر السجل
````

المتوقع من التشغيل الصامت (لينكس، 104 مجموعات، 4.9 دقيقة): الكونسول 292 سطراً، السجل 1,933 سطراً، وفي نهايته
`full-suite-evidence: تم حفظ الأثر في dist/test-runs/<طابع>` و`summary.json` فيه `"console_mode": "quiet"`.
على ويندوز الأرقام تختلف (مجموعات أكثر) — سجّلها كما هي.

**عضّة الوضع الصامت** (الحارس `test:full-quiet`):

````text
زرع:      node -e "const fs=require('fs');const p='scripts/full-suite-evidence.js';fs.writeFileSync(p,fs.readFileSync(p,'utf8').replace('feed(chunk, source) {','feed(chunk, source) { write(chunk);'))"
قبل/بعد:  node -e "const s=require('fs').readFileSync('scripts/full-suite-evidence.js','utf8');console.log('write(chunk); في feed:', (s.match(/feed\(chunk, source\) \{ write\(chunk\);/g)||[]).length)"   ← 0 → 1
فشل الحارس: AssertionError [ERR_ASSERTION]: ضجيج المجموعة الناجحة لا يظهر
استعادة:   git checkout -- scripts/full-suite-evidence.js
````

**عضّة الخطّاف** (الحارس `test:filter-hook`):

````text
زرع:      node -e "const fs=require('fs');const p='scripts/hooks/filter-test-output.js';fs.writeFileSync(p,fs.readFileSync(p,'utf8').replace('test:full(?::evidence)?','never-matches'))"
قبل/بعد:  node -e "const s=require('fs').readFileSync('scripts/hooks/filter-test-output.js','utf8');console.log('never-matches:',(s.match(/never-matches/g)||[]).length)"   ← 0 → 1
فشل الحارس: AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:  + actual - expected  + null  - 'npm run test:full:evidence -- --quiet'
استعادة:   git checkout -- scripts/hooks/filter-test-output.js
````

**عضّة الخطّاف حيّاً (من داخل Claude Code):** في جلسة جديدة اطلب من النموذج تنفيذ `npm run test:full` وراقب الأمر
الذي نُفّذ فعلاً — يجب أن يظهر `npm run test:full:evidence -- --quiet`. سجّل ما رأيت (هذا الدليل الوحيد على أن
الخطّاف يعمل على ويندوز فعلاً؛ اختبار stdin يثبت المنطق لا التكامل).

### 3.7 معايير القبول

- الاختباران الجديدان مسجَّلان في `SUITE` و`package.json`، و`test:suite-coverage` أخضر.
- `npm run test:full:evidence -- --quiet` يطبع رؤوس المجموعات والخاتمة فقط، و`full-suite.log` كامل، و`summary.json`
  يحمل `console_mode`.
- `npm run test:full:evidence` (بلا وسيط) يتصرّف كما كان تماماً (CI يقرأ الكونسول المفصّل).
- الخطّاف ظاهر في `/hooks` ويعيد الكتابة حيّاً.
- التقرير يحمل: أرقام خط الأساس، أرقام الصامت، العضّتين بنصّهما، ما لم يُتحقق منه.

---

## 4. الحزمة 02 — حمية `CLAUDE.md` (`diet/02-claude-md-diet`)

**الهدف:** نقل قسم «## المعمارية» (الأسطر 12–4156، 66 قسماً، 483,659 بايتاً) **حرفياً** إلى `docs/internals/NN-slug.md`
مع فهرس، وكتابة نواة `CLAUDE.md` جديدة (‏170 سطراً / ~11.5 ألف محرف)، وقواعد `.claude/rules/*.md` مسارية تحيل إلى
ملفات internals عند لمس مسارات نظام فرعي، وحارس حجم، وتحديث اختبارين كانا يقرآن `CLAUDE.md`، وثلاث إحالات في `AGENTS.md`.

**لماذا هكذا لا بـ`@import`:** المستوردات تُحمَّل عند الإطلاق أيضاً (توثيق Claude Code) فلا توفّر شيئاً؛ أما
القواعد المسارية فتُحمَّل حين يقرأ الوكيل ملفاً يطابق `paths:`، والمهارات عند الطلب. لذلك النواة = ما يلزم كل جلسة،
والقواعد = مؤشّرات (بضعة أسطر) إلى التفاصيل، والتفاصيل = ملفات تُقرأ عند الحاجة.

**الملفات:** `CLAUDE.md` (استبدال) · `docs/internals/*.md` + `README.md` (جديد، 67 ملفاً) · `.claude/rules/*.md`
(جديد، 10 ملفات) · `scripts/claude-md-size-test.js` (جديد) · `scripts/sdk-background-test.js` و`scripts/elicitation-test.js`
(إعادة توجيه سطر واحد + دالة مساعدة) · `AGENTS.md` (ثلاث إحالات) · `package.json`/`scripts/full-suite.js` (تسجيل).
وأداتان مؤقّتتان في `scripts/_split-claude-md.js` و`scripts/_verify-split.js` و`scripts/_make-rules.js` — مسار
`scripts/_*.js` **متجاهَل في `.gitignore`** فلا تُلتزم؛ الوثيقة هي مصدرها.

### 4.1 أداة النقل (مؤقّتة) — `scripts/_split-claude-md.js`


**`scripts/_split-claude-md.js`** — انسخه كاملاً كما هو:

````js
#!/usr/bin/env node
'use strict';

/**
 * أداة نقل لمرة واحدة (مسارها `scripts/_*.js` متجاهَل في .gitignore فلا تُلتزم):
 * تنقل قسم «## المعمارية» من CLAUDE.md **حرفياً** إلى `docs/internals/NN-slug.md`،
 * وتكتب فهرس `docs/internals/README.md`، وتحفظ المقطع الأصلي في
 * `dist/claude-md-architecture.orig.md` كي يقارنه `_verify-split.js` بايتاً ببايت.
 *
 * لا تعدّل CLAUDE.md نفسه — كتابة النواة الجديدة خطوة مستقلة يراجعها الإنسان.
 * التشغيل: node scripts/_split-claude-md.js   (من جذر المستودع)
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const SOURCE = path.join(ROOT, 'CLAUDE.md');
const OUT_DIR = path.join(ROOT, 'docs', 'internals');
const ORIG_COPY = path.join(ROOT, 'dist', 'claude-md-architecture.orig.md');
const START = '## المعمارية';
const END = '## قواعد إلزامية';

// الأسماء ثابتة بالترتيب — لا تُشتق آلياً كي تبقى المسارات مقروءة ومستقرة للإحالات.
const SLUGS = [
  'architecture-overview', 'data-flow', 'claude-fork-rewind', 'claude-models-account',
  'claude-connectors', 'claude-sdk-background-tasks', 'claude-sdk-polish', 'session-continuity',
  'adapters-providers', 'codex-steer', 'codex-compact-context', 'codex-connectors-panel',
  'codex-account-usage', 'send-liveness-timeouts', 'kimi-engine-acp', 'keys-vault',
  'testsprite-mcp', 'testsprite-jobs', 'features-community-enterprise', 'phase5-ipcs',
  'sessions-browser', 'skills-panel', 'task-ledger', 'verify-loop-checkpoint',
  'project-memory', 'repo-map', 'research-orchestrator', 'executor-worktree',
  'parallel-executors', 'reviewer-merge', 'integration-verify', 'review-my-changes',
  'decisions-evidence-log', 'ops-room-ui', 'bounded-loop-mode', 'media-generation-core',
  'media-generation-extension', 'audio-durations-ad-music', 'ad-music-quality-round',
  'claude-code-parity-commands', 'subagents', 'msix-store-package', 'auto-update',
  'run-in-terminal-tool', 'background-terminal-jobs', 'bg-term-done-feedback', 'envbrief',
  'generate-media-tool-gallery', 'generation-done-event-skill', 'slash-menu-sync',
  'first-run-gate-icon', 'project-files-panel-reader', 'git-changes-panel', 'chat-export',
  'mixed-direction-chat', 'at-files-image-paste', 'arabic-diff-viewer', 'arabic-terminal',
  'preview-panel', 'design-system', 'quick-ux-batch', 'daily-loop-polish', 'web-components',
  'generations-gallery-panel', 'generation-cards-chat', 'media-players-gallery',
];

const text = fs.readFileSync(SOURCE, 'utf8');
const lines = text.split('\n');
const startIndex = lines.findIndex((line) => line.startsWith(START));
const endIndex = lines.findIndex((line) => line.startsWith(END));
if (startIndex < 0 || endIndex < 0 || endIndex <= startIndex) {
  throw new Error(`لم يُعثر على حدود القسم: start=${startIndex} end=${endIndex}`);
}

const sliceLines = lines.slice(startIndex, endIndex);
const heads = [0];
for (let i = 1; i < sliceLines.length; i++) if (sliceLines[i].startsWith('### ')) heads.push(i);
heads.push(sliceLines.length);
const sectionCount = heads.length - 1;
if (sectionCount !== SLUGS.length) {
  throw new Error(`عدد الأقسام ${sectionCount} لا يطابق جدول الأسماء ${SLUGS.length} — راجع SLUGS قبل النقل`);
}

fs.mkdirSync(OUT_DIR, { recursive: true });
fs.mkdirSync(path.dirname(ORIG_COPY), { recursive: true });
fs.writeFileSync(ORIG_COPY, sliceLines.join('\n'), 'utf8');

const index = [];
for (let n = 0; n < sectionCount; n++) {
  const body = sliceLines.slice(heads[n], heads[n + 1]);
  const title = body[0].replace(/^#{2,3} /, '').trim();
  const file = `${String(n).padStart(2, '0')}-${SLUGS[n]}.md`;
  // المحتوى حرفي بلا تعديل: أول سطر هو العنوان الأصلي بمستواه الأصلي (### أو ##).
  fs.writeFileSync(path.join(OUT_DIR, file), body.join('\n') + (n === sectionCount - 1 ? '' : '\n'), 'utf8');
  const bytes = Buffer.byteLength(body.join('\n'), 'utf8');
  index.push({ n, file, title, bytes, originalLine: startIndex + heads[n] + 1 });
}

const readme = [];
readme.push('# سجلّ المعمارية التفصيلي — docs/internals');
readme.push('');
readme.push('> هذا المجلد هو قسم «المعمارية» الذي كان يعيش داخل `CLAUDE.md` (‏4,145 سطراً، دفعةً دفعة).');
readme.push('> نُقل **حرفياً** في 2026-09 (خطة حمية الرموز — `docs/TOKEN-DIET-PLAN.md`) كي لا يُحمَّل كاملاً في');
readme.push('> كل جلسة. **القاعدة**: قبل تعديل نظام فرعي اقرأ ملفه هنا؛ وأي دفعة جديدة تُوثَّق في ملفها لا في');
readme.push('> `CLAUDE.md`. قواعد `.claude/rules/*.md` تحيل إلى هذه الملفات تلقائياً عند لمس مساراتها.');
readme.push('');
readme.push('| # | الملف | العنوان الأصلي | الحجم |');
readme.push('|---|---|---|---|');
for (const item of index) {
  readme.push(`| ${String(item.n).padStart(2, '0')} | [\`${item.file}\`](${item.file}) | ${item.title.replace(/\|/g, '\\|')} | ${(item.bytes / 1024).toFixed(1)} ك.ب |`);
}
readme.push('');
fs.writeFileSync(path.join(OUT_DIR, 'README.md'), readme.join('\n'), 'utf8');

console.log(`نُقل ${sectionCount} قسماً (الأسطر ${startIndex + 1}–${endIndex} من CLAUDE.md) إلى docs/internals/`);
console.log(`النسخة الأصلية للمقارنة: ${path.relative(ROOT, ORIG_COPY)}`);
console.log('أكبر خمسة:', index.slice().sort((a, b) => b.bytes - a.bytes).slice(0, 5).map((i) => `${i.file} (${(i.bytes / 1024).toFixed(0)}ك.ب)`).join(' · '));
````

شغّلها: `node scripts/_split-claude-md.js` — المتوقع حرفياً:

````text
نُقل 66 قسماً (الأسطر 12–4156 من CLAUDE.md) إلى docs/internals/
النسخة الأصلية للمقارنة: dist/claude-md-architecture.orig.md
أكبر خمسة: 58-preview-panel.md (57ك.ب) · 00-architecture-overview.md (41ك.ب) · 33-ops-room-ui.md (21ك.ب) · 34-bounded-loop-mode.md (20ك.ب) · 14-kimi-engine-acp.md (19ك.ب)
````

إن قالت «عدد الأقسام N لا يطابق جدول الأسماء 66» فقد تغيّر `CLAUDE.md` على `main` بعد كتابة هذه الوثيقة —
**نقطة توقف**: اعرض العناوين (`grep -n "^### " CLAUDE.md`) وأضف اسماً للقسم الجديد في `SLUGS` بموضعه، ثم أعد.

### 4.2 دليل «لا ضياع» — `scripts/_verify-split.js`


**`scripts/_verify-split.js`** — انسخه كاملاً كما هو:

````js
#!/usr/bin/env node
'use strict';

/**
 * دليل «لا ضياع» لخطوة النقل: يعيد تركيب ملفات docs/internals/NN-*.md بترتيبها ويقارنها
 * **بايتاً ببايت** بالمقطع الأصلي الذي حفظه `_split-claude-md.js` في dist/.
 * يُطبع الناتج حرفياً في تقرير الـPR. (مسار `scripts/_*.js` متجاهَل في .gitignore.)
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const DIR = path.join(ROOT, 'docs', 'internals');
const ORIG = path.join(ROOT, 'dist', 'claude-md-architecture.orig.md');

const files = fs.readdirSync(DIR).filter((f) => /^\d{2}-.*\.md$/.test(f)).sort();
const rebuilt = files.map((f) => fs.readFileSync(path.join(DIR, f), 'utf8')).join('');
const original = fs.readFileSync(ORIG, 'utf8');
const sha = (s) => crypto.createHash('sha256').update(s, 'utf8').digest('hex').slice(0, 16);

console.log(`ملفات: ${files.length} · بايتات الأصل: ${Buffer.byteLength(original, 'utf8')} · بايتات المعاد تركيبه: ${Buffer.byteLength(rebuilt, 'utf8')}`);
console.log(`sha256 الأصل: ${sha(original)} · sha256 المعاد تركيبه: ${sha(rebuilt)}`);
if (rebuilt === original) {
  console.log('verify-split: مطابق بايتاً ببايت — لا ضياع.');
} else {
  console.error('verify-split: غير مطابق — لا تُكمل قبل معرفة السبب.');
  process.exit(1);
}
````

شغّلها: `node scripts/_verify-split.js` — المتوقع (يُنسخ حرفياً في التقرير):

````text
ملفات: 66 · بايتات الأصل: 483659 · بايتات المعاد تركيبه: 483659
sha256 الأصل: a272a66564bbf374 · sha256 المعاد تركيبه: a272a66564bbf374
verify-split: مطابق بايتاً ببايت — لا ضياع.
````

### 4.3 نواة `CLAUDE.md` الجديدة — استبدل الملف كاملاً بهذا

هذه هي النواة (‏170 سطراً). ما بين «## قواعد إلزامية» ونهاية الملف هو **الأصل حرفياً** عدا تعديلين مذكورين
تحت الكتلة؛ وما قبله (الرأس + «الخريطة المختصرة» + «أين التفاصيل») هو النص الوحيد المؤلَّف في هذه الخطة —
راجعه مع المالك في الـPR.


````markdown
# سطر (Satr) 2.0 — دليل المشروع لـ Claude Code

## ما هذا المشروع

تطبيق سطح مكتب (Electron) يحل مشكلة عرض اللغة العربية (RTL + تشكيل الحروف) عند استخدام
أدوات الذكاء الاصطناعي في سطر الأوامر — وعلى رأسها Claude Code. الطرفيات التقليدية لا تدعم
BiDi فيظهر العربي مقطّعاً ومعكوساً؛ «سطر» يشغّل هذه الأدوات في الخلفية ويعرض المحادثة
في واجهة HTML تعرض العربية بشكل مثالي.

الرؤية النهائية: البيت العربي لكل أدوات CLI الذكية (Claude Code أولاً، ثم Gemini CLI و Codex عبر محوّلات).

## المعمارية — الخريطة المختصرة (التفاصيل في `docs/internals/`)

- `electron/main.js` — العملية الرئيسية: النافذة، توجيه المحرّكات، معالجات IPC، **كل التنقية**
  (‏`SAFE_SESSION`/`SAFE_MODEL`/`SAFE_ENGINE`). `electron/preload.js` — الجسر الآمن الوحيد (`window.satr`).
- محرّكات أصيلة: `agent.js` (‏Claude Agent SDK: بثّ + `canUseTool` + خطّافا Pre/PostToolUse) ·
  `codex.js` (‏`codex app-server` JSON-RPC، ابنِ على v2) · `kimi.js` (‏ACP) · `claudeauth.js`/`enginesupdate.js`.
- المزوّدات «العمياء»: `electron/adapters/` (عقد `start(input,cwd,emit)→{stop()}`، سجلّ قابل للحقن)،
  ووكيل سطر الخاص: `tools.js` (الأدوات) · `looprunner.js` (الحلقة المحدودة) · `context.js`/`repomap.js`
  (الميزانية وخريطة المستودع — الكتلة المتغيّرة في `turnPrompt` لا في `systemPrompt` كي لا يُكسر الكاش) ·
  `adapters/usage.js` (عدّ الرموز).
- غرفة العمليات: `opsroom.js` · `opsplanner.js` · `opsbrainstorm.js` (العصف الثلاثي) · `orchestrator.js`
  (باحثون للقراءة) · `executor.js`/`executionteam.js`/`worktrees.js` · `reviewer.js` (المحلّف الأعمى) ·
  `merger.js` · `verify.js` · `integration.js` · `opsartifacts.js`.
- الطرفية: `term.js`/`termjobs.js` (‏ConPTY عبر node-pty) + `src/vendor/xterm*` (مُضمّن) +
  `src/ui/components/terminal-panel.js`. المعاينة: `preview.js`/`previewrecording.js` + `preview-panel.js`
  + `src/ui/lib/preview-shield.js`. الأمان: `execguard.js` · `gitsafe.js` · `browserguard.js`/`browserorigin.js`/
  `browserpolicy.js` · `renderertrust.js` · `secretscrub.js` · `hookguard.js` · `autogate.js`.
- اللغة: `langanchor.js` · `langmetric.js` · `langshadow.js` · `langoverride.js` (عقد `docs/LANGUAGE-CONTRACT.md`).
- الجوال: `mobile*.js` · `webpush.js`. التوليد: `genmedia.js` · `promostudio.js`/`promocapture.js`.
- الواجهة: `src/index.html` (وسوم المكوّنات، CSP صارم) · `src/styles/base.css` (‏Design Tokens) ·
  `src/ui/app.js` (القشرة + مجرى `satr:event`) · `src/ui/components/` (‏Web Components بادئة `satr-`) ·
  `src/ui/lib/` (وحدات مشتركة: `text-dir.js`، `usage-summary.js`، …).
- عقد الأحداث الموحّد (`system`/`assistant`/`user`/`stream_text`/`result`/`permission_request`/`file_edit`/
  `proc_done`) في `AGENTS.md` قسم «تدفّق البيانات» — **أي محرك جديد يطبّع خرجه لهذه الأنواع نفسها**.

### أين التفاصيل — اقرأ قبل أن تلمس

سجلّ المعمارية التفصيلي (‏66 قسماً، دفعةً دفعة، بالتاريخ والدروس) في **`docs/internals/`** والفهرس
`docs/internals/README.md`. القاعدة: **قبل تعديل نظام فرعي اقرأ ملفه هناك، ووثّق الدفعة الجديدة فيه لا
هنا.** قواعد `.claude/rules/*.md` المسارية تذكّرك بالملف المعني تلقائياً عند لمس مساراته. هذا الملف
نواة فقط: ما يلزم كل جلسة، ويحرسه `npm run test:claude-md-size` (≤ 40 ألف محرف).

مراجع أخرى: `docs/ARCHITECTURE.md` (فصل Community/Enterprise) · `docs/OBSERVATIONS.md` (الملاحظات) ·
`docs/radar/` (الرادار) · `docs/MODEL-ROUTING.md` (توجيه النماذج والرصد) · `docs/DEFINITION-OF-DONE.md`.

## قواعد إلزامية

1. **الأمان أولاً**: لا تعطّل `contextIsolation` أو `sandbox`، ولا تفعّل `nodeIntegration`.
   كل قدرة جديدة تمر عبر preload.js بدالة محددة — لا تكشف ipcRenderer كاملاً أبداً.
2. **التحقق من المدخلات في main.js**: أي قيمة تدخل في وسائط spawn يجب أن تمر على
   regex تحقق صارم (انظر SAFE_SESSION و SAFE_MODEL الموجودة). البرومبت نفسه آمن لأنه عبر stdin.
3. **العربية أولاً**: كل نص واجهة بالعربية. الأكواد والمسارات والأرقام التقنية دائماً
   `direction: ltr`. أما **اتجاه النص المختلط فيُحسم بحسب الوعاء لا بقاعدة واحدة**
   (‏`OBS-061` — الصياغة السابقة كانت توصي بالعلّة نفسها التي أُصلحت في 2026-07-18):
   - **فقرة أو عنصر قائمة أو عنوان أو خلية جدول أو فقاعة رسالة ⇒ حسم إحصائي صريح**
     عبر `textDir()` من `src/ui/lib/text-dir.js` (المصدر الواحد) ثم ضبط `dir` على
     العنصر. السبب مقيس: `unicode-bidi: plaintext` و`dir="auto"` يحسمان من **أول حرف
     قوي**، فأي فقرة عربية الجوهر تبدأ برمز لاتيني (`SHA-256 …` · `npm run …`) ترسو
     LTR كاملة — وهو نمط التقارير التقنية لا حالة نادرة.
   - **حاوية أو نص قصير بلا رمز لاتيني بادئ ⇒ `dir="auto"` مقبول** ويبقى مستعملاً
     عمداً (`chat.js:742, 796, 967, 1213`). لا تُطارد هذه المواضع.
   - **كتلة متعددة الأسطر (‏`<pre>`/عارض ملف/سجلّ) ⇒ اتجاه واحد للكتلة كلها**؛
     `dir="auto"` لكل سطر جُرّب وأخفق (كل سطر يرسو على حافة مختلفة).
   - ⚠️ **`getComputedStyle(el).direction` لا يكشف هذا العطل** — يعيد `rtl` الموروثة
     بينما الفقرة رست LTR. الدليل الوحيد موضع أول محرف بالبكسل
     (‏`scripts/arabic-rtl-probe.js`)، وأداة `browser_readability` تقيسه لصفحات المعاينة.
4. **الكود بالإنجليزية، التعليقات بالعربية**: أسماء المتغيرات والدوال إنجليزية،
   التعليقات التوضيحية عربية (صاحب المشروع يقرأ بالعربية).
5. **أقل اعتماديات ممكنة**: لا تضف حزمة npm إلا لضرورة واضحة. الواجهة صفر اعتماديات
   وقت التشغيل — حافظ على ذلك. العملية الرئيسية تعتمد `@anthropic-ai/claude-agent-sdk` فقط
   (أساس المرحلة 2).
   **استثناء واعٍ وموثَّق (المرحلة 8 — الطرفية):** `node-pty` اعتمادية **أصلية (native)**
   ثانية في العملية الرئيسية. المبرر: الطرفية المدمجة تستحيل بلا pseudoterminal حقيقي
   (ConPTY) ولا بديل JS خالص له — spawn العادي لا يعطي TTY (لا ألوان ولا تفاعلية)؛ الحزمة
   من مايكروسوفت وتشغّل VS Code نفسه. أما xterm.js وخط IBM Plex Sans Arabic في الواجهة
   فليسا اعتماديتَي تشغيل npm بل **مُضمّنان (vendored)** في `src/vendor/` (المصدر
   devDependency، والنسخ عبر `scripts/vendor-xterm.js` و`scripts/vendor-fonts.js`،
   والناتج مُلتزَم) — فقاعدة الواجهة تبقى قائمة بمعناها.
   لا استثناءات أخرى دون قرار يُوثَّق هنا (القاعدة) وفي `docs/internals/` (التفصيل).
6. **لا تكسر العقد بين الطبقات**: أي تغيير في صيغة أحداث IPC يتطلب تحديث الطرفين معاً
   وتحديث ملف النظام الفرعي المعني في `docs/internals/` (وهذا الملف إن مسّ النواة).
7. **اختبر على ويندوز ذهنياً**: المسارات بـ `\`، الأوامر `.cmd`، الترميز UTF-8 —
   هذه البيئة الأساسية للمستخدمين.
8. **التحقق من النماذج**: قائمة النماذج في الواجهة تمرر القيمة لـ `--model` كما هي.
   عند إضافة نموذج جديد تحقق أولاً أن claude يقبله (مثال: `claude --model claude-fable-5 -p "hi"`).

## سجل الملاحظات المؤجَّلة (قاعدة مالك — 2026-08-13)

**أي ملاحظة تظهر أثناء دفعة جارية تُسجَّل في `docs/OBSERVATIONS.md` ولا تُنفَّذ.**
الغاية مزدوجة: ألّا تضيع الملاحظة، وألّا تنتفخ الدفعة الجارية فيضيع حاجزها.

- **ثلاثة استثناءات تُنفَّذ فوراً** (وإلا صارت القاعدة ذريعة لتأجيل عطل حقيقي):
  تراجع أمني · عطل يكسر الدفعة الجارية نفسها · سطر واحد داخل ملف يُعدَّل أصلاً.
- **القائد وحده يكتب في الملف.** المنفّذون يذكرون ملاحظاتهم في تقاريرهم النهائية
  (بند «تغيير لزم في ملف لا أملكه — مذكوراً لا منفَّذاً») والقائد ينقلها. هذا يمنع
  تعارضات الدمج ويُبقي الملف ضمن ملكية `docs/`.
- **السحب خطوة إلزامية أولى في كل دفعة جديدة**: تُقرأ الملاحظات المفتوحة، وتُرشَّح
  المطابقة لوسم الدفعة، **وتُعرض على المالك ليقرر** أيها يدخل. لا ضمّ تلقائي — وإلا
  عادت الدفعات المنتفخة التي بُنيت هذه القاعدة لمنعها.
- **الإغلاق بمرجع**: المنجزة تحمل رقم التزام، والمرفوضة تحمل سبباً. **لا تُحذف
  ملاحظة أبداً** — تاريخ الرفض يمنع إعادة فتح نقاش محسوم بعد أشهر.
- **مرجع الالتزام يُحلّ فعلاً لا شكلاً**: كان الحارس يقبل أي `[0-9a-f]{7,40}` في
  الكتلة، فمعرّف ملف جلسة يمرّ كأنه مرجع — مقيس على `main` (2026-09-04): من `63`
  منجزة كانت `10` بلا أي hex يطابق التزاماً. صار المرشّح يُحلّ بـ`git cat-file`
  إلى **التزام** في هذا المستودع. وللمرجع الخارجي المشروع **باب تصرّح به الملاحظة
  في نصّها** (لا قائمة أسماء في السكربت) بشكلين: `` `<hex>` في `<مستودع>` `` لالتزام
  في مستودع آخر مسمّى، و`` `sha256:<hex>` `` لبصمة نسخة ليست رقم التزام. **حدّان
  مُصرَّح بهما**: الباب يتحقق من وجود التصريح لا من الكائن الخارجي نفسه؛ والتحقق
  يسقط إلى الشرط الشكلي مع سطر معلن حين تكون النسخة **سطحية** (‏`fetch-depth: 1`
  في CI) أو بلا git — فلا يُصبغ الطقم أحمر لسبب بيئي.
- الوسم من قائمة مغلقة (`mobile · ui · ops-room · engines · preview · generation ·
  security · process · docs · perf`)، والدليل (`ملف:سطر` أو التزام) إلزامي: بلا دليل
  تصير الملاحظة رأياً لا يمكن التحقق منه بعد شهر.

`npm run test:observations` (ضمن `test:full`) يحرس الشكل والأوسمة والأدلة والترقيم
ومراجع الالتزام.
**حدّه مُصرَّح به**: لا يستطيع أن يعرف أن ملاحظةً لوحظت ولم تُسجَّل — يحرس صحة الملف
وعدم تعفّنه لا اكتمال التسجيل. ادّعاء غير ذلك يكون «الحارس الأخضر الكاذب» نفسه.

**ومن أين تأتي بنود هذا السجل**: `docs/radar/` («رادار سطر») يقترح ولا ينفّذ — ما يُقبل
منه يُسجَّل هنا بقرار المالك. و`docs/radar/state.json` يحمل **المقبرة**: ما رُفض بسبب
مكتوب، فتُراجَع قبل اقتراح أي تبعية أو تقنية جديدة (مهارة `satr-radar`)، ويحرسها
`npm run test:radar-graveyard`. القواعد كاملةً في `AGENTS.md` قسم «رادار سطر».

## أوامر التشغيل والبناء

```
npm install        # مرة واحدة
npm start          # تشغيل التطبيق للتطوير
npm run dist       # بناء مثبّت ويندوز NSIS في مجلد dist/
npm run dist:dir   # بناء مجلد بدون مثبّت (أسرع للتجربة)
```

ملاحظات البناء (مهمة):
- **حجم المثبّت**: لا نحزم ثنائي claude (~234م.ب)؛ نوجّه SDK إلى المثبّت عالمياً
  (انظر agent.js). البناء يستثني `claude-agent-sdk-win32-x64` عبر `files`، ومع node-pty
  مقلَّم الـ prebuilds (المرحلة 8) يبلغ المثبّت ~80م.ب.
- **لا إعادة بناء أصلية**: `npmRebuild: false` — انظر «الطرفية العربية المدمجة» أعلاه.
- **المهارة المضمّنة**: `build.files` يضم `.agents/skills/satr-guide/**/*` فقط، ويطابقه
  `asarUnpack` لأن حصر الموارد يعتمد `realpathSync`. في الإنتاج يحوّل `skills.js` جذر
  `app.asar` إلى `app.asar.unpacked`؛ وفي التطوير يقرأ المسار المباشر نفسه.
- **مثبّت عربي بالكامل**: `build/installer.nsh` يفرض `$LANGUAGE=1025` في `preInit` و
  `customUnInit`. **لا تضع `multiLanguageInstaller: false`** — في electron-builder تعني
  تجاهل `installerLanguages` وفرض الإنجليزية (en_US). اترك `installerLanguages: ["ar_SA"]`
  وحدها مع ملف الـ nsh.
- **ذاكرات البناء على D:**: متغيّرات `ELECTRON_BUILDER_CACHE` و `ELECTRON_CACHE` (نطاق User)
  و `npm config cache` كلها على `D:\dev-caches`. عند البناء من هذه الجلسة مرّرها inline.

## مرجع سريع لـ Claude Code CLI

- التوثيق: https://code.claude.com/docs/en/cli-reference و https://code.claude.com/docs/en/headless
- الوضع غير التفاعلي: `claude -p` + `--output-format stream-json` (يتطلب `--verbose`)
- `--include-partial-messages`: يضيف أحداث بث جزئية (حرفاً بحرف) — مخطط للمرحلة 3
- أوضاع الصلاحيات: `default`, `acceptEdits`, `plan`, `bypassPermissions`, `auto` (خارطة
  المنصّات الموجة 4 — محرك SDK فقط): مصنّف Anthropic يوافق القرائية تلقائياً، والأدوات ذات
  الأثر تُجبَر على مربع الإذن العربي عبر `preToolUse:'ask'`. المنطق النقي في `electron/autogate.js`
  (`AUTO_SAFE_TOOLS`/`autoNeedsPrompt`/`decideAutoApproval`/`nonSdkPerm`)، يستهلكه agent.js
  (canUseTool يستدعي `decideAutoApproval` المُختبَرة) وmain.js (`nonSdkPerm` يسقط auto لغير SDK).
  **fail-safe**: whitelist للآمن لا blacklist للخطر (المجهول يُسأل)؛ «موافقة دائمة» سابقة لا
  تعفي أداة غير آمنة في auto؛ `browserControl` استثناء صريح للمتصفح. اختبار `npm run test:autogate`.
- جلسات Claude Code المحفوظة محلياً: `~/.claude/projects/<مسار-مرمّز>/*.jsonl` — تُستخدم في المرحلة 2 (متصفح الجلسات)
- للترقية المستقبلية: Claude Agent SDK (TypeScript) يوفر تحكماً برمجياً كاملاً بما فيه
  اعتراض طلبات الأذونات — هذا أساس المرحلة 3. تحقق من توثيقه الرسمي قبل البدء.

## خطة العمل

اقرأ `docs/PLAN.md` — لا تنفذ أكثر من مرحلة واحدة في الجلسة الواحدة،
وبعد كل مرحلة: شغّل التطبيق، تحقق من معايير القبول المذكورة، ثم قدّم ملخصاً.
````

التعديلان داخل الأصل: القاعدة 5 صارت تنتهي بـ«لا استثناءات أخرى دون قرار يُوثَّق هنا (القاعدة) وفي
`docs/internals/` (التفصيل).»، والقاعدة 6 «…وتحديث ملف النظام الفرعي المعني في `docs/internals/` (وهذا الملف إن
مسّ النواة).» — بدل «وتحديث هذا الملف».

تحقّق بعد الحفظ: `node -e "const s=require('fs').readFileSync('CLAUDE.md','utf8');console.log('chars',s.length,'lines',s.split('\n').length)"`
← المتوقع `chars 11499 lines 170` (±بضعة محارف إن اختلف سطر نهاية الملف).

### 4.4 القواعد المسارية — `scripts/_make-rules.js` (مؤقّتة) تولّد `.claude/rules/*.md`


**`scripts/_make-rules.js`** — انسخه كاملاً كما هو:

````js
#!/usr/bin/env node
'use strict';

/**
 * أداة لمرة واحدة (متجاهَلة في .gitignore): تولّد قواعد `.claude/rules/*.md` المسارية.
 * كل قاعدة **مؤشّرات لا نصوص**: حين يلمس الوكيل ملفاً من مساراتها تُحمَّل القاعدة
 * (بضعة أسطر) فتذكّره بأي ملفات `docs/internals/` يقرأ قبل التعديل — بدل تحميل
 * 480 ك.ب في كل جلسة. الخريطة أدناه ثابتة ومراجَعة يدوياً؛ عدّلها هنا ثم أعد التوليد.
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const INTERNALS = path.join(ROOT, 'docs', 'internals');
const RULES = path.join(ROOT, '.claude', 'rules');

// اسم القاعدة → المسارات التي تُفعّلها → أرقام أقسام internals التي تشير إليها.
const MAP = [
  ['claude-engine', ['electron/agent.js', 'electron/claudeauth.js', 'electron/sessions.js', 'electron/chats.js',
    'electron/sdkrewinds.js', 'electron/elicitation.js', 'electron/envbrief.js', 'electron/agents.js',
    'electron/enginesupdate.js'], [2, 3, 4, 5, 6, 7, 13, 20, 39, 40, 46]],
  ['codex-engine', ['electron/codex.js', 'electron/codexrpc.js', 'electron/codexmcp.js', 'electron/codexsessions.js',
    'src/ui/components/mcp-panel.js'], [9, 10, 11, 12, 13]],
  ['kimi-engine', ['electron/kimi.js', 'electron/kimi-keepalive.js'], [14]],
  ['satr-agent', ['electron/adapters/**', 'electron/tools.js', 'electron/context.js', 'electron/repomap.js',
    'electron/memory.js', 'electron/keys.js', 'electron/features.js', 'electron/skills.js', 'electron/skillwriter.js',
    'src/ui/components/skills-panel.js', 'src/ui/components/memory-panel.js', 'src/ui/components/context-panel.js'],
  [8, 15, 18, 19, 21, 24, 25]],
  ['ops-room', ['electron/opsroom.js', 'electron/opsroomindex.js', 'electron/opsplanner.js', 'electron/opsbrainstorm.js',
    'electron/orchestrator.js', 'electron/executor.js', 'electron/executionteam.js', 'electron/worktrees.js',
    'electron/reviewer.js', 'electron/merger.js', 'electron/verify.js', 'electron/integration.js',
    'electron/opsartifacts.js', 'electron/looprunner.js', 'electron/loopfailure.js', 'electron/checkpoints.js',
    'electron/tasks.js', 'electron/reviewchanges.js', 'src/ui/components/ops-room.js',
    'src/ui/components/execution-panel.js', 'src/ui/components/research-panel.js', 'src/ui/lib/ops-room-state.js'],
  [22, 23, 26, 27, 28, 29, 30, 31, 32, 33, 34]],
  ['terminal', ['electron/term.js', 'electron/termjobs.js', 'electron/bgprocs.js', 'electron/execguard.js',
    'src/ui/components/terminal-panel.js', 'src/vendor/**'], [43, 44, 45, 57]],
  ['preview', ['electron/preview.js', 'electron/previewrecording.js', 'electron/browserguard.js',
    'electron/browserorigin.js', 'electron/browserpolicy.js', 'electron/devservers.js',
    'src/ui/components/preview-panel.js', 'src/ui/lib/preview-shield.js'], [58]],
  ['media', ['electron/genmedia.js', 'electron/promostudio.js', 'electron/promocapture.js',
    'src/ui/components/gallery-panel.js', 'src/ui/components/promo-studio.js', 'src/ui/lib/media-recorder.js',
    'src/ui/lib/promo-renderer.js'], [35, 36, 37, 38, 47, 48, 63, 64, 65]],
  ['ui-shell', ['src/index.html', 'src/styles/**', 'src/ui/app.js', 'src/ui/components/chat.js',
    'src/ui/components/composer.js', 'src/ui/components/topbar.js', 'src/ui/components/gate.js',
    'src/ui/components/files-panel.js', 'src/ui/components/file-viewer.js', 'src/ui/components/git-panel.js',
    'src/ui/components/sessions-panel.js', 'src/ui/components/perm-dialog.js', 'src/ui/components/question-dialog.js',
    'src/ui/lib/text-dir.js', 'src/ui/lib/diff.js', 'src/ui/lib/diff.css.js', 'src/ui/lib/highlight.js',
    'src/ui/lib/sheet.js', 'src/ui/lib/card.css.js', 'src/ui/lib/panel.css.js', 'electron/exporter.js',
    'electron/files.js', 'electron/search.js', 'electron/gitdiff.js', 'electron/gitactions.js', 'electron/diff.js',
    'electron/inject.js'], [1, 20, 49, 50, 51, 52, 53, 54, 55, 56, 59, 60, 61, 62]],
  ['distribution', ['build/**', 'electron/updater.js', 'electron/readiness.js', 'scripts/sync-readme-version.js',
    'scripts/store-shots.js', '.github/workflows/**'], [41, 42, 50]],
];

const files = fs.readdirSync(INTERNALS).filter((f) => /^\d{2}-.*\.md$/.test(f)).sort();
const titleOf = (file) => fs.readFileSync(path.join(INTERNALS, file), 'utf8').split('\n')[0].replace(/^#+ /, '').trim();
const byNumber = new Map(files.map((f) => [Number(f.slice(0, 2)), f]));

fs.mkdirSync(RULES, { recursive: true });
for (const [name, paths, sections] of MAP) {
  const out = [];
  out.push('---');
  out.push('paths:');
  for (const p of paths) out.push(`  - "${p}"`);
  out.push('---');
  out.push('');
  out.push(`# ${name} — اقرأ قبل أن تلمس`);
  out.push('');
  out.push('هذه الملفات لها سجلّ معماري مفصّل (دفعات، قرارات، دروس مقيسة) نُقل من `CLAUDE.md` إلى');
  out.push('`docs/internals/`. **قبل تعديلها اقرأ ما يخصّ تغييرك من القائمة، ووثّق دفعتك الجديدة في الملف المعني:**');
  out.push('');
  for (const n of sections) {
    const file = byNumber.get(n);
    if (!file) throw new Error(`القسم ${n} غير موجود في docs/internals`);
    out.push(`- \`docs/internals/${file}\` — ${titleOf(file)}`);
  }
  out.push('');
  fs.writeFileSync(path.join(RULES, `${name}.md`), out.join('\n'), 'utf8');
  console.log(`كُتبت .claude/rules/${name}.md (${sections.length} إحالة، ${paths.length} مساراً)`);
}
````

شغّلها: `node scripts/_make-rules.js` — تكتب عشر قواعد (‏claude-engine · codex-engine · kimi-engine · satr-agent ·
ops-room · terminal · preview · media · ui-shell · distribution) مجموعها ~15 ك.ب، كل واحدة ترويسة `paths:` وقائمة
إحالات. مثال الناتج `.claude/rules/kimi-engine.md`:


````markdown
---
paths:
  - "electron/kimi.js"
  - "electron/kimi-keepalive.js"
---

# kimi-engine — اقرأ قبل أن تلمس

هذه الملفات لها سجلّ معماري مفصّل (دفعات، قرارات، دروس مقيسة) نُقل من `CLAUDE.md` إلى
`docs/internals/`. **قبل تعديلها اقرأ ما يخصّ تغييرك من القائمة، ووثّق دفعتك الجديدة في الملف المعني:**

- `docs/internals/14-kimi-engine-acp.md` — محرك Kimi Code الأصيل (ACP — 2.10.0)
````

**كيف تعمل:** حين يقرأ Claude Code ملفاً يطابق `paths:` تُحمَّل القاعدة (بضعة أسطر) فتذكّره بأي ملفات
`docs/internals/` يقرأ قبل التعديل. القواعد بلا `paths:` تُحمَّل دائماً — لذلك كلها هنا مسارية.

### 4.5 حارس الحجم — `scripts/claude-md-size-test.js`


**`scripts/claude-md-size-test.js`** — انسخه كاملاً كما هو:

````js
#!/usr/bin/env node
'use strict';

/**
 * سطر — حارس حمية CLAUDE.md: **النواة تبقى نواة**.
 *
 * الدرس (خطة حمية الرموز، 2026-09-10): بلغ CLAUDE.md ‏476 ك.ب (‏4,279 سطراً) لأن كل دفعة
 * كانت تُوثَّق فيه، وهو يُحمَّل كاملاً في **كل** جلسة Claude Code وفي محرك SDK داخل سطر
 * (‏`settingSources` يشمل `project`) — أي ~100 ألف رمز قبل أول سؤال. تحذير Claude Code
 * الرسمي عند 40 ألف محرف، والتوصية ≤ 200 سطر. التفاصيل انتقلت إلى `docs/internals/`.
 *
 * ما يعضّ عليه: (١) حجم CLAUDE.md وعدد أسطره؛ (٢) وجود الإحالة إلى docs/internals؛
 * (٣) فهرس internals يذكر كل ملف NN-*.md وكل ملف مذكور موجود ويبدأ بعنوان؛
 * (٤) قواعد `.claude/rules/*.md` تحمل `paths:` وكل إحالة فيها إلى ملف موجود؛
 * (٥) لا يعود قسم «## المعمارية» المفصّل إلى CLAUDE.md (لا `### ` تحته إلا «أين التفاصيل»).
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const CLAUDE_MD = path.join(ROOT, 'CLAUDE.md');
const INTERNALS = path.join(ROOT, 'docs', 'internals');
const RULES = path.join(ROOT, '.claude', 'rules');

const MAX_CHARS = 40000; // عتبة تحذير Claude Code
const MAX_LINES = 240;   // التوصية 200 مع هامش للنواة العربية الكثيفة

let checks = 0;
function ok(condition, message) { assert.ok(condition, message); checks += 1; }

const text = fs.readFileSync(CLAUDE_MD, 'utf8');
const lines = text.split('\n');
ok(text.length <= MAX_CHARS, `CLAUDE.md ${text.length} محرفاً > الحدّ ${MAX_CHARS} — انقل التفاصيل إلى docs/internals`);
ok(lines.length <= MAX_LINES, `CLAUDE.md ${lines.length} سطراً > الحدّ ${MAX_LINES}`);
ok(/docs\/internals\/README\.md/.test(text), 'CLAUDE.md يحيل إلى docs/internals/README.md');
ok(/test:claude-md-size/.test(text), 'CLAUDE.md يذكر حارسه');
const h3 = lines.filter((l) => l.startsWith('### '));
ok(h3.length <= 1, `عادت أقسام تفصيلية (###) إلى CLAUDE.md: ${h3.length} — مكانها docs/internals`);

// الفهرس والملفات
const files = fs.readdirSync(INTERNALS).filter((f) => /^\d{2}-.*\.md$/.test(f)).sort();
ok(files.length >= 60, `docs/internals فيه ${files.length} ملفاً فقط — هل ضاع النقل؟`);
const readme = fs.readFileSync(path.join(INTERNALS, 'README.md'), 'utf8');
for (const file of files) {
  ok(readme.includes(`(${file})`), `الفهرس لا يذكر ${file}`);
  const first = fs.readFileSync(path.join(INTERNALS, file), 'utf8').split('\n')[0];
  ok(/^#{2,3} /.test(first), `${file} لا يبدأ بعنوان`);
}
for (const match of readme.matchAll(/\]\(([0-9]{2}-[^)]+\.md)\)/g)) {
  ok(fs.existsSync(path.join(INTERNALS, match[1])), `الفهرس يذكر ملفاً غير موجود: ${match[1]}`);
}

// القواعد المسارية
const rules = fs.readdirSync(RULES).filter((f) => f.endsWith('.md'));
ok(rules.length >= 8, `قواعد .claude/rules قليلة: ${rules.length}`);
for (const rule of rules) {
  const body = fs.readFileSync(path.join(RULES, rule), 'utf8');
  ok(/^---\npaths:\n(?:  - ".+"\n)+---\n/.test(body), `${rule} بلا ترويسة paths صالحة`);
  for (const ref of body.matchAll(/`docs\/internals\/([^`]+)`/g)) {
    ok(fs.existsSync(path.join(INTERNALS, ref[1])), `${rule} يحيل إلى ملف غير موجود: ${ref[1]}`);
  }
  ok(body.length < 4000, `${rule} أكبر من مؤشّرات (${body.length} محرفاً) — القواعد إحالات لا نصوص`);
}

console.log(`claude-md-size-test: ok — ${checks} فحصاً؛ CLAUDE.md ${lines.length} سطراً / ${text.length} محرفاً؛ internals ${files.length} ملفاً؛ rules ${rules.length}`);
````

### 4.6 الاختباران اللذان كانا يقرآن `CLAUDE.md`

`scripts/sdk-background-test.js` (السطر ~380: `const docs = read('CLAUDE.md');` ويتحقق من `### مهام Claude SDK الخلفية`)
و`scripts/elicitation-test.js` (السطر ~351، ويتحقق من `elicitation_request`/`satr:elicitationDone`). في **كلٍّ** منهما:

**(أ)** بعد السطر `const ROOT = path.resolve(__dirname, '..');` أضف:

````js

/** القسم المعماري انتقل من CLAUDE.md إلى docs/internals — نقرأ المجلد كله كي لا يعتمد الحارس على اسم ملف. */
function readInternals() {
  const dir = path.join(ROOT, 'docs', 'internals');
  return fs.readdirSync(dir).filter((f) => f.endsWith('.md')).sort().map((f) => fs.readFileSync(path.join(dir, f), 'utf8')).join('\n');
}
````

**(ب)** استبدل `  const docs = read('CLAUDE.md');` بـ `  const docs = readInternals();` (مرة واحدة في كل ملف).

تحقّق: `npm run test:sdk-background` و`npm run test:elicitation` (يحتاجان Electron مثبّتاً — موجود عندكم).

### 4.7 ثلاث إحالات في `AGENTS.md`

1. السطران 3–4 (المقدمة): استبدل

````text
> هذا الملف لوكلاء Codex. النسخة الأشمل (بالتاريخ والدروس المفصّلة) في `CLAUDE.md` —
> ارجع إليه عند الحاجة لتفاصيل ميزة بعينها. هنا **الجوهر الملزِم** كي لا ينحرف التطوير.
````

بـ

````text
> هذا الملف لوكلاء Codex. النسخة الأشمل (بالتاريخ والدروس المفصّلة) في `docs/internals/` —
> الفهرس `docs/internals/README.md`؛ ارجع إليه عند الحاجة لتفاصيل ميزة بعينها. هنا **الجوهر الملزِم**
> كي لا ينحرف التطوير.
````

2. في «المعمارية (خريطة مختصرة)»: `— انظر `CLAUDE.md` لتفاصيل كلٍّ.` → `— انظر `docs/internals/` لتفاصيل كلٍّ.`
3. في «أعراف العمل»: استبدل السطر `- عند الشكّ في تفصيل ميزة، اقرأ قسمها في `CLAUDE.md` قبل التعديل — لا تُعِد اشتقاق ما هو موثّق.` بـ

````text
- عند الشكّ في تفصيل ميزة، اقرأ ملفها في `docs/internals/` (الفهرس في `README.md` هناك) قبل التعديل —
  لا تُعِد اشتقاق ما هو موثّق. والدفعة الجديدة تُوثَّق في ملفها هناك لا في `CLAUDE.md` (نواة ≤ 200 سطر).
````

### 4.8 التسجيل والتحقق والعضّة

`package.json` بعد `"test:filter-hook": …,`:

````json
    "test:claude-md-size": "node scripts/claude-md-size-test.js",
````

و`SUITE` بعد `'test:filter-hook',`:

````js
  'test:claude-md-size',
````

**التحقق:**

````text
node scripts/_verify-split.js                 # مطابق بايتاً ببايت
npm run test:claude-md-size                   # ok — 291 فحصاً؛ CLAUDE.md 170 سطراً / 11499 محرفاً؛ internals 66 ملفاً؛ rules 10
npm run test:sdk-background && npm run test:elicitation
npm run test:suite-coverage && npm run test:observations && npm run test:skills && npm run test:definition-of-done
npm run test:full:evidence -- --quiet         # الطقم كله
````

ثم في جلسة Claude Code **جديدة**: `/context` — سجّل حجم Memory files بعد الحمية (المتوقع: من ~100 ألف رمز إلى
بضعة آلاف)؛ وافتح `electron/kimi.js` بالقراءة واطلب من النموذج أن يخبرك بالقواعد المحمّلة — يجب أن يذكر
`kimi-engine` (أو استعمل خطّاف `InstructionsLoaded` إن أردت دليلاً آلياً).

**العضّة** (الحارس `test:claude-md-size`):

````text
زرع:      node -e "const fs=require('fs');fs.appendFileSync('CLAUDE.md','\n### قسم مزروع\n'+'نص حشو يعيد الانتفاخ. '.repeat(1800))"
قبل/بعد:  node -e "const s=require('fs').readFileSync('CLAUDE.md','utf8');console.log('chars',s.length,'### count',(s.match(/\n### /g)||[]).length)"   ← 11499/1 → 76300/2
فشل الحارس: AssertionError [ERR_ASSERTION]: CLAUDE.md 76300 محرفاً > الحدّ 40000 — انقل التفاصيل إلى docs/internals
استعادة:   git checkout -- CLAUDE.md
````

### 4.9 معايير القبول

- `_verify-split.js` مطابق، والناتج في التقرير حرفياً.
- `CLAUDE.md` ≤ 40 ألف محرف و≤ 240 سطراً ويحيل إلى `docs/internals/README.md`.
- 66 ملفاً + فهرس في `docs/internals/`، و10 قواعد في `.claude/rules/`، وكل الإحالات تشير إلى ملفات موجودة (يحرسها الاختبار).
- الطقم كله أخضر (عدا المتخطّى المعلَن).
- `/context` قبل/بعد في التقرير بالأرقام.
- **نقاش للمالك في الـPR:** هل يريد نقل الخريطة المختصرة إلى شكل آخر أو ضمّ أقسام في internals — لا تقرّر عنه.

---

## 5. الحزمة 03 — سياسة توجيه النماذج (`diet/03-model-routing`)

**الهدف:** تثبيت السياسة كتابةً وإعداداً وحارساً: `docs/MODEL-ROUTING.md` (السياسة كاملة)، قسم «توجيه النماذج» في
`AGENTS.md` (الجوهر الملزِم ليتبعه الوكيل نفسه)، مفاتيح النموذج في `.claude/settings.json`، وحارس `test:model-routing`.

### 5.1 `docs/MODEL-ROUTING.md`


**`docs/MODEL-ROUTING.md`** — انسخه كاملاً كما هو:

````markdown
# توجيه النماذج والرصد — سياسة الكلفة في تطوير «سطر»

> قرار مالك (2026-09-10). **المبدأ: الغالي يقرّر ويراجع، الرخيص ينفّذ، والطقم يحكم.**
> يكمّل `AGENTS.md` (قسم «توجيه النماذج») ولا يُلغيه. الأرقام أدناه مقيسة بتاريخها وتُراجَع
> مع كل تغيير في حدود الخطط؛ ما لا يحمل تاريخ قياس يُعامَل كتقدير.

## 1. لماذا (التشخيص المقيس)

- **رصيد Claude Max**: نماذج Fable تسحب من الحد الأسبوعي نفسه لكن **حتى 50٪ منه فقط** وتستهلكه
  أسرع من بقية النماذج (توثيق Anthropic). التفكير الممتد لا يُطفأ على Fable، والجهد الافتراضي `high`.
  ⇒ تشغيل كل شيء على Fable يستنفد سقفها في يومين ويترك النصف الآخر (‏Sonnet/Opus) بلا استعمال.
- **رصيد Codex (ChatGPT Pro)**: ‏GPT‑6 Astra تشارك الرصيد نفسه وتستهلكه أسرع لكل طلب من 5.6 Sol/Terra؛
  توصية OpenAI: ‏5.6 Luna «للمهام المركّزة أو المتكررة»، و«الجهد الأعلى يستهلك أكثر ولا يعطي نتيجة أفضل دائماً».
- **الكلفة الثابتة لكل دور**: كان `CLAUDE.md` ‏476 ك.ب يُحمَّل كاملاً في كل جلسة Claude Code وفي محرك SDK
  داخل سطر (‏`agent.js` يمرّر `settingSources: ['user','project','local']`)؛ عمر كاش المطالبة ساعة على
  الاشتراك (خمس دقائق على الرصيد الإضافي أو API) — كل عودة بعد ساعة تعيد معالجة السياق كاملاً.
  عُولج في 2026-09 (‏`docs/internals/` + `test:claude-md-size`).
- **ضجيج الأدوات**: الطقم الكامل (‏100+ مجموعة) كان يبثّ خرجه حرفياً إلى سياق الوكيل، ويُعاد إرساله في كل
  دور تالٍ. عُولج بـ`npm run test:full:evidence -- --quiet` وخطّاف `scripts/hooks/filter-test-output.js`.
- **حدود 14 سبتمبر 2026**: انتهى عرض +50٪ على حدود Claude Code الأسبوعية؛ الحدّ الدائم +25٪ عن الأساس،
  أي **−17٪ عمّا كان** خلال العرض.

## 2. الطبقات الأربع

| الطبقة | ما هي | أمثلة المهام | من ينفّذ |
|---|---|---|---|
| **T0 — بلا نموذج** | كل ما يقرّره سكربت | الحرّاس، الطقم، `test:suite-coverage`، `test:radar-graveyard`، `radar:baseline`، فهرسة البحث | سكربتات المستودع |
| **T1 — مجاني/زهيد خارج الاشتراكين** | وكيل سطر الخاص (‏REST) | صياغة OBS من بلاغ، CHANGELOG ورسائل الالتزام، تحديث الأدلة، تحويل أعداد الرادار إلى مرشّحات، فرز السجلات، أسئلة «أين X؟»، هياكل اختبارات من مواصفة، إعادة تسمية/نقل يحكمها الطقم | Groq `openai/gpt-oss-120b` · NIM `nemotron-3-super` · DeepSeek `v4-flash` · Ollama محلياً |
| **T2 — المسار الرخيص داخل الاشتراكات** | التنفيذ الموصوف | تنفيذ OBS له معايير قبول واختبار قضم، بنود الموجات، أوصاف PR، المراجعة الأولى، وثائق مع كود | Claude Code `sonnet` بجهد `medium` · Codex `gpt-5.6-luna`/`sol` بجهد `low`/`medium` · Kimi K3 (رصيد مستقل) |
| **T3 — المسار الغالي** | الحكم والمراجعة | قرارات المفاضلة (العصف الثلاثي)، تغييرات العقود (‏IPC، langanchor)، أعطال ConPTY/BiDi/المصيّر، الأمن وسلسلة التوريد، المراجعة العدائية لفروق T2 قبل الدمج (المحلّف الأعمى)، التصعيد بعد فشلين | Fable 5.1 `high`+ · Opus `xhigh` · Codex `gpt-6-astra` `high`/`xhigh` |

**نمط الشطيرة**: T3 يكتب المواصفة (الملفات، معايير القبول، اختبار القضم، ما لا يُلمس) ← T2 ينفّذ تحت الحارس ←
T3 يراجع **الفرق وحده** ← الطقم يحكم. وهو ما يؤتمته `opusplan` في Claude Code (تخطيط بـOpus، تنفيذ بـSonnet).

## 3. قواعد التصعيد والهبوط (آلية — يطبّقها الوكيل على نفسه)

**اصعد إلى T3** إذا تحقّق واحد: (أ) التغيير يلمس الأمن/‏sandbox/‏CSP/عقد IPC/‏PTY/‏BiDi أو ملفات
`electron/*guard*.js`، `electron/preload.js`، `electron/main.js` (التنقية)؛ (ب) يعبر حدود العمليات
(‏main ⇄ preload ⇄ renderer) أو أكثر من ثلاثة ملفات متباعدة؛ (ج) سقط الحارس نفسه في المحاولة الثانية؛
(د) لا معايير قبول مكتوبة — وعندها يكتب T3 **المواصفة لا الكود**.

**اهبط إلى T2/T1** إذا تحقّق واحد: مواصفة باختبار قضم موجودة · وثائق أو اختبارات فقط · ملف واحد ·
إعادة هيكلة آلية يحكمها الطقم.

**سقف T3**: نحو ثلث الأشرطة الأسبوعية، يُراجَع يومياً بـ`/usage`. إيقاع الأسبوع: قرارات ومواصفات أوله،
تنفيذ وسطه، مراجعات آخره. **لا تشغّل المحرّكات الثلاثة على مهمة روتينية** — العصف الثلاثي للقرارات فقط.

## 4. الإعدادات

**Claude Code** — `.claude/settings.json` (مشترك في المستودع):

```json
{
  "model": "opusplan",
  "effortLevel": "medium",
  "modelSettings": { "claude-fable-5-1": { "effort": "xhigh" } },
  "env": { "CLAUDE_CODE_SUBAGENT_MODEL": "haiku" }
}
```

- `opusplan`: ‏Opus في وضع التخطيط، ثم Sonnet للتنفيذ. للمهمة T3 صراحةً: `/model fable` + `/effort high`،
  أو كلمة `ultrathink` لدور واحد عميق. `/effort auto` يعيد الافتراضي.
- الوكلاء الفرعيون على `haiku` افتراضياً؛ من يحتاج أكثر يعلنه في ترويسته (`model: sonnet` كما في
  `.claude/agents/muraji-amn.md`). `CLAUDE_CODE_SUBAGENT_MODEL_FORCE=sonnet` يفرض على الجميع عند الحاجة.
- الطقم من داخل الوكيل: `npm run test:full:evidence -- --quiet` (الخطّاف يعيد كتابة `npm run test:full` إليه).
- انضباط الجلسة: مهمة واحدة لكل جلسة؛ `/clear` بين المهام (مجاني)؛ `/compact` بتعليمات تركيز فقط حين تلزم
  الاستمرارية (هو نفسه طلب كبير)؛ اعمل في كتل زمنية متصلة (عمر الكاش ساعة).

**Codex** — `~/.codex/config.toml` على جهاز المالك (لا يُلتزم):

```toml
model = "gpt-5.6-luna"
model_reasoning_effort = "low"

[profiles.deep]
model = "gpt-6-astra"
model_reasoning_effort = "high"
```

`codex --profile deep` أو `/model` داخل الواجهة للمهمة T3. داخل سطر يكفي منتقي الشريط: النموذج والجهد
يُرسلان كل دور (‏`electron/codex.js` — `-c model_reasoning_effort`)، والافتراضي `gpt-5.6-sol`.

**داخل سطر**: الافتراضيات تبقى T2 (‏Codex `gpt-5.6-sol`، Kimi `k3`)؛ العصف الثلاثي على Opus بحكم تصميمه
(‏`SATR_OPSROOM_*_MODEL` للتجاوز)؛ وحلقة غرفة العمليات لها ميزانية رموز (‏`looprunner.js`، افتراضي 400k).

## 5. الرصد — الأمر الأول كل يوم

- `/usage` في Claude Code: أشرطة الخطة، **العزو** (مهارات/وكلاء فرعيون/خوادم MCP)، و**أعلام السلوك**
  (سياق طويل، إخفاقات الكاش ≥ 10٪) — `d`/`w` لليوم/الأسبوع. و`/context` لما يشغل السياق (ملفات الذاكرة، الأدوات).
- `/status` في Codex لحدود الخمس ساعات والأسبوع.
- داخل سطر: `electron/adapters/usage.js` يسجّل input/output/cached/reasoning لكل طلب في مسار REST.
- المؤشّر الذي نحكم به: **هل يدوم شريط Fable/Astra الأسبوع كله على القرارات والمراجعات؟** لا «كم أنفقنا».

## 6. صمّامات الفائض

- مفاتيح API فائضٌ لا بديل: مسار REST في سطر يدعم OpenAI Responses (‏Astra 10$/50$ للمليون، والإدخال
  المخزّن 1$) وDeepSeek وQwen وKimi وMiniMax وGemini وNIM وGroq. لا محوّل Anthropic API فيه بعد.
- الرصيد الإضافي على Max (‏`/usage-credits`) بسقف شهري — مع ملاحظة أن عمر الكاش يهبط إلى خمس دقائق عند
  السحب منه ما لم يُختَر TTL يدوياً.
- قرار الاشتراك الثاني يُتّخذ بعد أسبوع قياس لا قبله.

## 7. ما يبقى مفتوحاً (OBS مقترحة)

- «الموجّه» داخل سطر: مسار لكل جلسة (اقتصادي/قياسي/عميق) يترجَم إلى محرك + نموذج + جهد.
- عدّاد ميزانية أسبوعية لكل محرك يقرأ `usage` من حدث `result` وحدود Codex و`usage.js`.
- إكمال خط «مواصفة ← تنفيذ رخيص ← محلّف» فوق `reviewer.js` و`opsbrainstorm.js`.
- `usage.js` يسجّل قراءة الكاش لا إنشاءه (‏`cache_creation*`) — فجوة قياس صغيرة.
````

### 5.2 قسم «توجيه النماذج» في `AGENTS.md`

أدرجه **قبل** قسم `## رادار سطر` مباشرة:


````markdown
## توجيه النماذج — الغالي يقرّر ويراجع، الرخيص ينفّذ، الطقم يحكم

السياسة كاملةً في `docs/MODEL-ROUTING.md` (قرار مالك 2026-09-10). الجوهر الملزِم:

- **الافتراضي T2**: ‏Claude Code على `opusplan` (تخطيط بـOpus، تنفيذ بـSonnet) وجهد `medium`؛ Codex على
  `gpt-5.6-luna`/`sol` بجهد `low`/`medium`. النموذج الغالي (‏Fable/Opus `xhigh`/Astra) **بسبب مكتوب** في
  المهمة: قرار مفاضلة، عقد (‏IPC/langanchor)، أمن، ConPTY/BiDi/مصيّر، مراجعة عدائية قبل الدمج، أو فشلان متتاليان.
- **الشطيرة**: الغالي يكتب المواصفة (ملفات، معايير قبول، اختبار قضم، ما لا يُلمس) ← الرخيص ينفّذ تحت
  الحارس ← الغالي يراجع الفرق وحده ← الطقم يحكم. لا محرّكات ثلاثة على مهمة روتينية.
- **الطقم من داخل الوكيل صامتاً**: `npm run test:full:evidence -- --quiet` (السجل الكامل في
  `dist/test-runs/`، والكونسول رؤوس وخاتمة وذيل الساقط فقط). خطّاف `.claude/settings.json` يعيد كتابة
  `npm run test:full` إليه تلقائياً؛ لا تعطّله.
- **النواة لا تنتفخ**: `CLAUDE.md` ≤ 200 سطر يحرسه `test:claude-md-size`؛ التفاصيل والدفعات الجديدة في
  `docs/internals/` وقواعد `.claude/rules/` تحيل إليها عند لمس مساراتها.
- **الرصد قبل الرأي**: `/usage` و`/context` أول كل يوم؛ الحكم «هل يدوم شريط Fable/Astra الأسبوع كله على
  القرارات والمراجعات؟».
````

### 5.3 `.claude/settings.json` — الشكل النهائي (مفاتيح النموذج + خطّاف الحزمة 01)


````json
{
  "model": "opusplan",
  "effortLevel": "medium",
  "modelSettings": {
    "claude-fable-5-1": {
      "effort": "xhigh"
    }
  },
  "env": {
    "CLAUDE_CODE_SUBAGENT_MODEL": "haiku"
  },
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Bash|PowerShell",
        "hooks": [
          {
            "type": "command",
            "command": "node \"${CLAUDE_PROJECT_DIR}/scripts/hooks/filter-test-output.js\"",
            "timeout": 10
          }
        ]
      }
    ]
  }
}
````

- `opusplan`: تخطيط بـOpus ثم تنفيذ بـSonnet. `effortLevel: medium` هو الافتراضي «الحساس للكلفة» في التوثيق.
- `modelSettings["claude-fable-5-1"].effort = xhigh`: حين يُختار Fable صراحةً لمهمة T3 يعمل بعمق (لا يُطفأ تفكيرها أصلاً).
- `CLAUDE_CODE_SUBAGENT_MODEL=haiku`: الوكلاء الفرعيون رخيصون افتراضياً؛ من يحتاج أكثر يعلنه في ترويسته
  (‏`muraji-amn` على `sonnet` بالفعل).
- الإعدادات في الملف **المشترك** بقرار المالك (المشروع هو ووكلاؤه)؛ يمكنه تجاوزها في `.claude/settings.local.json`.

### 5.4 الحارس — `scripts/model-routing-test.js`


**`scripts/model-routing-test.js`** — انسخه كاملاً كما هو:

````js
#!/usr/bin/env node
'use strict';

/**
 * سطر — حارس سياسة توجيه النماذج (‏docs/MODEL-ROUTING.md + .claude/settings.json + AGENTS.md).
 *
 * ما يعضّ عليه: (١) `.claude/settings.json` JSON صالح، الافتراضي رخيص (‏`opusplan`/`sonnet`/`haiku`)
 * والجهد الافتراضي ليس أعلى من `medium`، والوكلاء الفرعيون على نموذج رخيص؛ (٢) خطّاف PreToolUse مسجَّل
 * ويشير إلى ملف موجود؛ (٣) `docs/MODEL-ROUTING.md` يحمل الطبقات الأربع وقواعد التصعيد؛ (٤) AGENTS.md
 * فيه قسم «توجيه النماذج» يحيل إلى المستند؛ (٥) وكلاء `.claude/agents/*.md` يعلنون نموذجاً صراحةً
 * (لا وراثة صامتة للغالي).
 *
 * الحدّ المُصرَّح به: يحرس الإعدادات المكتوبة لا السلوك الفعلي للوكيل — من يختار `/model fable` لمهمة
 * روتينية لا يمسكه هذا الحارس؛ يمسكه `/usage`.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const CHEAP_DEFAULTS = new Set(['opusplan', 'sonnet', 'haiku', 'default']);
const CHEAP_SUBAGENTS = new Set(['haiku', 'sonnet']);
const EFFORT_ORDER = ['low', 'medium', 'high', 'xhigh', 'max'];

let checks = 0;
function ok(condition, message) { assert.ok(condition, message); checks += 1; }

// ── (١)(٢) الإعدادات ──
const settings = JSON.parse(read('.claude/settings.json'));
ok(CHEAP_DEFAULTS.has(settings.model), `الافتراضي «${settings.model}» ليس من المسار الرخيص (${[...CHEAP_DEFAULTS].join('/')})`);
ok(EFFORT_ORDER.indexOf(settings.effortLevel) <= EFFORT_ORDER.indexOf('medium'),
  `الجهد الافتراضي «${settings.effortLevel}» أعلى من medium — الغالي بسبب مكتوب لا افتراضاً`);
ok(settings.env && CHEAP_SUBAGENTS.has(settings.env.CLAUDE_CODE_SUBAGENT_MODEL),
  'CLAUDE_CODE_SUBAGENT_MODEL يجب أن يكون haiku أو sonnet');
ok(settings.modelSettings && settings.modelSettings['claude-fable-5-1'], 'Fable له إعداد جهد صريح في modelSettings');
const pre = settings.hooks && settings.hooks.PreToolUse;
ok(Array.isArray(pre) && pre.length >= 1, 'خطّاف PreToolUse مسجَّل');
const hookCommands = [];
for (const entry of pre || []) for (const h of entry.hooks || []) hookCommands.push(String(h.command));
const filterHook = hookCommands.find((c) => c.includes('scripts/hooks/filter-test-output.js'));
ok(!!filterHook, 'خطّاف filter-test-output.js مسجَّل في PreToolUse');
ok(fs.existsSync(path.join(ROOT, 'scripts', 'hooks', 'filter-test-output.js')), 'ملف الخطّاف موجود');
ok(/^node /.test(filterHook || ''), 'الخطّاف يُشغَّل بـnode (لا bash — ويندوز أولاً)');
ok((pre || []).every((entry) => /Bash/.test(String(entry.matcher))), 'matcher الخطّاف يشمل Bash');

// ── (٣) المستند ──
const doc = read('docs/MODEL-ROUTING.md');
for (const tier of ['T0', 'T1', 'T2', 'T3']) ok(new RegExp(`\\*\\*${tier} `).test(doc), `المستند يعرّف الطبقة ${tier}`);
ok(/اصعد إلى T3/.test(doc) && /اهبط إلى T2\/T1/.test(doc), 'قواعد التصعيد والهبوط موجودة');
ok(/opusplan/.test(doc) && /gpt-5\.6-luna/.test(doc), 'الإعدادات المرجعية مذكورة (opusplan، luna)');
ok(/test:full:evidence -- --quiet/.test(doc), 'المستند يوجّه إلى الطقم الصامت');

// ── (٤) AGENTS.md ──
const agents = read('AGENTS.md');
ok(/^## توجيه النماذج/m.test(agents), 'AGENTS.md فيه قسم «توجيه النماذج»');
ok(/docs\/MODEL-ROUTING\.md/.test(agents), 'AGENTS.md يحيل إلى docs/MODEL-ROUTING.md');

// ── (٥) الوكلاء الفرعيون يعلنون نموذجهم ──
const agentsDir = path.join(ROOT, '.claude', 'agents');
for (const file of fs.readdirSync(agentsDir).filter((f) => f.endsWith('.md'))) {
  const head = read(path.join('.claude', 'agents', file)).split('\n').slice(0, 12).join('\n');
  ok(/^model: \S+/m.test(head), `.claude/agents/${file} بلا سطر model: صريح`);
}

console.log(`model-routing-test: ok — ${checks} فحصاً (الافتراضي ${settings.model}/${settings.effortLevel}، الفرعيون ${settings.env.CLAUDE_CODE_SUBAGENT_MODEL})`);
````

### 5.5 التسجيل والتحقق والعضّة

`package.json` بعد `"test:claude-md-size": …,`:

````json
    "test:model-routing": "node scripts/model-routing-test.js",
````

و`SUITE` بعد `'test:claude-md-size',`:

````js
  'test:model-routing',
````

**التحقق:**

````text
npm run test:model-routing        # ok — 19 فحصاً (الافتراضي opusplan/medium، الفرعيون haiku)
npm run test:suite-coverage
npm run test:full:evidence -- --quiet
````

ثم جلسة Claude Code جديدة: `/model` يجب أن يعرض `opusplan` افتراضاً، و`/effort` يعرض `medium`.

**العضّة** (الحارس `test:model-routing`):

````text
زرع:      node -e "const fs=require('fs');const p='.claude/settings.json';const d=JSON.parse(fs.readFileSync(p,'utf8'));d.model='fable';fs.writeFileSync(p,JSON.stringify(d,null,2)+'\n')"
قبل/بعد:  node -e "console.log(JSON.parse(require('fs').readFileSync('.claude/settings.json','utf8')).model)"   ← opusplan → fable
فشل الحارس: AssertionError [ERR_ASSERTION]: الافتراضي «fable» ليس من المسار الرخيص (opusplan/sonnet/haiku/default)
استعادة:   git checkout -- .claude/settings.json
````

### 5.6 ما يخصّ جهاز المالك (لا يُلتزم — يُذكر في التقرير تحت «تغيير لزم في ملف لا أملكه»)

`~/.codex/config.toml`:

````toml
model = "gpt-5.6-luna"
model_reasoning_effort = "low"

[profiles.deep]
model = "gpt-6-astra"
model_reasoning_effort = "high"
````

`codex --profile deep` أو `/model` داخل الواجهة للمهمة T3. داخل سطر يكفي منتقي الشريط (النموذج والجهد يُرسلان كل
دور)، والافتراضي `gpt-5.6-sol`.

### 5.7 معايير القبول

- المستند والقسم والإعدادات والحارس موجودة ومسجَّلة، والطقم أخضر.
- `/model` و`/effort` في جلسة جديدة يعكسان الإعدادات.
- التقرير يذكر مقطع Codex كتغيير خارج الملكية.

---

## 6. ترتيب التنفيذ الكامل (قائمة تدقيق)

````text
[ ] 2   خط الأساس: /context · /usage · حجم CLAUDE.md · تشغيل مفصّل واحد وعدّ أسطره · الإصدارات
[ ] 3   git switch -c diet/01-suite-quiet main → التزام 1: docs/TOKEN-DIET-PLAN.md
[ ] 3.1–3.5 تعديل المشغّل + الاختباران + الخطّاف + settings.json + التسجيل
[ ] 3.6 التحقق + العضّتان + الخطّاف حيّاً · npm run test:full:evidence -- --quiet
[ ] 3.7 التزام + دفع + PR (الملحق ب)
[ ] 4   git switch -c diet/02-claude-md-diet diet/01-suite-quiet
[ ] 4.1 _split → 4.2 _verify → 4.3 النواة → 4.4 _make-rules → 4.5 الحارس → 4.6 الاختباران → 4.7 AGENTS.md → 4.8 التسجيل
[ ] 4.8 التحقق + /context بعد + العضّة · الطقم صامتاً
[ ] 4.9 التزام + دفع + PR (اذكر أنه مبني فوق 01)
[ ] 5   git switch -c diet/03-model-routing diet/02-claude-md-diet
[ ] 5.1–5.5 المستند + القسم + settings.json + الحارس + التسجيل + العضّة · الطقم صامتاً
[ ] 5.7 التزام + دفع + PR (مبني فوق 02) · اذكر مقطع Codex للمالك
[ ] 7   جدول القياس النهائي في تعليق على PR 03
````

المدة التقديرية على `sonnet`: ‏01 ساعة · 02 ساعة ونصف (أغلبها تشغيل الطقم) · 03 ثلاثة أرباع ساعة.

---

## 7. القياس بعد التنفيذ — الجدول الذي يُملأ

| المؤشّر | قبل | بعد | كيف يُقاس |
|---|---|---|---|
| حجم `CLAUDE.md` (محارف/أسطر) | 335,547 / 4,279 | (متوقع 11,499 / 170) | `node -e` القسم 2 |
| Memory files في `/context` عند الإقلاع | | | جلسة جديدة |
| أسطر كونسول الطقم الكامل | | | مفصّل مقابل `--quiet` |
| أعلام السلوك في `/usage` (سياق طويل، إخفاقات كاش) | | | بعد أسبوع من العمل |
| هل دام شريط Fable/Astra الأسبوع كله؟ | لا (يومان) | | `/usage` نهاية الأسبوع + `/status` في Codex |

**قاعدة الحكم:** الأسبوع الأول بعد الدمج يُعمل فيه بالإعدادات الجديدة بلا استثناء، ثم يُقارن. إن لم يدُم شريط
Fable/Astra الأسبوع فالخطوة التالية ليست «نموذج أرخص» بل قراءة **العزو** في `/usage`: أي مهارة/وكيل فرعي/خادم MCP
يأكل الرصيد.

---

## 8. ما لا يُنفَّذ الآن — يُسجَّل OBS بقرار المالك

- «الموجّه» داخل سطر: مسار لكل جلسة (اقتصادي/قياسي/عميق) ← محرك + نموذج + جهد. (محور F11 «تخفيض استهلاك الرموز».)
- عدّاد ميزانية أسبوعية لكل محرك في الشريط يقرأ `usage` من حدث `result` وحدود Codex و`adapters/usage.js`.
- إكمال خط «مواصفة ← تنفيذ رخيص ← محلّف» فوق `reviewer.js` و`opsbrainstorm.js`.
- `adapters/usage.js` يسجّل قراءة الكاش لا إنشاءه (`cache_creation*`).
- `zg` (zvec-grep) طبقةَ استرجاع لأسئلة «أين X؟» — بشرط قياس العربية أولاً (بند الرادار القائم).
- محوّل Anthropic API في مسار REST (اليوم Claude عبر SDK/CLI فقط) — صمّام فائض مستقبلي.

---

## الملحق أ — برومبت الانطلاق (يلصقه المالك في Claude Code داخل سطر)

````text
اقرأ docs/TOKEN-DIET-PLAN.md كاملاً قبل أي فعل. هذه مواصفة تنفيذ من ثلاث حزم مرتّبة (01 → 02 → 03) بكود
متحقَّق منه على لينكس؛ عملك تنفيذها على ويندوز بالترتيب، بحرفيّة الوثيقة، وبإثبات كل حارس بعرف العضّة كما في
AGENTS.md. القواعد: لا تدفع إلى main أبداً؛ فرع لكل حزمة (diet/01-suite-quiet من main، ثم 02 من 01، ثم 03 من 02)
وPR لكل فرع بقاعدة main بتقرير بنمط منفّذينا (الملحق ب في الوثيقة)؛ الطقم قبل كل التزام؛ لا تلخّص ما يُنقل؛
لا تلمس إعدادات جهازي؛ لا حزم npm جديدة. اعمل على sonnet أو opusplan بجهد medium. ابدأ بقسم «خط الأساس»
(القسم 2) وسجّل أرقامه قبل أول تعديل. عند أي «نقطة توقف» مذكورة في القسم 1 توقّف واكتب ما رأيت ولا تخمّن.
حين تنتهي الحزم الثلاث اكتب تعليقاً على PR 03 بجدول القياس (القسم 7) وقائمة OBS المقترحة (القسم 8) — الاقتراح لي والقرار لي.
````

## الملحق ب — قالب تقرير الـPR (يُلصق في وصف كل PR)

````markdown
## ما نُفّذ (بالملفات والسطور)
- `scripts/full-suite-evidence.js`: … (الأسطر …)
- …

## الخواتم المشغَّلة وخاتمة إخراجها الحرفية
- `npm run test:full-quiet` → `full-suite-quiet-test: ok — 22 فحصاً`
- `npm run test:full:evidence -- --quiet` → `full-suite: نجحت المجموعات كلها — N/N (وK متخطّاة بحدّ معلَن)` · الكونسول X سطراً / السجل Y سطراً
- …

## أدلة العضّة (لكل حارس جديد)
زرع: …
قبل/بعد: …
فشل الحارس: …
استعادة: …

## تغيير لزم في ملف لا أملكه (مذكوراً لا منفَّذاً)
- …

## المخاطر وما لم أتحقق منه
- …

## قياسات (خط الأساس ↔ بعد)
- /context: … ↔ …
- …
````

## الملحق ج — المراجع التي بُنيت عليها الأرقام

- Claude Code — Model configuration: https://code.claude.com/docs/en/model-config
- Claude Code — Manage costs effectively (‏`/usage`، الكاش، الوكلاء الفرعيون، الخطّاف المرشِّح): https://code.claude.com/docs/en/costs
- Claude Code — Hooks reference (‏PreToolUse، `updatedInput`، ويندوز): https://code.claude.com/docs/en/hooks
- Claude Code — Memory وقواعد `.claude/rules/` المسارية: https://code.claude.com/docs/en/memory
- Claude Code — Settings files and precedence: https://code.claude.com/docs/en/settings
- Claude Help Center — Claude Fable models on your plan (قاعدة 50٪): https://support.claude.com/en/articles/15424964-claude-fable-models-on-your-plan
- تغيير الحدود الأسبوعية 14 سبتمبر 2026 (‏−17٪ عن العرض): https://www.bleepingcomputer.com/news/artificial-intelligence/anthropic-is-cutting-claude-codes-current-weekly-limits-by-17-percent/
- OpenAI Help Center — Managing usage with GPT‑6 Astra in Work and Codex: https://help.openai.com/en/articles/20001516-managing-usage-with-gpt-6-astra-in-work-and-codex
- GPT‑6 Astra في Codex CLI (المعرّفات والجهد والأسعار): https://codex.danielvaughan.com/2026/09/03/gpt-6-astra-codex-cli-configuration-context-notes-safety/

