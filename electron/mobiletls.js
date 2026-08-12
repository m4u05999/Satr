/**
 * سطر — شهادة TLS محلية موقّعة ذاتياً للقناة المحلية (م1-ب — §5.5.1 من
 * docs/MOBILE-CONTROL-PLAN.md).
 *
 * ── لماذا تلزم أصلاً ────────────────────────────────────────────────────
 * `crypto.subtle` محجوب خارج «السياق الآمن»، فتشغيل تطبيق الجوال عبر HTTP
 * على عنوان شبكة يجعل الاقتران مستحيلاً بنيوياً. أثبت الفحص الحيّ على أندرويد
 * أن شهادة موقّعة ذاتياً تمنح سياقاً آمناً بعد قبول التحذير — فمسار LAN قابل
 * للتحقيق. الشهادة في تلك التجربة وُلّدت بـ`openssl`، و`openssl` **غير مضمون**
 * على أجهزة المستخدمين وعقيدة المشروع لا تقبل حزمة npm جديدة؛ لذلك يبني هذا
 * الملف شهادة X.509 كاملة بترميز DER يدوياً فوق `node:crypto` وحده.
 *
 * ── قرار نوع المفتاح: EC P-256 (لا RSA-2048) ────────────────────────────
 *  1) التوليد فوري (أجزاء من الملّي) بينما RSA-2048 قد يستغرق مئات
 *     الملّي ثانية إلى ثوانٍ — وهذه الدالة تُستدعى في مسار بدء القناة.
 *  2) نفس منحنى `mobilecrypto.js` (‏prime256v1) فلا يدخل المشروع خوارزمية
 *     ثانية بلا داعٍ.
 *  3) ECDSA-P-256 + SHA-256 مدعوم في كل متصفح حديث (أندرويد/‏iOS) وفي طبقة
 *     TLS في Node بلا إعداد إضافي. الشهادة أصغر فيصغر رمز QR غير المباشر.
 *
 * ── بنية DER المبنية يدوياً ──────────────────────────────────────────────
 *  Certificate ::= SEQUENCE { tbsCertificate, signatureAlgorithm, signature }
 *  TBSCertificate ::= SEQUENCE {
 *      [0] version(v3=2) · serialNumber · signature(AlgId) · issuer(Name)
 *      validity(SEQUENCE{UTCTime,UTCTime}) · subject(Name)
 *      subjectPublicKeyInfo · [3] extensions }
 *  الامتدادات: basicConstraints(CA:FALSE, حرج) · keyUsage(digitalSignature،
 *  حرج) · extKeyUsage(serverAuth) · subjectKeyIdentifier · subjectAltName.
 *  **SAN إلزامي** (‏IP:<ip> + DNS:localhost + IP:127.0.0.1) — بلا SAN ترفض
 *  المتصفحات الشهادة رفضاً قاطعاً ولا يفيد CN.
 *  ملاحظة: `crypto.X509Certificate` يقرأ ولا يُنشئ، فالإنشاء بناء DER بيدنا؛
 *  لكنه يُستعمل هنا للتحقق البنيوي من الملف المخزّن (حارس ضد ملف فاسد).
 *
 * ── أمان ────────────────────────────────────────────────────────────────
 *  المفتاح الخاص يُعاد في `key` **للعملية الرئيسية حصراً** ليمرّره خادم HTTPS؛
 *  لا يُسجَّل ولا يظهر في أي رسالة خطأ (رموز الأخطاء إنجليزية قصيرة ثابتة)،
 *  ولا يعبر IPC إلى renderer أبداً. الملفات لا تُنشأ خارج `~/.satr/mobile-tls`.
 */

'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');

