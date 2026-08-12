/**
 * اختبارات قطعية لـ electron/mobiletls.js — بلا شبكة خارجية وبلا اعتماديات.
 *
 * الاختبار الحاكم هو الأول: مصافحة TLS حقيقية عبر `https` مع
 * `rejectUnauthorized:true` و`ca:[cert]` وتحقق هوية الخادم. شهادة تُبنى ولا
 * يقبلها TLS = فشل، مهما بدت بنية DER سليمة.
 *
 * العزل: يُستبدل `os.homedir` بمجلد مؤقت **قبل** استيراد الوحدة، فالمسار
 * الافتراضي `~/.satr/mobile-tls` يقع داخل بيت وهمي يُحذف في النهاية.
 */

'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const https = require('node:https');
const os = require('node:os');
const path = require('node:path');
const tls = require('node:tls');

const testHome = path.join(os.tmpdir(), 'satr-mobiletls-test-' + process.pid + '-' + Date.now());
const realHomedir = os.homedir;
os.homedir = () => testHome;

const mobiletls = require('../electron/mobiletls');

const LAN_IP = '192.168.7.31';
const DAY_MS = 24 * 60 * 60 * 1000;
const tlsDir = path.join(testHome, '.satr', 'mobile-tls');

let passed = 0;

function assert(condition, message) {
  if (condition) {
    passed += 1;
    return;
  }
  console.error('FAIL:', message);
  process.exitCode = 1;
}

function assertEqual(actual, expected, message) {
  if (actual === expected) {
    passed += 1;
    return;
  }
  console.error('FAIL:', message, '| expected', expected, '| got', actual);
  process.exitCode = 1;
}

function cleanup() {
  os.homedir = realHomedir;
  try {
    fs.rmSync(testHome, { recursive: true, force: true });
  } catch (error) {
    // نتجاهل — لا يؤثر على نتيجة الاختبار
  }
}

/** يسرد كل الملفات تحت جذر (للتحقق من عدم الكتابة خارج المجلد المسموح). */
function walk(root) {
  const out = [];
  const stack = [root];
  while (stack.length) {
    const current = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch (error) {
      continue;
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) stack.push(full);
      else out.push(full);
    }
  }
  return out;
}

/** يكتب حزمة شهادة إلى مجلد التخزين محاكياً حالة قرص سابقة. */
function writeBundle(bundle, overrides = {}) {
  fs.mkdirSync(tlsDir, { recursive: true });
  fs.writeFileSync(path.join(tlsDir, 'key.pem'), overrides.key !== undefined ? overrides.key : bundle.key, 'utf8');
  fs.writeFileSync(path.join(tlsDir, 'cert.pem'), overrides.cert !== undefined ? overrides.cert : bundle.cert, 'utf8');
  fs.writeFileSync(
    path.join(tlsDir, 'meta.json'),
    JSON.stringify({ v: 1, ip: bundle.ip, createdAt: bundle.createdAt, fingerprint: bundle.fingerprint }),
    'utf8'
  );
}

/** جسم المفتاح الخاص base64 بلا ترويسات — للبحث عن تسريبه في قيم أخرى. */
function keyBody(pem) {
  return pem
    .replace(/-----[^-]+-----/g, '')
    .replace(/\s+/g, '')
    .trim();
}

/**
 * بصمة نصية للمقارنة.
 * **مقصودة**: `assertEqual` يطبع الطرفين عند الفشل، فمقارنة PEM المفتاح
 * مباشرةً كانت تُسرّب مفتاحاً خاصاً إلى خرج الاختبار (وإلى سجل CI). المقارنة
 * على الملخّص تعطي التشخيص نفسه بلا مادة مفاتيح ولا ضجيج.
 */
function digest(text) {
  return crypto.createHash('sha256').update(String(text)).digest('hex').slice(0, 16);
}

/* ───────── 1) الاختبار الحاكم: مصافحة TLS حقيقية ───────── */

