/**
 * حارس أعطال إيصال الأوامر إلى الطرفية — مرصودة حيّاً في جولة تباعد (2026-08-28).
 *
 * ① **العلّة الجذرية**: `sanitizeCommand` يحذف `\n` بلا بديل، فأمرٌ متعدد الأسطر تلتصق
 *    جُمله فتصير **جملة غير مكتملة** — وهي المعنى الوحيد لمِحَثّ `>>` الذي عَلِقت عنده
 *    المهمة «حيّةً بلا عمل». والطول **لم يكن العلّة**: سُبر أمرٌ 7986 محرفاً (67 سطراً
 *    ملتفاً) فوصل سليماً بالكتابة الخام — فتفسير «تجاوز الطول» كان تفسير الوكيل لنفسه.
 * ② **النقل**: مسار المهام صار يمرّر السكربت في **وسائط spawn** (`-EncodedCommand`)
 *    فلا يمرّ بمحرِّر السطر إطلاقاً، وأي خطأ تحليل يصير خروجاً فورياً بدل علقٍ صامت.
 * ③ `readBuffer` كان يقصّ **بايتات خاماً**: يشطر محرفاً عربياً، ويقطع السطر الأول بلا
 *    علامة فيبدو كاملاً — وخرج JSON طويل يفقد غلافه فيستحيل التحقق منه.
 *
 * قطعي بلا شبكة. يشغّل pty حقيقياً لأن العطل في طبقة الإقلاع والكتابة نفسها.
 */

'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'satr-longline-'));
process.env.SATR_DEVSERVER_FILE = path.join(temp, 'devservers.json');

const term = require(path.join(ROOT, 'electron', 'term.js'));
const termjobs = require(path.join(ROOT, 'electron', 'termjobs.js'));

let checks = 0;
function ok(label, cond, detail) {
  checks++;
  if (cond) { console.log('  ✓ ' + label); return; }
  console.error('  ✗ ' + label + (detail ? ' — ' + detail : ''));
  throw new assert.AssertionError({ message: label + (detail ? ' — ' + detail : '') });
}

process.on('uncaughtException', (error) => {
  console.error('term-longline: FAIL:', (error && error.stack) || error);
  process.exit(1);
});
const guard = setTimeout(() => {
  console.error('term-longline: FAIL — تجاوز المهلة');
  process.exit(1);
}, 180000);
guard.unref();

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const events = [];
termjobs.setNotifier((event) => events.push(event));
const doneOf = (id) => events.find((e) => e.type === 'bg_term_done' && e.id === id);

async function waitFor(fn, label, timeout = 25000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = fn();
    if (value) return value;
    await sleep(60);
  }
  throw new Error('انتهت مهلة: ' + label);
}

