'use strict';

// جسر مزيّف أدنى ما يلزم لإظهار `<satr-gate>` الإنتاجي في حالة «لا محرك جاهز» — وهي
// الحالة التي يقع فيها انحدار OBS-128. الشكل مطابق لما يعيده `satr:preflight` فعلاً
// (منسوخ من `gate-live-page.js`) كي يكون المقيس المكوّنَ الإنتاجي لا نسخةً منه.

(function () {
  const NODE_OK = { ok: true, version: 'v22.0.0' };
  const META = {
    'sdk': { label: 'Claude Code', install: 'npm install -g @anthropic-ai/claude-code', login: 'claude auth login' },
    'codex': { label: 'Codex', install: 'npm install -g @openai/codex', login: 'codex login' },
    'kimi-code': { label: 'Kimi Code', install: 'irm https://code.kimi.com/kimi-code/install.ps1 | iex', login: 'kimi login' },
  };
  const engines = ['sdk', 'codex', 'kimi-code'].map((id) => ({
    id, label: META[id].label, installed: false, loggedIn: null, state: 'missing',
    install: META[id].install, login: META[id].login,
  }));
  const SNAPSHOT = {
    node: NODE_OK, npm: NODE_OK,
    claude: { ok: false, version: undefined, path: null },
    engines, keyProviders: [], readyEngines: [], ready: false, preferred: null,
  };

  // `#legacy` يحذف `engines` فتسلك البوابة فرع «استجابة preflight قديمة» — وهو الفرع
  // الذي ينتج العنوان «ثبّت Claude Code» بلا لاحقة، فيحسمه `applyTextDirection`
  // إحصائياً **LTR** (‏«ثبّت» أربعة محارف مقابل أحد عشر لاتينياً). ذاك هو العنصر الذي
  // كسر `test:gate-live` على Electron 44، ولا يظهر في الفرع الحديث.
  const LEGACY = Object.assign({}, SNAPSHOT, { engines: undefined });

  window.satr = {
    preflight: async () => (location.hash === '#legacy' ? LEGACY : SNAPSHOT),
    providers: async () => ({ providers: [
      { name: 'nvidia', label: 'NVIDIA NIM — مفتاح API مجاني', keyName: 'NVIDIA_API_KEY' },
    ] }),
    keySet: async () => ({ ok: true }),
  };

  window.__gateDirectionReady = true;
})();
