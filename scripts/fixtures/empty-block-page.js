// إعادة إنتاج OBS-142: دورٌ يُعرض فارغاً مع «اكتمل العمل» بينما نصّه موجود.
//
// يُشغّل مكوّن chat الإنتاجي ويُعيد **شكل الدور المعطوب حرفياً**: نصوصٌ مشبوكة
// بأدوات كثيرة ثم `finish`. الغاية عزلُ الشرط الذي يُفرغ الكتلة بصرياً، لا تأكيدُ
// فرضية — فقد سقطت فرضيتان قبله (إعادة الإطلاق، وإنشاء كتلة وسط الدور).

const violations = [];
window.addEventListener('securitypolicyviolation', (event) => {
  violations.push({ directive: event.effectiveDirective, blockedURI: event.blockedURI });
});

function assert(condition, message) { if (!condition) throw new Error(message); }

// ما يراه المستخدم فعلاً في الكتلة: نصُّ سطح الإجابة، وهل هو ظاهر أصلاً.
function visibleAnswer(block) {
  const w = block.el;
  const answer = w.querySelector('.answer-wrap');
  const worklog = w.querySelector('.worklog');
  const commentary = w.querySelector('.commentary-wrap');
  const shown = (el) => !!el && !el.hidden && getComputedStyle(el).display !== 'none'
    && el.getBoundingClientRect().height > 0;
  // بطاقات الأدوات سطحٌ مرئي ثالث — إغفالُها يجعل «فارغ بصرياً» يشتعل زوراً على
  // كتلةٍ تعرض إجراءاتها فعلاً (وقع في أول قياس).
  const toolCards = Array.from(w.querySelectorAll('.tool')).filter(shown);
  return {
    answerExists: !!answer,
    answerShown: shown(answer),
    answerText: answer ? answer.textContent.trim() : '',
    commentaryShown: shown(commentary),
    commentaryText: commentary ? commentary.textContent.trim() : '',
    visibleToolCards: toolCards.length,
    worklogCollapsed: !!worklog && worklog.classList.contains('collapsed'),
    blockText: w.textContent.replace(/\s+/g, ' ').trim(),
  };
}

document.addEventListener('DOMContentLoaded', async () => {
  const out = { scenarios: {}, violations };
  try {
    await customElements.whenDefined('satr-chat');
    const chat = document.querySelector('satr-chat');

    // ── (أ) شكل الدور المعطوب: نصّ + أدوات كثيرة + نصّ ختامي ثم finish ──────────
    // النصوص كلها بلا وسم phase — كما تصل من `addText` حين يغيب الوسم.
    {
      chat.addUserMsg('لماذا لا تقوم باستخدام الطرفية');
      const b = chat.newAssistantBlock('Claude Code');
      b.addText('محقّ، وهذا خطأي. القاعدة عندك صريحة.');
      b.addTool('t1', 'ToolSearch', { query: 'select:run_in_terminal' });
      b.toolDone('t1', false);
      b.addText('الأداة جاهزة. أُعيد الحارس الأهمّ في طرفيتك المرئية.');
      for (let i = 2; i <= 8; i += 1) {
        b.addTool('t' + i, 'mcp__satr-terminal__run_in_terminal', { command: 'npm run test:hookguard' });
        b.toolDone('t' + i, false);
        b.addText('نصّ بين الأدوات رقم ' + i + '.');
      }
      b.addTool('t9', 'AskUserQuestion', { questions: [] });
      b.toolDone('t9', true); // أُلغيت البطاقة ⇒ نتيجة خطأ
      b.addText('**توقّفت عند الدمج، ولم أنشر شيئاً.** أحتاج قرارك في خطوة واحدة.');
      b.finish({ total_cost_usd: 0.1, duration_ms: 1000 });
      out.scenarios.brokenShape = visibleAnswer(b);
    }

    // ── (ب) ضابط: النصّ الختامي وحده بلا أدوات ─────────────────────────────────
    {
      const b = chat.newAssistantBlock('Claude Code');
      b.addText('إجابة نهائية بلا أي أداة.');
      b.finish({ total_cost_usd: 0.1, duration_ms: 1000 });
      out.scenarios.textOnly = visibleAnswer(b);
    }

    // ── (ج) الفرضية المطروحة: أدوات بلا نصّ إجابة نهائي إطلاقاً ────────────────
    {
      const b = chat.newAssistantBlock('Claude Code');
      b.addTool('c1', 'mcp__satr-terminal__run_in_terminal', { command: 'echo x' });
      b.toolDone('c1', false);
      b.finish({ total_cost_usd: 0.1, duration_ms: 1000 });
      out.scenarios.toolsNoAnswer = visibleAnswer(b);
    }

    // ── (د) تعليقٌ فقط (phase=commentary) مع أدوات — بلا إجابة ─────────────────
    {
      const b = chat.newAssistantBlock('Claude Code');
      b.addText('تفكيرٌ داخلي.', null, 'commentary');
      b.addTool('d1', 'Bash', { command: 'ls' });
      b.toolDone('d1', false);
      b.finish({ total_cost_usd: 0.1, duration_ms: 1000 });
      out.scenarios.commentaryOnly = visibleAnswer(b);
    }

    // ── العقد المحروس (OBS-142) ────────────────────────────────────────────────
    // ‏(١) لا كتلةَ فارغةٍ بصرياً بعد نهاية الدور — أياً كان شكله.
    for (const [name, s] of Object.entries(out.scenarios)) {
      const empty = !s.answerShown && !s.commentaryShown && !s.visibleToolCards;
      assert(!empty, 'OBS-142: كتلة «' + name + '» تُعرض فارغة بصرياً بعد الاكتمال.');
    }
    // ‏(٢) وما فيه إجابة يبقى يطوي السجلّ — الإصلاح لا يُلغي الطيّ المقصود.
    assert(out.scenarios.brokenShape.worklogCollapsed && out.scenarios.textOnly.worklogCollapsed,
      'OBS-142: الطيّ عند وجود إجابة يجب أن يبقى (لا تراجع في السلوك المقصود).');
    // ‏(٣) وما لا إجابة فيه يبقى مفتوحاً كي يُرى محتواه.
    assert(!out.scenarios.commentaryOnly.worklogCollapsed
      && out.scenarios.commentaryOnly.commentaryShown,
    'OBS-142: دورٌ بلا إجابة يجب أن يُبقي السجلّ مفتوحاً وتعليقَه مرئياً.');

    assert(violations.length === 0, 'انتهاك CSP: ' + JSON.stringify(violations));
    window.__RESULT__ = { ok: true, ...out };
  } catch (error) {
    window.__RESULT__ = { ok: false, error: String((error && error.message) || error), ...out };
  }
  window.__DONE__ = true;
});