async function main() {
  const isPwsh = /powershell|pwsh/i.test(path.basename(String(term.defaultShell())));

  console.log('\n— ① العلّة الجذرية: حفظ الأسطر الجديدة (منطق نقي) —');

  // حالة البلاغ حرفياً: here-string متعدد الأسطر. حذف `\n` يلصق `'@` بالجملة التالية
  // فيولّد جملة غير مكتملة — وهذا مولّد `>>`.
  const multi = "$b = @'\nنص عربي\n'@\nWrite-Output $b";
  ok('sanitizeCommand ما زال يفرض سطراً واحداً (بروتوكول علامات runCapture يوجبه)',
    !term.sanitizeCommand(multi).includes('\n'));
  ok('sanitizeScript يحفظ الأسطر الجديدة',
    term.sanitizeScript(multi).split('\n').length === 4,
    JSON.stringify(term.sanitizeScript(multi)));
  ok('sanitizeScript يحفظ الجملة سليمة بلا التصاق',
    term.sanitizeScript(multi).includes("'@\nWrite-Output"),
    JSON.stringify(term.sanitizeScript(multi)));
  ok('sanitizeScript يوحّد CRLF إلى LF بلا \\r متبقٍّ',
    !term.sanitizeScript('a\r\nb\rc').includes('\r')
    && term.sanitizeScript('a\r\nb\rc') === 'a\nb\nc');
  ok('sanitizeScript يزيل محارف التحكم عدا \\n و\\t',
    term.sanitizeScript('a\x00b\x1bc\td\ne') === 'abc\td\ne',
    JSON.stringify(term.sanitizeScript('a\x00b\x1bc\td\ne')));
  ok('sanitizeScript مسقوف بـ8000 محرف', term.sanitizeScript('ز'.repeat(9000)).length === 8000);
  ok('sanitizeScript يرفض غير النص fail-closed', term.sanitizeScript(null) === '');
  ok('pwshSingleQuote يضاعف الاقتباس المفرد', term.pwshSingleQuote("a'b") === "'a''b'");

  console.log('\n— ② النقل: السكربت يُقلع مع الصدفة لا عبر سطر الطرفية —');
  const src = fs.readFileSync(path.join(ROOT, 'electron', 'termjobs.js'), 'utf8');
  // التحذير المضاد للتراجع باقٍ — مع سببه، كي لا يُعاد أيٌّ من الخطأين المقيسين.
  ok('تحذير عدم إعادة الأمر إلى سطر الطرفية باقٍ',
    /لا تُعِد الأمر إلى سطر الطرفية/.test(src) && /writeTermPasted/.test(src),
    'حُذف التحذير — سيُعاد الخطأ نفسه');
  ok('term.js يصدّر writeTermPasted لمسار runCapture', typeof term.writeTermPasted === 'function');

  if (isPwsh) {
    const probe = term.startTerm(ROOT, 120, 30, { label: 'probe', script: 'exit 0' });
    ok('startTerm يُقلع السكربت في وسائط spawn ويعلنها', probe.ok && probe.launchedScript === true,
      JSON.stringify(probe));
    term.killTerm(probe.id);
    ok('طرفية بلا script تبقى تفاعلية (launchedScript=false)', (() => {
      const plain = term.startTerm(ROOT, 120, 30, { label: 'plain' });
      const flag = plain.ok && plain.launchedScript === false;
      if (plain.ok) term.killTerm(plain.id);
      return flag;
    })());
  } else {
    console.log('  ⏭ صدفة غير PowerShell — فحوص وسائط spawn لا تنطبق (حدّ معلَن)');
  }

  console.log('\n— ③ سلوك المهام: متعدد الأسطر ينفَّذ، والجملة الناقصة تفشل سريعاً —');

  // (أ) أمر **متعدد الأسطر** — كان يُسحق إلى سطر واحد فيفسد. المعيار: نتيجته الصحيحة.
  const mlJob = termjobs.startJob(temp,
    isPwsh ? "$parts = @('AA','BB')\nWrite-Output ($parts -join '-')"
      : "parts='AA-BB'\necho $parts",
    'مهمة متعددة الأسطر');
  ok('بدأت المهمة متعددة الأسطر', mlJob.ok, JSON.stringify(mlJob));
  const mlDone = await waitFor(() => doneOf(mlJob.id), 'bg_term_done للمهمة متعددة الأسطر');
  ok('الأمر متعدد الأسطر نُفّذ فعلاً ونتيجته صحيحة', mlDone.tail.includes('AA-BB'),
    'الذيل: ' + JSON.stringify(mlDone.tail.slice(-200)));
  ok('ورمز خروجه نجاح', mlDone.exitCode === 0, String(mlDone.exitCode));

  // (ب) أمر طويل جداً — يبقى سليماً عبر وسائط spawn بلا حدّ سطر
  const filler = 'x'.repeat(7000);
  const longJob = termjobs.startJob(temp,
    isPwsh ? "$pad='" + filler + "'; if ($pad.Length -eq 7000) { Write-Output 'LONG_OK' }"
      : "pad='" + filler + "'; [ ${#pad} -eq 7000 ] && echo LONG_OK",
    'مهمة طويلة');
  const longDone = await waitFor(() => doneOf(longJob.id), 'bg_term_done للمهمة الطويلة');
  ok('أمر 7000+ محرف وصل سليماً ونُفّذ', longDone.tail.includes('LONG_OK'),
    'الذيل: ' + JSON.stringify(longDone.tail.slice(-200)));

  if (isPwsh) {
    // (ج) **العطل المقيس**: جملة غير مكتملة. قبل الإصلاح كانت القشرة تعلق عند `>>` بلا
    // نهاية والمهمة تبدو حيّة؛ بعده تخرج فوراً برمز غير صفري ورسالة تحليل صريحة.
    const brokenJob = termjobs.startJob(temp, "Write-Output 'UNTERMINATED", 'جملة ناقصة');
    ok('بدأت مهمة الجملة الناقصة', brokenJob.ok, JSON.stringify(brokenJob));
    const brokenDone = await waitFor(() => doneOf(brokenJob.id),
      'الجملة الناقصة يجب أن تخرج لا أن تعلق عند «>>»', 20000);
    ok('الجملة الناقصة تخرج بدل أن تعلق صامتة', brokenDone.exitCode !== 0,
      'رمز الخروج: ' + brokenDone.exitCode);
    ok('ومعها تشخيص صريح في الذيل لا صمت',
      /terminator|ParserError|missing/i.test(brokenDone.tail),
      'الذيل: ' + JSON.stringify(brokenDone.tail.slice(-260)));
    ok('ولا مِحَثّ متابعة «>>» عالق في الذيل', !/>>\s*$/.test(brokenDone.tail.trim()),
      JSON.stringify(brokenDone.tail.slice(-120)));

    // (د) الصدى: `-EncodedCommand` لا يطبع مِحَثّاً، فبلا صدى يرى المستخدم خرجاً بلا مصدر.
    ok('الأمر يُصدَّى في التبويب فيعرف المستخدم ما يعمل',
      mlDone.tail.includes('Write-Output') || mlDone.tail.includes('$parts'),
      'الذيل: ' + JSON.stringify(mlDone.tail.slice(0, 200)));
  }

  console.log('\n— ④ جدول الثوابت: التحويل المعلَن لكل فرع مثبَّت رقماً —');
  // خرج هذا الجدول من جولة قرار (‏2026-08-28) رُفض فيها بناء سجلٍّ دائم لتيار التفكير.
  // الاعتراض القاتل: الفرق البنيوي بين ما طلبه النموذج وما سُلِّم **ليس صفراً بالتصميم**
  // (الغلاف يضيف أسطراً، وفرع cmd/POSIX يحذفها) — فسجلٌّ يرصد «الشذوذ» يشتعل دائماً.
  // العلاج الأرخص: يُثبَّت التحويل المعلَن نفسه هنا ثابتاً، فيسقط أي انحراف في CI قبل
  // الشحن بدل أن يُقرأ من قرص المستخدم بعد أن تعلق مهمته. صفر قرص وصفر خصوصية.
  const sample = "$a = 'x'\n$b = \"y\"\nWrite-Output $a";
  const nl = (sample.match(/\n/g) || []).length; // 2

  const kept = term.structuralDelta(sample, term.sanitizeScript(sample));
  ok('sanitizeScript: تحويل الهوية — صفر في كل بُعد',
    kept.bytes === 0 && kept.newlines === 0 && kept.singleQuotes === 0 && kept.doubleQuotes === 0,
    JSON.stringify(kept));

  const flat = term.structuralDelta(sample, term.sanitizeCommand(sample));
  ok('sanitizeCommand: يُسقط كل الأسطر **عمداً** بقيمة متوقَّعة (‏−' + nl + ')',
    flat.newlines === -nl && flat.bytes === -nl,
    JSON.stringify(flat));
  ok('sanitizeCommand: لا يمسّ الاقتباس',
    flat.singleQuotes === 0 && flat.doubleQuotes === 0, JSON.stringify(flat));

  // غلاف المهمة: أربعة أسطر بالتصميم + أسطر الصدى (الصدى نسخة من الأمر حين لا يُقصّ)
  const oneLine = "Write-Output 'hi'";
  const wrap1 = term.structuralDelta(oneLine, termjobs.buildPwshJobScript(oneLine));
  ok('buildPwshJobScript: يضيف 4 أسطر بالتصميم لأمر أحادي السطر',
    wrap1.newlines === 4, JSON.stringify(wrap1));
  ok('buildPwshJobScript: يضاعف الاقتباس المفرد في الصدى (‏pwshSingleQuote)',
    wrap1.singleQuotes > 0, JSON.stringify(wrap1));

  const wrapN = term.structuralDelta(sample, termjobs.buildPwshJobScript(sample));
  ok('buildPwshJobScript: لأمر متعدد الأسطر يضيف 4 + أسطر الصدى (‏4+' + nl + ')',
    wrapN.newlines === 4 + nl, JSON.stringify(wrapN));

  // القصّ عند 400 ليس تجميلاً: بدونه يتجاوز base64 سطرَ أوامر ويندوز (رُصد 206 حيّاً)
  const huge = 'Write-Output ' + "'" + 'z'.repeat(2000) + "'";
  const script = termjobs.buildPwshJobScript(huge);
  ok('صدى الأمر مقصوص عند MAX_ECHO_CHARS=' + termjobs.MAX_ECHO_CHARS,
    script.includes('قُصّ الصدى') && script.length < huge.length * 2,
    'طول السكربت ' + script.length + ' مقابل أمر ' + huge.length);
  ok('والأمر نفسه يبقى كاملاً رغم قصّ الصدى', script.includes('z'.repeat(2000)));

  ok('structuralDelta دالة نقية لا مستدعي لها في الإنتاج', (() => {
    const files = ['electron/term.js', 'electron/termjobs.js', 'electron/tools.js',
      'electron/agent.js', 'electron/codex.js', 'electron/kimi.js'];
    for (const f of files) {
      const body = fs.readFileSync(path.join(ROOT, f), 'utf8');
      // التعريف والتصدير في term.js مسموحان؛ أي **استدعاء** في الإنتاج ممنوع
      if (/structuralDelta\s*\(/.test(body.replace(/function structuralDelta\s*\(/g, ''))) return false;
    }
    return true;
  })(), 'استُدعيت في مسار إنتاج — القرار كان ألّا يُكتب أثرها إلى أي قرص');

  console.log('\n— ⑦ بروتوكول الالتقاط تحت bash/sh (OBS-072 — منطق نقي، بلا pty ولا لينكس محلي) —');
  // العطل المقيس في بوابة لينكس (‏33697105032): فرع sh/bash طابق النمط القديم بلا الحقل
  // الثالث، وعلامة النهاية بلا تقييد بداية سطر كانت قد تُطابق صدًى ملتفّاً فتُنهي الالتقاط
  // مبكراً ويتسرّب النداء التالي إلى خرج سابق («خرج النداء الأول متشابك»). هذه الفحوص
  // تثبت المنطق نقيّاً؛ القياس الحيّ تحت bash يبقى لـ`test:termjobs` على البوابة.

  // (أ) فرع POSIX يبني الحقول الثلاثة كاملة: رمز خروج رقمي دائماً + علم مشتق منه.
  const capLine = term.buildCaptureLine('/bin/bash', 'MK_B', 'MK_E', 'echo hi');
  ok('POSIX: علامة النهاية بثلاثة حقول (‏END:<رمز>:<علم>)',
    capLine.includes('printf "%s:%s:%s\\n" "MK_E"'), capLine);
  ok('POSIX: رمز الخروج يُلتقط رقمياً فور الأمر (‏c=$? قبل العلامة)',
    capLine.indexOf('c=$?;') !== -1 && capLine.indexOf('c=$?;') < capLine.indexOf('"MK_E" "$c"'),
    capLine);
  ok('POSIX: علم الصدفة مشتق حسابياً من الرمز (رقم 0/1 دائماً)',
    capLine.includes('"$(($c == 0))"'), capLine);
  ok('POSIX: علامة البداية سطر مستقل قبل الأمر',
    capLine.indexOf('printf "%s\\n" "MK_B";') !== -1
    && capLine.indexOf('printf "%s\\n" "MK_B";') < capLine.indexOf('echo hi'), capLine);

  // (ب) مسار PowerShell بلا انحراف بايت واحد — السطر الملتصق للصدفة مثبَّت حرفياً
  // (نفس البنية التي عقدت في OBS-065 وtermjobs؛ أي تغيير مستقبلي هنا يتطلب قراراً
  // موثّقاً وتحديث هذا الثابت عن سابق قصد).
  const PS_CAPTURE_PIN = '$global:LASTEXITCODE=$null; Write-Output "MK_B"; echo hi'
    + ' ; $ok=$?; $c=$LASTEXITCODE; if($null -eq $c){$c=if($ok){0}else{1}}'
    + '; Write-Output ("MK_E:"+$c+":"+$(if($ok){1}else{0}))\r';
  ok('PowerShell: سطر الالتقاط مطابق للثابت المثبَّت بايتاً ببايت (بما فيه \\r الختامي)',
    term.buildCaptureLine('powershell.exe', 'MK_B', 'MK_E', 'echo hi') === PS_CAPTURE_PIN,
    JSON.stringify(term.buildCaptureLine('powershell.exe', 'MK_B', 'MK_E', 'echo hi')));
  const CMD_CAPTURE_PIN = 'echo MK_B & echo hi & echo MK_E:%ERRORLEVEL%\r';
  ok('cmd: سطر الالتقاط بلا انحراف', term.buildCaptureLine('cmd.exe', 'MK_B', 'MK_E', 'echo hi') === CMD_CAPTURE_PIN);

  // (ج) تحليل العلامة: الحقول الثلاثة، وعلم الفشل، والتوافق الخلفي مع النمط القديم.
  const newOk = term.matchCaptureEnd('خرج الأمر\nMK_E:0:1\n', 'MK_E', true);
  ok('التحليل: النمط الجديد ثلاثي الحقول — نجاح',
    newOk && newOk.exitCode === 0 && newOk.shellFailed === false, JSON.stringify(newOk));
  const newFail = term.matchCaptureEnd('MK_E:0:0', 'MK_E', true);
  ok('التحليل: علم الفشل مع رمز خروج 0 (‏shellFailed)',
    newFail && newFail.exitCode === 0 && newFail.shellFailed === true, JSON.stringify(newFail));
  const oldTwo = term.matchCaptureEnd('MK_E:3', 'MK_E', true);
  ok('التوافق الخلفي: النمط القديم بلا الحقل الثالث يُقبل — رمزه يُقرأ وعلمه غير مفترض',
    oldTwo && oldTwo.exitCode === 3 && oldTwo.shellFailed === false, JSON.stringify(oldTwo));
  const crlf = term.matchCaptureEnd('سطر\r\nMK_E:7:1\r\n', 'MK_E', true);
  ok('التحليل: العلامة بعد \\r\\n (سطر بداية حقيقي) تُطابَق',
    crlf && crlf.exitCode === 7 && crlf.shellFailed === false, JSON.stringify(crlf));
  ok('التحليل: خرج بلا علامة يردّ null', term.matchCaptureEnd('لا شيء هنا', 'MK_E', true) === null);
  ok('التحليل: رمز غير رقمي لا يُطابَق', term.matchCaptureEnd('MK_E:abc', 'MK_E', true) === null);

  // (د) تقييد بداية السطر (‏POSIX): صدًى ملتفّ أو خرج أمر يحوي نصّ العلامة بلا أن
  // يكون سطراً مستقلاً **لا يُنهي الالتقاط** — هذا هو منع التشابك تحديداً.
  const echoTrap = term.matchCaptureEnd('صدى: printf "%s" "MK_E" ثم MK_E:0 في المنتصف', 'MK_E', true);
  ok('POSIX: علامة في منتصف سطر (صدًى/خرج) لا تُطابَق — لا إنهاء مبكّر كاذب',
    echoTrap === null, JSON.stringify(echoTrap));
  const legacyMid = term.matchCaptureEnd('prefix MK_E:5', 'MK_E', false);
  ok('غير POSIX: سلوك المطابقة الحرّة باقٍ للمسارات المثبَّتة (‏cmd/PowerShell)',
    legacyMid && legacyMid.exitCode === 5, JSON.stringify(legacyMid));

  console.log('\n— ⑤ قصّ الذيل: حدود UTF-8 وإعلان القصّ —');
  const started = term.startTerm(ROOT, 120, 30, { label: 'longline-buffer' });
  ok('أُنشئت طرفية الاختبار', started.ok, JSON.stringify(started));
  const id = started.id;

  const arabic = 'مرحبا بالعالم '.repeat(14);
  term.writeTermPasted(id, (isPwsh ? "Write-Output '" + arabic + "'" : "echo '" + arabic + "'") + '\r');
  let seen = '';
  for (let i = 0; i < 60 && !seen.includes('مرحبا بالعالم'); i++) {
    await sleep(250);
    const r = term.readBuffer(id);
    seen = r.ok ? r.data : '';
  }
  ok('وصل نصّ عربي إلى المخزن', seen.includes('مرحبا بالعالم'), seen.slice(-120));

  const full = term.readBuffer(id);
  ok('بلا قصّ: truncated=false', full.ok && full.truncated === false, JSON.stringify(full.truncated));
  ok('بلا قصّ: لا علامة مقحمة', !/قُصّ \d+ بايت/.test(full.data));

  const cut = term.readBuffer(id, 400);
  ok('مع القصّ: truncated=true', cut.ok && cut.truncated === true);
  ok('القصّ معلَن بعلامة صريحة', /^\[قُصّ \d+ بايت من بداية السجل/.test(cut.data), cut.data.slice(0, 80));
  ok('droppedBytes رقم موجب', Number.isInteger(cut.droppedBytes) && cut.droppedBytes > 0,
    String(cut.droppedBytes));
  ok('الذيل أقصر من الكامل', cut.data.length < full.data.length + 80);

  // العربي بايتان في UTF-8، فمسحُ ثمانية إزاحات متتالية يضمن أن نصفها يقع داخل محرف
  // إن عُطّلت المحاذاة.
  const brokenOffsets = [];
  for (let extra = 0; extra < 8; extra++) {
    const r = term.readBuffer(id, 120 + extra);
    if (r.ok && r.data.includes('�')) brokenOffsets.push(120 + extra);
  }
  ok('لا محرف تالف عند أي من ثماني إزاحات قصّ', brokenOffsets.length === 0,
    'إزاحات شطرت محرفاً: ' + brokenOffsets.join(', '));

  // **ما لا يغطّيه هذا الحارس** (مُثبَت بفحص عضّ: تعطيل المحاذاة يُبقيه أخضر): إسقاط
  // السطر الجزئي يبتلع المحرف المشطور قبل أن يصل، فمحاذاة UTF-8 طبقةٌ ثانية أثرها
  // المستقل يظهر فقط حين لا يحوي الذيل سطراً جديداً أصلاً — وهي حالة يصعب ترتيبها مع
  // مِحَثّ الصدفة. تبقى المحاذاة دفاعاً معلَناً لا مغطّى، لا يُسجَّل كأنه مُختبَر.

  term.killTerm(id);

  console.log('\n— 6 عناقيد الحرف العربي عند حافة الالتفاف (OBS-106) —');
  // OBS-106 قِيست على عرض 40 عموداً فرصدت عطلَين: (أ) انقسام العنقود عند حافة الالتفاف
  // (تشويه عرض بصري بلا فقد — تثبيت قياس لا يزال قائماً، علاجه يمسّ العارض) و(ب) سقوط
  // الحركات المُلصقة في مسار الإدخال (فقد بيانات — عُولج في `term.js` وثبت تشخيصه:
  // المُسقط PSReadLine القديم، والعلاج لصق عبر الحافظة). سقوط فحص (أ) المثبَّت يعني أن
  // القياس تغيّر — يُعاد ويُحدَّث OBS-106؛ وسقوط فحص (ب) يعني أن العطل القديم عاد.
  if (!isPwsh) {
    console.log('  تخطٍّ: صدفة غير PowerShell — بناء النصّ المشكَّل يستعمل صياغة PowerShell (حدّ معلَن)');
  } else {
    const WRAP_COLS = 40;
    const PREFIX = WRAP_COLS - 3;   // فيقع العنقود الأول عند العمودين الأخيرين تماماً
    const CLUSTERS = 3;
    // تُبنى المحارف من رموزها لا حرفياً: علامات التشكيل غير مرئية في المصدر، وكتابتها
    // برمزها تجعل ما يُقاس مقروءاً ولا تعتمد على ترميز الملف.
    const BEH = String.fromCharCode(0x0628);    // باء — حرف أساس أحادي العرض
    const FATHA = String.fromCharCode(0x064E);  // فتحة — علامة واصلة عرضها صفر بالتصميم
    const DAMMA = String.fromCharCode(0x064F);
    const ESC = String.fromCharCode(27);
    const BEL = String.fromCharCode(7);
    const MARK_CODES = [0x064B, 0x064C, 0x064D, 0x064E, 0x064F, 0x0650, 0x0651, 0x0652, 0x0670];
    const startsWithMark = (line) => {
      const first = [...line][0];
      return first !== undefined && MARK_CODES.includes(first.codePointAt(0));
    };
    // تجريد تسلسلات ANSI بلا تعابير فيها محارف تحكم: تُشقّ السلسلة عند ESC ويُقصّ رأس
    // كل شقّ حسب نوعه (CSI بمعاملاته وحرفه النهائي، وOSC حتى BEL).
    const stripAnsi = (text) => {
      const parts = String(text).split(ESC);
      let out = parts[0];
      for (let index = 1; index < parts.length; index++) {
        let chunk = parts[index];
        if (chunk.startsWith('[')) {
          let cut = 1;
          while (cut < chunk.length && '0123456789;?'.includes(chunk[cut])) cut++;
          if (cut < chunk.length) cut++;
          chunk = chunk.slice(cut);
        } else if (chunk.startsWith(']')) {
          const bel = chunk.indexOf(BEL);
          chunk = bel === -1 ? '' : chunk.slice(bel + 1);
        } else {
          chunk = chunk.slice(1);
        }
        out += chunk;
      }
      return out;
    };
    const countChar = (text, ch) => text.split(ch).length - 1;
    const promptBack = (text) => /PS .*>\s*$/.test(text.trim().slice(-60));

    const wrapTerm = term.startTerm(ROOT, WRAP_COLS, 14, { label: 'longline-wrap' });
    ok('أُنشئت طرفية القياس بعرض ' + WRAP_COLS + ' عموداً', wrapTerm.ok, JSON.stringify(wrapTerm));
    await sleep(2600);
    term.readBuffer(wrapTerm.id);

    // (أ) **الالتفاف**: النصّ يُبنى داخل PowerShell من رموز [char] فلا يمرّ محرف غير
    //     ASCII في الإدخال — عزلٌ مقصود عن العطل (ب) أدناه، وإلا اختلط سببان في قياس.
    const build = '$b=[string][char]0x628; $f=[string][char]0x64E; '
      + 'Write-Output ((($b)*' + PREFIX + ')+(($b+$f)*' + CLUSTERS + '))';
    term.writeTermPasted(wrapTerm.id, build + '\r');
    let wrapOut = '';
    for (let attempt = 0; attempt < 60; attempt++) {
      await sleep(200);
      wrapOut = stripAnsi(term.readBuffer(wrapTerm.id).data);
      if (countChar(wrapOut, FATHA) >= CLUSTERS && promptBack(wrapOut)) break;
    }
    const emittedMarks = countChar(wrapOut, FATHA);
    const arabicLines = wrapOut.split(/\r?\n/).filter((line) => line.includes(BEH));
    const splitLines = arabicLines.filter(startsWithMark).length;
    console.log('    قياس الالتفاف: أسطر عربية=' + arabicLines.length
      + ' · تبدأ بحركة عارية=' + splitLines + ' · حركات وصلت=' + emittedMarks);

    // ثابتٌ يجب أن يصمد مهما تغيّر الالتفاف: لا تُفقد حركة من المجرى.
    ok('لا تُفقد علامة تشكيل عبر الالتفاف (' + CLUSTERS + ' متوقَّعة)',
      emittedMarks === CLUSTERS, 'المرصود: ' + emittedMarks);
    ok('مرصود (OBS-106): العنقود ينقسم على سطرين — سطر ملتفّ يبدأ بحركة عارية',
      splitLines > 0,
      'اختفى الانقسام (splitLines=' + splitLines + ') — القياس تغيّر: أعِد القياس وحدّث OBS-106');

    // (ب) عطل ثانٍ **مستقل** رُصد أثناء القياس نفسه: نصّ مشكَّل يُلصق في سطر الطرفية
    //     تسقط حركاته قبل أن تبلغ الصدفة أصلاً. التشخيص (دفعة OBS-106): المُسقط PSReadLine
    //     2.0.0 المرافق لـWindows PowerShell 5.1 — يحفظ cmd الحركات، وتعود بعد إزالة
    //     الوحدة، ويحفظ لصقها عبر الحافظة (تقرأ نصاً لا أحداث مفاتيح). العلاج في
    //     `term.js` (‏`clusterPasteWrite`): لصق عبر الحافظة + Ctrl+V للإدخال التفاعلي
    //     أحادي السطر. والفحص أدناه يثبت **السلوك الجديد** ويسقط إن عاد الفقد القديم.
    const literal = BEH + FATHA + BEH + DAMMA;
    term.writeTermPasted(wrapTerm.id, "Write-Output 'MARK<" + literal + ">'" + '\r');
    let pasteOut = '';
    for (let attempt = 0; attempt < 50; attempt++) {
      await sleep(200);
      pasteOut = stripAnsi(term.readBuffer(wrapTerm.id).data);
      if (pasteOut.includes('MARK<') && promptBack(pasteOut)) break;
    }
    // المخزن دائري تراكمي، فحركات الفقرة (أ) ما زالت فيه: يُقصّ ما قبل أول «MARK<»
    // كي يُقاس هذا النداء وحده — وإلا صار الفحص يعدّ قياساً سابقاً ويُقرأ نجاحاً كاذباً.
    const pasteTail = pasteOut.slice(Math.max(0, pasteOut.indexOf('MARK<')));
    const pastedMarks = countChar(pasteTail, FATHA) + countChar(pasteTail, DAMMA);
    console.log('    قياس اللصق: حركات وصلت=' + pastedMarks + ' · الأساس وصل='
      + pasteTail.includes(BEH));
    ok('الحركات المُلصقة تصل بعد علاج OBS-106 (العنقود سليم لا يُفكّ)',
      pasteTail.includes(BEH + FATHA) && pasteTail.includes(BEH + DAMMA),
      'عاد العطل القديم: الحركات ساقطة — الذيل: ' + JSON.stringify(pasteTail.slice(0, 120)));
    ok('والحرف الأساس نفسه يصل سليماً — فالوصل يشمل العلامات لا الأساس وحده',
      pasteTail.includes(BEH), JSON.stringify(pasteTail.slice(0, 120)));

    term.killTerm(wrapTerm.id);
  }

  term.killAll();
  try { fs.rmSync(temp, { recursive: true, force: true, maxRetries: 15, retryDelay: 200 }); }
  catch (e) { console.warn('term-longline: تعذّر تنظيف المجلد المؤقت (غير مُفشل)'); }

  console.log('\nterm-longline: نجح — ' + checks
    + ' فحصاً (حفظ الأسطر، إقلاع السكربت في وسائط spawn، فشل صريح بلا علق، وقصّ ذيل معلَن، وبروتوكول الالتقاط تحت bash/sh نقيّاً، وعناقيد الحرف عند حافة الالتفاف مقيسة).');
  process.exit(0);
}

main().catch((error) => {
  console.error('term-longline: FAIL:', (error && error.stack) || error);
  process.exit(1);
});
