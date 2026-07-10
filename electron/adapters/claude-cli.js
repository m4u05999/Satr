/**
 * محوّل Claude CLI (المسار الاحتياطي) — نُقل من main.js في المرحلة 5أ دون تغيير سلوك.
 *
 * يشغّل `claude -p --output-format stream-json --verbose` ويبثّ أسطر JSON مفسَّرة عبر
 * emit كأحداث satr:event خام (الواجهة تفهمها مباشرةً — نفس عقد Claude Code).
 *
 * الواجهة الموحّدة للمحوّلات: start(input, cwd, emit) → { stop() }
 *  - input: حقول **مُنقّاة مسبقاً في main.js** (القاعدة 2: التحقق في العملية الرئيسية).
 *  - emit(obj): يبثّ حدثاً للواجهة (مقيَّد بـ runSeq في main.js).
 *  - stop(): يُنهي العملية ويعيد Promise (نمط agent.start().stop()).
 */

const { spawn } = require('child_process');

const IS_WIN = process.platform === 'win32';
const CLAUDE_BIN = process.env.CLAUDE_BIN || 'claude';

// input.{prompt, sessionId, model, permissionMode} مُنقّاة في main.js:
//   sessionId مطابق SAFE_SESSION أو null، model مطابق SAFE_MODEL أو null،
//   permissionMode ضمن PERMISSION_MODES (الافتراضي 'default').
function start(input, cwd, emit) {
  const { prompt, sessionId, model, permissionMode } = input;

  const args = ['-p', '--output-format', 'stream-json', '--verbose'];
  if (sessionId) args.push('--resume', sessionId);
  if (permissionMode && permissionMode !== 'default') args.push('--permission-mode', permissionMode);
  if (model) args.push('--model', model);

  // detached على ويندوز = DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP: الطفل يأخذ
  // مجموعة عمليات وكونسولاً خاصّين به، فأي حدث تحكّم كونسول من خادم تطوير أو غيره
  // يبقى محبوساً في شجرته ولا يصل «سطر» ولا الطرفيات الأخرى. windowsHide يمنع وميض
  // نافذة كونسول. لا نستدعي unref لأننا نقرأ stdout ونديره.
  const child = spawn(CLAUDE_BIN, args, { cwd, shell: IS_WIN, detached: IS_WIN, windowsHide: true });

  // البرومبت عبر stdin لتجنب مشاكل الاقتباس
  child.stdin.write(prompt, 'utf8');
  child.stdin.end();

  // تجزئة المخرجات إلى أسطر JSON وإرسالها للواجهة مفسَّرة
  let buf = '';
  child.stdout.on('data', (d) => {
    buf += d.toString('utf8');
    let idx;
    while ((idx = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 1);
      if (!line) continue;
      try { emit(JSON.parse(line)); } catch (e) { /* سطر غير JSON — نتجاهله */ }
    }
  });
  child.stderr.on('data', (d) => emit({ type: 'stderr', text: d.toString('utf8') }));
  child.on('error', (e) => emit({ type: 'spawn_error', text: String(e && e.message) }));
  child.on('close', (code) => emit({ type: 'proc_done', code }));

  return {
    // إيقاف العملية — يعيد Promise ليوحّد مع agent.start().stop()
    stop() {
      return new Promise((resolve) => {
        if (!child || child.killed || child.exitCode !== null || !child.pid) return resolve();
        if (IS_WIN) {
          // child.pid هو cmd.exe (shell:true)، وهو قائد مجموعة عمليات معزولة (detached)
          // ولها كونسولها الخاص. taskkill /T يقتل الشجرة كاملة (cmd + claude + أحفادها)
          // نزولاً فقط — ثبت أنه لا يصعد لـ«سطر» (الأب) ولا يسرّب حدثاً للكونسول المشترك.
          const tk = spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true });
          tk.on('error', () => resolve());
          tk.on('close', () => resolve());
        } else {
          try { child.kill('SIGTERM'); } catch (e) {}
          resolve();
        }
      });
    },
  };
}

module.exports = { start };