// — ثوابت العقد —
const DIR_NAME = 'mobile-tls';
const CURVE = 'prime256v1'; // = P-256 = secp256r1
const VALIDITY_DAYS = 397; // ≤ 398 يوماً (سقف المتصفحات)
const SKEW_MS = 60 * 60 * 1000; // ساعة إلى الوراء تسامحاً مع انحراف الساعة
const RENEW_MARGIN_MS = 7 * 24 * 60 * 60 * 1000; // تُجدَّد قبل الانتهاء بأسبوع
const MAX_PEM_BYTES = 64 * 1024;
const MAX_META_BYTES = 8 * 1024;
const KEY_FILE = 'key.pem';
const CERT_FILE = 'cert.pem';
const META_FILE = 'meta.json';

// — معرّفات الكائنات (OIDs) —
const OID_EC_PUBLIC_KEY = '1.2.840.10045.2.1';
const OID_ECDSA_SHA256 = '1.2.840.10045.4.3.2';
const OID_CN = '2.5.4.3';
const OID_O = '2.5.4.10';
const OID_SUBJECT_KEY_ID = '2.5.29.14';
const OID_KEY_USAGE = '2.5.29.15';
const OID_SAN = '2.5.29.17';
const OID_BASIC_CONSTRAINTS = '2.5.29.19';
const OID_EXT_KEY_USAGE = '2.5.29.37';
const OID_SERVER_AUTH = '1.3.6.1.5.5.7.3.1';

/** خطأ بعقد ثابت: رمز إنجليزي قصير — لا يحمل أي مادة مفاتيح. */
function fail(code) {
  return new Error(code);
}

/* ────────────────────────── ترميز ASN.1/DER ────────────────────────── */

/** طول DER: قصير (<128) أو طويل (0x8N ثم N بايتاً big-endian). */
function encodeLength(len) {
  if (len < 0x80) return Buffer.from([len]);
  const bytes = [];
  let value = len;
  while (value > 0) {
    bytes.unshift(value & 0xff);
    value = Math.floor(value / 256);
  }
  return Buffer.from([0x80 | bytes.length, ...bytes]);
}

/** عنصر TLV واحد: tag || length || content. */
function tlv(tag, content) {
  const body = Array.isArray(content) ? Buffer.concat(content) : content;
  return Buffer.concat([Buffer.from([tag]), encodeLength(body.length), body]);
}

const seq = (parts) => tlv(0x30, parts);
const set = (parts) => tlv(0x31, parts);
const octetString = (buf) => tlv(0x04, buf);

/** BIT STRING مع عدد البتات غير المستعملة في أول بايت من المحتوى. */
function bitString(buf, unusedBits = 0) {
  return tlv(0x03, Buffer.concat([Buffer.from([unusedBits]), buf]));
}

/** INTEGER موجب من بايتات: يقصّ الأصفار البادئة ويحشو 0x00 إن أضاء بت الإشارة. */
function positiveInteger(buf) {
  let start = 0;
  while (start < buf.length - 1 && buf[start] === 0) start += 1;
  let body = buf.subarray(start);
  if (body[0] & 0x80) body = Buffer.concat([Buffer.from([0x00]), body]);
  return tlv(0x02, body);
}

/** INTEGER صغير موجب (يستعمل لرقم إصدار الشهادة). */
function smallInteger(value) {
  return tlv(0x02, Buffer.from([value & 0x7f]));
}

/** OBJECT IDENTIFIER من صيغة منقّطة: أول بايت 40*a+b ثم base-128. */
function objectIdentifier(dotted) {
  const parts = dotted.split('.').map((part) => Number.parseInt(part, 10));
  if (parts.length < 2 || parts.some((n) => !Number.isInteger(n) || n < 0)) throw fail('bad_oid');
  const out = [40 * parts[0] + parts[1]];
  for (let i = 2; i < parts.length; i += 1) {
    let value = parts[i];
    const chunk = [value & 0x7f];
    value = Math.floor(value / 128);
    while (value > 0) {
      chunk.unshift((value & 0x7f) | 0x80);
      value = Math.floor(value / 128);
    }
    out.push(...chunk);
  }
  return tlv(0x06, Buffer.from(out));
}

