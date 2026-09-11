# OBS-147 — أدلة إعادة الإنتاج والإصلاح (2026-09-09)

## النتيجة والنطاق

يعني نجاح HTTP إيداع أمر الإيقاف فقط. ينتظر الهاتف نتيجة معمّاة من الحاسوب، مرتبطة
بـ `command_id` و`run`، وينشر الحاسوب `stopped` بعد `done` للتشغيل الملتقط.
لا يُستنتج ذلك من `stopAll` أو `proc_done`؛ كلاهما قد يسبق انتهاء التنفيذ والتنظيف.
فوات المهلة أو غياب وعد موثوق أو فشل التنظيف ينتج `unknown`، وتبدّل المالك ينتج
`stale_run`. تشغيل A لا يبدّل حالة B، حتى لو احتُفظ برمز الدور نفسه في الاختبار
وتغيّر رقم الملكية الداخلي.

لا يتغير عقد IPC أو الإصدار أو حقول لقطة الحالة الأحد عشر. تغيّر عقد رسائل الجوال
بإضافة إقرار مستقل محدود، مع قبول طلب الإيقاف القديم بلا `command_id`.
رفعت مراجعة قشرة PWA إلى `satr-pwa-v14` حتى لا تبقى رسالة النجاح القديمة في الكاش.
هذا ليس تغييراً لإصدار التطبيق.

`stopAll(false)` يبقى مسار الإيقاف: يحافظ على سجل SDK الخلفي المنفصل؛
المهام الخلفية التابعة للتشغيل الجاري نفسه تتوقف معه بالسلوك السابق.
لا تعني الرسالة «إيقاف كل الأعمال على الحاسوب».

## إعادة الإنتاج قبل الإصلاح

`node scripts/mobile-stop-confirmation-test.js` شغّل دالتَي الإنتاج
`stopAgent` و`handleMobileStop` المستخرجتين من المصدر داخل VM.
النقل فقط مضبوط ليعيد HTTP 202، وإكمال الدور وعد يمكن تأخيره.
خرج برمز `1`، وفشل الطرفان حرفياً:

```text
AssertionError [ERR_ASSERTION]: OBS-147: HTTP 202 was reported as desktop stop completion
AssertionError [ERR_ASSERTION]: OBS-147: desktop published stopped before run.done
```

هذه إعادة إنتاج آلية لمنطق الطرفين، وليست تجربة هاتف على شبكة الإنترنت.

## الحراس المتصلة بالطقم

- `scripts/mobile-stop-confirmation-test.js`: 15 سيناريو إنتاجياً؛ يثبت الانتظار،
  المهل، خطأ التعمية، فقدان رد HTTP مع وصول الإقرار لاحقاً، تكرار الأمر للدور نفسه،
  تبدّل التشغيل، وعدم حجب بطاقة الإذن للاستقصاء أو طمس النتيجة بدورة جديدة.
  يراجع أيضاً صدق رسالة الاشتراك: جاهزية اشتراك المتصفح وإرساله لا تثبت حفظه
  في الحاسوب أو وصول Web Push.
- `scripts/mobilecommands-test.js`: 54 فحصاً لمنطق النقلين مع تعمية الإنتاج.
  [أدلة النقل والعضّات الثلاث](OBS-147-TRANSPORT-EVIDENCE.md).
- `scripts/engine-stop-done-test.js`: 7 سيناريوهات لدورة الحياة.
  Codex يعمل فوق app-server محلي تجريبي بلا حساب، وKimi فوق ACP محقون.
  [أدلة المحركات والعضّات الأربع](OBS-147-ENGINE-EVIDENCE.md).
- الحراس الثلاثة تُستدعى من `test:mobile-integration` الموجود في `test:mobile`
  ثم `test:full`؛ لا اعتماد على تذكّر تشغيلها منفردة.
- حارس DOM في `scripts/pwa-dom-live-test.js` يحمّل قشرة الإنتاج ويمرّر
  الأطر عبر WebCrypto و`pollLoop` والرسم الفعلي داخل Chromium؛ [أدلة DOM والعضّة](OBS-147-DOM-EVIDENCE.md).

البحث في الحراس كشف تأكيداً قديماً بأن «قبول الإيقاف يطلق stopped» في
`mobilerelay-test.js`، وحداً نصياً قصيراً لجسم `handleMobileStop` في
`mobile-integration-test.js`. صُحّح معنى الأول إلى التأكيد، ويُختبر توقيته سلوكياً؛
والثاني يفحص جسم دالة الإنتاج المستخرجة بدلاً من حدّ أحرف يتغير بطول الإصلاح.