function tlsRoundTrip(bundle, connectHost, servername) {
  return new Promise((resolve, reject) => {
    const server = https.createServer({ key: bundle.key, cert: bundle.cert }, (req, res) => {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('satr-ok');
    });
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const options = {
        host: connectHost,
        port: server.address().port,
        path: '/',
        ca: [bundle.cert],
        rejectUnauthorized: true,
        // تحقق الهوية صريح: لا نكتفي بسلسلة الثقة بل نوجب مطابقة SAN
        checkServerIdentity: (host, cert) => tls.checkServerIdentity(host, cert)
      };
      if (servername) options.servername = servername;

      const request = https.get(options, (res) => {
        const authorized = res.socket.authorized;
        const peer = res.socket.getPeerCertificate();
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => {
          body += chunk;
        });
        res.on('end', () => {
          server.close(() => resolve({ authorized, peer, body, status: res.statusCode }));
        });
      });
      request.on('error', (error) => {
        server.close(() => reject(error));
      });
    });
  });
}

async function testRealTls() {
  const bundle = mobiletls.generateCert(LAN_IP);

  // (أ) اتصال على 127.0.0.1 — يثبت SAN ‏IP:127.0.0.1 والتحقق الكامل
  const loop = await tlsRoundTrip(bundle, '127.0.0.1', null);
  assertEqual(loop.body, 'satr-ok', 'TLS: طلب HTTPS كامل نجح على 127.0.0.1');
  assertEqual(loop.status, 200, 'TLS: رمز الحالة 200');
  assertEqual(loop.authorized, true, 'TLS: العميل اعتمد الشهادة مع rejectUnauthorized:true');

  // (ب) نفس الشهادة تجتاز تحقق الهوية لعنوان LAN الفعلي — دون ربط ذلك العنوان
  assertEqual(
    tls.checkServerIdentity(LAN_IP, loop.peer),
    undefined,
    'TLS: تحقق الهوية ينجح لعنوان LAN المطلوب'
  );
  // عنوان لم يُوقَّع عليه يجب أن يُرفض (وإلا فالتحقق صوري)
  assert(
    tls.checkServerIdentity('10.0.0.9', loop.peer) instanceof Error,
    'TLS: تحقق الهوية يرفض عنواناً خارج SAN'
  );
  assert(
    tls.checkServerIdentity('evil.test', loop.peer) instanceof Error,
    'TLS: تحقق الهوية يرفض اسم مضيف خارج SAN'
  );

  // (ج) اتصال بـSNI ‏localhost — يثبت SAN ‏DNS:localhost عبر مصافحة فعلية
  const named = await tlsRoundTrip(bundle, '127.0.0.1', 'localhost');
  assertEqual(named.body, 'satr-ok', 'TLS: مصافحة ثانية بـservername=localhost نجحت');
  assertEqual(named.authorized, true, 'TLS: هوية localhost معتمدة');

  // (د) شهادة أخرى لا تُعتمد كسلطة — يثبت أن الاعتماد ليس مفتوحاً
  const stranger = mobiletls.generateCert(LAN_IP);
  let rejected = null;
  try {
    await tlsRoundTrip({ key: bundle.key, cert: bundle.cert }, '127.0.0.1', null).then(() => null);
    await new Promise((resolve, reject) => {
      const server = https.createServer({ key: bundle.key, cert: bundle.cert }, (req, res) => res.end('x'));
      server.listen(0, '127.0.0.1', () => {
        https
          .get(
            { host: '127.0.0.1', port: server.address().port, path: '/', ca: [stranger.cert], rejectUnauthorized: true },
            () => server.close(() => resolve())
          )
          .on('error', (error) => {
            rejected = error;
            server.close(() => resolve());
          });
      });
      server.on('error', reject);
    });
  } catch (error) {
    rejected = error;
  }
  assert(rejected instanceof Error, 'TLS: شهادة غريبة كسلطة تُرفض (الاعتماد ليس مفتوحاً)');
}

/* ───────── 2) الأسماء البديلة ───────── */

