// <satr-chat> — خيط المحادثة (تفكيك ت-12 — آخر المكوّنات قبل التنظيف النهائي).
// **بلا Shadow DOM** (قرار خطة التفكيك §2/3): البث يعيد بناء innerHTML مع كل جزء،
// أزرار النسخ تُحقن بعد اكتمال الدور، وبطاقات diff/الوكلاء تُبنى من مسارات متعددة —
// العزل هنا خطر بلا فائدة. الأنماط تبقى في base.css (light DOM)، والمكوّن غلاف
// display:contents يبني <main> بداخله فيبقى ابناً مباشراً لعمود body (نمط الطرفية ت-9).
//
// العقد للخارج (تستدعيه القشرة وقت التفاعل — بعد تحميل الوحدات):
//   addUserMsg(text, images) · addNotice(text) · addNoticeBefore(text, beforeEl)
//   addStandaloneDiff(ev) · addHistoryAssistant(msg, label) · newAssistantBlock(label)
//   showTaskLedger(ledger) · clearTaskLedger()
//   showCheckpoint(checkpoint) · showVerification(result) · clearCheckpoint()
//   reset() «جلسة جديدة» · clearThread() «استئناف محوّل» · scrollToEnd(force)
//   notifyTurnDone(isError) · toolDetail(input)
//
// **قرار تنفيذ موثّق (ت-12)**: مجرى أحداث satr:event يبقى orchestration في القشرة
// (يلمس sessionId/busy/currentBlock) ويستدعي methods كتلة الرد التي يعيدها
// newAssistantBlock — نفس عقد الكتلة الحرفي (addText/addDelta/addTool/toolDone/
// addDiff/compacted/finish/error/stopped/done). deadSessionRecovery بقيت في القشرة
// كذلك (تلمس sessionId/sessionCwd/المحرّر — حالة قشرة لا عرض محادثة). عدّاد الكلفة
// التراكمي صار داخل المكوّن ويكتب #costInfo (عنصر شريط الحالة في footer المؤلّف —
// light DOM مشترك يصله getElementById). اسم المحرك المعروض يصل وسيطاً label
// (engineLabel تبقى في القشرة — تقرأ providersCache ومنتقي المحرك).
import { buildDiff } from '../lib/diff.js';
import { diffSheet } from '../lib/diff.css.js';

// حسم ازدواج أنماط بطاقة الفرق (الموثّق منذ ت-5): نسخة base.css حُذفت مع هذه الدفعة،
// وdiffSheet تُعتمد هنا على **المستند** نفسه (adoptedStyleSheets على المستند — تحقق §1
// من الخطة) فتخدم بطاقات light DOM في هذا الخيط، وبطاقات Shadow DOM في لوحة git
// وعارض الملفات، من مصدر واحد. أوراق المستند المعتمدة تُطبَّق بعد أوراق <link>
// فالترتيب التعاقبي كما كان (قسم الفرق كان آخر أقسام base.css المؤثرة هنا).
document.adoptedStyleSheets = [...document.adoptedStyleSheets, diffSheet];

const MARKUP = `
<main id="main">
  <div class="thread" id="thread">
    <div class="empty" id="empty">
      <div class="big">سطر</div>
      <p>تطبيق عربي لـ Claude Code — اكتب بالعربية وكل شيء يظهر بالاتجاه الصحيح.</p>
      <div class="hints">
        <span><kbd>/</kbd> قائمة الأوامر (في بداية السطر)</span>
        <span><kbd>@</kbd> إدراج ملف من المشروع</span>
        <span><kbd>Ctrl+V</kbd> لصق صورة من الحافظة</span>
        <span><kbd>🖥️</kbd> الطرفية المدمجة (من الشريط العلوي)</span>
      </div>
    </div>
  </div>
  <button id="jumpDown" type="button" hidden>⬇ الأحدث</button>
</main>
`;