## عرف العضّة — حارس الطرفين

المشغّل التالي كُتب في `dist/obs147-bite.js` خارج الملفات المتتبعة.
لا يستعيد ملفاً من Git: يستبدل موضعاً واحداً، ويقارن SHA-256 بالنسخة السابقة
للزرع قبل الاستعادة. يحفظ تعديلات OBS-148 والتوصيلات الموجودة.

```javascript
'use strict';
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const root=path.resolve(__dirname,'..');
const bites=[
  {
    "label": "early-desktop",
    "file": "electron/main.js",
    "original": "mobileDebug('stop_accepted');",
    "mutant": "publishMobileState({ phase: 'stopped' }); // OBS147_BITE_EARLY"
  },
  {
    "label": "old-owner",
    "file": "electron/main.js",
    "original": "if (owner !== runSeq || run !== mobileRunToken) status = 'stale_run';",
    "mutant": "if (false) status = 'stale_run'; // OBS147_BITE_OWNER"
  },
  {
    "label": "http-success",
    "file": "pwa/app.js",
    "original": "if (state.currentRun === run) setStatus('أُرسل أمر الإيقاف — بانتظار تأكيد الحاسوب.');",
    "mutant": "if (state.currentRun === run) { hideCard(); setStatus('أُرسل أمر الإيقاف — أوقف سطح المكتب الدور.'); }"
  },
  {
    "label": "command-match",
    "file": "pwa/app.js",
    "original": "if (!result || !request || result.command_id !== request.command_id || result.run !== request.run) return;",
    "mutant": "if (!result || !request) return; // OBS147_BITE_COMMAND"
  },
  {
    "label": "poll-permission",
    "file": "pwa/app.js",
    "original": "if (pendingStop && pendingStop.run === envelope.run) {",
    "mutant": "if (false) { // OBS147_BITE_POLL"
  }
];
const [mode,id]=process.argv.slice(2), bite=bites[Number(id)];
if(!bite||!['plant','restore'].includes(mode))throw Error('invalid_action');
const file=path.join(root,bite.file), before=fs.readFileSync(file,'utf8');
const count=(s,p)=>s.split(p).length-1;
const hash=s=>crypto.createHash('sha256').update(s).digest('hex');
const original=bite.original, mutant=bite.mutant;
const receipt=path.join(__dirname,'obs147-bite-'+id+'.json');
console.log('before original='+count(before,original)+' mutant='+count(before,mutant));
if(mode==='plant'){
  if(count(before,original)!==1||count(before,mutant)!==0)throw Error('plant_anchor');
  fs.writeFileSync(receipt,JSON.stringify({sha256:hash(before)}));
  fs.writeFileSync(file,before.replace(original,mutant));
}else{
  if(count(before,original)!==0||count(before,mutant)!==1)throw Error('restore_anchor');
  const restored=before.replace(mutant,original);
  if(hash(restored)!==JSON.parse(fs.readFileSync(receipt,'utf8')).sha256)throw Error('restore_digest_mismatch');
  fs.writeFileSync(file,restored);
}
const after=fs.readFileSync(file,'utf8');
console.log('after original='+count(after,original)+' mutant='+count(after,mutant));
console.log('sha256='+hash(after));

```

### العضّة 1: early-desktop

أمر الزرع كما نُفّذ:

```powershell
node dist/obs147-bite.js plant 0
```

العدّ الفعلي:

```text
before original=1 mutant=0
after original=0 mutant=1
sha256=1ef05ff35b25ef119f90aec6d9e0f833cb7f9ea9334ee708b79364885ab732b2
```

الاختبار: `node scripts/mobile-stop-confirmation-test.js` — رمز الخروج `1`.
الخرج الحرفي:

```text
mobile-stop-confirmation: ok relay-202-is-not-confirmation
AssertionError [ERR_ASSERTION]: OBS-147: desktop published stopped before run.done
+ actual - expected

+ [
+   {
+     phase: 'stopped'
+   }
+ ]
- []

    at D:\sater\satr-2\scripts\mobile-stop-confirmation-test.js:115:12
    at check (D:\sater\satr-2\scripts\mobile-stop-confirmation-test.js:96:17)
    at testMobileStopConfirmation (D:\sater\satr-2\scripts\mobile-stop-confirmation-test.js:111:9)
AssertionError [ERR_ASSERTION]: OBS-147: late stop A changed B
+ actual - expected

+ [
+   {
+     phase: 'stopped'
+   }
+ ]
- []

    at D:\sater\satr-2\scripts\mobile-stop-confirmation-test.js:137:14
    at async check (D:\sater\satr-2\scripts\mobile-stop-confirmation-test.js:96:11)
    at async testMobileStopConfirmation (D:\sater\satr-2\scripts\mobile-stop-confirmation-test.js:126:3)
AssertionError [ERR_ASSERTION]: OBS-147: uncertain stop published stopped
+ actual - expected

+ [
+   {
+     phase: 'stopped'
+   }
+ ]
- []

    at D:\sater\satr-2\scripts\mobile-stop-confirmation-test.js:153:14
    at async check (D:\sater\satr-2\scripts\mobile-stop-confirmation-test.js:96:11)
    at async testMobileStopConfirmation (D:\sater\satr-2\scripts\mobile-stop-confirmation-test.js:141:3)
AssertionError [ERR_ASSERTION]: Expected values to be strictly deep-equal:
+ actual - expected

+ [
+   {
+     phase: 'stopped'
+   }
+ ]
- []

    at D:\sater\satr-2\scripts\mobile-stop-confirmation-test.js:169:12
    at async check (D:\sater\satr-2\scripts\mobile-stop-confirmation-test.js:96:11)
    at async testMobileStopConfirmation (D:\sater\satr-2\scripts\mobile-stop-confirmation-test.js:158:3)
AssertionError [ERR_ASSERTION]: OBS-147: proc_done bypassed pending stop confirmation
+ actual - expected

+ [
+   {
+     phase: 'stopped'
+   }
+ ]
- []

    at D:\sater\satr-2\scripts\mobile-stop-confirmation-test.js:182:12
    at check (D:\sater\satr-2\scripts\mobile-stop-confirmation-test.js:96:17)
    at testMobileStopConfirmation (D:\sater\satr-2\scripts\mobile-stop-confirmation-test.js:176:9)
mobile-stop-confirmation: ok phone-seal-failure-is-reported
mobile-stop-confirmation: ok phone-requires-matching-command-and-run
mobile-stop-confirmation: ok phone-old-ack-cannot-change-new-run
mobile-stop-confirmation: ok phone-retry-rejects-old-command-same-run
mobile-stop-confirmation: ok phone-timeout-stale-and-unknown-stay-honest
mobile-stop-confirmation: ok phone-lost-http-response-still-accepts-confirmation
mobile-stop-confirmation: ok phone-late-http-cannot-overwrite-ack-or-B
mobile-stop-confirmation: ok phone-poll-keeps-reading-until-command-result
mobile-stop-confirmation: ok push-202-reports-only-subscription-sent
AssertionError [ERR_ASSERTION]: OBS-147: confirmation scenarios failed

5 !== 0

    at testMobileStopConfirmation (D:\sater\satr-2\scripts\mobile-stop-confirmation-test.js:349:10)
```

أمر الاستعادة كما نُفّذ:

```powershell
node dist/obs147-bite.js restore 0
```

```text
before original=0 mutant=1
after original=1 mutant=0
sha256=f1c3a512c712e003615cad7627a45385574c9d95199f6fd0975ab9402209ee3d
```

### العضّة 2: old-owner

أمر الزرع كما نُفّذ:

```powershell
node dist/obs147-bite.js plant 1
```

العدّ الفعلي:

```text
before original=1 mutant=0
after original=0 mutant=1
sha256=9ea62d50b86c419e6809bb466d0e1f4c74bf0fce917505fa0b03436d952343a3
```

الاختبار: `node scripts/mobile-stop-confirmation-test.js` — رمز الخروج `1`.
الخرج الحرفي:

