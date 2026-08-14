/**
 * سطر — حارس اللغة بوضع الظلّ (‏OBS-001، الدفعة 5 — بقرار مالك 2026-08-15).
 *
 * **ظلٌّ لا حَكَم**: يقيس نثر رسائل المساعد المكتملة بـ`langmetric.isSlip` ويسجّل
 * **أرقاماً فقط** في `~/.satr/lang-shadow.jsonl` — لا يعرض شيئاً للمستخدم ولا
 * يعيد توليداً ولا يترجم (ممنوعات العصف المجمَّدة). بعد أسبوع ظلٍّ تُقرأ حصيلته
 * بـ`scripts/lang-shadow-report.js` وتُعايَر العتبات على بيانات حقيقية، ثم يقرر
 * المالك الانتقال إلى العرض (زر «أعد الصياغة بالعربية» — اقتراح كيمي).
 *
 * قرارات العصف الملزمة هنا:
 * - **الرسالة المكتملة فقط** (أحداث `assistant`) — لا شظايا `stream_text`.
 * - **نقطة اختناق واحدة** (‏`emitToWindow` في `main.js`) — لا أربع نسخ في المحرّكات.
 * - **لا نص في السجل إطلاقاً**: `share/reason/strong/engine/phase` أرقام ووسوم —
 *   نص المستخدم أو المساعد في ملف مراقبة يتحول تسريباً.
 * - أفضل جهد مطلق: أي فشل قرص يُبتلع ولا يمسّ الدور.
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { isSlip, METRIC_VERSION } = require('./langmetric');

const DEFAULT_FILE = path.join(os.homedir(), '.satr', 'lang-shadow.jsonl');
const MAX_FILE_BYTES = 512 * 1024;
const KEEP_TAIL_LINES = 2000;
const SAFE_ENGINE = /^[a-z0-9_-]{1,32}$/i;
const PHASES = new Set(['final_answer', 'commentary']);

function createShadow(options) {
  const opts = options && typeof options === 'object' ? options : {};
  const file = typeof opts.file === 'string' && opts.file ? opts.file : DEFAULT_FILE;
  const io = opts.fs || fs;

  /** قصّ الملف إلى ذيله عند تجاوز السقف — سجل ظلّ لا أرشيف. */
  function trimIfNeeded() {
    try {
      const stat = io.statSync(file);
      if (stat.size <= MAX_FILE_BYTES) return;
      const lines = io.readFileSync(file, 'utf8').split('\n').filter(Boolean);
      const tail = lines.slice(-KEEP_TAIL_LINES).join('\n') + '\n';
      const temp = file + '.tmp-' + process.pid;
      io.writeFileSync(temp, tail, 'utf8');
      io.renameSync(temp, file);
    } catch { /* أفضل جهد */ }
  }

  /**
   * يقيس نص رسالة مساعد مكتملة ويسجّل السطر. يعيد الحكم للفحص لا للعرض.
   * @param {{text:string, engine?:string, phase?:string}} entry
   */
  function record(entry) {
    if (!entry || typeof entry.text !== 'string' || !entry.text) return null;
    let verdict;
    try { verdict = isSlip(entry.text); } catch { return null; }
    // الردود القصيرة والكودية خارج الحكم — تسجيلها ضجيج يغرق التقرير
    if (verdict.reason === 'short' || verdict.reason === 'no_prose') return verdict;
    const row = {
      at: Date.now(),
      v: METRIC_VERSION,
      engine: SAFE_ENGINE.test(String(entry.engine || '')) ? entry.engine : 'unknown',
      phase: PHASES.has(entry.phase) ? entry.phase : 'final_answer',
      share: verdict.share === null ? null : Math.round(verdict.share * 1000) / 1000,
      strong: verdict.arabic + verdict.latin,
      slip: verdict.slip === true,
      reason: verdict.reason,
    };
    try {
      io.mkdirSync(path.dirname(file), { recursive: true });
      io.appendFileSync(file, JSON.stringify(row) + '\n', 'utf8');
      trimIfNeeded();
    } catch { /* فشل القرص لا يمسّ الدور */ }
    return verdict;
  }

  return { record, file };
}

const shadow = createShadow();

module.exports = {
  record: shadow.record,
  file: shadow.file,
  createShadow,
  MAX_FILE_BYTES,
  KEEP_TAIL_LINES,
};
