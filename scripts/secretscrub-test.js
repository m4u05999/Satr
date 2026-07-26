'use strict';

/**
 * اختبار بوابة حجب الأسرار المشتركة (K5-أ/ج):
 * كل نمط جديد يُحجب (JWT/Bearer/PEM/AWS/GitHub/Slack)، النمطان القائمان ثابتان،
 * والإيجابيات الكاذبة لا تُحجب (SHA/UUID/مسار/اسم حزمة/نص عربي).
 */

const assert = require('assert');
const { scrubSecrets } = require('../electron/secretscrub');

// — النمطان القائمان (سلوك محفوظ) —
const sk = scrubSecrets('المفتاح sk-live-1234567890abcdef هنا');
assert.ok(!sk.includes('sk-live-1234567890abcdef') && sk.includes('[secret]'), 'sk-* لم يُحجب');
const kv = scrubSecrets('api_key: abcdef123456 وكلمة password=zzz999');
assert.ok(kv.includes('api_key=[secret]') && kv.includes('password=[secret]'), 'key=value لم يُحجب');

// — JWT —
const jwt = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4ifQ.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c';
const jwtOut = scrubSecrets('توكن ' + jwt + ' انتهى');
assert.ok(!jwtOut.includes('eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9') && jwtOut.includes('[secret]'), 'JWT لم يُحجب');

// — Bearer (تُبقى الكلمة وتحجب القيمة) —
const bearer = scrubSecrets('Authorization: Bearer abcdef1234567890.token_xyz');
assert.ok(bearer.includes('Bearer [secret]') && !bearer.includes('abcdef1234567890'), 'Bearer لم يُحجب قيمته');

// — PEM (يُحجب المحتوى ويُبقى السطران) —
const pem = '-----BEGIN PRIVATE KEY-----\nMIIEvwIBADANBgkqhkiG9w0BAQEFAASC\nb2NsaWQgc2VjcmV0\n-----END PRIVATE KEY-----';
const pemOut = scrubSecrets('الملف:\n' + pem + '\nانتهى');
assert.ok(pemOut.includes('-----BEGIN PRIVATE KEY-----'), 'سطر BEGIN فُقد');
assert.ok(pemOut.includes('-----END PRIVATE KEY-----'), 'سطر END فُقد');
assert.ok(!pemOut.includes('MIIEvwIBADANBgkqhkiG9w0BAQEFAASC'), 'محتوى PEM لم يُحجب');
const pemRsa = scrubSecrets('-----BEGIN RSA PRIVATE KEY-----\nAAAAB3NzaC1yc2EAAAADAQAB\n-----END RSA PRIVATE KEY-----');
assert.ok(pemRsa.includes('-----BEGIN RSA PRIVATE KEY-----') && !pemRsa.includes('AAAAB3NzaC1yc2EAAAADAQAB'), 'RSA PEM لم يُحجب');

// — AWS —
const aws = scrubSecrets('المفتاح AKIAIOSFODNN7EXAMPLE هنا');
assert.ok(!aws.includes('AKIAIOSFODNN7EXAMPLE') && aws.includes('[secret]'), 'AWS key لم يُحجب');

// — GitHub —
const ghp = scrubSecrets('توكن ghp_abcdefghij1234567890ABCD هنا');
assert.ok(!ghp.includes('ghp_abcdefghij1234567890ABCD'), 'ghp_ لم يُحجب');
const gho = scrubSecrets('توكن gho_xyzABC1234567890defghi هنا');
assert.ok(!gho.includes('gho_xyzABC1234567890defghi'), 'gho_ لم يُحجب');

// — Slack —
const slack = scrubSecrets('توكن xoxb-123456789012-abcdefghijkl هنا');
assert.ok(!slack.includes('xoxb-123456789012-abcdefghijkl'), 'xoxb- لم يُحجب');
const slackP = scrubSecrets('توكن xoxp-123456789012-123456789012-abcdef هنا');
assert.ok(!slackP.includes('xoxp-123456789012-123456789012-abcdef'), 'xoxp- لم يُحجب');

// — التحفظ ضد الإيجابيات الكاذبة (إلزامي): لا شيء منها يُحجب —
const sha = 'da39a3ee5e6b4b0d3255bfef95601890afd80709';
assert.strictEqual(scrubSecrets('الالتزام ' + sha), 'الالتزام ' + sha, 'git SHA حُجب خطأً');
const uuid = '550e8400-e29b-41d4-a716-446655440000';
assert.strictEqual(scrubSecrets('المعرّف ' + uuid), 'المعرّف ' + uuid, 'UUID حُجب خطأً');
const winPath = 'D:\\sater\\satr-2-kimi\\electron\\secretscrub.js';
assert.strictEqual(scrubSecrets('الملف ' + winPath), 'الملف ' + winPath, 'مسار حُجب خطأً');
const pkg = '@moonshot-ai/kimi-code و node-pty';
assert.strictEqual(scrubSecrets('الحزمة ' + pkg), 'الحزمة ' + pkg, 'اسم حزمة حُجب خطأً');
const arabic = 'نص عربي خالص بلا أسرار — المهمة اكتملت بنجاح.';
assert.strictEqual(scrubSecrets(arabic), arabic, 'نص عربي تغيّر');
// hex طويل يبدأ AKIA داخل سلسلة أطول (لا حدود كلمة ⇒ لا حجب)
const longHex = 'xxAKIA1234567890ABCDEFYY';
assert.strictEqual(scrubSecrets(longHex), longHex, 'hex مضمّن حُجب خطأً');

console.log('✓ النمطان القائمان (sk- وkey=value) ثابتان بلا تغيير');
console.log('✓ JWT وBearer وPEM (بسطرَي BEGIN/END) وAWS وGitHub وSlack تُحجب كلها');
console.log('✓ الإيجابيات الكاذبة محمية: SHA وUUID ومسار وأسماء حزم ونص عربي لا تُحجب');
