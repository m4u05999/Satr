# تشخيص التوقفات المتكررة — 2026-09-22

## الحالة الحالية قبل الإصدار

نجح الطقم الكامل بعد إصلاح ConPTY ورفع النسخة إلى 2.18.1: **153/153**،
ورمز خروج 0، وفق `dist/test-runs/2026-09-22T04-47-37-793Z/summary.json`.
الجولة السابقة 152/152 محفوظة في `dist/test-runs/2026-09-22T02-24-53-646Z/summary.json`.
اكتمل قبول النموذج المحلي وتنبيه إعادة المحاولة، وأغلق المالك بند WhatsApp
بتأكيد تجربته في جلسة أخرى؛ تفاصيلها في `internals/84-permission-metrics.md`.
الفقرات المؤرخة أدناه سجل للمحطات السابقة، وليست قائمة انتظار حالية.

حالة تجربة Codex على محرك حقيقي: جُهزت الحزمة المعزولة في
`live_a4eb42e9975f7061b120b58b`، بعنوان «سطر — فحص توجيه Codex»،
سجّل المالك الدخول بنفسه. فشل الطلب الأول قبل إنشاء الجلسة بـ
`codex_rpc_closed` خلال نحو ثانية. نجحت إعادة تشخيصية واحدة بمحرك Codex
والنموذج المختار في الواجهة `gpt-6-astra`، وانتهت بـ `result:success`
و`proc_done:0`. لم يُنقل اعتماد ولم يتغير كود الإنتاج بسبب هذه المعالجة.
سبب الانقطاع الأول غير مثبت، ونجاح الإعادة ليس إصلاحاً له.
الدليل `codex-diagnostic-result.json` في جذر التجربة؛ فحصا الإقلاع وإنشاء
الخيط دون طلب نموذج محفوظان في `codex-boot-probe.json` و`codex-thread-probe.json`.
نجاح انتهاء دور عادي وحده لا يثبت فرع
`no_active_turn`. معيار الصواب والفشل والحدود مكتوبة قبل التجربة في
`dist/live-tests/live_a4eb42e9975f7061b120b58b/human-scenario.json`.

قبول بشري لاحق في الحزمة نفسها: أرسل المالك طلب العشرين نصيحة، وكتب
«اختصرها إلى ثلاث نقاط» أثناء الدور دون إرسالها. أظهرت لقطتاه النص مع زر
«وجّه» أثناء الاستعداد، ثم النص نفسه مع زر «إرسال» بعد ظهور الإجابة كاملة.
اجتاز حفظ المسودة وعودة زر الإرسال عند اكتمال الدور العادي، وفق المعيار
المسلّم قبل التجربة. مصدر الدليل صورتا المالك في المحادثة؛ لا ندّعي وجود
نسخة محلية من الصورتين. لم تُضغط «وجّه» في هذا الفحص، فلا يثبت رفض
التوجيه المتأخر من المحرك الحقيقي. ذلك الفرع مغطى آلياً بحارس
`scripts/conversation-ui-test.js` وعضّاته الموثقة أدناه؛ لا يُطلب من المالك
تكرار سباق توقيت لإثبات ما يغطيه الحارس. لم يتغير كود الإنتاج لهذه النتيجة.

تحديث التشخيص: أُعيد انهيار خروج الطرفيات المتزامن وحدد التفريغ موقعه في
`conpty.node` داخل `SetupExitCallback`، عند إزالة عنصر `ptyHandles` المشترك.
ثُبّت إصلاح المصدر الرسمي عبر `node-pty@1.2.0-beta.15`؛ تفاصيل المقارنة والعضّة
في قسم «سباق الخروج المتزامن» أدناه. اكتمل التحقق الجديد للحارس والحزمة والطقم، كما في خاتمة هذه الوثيقة.
لا التزام أو دفع أو وسم إصدار في هذه المحطة.

## النتائج المثبتة

- الحزمة: dist/gate-recovery-build/win-unpacked/Satr.exe. لم يُغيَّر node-pty أو سياسة الأذونات أو النسخة المثبتة.
- التشغيل المخصص بـ --inspect-brk وDebugger.enable توقف داخل native connect؛ startProcess عاد. مسار العامل داخل app.asar ليس سبباً مثبتاً: تحميله خارج الأرشيف لم يغير النتيجة. execArgv كان فارغاً، فلا دليل على وراثة ذلك العلم هناك.
- حذف مصحح العملية الرئيسية واستخدام --user-data-dir مع buildChildEnv نجح في فتح طرفيتين؛ تجربة لاحقة أثبتت خرج أمر منفصل في كل طرفية. أُصلحت مشغلات gate-recovery وpermission-metrics المخصصة داخل dist. المسار الرسمي source لم يتغير.
- كشف الإغلاق بـ exit خروج الحزمة 3221225477 (0xC0000005). السبب الأصلي داخل الإغلاق غير محدد، ولم يُصلح. المسبار الدائم يفصل نجاح الخرج عن اكتمال الإغلاق.
- فشل حفظ المحادثة في failContinuity كان يوقف المحرك ويرسل السبب عبر stderr غير المرئي. أُصلح العرض باستعمال spawn_error / kind=continuity، مع المحافظة على إيقاف المحرك عند فشل الحفظ. لا يثبت ذلك أن الحفظ سبب الحادثتين التاريخيتين.