/** AlgorithmIdentifier بلا معاملات (‏RFC 5758 يوجب غيابها لـECDSA). */
function algorithmIdentifier(dotted, params) {
  const parts = [objectIdentifier(dotted)];
  if (params) parts.push(params);
  return seq(parts);
}

/** UTCTime بصيغة YYMMDDHHMMSSZ — صالحة للسنوات 1950..2049 حصراً. */
function utcTime(date) {
  const year = date.getUTCFullYear();
  if (year < 1950 || year > 2049) throw fail('time_out_of_range');
  const pad = (n) => String(n).padStart(2, '0');
  const text =
    pad(year % 100) +
    pad(date.getUTCMonth() + 1) +
    pad(date.getUTCDate()) +
    pad(date.getUTCHours()) +
    pad(date.getUTCMinutes()) +
    pad(date.getUTCSeconds()) +
    'Z';
  return tlv(0x17, Buffer.from(text, 'ascii'));
}

/** Name ::= RDNSequence — كل مدخل SET{ SEQUENCE{ OID, UTF8String } }. */
function distinguishedName(entries) {
  return seq(entries.map(([dotted, value]) => set([seq([objectIdentifier(dotted), tlv(0x0c, Buffer.from(value, 'utf8'))])])));
}

/** Extension ::= SEQUENCE { extnID, critical DEFAULT FALSE, extnValue OCTET STRING }. */
function extension(dotted, critical, valueDer) {
  const parts = [objectIdentifier(dotted)];
  if (critical) parts.push(tlv(0x01, Buffer.from([0xff])));
  parts.push(octetString(valueDer));
  return seq(parts);
}

/* ────────────────────────── عناوين IP ────────────────────────── */

