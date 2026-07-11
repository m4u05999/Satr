// <satr-chat> — خيط المحادثة (تفكيك ت-12 — آخر المكوّنات قبل التنظيف النهائي).
// **بلا Shadow DOM** (قرار خطة التفكيك §2/3): البث يعيد بناء innerHTML مع كل جزء،
// أزرار النسخ تُحقن بعد اكتمال الدور، وبطاقات diff/الوكلاء تُبنى من مسارات متعددة —
// العزل هنا خطر بلا فائدة. الأنماط تبقى في base.css (light DOM)، والمكوّن غلاف
// display:contents يبني <main> بداخله فيبقى ابناً مباشراً لعمود body (نمط الطرفية ت-9).
//
// العقد للخارج (تستدعيه القشرة وقت التفاعل — بعد تحميل الوحدات):
//   addUserMsg(text, images) · addNotice(text) · addNoticeBefore(text, beforeEl)
//   addStandaloneDiff(ev) · addHistoryAssistant(msg, label) · newAssistantBlock(label)
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
    return inp.file_path || inp.path || inp.command || inp.pattern || inp.query || inp.url || '';
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
    // مجموعة الإجراءات القابلة للطيّ: مخفية حتى أول أداة، وتنطوي عند انتهاء الدور
    const toolsWrap = document.createElement('div'); toolsWrap.className = 'tools-wrap';
    const toolsHead = document.createElement('div'); toolsHead.className = 'tools-head';
    const chev = document.createElement('span'); chev.className = 'chev'; chev.textContent = '▼';
    const toolsLabel = document.createElement('span'); toolsLabel.textContent = 'الإجراءات';
    toolsHead.appendChild(chev); toolsHead.appendChild(toolsLabel);
    const tools = document.createElement('div'); tools.className = 'tools';
    toolsWrap.appendChild(toolsHead); toolsWrap.appendChild(tools);
    toolsWrap.style.display = 'none';
    toolsHead.addEventListener('click', () => toolsWrap.classList.toggle('collapsed'));
    let toolCount = 0;
    // بطاقات الوكلاء الفرعيين (المرحلة 14.2): أداة الإطلاق (Task/Agent) تصير بطاقة،
    // وكل ما يصل بـ parent_tool_use_id يتوجّه داخلها (أدوات متداخلة + سجل نصي حي)
    const agentsFlow = document.createElement('div'); agentsFlow.className = 'agents-flow';
    const agentCards = {}; // tool_use_id للإطلاق → { el, tools, text, buf }
    const diffs = document.createElement('div'); diffs.className = 'diffs';
    const bubble = document.createElement('div'); bubble.className = 'bubble';
    const md = document.createElement('div'); md.className = 'md'; md.dir = 'auto';
    bubble.appendChild(md); bubble.style.display = 'none';
    const status = document.createElement('div');
    status.className = 'thinking'; status.textContent = 'يعمل';
    w.appendChild(toolsWrap); w.appendChild(agentsFlow); w.appendChild(diffs); w.appendChild(bubble); w.appendChild(status);
    thread.appendChild(w); scrollDown();

    let fullText = '';
    let partial = '';      // نص جزئي يصل حرفاً بحرف من بث SDK
    let lastRender = 0;
    const toolEls = {};
    function renderNow() {
      bubble.style.display = '';
      md.innerHTML = renderMD(partial ? (fullText ? fullText + '\n\n' + partial : partial) : fullText);
      scrollDown();
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
      agentCards[id] = { el: card, tools: nested, text, buf: '' };
      if (id) toolEls[id] = card; // toolDone يعلّم البطاقة ✓/✗ عبر .state داخلها
    }

    return {
      el: w, // جذر البطاقة — لإدراج تنبيهات قبل الرد (تنبيه 📎 الحقن مثلاً)
      addText(t, parentId) {
        // نص وكيل فرعي (forwardSubagentText) ⇐ سجل بطاقته المتداخل لا النص الرئيسي
        const card = parentId ? agentCards[parentId] : null;
        if (card) {
          card.buf += (card.buf ? '\n\n' : '') + t;
          card.text.innerHTML = renderMD(card.buf);
          card.text.scrollTop = card.text.scrollHeight;
          scrollDown();
          return;
        }
        // الرسالة المكتملة تحل محل النص الجزئي المتراكم لنفس الكتلة
        partial = '';
        fullText += (fullText ? '\n\n' : '') + t;
        renderNow();
      },
      addDelta(t) {
        partial += t;
        const now = Date.now();
        if (now - lastRender > 80) { lastRender = now; renderNow(); } // خنق إعادة الرسم
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
        if (card) {
          // أداة متداخلة من وكيل فرعي ⇐ داخل بطاقة وكيلها، ملتصقة بآخر إجراء
          card.tools.appendChild(el);
          card.tools.scrollTop = card.tools.scrollHeight;
        } else {
          tools.appendChild(el);
          // إظهار المجموعة عند أول أداة + تحديث العدّاد + التصاق القائمة بآخر إجراء
          toolCount++;
          toolsLabel.textContent = 'الإجراءات (' + toolCount + ')';
          toolsWrap.style.display = '';
          tools.scrollTop = tools.scrollHeight;
        }
        scrollDown();
      },
      toolDone(id, isError) {
        const el = toolEls[id];
        if (!el) return;
        el.classList.add('done');
        el.querySelector('.state').textContent = isError ? '✗' : '✓';
        if (isError) el.querySelector('.state').style.color = 'var(--red)';
      },
      addDiff(ev) {
        diffs.appendChild(bDiff(ev));
        scrollDown();
      },
      // بطاقة نتيجة ضغط المحادثة (/ضغط): من X رمز ← Y رمز
      compacted(meta) {
        status.remove();
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
        w.appendChild(card); scrollDown();
      },
      finish(resultObj) {
        status.remove();
        // انتهى الدور: تُطوى قائمة الإجراءات لملخص سطر واحد (الرأس بعدّاده يبقى)
        if (toolCount) toolsWrap.classList.add('collapsed');
        // أزرار النسخ تُحقن بعد اكتمال النص (البث يعيد بناء innerHTML فيضيعها)
        if (fullText) { addCodeCopyButtons(md); addMsgCopy(who, () => fullText); }
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
        status.remove();
        const e = document.createElement('div');
        e.className = 'error-box'; e.dir = 'auto'; e.textContent = text;
        w.appendChild(e); scrollDown();
      },
      stopped() {
        // إزالة مؤشر «يعمل» عند الإيقاف اليدوي — آمنة للاستدعاء المتكرر
        status.remove();
        if (toolCount) toolsWrap.classList.add('collapsed');
        if (fullText || partial) { addCodeCopyButtons(md); addMsgCopy(who, () => fullText || partial); }
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
      w.appendChild(tools);
    }
    if (msg.text) {
      const bubble = document.createElement('div'); bubble.className = 'bubble';
      const md = document.createElement('div'); md.className = 'md'; md.dir = 'auto';
      md.innerHTML = renderMD(msg.text);
      bubble.appendChild(md); w.appendChild(bubble);
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
    totalCost = 0;
    $('costInfo').textContent = '';
    thread.innerHTML = '<div class="empty" id="empty"><div class="big">سطر</div><p>جلسة جديدة — اكتب طلبك الأول.</p></div>';
  }
  // تفريغ الخيط لاستئناف محادثة محوّل (نظير reset دون حالة الفراغ — التاريخ سيُبنى فوراً)
  function clearThread() {
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
    this.newAssistantBlock = newAssistantBlock;
    this.reset = reset;
    this.clearThread = clearThread;
    this.scrollToEnd = scrollDown;
    this.notifyTurnDone = notifyTurnDone;
    this.toolDetail = toolDetail;
  }
}

customElements.define('satr-chat', SatrChat);