function testSanPresence() {
  const bundle = mobiletls.generateCert(LAN_IP);
  const x509 = new crypto.X509Certificate(bundle.cert);
  const san = x509.subjectAltName || '';

  assert(san.includes(`IP Address:${LAN_IP}`), 'SAN: يحوي IP الخاص بالعنوان');
  assert(san.includes('IP Address:127.0.0.1'), 'SAN: يحوي IP:127.0.0.1');
  assert(san.includes('DNS:localhost'), 'SAN: يحوي DNS:localhost');
  assertEqual(x509.checkIP(LAN_IP), LAN_IP, 'SAN: checkIP يطابق عنوان LAN');
  assertEqual(x509.checkIP('127.0.0.1'), '127.0.0.1', 'SAN: checkIP يطابق العنوان المحلي');
  assertEqual(x509.checkHost('localhost'), 'localhost', 'SAN: checkHost يطابق localhost');

  // خصائص إلزامية أخرى
  assertEqual(x509.ca, false, 'basicConstraints: CA:FALSE');
  assert(x509.keyUsage && x509.keyUsage.includes('1.3.6.1.5.5.7.3.1'), 'extKeyUsage: serverAuth حاضر');
  assert(x509.verify(x509.publicKey), 'التوقيع الذاتي صحيح ويتحقق بالمفتاح العام نفسه');
  assert(x509.checkPrivateKey(crypto.createPrivateKey(bundle.key)), 'المفتاح الخاص يطابق الشهادة');
  assertEqual(x509.subject, x509.issuer, 'الموضوع والمُصدِر متطابقان (موقّعة ذاتياً)');

  const lifetime = Date.parse(x509.validTo) - Date.parse(x509.validFrom);
  assert(lifetime <= 398 * DAY_MS, 'الصلاحية ≤ 398 يوماً');
  assert(lifetime > 300 * DAY_MS, 'الصلاحية معقولة (> 300 يوم)');
  assert(Date.parse(x509.validFrom) <= Date.now(), 'notBefore ليس في المستقبل');

  // مفتاح EC P-256 كما ينصّ القرار الموثّق
  const details = x509.publicKey.asymmetricKeyDetails || {};
  assertEqual(x509.publicKey.asymmetricKeyType, 'ec', 'نوع المفتاح EC');
  assertEqual(details.namedCurve, 'prime256v1', 'المنحنى prime256v1 (‏P-256)');

  // البصمة: SHA-256 للـDER بصيغة عرض
  assert(/^([0-9A-F]{2}:){31}[0-9A-F]{2}$/.test(bundle.fingerprint), 'البصمة SHA-256 بصيغة AA:BB:…');
  const expected = crypto.createHash('sha256').update(x509.raw).digest('hex').toUpperCase();
  assertEqual(bundle.fingerprint.replace(/:/g, ''), expected, 'البصمة تساوي SHA-256 للشهادة فعلاً');

  // IPv6 يعمل أيضاً (لا يكسر ترميز SAN)
  const v6 = mobiletls.generateCert('fd12:3456:789a::5');
  const v6cert = new crypto.X509Certificate(v6.cert);
  assertEqual(v6cert.checkIP('fd12:3456:789a::5'), 'fd12:3456:789a::5', 'SAN: عنوان IPv6 مُرمَّز صحيحاً');
}

/* ───────── 3) إعادة الاستخدام وإعادة التوليد ───────── */

function testReuseAndRotation() {
  const first = mobiletls.ensureCert(LAN_IP);
  assertEqual(first.ip, LAN_IP, 'ensureCert يعيد العنوان المطلوب');

  // إعادة استخدام من الذاكرة
  const again = mobiletls.ensureCert(LAN_IP);
  assertEqual(again.fingerprint, first.fingerprint, 'إعادة استخدام الشهادة نفسها عند ثبات العنوان');

  // إعادة استخدام من **القرص** (بعد إسقاط الكاش) — الإثبات الحقيقي
  mobiletls.resetCache();
  const cold = mobiletls.ensureCert(LAN_IP);
  assertEqual(cold.fingerprint, first.fingerprint, 'إعادة استخدام من القرص بعد إسقاط الكاش (لا توليد كل مرة)');
  assertEqual(digest(cold.key), digest(first.key), 'المفتاح الخاص نفسه يُعاد من القرص');
  assertEqual(cold.createdAt, first.createdAt, 'createdAt محفوظ عبر القراءة من القرص');

  // تغيّر العنوان ⇒ توليد جديد
  const other = mobiletls.ensureCert('10.1.2.3');
  assert(other.fingerprint !== first.fingerprint, 'تغيّر IP ⇒ شهادة جديدة');
  assertEqual(other.ip, '10.1.2.3', 'الشهادة الجديدة تحمل العنوان الجديد');
  assertEqual(new crypto.X509Certificate(other.cert).checkIP('10.1.2.3'), '10.1.2.3', 'SAN الجديدة تغطي العنوان الجديد');

  // والعودة للعنوان الأول تولّد أيضاً (الملف المخزّن صار للعنوان الآخر)
  mobiletls.resetCache();
  const back = mobiletls.ensureCert(LAN_IP);
  assert(back.fingerprint !== other.fingerprint, 'العودة للعنوان الأول لا تعيد استعمال شهادة عنوان آخر');
  assertEqual(new crypto.X509Certificate(back.cert).checkIP(LAN_IP), LAN_IP, 'شهادة العودة تغطي العنوان الأول');
  assert(!new crypto.X509Certificate(back.cert).checkIP('10.1.2.3'), 'شهادة العودة لا تغطي العنوان القديم');

  // عنوان غير صالح ⇒ رفض fail-closed بلا كتابة
  for (const bad of ['', 'not-an-ip', '999.1.1.1', null, undefined, 42, { ip: '1.2.3.4' }]) {
    let error = null;
    try {
      mobiletls.ensureCert(bad);
    } catch (caught) {
      error = caught;
    }
    assert(error instanceof Error && error.message === 'bad_ip', 'عنوان غير صالح يُرفض برمز bad_ip: ' + String(bad));
  }
}