/** IPv6 إلى 16 بايتاً: يوسّع «::» ويستوعب الذيل بصيغة IPv4. */
function ipv6ToBytes(input) {
  let text = input;
  const scope = text.indexOf('%');
  if (scope !== -1) text = text.slice(0, scope); // نطاق الواجهة لا يدخل الشهادة

  // ذيل بصيغة IPv4 (مثل ::ffff:192.168.1.4) ⇒ يُحوَّل إلى hextetين
  const tail = /:((?:\d{1,3}\.){3}\d{1,3})$/.exec(text);
  if (tail) {
    const octets = tail[1].split('.').map((part) => Number.parseInt(part, 10));
    if (octets.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return null;
    const high = ((octets[0] << 8) | octets[1]).toString(16);
    const low = ((octets[2] << 8) | octets[3]).toString(16);
    text = text.slice(0, tail.index) + ':' + high + ':' + low;
  }

  const double = text.indexOf('::');
  let head;
  let rest;
  if (double === -1) {
    head = text.split(':');
    rest = [];
  } else {
    const left = text.slice(0, double);
    const right = text.slice(double + 2);
    head = left ? left.split(':') : [];
    rest = right ? right.split(':') : [];
  }

  const missing = 8 - head.length - rest.length;
  if (missing < 0) return null;
  const groups = [...head, ...new Array(missing).fill('0'), ...rest];
  if (groups.length !== 8) return null;

  const out = Buffer.alloc(16);
  for (let i = 0; i < 8; i += 1) {
    if (!/^[0-9a-fA-F]{1,4}$/.test(groups[i])) return null;
    out.writeUInt16BE(Number.parseInt(groups[i], 16), i * 2);
  }
  return out;
}

/** بايتات عنوان IP (‏4 أو 16) — أو null لعنوان غير صالح. */
function ipToBytes(ip) {
  const kind = net.isIP(ip);
  if (kind === 4) {
    const octets = ip.split('.').map((part) => Number.parseInt(part, 10));
    return Buffer.from(octets);
  }
  if (kind === 6) return ipv6ToBytes(ip);
  return null;
}

/** ينقّي عنوان الربط: نص عنوان IP صالح فقط، وبلا نطاق واجهة. */
function normalizeIp(ip) {
  if (typeof ip !== 'string') return null;
  const trimmed = ip.trim();
  if (!trimmed || trimmed.length > 64) return null;
  const scope = trimmed.indexOf('%');
  const bare = scope === -1 ? trimmed : trimmed.slice(0, scope);
  if (!net.isIP(bare)) return null;
  return bare;
}

/* ────────────────────────── بناء الشهادة ────────────────────────── */

/** يبني قائمة الأسماء البديلة المطلوبة بلا تكرار وبترتيب ثابت. */
function buildSanEntries(ip) {
  const entries = [{ type: 'dns', value: 'localhost' }];
  const seen = new Set();
  for (const value of [ip, '127.0.0.1']) {
    if (seen.has(value)) continue;
    seen.add(value);
    entries.push({ type: 'ip', value });
  }
  return entries;
}

function sanExtensionValue(entries) {
  const items = entries.map((entry) => {
    if (entry.type === 'dns') return tlv(0x82, Buffer.from(entry.value, 'ascii')); // [2] dNSName
    const bytes = ipToBytes(entry.value);
    if (!bytes) throw fail('bad_ip');
    return tlv(0x87, bytes); // [7] iPAddress
  });
  return seq(items);
}

/** يلفّ DER في PEM بأسطر 64 محرفاً. */
function toPem(der, label) {
  const base64 = der.toString('base64');
  const lines = [];
  for (let i = 0; i < base64.length; i += 64) lines.push(base64.slice(i, i + 64));
  return `-----BEGIN ${label}-----\n${lines.join('\n')}\n-----END ${label}-----\n`;
}

/** بصمة عرض: SHA-256 للـDER بصيغة AA:BB:… */
function fingerprintOf(der) {
  const digest = crypto.createHash('sha256').update(der).digest('hex').toUpperCase();
  return digest.replace(/(.{2})(?=.)/g, '$1:');
}

/**
 * يولّد زوج مفاتيح وشهادة موقّعة ذاتياً للعنوان المعطى.
 * `options.notBefore` و`options.notAfter` منفذان داخليان للاختبار حصراً.
 * @returns {{key:string, cert:string, fingerprint:string, ip:string, createdAt:number}}
 */
function generateCert(ip, options = {}) {
  const address = normalizeIp(ip);
  if (!address) throw fail('bad_ip');

  const now = Number.isFinite(options.now) ? new Date(options.now) : new Date();
  const notBefore = options.notBefore instanceof Date ? options.notBefore : new Date(now.getTime() - SKEW_MS);
  const notAfter =
    options.notAfter instanceof Date ? options.notAfter : new Date(now.getTime() + VALIDITY_DAYS * 24 * 60 * 60 * 1000);
  if (notAfter.getTime() - notBefore.getTime() > 399 * 24 * 60 * 60 * 1000) throw fail('validity_too_long');

  const { publicKey, privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: CURVE });
  // SPKI الجاهز من Node هو حرفياً حقل subjectPublicKeyInfo — لا نعيد ترميزه بيدنا
  const spki = publicKey.export({ type: 'spki', format: 'der' });
  const jwk = publicKey.export({ format: 'jwk' });
  const point = Buffer.concat([
    Buffer.from([0x04]),
    Buffer.from(jwk.x, 'base64url'),
    Buffer.from(jwk.y, 'base64url')
  ]);
  if (point.length !== 65) throw fail('bad_public_key');

  // رقم تسلسلي موجب غير صفري (‏16 بايتاً — دون سقف RFC البالغ 20)
  const serial = crypto.randomBytes(16);
  serial[0] = (serial[0] & 0x7f) | 0x01;

  const sigAlg = algorithmIdentifier(OID_ECDSA_SHA256);
  const name = distinguishedName([
    [OID_O, 'Satr'],
    [OID_CN, address]
  ]);

  const extensions = seq([
    // CA:FALSE ⇒ SEQUENCE فارغة (‏cA له DEFAULT FALSE فيُحذف في DER)
    extension(OID_BASIC_CONSTRAINTS, true, seq([])),
    // digitalSignature وحده: هو ما يلزم ECDHE_ECDSA (‏بت 0 ⇒ 7 بتات غير مستعملة)
    extension(OID_KEY_USAGE, true, bitString(Buffer.from([0x80]), 7)),
    extension(OID_EXT_KEY_USAGE, false, seq([objectIdentifier(OID_SERVER_AUTH)])),
    extension(OID_SUBJECT_KEY_ID, false, octetString(crypto.createHash('sha1').update(point).digest())),
    extension(OID_SAN, false, sanExtensionValue(buildSanEntries(address)))
  ]);

  const tbs = seq([
    tlv(0xa0, smallInteger(2)), // [0] version = v3
    positiveInteger(serial),
    sigAlg,
    name, // issuer = subject (موقّعة ذاتياً)
    seq([utcTime(notBefore), utcTime(notAfter)]),
    name,
    spki,
    tlv(0xa3, extensions) // [3] extensions
  ]);

  const signature = crypto.sign('sha256', tbs, privateKey); // ECDSA ⇒ DER افتراضياً
  const certDer = seq([tbs, sigAlg, bitString(signature)]);

  return {
    key: privateKey.export({ type: 'pkcs8', format: 'pem' }),
    cert: toPem(certDer, 'CERTIFICATE'),
    fingerprint: fingerprintOf(certDer),
    ip: address,
    createdAt: now.getTime()
  };
}