## سجلا Codex وسطر

الدور run-b2b05801-bd8a-404c-ae20-f4400264d67b: أنتج Codex جواباً نهائياً من 646 محرفاً، ثم task_complete عند 2026-09-21T20:18:52.444Z؛ سجل سطر stopped عند 20:18:54.607Z مع جواب مبتور. الدور run-a46aa2a3-cd27-4b0e-8b83-346d434ac688: سجل سطر stopped عند 20:42:00.564Z؛ سجل Codex turn_aborted reason=interrupted عند 20:42:00.668Z. لا يحدد السجل مستدعي الإيقاف. لا ننسبه للمستخدم ولا لانهيار النموذج.

## الأدلة المحلية

- dist/live-tests/live_e734ca036e3fd4911f06e6ee: فشل إعداد المسبار الأول؛ غياب cwd منع إنشاء الطرفية. كشف أن اختبار اللوحة السابق لم يكن كافياً.
- dist/live-tests/live_11235719b815a6ce04a51430: spawn:enter دون return وdebug_timeout.
- dist/live-tests/live_ff1a4ee2b99ba68b5be33248/worker-stages.jsonl: startProcess:return ثم connect:enter دون return.
- dist/live-tests/live_047f86429981adcc80dc2512: نقل مسار العامل وحده لم يصلح التعليق.
- dist/live-tests/live_86081fe10cd3a2250e59bff1/two-terminals.json: الطرفيتان والواجهة تستجيبان بلا مصحح رئيسي.
- dist/live-tests/live_9bc2b14c3e7a9ad8eaec1880: نجح خرج الطرفيتين، ثم package-exit.json يحمل 3221225477؛ failure.json يحمل debug_timeout. ملف two-terminals.json القديم يخص الفتح والخرج فقط، ولا يعد قبولاً كاملاً.

## الحارس والعضّة

node scripts/conversation-main-test.js: 10/10. يزرع EBUSY في renameSync للمسودة مرة واحدة، ثم يختبر توقف المحرك، وصول الخطأ المرئي مرة واحدة، عدم إخفائه بحدث متأخر، وحفظ النص الجزئي.

أمر زرع العطل كما نُفذ داخل سكربت Node عبر PowerShell (المصدر الحقيقي لا يُستبدل؛ النسخة هي مدخل --source):

~~~js
const original=fs.readFileSync('electron/main.js','utf8');
const good="emitToWindow({ type: 'spawn_error', kind: 'continuity',";
const bad="emitToWindow({ type: 'stderr', kind: 'continuity',";
const count=(s,t)=>s.split(t).length-1;
const mutant=original.replace(good,bad);
const file=path.join(dir,'main-mutant.js');
fs.writeFileSync(file,mutant);
const result=cp.spawnSync(process.execPath,['scripts/conversation-main-test.js','--source',file],{encoding:'utf8',timeout:20000});
fs.writeFileSync(file,original);
~~~

العد المقيس: الأصل 1→0، المتحوّر 0→1؛ بعد الاستعادة الأصل 1، المتحوّر 0.

~~~text
BITE_EXIT 1
AssertionError [ERR_ASSERTION]: continuity failure must reach the visible error channel
~~~

أمر الاستعادة الفعلي: fs.writeFileSync(file,original). خرج الحارس في dist/continuity-visibility/bite.log ونتيجة العد في bite.json. المصدر الأصلي لم يُمس أثناء العضّة.

## الحدود والمتبقي

لم يُشغّل الطقم الكامل. لم يُحدَّث تطبيق المالك المثبت ولم يُجر commit. لم تُنسخ بيانات الدخول ولم يعمل نموذج مدفوع. لم تُجمع عينة أذونات جديدة. تسجيل دخول التجربة القديم term_2 خارج موارد هذه التجارب، ولم يُوقف. يبقى تحديد سبب مقاطعة Codex التاريخية وانهيار إغلاق الطرفيات عملاً مفتوحاً؛ إصلاح إظهار السبب لا يساوي إصلاح السبب.


## متابعة 22 سبتمبر: فصل الإغلاق ومصدر المقاطعة

