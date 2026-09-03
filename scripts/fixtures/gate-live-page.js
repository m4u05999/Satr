'use strict';

// صفحة اختبار البوابة الحي: تشغّل <satr-gate> الإنتاجي تحت CSP الفعلية مع جسر
// window.satr مزيف يقدّم لقطات preflight بالشكل الذي تبنيه main.js فعلاً.
// الغاية أن يُثبَت **سلوك البوابة نفسه** (تفتح/تحجب/ترشد) لا حساب الدالة النقية —
// وهو الفرق بين حارس حقيقي و«أخضر كاذب».

(function () {
  const checks = [];
  const violations = [];
  let scenario = null;
  let preflightCalls = 0;
  const preflightOptions = [];
  let keySetCalls = 0;
  let keySetName = '';
  let keySetValueLength = 0;
  let keySetShouldFail = false;

  window.__gateLiveProgress = 'boot';
  document.addEventListener('securitypolicyviolation', (e) => {
    violations.push(String(e.violatedDirective || '') + ' ' + String(e.blockedURI || ''));
  });

  // الجسر المزيف — الشكل مطابق لما يعيده satr:preflight بعد عقد الجاهزية.
  const PROVIDERS = [
    { name: 'gemini', label: 'Google Gemini — مفتاح API', keyName: 'GEMINI_API_KEY' },
    { name: 'groq', label: 'Groq — مفتاح API مجاني', keyName: 'GROQ_API_KEY' },
    { name: 'nvidia', label: 'NVIDIA NIM — مفتاح API مجاني', keyName: 'NVIDIA_API_KEY' },
    { name: 'ollama', label: 'Ollama — محلي', keyName: '' },
  ];
  window.satr = {
    preflight: async (options) => {
      preflightCalls++;
      preflightOptions.push(options || null);
      return scenario;
    },
    providers: async () => ({ providers: PROVIDERS }),
    keySet: async (name, value) => {
      keySetCalls++;
      keySetName = name;
      keySetValueLength = typeof value === 'string' ? value.length : -1;
      if (keySetShouldFail) return { ok: false, error: 'write_failed' };
      const provider = PROVIDERS.find((item) => item.keyName === name);
      scenario = snapshot(
        { 'sdk': 'missing', 'codex': 'missing', 'kimi-code': 'missing' },
        null,
        provider ? [{ name: provider.name, label: provider.label }] : []);
      return { ok: true };
    },
  };

  const NODE_OK = { ok: true, version: 'v22.0.0' };

  // بنّاء لقطة بنفس ترتيب المحركات ونصوص الأوامر التي تعتمدها readiness.js
  function snapshot(states, claude, keyProviders) {
    const meta = {
      'sdk': { label: 'Claude Code', install: 'npm install -g @anthropic-ai/claude-code', login: 'claude auth login' },
      'codex': { label: 'Codex', install: 'npm install -g @openai/codex', login: 'codex login' },
      'kimi-code': { label: 'Kimi Code', install: 'irm https://code.kimi.com/kimi-code/install.ps1 | iex', login: 'kimi login' },
    };
    const engines = ['sdk', 'codex', 'kimi-code'].map((id) => ({
      id, label: meta[id].label,
      installed: states[id] !== 'missing',
      loggedIn: states[id] === 'ready' ? true : (states[id] === 'logged_out' ? false : null),
      state: states[id],
      install: meta[id].install, login: meta[id].login,
    }));
    const readyEngines = engines.filter((e) => e.state === 'ready').map((e) => e.id);
    const keyed = Array.isArray(keyProviders) ? keyProviders : [];
    return {
      node: NODE_OK, npm: NODE_OK,
      claude: claude || { ok: states.sdk !== 'missing', version: states.sdk !== 'missing' ? '2.1.220' : undefined, path: null },
      engines, keyProviders: keyed, readyEngines, ready: readyEngines.length > 0 || keyed.length > 0,
      preferred: readyEngines[0] || (keyed[0] && keyed[0].name) || null,
    };
  }

  function stepsText(gate) {
    return Array.from(gate.shadowRoot.querySelectorAll('.gate-step')).map((li) => li.textContent).join('\n');
  }

  async function settle() {
    for (let i = 0; i < 20; i++) await Promise.resolve();
    await new Promise((r) => setTimeout(r, 15));
  }

  // تشغيل سيناريو عبر زر «أعد الفحص» — يحاكي فعل المستخدم لا استدعاء داخلياً
  async function run(gate, next) {
    scenario = next;
    const optionIndex = preflightOptions.length;
    const seen = [];
    const onReady = (e) => seen.push(e.detail);
    gate.addEventListener('gate-ready', onReady);
    gate.shadowRoot.querySelector('.recheck').click();
    await settle();
    gate.removeEventListener('gate-ready', onReady);
    if (!preflightOptions[optionIndex] || preflightOptions[optionIndex].force !== true) {
      throw new Error('زر «أعد الفحص» لم يرسل {force:true}');
    }
    return { hidden: gate.hidden === true, detail: seen[0] || null, steps: stepsText(gate) };
  }

  async function main() {
    await customElements.whenDefined('satr-gate');
    const gate = document.getElementById('gate');
    await settle(); // فحص connectedCallback الأول (scenario=null ⇒ يرسم الحجب)
    window.__gateLiveProgress = 'ready';

    // 1) العطل المُعالَج: Codex جاهز وClaude غائب ⇒ البوابة تفتح على Codex
    {
      const r = await run(gate, snapshot({ 'sdk': 'missing', 'codex': 'ready', 'kimi-code': 'missing' }));
      if (!r.hidden) throw new Error('البوابة بقيت محجوبة رغم جهوز Codex');
      if (!r.detail) throw new Error('لم يصل gate-ready مع Codex الجاهز');
      if (r.detail.preferred !== 'codex') throw new Error('preferred ليس codex: ' + r.detail.preferred);
      if (r.detail.engineLabel !== 'Codex') throw new Error('engineLabel خطأ: ' + r.detail.engineLabel);
      checks.push('codex-only-opens');
    }

    // 2) العكس: Claude جاهز وCodex غائب ⇒ السلوك القائم يبقى كما هو
    {
      const r = await run(gate, snapshot({ 'sdk': 'ready', 'codex': 'missing', 'kimi-code': 'missing' },
        { ok: true, version: '2.1.220', authChecked: true, loggedIn: true }));
      if (!r.hidden) throw new Error('البوابة بقيت محجوبة رغم جهوز Claude');
      if (r.detail.preferred !== 'sdk') throw new Error('preferred ليس sdk');
      if (r.detail.version !== '2.1.220') throw new Error('إصدار Claude لم يمرّ في gate-ready');
      checks.push('claude-only-opens');
    }

    // 3) Kimi وحده جاهز
    {
      const r = await run(gate, snapshot({ 'sdk': 'missing', 'codex': 'missing', 'kimi-code': 'ready' }));
      if (!r.hidden) throw new Error('البوابة بقيت محجوبة رغم جهوز Kimi');
      if (r.detail.preferred !== 'kimi-code') throw new Error('preferred ليس kimi-code');
      checks.push('kimi-only-opens');
    }

    // 4) لا محرك مثبّت ⇒ حجب + إرشاد إلى المحركات الثلاثة بأوامرها الحقيقية
    {
      const r = await run(gate, snapshot({ 'sdk': 'missing', 'codex': 'missing', 'kimi-code': 'missing' }));
      if (r.hidden) throw new Error('البوابة انفتحت بلا أي محرك مثبّت');
      if (r.detail) throw new Error('صدر gate-ready بلا محرك جاهز');
      for (const cmd of ['npm install -g @anthropic-ai/claude-code', 'npm install -g @openai/codex', 'code.kimi.com/kimi-code/install.ps1']) {
        if (!r.steps.includes(cmd)) throw new Error('غاب أمر التثبيت من خطوات البوابة: ' + cmd);
      }
      if (!r.steps.includes('Codex')) throw new Error('لم تُذكر Codex في خطوات الإرشاد');
      if (!r.steps.includes('Kimi Code')) throw new Error('لم تُذكر Kimi Code في خطوات الإرشاد');
      checks.push('none-installed-blocks');
      checks.push('three-engines-guided');
    }

    // 5) لا محرك أصيل + مزوّد بمفتاح محفوظ ⇒ تفتح البوابة عليه وتعرض تسميته.
    {
      const r = await run(gate, snapshot(
        { 'sdk': 'missing', 'codex': 'missing', 'kimi-code': 'missing' }, null,
        [{ name: 'nvidia', label: 'NVIDIA NIM — مفتاح API مجاني' }]));
      if (!r.hidden || !r.detail) throw new Error('مفتاح NVIDIA المحفوظ لم يفتح البوابة');
      if (r.detail.preferred !== 'nvidia') throw new Error('preferred لم يمرّر مزوّد المفتاح');
      if (r.detail.engineLabel !== 'NVIDIA NIM — مفتاح API مجاني') throw new Error('تسمية مزوّد المفتاح لم تمرّ');
      checks.push('key-provider-opens');
    }

    // 6) بلا أصيل ولا مفتاح: يظهر المسار البديل، يحجب الخطأ قيمة الحقل، ثم يحفظ ويعيد الفحص.
    {
      const r = await run(gate, snapshot({ 'sdk': 'missing', 'codex': 'missing', 'kimi-code': 'missing' }));
      if (r.hidden) throw new Error('البوابة انفتحت بلا أصيل ولا مفتاح');
      const root = gate.shadowRoot;
      const section = root.querySelector('.gate-key');
      const select = root.querySelector('#gateKeyProvider');
      const input = root.querySelector('#gateKeyValue');
      const save = root.querySelector('.save-key');
      const error = root.querySelector('.gate-key-error');
      if (section.hidden) throw new Error('قسم المفتاح البديل لم يظهر');
      if (input.type !== 'password') throw new Error('حقل المفتاح ليس password');
      const options = Array.from(select.options);
      if (options[0].value !== 'nvidia' || options[1].value !== 'groq') throw new Error('المزوّدان المجانيان ليسا أولاً');
      if (!options[0].textContent.includes('مجاني') || !options[1].textContent.includes('مجاني')) throw new Error('غابت وسم مجاني');
      const links = Array.from(section.querySelectorAll('a'));
      if (links.length !== 2 || links.some((a) => a.target !== '_blank' || a.rel !== 'noopener')) throw new Error('روابط إنشاء المفتاح غير آمنة');
      checks.push('key-section-guidance');

      keySetShouldFail = true;
      const rejectedSecret = 'never-echo-this-test-secret';
      input.value = rejectedSecret;
      save.click();
      if (input.value !== '') throw new Error('حقل المفتاح لم يُمسح فور الضغط');
      await settle();
      if (!error.textContent || error.textContent.includes(rejectedSecret)) throw new Error('خطأ الحفظ فارغ أو أعاد قيمة المفتاح');
      checks.push('key-save-error-redacted');

      keySetShouldFail = false;
      const callsBefore = preflightCalls;
      let savedDetail = null;
      gate.addEventListener('gate-ready', (e) => { savedDetail = e.detail; }, { once: true });
      input.value = 'test-key-value';
      save.click();
      if (input.value !== '') throw new Error('حقل المفتاح لم يُمسح فور الحفظ');
      await settle();
      if (keySetCalls < 2 || keySetName !== 'NVIDIA_API_KEY' || keySetValueLength !== 14) throw new Error('keySet لم يستقبل اسم مفتاح NVIDIA والقيمة');
      if (preflightCalls !== callsBefore + 1) throw new Error('الحفظ الناجح لم يُعد الفحص تلقائياً');
      if (!gate.hidden || !savedDetail || savedDetail.preferred !== 'nvidia') throw new Error('البوابة لم تفتح على NVIDIA بعد الحفظ');
      checks.push('key-setup-saves-and-opens');
    }

    // 7) مثبّت لكنه غير مسجّل ⇒ يُرشد لتسجيل الدخول لا لإعادة التثبيت
    {
      const r = await run(gate, snapshot({ 'sdk': 'missing', 'codex': 'logged_out', 'kimi-code': 'missing' }));
      if (r.hidden) throw new Error('البوابة انفتحت لمحرك غير مسجّل الدخول');
      if (!r.steps.includes('codex login')) throw new Error('لم يُعرض أمر تسجيل دخول Codex');
      if (r.steps.includes('npm install -g @openai/codex')) throw new Error('عُرض أمر تثبيت Codex رغم أنه مثبّت');
      checks.push('logged-out-guides-login');
    }

    // 8) تعذّر حسم المصادقة ⇒ fail-open (مطابق لسلوك gate.js القائم مع authChecked=false)
    {
      const r = await run(gate, snapshot({ 'sdk': 'missing', 'codex': 'ready', 'kimi-code': 'missing' }));
      if (!r.hidden) throw new Error('fail-open لم يُطبَّق');
      checks.push('fail-open-unknown-auth');
    }

    // 9) توافق خلفي: استجابة preflight قديمة (بلا ready/engines) ⇒ شرط Claude وحده
    {
      const legacyReady = { node: NODE_OK, npm: NODE_OK, claude: { ok: true, version: '2.1.220', authChecked: true, loggedIn: true } };
      const r1 = await run(gate, legacyReady);
      if (!r1.hidden) throw new Error('استجابة قديمة بـClaude جاهز لم تفتح البوابة');
      if (r1.detail.preferred !== 'sdk') throw new Error('التراجع القديم لم يفترض sdk');

      const legacyBlocked = { node: NODE_OK, npm: NODE_OK, claude: { ok: false, path: null } };
      const r2 = await run(gate, legacyBlocked);
      if (r2.hidden) throw new Error('استجابة قديمة بلا Claude فتحت البوابة');
      // `npm.cmd` لا `npm` العارية: ‏`ExecutionPolicy` تحجب `npm.ps1` الذي يسبقه في
      // ترتيب PowerShell، فيفشل الأمر حتى وهو منسوخ بيد المستخدم (عطل مُعاد إنتاجه).
      if (!r2.steps.includes('npm.cmd install -g @anthropic-ai/claude-code')) throw new Error('تراجع البوابة القديم بلا أمر تثبيت بـnpm.cmd');
      checks.push('legacy-preflight-fallback');
    }

    // 10) فشل preflight كلياً ⇒ حجب بلا انهيار
    {
      const r = await run(gate, null);
      if (r.hidden) throw new Error('البوابة انفتحت رغم فشل الفحص');
      checks.push('null-preflight-blocks');
    }

    if (preflightCalls < 11) throw new Error('عدد استدعاءات preflight أقل من المتوقع: ' + preflightCalls);
    checks.push('recheck-button-drives-scan');
    checks.push('recheck-forces-scan');

    window.__gateLiveResult = { pass: true, checks, violations, progress: 'done' };
  }

  window.addEventListener('DOMContentLoaded', () => {
    main().catch((error) => {
      window.__gateLiveResult = {
        pass: false, checks, violations,
        progress: window.__gateLiveProgress,
        error: (error && error.message) || String(error),
      };
    });
  });
})();