```text
mobile-stop-confirmation: ok relay-202-is-not-confirmation
mobile-stop-confirmation: ok main-waits-for-owner-done
AssertionError [ERR_ASSERTION]: Expected values to be strictly deep-equal:
+ actual - expected

  [
+   'stopped'
-   'stale_run'
  ]

    at D:\sater\satr-2\scripts\mobile-stop-confirmation-test.js:136:14
    at async check (D:\sater\satr-2\scripts\mobile-stop-confirmation-test.js:96:11)
    at async testMobileStopConfirmation (D:\sater\satr-2\scripts\mobile-stop-confirmation-test.js:126:3)
mobile-stop-confirmation: ok main-unknown-is-not-stopped
mobile-stop-confirmation: ok main-starting-and-repeated-stop
mobile-stop-confirmation: ok main-result-cannot-bypass-pending-stop
mobile-stop-confirmation: ok phone-seal-failure-is-reported
mobile-stop-confirmation: ok phone-requires-matching-command-and-run
mobile-stop-confirmation: ok phone-old-ack-cannot-change-new-run
mobile-stop-confirmation: ok phone-retry-rejects-old-command-same-run
mobile-stop-confirmation: ok phone-timeout-stale-and-unknown-stay-honest
mobile-stop-confirmation: ok phone-lost-http-response-still-accepts-confirmation
mobile-stop-confirmation: ok phone-late-http-cannot-overwrite-ack-or-B
mobile-stop-confirmation: ok phone-poll-keeps-reading-until-command-result
mobile-stop-confirmation: ok push-202-reports-only-subscription-sent
AssertionError [ERR_ASSERTION]: OBS-147: confirmation scenarios failed

1 !== 0

    at testMobileStopConfirmation (D:\sater\satr-2\scripts\mobile-stop-confirmation-test.js:349:10)
```

أمر الاستعادة كما نُفّذ:

```powershell
node dist/obs147-bite.js restore 1
```

```text
before original=0 mutant=1
after original=1 mutant=0
sha256=f1c3a512c712e003615cad7627a45385574c9d95199f6fd0975ab9402209ee3d
```

### العضّة 3: http-success

أمر الزرع كما نُفّذ:

```powershell
node dist/obs147-bite.js plant 2
```

العدّ الفعلي:

```text
before original=1 mutant=0
after original=0 mutant=1
sha256=d9235c8c8777504cadf1bbe5db6af3cc283341412e16ed010298c8dab91b2364
```

الاختبار: `node scripts/mobile-stop-confirmation-test.js` — رمز الخروج `1`.
الخرج الحرفي:

```text
AssertionError [ERR_ASSERTION]: OBS-147: HTTP 202 was reported as desktop stop completion
    at D:\sater\satr-2\scripts\mobile-stop-confirmation-test.js:104:12
    at async check (D:\sater\satr-2\scripts\mobile-stop-confirmation-test.js:96:11)
    at async testMobileStopConfirmation (D:\sater\satr-2\scripts\mobile-stop-confirmation-test.js:100:3)
mobile-stop-confirmation: ok main-waits-for-owner-done
mobile-stop-confirmation: ok main-stale-token-and-generation
mobile-stop-confirmation: ok main-unknown-is-not-stopped
mobile-stop-confirmation: ok main-starting-and-repeated-stop
mobile-stop-confirmation: ok main-result-cannot-bypass-pending-stop
mobile-stop-confirmation: ok phone-seal-failure-is-reported
AssertionError [ERR_ASSERTION]: The expression evaluated to a falsy value:

  assert.ok(phone.state.currentEnvelope)

    at D:\sater\satr-2\scripts\mobile-stop-confirmation-test.js:213:12
    at async check (D:\sater\satr-2\scripts\mobile-stop-confirmation-test.js:96:11)
    at async testMobileStopConfirmation (D:\sater\satr-2\scripts\mobile-stop-confirmation-test.js:203:3)
mobile-stop-confirmation: ok phone-old-ack-cannot-change-new-run
AssertionError [ERR_ASSERTION]: The expression evaluated to a falsy value:

  assert.ok(phone.state.currentEnvelope)

    at D:\sater\satr-2\scripts\mobile-stop-confirmation-test.js:241:12
    at async check (D:\sater\satr-2\scripts\mobile-stop-confirmation-test.js:96:11)
    at async testMobileStopConfirmation (D:\sater\satr-2\scripts\mobile-stop-confirmation-test.js:233:3)
AssertionError [ERR_ASSERTION]: timeout: لم يتأكد انتهاء الدور
    at D:\sater\satr-2\scripts\mobile-stop-confirmation-test.js:251:14
    at async check (D:\sater\satr-2\scripts\mobile-stop-confirmation-test.js:96:11)
    at async testMobileStopConfirmation (D:\sater\satr-2\scripts\mobile-stop-confirmation-test.js:244:3)
mobile-stop-confirmation: ok phone-lost-http-response-still-accepts-confirmation
mobile-stop-confirmation: ok phone-late-http-cannot-overwrite-ack-or-B
mobile-stop-confirmation: ok phone-poll-keeps-reading-until-command-result
mobile-stop-confirmation: ok push-202-reports-only-subscription-sent
AssertionError [ERR_ASSERTION]: OBS-147: confirmation scenarios failed

4 !== 0

    at testMobileStopConfirmation (D:\sater\satr-2\scripts\mobile-stop-confirmation-test.js:349:10)
```