- live_406d6d908bfa669f65298d74: خروج كل صدفة على حدة، ثم إغلاق التطبيق؛ رمز 0. المراحل محفوظة في stages.json.
- live_f81c5f7846ced9b211eb67c1: termKill لكل طرفية على حدة، ثم إغلاق التطبيق؛ رمز 0. اختبار API الإغلاق، لا نقرة بشرية على التبويب.
- تأكد وجود سباق ptyHandles في المصدر المثبت 1.1.0، مع إصلاح upstream [#922](https://github.com/microsoft/node-pty/pull/922) وتقرير [#921](https://github.com/microsoft/node-pty/issues/921) يحمل رمز الانهيار نفسه. هذا مرشح قوي، لا بصمة crash dump محلية تربط الحادثة به. كذلك يطابق [#943](https://github.com/microsoft/node-pty/pull/943) تعليق العامل تحت المصحح.
- نُزلت 1.2.0-beta.15 إلى dist/pty-candidate فقط باستخدام npm pack --ignore-scripts. مصدرها يحتوي الحماية وwatchdog العامل. لم تُثبت في المشروع ولم يتغير القفل أو الاعتمادية.
- مقارنة electron/term.js الحقيقي تحت Electron المثبت: 3 جولات × 6 طرفيات، مع خرج فعلي ثم exit متقارب. الحالي live_f75d3094c226e195011a64aa والمرشح live_2dfbedf55e650a2e5fb65ae5 اجتازا 18 خروجاً لكل منهما ورمز التطبيق 0. لا دليل تفضيل مقيس؛ لا تُقدّم الترقية كعلاج مثبت. هذه مقارنة داخل Electron بلا قشرة UI، وليست قبول الحزمة المرشحة.
- أُضيف stopSource إلى سجل الدور، ووسمت مواقع stopAll في main بمصدر داخلي مغلق. لا يُنسب renderer_request للمستخدم تلقائياً. السجلات التاريخية تبقى بلا مصدر معلوم.
- الاختبارات: conversations 26/26، conversation-main 11/11، conversation-ui 19/19، subagent-permission 31 فحصاً، mobile-task-owner 7 سيناريوهات. أصلحت بيئة conversation-ui لتعريف setupGate بعد أن سقطت بـReferenceError؛ منطق المنتج لم يتغير لذلك.

### عضّتا مصدر الإيقاف

نُفذت عبر سكربت Node في PowerShell؛ النسخة المتحورة وحدها مدخل الاختبار:

~~~js
let mutant=original.replace(c.good,c.bad);
if(c.file.includes('conversations.js')) mutant=mutant.replace("require('./memory')",'require('+JSON.stringify(path.resolve('electron/memory.js'))+')');
fs.writeFileSync(mutantFile,mutant);
const r=cp.spawnSync(process.execPath,[c.test,...(c.flag==='--source'?[c.flag,mutantFile]:[c.flag+mutantFile])],{encoding:'utf8',timeout:20000});
fs.writeFileSync(mutantFile,original);
~~~

1. store-stop-source: استبدال run.stopSource = STOP_SOURCES.has(source) ? source : 'unspecified'; بـrun.stopSource = 'unspecified';، ثم node scripts/conversations-test.js --module=<mutantFile>.
2. main-stop-source: استبدال stopAll(false, 'new_request'), بـstopAll(false),، ثم node scripts/conversation-main-test.js --source <mutantFile>.

في كلتا العضتين: الأصل 1→0 والمتحور 0→1؛ بعد أمر الاستعادة fs.writeFileSync(mutantFile,original): الأصل 1 والمتحور 0. ملفات المصدر لم تتحور. الخرج الحرفي:

~~~text
AssertionError [ERR_ASSERTION]: stop source must persist
AssertionError [ERR_ASSERTION]: new send must record stop source
~~~

الأدلة: dist/continuity-visibility/store-stop-source.{json,log} وmain-stop-source.{json,log}. خرج الاختبارين 1 كما ينبغي. لم يُشغل الطقم الكامل، ولم يُجر commit أو تحديث النسخة المثبتة.


## تصحيح من المالك: الإيقاف بعد رفض التوجيه

أوضح المالك أنه هو الذي ضغط إيقاف بعدما حاول إرسال رسالة وظهرت «انتهى الدور — أرسل رسالة جديدة بدل التوجيه». هذه إفادة تفسر فعل الإيقاف في التسلسل المبلغ عنه؛ لا يعود صالحاً وصفه بانقطاع ذاتي مجهول الفاعل. لا تثبت وحدها سبب تأخر/فقدان إشعار اكتمال الدور في الواجهة.

الفحص أثبت عطلاً مستقلاً في steerTurn: رد no_active_turn يعرض التنبيه، ثم refreshSteerButton يترك busy=true؛ المحاولة التالية تعود للتوجيه، فلا ينفذ الإرشاد الذي أعطيناه. الإصلاح يستدعي endRun للطلب نفسه فقط، فيعيد زر إرسال ويحفظ نص المحرر. لا يعيد الإرسال آلياً ولا يستدعي stop؛ الضغطة التالية ترسل مرة واحدة. الرفض العام يبقي الدور نشطاً، ورد IPC قديم لا يحرر دوراً جديداً (conversationEpoch/currentBlock).

حارس conversation-ui يشغّل send/steerTurn/releaseRunControls/endRun الإنتاجية، مع بدائل IPC فقط: 22/22. codex-steer نجح بعقد fixture بلا خدمة مدفوعة. فحص app.js بلاحقة mjs نجح. هذه أدلة آلية؛ القبول البشري للحزمة المحدثة لم يحدث بعد.

### عضّات التعافي من التوجيه

الأمر المنفذ لكل حالة داخل Node عبر PowerShell:

~~~js
const mutated=source.replace(good,bad);
fs.writeFileSync(file,mutated);
const r=cp.spawnSync(process.execPath,[test,'--source',file],{encoding:'utf8',timeout:15000});
fs.writeFileSync(file,original);
~~~

المدخل test هو scripts/conversation-ui-test.js؛ file تحت dist/continuity-visibility، وليس ملف الإنتاج. التحويرات والخرج الحرفي:

- expired-steer: استبدال endRun قبل إشعار «انتهى الدور» بتعليق؛ الأصل 1→0، المتحور 0→1. AssertionError [ERR_ASSERTION]: expired steer must release composer
- rejected-steer: توسيع if (r && r.error === 'no_active_turn') إلى if (r && r.error)؛ الأصل 1→0، المتحور 3→4 (ثلاث مطابقات قائمة خارج هذا الموضع). AssertionError [ERR_ASSERTION]: rejected steer must keep active turn
- late-steer: استبدال حارس steerEpoch/currentBlock بـif (false) return؛ الأصل 1→0، المتحور 0→1. AssertionError [ERR_ASSERTION]: late steer must not release new turn

الاستعادة الفعلية fs.writeFileSync(file,original) أعادت الأعداد إلى 1/0 و1/3 و1/0. الثلاثة خرجت برمز 1. ملفات json/log بنفس أسماء الحالات تحفظ الدليل.


## الحزمة النهائية لهذه المتابعة

بُنيت dist/stability-diagnostic-build/win-unpacked/Satr.exe بعد إصلاح no_active_turn. مسبار live_45abb38c7722893e35e2f95c طابق سبعة ملفات إنتاجية بالبايت من app.asar، ثم اجتاز فتح الطرفيتين والخرج وخروج كل صدفة والإغلاق؛ completion.pass=true وpackage-exit.code=0. تحققنا من انتهاء PID الخاص بالتجربة. هذه النتيجة لا تختبر خدمة Codex الحقيقية، ولا تثبت حل الانهيار المتقطع. لم تُحدث النسخة المثبتة، وبقيت الاعتمادية node-pty 1.1.0.

## نتيجة تجربة المالك للطرفية

التجربة live_c6084e90156eeef2e3a513fe في الحزمة النهائية وبملف شخصي معزول. لقطة المالك في المحادثة تعرض تبويبي PowerShell، والأمر Write-Output 123 وخرجه 123 وعودة prompt في التبويب المحدد. تُقبل خطوة فتح الطرفية الثانية وتنفيذ الأمر فقط؛ لا تثبت اللقطة استجابة مستمرة، أو سلامة الإغلاق، أو إصلاح التوجيه، أو زوال الانهيار المتقطع. تفصيل الحكم في human-review.json داخل موارد التجربة.


## متابعة التشخيص وتجميع النسخة — 2026-09-22

- السيناريو الإضافي: إنشاء طرفيات أثناء خروج غيرها، 60 إجمالاً وبحد 6 متزامنة ومهلة 120 ثانية. الأمر: node dist/pty-candidate/rolling.cjs. يشغّل electron/term.js الحقيقي تحت Electron 33.4.11 وnode-pty 1.1.0، بلا مصحح رئيسي وبمنزل وملف شخصي معزولين، بلا محرك مدفوع أو واجهة التطبيق.
- التجربة live_25643f57e52a1a490a356757: started=60، exited=60، goodOutput=60، maxLive=6؛ rolling-result.json يحمل pass=true، وrolling-exit.json يحمل code=0 وtimedOut=false. انتهى PID 23916. تداخل أعمار الطرفيات لا يثبت وقوع سباق الخيوط الأصلي؛ الانهيار السابق 0xC0000005 ما زال غير محسوم، ولم تُرقّ الاعتمادية أو يُعدّل term.js بناءً على التخمين.
- لا حدث Application Error برقم 1000 منذ 2026-09-21 في استعلام سجل Windows الذي أُجري، ولم تُعثر أدوات cdb/windbg/procdump في PATH. لا يوجد dump محلل يربط انهيارنا بسباق node-pty المعروف.
- اكتمل بناء dist/stability-combined-build/win-unpacked/Satr.exe برمز 0. يحتوي إصلاح الكتابة الغنية والتوجيه بعد انتهاء الدور والخروج من بوابة الإعداد وقياس الأذونات. ملف verified-files.json بجانب البناء يثبت تطابق 14 ملفاً محدداً من app.asar بالبايت مع المصدر؛ لا يدّعي تغطية كل الحزمة.
- هذه نسخة من شجرة العمل الحالية بما فيها تعديلاتها السابقة، وليست إصداراً منشوراً أو تثبيتاً على جهاز المالك. لم يُشغّل الطقم الكامل، ولم تُفتح الحزمة المجمعة للقبول، بناءً على تأجيل المالك التجربة إلى دفعة واحدة.

### ما بقي قبل الاعتماد

1. اكتمل الطقم الكامل وفحص الحزمة المعزولة؛ تفاصيل السقوط الأول وإعادة المجموعات أدناه. لا توصف النتيجة بأنها جولة كاملة خضراء واحدة.
2. الكتابة في المحرر الخارجي: الصواب قيمة واحدة مطابقة بعد الاستبدال، وعدم الإضافة عند إعادة القيمة؛ الفشل تكرار النص أو بقاء القيمة القديمة. الاختبار المحلي الآلي مثبت؛ لم تُلمس بيانات WhatsApp الحقيقية في هذه المتابعة.
3. التوجيه بعد انتهاء دور Codex: الصواب عودة زر إرسال وبقاء المسودة ثم إرسالها مرة واحدة بالنقرة التالية؛ الفشل بقاء وضع التوجيه أو فقدان المسودة أو الإرسال المكرر. يلزم موقف حقيقي، لا حقن رسالة ثم تسميتها قبول محرك.
4. الانهيار المتقطع: يبقى مفتوحاً؛ نحتاج أثر انهيار يحدد موضعه إذا تكرر، لا إعادة اختبارات ناجحة بلا فرضية جديدة.
5. اكتمل قياس عينتي القراءة والنماذج ومراجعة حراس الأذونات: ستة طلبات بأسباب متوقعة، و110 فحوص ناجحة. التفصيل والحدود في docs/internals/84-permission-metrics.md؛ لم تُغيّر السياسة ولم يثبت خفض المقاطعات.

القبول البشري مؤجل بطلب المالك؛ لا يُطلب منه تكرار ما ثبت في حراس البوابة أو لقطة فتح الطرفية الثانية.


## نتيجة التحقق المجمّع — 2026-09-22

شُغّل npm run test:full:evidence -- --quiet في PowerShell مستقلة عبر dist/combined-validation/run-full-suite.ps1. انتهت الجولة الأولى بعد 708797ms برمز 1: نجحت 148 من 152 مجموعة، وفشلت mobile وsend-liveness وfork-rewind وsdk-background. المرجع dist/test-runs/2026-09-21T22-31-43-273Z/summary.json وسجله، وعلامة full-suite.log.done تحمل 1. رمز غلاف الطرفية 0 لا يُعتد به بديلاً عن رمز الطقم الفعلي.

سبب الفشل أربع توقعات نصية قديمة لصيغة stopAll قبل إضافة مصدر الإيقاف. صُححت الحراس دون تغيير الإنتاج في هذه الجولة: تشغيل معالج IPC نفسه للتحقق من منع إيقاف المهمة المحجوزة وإلغاء الطلب المعلق وحفظ المهام الخلفية ومصدر الإيقاف وانتظار التنظيف؛ وتشغيل سباق الإرسال نفسه لإثبات أن انتهاء الإيقاف أو المهلة يكفي وحده. حارس الجوال يتحقق من الوسائط الفعلية في handleMobileStop. المنطق المشترك في scripts/lib/main-stop-handler-check.js.

أُعيدت المجموعات الأربع كاملة في term_24؛ خرجت جميعها برمز 0. السجل dist/combined-validation/retest-exits.log وملفات test-*.log المجاورة. طقم الجوال 9/9. لم يُعد الطقم الكامل بعد تغييرات الحراس، ولم تتغير ملفات الإنتاج بسبب هذه المعالجة. نجح git diff --check للملفات المعدلة في هذه المعالجة.

### إثبات الحراس بزرع الأعطال

نُفذت على نسخ تحت dist/combined-validation؛ لم تُزرع الأعطال في ملفات الإنتاج. أمر الزرع الفعلي fs.writeFileSync(file, source.replace(good, bad))، أو fs.writeFileSync(file, original.replace(good, bad)) لحارس IPC. أمر الاستعادة fs.writeFileSync(file, source)، أو fs.writeFileSync(file, original) لحارس IPC. سكربت اختبار الجوال المؤقت أُزيل عبر fs.unlinkSync(testFile). التقارير تحفظ good وbad والمسار وأمرَي الزرع والاستعادة والخرج الحرفي.

في الحالات السبع: الأصل 1→0، المتحور 0→1؛ كل اختبار خرج 1؛ وبعد الاستعادة الأصل 1 والمتحور 0. التقارير: mobile-bites/report.json وrenderer-stop-bites/report.json وsend-cap-bites/report.json داخل dist/combined-validation.

- الجوال: حذف المصدر، أو تحويل false إلى true؛ كلاهما: AssertionError [ERR_ASSERTION]: mobile stop must preserve background runs and record its source
- معالج الواجهة: حذف المصدر، أو تحويل false إلى true؛ كلاهما: AssertionError [ERR_ASSERTION]: renderer stop must cancel pending send, preserve background runs and record its source
- معالج الواجهة: استبدال await بـvoid؛ AssertionError [ERR_ASSERTION]: renderer stop must await cleanup
- سباق الإرسال: استبدال Promise.race بـPromise.all؛ AssertionError [ERR_ASSERTION]: send must continue when cap wins
- سباق الإرسال: حذف المصدر؛ AssertionError [ERR_ASSERTION]: new send must preserve background runs and record its stop source

صُححت أداة إثبات سباق الإرسال لتستخرج المقطع قبل فحص requestEpoch، لأن البحث عن Promise.race وحدها كان ينتقل إلى سباق لاحق بعد التحوير ويعطي فشلاً لسبب آخر. التقرير النهائي أعيد بعد التصحيح، وفشل Promise.all برسالة المهلة المطلوبة أعلاه. كذلك أُعيد إثبات حارس IPC بعد تصحيح عدّ نمط متداخل؛ لا تُحسب المحاولة السابقة دليلاً.

### فحص الحزمة المجمّعة

الأمر node scripts/packaged-terminal-probe.cjs dist/stability-combined-build/win-unpacked/Satr.exe؛ التجربة live_9df739d3bdad916417618a1b، بلا مصحح للعملية الرئيسية وببيئة وملف مستخدم معزولين. نجح خرج الطرفيتين وخروج كل صدفة على حدة واستجابة التطبيق بينهما ثم إغلاقه: completion.pass=true وcleanup=closed، وpackage-exit.code=0. لم يعد PID 25196 موجوداً بعد الفحص. أعيد التحقق من تطابق 14 ملفاً محدداً في verified-files.json مع المصدر بالبايت والبصمة، بنجاح.

تبقى النسخة المثبتة دون تحديث. القبول البشري المجمّع مؤجل بطلب المالك، وكذلك الاختبار الفعلي في WhatsApp وحالة التوجيه داخل دور Codex حقيقي. اكتمل تقرير عينتي أسباب الأذونات لاحقاً في docs/internals/84-permission-metrics.md. الانهيار المتقطع 0xC0000005 لم يُحسم؛ نجاح هذه الجولة لا يغلقه. لم تُرقّ node-pty، ولم يُجر commit.


### توقف الرد بعد الفحوص — بلاغ المالك 2026-09-22

أبلغ المالك أن الرد توقف مدة طويلة ثم ضغط الإيقاف ليطلب الاستكمال. الأدوات الأخيرة
عادت بنجاح، وآخر نص وعد بحفظ التقرير وإغلاق نافذة القياس ولم ينفذ الخطوتين قبل الإيقاف.
لا يثبت ذلك تعليق اختبار أو توقفاً ذاتياً من المحرك، ولا يُنسب إلى طرفية التجربة.
سبب توقف تدفق الرد غير محسوم؛ يلزم ربط أحداث الدور والبث بطابع وقت البلاغ.

### إيقاف أثناء مراجعة الإصدار — قياس 2026-09-22

أبلغ المالك عن توقف المتابعة، وأرفق لقطة تحمل «أوقف الدور» وأربع رسائل رفض توجيه
لدور انتهى. قراءة السجلين انتقت أنواع الأحداث وأوقاتها فقط؛ لم تنقل نصوص الأدوات.
الدور run-68200086-d174-46df-beeb-8bc72fd1db18 بدأ في 02:24:11.828Z، وسجله المحلي
stopped في 02:25:08.885Z بلا stopSource. آخر خرج أداة في سجل Codex كان
02:25:05.006Z، ثم turn_aborted reason=interrupted في 02:25:09.023Z. الفاصل
نحو 57 ثانية من بدء الدور، ونحو أربع ثوان من آخر خرج أداة؛ لا دليل في هذه النافذة
على انتظار أداة معلقة أو خطأ مزوّد. مصدر المقاطعة غير مثبت، ولا تُنسب إلى نقرة المالك.
الأثر المنقّح: dist/release-validation-20260922/interruption-audit.json، ومشغله المجاور
audit-interruption.cjs. النص الجزئي المحفوظ «بدأ الطقم فعلي» ليس جواباً نهائياً.

المهمة المستقلة term_41 استمرت بعد إيقاف الدور: نجح الطقم 152/152، ورمز الخروج 0،
من 02:24:53.646Z إلى 02:36:07.588Z، خلال 673942ms. الدليل
dist/test-runs/2026-09-22T02-24-53-646Z/summary.json، والخاتمة في
dist/release-validation-20260922/full-suite.log وعلامة .done. هذه جولة كاملة ناجحة
بعد الجولة السابقة 150/152؛ لا تحسم سبب تقطع UIA السابق أو انهيار الطرفية المتقطع.

### قبول الطرفية والإغلاق البشري — 2026-09-22

في الحزمة المعزولة live_a4eb42e9975f7061b120b58b أظهرت لقطتا المالك خرج
SATR-TERMINAL-READY ثم exit ورسالة انتهاء جلسة الطرفية، مع بقاء نافذة سطر.
أكد المالك استجابة تبويب الطرفية الآخر بعبارة «نعم يعمل .»، ثم أغلق نافذة التجربة
وأكد «تم الإغلاق بنجاح .». سجل package-exit.json رمز 0 في
2026-09-22T04:21:09.701Z؛ وانتهت term_43 برمز 0 ولم يعد PID 21588 موجوداً.
الدليل terminal-human-acceptance.json في جذر التجربة؛ الصور في المحادثة وليست
ملفات محلية. نجح خروج طرفية واحدة واستجابة النافذة وإغلاق التطبيق في هذه المحاولة؛
لم يثبت إصلاح سبب 0xC0000005 السابق. لا تغيير إنتاجي في هذه المحطة ولا إعادة للطقم.

### التقاط الانهيار محلياً واختبار تغيير الحجم — 2026-09-22

بحث WER المحلي وجد تقرير AppHangB1 للحزمة gate-recovery-build عند
2026-09-21T20:36:59.6930130Z؛ سبق حادثة الخروج 21:20:44.589Z، ولا يفسرها.
لم يوجد تفريغ dmp للحادثة الأصلية في مجلد تجربتها أو جذور تقارير Windows التي فُحصت.
ثنائيات node-pty الثلاثة في gate-recovery-build وacceptance-retry-build متطابقة
بـ SHA-256؛ نجاح الحزمة الأخيرة ليس ناتجاً عن استبدال هذا المكوّن.

أمر التشخيص المرئي: `node dist/release-validation-20260922/native-diagnostic.cjs`
(term_44، رمز 0). معايرة منفصلة live_57b94a2c4e4814b4e57e1a0b شغّلت
`process.crash()` عمداً داخل Electron معزول، بعدما ضبطت
`crashReporter.start({uploadToServer:false,ignoreSystemCrashHandler:true})`.
خرجت عملية المعايرة برمز 3221225477 وحفظت تفريغاً حجمه 34327632 بايت،
استثناء 0xc0000005 داخل electron.exe بإزاحة 0x3a3c00. هذه معايرة الالتقاط،
وليست تكراراً لعطل الطرفية أو دليلاً على سببه. التفريغ محلي ولم يُرفع.

القياس التالي live_1116a1f8b2f0dc9a947f5447 شغّل electron/term.js الإنتاجي
على Electron وnode-pty المثبتين: 48 طرفية، بحد 6 متزامنة، و4536 استدعاء تغيير
حجم، منها 2986 بعد وصول علامة الخرج. اكتمل خرج وخروج الطرفيات 48/48 ثم خرج
Electron برمز 0 بلا تفريغ. الدليل native-result.json وnative-exit.json في جذر
التجربة، والسجل native-stages.jsonl. لا واجهة في هذا القياس، ولا ضمان أن نافذة
السباق الأصلي وقعت رغم تداخل العمليات. ميزانية كل عملية 150 ثانية ولم تبلغ المهلة.

أمر الحزمة التشخيصية: `node dist/release-validation-20260922/package-crash-capture.cjs`
(term_45، رمز 0). أنشأ نسخة مستقلة dist/crash-capture-build/win-unpacked من
الحزمة المقبولة؛ تحقق من بقاء بصمة الأرشيف الأصلي ومن تطابق 1167 ملفاً. الفرق
الوحيد في المحتوى: مدخل bootstrap إضافي لتشغيل الالتقاط المحلي قبل main.js،
وتغيير حقل main في package.json إليه. ملف التدقيق
dist/release-validation-20260922/package-crash-capture-audit.json يحفظ البصمات.

التجربة live_db72728328f5352a467bbda4 أثبتت packaged=true وuploads=false في
profile/crash-capture-ready.json؛ ثم اجتازت فتح طرفيتين وخرجهما وخروج كل منهما
وبقاء المصيّر مستجيباً وإغلاق التطبيق برمز 0. completion.json يحمل pass=true،
وpackage-exit.json يثبت الخروج عند 2026-09-22T04:30:47.773Z. لم يتولد تفريغ.
هذا اختبار آلي لحزمة أضيف إليها التشخيص، وليس قبولاً بشرياً جديداً أو نسخة إصدار.

النتيجة: صار الالتقاط المحلي مثبتاً وجاهزاً لتكرار العطل، لكن السبب التاريخي بقي
غير محسوم. لا تعديل إنتاجي أو ترقية node-pty أو تغيير قفل، ولا طلب نموذج مدفوع،
ولا إعادة للطقم الكامل أو التزام أو دفع أو نشر. أُغلقت عمليات التجارب واحتُفظ
بالأدلة. لا تفيد إعادة السيناريو السليم نفسه بلا فرضية أو أثر جديد؛ الدليل الناقص
هو تفريغ عطل غير متعمد أو سيناريو يعيد إنتاجه، لا نقرة قبول أخرى من المالك.

## سباق الخروج المتزامن — 2026-09-22

أمر التشخيص `node dist/release-validation-20260922/native-diagnostic.cjs barrier-exit` (term_46) أعاد العطل: ست طرفيات تنتظر ملف حاجز واحد ثم تخرج بالتزامن مع تغيير الحجم. بعد ثلاث موجات ناجحة، انهار Electron في الرابعة برمز 3221225477 (`0xC0000005`)، دون بلوغ المهلة. التجربة `live_5359f8074ac423395e089ce8`؛ التفريغ `crash-dumps/reports/541c7527-b54d-40a4-be35-57f7ba31b5f3.dmp`، حجمه 135397600 بايت. العنوان `0x7ffd08d0301a` في `conpty.node+0x301a`. قراءة PDB المحلي بأداة native-symbol.py حددت `SetupExitCallback`، `conpty.cc:106`، عند `remove_pty_baton(baton->id)`. حُفظ الملخص في barrier-diagnostic-summary.json والرمز في barrier-crash-symbol.json بجوار STATUS.md.

الإصلاح الرسمي https://github.com/microsoft/node-pty/pull/922 يزامن الوصول إلى ptyHandles. السجل الرسمي وقت القياس: latest=1.1.0 وbeta=1.2.0-beta.15. أمر المقارنة `node dist/release-validation-20260922/native-diagnostic.cjs barrier-candidate` (term_47، live_2523d8d948b7a7d84cf93b32) نجح في 12 موجة و72 خروجاً بالنسخة المصححة، exit=0. ثُبّت الرقم التجريبي بدقة بأمر `npm.cmd install node-pty@1.2.0-beta.15 --save-exact --ignore-scripts --no-audit --no-fund`. النسخة القديمة حُفظت تحت dist/pty-candidate/original-1.1.0؛ لم تزد قائمة الاعتماديات.

### عضّة الحارس الدائم

الزرع الفعلي باستبدال اعتماد العملية المعزولة: `node scripts/pty-native-lifecycle-test.js --pty-package dist/pty-candidate/original-1.1.0`. عدد النسخ المختارة في خطة العملية: الأصل المصحح 1→0، المتحوّر القديم 0→1؛ pty-native-plan.json يثبت 1.1.0 في live_a198f53aa106af89203a1b60. سقط الحارس في term_48 برمز 1 بعد موجتين. الخرج الحرفي:

```text
PTY_NATIVE_CRASH: exit=4294930435

BARRIER_WAVE_PASS 1
BARRIER_WAVE_PASS 2
[23032:0922/074339.069:ERROR:crashpad_client_win.cc(868)] not connected

4294930435 !== 0
```

الاستعادة: `node scripts/pty-native-lifecycle-test.js`؛ يعود الاختيار الافتراضي دون تحرير ملفات الإنتاج. الأصل المصحح 0→1 والقديم 1→0؛ plan يثبت 1.2.0-beta.15 في live_6b6ac99fd47a8034ecd6fb11. term_49 خرج 0، 72/72 خرجاً سليماً، و5694 تغيير حجم، ثم خروج Electron نفسه 0. الخطط والأحداث والنتائج محفوظة في جذري التجربتين؛ التقرير المجمع pty-fix-bite.json.

حدود الإثبات: رمز انهيار العضّة الدائمة 4294930435 مختلف عن تفريغ التشخيص؛ لا نسميهما عنوان انهيار واحداً. الانهيار التاريخي الأول بلا تفريغ، فلا نزعم تطابق عنوانه. الاختبار توقيتي احتمالي، والبناء والطقم الكامل بعد الترقية لم يكتملَا وقت كتابة هذه المحطة. لا نقرات بشرية إضافية مطلوبة.

## اكتمال التحقق المحلي للإصدار 2.18.1

الطقم الجديد: 153/153، exit=0، بدأ 2026-09-22T04:47:37.793Z وانتهى 2026-09-22T04:59:51.034Z، ومدته 733241ms. المرجع `dist/test-runs/2026-09-22T04-47-37-793Z/summary.json`، وملف `dist/release-validation-20260922/pty-fix-full-suite.log.done` يحمل 0. أُجري بعد تثبيت node-pty المصحح ورفع النسخة؛ شمل الحارس الجديد دون إضافة إعادة تلقائية له.

بُنيت `dist/pty-fix-build/win-unpacked/Satr.exe` بأمر `npm run dist:dir -- --config.directories.output=dist/pty-fix-build` (term_50، exit=0). اجتازت مسار exit في live_1009c942d157ab9b682f55a3 (term_52) ومسار kill في live_1ab8e04e15b80fdfaf0d906f (term_53): فتح طرفيتين وخرجهما، ثم بقاء الواجهة مستجيبة بعد إنهاء كل منهما وإغلاق التطبيق 0. المسبار `scripts/packaged-terminal-probe.cjs`؛ هذه تجربة آلية للحزمة وليست قبولاً بشرياً جديداً.

تدقيق pty-fix-package-audit.json طابق 181 ملف تشغيل وإعداد package.json بعد التطبيع؛ pty-fix-native-audit.json طابق conpty.node وconpty_console_list.node وOpenConsole.exe وconpty.dll مع المصدر المثبت، وأثبت node-pty=1.2.0-beta.15 داخل الحزمة. نجح git diff --check. القبول البشري السابق باقٍ بنطاقه وحدوده؛ لا طلبات نموذج مدفوعة في جولة الترقية. التالي بعد هذه المحطة: الالتزام وطلب الدمج وفحوص GitHub ثم وسم الإصدار؛ لم تُعلن نتيجة نشر بعد.

## تصحيح مانعَي CI قبل الدمج

في طلب #166 نجح تحقق ويندوز وفشلت بوابة لينكس (run 35689043733): test:observations رفض مراجع OBS-215/217/220 المحلية غير الموجودة في تاريخ GitHub بعد squash؛ تحققت مطابقة ملفات Kimi بين acc4799 و523d1e5، ورسالة الدمج العام #165 تتضمن دفعة القراءة والأبعاد. أضيف المرجع العام 523d1e5 مع إبقاء الأرقام التاريخية، دون تخفيف الحارس أو تغيير حالات الملاحظات.

test:preview-popups تجاوز 240 ثانية بعد حارسه النقي؛ غلاف الاختبار كان يحذف DISPLAY وXAUTHORITY من بيئة Electron رغم تشغيل الطقم تحت xvfb. أضيف المتغيران إلى قائمة البيئة المسموحة، وحُسمت مهلة الطفل المملوك بـSIGKILL كي لا ينتظر spawnSync خروج عملية لا تستجيب لـSIGTERM. لا تعديل لإنتاج المعاينة ولا تخطٍّ للاختبار. يلزم إثبات التصحيح بجولة CI التالية.

أُعيد الحارسان محلياً في term_55: سجل الملاحظات 2154 فحصاً، والنوافذ المنبثقة 76 فحصاً حياً مع الحارس النقي، exit=0. الدليل `dist/popup-implementation/live-1790053998190.json`. لم تتغير ملفات الإنتاج أو الحزمة بسبب هذا التصحيح.
