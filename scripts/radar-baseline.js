#!/usr/bin/env node
/**
 * سطر — قارئ إصدارات المحرّكات المثبّتة على جهاز المالك (‏`radar:baseline`).
 *
 * **الفجوة التي يسدّها** (اقتراح وكيل الرادار، 2026-09-06): الرادار يقرأ npm registry
 * و`package.json` من المستودع، لكنه **لا يستطيع** معرفة `codex --version` على جهاز
 * المالك — وهي بالضبط الأرقام التي تُقارَن بها «الأحدث على السجلّ». فبلا هذا الحقل
 * يبقى عمودٌ من ثلاثة أعمى، ويُقرأ `latest_seen` خطأً على أنه حكمٌ على تأخّرنا بينما
 * هو لقطة زمنية لِما رُصد لحظة تشغيل العدد.
 *
 * **العقد**: ما يكتبه هذا السكربت في `state.json → baseline.engines_on_owner_machine`
 * **يغلب** ما يرصده الرادار — لأنه قياس محلي لا استنتاج.
 *
 * الاستعمال:
 *   npm run radar:baseline            # يطبع الجدول فقط
 *   npm run radar:baseline -- --write # يكتبه في docs/radar/state.json
 *
 * ⚠️ **حدّ معلَن**: يفحص الأسماء المجرّدة في `PATH` كما يراها هذا الطرفية. وثبت في هذا
 * المستودع أن مثبّت `winget` يضع الأداة في مسار ليس في `PATH` الذي ورثه التطبيق
 * (‏درس `satr-youtube`)، فقد يظهر محرّكٌ «غير موجود» وهو مثبَّت. النتيجة `null` تعني
 * «لم يُقَس هنا» لا «غير مثبَّت».
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');

// نسخة واحدة: `probeVersion` نفسها التي تستعملها بوابة أول التشغيل — فترث علاج
// ‏OBS-130 (المسار ذو المسافة: `.exe` بلا صدفة و`.cmd` باقتباس) بلا تكرار منطق.
const { probeVersion } = require('../electron/claudeauth');

const ROOT = path.resolve(__dirname, '..');
const STATE = path.join(ROOT, 'docs', 'radar', 'state.json');

const ENGINES = [
  { key: 'codex', command: 'codex' },
  { key: 'kimi-code', command: 'kimi' },
  { key: 'claude-code', command: 'claude' },
  { key: 'node', command: 'node' },
  { key: 'npm', command: 'npm' },
];

/**
 * أوّل ما يشبه رقم إصدار في الخرج. الأدوات تطبع أشكالاً مختلفة:
 * `codex-cli 0.153.4` · `v26.5.0` · `2.1.258 (Claude Code)` · `11.17.0`.
 * نأخذ الرقم لا السطر كي يبقى الحقل قابلاً للمقارنة آلياً.
 */
function extractVersion(raw) {
  const text = String(raw || '').trim();
  if (!text) return null;
  const match = text.match(/\d+\.\d+(?:\.\d+)?(?:[-+][0-9A-Za-z.]+)?/);
  return match ? match[0] : null;
}

async function readEngines() {
  const out = {};
  for (const engine of ENGINES) {
    let version = null;
    try {
      const probe = await probeVersion(engine.command, ['--version']);
      if (probe && probe.ok) version = extractVersion(probe.version);
    } catch { /* غير موجود في PATH — يبقى null */ }
    out[engine.key] = version;
  }
  return out;
}

function today() {
  // بلا مكتبة تواريخ: YYYY-MM-DD محلياً
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
}

async function main() {
  const write = process.argv.includes('--write');
  const engines = await readEngines();

  console.log('إصدارات المحرّكات على هذا الجهاز:');
  for (const engine of ENGINES) {
    const value = engines[engine.key];
    console.log('  ' + engine.key.padEnd(14) + (value || '— لم يُقَس هنا (ليس في PATH)'));
  }

  if (!write) {
    console.log('');
    console.log('للكتابة في state.json:  npm run radar:baseline -- --write');
    return;
  }

  let state;
  try {
    state = JSON.parse(fs.readFileSync(STATE, 'utf8'));
  } catch (e) {
    console.error('تعذّرت قراءة state.json: ' + (e && e.message));
    process.exitCode = 1;
    return;
  }

  state.baseline = state.baseline || {};
  state.baseline.engines_on_owner_machine = Object.assign({}, engines, { _updated: today() });

  // كتابة ذرّية أفضل جهد (نمط المستودع): temp ثم rename
  const tmp = STATE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, STATE);
  console.log('');
  console.log('كُتب في docs/radar/state.json → baseline.engines_on_owner_machine (‏_updated: ' + today() + ')');
}

main().catch((error) => {
  console.error(error && error.stack || error);
  process.exitCode = 1;
});