/* ────────────────────────── التخزين ────────────────────────── */

/**
 * يتحقق أن الشهادة تغطي الأسماء البديلة الثلاثة المطلوبة.
 *
 * يستعمل `checkIP`/`checkHost` لا مقارنة نصية مع `subjectAltName`: فOpenSSL
 * يطبع IPv6 بصيغة موسّعة بأحرف كبيرة (‏`FD12:3456:789A:0:0:0:0:5`) لا تساوي
 * ما كتبناه، فمقارنة النص كانت ستُفشل التحقق وتعيد التوليد في كل استدعاء.
 */
function coversRequiredNames(x509, address) {
  if (x509.checkHost('localhost') !== 'localhost') return false;
  for (const entry of buildSanEntries(address)) {
    if (entry.type === 'ip' && !x509.checkIP(entry.value)) return false;
  }
  return true;
}

function createStore(options = {}) {
  const io = options.fs || fs;
  const dir = options.dir || process.env.SATR_MOBILE_TLS_DIR || path.join(os.homedir(), '.satr', DIR_NAME);
  const keyPath = path.join(dir, KEY_FILE);
  const certPath = path.join(dir, CERT_FILE);
  const metaPath = path.join(dir, META_FILE);
  let cached = null; // آخر شهادة صالحة في هذه العملية

  function readTextFile(file, maxBytes) {
    const stat = io.statSync(file);
    if (!stat.isFile() || stat.size > maxBytes) throw fail('bad_file');
    return io.readFileSync(file, 'utf8');
  }

  /**
   * يقرأ الشهادة المخزّنة ويتحقق منها **بنيوياً** لا بمجرد وجود الملف:
   * تحليل X.509 فعلي + مطابقة المفتاح الخاص + وجود الأسماء البديلة الثلاثة
   * + صلاحية زمنية. أي فشل يعيد null (⇒ يُعاد التوليد بلا رمي).
   */
  function readStored(address, now) {
    let key;
    let cert;
    let meta = null;
    try {
      key = readTextFile(keyPath, MAX_PEM_BYTES);
      cert = readTextFile(certPath, MAX_PEM_BYTES);
    } catch (error) {
      return null;
    }
    try {
      meta = JSON.parse(readTextFile(metaPath, MAX_META_BYTES));
    } catch (error) {
      meta = null; // الميتاداتا مساعِدة فقط؛ الشهادة نفسها مصدر الحقيقة
    }

    let x509;
    try {
      x509 = new crypto.X509Certificate(cert);
      const keyObject = crypto.createPrivateKey(key);
      if (!x509.checkPrivateKey(keyObject)) return null;
    } catch (error) {
      return null; // ملف فاسد أو مبتور أو مفتاح لا يطابق
    }

    // الأسماء البديلة مصدر الحقيقة لـ«هل تغيّر العنوان؟» — لا meta.json
    if (!coversRequiredNames(x509, address)) return null;

    const validFrom = Date.parse(x509.validFrom);
    const validTo = Date.parse(x509.validTo);
    if (!Number.isFinite(validFrom) || !Number.isFinite(validTo)) return null;
    if (now < validFrom) return null;
    if (validTo - now <= RENEW_MARGIN_MS) return null; // منتهية أو توشك

    const createdAt = meta && Number.isFinite(meta.createdAt) ? meta.createdAt : validFrom;
    return {
      key,
      cert,
      fingerprint: fingerprintOf(x509.raw),
      ip: address,
      createdAt
    };
  }

  /** كتابة ذرية أفضل جهد: temp ثم rename لكل ملف. فشل القرص لا يكسر الجلسة. */
  function persist(bundle) {
    const stamp = process.pid + '-' + Date.now();
    const files = [
      [keyPath, bundle.key, 0o600],
      [certPath, bundle.cert, 0o644],
      [
        metaPath,
        JSON.stringify(
          { v: 1, ip: bundle.ip, createdAt: bundle.createdAt, fingerprint: bundle.fingerprint },
          null,
          2
        ),
        0o644
      ]
    ];
    try {
      io.mkdirSync(dir, { recursive: true });
    } catch (error) {
      return false;
    }
    for (const [target, content, mode] of files) {
      const temp = `${target}.tmp-${stamp}`;
      try {
        io.writeFileSync(temp, content, { encoding: 'utf8', mode });
        io.renameSync(temp, target);
      } catch (error) {
        try {
          io.unlinkSync(temp);
        } catch (cleanupError) {
          // نتجاهل — التنظيف أفضل جهد
        }
        return false;
      }
    }
    return true;
  }

  /**
   * يعيد شهادة صالحة للعنوان المعطى، مولّداً إياها عند الحاجة.
   * يُعاد التوليد إن تغيّر `ip` أو انتهت الصلاحية أو فسد الملف — بلا تدخل مستخدم.
   * @param {string} ip عنوان IP الذي ستُربط عليه القناة
   */
  function ensureCert(ip) {
    const address = normalizeIp(ip);
    if (!address) throw fail('bad_ip');
    const now = Date.now();

    if (cached && cached.ip === address && cached.validTo - now > RENEW_MARGIN_MS) {
      return { ...cached.bundle };
    }

    const stored = readStored(address, now);
    if (stored) {
      cached = { ip: address, bundle: stored, validTo: Date.parse(new crypto.X509Certificate(stored.cert).validTo) };
      return { ...stored };
    }

    const fresh = generateCert(address, { now });
    persist(fresh); // أفضل جهد؛ الفشل يعني إعادة توليد في التشغيل القادم لا انهياراً
    cached = { ip: address, bundle: fresh, validTo: Date.parse(new crypto.X509Certificate(fresh.cert).validTo) };
    return { ...fresh };
  }

  /** يُسقط الكاش الحيّ (للاختبار ولإعادة القراءة القسرية من القرص). */
  function resetCache() {
    cached = null;
  }

  return { ensureCert, resetCache, dir, keyPath, certPath, metaPath };
}

const store = createStore();

module.exports = {
  ensureCert: store.ensureCert,
  resetCache: store.resetCache,
  createStore,
  generateCert,
  normalizeIp,
  ipToBytes,
  VALIDITY_DAYS,
  RENEW_MARGIN_MS,
  DIR_NAME
};
