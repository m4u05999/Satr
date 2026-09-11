# OBS-147 — أدلة نقل نتائج أوامر الإيقاف

تاريخ التنفيذ: 2026-09-09. هذا تقرير النواة المشتركة والنقلين وحارسهما، ضمن إصلاح OBS-147.

## ما تغير

- `electron/mobilecommands.js`: طلب مغلق `{type:"stop",run,command_id}`؛ المعرّفان 16 خانة hex صغيرة. يقبل الطلب القديم بلا `command_id` دون إرسال نتيجة جديدة.
- `dispatchStop(payload,onStop,onResult)` يمرّر `onStop(run,report)` ويعيد قبول الأمر مزامنةً. `report(status)` يحسم مرة واحدة فقط؛ لا ينتج القبول نفسه نجاحاً. الرفض يعيد `stale_run`، والاستثناء `unknown`، والحالة غير المعروفة تُطوى إلى `unknown`.
- إطار النتيجة مغلق: `{v:1,type:"command_result",command_id,run,status}` حيث `status` من `stopped|stale_run|unknown`. تُنسخ هوية الطلب قبل استدعاء المنفّذ، فلا يبدّلها تعديل الكائن لاحقاً.
- `electron/mobilelink.js`: طابور نتائج مستقل بحد أربعة لكل جهاز وTTL مقداره 60000ms. يُنقّى عند الوصول، وتسبق نتيجته الإذن في `handlePoll` و`wakeWaiters`، ثم يعود الإذن إلى أولويته على الحالة.
- `electron/mobilerelay.js`: دفع مباشر إلى صندوق الجهاز صاحب الطلب. النقلان يستخدمان حجز العدادات والتعمية الموجودين في الإنتاج، ويرفضان تسليم نتيجة إلى جلسة اقتران استبدلت جلسة الطلب.

## ما اختُبر وحدوده

الحارس `scripts/mobilecommands-test.js` يستخرج `handleReply` و`handlePoll` و`wakeWaiters` ومعالجات النتائج من القناة المحلية، و`handleDeviceFrame` و`requestStop` و`sendCommandResult` من الوسيط. يشغّل هذه الدوال من ملفات الإنتاج مع `mobilecrypto` الحقيقية. HTTP والتخزين وساعة الاختبار محقونة؛ لا شبكة خارجية ولا قراءة لملفات اقتران المستخدم.

الفحوص تغطي شكل الطلب والنتيجة، توافق legacy، عدم نجاح الأمر قبل التقرير، التقرير المكرر والمتزامن، هوية الأمر الأصلية، الرفض والاستثناء، توجيه النتيجة لجهاز واحد، فشل فتحها بجهاز آخر، استبدال الاقتران وإبطاله، فشل حجز العدادات، أولوية النتيجة على الإذن، سقف الطابور وTTL.

النتيجة النهائية بعد الاستعادة: `node scripts/mobilecommands-test.js` خرج برمز `0`:

```text
mobilecommands: 54 checks passed
```

نجح `node --check` على الملفات الأربعة، و`git diff --check -- electron/mobilelink.js electron/mobilerelay.js` بلا إخراج وبرمز `0`.

هذا الحارس لا يثبت إغلاق محرك حقيقي أو عرض PWA أو وصول النتيجة إلى هاتف حي؛ أدلة منطق الحاسوب والهاتف والطقم المرتبط تُوثق في تقرير الإصلاح العام. لم يُشغّل الطقم الكامل من هذه المهمة.

## عرف العضّة — الأوامر والإخراج الحرفي

نُفّذت كل عضّة مستقلة بالترتيب: زرع في ملف الإنتاج، عدّ الأصل والمتحور، تشغيل الحارس، استعادة باستبدال دقيق. لم يُستخدم Git لاستعادة الملفات أو نسخ من HEAD. مقتطف الخطأ أدناه حرفي؛ حُذفت منه stack frames فقط.

### 1. الإعلان المبكر من النواة

الزرع كما نُفّذ:

```powershell
$OutputEncoding = [System.Text.UTF8Encoding]::new($false)
@'
const fs = require('node:fs');
const p = 'electron/mobilecommands.js';
const a = "else if (queuedStatus !== null) finish(queuedStatus);";
const b = "else finish(queuedStatus || 'stopped');";
const s = fs.readFileSync(p, 'utf8');
const count = (text, pattern) => text.split(pattern).length - 1;
console.log('before original=' + count(s,a) + ' mutant=' + count(s,b));
if (count(s,a) !== 1 || count(s,b) !== 0) throw Error('anchor_count');
fs.writeFileSync(p, s.replace(a,b));
const changed = fs.readFileSync(p, 'utf8');
console.log('after original=' + count(changed,a) + ' mutant=' + count(changed,b));
'@ | node
```

الإخراج:

```text
before original=1 mutant=0
after original=0 mutant=1
```

أمر الاختبار كما نُفّذ:

```powershell
node scripts/mobilecommands-test.js
```

خرج برمز `1`، ورسالة الفشل:

```text
AssertionError [ERR_ASSERTION]: قبول الأمر لا يصنع نتيجة توقف

1 !== 0
```

الاستعادة كما نُفّذت:

```powershell
$OutputEncoding = [System.Text.UTF8Encoding]::new($false)
@'
const fs = require('node:fs');
const p = 'electron/mobilecommands.js';
const a = "else if (queuedStatus !== null) finish(queuedStatus);";
const b = "else finish(queuedStatus || 'stopped');";
const s = fs.readFileSync(p, 'utf8');
if (s.split(a).length !== 1 || s.split(b).length !== 2) throw Error('restore_anchor_count');
fs.writeFileSync(p, s.replace(b,a));
const restored = fs.readFileSync(p, 'utf8');
console.log('restored original=' + (restored.split(a).length - 1) + ' mutant=' + (restored.split(b).length - 1));
'@ | node
```