/* ───────── 4) الفساد والانتهاء ⇒ توليد جديد بلا رمي ───────── */

function testCorruptionAndExpiry() {
  const base = mobiletls.ensureCert(LAN_IP);

  const cases = [
    {
      name: 'شهادة فاسدة نصياً',
      apply: () => writeBundle(base, { cert: 'not a certificate at all' })
    },
    {
      name: 'شهادة مبتورة (‏PEM ناقص)',
      apply: () => writeBundle(base, { cert: base.cert.slice(0, Math.floor(base.cert.length / 2)) })
    },
    {
      name: 'مفتاح فاسد',
      apply: () => writeBundle(base, { key: '-----BEGIN PRIVATE KEY-----\nZ+++\n-----END PRIVATE KEY-----\n' })
    },
    {
      name: 'مفتاح لا يطابق الشهادة',
      apply: () => writeBundle(base, { key: mobiletls.generateCert(LAN_IP).key })
    },
    {
      name: 'ملف الشهادة مفقود',
      apply: () => {
        writeBundle(base);
        fs.rmSync(path.join(tlsDir, 'cert.pem'), { force: true });
      }
    },
    {
      name: 'ملف المفتاح مفقود',
      apply: () => {
        writeBundle(base);
        fs.rmSync(path.join(tlsDir, 'key.pem'), { force: true });
      }
    },
    {
      name: 'ميتاداتا فاسدة (الشهادة سليمة ⇒ لا يلزم توليد)',
      apply: () => {
        writeBundle(base);
        fs.writeFileSync(path.join(tlsDir, 'meta.json'), '{ broken', 'utf8');
      },
      expectSame: true
    },
    {
      name: 'شهادة منتهية الصلاحية',
      apply: () => {
        const stale = mobiletls.generateCert(LAN_IP, {
          notBefore: new Date(Date.now() - 30 * DAY_MS),
          notAfter: new Date(Date.now() - DAY_MS)
        });
        writeBundle(stale);
      }
    },
    {
      name: 'شهادة توشك على الانتهاء (داخل هامش التجديد)',
      apply: () => {
        const soon = mobiletls.generateCert(LAN_IP, {
          notBefore: new Date(Date.now() - 30 * DAY_MS),
          notAfter: new Date(Date.now() + 2 * DAY_MS)
        });
        writeBundle(soon);
      }
    },
    {
      name: 'شهادة لم تبدأ صلاحيتها بعد',
      apply: () => {
        const future = mobiletls.generateCert(LAN_IP, {
          notBefore: new Date(Date.now() + 10 * DAY_MS),
          notAfter: new Date(Date.now() + 100 * DAY_MS)
        });
        writeBundle(future);
      }
    },
    {
      name: 'شهادة لعنوان آخر (تلاعب في meta لا يخدع SAN)',
      apply: () => {
        const wrong = mobiletls.generateCert('172.16.9.9');
        writeBundle({ ...wrong, ip: LAN_IP });
      }
    }
  ];

  for (const testCase of cases) {
    testCase.apply();
    mobiletls.resetCache();

    let before = '';
    try {
      before = fs.readFileSync(path.join(tlsDir, 'cert.pem'), 'utf8').trim();
    } catch (missing) {
      before = ''; // حالة «الملف مفقود» — لا شيء لمقارنته
    }
    let result = null;
    let error = null;
    try {
      result = mobiletls.ensureCert(LAN_IP);
    } catch (caught) {
      error = caught;
    }

    assert(error === null, `لا رمي عند: ${testCase.name}`);
    if (!result) continue;

    const x509 = new crypto.X509Certificate(result.cert);
    assertEqual(x509.checkIP(LAN_IP), LAN_IP, `النتيجة صالحة للعنوان عند: ${testCase.name}`);
    assert(Date.parse(x509.validTo) - Date.now() > mobiletls.RENEW_MARGIN_MS, `النتيجة غير منتهية عند: ${testCase.name}`);
    assert(x509.checkPrivateKey(crypto.createPrivateKey(result.key)), `المفتاح يطابق الشهادة عند: ${testCase.name}`);

    if (testCase.expectSame) {
      assert(result.cert.trim() === before, `أُبقيت الشهادة السليمة كما هي عند: ${testCase.name}`);
    } else {
      assert(result.cert.trim() !== before, `أُعيد التوليد عند: ${testCase.name}`);
      assert(
        fs.readFileSync(path.join(tlsDir, 'cert.pem'), 'utf8').trim() === result.cert.trim(),
        `الشهادة الجديدة كُتبت إلى القرص عند: ${testCase.name}`
      );
      assert(
        digest(fs.readFileSync(path.join(tlsDir, 'key.pem'), 'utf8')) === digest(result.key),
        `المفتاح الجديد كُتب إلى القرص عند: ${testCase.name}`
      );
    }
  }

  // الشهادة المولَّدة بعد الفساد ما زالت تعمل في TLS حقيقي
  return mobiletls.ensureCert(LAN_IP);
}