class SatrChat extends HTMLElement {
  connectedCallback() {
    if (this._wired) return; // اتصال متكرر لا يعيد البناء
    this._wired = true;
    this.innerHTML = MARKUP;
    const $ = (id) => document.getElementById(id);
    const main = $('main'), thread = $('thread');
    let totalCost = 0; // الكلفة التراكمية للجلسة — يصفّرها reset/clearThread

// ما يلي منقول حرفياً من القشرة (المراحل 2–4 + دفعة UX) — بلا أي تغيير سلوك
  // ---------- ماركداون مدمج آمن (بدون مكتبات خارجية) ----------
  function esc(s) {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }
  function inlineMD(s) {
    return esc(s)
      .replace(/`([^`]+)`/g, '<code>$1</code>')
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
      .replace(/(^|\s)\*([^*\n]+)\*(?=\s|$)/g, '$1<em>$2</em>');
  }
  // فاصل أفقي: --- أو *** أو ___ (لا يتعارض مع القوائم: علامتها يليها فراغ)
  const HR_RE = /^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/;
  // سطر فاصل رأس الجدول: |---|:---:|--- إلخ
  const TSEP_RE = /^\s*\|?\s*:?-{2,}:?\s*(?:\|\s*:?-{2,}:?\s*)+\|?\s*$/;
  // بداية جدول: سطر فيه | يليه سطر فاصل
  function isTableStart(lines, i) {
    return lines[i].includes('|') && i + 1 < lines.length && TSEP_RE.test(lines[i + 1]);
  }
  // تقسيم صف الجدول إلى خلايا (يتسامح مع | البادئة/الذيلية)
  function splitRow(s) {
    let t = s.trim();
    if (t.startsWith('|')) t = t.slice(1);
    if (t.endsWith('|')) t = t.slice(0, -1);
    return t.split('|').map((c) => c.trim());
  }
  function renderMD(text) {
    const out = [];
    const lines = text.split('\n');
    let i = 0;
    while (i < lines.length) {
      const line = lines[i];
      if (line.startsWith('```')) {                       // كتلة كود
        const buf = [];
        i++;
        while (i < lines.length && !lines[i].startsWith('```')) { buf.push(lines[i]); i++; }
        i++;
        out.push('<pre><code>' + esc(buf.join('\n')) + '</code></pre>');
      } else if (/^#{1,3}\s/.test(line)) {                // عناوين
        const lvl = line.match(/^#+/)[0].length;
        out.push('<h' + lvl + '>' + inlineMD(line.replace(/^#+\s*/, '')) + '</h' + lvl + '>');
        i++;
      } else if (HR_RE.test(line)) {                      // فاصل أفقي
        out.push('<hr>');
        i++;
      } else if (isTableStart(lines, i)) {                // جدول أنابيب
        const head = splitRow(lines[i]);
        i += 2; // تخطي الرأس وسطر الفاصل
        // الخلايا بأساس RTL ثابت من CSS (لا <bdi>): خلية تبدأ بإنجليزية كانت تنقلب
        // LTR وتلتصق يساراً فيتشتت الجدول — الإنجليزية تنضمّ داخل الأساس RTL طبيعياً
        let html = '<table><thead><tr>' +
          head.map((c) => '<th>' + inlineMD(c) + '</th>').join('') + '</tr></thead><tbody>';
        while (i < lines.length && lines[i].trim() !== '' && lines[i].includes('|') && !HR_RE.test(lines[i])) {
          const cells = splitRow(lines[i]);
          html += '<tr>' + cells.map((c) => '<td>' + inlineMD(c) + '</td>').join('') + '</tr>';
          i++;
        }
        out.push(html + '</tbody></table>');
      } else if (/^\s*[-*]\s+/.test(line)) {              // قائمة نقطية
        const items = [];
        // <bdi> يحلّ اتجاه نص العنصر وحده ويعزله عن صندوق العلامة (انظر CSS القائمة)
        while (i < lines.length && /^\s*[-*]\s+/.test(lines[i])) {
          items.push('<li><bdi>' + inlineMD(lines[i].replace(/^\s*[-*]\s+/, '')) + '</bdi></li>'); i++;
        }
        out.push('<ul>' + items.join('') + '</ul>');
      } else if (/^\s*\d+[.)]\s+/.test(line)) {           // قائمة مرقمة
        const items = [];
        while (i < lines.length && /^\s*\d+[.)]\s+/.test(lines[i])) {
          items.push('<li><bdi>' + inlineMD(lines[i].replace(/^\s*\d+[.)]\s+/, '')) + '</bdi></li>'); i++;
        }
        out.push('<ol>' + items.join('') + '</ol>');
      } else if (line.trim() === '') {
        i++;
      } else {                                            // فقرة
        const buf = [];
        while (i < lines.length && lines[i].trim() !== '' &&
               !/^(```|#{1,3}\s|\s*[-*]\s+|\s*\d+[.)]\s+)/.test(lines[i]) &&
               !HR_RE.test(lines[i]) && !isTableStart(lines, i)) {
          buf.push(inlineMD(lines[i])); i++;
        }
        out.push('<p>' + buf.join('<br>') + '</p>');
      }
    }
    return out.join('');
  }

  // الالتصاق الذكي بالذيل (دفعة UX — نفس منطق pinned في الطرفية): البث لا يسحب
  // المستخدم للأسفل إن مرّر لأعلى ليقرأ؛ زر «⬇ الأحدث» يعيد الالتصاق.
  let chatPinned = true;
  const jumpDown = $('jumpDown');
  function scrollDown(force) {
    if (force) chatPinned = true;
    if (chatPinned) main.scrollTop = main.scrollHeight;
  }
  main.addEventListener('scroll', () => {
    chatPinned = main.scrollTop + main.clientHeight >= main.scrollHeight - 48;
    jumpDown.hidden = chatPinned;
  });
  jumpDown.addEventListener('click', () => { scrollDown(true); jumpDown.hidden = true; });
  function hideEmpty() { const e = $('empty'); if (e) e.remove(); }

  // ---------- أزرار النسخ (دفعة UX) ----------
  // نسخ للحافظة مع تأكيد بصري قصير على الزر نفسه
  async function copyWithFeedback(btn, text) {
    try { await navigator.clipboard.writeText(text); btn.textContent = '✓'; }
    catch (e) { btn.textContent = '✗'; }
    setTimeout(() => { btn.textContent = 'نسخ'; }, 1200);
  }
  // حقن زر نسخ لكل كتلة كود داخل md — بعد اكتمال الدور لا أثناء البث
  // (innerHTML يعاد بناؤه مع كل جزء بثّي فتضيع الأزرار المحقونة أثناءه)
  function addCodeCopyButtons(mdEl) {
    for (const pre of mdEl.querySelectorAll('pre')) {
      if (pre.querySelector('.code-copy')) continue;
      const b = document.createElement('button');
      b.type = 'button'; b.className = 'code-copy'; b.textContent = 'نسخ'; b.title = 'نسخ الكود';
      // النص من <code> لا <pre> — حتى لا يدخل نص الزر نفسه في المنسوخ
      b.addEventListener('click', () => copyWithFeedback(b, (pre.querySelector('code') || pre).innerText));
      pre.appendChild(b);
    }
  }
  // زر نسخ الرسالة كاملة في سطر «من» (يظهر عند التحويم)
  function addMsgCopy(whoEl, getText) {
    if (!whoEl || whoEl.querySelector('.msg-copy')) return;
    const b = document.createElement('button');
    b.type = 'button'; b.className = 'msg-copy'; b.textContent = 'نسخ'; b.title = 'نسخ نص الرسالة';
    b.addEventListener('click', () => copyWithFeedback(b, getText()));
    whoEl.appendChild(b);
  }

  function addUserMsg(text, images) {
    hideEmpty();
    const w = document.createElement('div');
    w.className = 'msg user';
    w.innerHTML = '<div class="who">أنت</div>';
    if (text) {
      const b = document.createElement('div');
      b.className = 'bubble'; b.textContent = text;
      w.appendChild(b);
      addMsgCopy(w.querySelector('.who'), () => text);
    }
    if (images && images.length) {
      const ic = document.createElement('div'); ic.className = 'imgs';
      for (const src of images) {
        const im = document.createElement('img');
        im.src = src; im.alt = 'صورة مرفقة';
        ic.appendChild(im);
      }
      w.appendChild(ic);
    }
    thread.appendChild(w); scrollDown(true); // إرسال المستخدم يعيد الالتصاق دائماً
  }

  // بطاقة فرق مستقلة عن الدور (حفظ من عارض القراءة — الدفعة 4): نفس buildDiff
  // القائمة (طيّ + تراجع عبر editSnapshots) لكن خارج كتلة رسالة — توثيق مرئي للتعديل اليدوي
  function addStandaloneDiff(ev) {
    hideEmpty();
    const wrap = document.createElement('div');
    wrap.className = 'diffs';
    wrap.appendChild(bDiff(ev));
    thread.appendChild(wrap);
    scrollDown();
  }

  function addNotice(text) {
    hideEmpty();
    const n = document.createElement('div');
    n.className = 'notice'; n.textContent = text;
    thread.appendChild(n); scrollDown();
  }

  let taskLedgerEl = null;
  let taskLedgerSession = null;
  let taskLedgerCollapsed = true;
  try { taskLedgerCollapsed = localStorage.getItem('satr_ledger_collapsed') !== '0'; } catch (e) {}

  function taskStateText(state) {
    if (state === 'paused') return 'متوقفة';
    if (state === 'completed') return 'مكتملة';
    return 'قيد العمل';
  }

  function taskStatusIcon(status) {
    if (status === 'completed') return '✓';
    if (status === 'in_progress') return '●';
    if (status === 'blocked') return '⚠';
    return '○';
  }

  function clearTaskLedger() {
    if (taskLedgerEl && taskLedgerEl.parentNode) taskLedgerEl.remove();
    taskLedgerEl = null;
    taskLedgerSession = null;
  }

  function showTaskLedger(ledger) {
    if (!ledger || !Array.isArray(ledger.tasks) || ledger.tasks.length < 3) {
      clearTaskLedger();
      return;
    }
    hideEmpty();
    if (!taskLedgerEl || taskLedgerSession !== ledger.engine + ':' + ledger.session_id) {
      clearTaskLedger();
      taskLedgerEl = document.createElement('section');
      taskLedgerEl.className = 'task-ledger';
      taskLedgerSession = ledger.engine + ':' + ledger.session_id;
      thread.prepend(taskLedgerEl);
    }
    taskLedgerEl.className = 'task-ledger state-' + ledger.state;
    taskLedgerEl.classList.toggle('collapsed', taskLedgerCollapsed);
    taskLedgerEl.innerHTML = '';

    const completed = ledger.tasks.filter((task) => task.status === 'completed').length;
    const head = document.createElement('div'); head.className = 'task-ledger-head';
    const title = document.createElement('div'); title.className = 'task-ledger-title'; title.textContent = 'سجل المهام';
    const progressText = document.createElement('span'); progressText.className = 'task-ledger-progress-text'; progressText.dir = 'ltr';
    progressText.textContent = completed + '/' + ledger.tasks.length;
    const stateText = document.createElement('span'); stateText.className = 'task-ledger-state'; stateText.textContent = taskStateText(ledger.state);
    head.appendChild(title); head.appendChild(progressText); head.appendChild(stateText);

    const actions = document.createElement('div'); actions.className = 'task-ledger-actions';
    if (ledger.state !== 'completed') {
      const action = document.createElement('button'); action.type = 'button'; action.className = 'task-ledger-action';
      action.textContent = ledger.state === 'paused' ? '▶ استئناف الخطة' : '⏸ إيقاف الخطة';
      action.addEventListener('click', () => this.dispatchEvent(new CustomEvent('task-action', {
        bubbles: true,
        detail: { action: ledger.state === 'paused' ? 'resume' : 'pause', engine: ledger.engine, sessionId: ledger.session_id },
      })));
      actions.appendChild(action);
    }
    head.appendChild(actions);

    const toggle = document.createElement('button'); toggle.type = 'button'; toggle.className = 'task-ledger-toggle';
    const syncToggle = () => {
      toggle.textContent = taskLedgerCollapsed ? '▸' : '▾';
      toggle.title = taskLedgerCollapsed ? 'توسيع سجل المهام' : 'طي سجل المهام';
      toggle.setAttribute('aria-label', toggle.title);
      toggle.setAttribute('aria-expanded', String(!taskLedgerCollapsed));
    };
    syncToggle();
    toggle.addEventListener('click', () => {
      taskLedgerCollapsed = !taskLedgerCollapsed;
      taskLedgerEl.classList.toggle('collapsed', taskLedgerCollapsed);
      syncToggle();
      try { localStorage.setItem('satr_ledger_collapsed', taskLedgerCollapsed ? '1' : '0'); } catch (e) {}
    });
    head.appendChild(toggle);

    const track = document.createElement('div'); track.className = 'task-progress-track';
    const fill = document.createElement('div'); fill.className = 'task-progress-fill';
    fill.style.width = Math.round((completed / ledger.tasks.length) * 100) + '%';
    track.appendChild(fill);

    const list = document.createElement('div'); list.className = 'task-list';
    for (const task of ledger.tasks) {
      const item = document.createElement('article'); item.className = 'task-item status-' + task.status;
      const row = document.createElement('div'); row.className = 'task-row';
      const icon = document.createElement('span'); icon.className = 'task-status-icon'; icon.textContent = taskStatusIcon(task.status);
      const taskTitle = document.createElement('span'); taskTitle.className = 'task-title'; taskTitle.dir = 'auto'; taskTitle.textContent = task.title;
      row.appendChild(icon); row.appendChild(taskTitle);
      if (task.owner) {
        const owner = document.createElement('span'); owner.className = 'task-owner'; owner.textContent = task.owner;
        row.appendChild(owner);
      }
      item.appendChild(row);
      if (Array.isArray(task.dependencies) && task.dependencies.length) {
        const dependencies = document.createElement('div'); dependencies.className = 'task-dependencies';
        dependencies.textContent = 'يعتمد على: ' + task.dependencies.join('، '); dependencies.dir = 'auto';
        item.appendChild(dependencies);
      }
      if (Array.isArray(task.evidence) && task.evidence.length) {
        const details = document.createElement('details'); details.className = 'task-evidence';
        const summary = document.createElement('summary'); summary.textContent = 'دليل التحقق (' + task.evidence.length + ')';
        const evidenceList = document.createElement('ul');
        for (const evidence of task.evidence) {
          const evidenceItem = document.createElement('li'); evidenceItem.dir = 'auto'; evidenceItem.textContent = evidence.text || '';
          evidenceList.appendChild(evidenceItem);
        }
        details.appendChild(summary); details.appendChild(evidenceList); item.appendChild(details);
      }
      list.appendChild(item);
    }
    taskLedgerEl.appendChild(head); taskLedgerEl.appendChild(track); taskLedgerEl.appendChild(list);
    scrollDown();
  }

  let checkpointEl = null;
  let checkpointSession = null;

  function clearCheckpoint() {
    if (checkpointEl && checkpointEl.parentNode) checkpointEl.remove();
    checkpointEl = null;
    checkpointSession = null;
  }

  function checkpointStateText(state) {
    if (state === 'open') return 'يجمع التعديلات';
    if (state === 'passed') return 'تحقق ناجح';
    if (state === 'failed') return 'تحقق فاشل';
    if (state === 'restored') return 'استُعيد';
    if (state === 'partial') return 'استعادة جزئية';
    return 'جاهز';
  }

  function renderVerification(container, verification) {
    if (!verification || !Array.isArray(verification.checks)) return;
    const old = container.querySelector('.verification-result');
    if (old) old.remove();
    const wrap = document.createElement('section');
    wrap.className = 'verification-result ' + (verification.passed ? 'passed' : 'failed');
    const head = document.createElement('div'); head.className = 'verification-head';
    head.textContent = verification.passed ? '✓ نجح التحقق' : '✗ فشل التحقق';
    wrap.appendChild(head);
    for (const check of verification.checks) {
      const details = document.createElement('details'); details.className = 'verification-check';
      const summary = document.createElement('summary');
      summary.textContent = (check.passed ? '✓ ' : '✗ ') + (check.label || check.id || 'تحقق')
        + ' · exit ' + (check.exit_code == null ? '—' : check.exit_code);
      details.appendChild(summary);
      if (check.output) {
        const output = document.createElement('pre'); output.dir = 'ltr'; output.textContent = check.output;
        details.appendChild(output);
      } else if (check.output_sha256) {
        const digest = document.createElement('div'); digest.className = 'verification-digest'; digest.dir = 'ltr';
        digest.textContent = 'SHA-256 ' + check.output_sha256.slice(0, 12) + ' · ' + (check.output_bytes || 0) + ' bytes';
        details.appendChild(digest);
      }
      wrap.appendChild(details);
    }
    container.appendChild(wrap);
  }

  function showCheckpoint(checkpoint) {
    if (!checkpoint || !checkpoint.id) { clearCheckpoint(); return; }
    hideEmpty();
    const sessionKey = checkpoint.engine + ':' + checkpoint.session_id;
    if (!checkpointEl || checkpointSession !== sessionKey) {
      clearCheckpoint();
      checkpointEl = document.createElement('section'); checkpointEl.className = 'checkpoint-card';
      checkpointSession = sessionKey;
      if (taskLedgerEl && taskLedgerEl.parentNode === thread) taskLedgerEl.after(checkpointEl);
      else thread.prepend(checkpointEl);
    }
    checkpointEl.className = 'checkpoint-card state-' + checkpoint.state;
    checkpointEl.innerHTML = '';

    const head = document.createElement('div'); head.className = 'checkpoint-head';
    const title = document.createElement('strong'); title.textContent = 'Checkpoint الدور';
    const state = document.createElement('span'); state.className = 'checkpoint-state'; state.textContent = checkpointStateText(checkpoint.state);
    const meta = document.createElement('span'); meta.className = 'checkpoint-meta'; meta.dir = 'ltr';
    meta.textContent = (checkpoint.edit_count || 0) + ' edits' + (checkpoint.previous_id ? ' · prev ' + checkpoint.previous_id : '');
    head.appendChild(title); head.appendChild(state); head.appendChild(meta);

    const actions = document.createElement('div'); actions.className = 'checkpoint-actions';
    if (checkpoint.restorable) {
      const verifyButton = document.createElement('button'); verifyButton.type = 'button'; verifyButton.textContent = '✓ تشغيل التحقق';
      verifyButton.addEventListener('click', () => this.dispatchEvent(new CustomEvent('checkpoint-verify', {
        bubbles: true, detail: { engine: checkpoint.engine, sessionId: checkpoint.session_id, checkpointId: checkpoint.id },
      })));
      const restoreButton = document.createElement('button'); restoreButton.type = 'button'; restoreButton.className = 'checkpoint-restore';
      restoreButton.textContent = '↶ استعادة';
      restoreButton.addEventListener('click', () => this.dispatchEvent(new CustomEvent('checkpoint-restore', {
        bubbles: true, detail: { engine: checkpoint.engine, sessionId: checkpoint.session_id, checkpointId: checkpoint.id },
      })));
      actions.appendChild(verifyButton); actions.appendChild(restoreButton);
    }
    head.appendChild(actions); checkpointEl.appendChild(head);

    if (Array.isArray(checkpoint.files) && checkpoint.files.length) {
      const files = document.createElement('div'); files.className = 'checkpoint-files';
      for (const file of checkpoint.files.slice(0, 10)) {
        const row = document.createElement('div'); row.className = 'checkpoint-file'; row.dir = 'ltr';
        row.textContent = file.rel + '  +' + (file.added || 0) + ' −' + (file.removed || 0);
        files.appendChild(row);
      }
      checkpointEl.appendChild(files);
    }
    if (!checkpoint.restorable && checkpoint.state !== 'open' && checkpoint.state !== 'restored') {
      const expired = document.createElement('div'); expired.className = 'checkpoint-expired';
      expired.textContent = 'metadata محفوظة للمقارنة؛ لقطة الاستعادة الذاكرية غير متاحة بعد إعادة التشغيل.';
      checkpointEl.appendChild(expired);
    }
    renderVerification(checkpointEl, checkpoint.verification);
    scrollDown();
  }

  function showVerification(result) {
    if (checkpointEl && (!result.checkpoint_id || checkpointEl.querySelector('.checkpoint-head'))) {
      renderVerification(checkpointEl, result);
      scrollDown();
      return;
    }
    addNotice((result.passed ? '✓ ' : '✗ ') + (result.summary || 'اكتمل التحقق'));
  }

  // تنبيه يُدرج قبل عنصر معيّن في الخيط (تنبيهات حقن @ فوق بطاقة الرد لا في الذيل —
  // الدفعة 1.1)؛ beforeEl غير الموجود/المنزوع ⇐ إلحاق عادي بالذيل
  function addNoticeBefore(text, beforeEl) {
    const n = document.createElement('div');
    n.className = 'notice'; n.textContent = text;
    if (beforeEl && beforeEl.parentNode === thread) thread.insertBefore(n, beforeEl);
    else thread.appendChild(n);
  }

  // إشعار بزرّ فعل (م-1 — الدفعة 5): نص + زرّ ينفّذ معاودة (اقتراح «افتح المعاينة»)
  function addActionNotice(text, btnLabel, onAct) {
    hideEmpty();
    const n = document.createElement('div');
    n.className = 'notice';
    const t = document.createElement('span'); t.textContent = text;
    const b = document.createElement('button');
    b.type = 'button'; b.className = 'notice-act'; b.textContent = btnLabel;
    b.addEventListener('click', () => { try { onAct(); } catch (e) {} });
    n.appendChild(t); n.appendChild(b);
    thread.appendChild(n); scrollDown();
  }

  function toolDetail(inp) {
    if (!inp) return '';
    if (Array.isArray(inp.checks)) {
      return inp.checks.slice(0, 6).map((check) => typeof check === 'string'
        ? check : ((check && check.id ? check.id + ': ' : '') + ((check && check.command) || ''))).join(' · ');
    }
    // م-4: أدوات المعاينة (نقر/كتابة) — يُظهر مربع الإذن العنصر المستهدف
    return inp.file_path || inp.path || inp.command || inp.pattern || inp.query || inp.url ||
      inp.selector || '';
  }

  // بناء عنصر الفرق: وحدة ui/lib/diff.js المشتركة (ت-5) — استيراد مباشر منذ ت-12
  // (كان عبر جسر window.SatrUI أيام القشرة الكلاسيكية)
  function bDiff(ev) { return buildDiff(ev, addNotice); }

  // كتلة رد المساعد — تعيدها للقشرة بعقدها الحرفي (مجرى الأحداث يستدعي methods)
  function newAssistantBlock(label) {
    hideEmpty();
    const w = document.createElement('div');
    w.className = 'msg assistant';
    const who = document.createElement('div'); who.className = 'who';
    who.textContent = label || 'النموذج'; // نص لا HTML (اسم المحرك آمن لكن textContent أنظف)
    w.appendChild(who);

    // مسار العمل الحي: يجمع السرد المرحلي والتنفيذ والتغييرات في سجل واحد خفيف قابل للطي.
    const worklog = document.createElement('section'); worklog.className = 'worklog working collapsed';
    const workToggle = document.createElement('button');
    workToggle.type = 'button'; workToggle.className = 'worklog-toggle'; workToggle.setAttribute('aria-expanded', 'false');
    workToggle.disabled = true;
    const workDot = document.createElement('span'); workDot.className = 'work-dot';
    const workTitle = document.createElement('span'); workTitle.className = 'work-title'; workTitle.textContent = 'يستعد';
    workTitle.setAttribute('aria-live', 'polite');
    const workMeta = document.createElement('span'); workMeta.className = 'work-meta';
    const workChev = document.createElement('span'); workChev.className = 'work-chev'; workChev.textContent = '⌄';
    workToggle.appendChild(workDot); workToggle.appendChild(workTitle); workToggle.appendChild(workMeta); workToggle.appendChild(workChev);
    const workBody = document.createElement('div'); workBody.className = 'worklog-body';

    const commentaryWrap = document.createElement('section'); commentaryWrap.className = 'work-section commentary-wrap'; commentaryWrap.hidden = true;
    const commentaryHead = document.createElement('div'); commentaryHead.className = 'work-section-head'; commentaryHead.textContent = 'سجل التفكير';
    const commentaryMd = document.createElement('div'); commentaryMd.className = 'md commentary-md'; commentaryMd.dir = 'auto';
    commentaryWrap.appendChild(commentaryHead); commentaryWrap.appendChild(commentaryMd);

    const toolsWrap = document.createElement('section'); toolsWrap.className = 'work-section tools-wrap'; toolsWrap.hidden = true;
    const toolsHead = document.createElement('div'); toolsHead.className = 'work-section-head tools-head';
    const toolsLabel = document.createElement('span'); toolsLabel.textContent = 'الإجراءات';
    toolsHead.appendChild(toolsLabel);
    const tools = document.createElement('div'); tools.className = 'tools';
    toolsWrap.appendChild(toolsHead); toolsWrap.appendChild(tools);
    let toolCount = 0;

    // بطاقات الوكلاء الفرعيين (المرحلة 14.2): أداة الإطلاق (Task/Agent) تصير بطاقة،
    // وكل ما يصل بـ parent_tool_use_id يتوجّه داخلها (أدوات متداخلة + سجل نصي حي)
    const agentsWrap = document.createElement('section'); agentsWrap.className = 'work-section agents-wrap'; agentsWrap.hidden = true;
    const agentsHead = document.createElement('div'); agentsHead.className = 'work-section-head'; agentsHead.textContent = 'الوكلاء الفرعيون';
    const agentsFlow = document.createElement('div'); agentsFlow.className = 'agents-flow';
    agentsWrap.appendChild(agentsHead); agentsWrap.appendChild(agentsFlow);
    const agentCards = {}; // tool_use_id للإطلاق → { el, tools, text, buf }
    let agentCount = 0;

    const diffsWrap = document.createElement('section'); diffsWrap.className = 'work-section diffs-wrap'; diffsWrap.hidden = true;
    const diffsHead = document.createElement('div'); diffsHead.className = 'work-section-head'; diffsHead.textContent = 'التغييرات';
    const diffs = document.createElement('div'); diffs.className = 'diffs';
    diffsWrap.appendChild(diffsHead); diffsWrap.appendChild(diffs);

    workBody.appendChild(commentaryWrap); workBody.appendChild(toolsWrap); workBody.appendChild(agentsWrap); workBody.appendChild(diffsWrap);
    worklog.appendChild(workToggle); worklog.appendChild(workBody);

    // الإجابة النهائية لها سطح مستقل وواضح، بينما يبقى سجل العمل خفيفاً فوقها.
    const answerWrap = document.createElement('section'); answerWrap.className = 'answer-wrap'; answerWrap.hidden = true;
    const answerLabel = document.createElement('div'); answerLabel.className = 'answer-label'; answerLabel.textContent = 'الإجابة';
    const bubble = document.createElement('div'); bubble.className = 'bubble';
    const md = document.createElement('div'); md.className = 'md'; md.dir = 'auto';
    bubble.appendChild(md); answerWrap.appendChild(answerLabel); answerWrap.appendChild(bubble);
    w.appendChild(worklog); w.appendChild(answerWrap);
    thread.appendChild(w); scrollDown();

    const textState = {
      commentary: { full: '', partial: '' },
      final_answer: { full: '', partial: '' },
    };
    const lastRender = { commentary: 0, final_answer: 0 };
    let diffCount = 0;
    let hasActivity = false;
    let answerStarted = false;
    let manuallyCollapsed = false;
    const toolEls = {};

    function normalizePhase(phase) { return phase === 'commentary' ? 'commentary' : 'final_answer'; }
    function phaseText(phase) {
      const state = textState[phase];
      return state.partial ? (state.full ? state.full + '\n\n' + state.partial : state.partial) : state.full;
    }
    function setWorklogCollapsed(collapsed) {
      worklog.classList.toggle('collapsed', collapsed);
      workToggle.setAttribute('aria-expanded', String(!collapsed));
    }
    workToggle.addEventListener('click', () => {
      manuallyCollapsed = true;
      setWorklogCollapsed(!worklog.classList.contains('collapsed'));
    });
    function updateWorkMeta() {
      const parts = [];
      if (phaseText('commentary')) parts.push('سرد حي');
      if (toolCount) parts.push(toolCount + ' إجراء');
      if (agentCount) parts.push(agentCount + ' وكيل');
      if (diffCount) parts.push(diffCount + ' تغيير');
      workMeta.textContent = parts.join(' · ');
    }
    function revealActivity(title) {
      hasActivity = true;
      workToggle.disabled = false;
      workTitle.textContent = title;
      if (!manuallyCollapsed && !answerStarted) setWorklogCollapsed(false);
      updateWorkMeta();
    }
    function startAnswer() {
      if (answerStarted) return;
      answerStarted = true;
      answerWrap.hidden = false;
      worklog.classList.add('answering');
      workTitle.textContent = 'يصوغ الإجابة';
      if (hasActivity) setWorklogCollapsed(true);
    }
    function renderPhase(phase) {
      const text = phaseText(phase);
      if (phase === 'commentary') {
        commentaryWrap.hidden = false;
        commentaryMd.innerHTML = renderMD(text);
        revealActivity('يفكّر ويستكشف');
      } else {
        startAnswer();
        md.innerHTML = renderMD(text);
      }
      scrollDown();
    }
    function flushTextSurfaces() {
      const commentaryText = phaseText('commentary');
      const answerText = phaseText('final_answer');
      if (commentaryText) {
        commentaryWrap.hidden = false;
        commentaryMd.innerHTML = renderMD(commentaryText);
      }
      if (answerText) {
        answerWrap.hidden = false;
        md.innerHTML = renderMD(answerText);
      }
    }

    // إنشاء بطاقة وكيل فرعي عند استدعاء أداة الإطلاق (Task/Agent)
    function createAgentCard(id, inp) {
      const card = document.createElement('div');
      card.className = 'agent-card';
      const head = document.createElement('div');
      head.className = 'agent-head';
      head.innerHTML = '<span class="aname"></span><span class="adesc"></span><span class="state">⋯</span>';
      const type = (inp && (inp.subagent_type || inp.agent_type || '')) || '';
      head.querySelector('.aname').textContent = '🤖 وكيل فرعي' + (type ? ' · ' + type : '');
      head.querySelector('.adesc').textContent =
        (inp && (inp.description || (typeof inp.prompt === 'string' ? inp.prompt.split('\n')[0] : ''))) || '';
      const nested = document.createElement('div'); nested.className = 'agent-tools';
      const text = document.createElement('div'); text.className = 'agent-text';
      card.appendChild(head); card.appendChild(nested); card.appendChild(text);
      agentsFlow.appendChild(card);
      agentsWrap.hidden = false;
      agentCount++;
      revealActivity('ينسّق وكيلاً فرعياً');
      agentCards[id] = { el: card, tools: nested, text, buf: '' };
      if (id) toolEls[id] = card; // toolDone يعلّم البطاقة ✓/✗ عبر .state داخلها
    }

    return {
      el: w, // جذر البطاقة — لإدراج تنبيهات قبل الرد (تنبيه 📎 الحقن مثلاً)
      addText(t, parentId, phase) {
        // نص وكيل فرعي (forwardSubagentText) ⇐ سجل بطاقته المتداخل لا النص الرئيسي
        const card = parentId ? agentCards[parentId] : null;
        if (card) {
          card.buf += (card.buf ? '\n\n' : '') + t;
          card.text.innerHTML = renderMD(card.buf);
          card.text.scrollTop = card.text.scrollHeight;
          scrollDown();
          return;
        }
        // الرسالة المكتملة تحل محل النص الجزئي المتراكم للمرحلة نفسها فقط.
        const normalized = normalizePhase(phase);
        const state = textState[normalized];
        state.partial = '';
        state.full += (state.full ? '\n\n' : '') + t;
        renderPhase(normalized);
      },
      addDelta(t, phase) {
        const normalized = normalizePhase(phase);
        textState[normalized].partial += t;
        const now = Date.now();
        if (now - lastRender[normalized] > 80) {
          lastRender[normalized] = now;
          renderPhase(normalized);
        } // خنق إعادة الرسم لكل مرحلة على حدة
      },
      addTool(id, name, inp, parentId) {
        const card = parentId ? agentCards[parentId] : null;
        // إطلاق وكيل فرعي من الخيط الرئيسي ⇐ بطاقة وكيل (لا رقاقة عادية)
        if (!card && (name === 'Task' || name === 'Agent')) {
          createAgentCard(id, inp);
          scrollDown();
          return;
        }
        const el = document.createElement('div');
        el.className = 'tool';
        el.innerHTML = '<span class="name"></span><span class="detail"></span><span class="state">⋯</span>';
        el.querySelector('.name').textContent = name;
        el.querySelector('.detail').textContent = toolDetail(inp);
        if (id) toolEls[id] = el;
        toolCount++;
        toolsLabel.textContent = 'الإجراءات (' + toolCount + ')';
        if (card) {
          // أداة متداخلة من وكيل فرعي ⇐ داخل بطاقة وكيلها، ملتصقة بآخر إجراء
          card.tools.appendChild(el);
          card.tools.scrollTop = card.tools.scrollHeight;
        } else {
          tools.appendChild(el);
          toolsWrap.hidden = false;
          tools.scrollTop = tools.scrollHeight;
        }
        revealActivity('ينفّذ ' + name);
        scrollDown();
      },
      toolDone(id, isError) {
        const el = toolEls[id];
        if (!el) return;
        el.classList.add('done');
        el.querySelector('.state').textContent = isError ? '✗' : '✓';
        if (isError) el.classList.add('error');
        workTitle.textContent = isError ? 'واجه عائقاً ويتابع' : 'يتابع العمل';
      },
      addDiff(ev) {
        diffs.appendChild(bDiff(ev));
        diffsWrap.hidden = false;
        diffCount++;
        revealActivity('يراجع التغييرات');
        scrollDown();
      },
      // بطاقة نتيجة ضغط المحادثة (/ضغط): من X رمز ← Y رمز
      compacted(meta) {
        const fmt = (n) => (typeof n === 'number' ? n.toLocaleString('en-US') : '—');
        const card = document.createElement('div');
        card.className = 'compact-card';
        const ico = document.createElement('span'); ico.className = 'ico'; ico.textContent = '🗜';
        const label2 = document.createElement('span'); label2.textContent = 'ضُغطت المحادثة';
        card.appendChild(ico); card.appendChild(label2);
        if (meta && typeof meta.pre_tokens === 'number') {
          const nums = document.createElement('span'); nums.className = 'nums'; nums.dir = 'ltr';
          const from = document.createElement('span'); from.className = 'from'; from.textContent = fmt(meta.pre_tokens);
          const arr = document.createElement('span'); arr.className = 'arrow'; arr.textContent = '←';
          const to = document.createElement('span'); to.className = 'to';
          to.textContent = typeof meta.post_tokens === 'number' ? fmt(meta.post_tokens) : '…';
          nums.appendChild(from); nums.appendChild(arr); nums.appendChild(to);
          const unit = document.createElement('span'); unit.className = 'sub'; unit.textContent = 'رمز · المحادثة مستمرة';
          card.appendChild(nums); card.appendChild(unit);
        }
        workBody.appendChild(card);
        revealActivity('يضغط المحادثة');
        scrollDown();
      },
      finish(resultObj) {
        flushTextSurfaces();
        worklog.classList.remove('working', 'answering');
        worklog.classList.add(resultObj && resultObj.is_error ? 'failed' : 'done');
        workTitle.textContent = resultObj && resultObj.is_error ? 'اكتمل مع خطأ' : 'اكتمل العمل';
        if (hasActivity) setWorklogCollapsed(true);
        // أزرار النسخ تُحقن بعد اكتمال النص (البث يعيد بناء innerHTML فيضيعها).
        const answerText = phaseText('final_answer');
        const commentaryText = phaseText('commentary');
        if (answerText) addCodeCopyButtons(md);
        if (commentaryText) addCodeCopyButtons(commentaryMd);
        if (answerText || commentaryText) addMsgCopy(who, () => answerText || commentaryText);
        if (resultObj) {
          const cost = typeof resultObj.total_cost_usd === 'number' ? resultObj.total_cost_usd : 0;
          totalCost += cost;
          const dur = resultObj.duration_ms ? (resultObj.duration_ms / 1000).toFixed(1) + 's' : '';
          const m = document.createElement('div');
          m.className = 'meta';
          m.textContent = [dur, cost ? '$' + cost.toFixed(4) : ''].filter(Boolean).join(' · ');
          if (m.textContent) w.appendChild(m);
          $('costInfo').textContent = totalCost ? 'الكلفة: $' + totalCost.toFixed(4) : '';
        }
      },
      error(text) {
        worklog.classList.remove('working', 'answering');
        worklog.classList.add('failed');
        workTitle.textContent = 'تعذّر الإكمال';
        const e = document.createElement('div');
        e.className = 'error-box'; e.dir = 'auto'; e.textContent = text;
        w.appendChild(e); scrollDown();
      },
      stopped() {
        flushTextSurfaces();
        worklog.classList.remove('working', 'answering');
        worklog.classList.add('stopped');
        workTitle.textContent = 'توقّف العمل';
        if (hasActivity) setWorklogCollapsed(true);
        const answerText = phaseText('final_answer');
        const commentaryText = phaseText('commentary');
        if (answerText) addCodeCopyButtons(md);
        if (commentaryText) addCodeCopyButtons(commentaryMd);
        if (answerText || commentaryText) addMsgCopy(who, () => answerText || commentaryText);
        if (!w.querySelector('.stopped-note')) {
          const n = document.createElement('div');
          n.className = 'meta stopped-note';
          n.textContent = '⏹ تم إيقاف الطلب';
          w.appendChild(n);
        }
        scrollDown();
      },
      done: false,
    };
  }

  // رسالة مساعد تاريخية (من ملف الجلسة أو ذاكرة محوّل) — بدون مؤشر «يعمل» ولا حالة جارية
  function addHistoryAssistant(msg, label) {
    hideEmpty();
    const w = document.createElement('div');
    w.className = 'msg assistant';
    const whoEl = document.createElement('div');
    whoEl.className = 'who'; whoEl.textContent = label || 'Claude Code';
    w.appendChild(whoEl);
    const toolNames = Array.isArray(msg.tools) ? msg.tools : [];
    if (toolNames.length) {
      const worklog = document.createElement('details'); worklog.className = 'worklog history-worklog done';
      const summary = document.createElement('summary'); summary.className = 'worklog-toggle';
      const dot = document.createElement('span'); dot.className = 'work-dot';
      const title = document.createElement('span'); title.className = 'work-title'; title.textContent = 'سجل التنفيذ';
      const meta = document.createElement('span'); meta.className = 'work-meta'; meta.textContent = toolNames.length + ' إجراء';
      const chev = document.createElement('span'); chev.className = 'work-chev'; chev.textContent = '⌄';
      summary.appendChild(dot); summary.appendChild(title); summary.appendChild(meta); summary.appendChild(chev);
      const body = document.createElement('div'); body.className = 'worklog-body';
      const section = document.createElement('section'); section.className = 'work-section tools-wrap';
      const tools = document.createElement('div'); tools.className = 'tools';
      for (const name of toolNames.slice(0, 6)) {
        const t = document.createElement('div');
        t.className = 'tool done';
        t.innerHTML = '<span class="name"></span><span class="state">✓</span>';
        t.querySelector('.name').textContent = name;
        tools.appendChild(t);
      }
      if (toolNames.length > 6) {
        const more = document.createElement('div');
        more.className = 'tool done';
        more.textContent = '+' + (toolNames.length - 6) + ' أداة أخرى';
        tools.appendChild(more);
      }
      section.appendChild(tools); body.appendChild(section); worklog.appendChild(summary); worklog.appendChild(body); w.appendChild(worklog);
    }
    if (msg.text) {
      const answerWrap = document.createElement('section'); answerWrap.className = 'answer-wrap history-answer';
      const answerLabel = document.createElement('div'); answerLabel.className = 'answer-label'; answerLabel.textContent = 'الإجابة';
      const bubble = document.createElement('div'); bubble.className = 'bubble';
      const md = document.createElement('div'); md.className = 'md'; md.dir = 'auto';
      md.innerHTML = renderMD(msg.text);
      bubble.appendChild(md); answerWrap.appendChild(answerLabel); answerWrap.appendChild(bubble); w.appendChild(answerWrap);
      addCodeCopyButtons(md);
      addMsgCopy(w.querySelector('.who'), () => msg.text);
    }
    thread.appendChild(w);
  }

  // إشعار نظام عند اكتمال الدور والنافذة غير مركزة (دفعة UX) — «أرسل وانشغل وارجع».
  // Notification في عارض Electron مسموح افتراضياً، وAppUserModelId مضبوط في main.js
  // فيظهر التوست باسم «سطر» على ويندوز. النقر يعيد التركيز للنافذة.
  function notifyTurnDone(isError) {
    if (document.hasFocus()) return;
    try {
      const n = new Notification('سطر', {
        body: isError ? '✗ انتهى الطلب بخطأ' : '✓ اكتمل الرد — جاهز للمراجعة',
        silent: false,
      });
      n.onclick = () => { try { window.focus(); } catch (e) {} n.close(); };
    } catch (e) {} // فشل الإشعار لا يمس الدور
  }

  // «جلسة جديدة»: حالة فارغة + تصفير الكلفة التراكمية وشريطها
  function reset() {
    taskLedgerEl = null;
    taskLedgerSession = null;
    checkpointEl = null;
    checkpointSession = null;
    totalCost = 0;
    $('costInfo').textContent = '';
    thread.innerHTML = '<div class="empty" id="empty"><div class="big">سطر</div><p>جلسة جديدة — اكتب طلبك الأول.</p></div>';
  }
  // تفريغ الخيط لاستئناف محادثة محوّل (نظير reset دون حالة الفراغ — التاريخ سيُبنى فوراً)
  function clearThread() {
    taskLedgerEl = null;
    taskLedgerSession = null;
    checkpointEl = null;
    checkpointSession = null;
    totalCost = 0;
    $('costInfo').textContent = '';
    thread.innerHTML = '';
  }

    // ---------- الواجهة العامة (تستهلكها القشرة) ----------
    this.addUserMsg = addUserMsg;
    this.addNotice = addNotice;
    this.addNoticeBefore = addNoticeBefore;
    this.addActionNotice = addActionNotice;
    this.addStandaloneDiff = addStandaloneDiff;
    this.addHistoryAssistant = addHistoryAssistant;
    this.showTaskLedger = showTaskLedger;
    this.clearTaskLedger = clearTaskLedger;
    this.showCheckpoint = showCheckpoint;
    this.showVerification = showVerification;
    this.clearCheckpoint = clearCheckpoint;
    this.newAssistantBlock = newAssistantBlock;
    this.reset = reset;
    this.clearThread = clearThread;
    this.scrollToEnd = scrollDown;
    this.notifyTurnDone = notifyTurnDone;
    this.toolDetail = toolDetail;
  }
}

customElements.define('satr-chat', SatrChat);