أمر الاستعادة كما نُفّذ:

```powershell
node dist/obs147-bite.js restore 2
```

```text
before original=0 mutant=1
after original=1 mutant=0
sha256=f178b1f87d676477bfdaa758d0f604935d3e5830560a86cd4b02c7a3dfe345f5
```

### العضّة 4: command-match

أمر الزرع كما نُفّذ:

```powershell
node dist/obs147-bite.js plant 3
```

العدّ الفعلي:

```text
before original=1 mutant=0
after original=0 mutant=1
sha256=ef317afa201f8dd1df3b782bbad99eedc7d9b5babb2e3861cc8a77e2da45d9a7
```

الاختبار: `node scripts/mobile-stop-confirmation-test.js` — رمز الخروج `1`.
الخرج الحرفي:

```text
mobile-stop-confirmation: ok relay-202-is-not-confirmation
mobile-stop-confirmation: ok main-waits-for-owner-done
mobile-stop-confirmation: ok main-stale-token-and-generation
mobile-stop-confirmation: ok main-unknown-is-not-stopped
mobile-stop-confirmation: ok main-starting-and-repeated-stop
mobile-stop-confirmation: ok main-result-cannot-bypass-pending-stop
mobile-stop-confirmation: ok phone-seal-failure-is-reported
AssertionError [ERR_ASSERTION]: OBS-147: unrelated acknowledgement settled stop
+ actual - expected

+ null
- {
-   command_id: '82b84f472714f56f',
-   run: 'aaaaaaaaaaaaaaaa',
-   timer: [Function (anonymous)]
- }

    at D:\sater\satr-2\scripts\mobile-stop-confirmation-test.js:212:12
    at async check (D:\sater\satr-2\scripts\mobile-stop-confirmation-test.js:96:11)
    at async testMobileStopConfirmation (D:\sater\satr-2\scripts\mobile-stop-confirmation-test.js:203:3)
mobile-stop-confirmation: ok phone-old-ack-cannot-change-new-run
AssertionError [ERR_ASSERTION]: OBS-147: old command acknowledgement settled retry
    at D:\sater\satr-2\scripts\mobile-stop-confirmation-test.js:240:12
    at async check (D:\sater\satr-2\scripts\mobile-stop-confirmation-test.js:96:11)
    at async testMobileStopConfirmation (D:\sater\satr-2\scripts\mobile-stop-confirmation-test.js:233:3)
mobile-stop-confirmation: ok phone-timeout-stale-and-unknown-stay-honest
mobile-stop-confirmation: ok phone-lost-http-response-still-accepts-confirmation
mobile-stop-confirmation: ok phone-late-http-cannot-overwrite-ack-or-B
mobile-stop-confirmation: ok phone-poll-keeps-reading-until-command-result
mobile-stop-confirmation: ok push-202-reports-only-subscription-sent
AssertionError [ERR_ASSERTION]: OBS-147: confirmation scenarios failed

2 !== 0

    at testMobileStopConfirmation (D:\sater\satr-2\scripts\mobile-stop-confirmation-test.js:349:10)
```

أمر الاستعادة كما نُفّذ:

```powershell
node dist/obs147-bite.js restore 3
```

```text
before original=0 mutant=1
after original=1 mutant=0
sha256=f178b1f87d676477bfdaa758d0f604935d3e5830560a86cd4b02c7a3dfe345f5
```

### العضّة 5: poll-permission

أمر الزرع كما نُفّذ:

```powershell
node dist/obs147-bite.js plant 4
```

العدّ الفعلي:

```text
before original=1 mutant=0
after original=0 mutant=1
sha256=8ac3699409e1dbe1b9a77d4162b5be254b7d13b1aa34d1ede959cb84815ae6d1
```

الاختبار: `node scripts/mobile-stop-confirmation-test.js` — رمز الخروج `1`.
الخرج الحرفي:

```text
mobile-stop-confirmation: ok relay-202-is-not-confirmation
mobile-stop-confirmation: ok main-waits-for-owner-done
mobile-stop-confirmation: ok main-stale-token-and-generation
mobile-stop-confirmation: ok main-unknown-is-not-stopped
mobile-stop-confirmation: ok main-starting-and-repeated-stop
mobile-stop-confirmation: ok main-result-cannot-bypass-pending-stop
mobile-stop-confirmation: ok phone-seal-failure-is-reported
mobile-stop-confirmation: ok phone-requires-matching-command-and-run
mobile-stop-confirmation: ok phone-old-ack-cannot-change-new-run
mobile-stop-confirmation: ok phone-retry-rejects-old-command-same-run
mobile-stop-confirmation: ok phone-timeout-stale-and-unknown-stay-honest
mobile-stop-confirmation: ok phone-lost-http-response-still-accepts-confirmation
mobile-stop-confirmation: ok phone-late-http-cannot-overwrite-ack-or-B
AssertionError [ERR_ASSERTION]: OBS-147: permission card prevented stop acknowledgement polling

1 !== 3

    at D:\sater\satr-2\scripts\mobile-stop-confirmation-test.js:314:12
    at async check (D:\sater\satr-2\scripts\mobile-stop-confirmation-test.js:96:11)
    at async testMobileStopConfirmation (D:\sater\satr-2\scripts\mobile-stop-confirmation-test.js:292:3)
mobile-stop-confirmation: ok push-202-reports-only-subscription-sent
AssertionError [ERR_ASSERTION]: OBS-147: confirmation scenarios failed

1 !== 0

    at testMobileStopConfirmation (D:\sater\satr-2\scripts\mobile-stop-confirmation-test.js:349:10)
```

أمر الاستعادة كما نُفّذ:

```powershell
node dist/obs147-bite.js restore 4
```

```text
before original=0 mutant=1
after original=1 mutant=0
sha256=f178b1f87d676477bfdaa758d0f604935d3e5830560a86cd4b02c7a3dfe345f5
```

## التحقق النهائي وحدود القبول

- `npm run test:mobile`: نجح 9/9 برمز 0؛ relay=203 وintegration=291، فوقها 15 سيناريو للتأكيد و54 للنقل و7 لدورة الحياة، وDOM=70.
- `npm run test:sdk-background`: نجح برمز 0، بما فيه سيناريوهات OBS-148 السبعة.
- اختبارات Kimi وCodex contract نجحت في تحقق المحركات الموضح في دليلها.
- `node --check` لملفات الإنتاج المعدلة، و`git diff --check`: نجحا.
- `npm start -- --user-data-dir=D:\sater\satr-2\dist\obs147-smoke-profile --enable-logging=stderr`: أقلع من المصدر بنافذة «سطر — Satr»، PID=10276. لم يُرسل دور أو تُستعمل بيانات حساب.
- بصمة main النهائية `sha256:ed98d3eb29a7fece8381c15df6db21af3d64327e34dabc1b6958102dd8f24a5b`؛ اختلفت عن بصمة الاستعادة أعلاه بتصحيح التعليق عن التأكيد فقط.

لا تجربة هاتف بشري أو وسيط منشور أو حساب محرك حي أو Web Push. الحارس يرصد نص DOM وظهور البطاقة والعدادات، لا بكسلات أو اتجاه RTL. لم يتغير CSS أو هيكل الواجهة، ولا فجوة رسم مستجدة يُستنتج إغلاقها؛ وفق satr-accept حُوّل ما يمكن إثباته آلياً إلى حارس، ولا يُسجّل ذلك قبولاً بشرياً.

لم يُعد `test:full`؛ نتيجته السابقة `102/103` برمز 1 باقية. نجاح العزل لا يثبت سببها، والتشخيص الجديد موثق في [أدلة التعثر](SUITE-TIMEOUT-EVIDENCE.md).

- `npm run test:observations`: نجح بـ1446 فحصاً بعد استكمال حقل الدليل ومرجع
  SHA-256 للنسخة غير الملتزمة. سقط أولاً لنقص هذين الحقلين؛ لم يُغيّر الحارس.
- `npm run test:kimi-keepalive` و`npm run test:codex-steer`: نجحا برمز 0.
- أُوقفت نسخة فحص الإقلاع وحدها (`term_27`، رمز 2 بعد `^C` متعمد)، وتحقق
  خروج عمليتها، ثم حُذف `dist/obs147-smoke-profile` بعد التحقق من المسار.
  بقيت نسخة قبول التوصيلات `term_25` وبيئتها كما هما.