/* ───────── 5) حصر الكتابة داخل ~/.satr/mobile-tls ───────── */

function testWriteScope() {
  const expectedDir = path.join(testHome, '.satr', 'mobile-tls');
  const files = walk(testHome);

  assert(files.length > 0, 'النطاق: كُتبت ملفات فعلاً (الاختبار ليس فارغاً)');
  for (const file of files) {
    assertEqual(path.dirname(file), expectedDir, 'النطاق: كل ملف داخل ~/.satr/mobile-tls حصراً — ' + file);
  }

  const names = new Set(files.map((file) => path.basename(file)));
  assert(names.has('key.pem'), 'النطاق: key.pem موجود');
  assert(names.has('cert.pem'), 'النطاق: cert.pem موجود');
  assert(names.has('meta.json'), 'النطاق: meta.json موجود');
  for (const name of names) {
    assert(!name.includes('.tmp-'), 'النطاق: لا ملفات مؤقتة متروكة — ' + name);
  }

  // مجلد مخصّص عبر createStore لا يكتب خارج نفسه
  const customDir = path.join(testHome, 'custom-tls');
  const custom = mobiletls.createStore({ dir: customDir });
  const bundle = custom.ensureCert('10.9.8.7');
  assert(bundle && bundle.cert.includes('BEGIN CERTIFICATE'), 'النطاق: createStore بمجلد مخصّص يعمل');
  for (const file of walk(customDir)) {
    assertEqual(path.dirname(file), customDir, 'النطاق: مخزن مخصّص يكتب داخل مجلده فقط — ' + file);
  }

  // فشل القرص أفضل جهد: لا يكسر الجلسة الحيّة
  const blindDir = path.join(testHome, 'read-only-tls');
  const blocked = mobiletls.createStore({
    dir: blindDir,
    fs: {
      mkdirSync: () => {
        throw new Error('EACCES');
      },
      statSync: () => {
        throw new Error('ENOENT');
      },
      readFileSync: () => {
        throw new Error('ENOENT');
      },
      writeFileSync: () => {
        throw new Error('EACCES');
      },
      renameSync: () => {
        throw new Error('EACCES');
      },
      unlinkSync: () => {}
    }
  });
  let diskError = null;
  let offline = null;
  try {
    offline = blocked.ensureCert(LAN_IP);
  } catch (error) {
    diskError = error;
  }
  assert(diskError === null, 'النطاق: فشل القرص لا يرمي (‏persist أفضل جهد)');
  assert(offline && new crypto.X509Certificate(offline.cert).checkIP(LAN_IP) === LAN_IP, 'النطاق: شهادة صالحة رغم فشل القرص');
  assert(!fs.existsSync(blindDir), 'النطاق: لم يُنشأ مجلد عند فشل الكتابة');
}