```text
restored original=1 mutant=0
```

معرّفات مخرجات التنفيذ للزرع والفشل والاستعادة: `bd4a0b · 96109c · 0cf62b`.

### 2. تجاوز ملكية اقتران LAN

الزرع كما نُفّذ:

```powershell
$OutputEncoding = [System.Text.UTF8Encoding]::new($false)
@'
const fs = require('node:fs');
const p = 'electron/mobilelink.js';
const a = 'if (stopped || activeEntry(deviceId) !== entry) return false;';
const b = 'if (stopped) return false; // OBS147_BITE_LAN';
const s = fs.readFileSync(p, 'utf8');
const count = (text, pattern) => text.split(pattern).length - 1;
console.log('before original=' + count(s,a) + ' mutant=' + count(s,b));
if (count(s,a) !== 1 || count(s,b) !== 0) throw Error('anchor_count');
fs.writeFileSync(p, s.replace(a,b));
const changed = fs.readFileSync(p, 'utf8');
console.log('after original=' + count(changed,a) + ' mutant=' + count(changed,b));
'@ | node
```

الإخراج:

```text
before original=1 mutant=0
after original=0 mutant=1
```

أمر الاختبار كما نُفّذ:

```powershell
node scripts/mobilecommands-test.js
```

خرج برمز `1`، ورسالة الفشل:

```text
AssertionError [ERR_ASSERTION]: lan: نتيجة اقتران قديم لا تُرسل لاقتران جديد

1 !== 0
```

الاستعادة كما نُفّذت:

```powershell
$OutputEncoding = [System.Text.UTF8Encoding]::new($false)
@'
const fs = require('node:fs');
const p = 'electron/mobilelink.js';
const a = 'if (stopped || activeEntry(deviceId) !== entry) return false;';
const b = 'if (stopped) return false; // OBS147_BITE_LAN';
const s = fs.readFileSync(p, 'utf8');
if (s.split(a).length !== 1 || s.split(b).length !== 2) throw Error('restore_anchor_count');
fs.writeFileSync(p, s.replace(b,a));
const restored = fs.readFileSync(p, 'utf8');
console.log('restored original=' + (restored.split(a).length - 1) + ' mutant=' + (restored.split(b).length - 1));
'@ | node
```

```text
restored original=1 mutant=0
```

معرّفات مخرجات التنفيذ للزرع والفشل والاستعادة: `a7989d · fdb1f9 · 857293`.

### 3. تجاوز ملكية اقتران الوسيط

الزرع كما نُفّذ:

```powershell
$OutputEncoding = [System.Text.UTF8Encoding]::new($false)
@'
const fs = require('node:fs');
const p = 'electron/mobilerelay.js';
const a = 'if (stopped || activeSession(deviceId) !== entry) return false;';
const b = 'if (stopped) return false; // OBS147_BITE_RELAY';
const s = fs.readFileSync(p, 'utf8');
const count = (text, pattern) => text.split(pattern).length - 1;
console.log('before original=' + count(s,a) + ' mutant=' + count(s,b));
if (count(s,a) !== 1 || count(s,b) !== 0) throw Error('anchor_count');
fs.writeFileSync(p, s.replace(a,b));
const changed = fs.readFileSync(p, 'utf8');
console.log('after original=' + count(changed,a) + ' mutant=' + count(changed,b));
'@ | node
```

الإخراج:

```text
before original=1 mutant=0
after original=0 mutant=1
```

أمر الاختبار كما نُفّذ:

```powershell
node scripts/mobilecommands-test.js
```

خرج برمز `1`، ورسالة الفشل:

```text
AssertionError [ERR_ASSERTION]: relay: نتيجة اقتران قديم لا تُرسل لاقتران جديد

1 !== 0
```

الاستعادة كما نُفّذت:

```powershell
$OutputEncoding = [System.Text.UTF8Encoding]::new($false)
@'
const fs = require('node:fs');
const p = 'electron/mobilerelay.js';
const a = 'if (stopped || activeSession(deviceId) !== entry) return false;';
const b = 'if (stopped) return false; // OBS147_BITE_RELAY';
const s = fs.readFileSync(p, 'utf8');
if (s.split(a).length !== 1 || s.split(b).length !== 2) throw Error('restore_anchor_count');
fs.writeFileSync(p, s.replace(b,a));
const restored = fs.readFileSync(p, 'utf8');
console.log('restored original=' + (restored.split(a).length - 1) + ' mutant=' + (restored.split(b).length - 1));
'@ | node
```

```text
restored original=1 mutant=0
```

معرّفات مخرجات التنفيذ للزرع والفشل والاستعادة: `d3632e · 484969 · 237a28`.

الإعادة بعد الزرع الثالث واستعادة جميع الملفات أعطت `mobilecommands: 54 checks passed` برمز `0` (خرج `946ff4`).

أضيف لاحقاً تصدير `testMobileCommands` وحارس `require.main === module` لاستدعاء الفحوص ضمن `mobile-integration` دون تشغيلها عند الاستيراد. الإعادة المباشرة بعد التغليف أعطت `mobilecommands: 54 checks passed` برمز `0` (خرج `5274a7`). أمر الاستيراد أدناه أعطى `export: function` فقط، بلا تشغيل للفحوص وبرمز `0` (خرج `3ada99`):

```powershell
node -e "const { testMobileCommands } = require('./scripts/mobilecommands-test'); console.log('export:', typeof testMobileCommands);"
```