/* ───────── 6) عدم تسريب المفتاح الخاص ───────── */

function testNoKeyLeak() {
  const bundle = mobiletls.ensureCert(LAN_IP);
  const secret = keyBody(bundle.key);
  assert(secret.length > 40, 'التسريب: جسم المفتاح مستخرَج للمقارنة');

  assertEqual(
    Object.keys(bundle).sort().join(','),
    'cert,createdAt,fingerprint,ip,key',
    'التسريب: العقد خمسة حقول بالضبط بلا حقول زائدة'
  );

  for (const field of ['cert', 'fingerprint', 'ip']) {
    const value = String(bundle[field]);
    assert(!value.includes(secret), `التسريب: ${field} لا يحوي جسم المفتاح`);
    assert(!value.includes('PRIVATE KEY'), `التسريب: ${field} لا يحوي ترويسة المفتاح الخاص`);
  }
  assert(typeof bundle.createdAt === 'number' && Number.isFinite(bundle.createdAt), 'التسريب: createdAt رقم لا نص');

  // meta.json المخزّن لا يحمل مادة مفاتيح
  const meta = fs.readFileSync(path.join(tlsDir, 'meta.json'), 'utf8');
  assert(!meta.includes(secret), 'التسريب: meta.json لا يحوي المفتاح الخاص');
  assert(!meta.includes('PRIVATE KEY'), 'التسريب: meta.json لا يحوي ترويسة مفتاح خاص');
  assert(!fs.readFileSync(path.join(tlsDir, 'cert.pem'), 'utf8').includes(secret), 'التسريب: cert.pem لا يحوي المفتاح');

  // رسائل الأخطاء رموز قصيرة بلا مادة مفاتيح
  let thrown = null;
  try {
    mobiletls.ensureCert('bad');
  } catch (error) {
    thrown = error;
  }
  assert(thrown instanceof Error, 'التسريب: عنوان فاسد يرمي');
  assertEqual(thrown.message, 'bad_ip', 'التسريب: رسالة الخطأ رمز ثابت قصير');
  assert(!String(thrown.stack).includes(secret), 'التسريب: أثر الخطأ لا يحوي المفتاح');

  // التعديل على النسخة المعادة لا يفسد الكاش الداخلي
  bundle.cert = 'tampered';
  const fresh = mobiletls.ensureCert(LAN_IP);
  assert(fresh.cert.includes('BEGIN CERTIFICATE'), 'التسريب: النسخة المعادة مستقلة عن الحالة الداخلية');
}

/* ───────── التشغيل ───────── */

async function main() {
  await testRealTls();
  testSanPresence();
  testReuseAndRotation();
  const recovered = testCorruptionAndExpiry();

  // برهان ختامي: الشهادة الناتجة عن مسار ensureCert (لا generateCert) تعمل في TLS
  const round = await tlsRoundTrip(recovered, '127.0.0.1', null);
  assertEqual(round.authorized, true, 'TLS: شهادة ensureCert المخزّنة معتمَدة في مصافحة حقيقية');
  assertEqual(round.body, 'satr-ok', 'TLS: شهادة ensureCert تخدم طلباً كاملاً');

  testWriteScope();
  testNoKeyLeak();
}

main()
  .then(() => {
    cleanup();
    if (process.exitCode) {
      console.error(`\nmobiletls-test: فشل — ${passed} فحصاً ناجحاً قبل الفشل`);
      return;
    }
    console.log(`mobiletls-test: ok — ${passed} فحصاً (‏TLS حقيقي + SAN + التدوير + الفساد + النطاق + عدم التسريب)`);
  })
  .catch((error) => {
    cleanup();
    console.error('mobiletls-test: خطأ غير متوقع —', error && error.message);
    process.exitCode = 1;
  });
