#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const opsartifacts = require('../electron/opsartifacts');

const ROOT = path.resolve(__dirname, '..');

function read(relative) {
  return fs.readFileSync(path.join(ROOT, relative), 'utf8');
}

function gitLines(args) {
  try {
    return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8' }).split(/\r?\n/).filter(Boolean);
  } catch {
    return [];
  }
}

function changedFiles() {
  return [...new Set([
    ...gitLines(['diff', '--name-only', '--diff-filter=ACMRTUXB', 'HEAD', '--']),
    ...gitLines(['ls-files', '--others', '--exclude-standard']),
  ])].filter((relative) => {
    const normalized = relative.replace(/\\/g, '/');
    // تقارير TestSprite صفحات خارجية مولّدة وليست أصول واجهة تُشحَن مع Electron.
    if (normalized.startsWith('testsprite_tests/')) return false;
    // مواد promo موقع مستقل غير مشحون داخل Electron؛ حارس CSP هنا خاص بواجهة التطبيق.
    if (normalized.startsWith('promo/')) return false;
    return fs.existsSync(path.join(ROOT, relative));
  });
}

function methodBody(source, marker) {
  const start = source.indexOf(marker);
  assert(start !== -1, 'missing method ' + marker);
  const opening = source.indexOf('{', start + marker.length);
  assert(opening !== -1, 'missing method body ' + marker);
  let depth = 1;
  for (let index = opening + 1; index < source.length; index++) {
    if (source[index] === '{') depth++;
    else if (source[index] === '}') depth--;
    if (depth === 0) return source.slice(opening + 1, index);
  }
  assert.fail('unterminated method body ' + marker);
}

async function loadStateModule() {
  const source = read('src/ui/lib/ops-room-state.js');
  const url = 'data:text/javascript;base64,' + Buffer.from(source).toString('base64');
  return import(url + '#' + Date.now());
}

function fixture(artifactId) {
  const team = {
    id: 'execution-team-ui-test', room_id: 'ops-room-ui-test', state: 'completed',
    artifact_id: artifactId, merge_supported: true, merged: false, agents: [],
  };
  const review = {
    id: 'execution-review-ui-test', team_id: team.id, artifact_id: artifactId, state: 'completed',
    required_review_engines: ['sdk', 'codex'],
    reviews: ['sdk', 'codex'].map((engine) => ({
      engine, artifact_id: artifactId, state: 'completed',
      verdict: { schema_version: 1, decision: 'approve', source: 'explicit' },
    })),
  };
  const verification = { artifact_id: artifactId, state: 'passed', checks: [] };
  return { team, review, verification };
}

function judgesFixture(artifactId) {
  const current = fixture(artifactId);
  const lensSummary = (label) => [
    '## المخاطر',
    '[risk: high] ' + label + ' يحتاج معالجة.',
    '## الملاحظات',
    label + ' ملاحظة مستقلة.',
    '## التوصية',
    'عالج البند ثم أعد المراجعة.',
  ].join('\n');
  const lenses = [
    ['correctness', 'الصحة'],
    ['security', 'الأمان'],
    ['simplicity', 'التبسيط'],
  ].map(([lens, label]) => ({
    lens, state: 'completed', summary: lensSummary(label),
    verdict: { schema_version: 1, decision: 'changes_required', source: 'explicit' },
    duration_ms: 1250,
    cost: { usd: 0.01, input_tokens: 100, output_tokens: 40, estimate: false },
  }));
  return {
    ...current,
    review: {
      ...current.review,
      reviews: current.review.reviews.map((item) => ({
        ...item,
        state: 'completed',
        summary: lenses.map((lens) => lens.summary).join('\n'),
        verdict: { schema_version: 1, decision: 'changes_required', source: 'explicit' },
        lenses: lenses.map((lens) => ({ ...lens })),
      })),
      merged_report: {
        schema_version: 1,
        items: [
          { severity: 'low', lens: 'simplicity', engine: 'codex', text: 'البند الأول كما وصل.' },
          { severity: 'critical', lens: 'security', engine: 'sdk', text: 'البند الثاني كما وصل.' },
          { severity: 'high', lens: 'correctness', engine: 'codex', text: 'البند الثالث كما وصل.' },
          { severity: 'medium', lens: 'security', engine: 'sdk', text: 'البند الرابع كما وصل.' },
        ],
        truncated: true,
      },
    },
  };
}

function testJudgesHelpers(component) {
  const safeText = (value) => typeof value === 'string' ? value : '';
  class FakeElement {
    constructor(tagName) {
      this.tagName = tagName;
      this.className = '';
      this.textContent = '';
      this.children = [];
      this.dataset = {};
      this.listeners = {};
      this.attributes = {};
      this.dir = '';
      this.hidden = false;
      this.disabled = false;
    }

    appendChild(child) {
      this.children.push(child);
      return child;
    }

    addEventListener(type, listener) {
      this.listeners[type] = listener;
    }

    setAttribute(name, value) {
      this.attributes[name] = String(value);
    }

    removeAttribute(name) {
      delete this.attributes[name];
    }

    toggleAttribute(name, force) {
      if (force === false) delete this.attributes[name];
      else this.attributes[name] = '';
    }
  }
  const document = {
    createElement: (tagName) => new FakeElement(tagName),
    createTextNode: (value) => {
      const node = new FakeElement('#text'); node.textContent = String(value); return node;
    },
  };
  const elementsByClass = (root, className) => {
    const matches = [];
    const visit = (element) => {
      if (!element) return;
      if (String(element.className).split(/\s+/).includes(className)) matches.push(element);
      for (const child of element.children || []) visit(child);
    };
    visit(root);
    return matches;
  };
  const flattenedText = (root, includeHidden = true) => {
    const values = [];
    const visit = (element) => {
      if (!element || (!includeHidden && element.hidden)) return;
      if (element.textContent) values.push(element.textContent);
      for (const child of element.children || []) visit(child);
    };
    visit(root);
    return values.join(' ');
  };
  const storageValues = new Map();
  const localStorage = {
    getItem: (key) => storageValues.has(key) ? storageValues.get(key) : null,
    setItem: (key, value) => storageValues.set(key, value),
  };
  const modelStorageKey = new Function('MODEL_STORAGE_PREFIX',
    'return function () {' + methodBody(component, '  _modelStorageKey()') + '};')('satr_ops_models::');
  const loadModels = new Function('localStorage', 'text',
    'return function () {' + methodBody(component, '  _loadModelPreferences()') + '};')(localStorage, safeText);
  const saveModels = new Function('localStorage',
    'return function () {' + methodBody(component, '  _saveModelPreferences()') + '};')(localStorage);
  const modelOverrides = new Function('text',
    'return function (names) {' + methodBody(component, '  _modelOverrides(names)') + '};')(safeText);
  const supportsModels = new Function(
    'return function (method, arity) {' + methodBody(component, '  _supportsModels(method, arity)') + '};')();
  const errorLabel = new Function('BAD_INPUT_LABELS', 'ERROR_LABELS',
    'return function (result, context, fallback) {'
      + methodBody(component, 'function errorLabel(result, context, fallback)') + '};')(
    { execution: 'مدخل غير صالح' },
    { bad_patch: 'أثر تالف', read_failed: 'تعذرت القراءة' },
  );
  assert.strictEqual(errorLabel(null, 'execution', 'رسالة احتياطية'),
    'لم يصل رد من العملية الرئيسية (خطأ داخلي أو انقطاع) — أعد المحاولة، وإن تكرر أعد تشغيل التطبيق.',
    'a missing IPC result must have its own actionable message');
  assert.strictEqual(errorLabel({ error: 'unknown_code' }, 'execution', 'رسالة احتياطية'),
    'رسالة احتياطية (الرمز التقني: unknown_code)',
    'an untranslated error must preserve its technical code');
  assert.strictEqual(errorLabel('', 'execution', 'رسالة احتياطية'), 'رسالة احتياطية',
    'an empty string error must retain the plain fallback');
  assert.strictEqual(errorLabel('bad_patch', 'execution', 'رسالة احتياطية'), 'أثر تالف',
    'known bad_patch errors must use their Arabic label');
  assert.strictEqual(errorLabel('read_failed', 'execution', 'رسالة احتياطية'), 'تعذرت القراءة',
    'known read_failed errors must use their Arabic label');
  const modelHost = {
    _cwd: 'D:\\repo\\judge-ui',
    _models: { worker: '', sdk: '', codex: '' },
    _modelStorageKey: modelStorageKey,
  };
  storageValues.set('satr_ops_models::D:\\repo\\judge-ui', JSON.stringify({
    worker: 'worker-model', sdk: 'judge-mini', codex: 'judge-codex',
  }));
  loadModels.call(modelHost);
  assert.deepStrictEqual(modelHost._models, {
    worker: 'worker-model', sdk: 'judge-mini', codex: 'judge-codex',
  }, 'model preferences must restore from the cwd-scoped frozen key');
  modelHost._models.codex = '';
  saveModels.call(modelHost);
  assert.deepStrictEqual(JSON.parse(storageValues.get('satr_ops_models::D:\\repo\\judge-ui')), modelHost._models,
    'model preferences must save back to the same cwd-scoped key');
  assert.deepStrictEqual(modelOverrides.call(modelHost, ['worker', 'sdk', 'codex']), {
    worker: 'worker-model', sdk: 'judge-mini',
  }, 'empty model selectors must not create overrides');
  assert.strictEqual(supportsModels(function (a, b) {}, 2), true,
    'extended bridge arity must enable model overrides');
  assert.strictEqual(supportsModels(function (a) {}, 2), false,
    'legacy bridge arity must retain the old call path');

  const weakJudgeLiteral = /const WEAK_JUDGE_MODEL = (\/[^\r\n]+\/i);/.exec(component);
  assert(weakJudgeLiteral, 'weak judge model regex missing');
  const weakJudgeModel = new Function('return ' + weakJudgeLiteral[1])();
  for (const model of ['claude-haiku', 'gpt-mini', 'judge-lite', 'gemini-flash', 'nano-reviewer']) {
    assert.strictEqual(weakJudgeModel.test(model), true, 'weak judge warning must match ' + model);
  }
  assert.strictEqual(weakJudgeModel.test('claude-opus'), false,
    'strong judge names must not trigger the non-blocking warning');

  const truncateSource = /function truncatePoints\(value, maximum, suffix\) \{[\s\S]*?\n\}/.exec(component);
  assert(truncateSource, 'Unicode code-point truncation helper missing');
  const truncatePoints = new Function('text',
    truncateSource[0] + '; return truncatePoints;')(safeText);
  const repairTaskFromReport = new Function('LENS_LABELS', 'engineLabel', 'text', 'truncatePoints',
    'return function (report) {' + methodBody(component, '  _repairTaskFromReport(report)') + '};')(
    { correctness: 'الصحة', security: 'الأمان', simplicity: 'التبسيط' },
    (value) => value === 'sdk' ? 'Claude SDK' : value === 'codex' ? 'Codex' : value,
    safeText,
    truncatePoints,
  );
  let seeded = '';
  const repairHost = { seedTask: (value) => { seeded = value; } };
  repairTaskFromReport.call(repairHost, judgesFixture('c'.repeat(64)).review.merged_report);
  assert(seeded.includes('البند الثاني كما وصل.') && seeded.includes('البند الثالث كما وصل.')
    && !seeded.includes('البند الأول كما وصل.') && !seeded.includes('البند الرابع كما وصل.'),
  'repair draft must include only critical/high items and must not submit anything');
  repairTaskFromReport.call(repairHost, { items: [{
    severity: 'critical', lens: 'security', engine: 'sdk', text: '😀'.repeat(2200),
  }] });
  assert.strictEqual(Array.from(seeded).length, 2000,
    'repair draft must be bounded to 2000 Unicode code points');
  assert(seeded.endsWith('… [قُصّ ذيل الملاحظات]'),
    'repair draft must expose a clear tail truncation marker');

  const severityLabels = { critical: 'حرج', high: 'مرتفع', medium: 'متوسط', low: 'منخفض' };
  const lensLabels = { correctness: 'الصحة', security: 'الأمان', simplicity: 'التبسيط' };
  const engineLabel = (value) => value === 'sdk' ? 'Claude SDK' : value === 'codex' ? 'Codex' : value;
  const renderMergedReport = new Function(
    'document', 'SEVERITY_LABELS', 'integerLabel', 'text', 'LENS_LABELS', 'engineLabel',
    'return function (view, report) {' + methodBody(component, '  _renderMergedReport(view, report)') + '};',
  )(document, severityLabels, (value) => String(value), safeText, lensLabels, engineLabel);
  let repairClicks = 0;
  const mergedView = new FakeElement('div');
  const mergedReport = judgesFixture('d'.repeat(64)).review.merged_report;
  renderMergedReport.call({ _repairTaskFromReport: () => { repairClicks++; } }, mergedView, mergedReport);
  const mergedCards = elementsByClass(mergedView, 'merged-report');
  assert.strictEqual(mergedCards.length, 1, 'synthetic merged_report must render one report card');
  assert.deepStrictEqual(
    elementsByClass(mergedView, 'merged-count').map((element) => element.dataset.severity),
    ['critical', 'high', 'medium', 'low'],
    'merged report counters must retain the frozen severity order',
  );
  assert.deepStrictEqual(
    elementsByClass(mergedView, 'merged-item').map((element) => element.dataset.severity),
    mergedReport.items.map((item) => item.severity),
    'merged report rows must retain their received order',
  );
  assert.deepStrictEqual(
    elementsByClass(mergedView, 'merged-text').map((element) => element.textContent),
    mergedReport.items.map((item) => item.text),
    'merged report rows must render the synthetic item text verbatim through textContent',
  );
  assert(elementsByClass(mergedView, 'merged-text').every((element) => element.dir === 'auto'),
    'merged report item text must use dir=auto');
  assert.strictEqual(elementsByClass(mergedView, 'merged-truncated')[0].textContent, 'مقصوص',
    'synthetic truncated report must show its marker');
  const repairButton = elementsByClass(mergedView, 'merged-repair')[0];
  assert(repairButton && typeof repairButton.listeners.click === 'function',
    'synthetic merged report must expose an explicit repair click');
  repairButton.listeners.click();
  assert.strictEqual(repairClicks, 1, 'repair click must only invoke the form-filling handler once');
  const lowSeverityView = new FakeElement('div');
  renderMergedReport.call({ _repairTaskFromReport: () => { repairClicks++; } }, lowSeverityView, {
    items: [
      { severity: 'medium', lens: 'correctness', engine: 'sdk', text: 'بند متوسط.' },
      { severity: 'low', lens: 'simplicity', engine: 'codex', text: 'بند منخفض.' },
    ],
  });
  assert.strictEqual(elementsByClass(lowSeverityView, 'merged-repair').length, 0,
    'medium/low-only merged reports must not expose an empty repair action');

  const reviewSections = new Function('text',
    'return function (summary, recommendation) {'
      + methodBody(component, 'function reviewSections(summary, recommendation)') + '};')(safeText);
  const polishLifecycle = {
    completed: 'اكتمل', running: 'يعمل', failed: 'فشل', timed_out: 'انتهت المهلة', stopped: 'أوقفه المستخدم',
    approve: 'موافقة', changes_required: 'تعديلات مطلوبة', reject: 'رفض', passed: 'نجح',
  };
  const visibleLifecycleLabel = (state, fallback) => polishLifecycle[state] || fallback || 'حالة غير معروفة';
  const reviewStateLabel = new Function('visibleLifecycleLabel', 'return function (state) {'
    + methodBody(component, 'function reviewStateLabel(state)') + '};')(visibleLifecycleLabel);
  const reviewDecisionLabel = new Function('visibleLifecycleLabel', 'return function (decision) {'
    + methodBody(component, 'function reviewDecisionLabel(decision)') + '};')(visibleLifecycleLabel);
  const appendReviewSections = new Function('document',
    'return function (container, sections) {'
      + methodBody(component, '  _appendReviewSections(container, sections)') + '};')(document);
  const renderReview = new Function(
    'document', 'deriveOpsRoomState', 'reviewSections', 'engineLabel', 'text',
    'LENS_LABELS', 'reviewStateLabel', 'reviewDecisionLabel', 'mergeGateLabel',
    'return function () {' + methodBody(component, '  _renderReview()') + '};',
  )(document, () => ({ canMerge: false }), reviewSections, engineLabel, safeText,
    lensLabels, reviewStateLabel, reviewDecisionLabel, () => 'بوابة اختبار');
  const renderHost = {
    _views: { review: new FakeElement('div') },
    _state: { review: judgesFixture('e'.repeat(64)).review, entries: [] },
    _renderMergedReport: () => {},
    _appendReviewSections: appendReviewSections,
    _entryCard: () => new FakeElement('article'),
    _card: (options) => {
      const card = new FakeElement('article');
      if (typeof options.body === 'function') {
        const body = new FakeElement('div');
        options.body(body);
        card.appendChild(body);
      }
      return card;
    },
  };
  renderReview.call(renderHost);
  const renderedLenses = elementsByClass(renderHost._views.review, 'review-lens');
  assert.deepStrictEqual(renderedLenses.map((element) => element.dataset.lens),
    ['correctness', 'security', 'simplicity', 'correctness', 'security', 'simplicity'],
  'each synthetic engine card must render all three frozen lenses');
  assert.deepStrictEqual(
    elementsByClass(renderHost._views.review, 'review-lens-title').slice(0, 3).map((element) => element.textContent),
    ['الصحة', 'الأمان', 'التبسيط'],
    'synthetic lens cards must expose the frozen Arabic labels',
  );
  renderHost._views.review = new FakeElement('div');
  renderHost._state.review = fixture('e'.repeat(64)).review;
  renderReview.call(renderHost);
  assert.strictEqual(elementsByClass(renderHost._views.review, 'review-lens').length, 0,
    'legacy review items without lenses must retain the old renderer path');
  assert(elementsByClass(renderHost._views.review, 'review-section').length > 0,
    'legacy review items without lenses must still render their ordinary sections');
  const stoppedCards = [];
  let stoppedMergedReports = 0;
  renderHost._views.review = new FakeElement('div');
  renderHost._state.review = { ...judgesFixture('f'.repeat(64)).review, state: 'stopped' };
  renderHost._renderMergedReport = () => { stoppedMergedReports++; };
  renderHost._card = (options) => {
    stoppedCards.push(options);
    const card = new FakeElement('article');
    if (typeof options.body === 'function') {
      const body = new FakeElement('div'); options.body(body); card.appendChild(body);
    }
    return card;
  };
  renderReview.call(renderHost);
  assert.strictEqual(stoppedMergedReports, 0,
    'a user-stopped review must not present an incomplete merged judgment');
  assert(stoppedCards.length === 2 && stoppedCards.every((options) =>
    options.stateLabel === 'أوقفها المستخدم قبل اكتمال الأحكام'
      && !/تعديلات مطلوبة|changes_required/.test(options.stateLabel + ' ' + options.summary)),
  'stopped review cards must explain the user stop instead of presenting changes_required as a judgment');
  assert.strictEqual(elementsByClass(renderHost._views.review, 'review-lens-verdict').length, 0,
    'stopped review lenses must hide their incomplete verdict badges');

  const loopReviewLabels = {
    idle: 'بانتظار المراجع', running: 'جارية', approve: 'اعتمدت',
    changes_required: 'تطلب تعديلات', reject: 'رفضت', failed: 'فشلت',
  };
  const renderLoop = new Function(
    'document', 'LOOP_STATES', 'LOOP_REVIEW_STATES', 'LOOP_STOP_REASONS', 'integerLabel', 'usdLabel', 'truncatePoints',
    'visibleLifecycleLabel',
    'return function (view, derived) {' + methodBody(component, '  _renderLoop(view, derived)') + '};',
  )(
    document,
    { working: 'ينفّذ الإصلاح', passed: 'نجحت' },
    loopReviewLabels,
    { pass: 'نجح التحقق' },
    (value) => String(Number(value) || 0),
    (value) => '$' + (Number(value) || 0).toFixed(2),
    truncatePoints,
    visibleLifecycleLabel,
  );
  const loopRenderHost = { _state: { loop: null, pending: '' }, _stopLoop: () => {} };
  for (const [reviewState, label] of Object.entries(loopReviewLabels)) {
    const view = new FakeElement('div');
    loopRenderHost._state.loop = loopFixture({
      review: { configured: true, state: reviewState, summary: reviewState === 'idle' ? '' : 'ملخص اصطناعي.' },
    });
    renderLoop.call(loopRenderHost, view, { loopTerminal: false });
    const reviewCards = elementsByClass(view, 'loop-review');
    const states = elementsByClass(view, 'loop-review-state');
    assert.strictEqual(reviewCards.length, 1, 'configured loop review must render for ' + reviewState);
    assert.strictEqual(states[0].textContent, label, 'loop review must localize ' + reviewState);
    assert.strictEqual(states[0].dataset.state, reviewState, 'loop review must expose its presentational state ' + reviewState);
  }
  for (const review of [undefined, { configured: false, state: 'idle', summary: '' }]) {
    const view = new FakeElement('div');
    loopRenderHost._state.loop = loopFixture({ ...(review ? { review } : {}) });
    renderLoop.call(loopRenderHost, view, { loopTerminal: false });
    assert.strictEqual(elementsByClass(view, 'loop-review').length, 0,
      'legacy or unconfigured loop snapshots must not gain a review row');
  }
  const adversarialView = new FakeElement('div');
  loopRenderHost._state.loop = loopFixture({ review: {
    configured: true, state: 'changes_required',
    summary: '<img src=x onerror=alert(1)>\u202E' + '😀'.repeat(400),
  } });
  renderLoop.call(loopRenderHost, adversarialView, { loopTerminal: false });
  const adversarialSummary = elementsByClass(adversarialView, 'loop-review-summary')[0];
  assert(adversarialSummary && Array.from(adversarialSummary.textContent).length <= 300,
    'adversarial loop review summary must be truncated by Unicode code points');
  assert(adversarialSummary.textContent.startsWith('<img src=x onerror=alert(1)>')
    && adversarialSummary.children.length === 0,
  'adversarial loop review summary must remain inert text without breaking the card');

  const timeLabel = new Function('return function (value) {'
    + methodBody(component, 'function timeLabel(value)') + '};')();
  const fingerprintLabel = new Function('text', 'return function (value) {'
    + methodBody(component, 'function fingerprintLabel(value)') + '};')(safeText);
  const actorLabel = new Function('text', 'ACTOR_LABELS', 'engineLabel', 'return function (value) {'
    + methodBody(component, 'function actorLabel(value)') + '};')(
    safeText, { system: 'النظام', user: 'المستخدم', reviewer: 'المراجع', advisor: 'المستشار' }, engineLabel,
  );
  const cardRenderer = new Function(
    'document', 'text', 'visibleLifecycleLabel', 'actorLabel', 'fingerprintLabel', 'timeLabel', 'engineLabel',
    'return function (options) {' + methodBody(component, '  _card(options)') + '};',
  )(document, safeText, visibleLifecycleLabel, actorLabel, fingerprintLabel, timeLabel, engineLabel);
  const fingerprint = 'a1'.repeat(32);
  const fingerprintCard = cardRenderer({
    title: 'بطاقة أثر', state: 'completed', actor: 'system', artifact: fingerprint, time: Date.UTC(2024, 5, 15, 12),
  });
  const visibleFingerprintText = flattenedText(fingerprintCard, false);
  assert(visibleFingerprintText.includes(fingerprint.slice(0, 12)) && !visibleFingerprintText.includes(fingerprint),
    'artifact cards must expose only the 12-character fingerprint prefix while collapsed');
  const hiddenFingerprintBody = elementsByClass(fingerprintCard, 'work-card-body')[0];
  assert(hiddenFingerprintBody && hiddenFingerprintBody.hidden && flattenedText(hiddenFingerprintBody).includes(fingerprint),
    'artifact cards must retain the full fingerprint behind the details toggle');
  const timeValue = elementsByClass(fingerprintCard, 'work-card-tech').find((element) => /2024/.test(element.textContent));
  assert(timeValue && timeValue.dir === 'ltr' && !/[٠-٩۰-۹]/.test(timeValue.textContent),
    'card time metadata must use Gregorian Latin digits inside an LTR bdi');
  const emptyMetadataCard = cardRenderer({ title: 'بلا بيانات', state: 'completed' });
  assert.strictEqual(elementsByClass(emptyMetadataCard, 'work-card-foot').length, 0,
    'empty actor, engine, artifact, and time metadata must omit the footer instead of placeholders');
  assert(flattenedText(cardRenderer({ title: 'حالة إضافية', state: 'partial' })).includes('حالة غير معروفة')
    && !flattenedText(cardRenderer({ title: 'حالة إضافية', state: 'partial' })).includes('partial'),
  'unknown additive lifecycle states must fail closed to Arabic instead of leaking raw tokens');
  for (const [actor, label] of Object.entries({
    system: 'النظام', user: 'المستخدم', reviewer: 'المراجع', advisor: 'المستشار',
  })) {
    const actorCard = cardRenderer({ title: 'فاعل', state: 'completed', actor });
    assert(flattenedText(actorCard).includes(label) && !flattenedText(actorCard).includes('الفاعل: ' + actor),
      'actor metadata must localize ' + actor);
  }
  const formattedTime = timeLabel(Date.UTC(2024, 5, 15, 12));
  assert(/2024/.test(formattedTime) && !/[٠-٩۰-۹]/.test(formattedTime),
    'timeLabel must remain Gregorian with Latin digits');

  const openDialog = new Function('document', 'text', 'fingerprintLabel', 'queueMicrotask',
    'return function (options) {' + methodBody(component, '  openDialog(options)') + '};',
  )(document, safeText, fingerprintLabel, (callback) => callback());
  const dialogHost = {
    _resolver: null,
    _title: new FakeElement('h2'), _description: new FakeElement('div'), _confirm: new FakeElement('button'),
    _items: new FakeElement('div'), _cancel: { focus: () => {} }, setAttribute: () => {},
  };
  openDialog.call(dialogHost, { title: 'تأكيد', description: 'وصف', items: [fingerprint] });
  const fingerprintDetails = dialogHost._items.children[0];
  assert(fingerprintDetails && fingerprintDetails.tagName === 'details'
    && flattenedText(fingerprintDetails.children[0]).includes(fingerprint.slice(0, 12))
    && fingerprintDetails.children[1].textContent === fingerprint,
  'confirmation dialogs must keep the full fingerprint inside native details behind its 12-character prefix');

  const fileForms = { one: 'ملف واحد', two: 'ملفان', plural: 'ملفات', many: 'ملفاً' };
  const arabicCount = (count, forms) => count === 1 ? forms.one : count === 2 ? forms.two
    : count >= 3 && count <= 10 ? count + ' ' + forms.plural : count + ' ' + forms.many;
  const renderDiffs = new Function('document', 'countLabel', 'FILE_COUNT_FORMS',
    'return function () {' + methodBody(component, '  _renderDiffs()') + '};',
  )(document, arabicCount, fileForms);
  for (const [fileCount, expected] of [[1, 'ملف واحد'], [2, 'ملفان'], [5, '5 ملفات']]) {
    const captured = [];
    const view = new FakeElement('div');
    const files = Array.from({ length: fileCount }, (_, index) => ({ rel: 'src/' + index + '.js', added: 1, removed: 0 }));
    renderDiffs.call({
      _views: { diffs: view }, _state: { team: { id: 'team', artifact_id: fingerprint, updated_at: 1,
        agents: [{ id: 'agent', label: 'عامل', state: 'completed', changes: { files } }] } },
      _card: (options) => { captured.push(options); return new FakeElement('article'); },
      _empty: () => {}, _diffCache: new Map(),
    });
    assert(view.children[0].textContent.includes('سيُدمج ' + expected)
      && captured[0].stateLabel === expected,
    'diff summaries and cards must use Arabic count inflection for ' + fileCount);
  }

  let truncateCalls = 0;
  const renderHistory = new Function(
    'document', 'text', 'truncateWords', 'RUN_KIND_LABELS', 'TEAM_STATES', 'visibleLifecycleLabel',
    'return function () {' + methodBody(component, '  _renderHistory()') + '};',
  )(document, safeText, (value) => { truncateCalls++; return value.length > 20 ? value.slice(0, 18) + '…' : value; },
    { team: 'فريق', loop: 'حلقة' }, { completed: 'اكتمل التنفيذ' }, visibleLifecycleLabel);
  const historyCards = [];
  renderHistory.call({
    _views: { history: new FakeElement('div') },
    _history: [
      { room_id: 'ops-room-modern', state: 'completed', task_excerpt: 'مهمة بشرية طويلة لاختبار القص الآمن',
        run_kind: 'team', updated_at: Date.UTC(2024, 5, 15), merged: false, restorable: false },
      { room_id: 'ops-room-loop', state: 'completed', task_excerpt: 'مهمة حلقة',
        run_kind: 'loop', updated_at: Date.UTC(2024, 5, 16), merged: false, restorable: false },
      { room_id: 'ops-room-legacy', state: 'completed', merged: false, restorable: false },
    ],
    _card: (options) => { historyCards.push(options); return new FakeElement('article'); }, _empty: () => {},
  });
  assert(truncateCalls === 3 && historyCards[0].title.endsWith('…')
    && historyCards[0].summary.includes('نوع التشغيل: فريق') && historyCards[0].time > 0,
  'modern history rows must consume task_excerpt, run_kind, truncation, and readable time inputs');
  assert(historyCards[1].summary.includes('نوع التشغيل: حلقة'), 'loop history rows must localize run_kind');
  assert.strictEqual(historyCards[2].title, 'ops-room-legacy',
    'legacy history rows must fall back gracefully to room_id when additive fields are absent');

  const checkResultLabel = new Function('text', 'return function (check) {'
    + methodBody(component, 'function checkResultLabel(check)') + '};')(safeText);
  assert.deepStrictEqual(checkResultLabel({ command: 'npm test', exit_code: -1073741510, exit_label: 'أوقفه المستخدم' }),
    { value: 'أوقفه المستخدم', technical: false }, 'exit_label must take precedence over command and raw exit code');
  assert.deepStrictEqual(checkResultLabel({ exit_code: -1073741510 }),
    { value: 'exit=-1073741510', technical: true }, 'missing exit_label must retain the raw technical code');
  const renderEvidence = new Function(
    'document', 'deriveOpsRoomState', 'visibleLifecycleLabel', 'checkResultLabel', 'lifecycleLabel',
    'return function () {' + methodBody(component, '  _renderEvidence()') + '};',
  )(document, () => ({ artifactId: fingerprint }), visibleLifecycleLabel, checkResultLabel,
    (state) => polishLifecycle[state] || state);
  const evidenceView = new FakeElement('div');
  renderEvidence.call({
    _views: { evidence: evidenceView },
    _state: { team: { updated_at: 1 }, entries: [], verification: { artifact_id: fingerprint, state: 'failed', checks: [
      { id: 'stop', label: 'إيقاف', command: 'npm test', exit_code: -1073741510,
        exit_label: 'أوقفه المستخدم', duration_ms: 4 },
      { id: 'raw', label: 'خام', exit_code: 1, duration_ms: 5 },
    ] } },
    _card: (options) => { const card = new FakeElement('article'); const body = new FakeElement('div');
      options.body(body); card.appendChild(body); return card; },
    _entryCard: () => new FakeElement('article'), _empty: () => {},
  });
  assert(elementsByClass(evidenceView, 'check-result')[0].textContent.includes('أوقفه المستخدم')
    && !flattenedText(evidenceView).includes('⚠️'),
  'intentional-stop exit labels must render as friendly text without a warning icon');
  const rawExit = elementsByClass(evidenceView, 'counts').find((element) => element.textContent.includes('exit=1'));
  assert(rawExit && rawExit.dir === 'ltr', 'raw exit-code fallback must remain isolated LTR');

  const mergeGateLabel = new Function('return function (state, derived) {'
    + methodBody(component, 'function mergeGateLabel(state, derived)') + '};')();
  const missingBoth = mergeGateLabel({}, { canMerge: false, reviewApproved: false, verificationPassed: false });
  const missingVerification = mergeGateLabel({}, { canMerge: false, reviewApproved: true, verificationPassed: false });
  const missingReview = mergeGateLabel({}, { canMerge: false, reviewApproved: false, verificationPassed: true });
  const readyGate = mergeGateLabel({}, { canMerge: true, reviewApproved: true, verificationPassed: true });
  assert(missingBoth.includes('المراجعات') && /تحقق/.test(missingBoth)
    && !missingVerification.includes('المراجعات') && /تحقق/.test(missingVerification)
    && missingReview.includes('المراجعات') && !missingReview.includes('نجاح التحقق')
    && readyGate.includes('التأكيد الصريح') && !readyGate.includes('المتبقي:'),
  'merge gate guidance must mention only the conditions that remain');
  assert(mergeGateLabel({ review: { state: 'stopped' } }, {
    canMerge: false, reviewApproved: false, verificationPassed: false,
  }).includes('إعادة المراجعة للأثر نفسه'), 'stopped review gate must recommend retrying the same artifact');

  const setMixedTechnicalText = new Function(
    'document', 'text', 'TECHNICAL_PARTS', 'TECHNICAL_PART',
    'return function (container, value) {' + methodBody(component, 'function setMixedTechnicalText(container, value)') + '};',
  )(document, safeText, /(\.satr[\\/][A-Za-z0-9._\\/-]*[A-Za-z0-9_-]|\b(?:HEAD|Git|worktree|commit|push|patch|preview)\b)/g,
    /^(?:\.satr[\\/][A-Za-z0-9._\\/-]*[A-Za-z0-9_-]|HEAD|Git|worktree|commit|push|patch|preview)$/);
  const mixedStatus = new FakeElement('div');
  setMixedTechnicalText(mixedStatus, 'راجع .satr/verify.json المعتمد في HEAD.');
  assert(mixedStatus.children.filter((element) => element.tagName === 'code').length === 2
    && mixedStatus.children.filter((element) => element.tagName === 'code').every((element) => element.dir === 'ltr'),
  'technical paths and code in Arabic status messages must be isolated in LTR code elements');

  const loadLayoutPreferences = new Function(
    'localStorage', 'getComputedStyle', 'document',
    'return function () {' + methodBody(component, '  _loadLayoutPreferences()') + '};',
  );
  const storedLayouts = new Map();
  const layoutStorage = { getItem: (key) => storedLayouts.get(key) || null };
  const layoutHost = {
    _layoutStorageKey: () => 'layout', _layoutSheet: { replaceSync: () => {} },
    _updateView: () => {}, _syncResponsiveMode: () => {},
  };
  const loadLayout = loadLayoutPreferences(layoutStorage,
    () => ({ fontSize: '16px' }), { documentElement: {} });
  loadLayout.call(layoutHost);
  assert.strictEqual(layoutHost._view, 'tasks', 'guided setup must remain the initial content view');
  storedLayouts.set('layout', JSON.stringify({ compact: true, width: 640, group: 'log', views: { log: 'decisions' } }));
  loadLayout.call(layoutHost);
  assert(layoutHost._preferredCompact === true && layoutHost._preferredWidth === 640
    && layoutHost._view === 'tasks' && layoutHost._groupViews == null,
  'layout restore must preserve width/compact while discarding removed tab preferences');

  const roomStatusMessage = new Function(
    'LOOP_STATES', 'TEAM_STATES', 'visibleLifecycleLabel',
    'return function (state, derived) {' + methodBody(component, 'function roomStatusMessage(state, derived)') + '};',
  )({ working: 'ينفّذ الإصلاح' }, { running: 'ينفّذ…' }, (value) => value);
  assert.strictEqual(roomStatusMessage({}, {}), '', 'an empty room must keep the inherited status row silent');
  assert.strictEqual(roomStatusMessage({ pending: true }, {}), 'جارٍ تنفيذ الانتقال المطلوب…');
  assert.strictEqual(roomStatusMessage({ team: { state: 'running' } }, {}), 'ينفّذ…',
    'real transition states must remain visible after empty-room silence');

  const syncSetupActions = new Function('deriveOpsRoomState', 'text',
    'return function () {' + methodBody(component, '  _syncSetupActions()') + '};')(
    () => ({ canStart: true, nextAction: { key: 'start', action: 'start', label: 'إرشاد الخطوة التالية من السلم.' } }),
    (value) => (typeof value === 'string' ? value : ''),
  );
  const taskField = { value: '' }; const ownershipField = { value: '' };
  const workerInput = { querySelector: (selector) => selector === '.task' ? taskField : ownershipField };
  const guidanceHost = {
    _state: {}, _cwd: '', _primaryAction: 'start', _plan: null,
    _primaryButton: new FakeElement('button'), _nextStep: new FakeElement('span'),
    _primaryReason: new FakeElement('span'), _actionBar: new FakeElement('div'),
    _setup: { count: { value: '1' }, inputs: [workerInput], planButton: new FakeElement('button'),
      planHint: new FakeElement('span') },
  };
  syncSetupActions.call(guidanceHost);
  assert.strictEqual([guidanceHost._nextStep, guidanceHost._primaryReason, guidanceHost._setup.planHint]
    .filter((element) => !element.hidden && element.textContent).length, 1,
  'incomplete setup must show one actionable guidance message, not duplicates');
  guidanceHost._cwd = 'D:\\repo'; taskField.value = 'نفّذ المهمة'; ownershipField.value = 'src/**';
  syncSetupActions.call(guidanceHost);
  assert.strictEqual([guidanceHost._nextStep, guidanceHost._primaryReason, guidanceHost._setup.planHint]
    .filter((element) => !element.hidden && element.textContent).length, 1,
  'complete setup must keep exactly one guidance line — the nextAction ladder label');
  assert.strictEqual(guidanceHost._nextStep.textContent, 'إرشاد الخطوة التالية من السلم.',
    'the blocking reason must yield back to the ladder label, not hide recovery guidance (timeout/merged)');

  // ب‑1: شريط المحطات يُبنى من المفاتيح الخمسة، ويعرض حالات deriveStations نفسها
  // بسمات data وبأسماء عربية آمنة، من دون بناء HTML نصي.
  const stationKeys = ['setup', 'execute', 'review', 'verify', 'merge'];
  const buildStations = new Function('document', 'STATION_KEYS',
    'return function () {' + methodBody(component, '  _buildStations()') + '};')(document, stationKeys);
  const stationClicks = [];
  const stationHost = {
    _stationStrip: new FakeElement('nav'), _selectStation: (key) => stationClicks.push(key),
  };
  buildStations.call(stationHost);
  assert.deepStrictEqual(stationHost._stationStrip.children.map((button) => button.dataset.station), stationKeys,
    'guided path must build five station buttons in deriveStations order');
  assert(stationHost._stationStrip.children.every((button) => button.tagName === 'button'),
    'every guided station must be a real button');
  stationHost._stationStrip.children[2].listeners.click();
  assert.deepStrictEqual(stationClicks, ['review'], 'station buttons must route through the shared station selector');

  const renderStations = new Function('MORE_VIEWS', 'text',
    'return function (stations, derived) {' + methodBody(component, '  _renderStations(stations, derived)') + '};')(
    [['history', 'التاريخ'], ['decisions', 'القرارات'], ['discussion', 'النقاش']],
    safeText,
  );
  const renderedStations = [
    { key: 'setup', label: 'إعداد', completed: true, current: false, alert: false },
    { key: 'execute', label: 'تنفيذ', completed: false, current: true, alert: false },
    { key: 'review', label: 'مراجعة', completed: false, current: false, alert: true },
    { key: 'verify', label: 'تحقق', completed: false, current: false, alert: false },
    { key: 'merge', label: 'دمج', completed: false, current: false, alert: false },
  ];
  const renderedHost = {
    _stationButtons: stationHost._stationButtons, _displayedStationKey: 'execute', _displayedMoreView: '',
    _stationTitle: new FakeElement('div'), _moreButton: new FakeElement('button'),
    _stationStrip: stationHost._stationStrip,
    _stationStatusLabel: (station) => station.alert ? 'تحتاج الانتباه'
      : station.completed ? 'مكتملة' : station.current ? 'الحالية' : 'لاحقة',
  };
  renderStations.call(renderedHost, renderedStations, { nextAction: { key: 'team_running' } });
  assert.deepStrictEqual(stationKeys.map((key) => renderedHost._stationButtons[key].button.dataset.state),
    ['completed', 'current', 'pending', 'pending', 'pending'],
  'station data-state values must mirror derived completion/current/pending states');
  assert.strictEqual(renderedHost._stationButtons.review.button.dataset.alert, 'true',
    'station alerts must be exposed as a data attribute');
  assert.deepStrictEqual(stationKeys.map((key) => renderedHost._stationButtons[key].marker.textContent),
    ['✓', '●', '⚠', '○', '○'], 'station markers must expose completed/current/alert/future states');
  assert(stationKeys.every((key) => /[\u0600-\u06ff]/.test(renderedHost._stationButtons[key].button.attributes['aria-label'] || '')),
    'every station button must carry an Arabic aria-label with its state');
  assert(renderedHost._stationTitle.textContent.startsWith('المحطة: تنفيذ'),
    'the displayed station must have a compact Arabic heading');

  let selectableStations = renderedStations;
  const selectStation = new Function(
    'deriveStations', 'deriveOpsRoomState', 'mergeGateLabel', 'setMixedTechnicalText', 'STATION_VIEWS', 'text',
    'return function (key) {' + methodBody(component, '  _selectStation(key)') + '};',
  )(
    () => selectableStations,
    () => ({ nextAction: { key: 'team_running', label: 'التنفيذ لم يكتمل بعد.' } }),
    () => 'المتبقي: نجاح التحقق وموافقة المراجعات.',
    (target, value) => { target.textContent = value; },
    { setup: 'tasks', execute: 'tasks', review: 'review', verify: 'evidence', merge: 'diffs' },
    safeText,
  );
  const shownViews = [];
  const routeHost = {
    _state: {}, _status: new FakeElement('div'), _statusRow: new FakeElement('div'),
    _displayedStationKey: '', _displayedMoreView: '',
    _show: (id) => { shownViews.push(id); return true; }, _closeMoreMenu: () => {}, _renderStations: () => {},
  };
  selectStation.call(routeHost, 'setup');
  assert.deepStrictEqual(shownViews, ['tasks'], 'a completed setup station must route to the existing tasks view');
  selectableStations = renderedStations.map((station) => ({
    ...station, completed: true, current: station.key === 'merge', alert: false,
  }));
  shownViews.length = 0;
  for (const key of stationKeys) selectStation.call(routeHost, key);
  assert.deepStrictEqual(shownViews, ['tasks', 'tasks', 'review', 'evidence', 'diffs'],
    'completed/current station clicks must reuse the approved existing views');
  selectableStations = renderedStations;
  shownViews.length = 0;
  selectStation.call(routeHost, 'review');
  assert.deepStrictEqual(shownViews, [], 'a future station must not move the current view');
  assert.strictEqual(routeHost._status.textContent, 'التنفيذ لم يكتمل بعد.',
    'a future station must show existing nextAction guidance');
  selectStation.call(routeHost, 'merge');
  assert(routeHost._status.textContent.includes('نجاح التحقق'),
    'a future merge station must reuse the existing merge gate guidance');
  // ب‑3: حين يتكلم شريط الفعل السفلي لا تكرر بوابةُ المحطة اللاحقة المعنى سطراً علوياً؛
  // بوابة الدمج وحدها تضيف تفصيل «ما تبقى» فتُعرض دائماً.
  routeHost._nextStep = new FakeElement('div');
  routeHost._nextStep.hidden = false;
  routeHost._nextStep.textContent = 'اكتب مهمة وملكية ملفات لكل عامل.';
  routeHost._status.textContent = ''; routeHost._statusRow.hidden = true;
  selectStation.call(routeHost, 'review');
  assert.strictEqual(routeHost._status.textContent, '',
    'a speaking action bar must silence the duplicate future-station guidance (B3)');
  assert.strictEqual(routeHost._statusRow.hidden, true,
    'the silenced gate row must stay hidden (B3)');
  selectStation.call(routeHost, 'merge');
  assert(routeHost._status.textContent.includes('نجاح التحقق'),
    'the merge gate detail must survive a speaking action bar (B3)');

  const toggleMoreMenu = new Function('deriveStations', 'deriveOpsRoomState', 'return function () {'
    + methodBody(component, '  _toggleMoreMenu()') + '};')(() => renderedStations, () => ({}));
  const oneClickViews = [];
  const menuHost = {
    _state: {}, _moreMenu: new FakeElement('div'), _moreButton: new FakeElement('button'),
    _displayedMoreView: '', _show: (id) => { oneClickViews.push(id); return true; }, _renderStations: () => {},
  };
  menuHost._moreMenu.hidden = true;
  toggleMoreMenu.call(menuHost);
  assert.strictEqual(menuHost._moreMenu.hidden, false);
  assert.strictEqual(menuHost._moreButton.attributes['aria-expanded'], 'true',
    'the More control must expose its open state accessibly');
  assert.deepStrictEqual(oneClickViews, ['history']);
  assert(menuHost._displayedMoreView === 'history' && menuHost._displayedStationKey === '',
    'one More click from the guided path must display history while leaving its menu open');

  const buildMoreMenu = new Function('document', 'MORE_VIEWS',
    'return function () {' + methodBody(component, '  _buildMoreMenu()') + '};')(
    document, [['history', 'التاريخ'], ['decisions', 'القرارات'], ['discussion', 'النقاش']],
  );
  const moreMenuHost = {
    _moreMenu: new FakeElement('div'), _selectMoreView: () => {},
  };
  buildMoreMenu.call(moreMenuHost);
  assert.deepStrictEqual(moreMenuHost._moreMenu.children.map((button) => button.textContent),
    ['التاريخ', 'القرارات', 'النقاش'], 'history must lead the one-click More menu after restart');
  assert(!moreMenuHost._moreMenu.children.some((button) => button.textContent === 'العصف'),
    'brainstorm must leave More after moving into setup');

  const selectMoreView = new Function('MORE_VIEWS', 'deriveStations', 'deriveOpsRoomState',
    'return function (id) {' + methodBody(component, '  _selectMoreView(id)') + '};')(
    [['history', 'التاريخ'], ['decisions', 'القرارات'], ['discussion', 'النقاش']],
    () => renderedStations, () => ({ nextAction: { key: 'wait' } }),
  );
  const moreHost = {
    _state: {}, _show: (id) => { shownViews.push(id); return true; }, _closeMoreMenu: () => { moreHost.closed = true; },
    _renderStations: () => {}, closed: false,
  };
  selectMoreView.call(moreHost, 'history');
  assert(shownViews.includes('history') && moreHost.closed && moreHost._displayedMoreView === 'history',
    'the More menu must open history through the flat view surface');

  const openSetupBrainstorm = new Function('deriveStations', 'deriveOpsRoomState',
    'return function () {' + methodBody(component, '  _openSetupBrainstorm()') + '};')(
    () => renderedStations, () => ({ nextAction: { key: 'wait' } }),
  );
  const brainstormViews = [];
  const brainstormHost = {
    _state: {}, _show: (id) => { brainstormViews.push(id); return true; },
    _closeMoreMenu: () => {}, _renderStations: () => {},
  };
  openSetupBrainstorm.call(brainstormHost);
  assert.deepStrictEqual(brainstormViews, ['brainstorm']);
  assert(brainstormHost._displayedStationKey === 'setup' && brainstormHost._displayedMoreView === '',
    'the setup brainstorm tool must remain owned by setup, so clicking setup returns to the form');

  const syncStationView = new Function('STATION_VIEWS',
    'return function (stations) {' + methodBody(component, '  _syncStationView(stations)') + '};')(
    { setup: 'tasks', execute: 'tasks', review: 'review', verify: 'evidence', merge: 'diffs' },
  );
  const syncViews = [];
  const syncHost = {
    _currentStationKey: 'execute', _stationUserView: true, _displayedStationKey: 'setup', _displayedMoreView: '',
    _show: (id) => syncViews.push(id), _closeMoreMenu: () => {},
  };
  syncStationView.call(syncHost, renderedStations);
  assert.deepStrictEqual(syncViews, [], 'manual station choice must survive renders within the same current station');
  syncStationView.call(syncHost, renderedStations.map((station) => ({
    ...station, current: station.key === 'review', completed: station.key === 'setup' || station.key === 'execute',
  })));
  assert.deepStrictEqual(syncViews, ['review']);
  assert.strictEqual(syncHost._stationUserView, false,
    'a current-station transition must resume automatic guided routing');

  class FakeCustomEvent {
    constructor(type, options) { this.type = type; this.detail = options && options.detail; this.bubbles = options && options.bubbles; }
  }
  const openVerifyConfig = new Function('CustomEvent',
    'return function () {' + methodBody(component, '  _openVerifyConfig()') + '};')(FakeCustomEvent);
  const recoveryEvents = [];
  const recoveryHost = { _cwd: 'D:\\repo\\loop-review', dispatchEvent: (event) => recoveryEvents.push(event) };
  openVerifyConfig.call(recoveryHost);
  assert.strictEqual(recoveryEvents.length, 1, 'review skill recovery button must emit one wizard event');
  assert.deepStrictEqual({ type: recoveryEvents[0].type, bubbles: recoveryEvents[0].bubbles, detail: recoveryEvents[0].detail }, {
    type: 'verify-config-open', bubbles: true, detail: { cwd: 'D:\\repo\\loop-review' },
  }, 'review skill recovery must reuse the existing cwd-scoped verification wizard event');
  recoveryHost._cwd = '';
  openVerifyConfig.call(recoveryHost);
  assert.strictEqual(recoveryEvents.length, 1, 'review skill recovery must not emit without a cwd');
}

function loopFixture(overrides) {
  return {
    type: 'loop_update', schema_version: 1,
    loop_id: 'loop-ui-test', team_id: 'execution-team-ui-test', room_id: 'ops-room-ui-test',
    state: 'working', iteration: 2, max_iterations: 3,
    last_failure_summary: 'فشل اختبار الواجهة (رمز الخروج 1)',
    cost: { usd: 0.42, input_tokens: 12000, output_tokens: 3000, estimate: true },
    budget: { limit_tokens: 400000, used_tokens: 15000, estimate: true, exhausted: false },
    stop_reason: '', updated_at: 1_722_345_678_000,
    ...(overrides || {}),
  };
}

async function testReducer() {
  const stateModule = await loadStateModule();
  const {
    createOpsRoomState, deriveAgentActivity, opsRoomReducer, deriveOpsRoomState, isCurrentArtifact,
    INHERIT_TEMPLATE_TEAM_STATES, OBSERVABLE_ACTIVITY_QUIET_MS,
  } = stateModule;
  const artifact = 'a'.repeat(64);
  const staleArtifact = 'b'.repeat(64);
  const current = fixture(artifact);

  assert.deepStrictEqual([...INHERIT_TEMPLATE_TEAM_STATES], [
    'failed', 'timed_out', 'stopped', 'conflict', 'cleanup_failed',
  ], 'only failed/stopped terminal teams may seed a retry template');
  assert.strictEqual(INHERIT_TEMPLATE_TEAM_STATES.has('completed'), false,
    'successful completion must open a clean setup form');

  let state = createOpsRoomState();
  assert.strictEqual(state.loop, null, 'loop state starts empty');
  assert.strictEqual(deriveOpsRoomState(state).canStart, true, 'initial execution must be available');
  state = opsRoomReducer(state, { type: 'event', event: {
    type: 'execution_team_update', team: { ...current.team, state: 'running', artifact_id: '' },
  } });
  assert.strictEqual(deriveOpsRoomState(state).canStop, true, 'running team must be stoppable');
  assert.strictEqual(deriveOpsRoomState(state).nextAction.key, 'team_running', 'running team needs a truthful wait instruction');
  assert.strictEqual(deriveOpsRoomState(state).canReview, false, 'review cannot start before artifact completion');

  const activityNow = 1_000_000;
  assert.deepStrictEqual(deriveAgentActivity({ state: 'running', last_activity_at: activityNow - 5_000 }, activityNow), {
    kind: 'waiting', observed: false, lastActivityAt: activityNow - 5_000, elapsedMs: 5_000,
  }, 'a timestamp without a tool or file is not observable worker activity');
  assert.strictEqual(deriveAgentActivity({
    state: 'running', last_tool: 'read', last_activity_at: activityNow - OBSERVABLE_ACTIVITY_QUIET_MS + 1,
  }, activityNow).kind, 'recent', 'recent observable tool activity stays truthful');
  assert.strictEqual(deriveAgentActivity({
    state: 'running', last_file: 'src/app.js', last_activity_at: activityNow - OBSERVABLE_ACTIVITY_QUIET_MS,
  }, activityNow).kind, 'quiet', 'the documented threshold describes silence without claiming a stall');
  assert.strictEqual(deriveAgentActivity({
    state: 'timed_out', last_tool: 'read', last_activity_at: activityNow - 1,
  }, activityNow).kind, 'terminal', 'terminal agent state overrides activity recency');

  for (const [teamState, key, phrase] of [
    ['failed', 'retry_failed', 'راجع السبب'],
    ['timed_out', 'retry_timeout', 'ضيّق المهمة'],
    ['conflict', 'retry_conflict', 'افصل الملكيات'],
    ['cleanup_failed', 'retry_cleanup', 'نظّفها يدوياً'],
    ['stopped', 'retry_stopped', 'بطلب المستخدم'],
  ]) {
    const terminal = opsRoomReducer(createOpsRoomState(), { type: 'hydrate', team: {
      ...current.team, state: teamState, artifact_id: '', merge_supported: false,
    } });
    const derived = deriveOpsRoomState(terminal);
    assert.strictEqual(derived.nextAction.key, key, teamState + ' needs a specific recovery action');
    assert(derived.nextAction.label.includes(phrase), teamState + ' recovery must explain the next step');
    assert.strictEqual(derived.nextAction.action, 'start', teamState + ' retry remains an explicit user action');
  }

  state = opsRoomReducer(state, { type: 'hydrate', room: {
    room_id: current.team.room_id,
    entries: [
      { id: 'ops-entry-b', type: 'note', actor: 'system', text: 'ثانٍ', created_at: 20 },
      { id: 'ops-entry-a', type: 'note', actor: 'system', text: 'أول', created_at: 10 },
    ],
  }, team: current.team });
  assert.deepStrictEqual(state.entries.map((entry) => entry.id), ['ops-entry-a', 'ops-entry-b'], 'hydrate ordering');
  state = opsRoomReducer(state, { type: 'event', event: {
    type: 'ops_room_update', room_id: current.team.room_id,
    entry: { id: 'ops-entry-c', type: 'note', actor: 'system', text: 'ثالث', created_at: 20 },
  } });
  state = opsRoomReducer(state, { type: 'event', event: {
    type: 'ops_room_update', room_id: current.team.room_id,
    entry: { id: 'ops-entry-c', type: 'note', actor: 'system', text: 'مكرر', created_at: 20 },
  } });
  assert.deepStrictEqual(state.entries.map((entry) => entry.id), ['ops-entry-a', 'ops-entry-b', 'ops-entry-c'], 'stable dedupe ordering');
  assert.strictEqual(deriveOpsRoomState(state).canReview, true, 'completed artifact must expose explicit review action');
  assert.strictEqual(deriveOpsRoomState(state).nextAction.action, 'review', 'completed artifact recommends review without starting it');

  for (const reviewState of ['stopped', 'failed', 'timed_out']) {
    const incompleteReview = opsRoomReducer(createOpsRoomState(), {
      type: 'hydrate', team: current.team, review: {
        id: 'execution-review-incomplete-' + reviewState,
        team_id: current.team.id, artifact_id: artifact, state: reviewState,
      },
    });
    const derived = deriveOpsRoomState(incompleteReview);
    assert.strictEqual(derived.canReview, true,
      reviewState + ' review must expose an explicit retry for the same artifact');
    assert.strictEqual(derived.nextAction.key, 'review');
    assert(derived.nextAction.label.includes('إعادة المراجعة للأثر نفسه'),
      reviewState + ' review guidance must explain the same-artifact retry');
  }
  const completedNotApproved = judgesFixture(artifact).review;
  const completedReviewState = opsRoomReducer(createOpsRoomState(), {
    type: 'hydrate', team: current.team, review: completedNotApproved,
  });
  assert.strictEqual(deriveOpsRoomState(completedReviewState).canReview, false,
    'a completed non-approved review must remain final');

  let mergedState = opsRoomReducer(createOpsRoomState(), {
    type: 'hydrate', team: { ...current.team, merged: true }, review: current.review,
    verification: current.verification,
  });
  const mergedDerived = deriveOpsRoomState(mergedState);
  assert.strictEqual(mergedDerived.nextAction.key, 'merged', 'merged work must retain its terminal context');
  assert.strictEqual(mergedDerived.nextAction.action, 'start', 'merged work must expose a new-task action');
  mergedState = opsRoomReducer(mergedState, { type: 'pending', action: 'start' });
  assert.strictEqual(deriveOpsRoomState(mergedState).nextAction.action, '',
    'pending merged transition must not expose a duplicate start action');

  let loopState = opsRoomReducer(createOpsRoomState(), {
    type: 'hydrate', room: { room_id: current.team.room_id, entries: [] }, team: current.team,
    loop: loopFixture({ state: 'preparing', iteration: 1 }),
  });
  assert.strictEqual(loopState.loop.state, 'preparing', 'hydrate accepts the latest loop snapshot');
  loopState = opsRoomReducer(loopState, { type: 'event', event: loopFixture() });
  assert.strictEqual(loopState.loop.iteration, 2, 'matching loop_update is consumed');
  assert.strictEqual(Object.prototype.hasOwnProperty.call(loopState.loop, 'review'), false,
    'legacy loop_update without review must retain the previous snapshot shape');
  const runningLoop = deriveOpsRoomState(loopState);
  assert.strictEqual(runningLoop.loopActive, true, 'non-terminal loop is active');
  assert.strictEqual(runningLoop.loopTerminal, false, 'non-terminal loop is not terminal');
  assert.strictEqual(runningLoop.canStart, false, 'active loop owns the execution start gate');
  assert.strictEqual(runningLoop.canStop, false, 'active loop uses its own stop button, not the team stop button');
  assert.strictEqual(runningLoop.canReview, false, 'active loop blocks review');
  assert.strictEqual(runningLoop.canPrepareVerification, false, 'active loop blocks formal verification preparation');
  assert.strictEqual(runningLoop.nextAction.key, 'loop_running', 'active loop precedes team-running guidance');
  assert.strictEqual(runningLoop.nextAction.action, '', 'loop_running is descriptive only');
  const gateKeys = [
    'loopActive', 'loopTerminal', 'canStart', 'canStop', 'canReview', 'canPrepareVerification',
    'canRunVerification', 'canMerge', 'showPreview', 'canPreview', 'canStopPreview', 'nextAction',
  ];
  const baselineGates = Object.fromEntries(gateKeys.map((key) => [key, runningLoop[key]]));
  const reviewStates = ['idle', 'running', 'approve', 'changes_required', 'reject', 'failed'];
  for (const reviewState of reviewStates) {
    const syntheticReview = {
      configured: true, state: reviewState,
      summary: reviewState === 'idle' ? '' : 'ملخص مراجعة نوعية اصطناعي.',
    };
    const reviewedState = opsRoomReducer(loopState, {
      type: 'event', event: loopFixture({ review: syntheticReview }),
    });
    assert.deepStrictEqual(reviewedState.loop.review, syntheticReview,
      'loop reducer must consume the additive review state ' + reviewState);
    assert.notStrictEqual(reviewedState.loop.review, syntheticReview,
      'loop reducer must detach the nested review snapshot ' + reviewState);
    const reviewedGates = deriveOpsRoomState(reviewedState);
    assert.deepStrictEqual(Object.fromEntries(gateKeys.map((key) => [key, reviewedGates[key]])), baselineGates,
      'loop review must not change existing gates or nextAction for ' + reviewState);
  }
  loopState = opsRoomReducer(loopState, { type: 'event', event: loopFixture({
    room_id: 'ops-room-other-test', iteration: 3,
  }) });
  assert.strictEqual(loopState.loop.iteration, 2, 'loop update from another room is ignored');
  loopState = opsRoomReducer(loopState, { type: 'event', event: loopFixture({
    team_id: 'execution-team-other-test', iteration: 3,
  }) });
  assert.strictEqual(loopState.loop.iteration, 2, 'loop update from another team is ignored');
  loopState = opsRoomReducer(loopState, { type: 'event', event: loopFixture({
    state: 'passed', stop_reason: 'pass', iteration: 3,
  }) });
  const passedLoop = deriveOpsRoomState(loopState);
  assert.strictEqual(passedLoop.loopActive, false, 'passed loop releases active ownership');
  assert.strictEqual(passedLoop.loopTerminal, true, 'passed loop is terminal');
  assert.strictEqual(passedLoop.nextAction.action, 'review', 'passed loop returns to the ordinary review gate');
  loopState = opsRoomReducer(loopState, { type: 'event', event: {
    type: 'execution_team_update', team: { ...current.team, id: 'execution-team-new-test' },
  } });
  assert.strictEqual(loopState.loop, null, 'changing the team id clears the old loop snapshot');

  state = opsRoomReducer(state, { type: 'settled', review: current.review });
  assert.strictEqual(deriveOpsRoomState(state).canPrepareVerification, true, 'all actual verdicts unlock prepare only');
  assert.strictEqual(deriveOpsRoomState(state).nextAction.action, 'prepare');
  state = opsRoomReducer(state, { type: 'settled', verification: { ...current.verification, state: 'pending_confirmation' } });
  assert.strictEqual(deriveOpsRoomState(state).showPreview, false, 'preview stays hidden before passed verification');
  assert.strictEqual(deriveOpsRoomState(state).canRunVerification, true, 'pending verification needs explicit confirmation');
  assert.strictEqual(deriveOpsRoomState(state).nextAction.action, 'verify');
  state = opsRoomReducer(state, { type: 'settled', verification: current.verification });
  assert.strictEqual(deriveOpsRoomState(state).canMerge, true, 'same-artifact approvals and verification unlock merge');
  assert.strictEqual(deriveOpsRoomState(state).showPreview, true, 'passed verification exposes preview helper');
  assert.strictEqual(deriveOpsRoomState(state).canPreview, true, 'preview needs its own explicit action');
  assert.strictEqual(deriveOpsRoomState(state).nextAction.action, 'merge');
  assert.strictEqual(isCurrentArtifact(current.verification, state), true, 'artifact helper accepts current fingerprint');
  state = opsRoomReducer(state, { type: 'event', event: {
    type: 'execution_preview_update', preview: { artifact_id: artifact, state: 'running', url: 'http://localhost:4319/' },
  } });
  assert.strictEqual(deriveOpsRoomState(state).previewActive, true);
  assert.strictEqual(deriveOpsRoomState(state).canStopPreview, true);
  assert.strictEqual(deriveOpsRoomState(state).canMerge, true, 'live preview must not alter merge gate');
  state = opsRoomReducer(state, { type: 'settled', preview: {
    artifact_id: artifact, state: 'cleanup_failed', url: 'http://localhost:4319/',
  } });
  assert.strictEqual(deriveOpsRoomState(state).canPreview, false, 'failed cleanup must block another preview');
  assert.strictEqual(deriveOpsRoomState(state).canStopPreview, true, 'failed cleanup must expose an explicit retry');
  state = opsRoomReducer(state, { type: 'settled', preview: null });

  const staleReview = fixture(staleArtifact).review;
  state = opsRoomReducer(state, { type: 'settled', review: staleReview, verification: current.verification });
  assert.strictEqual(deriveOpsRoomState(state).canMerge, false, 'stale review must not unlock merge');
  state = opsRoomReducer(state, { type: 'settled', review: current.review,
    verification: { ...current.verification, artifact_id: staleArtifact } });
  assert.strictEqual(deriveOpsRoomState(state).canMerge, false, 'stale verification must not unlock merge');
  const mixedFingerprint = fixture(artifact).review;
  mixedFingerprint.reviews[1] = { ...mixedFingerprint.reviews[1], artifact_id: staleArtifact };
  state = opsRoomReducer(state, { type: 'settled', review: mixedFingerprint, verification: current.verification });
  assert.strictEqual(deriveOpsRoomState(state).canMerge, false, 'one stale verdict must close the gate');
  const rejected = fixture(artifact).review;
  rejected.reviews[0] = { ...rejected.reviews[0], verdict: {
    schema_version: 1, decision: 'reject', source: 'explicit',
  } };
  state = opsRoomReducer(state, { type: 'settled', review: rejected, verification: current.verification });
  assert.strictEqual(deriveOpsRoomState(state).canMerge, false, 'rejection cannot be overridden');

  const judges = judgesFixture(artifact);
  let judgesState = opsRoomReducer(createOpsRoomState(), {
    type: 'hydrate', room: { room_id: current.team.room_id, entries: [] }, team: current.team,
  });
  judgesState = opsRoomReducer(judgesState, { type: 'event', event: {
    type: 'execution_review_update', review: judges.review,
  } });
  assert.deepStrictEqual(
    judgesState.review.merged_report.items.map((item) => item.text),
    judges.review.merged_report.items.map((item) => item.text),
    'merged report item order must survive the existing review event unchanged',
  );
  assert.deepStrictEqual(
    judgesState.review.reviews[0].lenses.map((item) => item.lens),
    ['correctness', 'security', 'simplicity'],
    'the three frozen review lenses must survive the existing review event',
  );
  assert.strictEqual(judgesState.review.merged_report.truncated, true,
    'the merged report truncation marker must survive the existing review event');
  assert.strictEqual(deriveOpsRoomState(judgesState).canPrepareVerification, false,
    'aggregated changes_required verdicts must keep the existing gate closed');

  const legacyReview = fixture(artifact).review;
  const legacyState = opsRoomReducer(judgesState, { type: 'event', event: {
    type: 'execution_review_update', review: legacyReview,
  } });
  assert.strictEqual(Object.prototype.hasOwnProperty.call(legacyState.review, 'merged_report'), false,
    'a legacy review event without merged_report must remain valid');
  assert(legacyState.review.reviews.every((item) => !Object.prototype.hasOwnProperty.call(item, 'lenses')),
    'legacy review items without lenses must remain valid');
  assert.strictEqual(deriveOpsRoomState(legacyState).canPrepareVerification, true,
    'legacy approved review events must retain their existing gate behavior');

  const oneFilePatch = [
    'diff --git a/src/app.js b/src/app.js',
    'index 1111111..2222222 100644',
    '--- a/src/app.js',
    '+++ b/src/app.js',
    '@@ -1 +1 @@',
    '-old',
    '+new',
    '',
  ].join('\n');
  const diffArtifact = { patch: oneFilePatch, files: [{ rel: 'src/app.js', kind: 'mod', added: 1, removed: 1 }] };
  assert.strictEqual(opsartifacts.fileDiff(diffArtifact, 'src/outside.js').error, 'file_not_in_artifact');
  const fileDiff = opsartifacts.fileDiff(diffArtifact, 'src/app.js');
  assert(fileDiff.ok && fileDiff.diff.lines.length === 2 && !Object.prototype.hasOwnProperty.call(fileDiff, 'patch'));
  assert(Buffer.byteLength(JSON.stringify(fileDiff), 'utf8') <= opsartifacts.MAX_FILE_DIFF_BYTES);
}

function testDesignGuard() {
  const files = changedFiles();
  const inlineStyle = new RegExp('\\sstyle\\s*=', 'i');
  const inlineHandler = /\son[a-z]+\s*=/i;
  const inlineScript = /<script(?![^>]*\bsrc\s*=)[^>]*>/i;
  const shadowStyleTag = new RegExp('<' + 'style(?:\\s|>)', 'i');
  const numericZ = /z-index\s*:\s*-?\d+(?:\.\d+)?\b/i;
  for (const relative of files) {
    const normalized = relative.replace(/\\/g, '/');
    const source = read(relative);
    if (normalized.endsWith('.html')) {
      assert(!inlineStyle.test(source), normalized + ': inline style attribute');
      assert(!inlineHandler.test(source), normalized + ': inline event handler');
      assert(!inlineScript.test(source), normalized + ': inline script block');
    }
    if (normalized.endsWith('.js') && normalized.startsWith('src/ui/')) {
      assert(!shadowStyleTag.test(source), normalized + ': style tag inside component source');
      assert(!numericZ.test(source), normalized + ': numeric z-index outside tokens');
    }
    if (normalized.endsWith('.css') && normalized !== 'src/styles/base.css'
      && !normalized.startsWith('src/vendor/')) {
      assert(!numericZ.test(source), normalized + ': numeric z-index outside tokens');
    }
  }
  const index = read('src/index.html');
  assert(!index.includes("'unsafe-inline'"), 'CSP must remain strict');
  const midRowStart = index.indexOf('<div id="midRow">');
  const terminalIndex = index.indexOf('<satr-terminal-panel>');
  const midRowClose = index.lastIndexOf('</div>', terminalIndex);
  const midRow = index.slice(midRowStart, terminalIndex);
  const chatColumn = midRow.slice(midRow.indexOf('<div id="chatColumn">'), midRow.indexOf('<satr-ops-room'));
  assert(chatColumn.includes('<satr-chat>') && chatColumn.includes('<satr-composer>'),
    'chat column must contain both chat and composer');
  assert(midRow.includes('<satr-ops-room') && midRow.includes('<satr-preview-panel'),
    'ops room and preview must remain siblings of the chat column inside the middle row');
  assert((index.match(/<satr-composer>/g) || []).length === 1
    && index.indexOf('<satr-composer>') < index.indexOf('<satr-ops-room'),
  'composer must exist once inside the chat column, before side surfaces');
  assert(midRowClose > index.indexOf('<satr-preview-panel') && terminalIndex > midRowClose,
    'terminal must remain outside and below the middle row');
  const base = read('src/styles/base.css');
  const composer = read('src/ui/components/composer.js');
  const composerStylesStart = base.indexOf('/* ===== الإدخال + قائمة الأوامر ===== */');
  const composerStylesEnd = base.indexOf('/* ===== لوحة الجلسات:', composerStylesStart);
  assert(composerStylesStart !== -1 && composerStylesEnd !== -1,
    'composer style block markers must remain available for scoped guards');
  const composerStyles = base.slice(composerStylesStart, composerStylesEnd);
  assert(!/\b(?:innerHTML|insertAdjacentHTML)\b/.test(composer),
    'composer must construct UI with safe DOM methods only');
  assert(!/#[0-9a-fA-F]{3,8}(?![0-9a-fA-F])/.test(composerStyles),
    'composer styles must use semantic color tokens only');
  assert(!/z-index\s*:\s*-?\d+(?:\.\d+)?\b/i.test(composerStyles),
    'composer styles must use z-index tokens only');
  for (const token of ['--z-base: 0', '--z-system: 1000', '--space-0: 0', '--space-7: 48px',
    '--radius-xs: 4px', '--radius-pill: 999px', '--side-surfaces-wide: 120rem']) {
    assert(base.includes(token), 'missing design token ' + token);
  }
  assert(base.includes('#chatColumn {') && base.includes('display: flex; flex-direction: column; flex: 1;')
    && base.includes('min-width: 0; min-height: 0;')
    && base.includes('container: chat-column / inline-size;'),
  'chat column must be the shrink-safe flexible middle-row surface');
  assert(base.includes('satr-chat { display: contents; }') && base.includes('satr-composer { display: contents; }'),
    'chat and composer light-DOM wrappers must stay display:contents');
  assert(base.includes('@container chat-column (max-width: 48rem)')
    && base.includes('@container chat-column (max-width: 28rem)')
    && base.includes('.composer textarea { grid-column: 1 / -1; width: 100%; }')
    && base.includes('#attachBtn { grid-column: 1 / -1; }')
    && base.includes('.awareness-bar { justify-content: flex-start; }'),
  'composer responsiveness must follow chat-column width and preserve usable controls');
  const packageJson = JSON.parse(read('package.json'));
  assert.strictEqual(packageJson.scripts['test:chatcolumn-layout'],
    'electron scripts/chatcolumn-layout-test.js',
    'live chat-column layout test must remain available through package scripts');
  const layoutFixture = read('scripts/fixtures/chatcolumn-layout.html');
  assert(layoutFixture.includes('../../src/styles/base.css')
    && layoutFixture.includes('../../src/ui/components/composer.js')
    && layoutFixture.indexOf('chatcolumn-layout-config.js') < layoutFixture.indexOf('chatcolumn-layout.css'),
  'layout fixture must exercise the production stylesheet and composer component');
  const layoutConfig = read('scripts/fixtures/chatcolumn-layout-config.js');
  const layoutCss = read('scripts/fixtures/chatcolumn-layout.css');
  const layoutRunner = read('scripts/chatcolumn-layout-test.js');
  assert(layoutRunner.includes("extractBlock(index, '<satr-composer>', '</satr-composer>')")
    && layoutRunner.includes('for (const width of LAYOUT_WIDTHS)')
    && layoutRunner.includes("win.loadFile(FIXTURE, { query: { width: String(width) } })")
    && layoutConfig.includes("new Set(['806', '504', '381'])")
    && layoutCss.includes('html[data-layout-width="504"] #chatColumn'),
  'layout runner must guard fixture parity and all three approved column widths');
  assert.strictEqual(packageJson.scripts['test:opsroom-ui-live'],
    'electron scripts/opsroom-ui-live-test.js',
    'live ops-room UI test must remain available through package scripts');
  assert.strictEqual(packageJson.scripts['test:verify-config-dialog'],
    'electron scripts/verify-config-dialog-live-test.js',
    'verification config wizard live test must remain available through package scripts');
  const opsLiveFixture = read('scripts/fixtures/opsroom-ui-live.html');
  assert(opsLiveFixture.includes('../../src/styles/base.css')
    && opsLiveFixture.includes('../../src/ui/components/ops-room.js'),
  'ops-room live fixture must exercise the production stylesheet and component');
  const stateSource = read('src/ui/lib/ops-room-state.js');
  assert(stateSource.includes('export function deriveAgentActivity(agent, currentTime)')
    && stateSource.includes("key: 'retry_timeout'") && stateSource.includes("key: 'retry_cleanup'"),
  'ops-room state must derive observable activity and terminal recovery guidance purely');
  const component = read('src/ui/components/ops-room.js');
  testJudgesHelpers(component);
  assert(component.includes("from '../lib/lifecycle-labels.js'")
    && ['LIFECYCLE_LABELS', 'lifecycleLabel', 'countLabel', 'truncateWords'].every((name) => component.includes(name)),
  'ops room must consume all shared lifecycle and Arabic wording helpers');
  for (const rawFallback of [
    'LOOP_STATES[loop.state] || loop.state', 'TEAM_STATES[agent.state] || agent.state',
    "verification.state === 'failed' ? 'فشل' : verification.state", 'stateLabel: entry.type',
    "worker.state === 'running' ? 'يفكّر…' : worker.state", 'TEAM_STATES[item.state] || item.state',
  ]) {
    assert(!component.includes(rawFallback), 'visible lifecycle state must not fall back to raw token: ' + rawFallback);
  }
  assert(component.includes('adoptedStyleSheets'), 'ops room must use constructable stylesheets');
  assert(component.includes("makeElement('button', 'verify-config', 'إعداد التحقق')")
    && component.includes("new CustomEvent('verify-config-open'"),
  'ops room must expose the manual verification config wizard without a slash command');
  assert(!component.includes('innerHTML') && !component.includes('insertAdjacentHTML'),
    'ops room must construct UI with safe DOM methods only');
  assert(!component.includes('room-nav') && !component.includes('className = \'subnav\'')
    && !component.includes('group-view') && !component.includes('group-badge')
    && !component.includes('_groupViews') && !component.includes('_groupSeen'),
  'removed group tabs, sub-tabs, and their seen/preference state must not survive in DOM, CSS, or logic');
  assert(component.includes('deriveOpsRoomState, deriveStations,') && component.includes('opsRoomReducer, STATION_KEYS,'),
    'guided path must consume the pure station derivation and fixed key order');
  assert(component.includes('for (const key of STATION_KEYS)')
    && component.includes("button.dataset.station = key")
    && component.includes("parts.button.dataset.state = state")
    && component.includes("parts.button.dataset.alert = 'true'"),
  'guided path must build five derived station buttons with semantic data states');
  assert(component.includes("parts.button.setAttribute('aria-label', station.label + ' — ' + statusLabel)")
    && component.includes("parts.marker.textContent = station.alert ? '⚠' : station.completed ? '✓' : station.current ? '●' : '○'"),
  'station buttons must expose Arabic state labels and the approved visual markers');
  assert(component.includes("const moreButton = makeElement('button', 'more-toggle', 'المزيد ⌄')")
    && component.includes("const MORE_VIEWS = [\n  ['history', 'التاريخ'], ['decisions', 'القرارات'], ['discussion', 'النقاش']")
    && !component.includes("['brainstorm', 'العصف']"),
  'More must expose history first, then decisions/discussion, without the setup-owned brainstorm tool');
  assert(component.includes('@media (max-width: 44rem)')
    && component.includes('.station-strip { grid-template-columns: minmax(0, 1fr); }')
    && !component.includes('.stage-indicator'),
  'the five guided stations must stack vertically below 44rem');
  assert(component.includes('const action = derived.nextAction && derived.nextAction.action'),
    'primary action must come directly from derived nextAction');
  assert(component.includes("const actionBar = makeElement('div', 'action-bar')")
    && component.includes('actionBar.appendChild(nextStep); actionBar.appendChild(primaryReason); actionBar.appendChild(previewButton);')
    && component.includes('actionBar.appendChild(previewStopButton); actionBar.appendChild(primaryButton);')
    && component.includes('[head, guidedPath, statusRow, timeoutRow, stationTitle, list, actionBar, resizeHandle]')
    && !component.includes('room-actions'),
  'primary nextAction must live in the bottom action bar after scrollable content');
  assert(component.includes("const primaryReason = makeElement('span', 'primary-reason')")
    && component.includes('this._nextStep.textContent = primaryReason')
    && component.includes("this._primaryReason.textContent = ''; this._primaryReason.hidden = true")
    && component.includes("this._actionBar.toggleAttribute('data-attention', Boolean(primaryReason))"),
  'disabled primary action must expose exactly one reason in the shared guidance slot');
  assert(component.includes("source: this._primaryAction === options.kind ? this._primaryButton : this"),
    'confirmation focus source must follow the single primary action');
  assert(component.includes("const LOOP_STATES = {") && component.includes("failed_after_n: 'فشلت بعد نفاد الدورات'")
    && component.includes("budget_exhausted: 'نفدت الميزانية'"),
  'loop card must localize all terminal loop outcomes');
  assert(component.includes("const LOOP_REVIEW_STATES = {")
    && component.includes("running: 'جارية', approve: 'اعتمدت'")
    && component.includes("changes_required: 'تطلب تعديلات', reject: 'رفضت', failed: 'فشلت'"),
  'loop card must localize every configured qualitative review state');
  assert(component.includes('if (loopReview && loopReview.configured === true)')
    && component.includes("summary.textContent = truncatePoints(loopReview.summary, 300, '…')")
    && component.includes('-webkit-line-clamp: 3;'),
  'loop review row must stay optional and visually clamp its inert Unicode summary');
  assert(component.includes("title.textContent = 'حلقة محدودة — الدورة '")
    && component.includes("iteration.textContent = integerLabel(loop.iteration) + '/' + integerLabel(loop.max_iterations)"),
  'loop card must expose the current and maximum iteration with LTR digits');
  assert(component.includes("failure.textContent = 'آخر فشل: ' + loop.last_failure_summary")
    && !component.includes('loop.last_failure_summary.trim('),
  'loop card must display the already-sanitized failure summary without reprocessing it');
  assert(component.includes("stop.textContent = '⏹ أوقف الحلقة'")
    && component.includes("stop.addEventListener('click', () => this._stopLoop(loop))")
    && component.includes('await window.satr.loopStop(loop.loop_id)'),
  'active loop card must expose a confirmed narrow stop action');
  assert(component.includes('راجع الأثر ثم امشِ بوابة الدمج كالمعتاد.')
    && component.includes("LOOP_STOP_REASONS[loop.stop_reason]"),
  'terminal loop card must show its localized reason and passed guidance');
  assert(component.includes("const costEstimate = loop.cost && loop.cost.estimate ? ' · تقديري' : ''")
    && component.includes("const budgetEstimate = loop.budget && loop.budget.estimate ? ' · تقديري' : ''"),
  'loop cost and token budget must retain their estimate labels');
  assert(component.includes("loopLabel.textContent = '🔁 حلقة محدودة'")
    && component.includes("maxIterations.value = '3'") && component.includes("budgetTokens.value = '400000'"),
  'execution setup must offer the approved bounded-loop defaults');
  assert(component.includes('loopMode.disabled = !singleWorker')
    && component.includes("loopMode.title = singleWorker ? '' : 'الحلقة المحدودة تعمل بعامل واحد فقط.'"),
  'bounded-loop setup must disable itself for multi-worker execution');
  assert(component.includes("typeof window.satr.loopPreflight !== 'function'")
    && component.includes("typeof window.satr.loopStart !== 'function'")
    && component.includes("typeof window.satr.loopStop !== 'function'")
    && component.includes("typeof window.satr.loopLatest === 'function'"),
  'all loop bridge calls must fail calmly when the core bridge is absent');
  assert(component.includes('items: (preflight.checks || []).map((check) => check.command)')
    && component.includes("kind: 'loop-start'") && component.includes('max_iterations: maxIterations')
    && component.includes('budget_tokens: budgetTokens') && component.includes('timeout_seconds: timeoutSeconds'),
  'loop preflight commands and approved bounds must cross the existing confirmation surface');
  assert(component.includes("review_skill_unavailable: 'مهارة المراجعة المضبوطة غير متاحة")
    && component.includes("makeElement('button', 'verify-config-recovery', 'افتح إعداد التحقق')")
    && component.includes('this._verifyConfigRecovery.hidden = this._state.status !== ERROR_LABELS.review_skill_unavailable')
    && component.includes("new CustomEvent('verify-config-open'"),
  'missing loop review skill must expose Arabic recovery through the existing verification wizard event');
  assert(component.includes(':host([compact]) {') && component.includes('width: var(--space-7); min-width: var(--space-7)'),
    'compact ops room must reclaim width through spacing tokens');
  assert(component.includes("makeElement('div', 'status-row')") && component.includes("makeElement('div', 'timeout-row')"),
    'stop and timeout extension must remain visible in their live context');
  assert(component.includes('const statusMessage = roomStatusMessage(this._state, derived)')
    && component.includes('this._statusRow.hidden = !statusMessage')
    && !component.includes('حدّد المهام والملكية، ثم ابدأ انتقال التنفيذ صراحةً.'),
  'an empty room must hide the redundant status row while real state messages keep using it');
  assert(component.includes("observable.className = 'observable-activity'")
    && component.includes('syncActivityElement(observable, agent, Date.now())')
    && component.includes('لم يصل نشاط أداة أو ملف قابل للرصد منذ'),
  'worker cards must expose truthful observable activity without inventing progress');
  const setupCard = component.slice(component.indexOf('  _setupCard(template) {'), component.indexOf('\n  _syncSetupActions() {'));
  const workerInputs = setupCard.indexOf('setup.appendChild(worker); inputs.push(worker);');
  const secondarySetup = setupCard.indexOf('setup.appendChild(note); setup.appendChild(planRow);');
  assert(workerInputs !== -1 && secondarySetup !== -1 && workerInputs < secondarySetup,
    'worker task and ownership inputs must precede secondary setup guidance and planning actions');
  assert(setupCard.includes("brainstormButton.className = 'setup-brainstorm'")
    && setupCard.includes("brainstormButton.textContent = '🧠 عصف'")
    && setupCard.includes("this._openSetupBrainstorm()"),
  'setup must expose brainstorm beside task splitting through the existing isolated brainstorm view');
  const renderTasks = component.slice(component.indexOf('  _renderTasks() {'),
    component.indexOf('\n  _renderDiscussion()', component.indexOf('  _renderTasks() {')));
  assert(component.includes('INHERIT_TEMPLATE_TEAM_STATES')
    && renderTasks.includes('INHERIT_TEMPLATE_TEAM_STATES.has(team.state)')
    && renderTasks.includes('this._setupCard(template)'),
  'setup inheritance must be restricted through the exported terminal-team contract');
  assert(component.includes('.task, .ownership { flex: 1 1 auto; }')
    && component.includes('.task { min-height: calc(var(--space-7) + var(--space-6)); }')
    && component.includes('min-height: calc(var(--space-7) + var(--space-3));'),
  'task and ownership fields must grow with token-based usable heights');
  assert(component.includes("resizeHandle.setAttribute('role', 'separator')")
    && component.includes("resizeHandle.setAttribute('aria-keyshortcuts', 'ArrowLeft ArrowRight Home End')"),
  'custom ops-room resize handle must expose separator keyboard semantics');
  assert(component.includes("if (event.key === 'ArrowLeft') next = current + step")
    && component.includes("else if (event.key === 'ArrowRight') next = current - step"),
  'RTL docked panel must expand leftward and shrink rightward from the keyboard');
  assert(component.includes("const DRAWER_MEDIA = '(max-width: 44rem)'" )
    && component.includes("this.setAttribute('aria-modal', 'true')"),
  'narrow ops-room mode must become an accessible drawer');
  assert(component.includes("const LAYOUT_STORAGE_PREFIX = 'satr_ops_layout:'")
    && component.includes('compact: this._preferredCompact === true')
    && component.includes('width: this._preferredWidth || 0')
    && !component.includes('views: { ...this._groupViews }'),
  'ops-room width and compact preferences must remain project-scoped after removing section preferences');
  assert(component.includes("this._layoutSheet.replaceSync(':host { --ops-room-width: '")
    && !component.includes('.style.'),
  'user resize width must use a validated constructable stylesheet, not inline style');
  assert(component.includes('position: relative; inset: auto; display: none; align-self: stretch;')
    && component.includes('box-shadow: var(--shadow-dock)') && base.includes('--shadow-dock:'),
  'ops room must be an in-row flex surface with a theme-aware token shadow');
  assert(!/\bconfirm\s*\(/.test(component), 'native confirm must not own ops decisions');
  const handleEventBody = component.slice(component.indexOf('  handleEvent(event) {'), component.indexOf('\n  }\n}', component.indexOf('  handleEvent(event) {')));
  assert(!handleEventBody.includes('._startReview(') && !handleEventBody.includes('._prepareVerification('),
    'runtime events must not create an agent-to-agent loop');
  const app = read('src/ui/app.js');
  const main = read('electron/main.js');
  const verifyPreload = read('electron/preload.js');
  const verifyDialog = read('src/ui/components/verify-config-dialog.js');
  assert(app.includes("if (ev.type === 'loop_update') { opsRoomEl.handleEvent(ev); return; }"),
    'loop_update must route into the ops-room reducer');
  assert(app.includes("surfaceCoordinator.register('verify-config-dialog'")
    && app.includes("opsRoomEl.addEventListener('verify-config-open'")
    && verifyDialog.includes('window.satr.verifyConfigCreate')
    && !verifyDialog.includes('innerHTML'),
  'verification config wizard must use the surface coordinator, scoped preload method, and safe DOM');
  assert(main.includes("ipcMain.handle('satr:verifyConfigCreate'")
    && main.includes('!verify.SAFE_CHECK_ID.test(id)')
    && main.includes('cwdStat.isSymbolicLink()')
    && verifyPreload.includes("verifyConfigCreate: (cwd, commands, overwrite, confirmed, reviewSkill)"),
  'verification config IPC must stay narrowly exposed and independently sanitized in main');
  assert(app.includes("state: 'hidden'") && app.includes("record.state = 'held'") && app.includes("record.state = 'active'"),
    'surface coordinator states missing');
  assert(app.includes("surfaceCoordinator.confirm(detail)"), 'ops dialog must pass through coordinator');
  assert(app.includes("const MULTI_SURFACE_MEDIA = '(min-width: 120rem)'")
    && app.includes("enforceSingleSideSurface('ops-room')")
    && app.includes("enforceSingleSideSurface('preview')")
    && app.includes("surfaceCoordinator.closePanel('ops-room', false)"),
  'responsive side-surface policy must share the explicit wide threshold');
  assert(app.includes("midRow.addEventListener('transitionend'")
    && app.includes('remeasurePreviewAfterLayout()') && app.includes('preview.remeasure()'),
  'preview position must be remeasured explicitly after layout transitions');
  assert(app.includes('chatColumnEl.inert = active') && app.includes('previewEl.holdForDrawer(active)')
    && app.includes('requestAnimationFrame(() => {') && app.includes('record.source.focus()'),
  'drawer must inert the whole chat column and restore focus after release');
  const preview = read('src/ui/components/preview-panel.js');
  assert(preview.includes('this.remeasure = reportBounds') && preview.includes("this.holdForDrawer = (hold)"),
    'preview must expose explicit remeasure and drawer hold contracts');
  assert(preview.includes(':host([drawer-held]) { display: none; }')
    && preview.includes("window.satr.previewBounds(0, 0, 0, 0)"),
  'drawer hold must hide both preview frame and native bounds');
  const mainProcess = read('electron/main.js');
  const recordingBridge = read('electron/previewrecording.js');
  assert(mainProcess.includes('previewrecording.attach(ownerWebContents.session')
    && recordingBridge.includes("session.on('will-download'")
    && recordingBridge.includes("'preview_recording_saved'")
    && recordingBridge.includes("'promo_final_saved'")
    && app.includes("ev.type === 'preview_recording_saved'"),
  'preview recording must use a sanitized Downloads path and report the completed path to the UI');
  assert(!mainProcess.includes('executionTeam.SAFE_RUN_ID.test('),
    'IPC handlers must validate team ids through the module export, not the runtime instance');
  assert(mainProcess.includes('executionTeamModule.SAFE_RUN_ID.test('),
    'IPC handlers must retain the execution-team id guard');
  assert(mainProcess.includes('OPS_TIMEOUT_SECONDS.has(timeoutSeconds)'), 'timeout presets must be validated in main');
  assert(mainProcess.includes("ipcMain.handle('satr:executionTeamExtend'"), 'one-shot timeout extension IPC missing');
  assert(mainProcess.includes("'team-terminal:' + team.id + ':' + team.state"), 'terminal team outcomes must enter the durable ledger');
  assert(mainProcess.includes("ipcMain.handle('satr:opsRoomRestore'"), 'artifact restore IPC missing');
  assert(mainProcess.includes("ipcMain.handle('satr:opsRoomArtifactDelete'"), 'artifact deletion IPC missing');
  assert(mainProcess.includes("ipcMain.handle('satr:opsBrainstormStart'"), 'brainstorm IPC missing');
  assert(mainProcess.includes('opsBrainstorm.latest(cwd)'), 'brainstorm history must be scoped to the active project');
  assert(mainProcess.includes("ipcMain.handle('satr:opsPlanStart'"), 'planner IPC missing');
  const preload = read('electron/preload.js');
  assert(preload.includes('timeoutSeconds'), 'timeout preset must cross the narrow preload bridge explicitly');
  assert(preload.includes('executionTeamExtend'), 'timeout extension must cross a narrow preload method');
  for (const method of ['opsRoomHistory', 'opsRoomRestore', 'opsRoomArtifactDelete', 'opsBrainstormStart', 'opsPlanStart']) {
    assert(preload.includes(method), 'missing narrow preload method ' + method);
  }
  const chat = read('src/ui/components/chat.js');
  assert(chat.includes('🏗 نفّذ في غرفة العمليات') && chat.includes("new CustomEvent('ops-room-open'"));
  assert(!app.includes("cmd: '/غرفة-العمليات'") && !app.includes("en: '/ops-room'"));
  const seedTask = component.slice(component.indexOf('  seedTask(task) {'), component.indexOf('\n  close()', component.indexOf('  seedTask(task) {')));
  const openHistory = component.slice(component.indexOf('  async _openHistory(item) {'),
    component.indexOf('\n  async _restoreHistory(', component.indexOf('  async _openHistory(item) {')));
  const restoreHistory = component.slice(component.indexOf('  async _restoreHistory(item) {'),
    component.indexOf('\n  async _deleteHistoryArtifact(', component.indexOf('  async _restoreHistory(item) {')));
  assert(app.includes('opsRoomEl.seedTask(taskSeed)') && seedTask.includes("this._selectView('tasks')")
    && restoreHistory.includes("this._selectView('tasks')") && openHistory.includes("this._selectView('decisions')"),
  'seed, artifact restore, and history-open routes must still land on station/More-owned flat views');
  assert(component.includes('previous.length || 1') && component.includes('شاهدها تعمل ← دمج'));
  assert(component.includes('window.satr.executionPreviewStart') && component.includes('derived.showPreview'));
  const renderDiffs = component.slice(component.indexOf('  _renderDiffs() {'), component.indexOf('\n  async _loadFileDiff'));
  const loadFileDiff = component.slice(component.indexOf('  async _loadFileDiff'), component.indexOf('\n  _renderReview()'));
  assert(!renderDiffs.includes('window.satr.executionFileDiff')
    && loadFileDiff.includes('window.satr.executionFileDiff(teamId, artifactId, file.rel)'));
  assert(component.includes("['المخاطر', sections.risks]")
    && component.includes("['الملاحظات', sections.notes]")
    && component.includes("['التوصية', sections.recommendation]"));
  for (const [lens, label] of [
    ['correctness', 'الصحة'], ['security', 'الأمان'], ['simplicity', 'التبسيط'],
  ]) {
    assert(component.includes(lens + ": '" + label + "'"),
      'missing frozen Arabic review lens label ' + lens);
  }
  for (const severity of ['critical', 'high', 'medium', 'low']) {
    assert(component.includes('.merged-count[data-severity="' + severity + '"]')
      && component.includes('.merged-severity[data-severity="' + severity + '"]'),
    'merged report must expose a semantic count and item badge for ' + severity);
  }
  for (const className of [
    'merged-report', 'merged-item', 'merged-severity', 'merged-lens', 'merged-engine',
    'merged-truncated', 'merged-repair', 'review-lenses', 'review-lens', 'review-lens-title',
    'review-lens-state', 'review-lens-verdict',
  ]) {
    assert(component.includes("'" + className + "'") || component.includes('.' + className),
      'missing judges UI class ' + className);
  }
  const renderReview = component.slice(component.indexOf('  _renderReview() {'),
    component.indexOf('\n  _entryCard(', component.indexOf('  _renderReview() {')));
  assert(renderReview.includes('review.merged_report')
    && renderReview.indexOf('review.merged_report') < renderReview.indexOf('review.reviews'),
  'a non-empty merged report must render above the engine review cards');
  assert(renderReview.includes('Array.isArray(item.lenses)')
    && renderReview.includes('reviewSections(lens && lens.summary)')
    && renderReview.includes('this._appendReviewSections(body, sections)'),
  'engine cards must render the three optional lens summaries through reviewSections');
  assert(component.includes("row.dir = 'auto'") && component.includes('row.textContent = value'),
    'legacy review summaries must retain safe textContent rendering');
  const mergedRenderer = component.slice(component.indexOf('  _renderMergedReport('),
    component.indexOf('\n  _renderReview()', component.indexOf('  _renderMergedReport(')));
  assert(mergedRenderer.includes('report.items') && !mergedRenderer.includes('.sort('),
    'merged report items must render in the received order without renderer sorting');
  assert(mergedRenderer.includes('row.dataset.severity = text(item && item.severity)')
    && mergedRenderer.includes("content.dir = 'auto'")
    && mergedRenderer.includes('content.textContent = text(item && item.text)'),
  'merged report items must expose severity while rendering untrusted text safely');
  assert(mergedRenderer.includes('report.truncated') && mergedRenderer.includes("'مقصوص'"),
    'merged report must expose the frozen truncation marker');
  assert(mergedRenderer.includes("addEventListener('click'")
    && mergedRenderer.includes('_repairTaskFromReport(report)'),
  'merged report repair must remain an explicit click');
  assert(mergedRenderer.includes('items.some((item) => item')
    && mergedRenderer.includes("item.severity === 'critical' || item.severity === 'high'")
    && mergedRenderer.indexOf('if (repairable)') < mergedRenderer.indexOf("repair.className = 'merged-repair'"),
  'merged report repair must only be created for critical/high findings');
  const repairTask = component.slice(component.indexOf('  _repairTaskFromReport('),
    component.indexOf('\n  _renderMergedReport(', component.indexOf('  _repairTaskFromReport(')));
  assert(repairTask.includes("item.severity === 'critical' || item.severity === 'high'")
    && repairTask.includes('truncatePoints(') && repairTask.includes('2000')
    && repairTask.includes('this.seedTask('),
  'repair must seed only critical/high notes through the 2000-code-point bound');
  assert(!repairTask.includes('executionTeamStart') && !repairTask.includes('_startExecution('),
    'repair must fill the setup form without starting execution');
  const primaryRenderer = component.slice(component.indexOf('  _renderPrimaryAction(derived) {'),
    component.indexOf('\n  _stationLifecycleState(', component.indexOf('  _renderPrimaryAction(derived) {')));
  assert(primaryRenderer.includes("key === 'merged' && available ? 'ابدأ مهمة جديدة'")
    && primaryRenderer.includes("'ابدأ فريقاً جديداً'"),
  'merged work must offer a new task while retry states retain the new-team label');
  assert(component.includes("bad_patch: 'ملف الأثر تالف أو غير صالح البنية")
    && component.includes("read_failed: 'تعذّرت قراءة بيانات المستودع أو الأثر")
    && component.includes("fallback + ' (الرمز التقني: ' + error + ')'")
    && component.includes('لم يصل رد من العملية الرئيسية (خطأ داخلي أو انقطاع)'),
  'Ops Room errors must distinguish IPC loss, known failures, and untranslated technical codes');
  const truncateSource = /function truncatePoints\(value, maximum, suffix\) \{[\s\S]*?\n\}/.exec(component);
  assert(truncateSource, 'Unicode code-point truncation helper missing');
  const truncatePoints = new Function('text',
    truncateSource[0] + '; return truncatePoints;')((value) => typeof value === 'string' ? value : '');
  const unicodeTrimmed = truncatePoints('أ'.repeat(1999) + '😀😀', 2000, '…');
  assert.strictEqual(Array.from(unicodeTrimmed).length, 2000,
    'repair truncation must count Unicode code points, not UTF-16 units');
  assert(unicodeTrimmed.endsWith('…'), 'repair truncation must expose a clear tail marker');
  assert(component.includes("const MODEL_STORAGE_PREFIX = 'satr_ops_models::'")
    && component.includes('localStorage.getItem(key)')
    && component.includes('localStorage.setItem(key, JSON.stringify(this._models))'),
  'per-project model choices must round-trip through the frozen localStorage key');
  for (const [name, className] of [
    ['worker', 'worker-model'], ['sdk', 'sdk-review-model'], ['codex', 'codex-review-model'],
  ]) {
    assert(component.includes("['" + name + "',") && component.includes("'" + className + "'"),
      'missing optional model selector ' + name);
  }
  assert(component.includes('this._loadModelPreferences()'),
    'opening a project must restore its saved model choices');
  assert(component.includes('const WEAK_JUDGE_MODEL = /haiku|mini|lite|flash|nano/i')
    && component.includes('WEAK_JUDGE_MODEL.test(modelInputs.sdk.value)')
    && component.includes('WEAK_JUDGE_MODEL.test(modelInputs.codex.value)')
    && component.includes('عقدة القاضي أخطر مكان للتوفير — نموذج ضعيف هنا يُصلح ما ليس مكسوراً ويكلّف أكثر مما يوفّر'),
  'weak judge models must show the frozen non-blocking warning');
  assert(component.includes("ops_model_invalid: '")
    && component.includes('اسم النموذج المختار غير صالح'),
  'ops_model_invalid must have a clear Arabic UI message');
  const startExecution = component.slice(component.indexOf('  async _startExecution() {'),
    component.indexOf('\n  async _stopLoop(', component.indexOf('  async _startExecution() {')));
  assert(startExecution.includes("this._modelOverrides(['worker'])")
    && startExecution.includes('this._supportsModels(window.satr.loopStart, 6)')
    && startExecution.includes('this._supportsModels(window.satr.executionTeamStart, 6)'),
  'worker overrides must cross loop/team starts only when the extended bridge arity is available');
  assert((startExecution.match(/window\.satr\.loopStart\(/g) || []).length >= 2
    && (startExecution.match(/window\.satr\.executionTeamStart\(/g) || []).length >= 2,
  'loop/team model overrides must retain literal legacy call branches');
  const startReview = component.slice(component.indexOf('  async _startReview() {'),
    component.indexOf('\n  async _prepareVerification(', component.indexOf('  async _startReview() {')));
  assert(startReview.includes("this._modelOverrides(['sdk', 'codex'])")
    && startReview.includes('this._supportsModels(window.satr.executionReviewStart, 2)')
    && (startReview.match(/window\.satr\.executionReviewStart\(/g) || []).length >= 2,
  'review model overrides must retain the literal legacy call and use the optional extended bridge');
  assert(main.includes("ipcMain.handle('satr:executionFileDiff'")
    && main.includes("ipcMain.handle('satr:executionPreviewStart'")
    && main.includes("Object.prototype.hasOwnProperty.call(p, 'command')"));
  assert(verifyPreload.includes('executionFileDiff') && verifyPreload.includes('executionPreviewStart')
    && verifyPreload.includes('executionPreviewStop'));
}

// عقد lifecycle-labels المشترك (خطوة القائد قبل أ‑2): الخريطة تغطي المفاتيح الملزمة،
// وصيغ العدد العربية، والقص على حدود الكلمات بنقاط Unicode بلا كسر surrogate pairs.
async function testLifecycleLabels() {
  const source = read('src/ui/lib/lifecycle-labels.js');
  const url = 'data:text/javascript;base64,' + Buffer.from(source).toString('base64');
  const { LIFECYCLE_LABELS, lifecycleLabel, countLabel, truncateWords } = await import(url + '#' + Date.now());
  for (const key of ['running', 'completed', 'approve', 'reject', 'changes_required', 'stopped',
    'stopping', 'starting', 'queued', 'preparing', 'pending_confirmation', 'passed', 'failed',
    'timed_out', 'interrupted', 'cleanup_failed', 'conflict', 'capturing', 'paused', 'active']) {
    assert(typeof LIFECYCLE_LABELS[key] === 'string' && LIFECYCLE_LABELS[key]
      && !/[a-z]/i.test(LIFECYCLE_LABELS[key]),
    'lifecycle label for ' + key + ' must be a non-empty Arabic string');
  }
  assert.strictEqual(lifecycleLabel('completed'), LIFECYCLE_LABELS.completed);
  assert.strictEqual(lifecycleLabel('unknown_raw_state'), 'unknown_raw_state',
    'unknown states must pass through untouched — no invented label');
  const files = { one: 'ملف واحد', two: 'ملفان', plural: 'ملفات', many: 'ملفاً' };
  assert.strictEqual(countLabel(1, files), 'ملف واحد');
  assert.strictEqual(countLabel(2, files), 'ملفان');
  assert.strictEqual(countLabel(5, files), '5 ملفات');
  assert.strictEqual(countLabel(13, files), '13 ملفاً');
  assert.strictEqual(countLabel(0, { ...files, zero: 'لا ملفات' }), 'لا ملفات');
  assert.strictEqual(truncateWords('نص قصير', 50), 'نص قصير', 'short text stays intact');
  const truncated = truncateWords('أصلح فرز القائمة في صفحة المنتجات كاملة', 20);
  assert(truncated.endsWith('…') && [...truncated].length <= 21 && !/\s…$/.test(truncated),
    'long text must cut at a word boundary with a trailing ellipsis');
  const surrogate = truncateWords('🙂🙂🙂🙂🙂 كلمة أخيرة', 7);
  assert(!/[\uD800-\uDBFF]$/.test(surrogate.replace(/…$/, '')),
    'code-point truncation must never split a surrogate pair');
}

// المسار الموجّه (ب — خطوة القائد): deriveStations اشتقاق عرض نقي — خمس محطات بحالاتها
// وواحدة حالية، من derived flags القائمة حصراً؛ لا يغيّر أي بوابة أو nextAction.
async function testDeriveStations() {
  const {
    createOpsRoomState, opsRoomReducer, deriveStations, STATION_KEYS,
  } = await loadStateModule();
  const artifact = 'a'.repeat(64);
  const base = fixture(artifact);
  const stationsOf = (parts) => deriveStations(opsRoomReducer(createOpsRoomState(), { type: 'hydrate', ...parts }));
  const currentKey = (stations) => stations.find((station) => station.current).key;
  const byKey = (stations) => Object.fromEntries(stations.map((station) => [station.key, station]));

  const empty = deriveStations(createOpsRoomState());
  assert.deepStrictEqual(empty.map((station) => station.key), STATION_KEYS, 'station order is fixed');
  assert.strictEqual(currentKey(empty), 'setup', 'no team ⇒ setup is current');
  assert(empty.every((station) => !station.completed && !station.alert), 'empty room has no progress or alerts');

  const running = stationsOf({ team: { ...base.team, state: 'running' } });
  assert.strictEqual(currentKey(running), 'execute', 'running team ⇒ execute is current');
  assert.strictEqual(byKey(running).setup.completed, true, 'a team existing completes setup');

  const failed = stationsOf({ team: { ...base.team, state: 'failed' } });
  assert.strictEqual(currentKey(failed), 'execute', 'failed team keeps the execute card (retry lives there)');
  assert.strictEqual(byKey(failed).execute.alert, true, 'failure marks the execute station');
  const stopped = stationsOf({ team: { ...base.team, state: 'stopped' } });
  assert.strictEqual(byKey(stopped).execute.alert, false, 'user stop is intent, not an execute alert');

  const readyForReview = stationsOf({ team: base.team });
  assert.strictEqual(currentKey(readyForReview), 'review', 'completed artifact ⇒ review is current');
  assert.strictEqual(byKey(readyForReview).execute.completed, true);

  const stoppedReview = stationsOf({ team: base.team, review: { ...base.review, state: 'stopped', reviews: [] } });
  assert.strictEqual(currentKey(stoppedReview), 'review', 'stopped review keeps review current (retry — item 28)');
  assert.strictEqual(byKey(stoppedReview).review.alert, true, 'incomplete review verdicts warrant attention');

  const rejected = judgesFixture(artifact);
  const rejectedStations = stationsOf({ team: rejected.team, review: rejected.review });
  assert.strictEqual(currentKey(rejectedStations), 'review', 'non-approved verdicts keep the review card current');
  assert.strictEqual(byKey(rejectedStations).review.alert, true);

  const approved = stationsOf({ team: base.team, review: base.review });
  assert.strictEqual(currentKey(approved), 'verify', 'approved review ⇒ verify is current');
  assert.strictEqual(byKey(approved).review.completed, true);

  const verified = stationsOf({ team: base.team, review: base.review, verification: base.verification });
  assert.strictEqual(currentKey(verified), 'merge', 'passed verification ⇒ merge is current');
  const failedVerification = stationsOf({
    team: base.team, review: base.review, verification: { ...base.verification, state: 'failed' },
  });
  assert.strictEqual(byKey(failedVerification).verify.alert, true, 'failed verification marks the verify station');

  const mergedStations = stationsOf({
    team: { ...base.team, merged: true }, review: base.review, verification: base.verification,
  });
  assert(mergedStations.every((station) => station.completed), 'merged flow completes every station');
  assert.strictEqual(currentKey(mergedStations), 'merge', 'merged summary card stays on the merge station');
}

// الوضع الآلي (ج — خطوة القائد): deriveAutoStep سائق نقي — قائمة أفعال مغلقة
// (مراجعة/تثبيت/تشغيل)، لا start ولا merge أبداً، وتوقف fail-closed عند أي عارض.
async function testDeriveAutoStep() {
  const {
    createOpsRoomState, opsRoomReducer, deriveAutoStep, AUTO_STEP_ACTIONS,
  } = await loadStateModule();
  const artifact = 'a'.repeat(64);
  const base = fixture(artifact);
  const stepOf = (parts, context) => deriveAutoStep(
    opsRoomReducer(createOpsRoomState(), { type: 'hydrate', ...parts }), context);
  const loopOf = (state) => ({
    loop_id: 'loop-ui-test', team_id: base.team.id, room_id: base.team.room_id, state,
  });

  assert.deepStrictEqual([...AUTO_STEP_ACTIONS], ['review', 'prepare', 'verify'],
    'auto allowlist is closed: review/prepare/verify only — never start or merge');
  assert(Object.isFrozen(AUTO_STEP_ACTIONS), 'auto allowlist must be frozen');

  assert.deepStrictEqual(deriveAutoStep(createOpsRoomState()), { step: '', stop: '' },
    'empty room: nextAction is start — the driver never auto-starts');

  assert.deepStrictEqual(stepOf({ team: base.team }), { step: 'review', stop: '' },
    'completed artifact without review ⇒ auto review');
  assert.deepStrictEqual(stepOf({ team: base.team, review: base.review }), { step: 'prepare', stop: '' },
    'approved review without verification ⇒ auto prepare');
  assert.deepStrictEqual(stepOf({
    team: base.team, review: base.review,
    verification: { ...base.verification, state: 'pending_confirmation' },
  }), { step: 'verify', stop: '' }, 'pinned verification ⇒ auto run');
  assert.deepStrictEqual(stepOf({ team: base.team, review: base.review, verification: base.verification }),
    { step: '', stop: 'merge_gate' }, 'merge-ready chain stops at the human gate — no auto merge');
  assert.deepStrictEqual(stepOf({
    team: { ...base.team, merged: true }, review: base.review, verification: base.verification,
  }), { step: '', stop: 'merge_gate' }, 'merged team reports the gate as reached');

  const pendingState = opsRoomReducer(
    opsRoomReducer(createOpsRoomState(), { type: 'hydrate', team: base.team }),
    { type: 'pending', action: 'review' });
  assert.deepStrictEqual(deriveAutoStep(pendingState), { step: '', stop: '' },
    'a pending transition waits — one step per settled update');

  assert.deepStrictEqual(stepOf({ team: { ...base.team, state: 'running' }, loop: loopOf('working') }),
    { step: '', stop: '' }, 'an active loop drives itself — the driver waits');
  assert.deepStrictEqual(stepOf({ team: base.team, loop: loopOf('passed') }), { step: 'review', stop: '' },
    'a passed loop hands off ⇒ auto review continues');
  for (const state of ['failed_after_n', 'budget_exhausted', 'failed']) {
    assert.deepStrictEqual(stepOf({ team: base.team, loop: loopOf(state) }),
      { step: '', stop: 'loop_not_passed' },
      'terminal non-passed loop must stop automation (' + state + ')');
  }
  assert.deepStrictEqual(stepOf({ team: base.team, loop: loopOf('stopped') }),
    { step: '', stop: 'loop_not_passed' },
    'a stopped loop delivering a completed restored team must NOT auto-review (owner decision 3)');

  assert.deepStrictEqual(stepOf({ team: { ...base.team, state: 'failed' } }),
    { step: '', stop: 'execution_alert' }, 'failed execution stops automation');
  assert.deepStrictEqual(stepOf({ team: { ...base.team, state: 'stopped' } }),
    { step: '', stop: 'execution_stopped' }, 'user-stopped execution stops automation');

  const rejected = judgesFixture(artifact);
  assert.deepStrictEqual(stepOf({ team: rejected.team, review: rejected.review }),
    { step: '', stop: 'review_not_approved' }, 'non-approved verdicts stop automation');
  assert.deepStrictEqual(stepOf({ team: base.team, review: { ...base.review, state: 'stopped', reviews: [] } }),
    { step: '', stop: 'review_incomplete' }, 'a review the user stopped is never auto-restarted');

  assert.deepStrictEqual(stepOf({
    team: base.team, review: base.review, verification: { ...base.verification, state: 'failed' },
  }), { step: '', stop: 'verification_failed' }, 'failed verification stops automation');

  assert.deepStrictEqual(stepOf({ team: base.team }, { failedStep: 'review' }),
    { step: '', stop: 'step_error' }, 'a step that failed to invoke is never retried in a loop');
  assert.deepStrictEqual(stepOf({ team: base.team, review: base.review }, { failedStep: 'review' }),
    { step: 'prepare', stop: '' }, 'failedStep only blocks its own step, not the next stage');
}

// الوضع الآلي (ج — عقود السطح الثابتة): السائق يستهلك deriveAutoStep حصراً بلا منطق
// موازٍ، لا مسار آلي للدمج أو بدء التنفيذ، والعلم لا يُخزَّن على القرص.
function testAutoModeSurface() {
  const component = read('src/ui/components/ops-room.js');
  const chat = read('src/ui/components/chat.js');
  const shell = read('src/ui/app.js');

  // القطع من سطر التعريف أولاً كي لا يلتقط indexOf موضع الاستدعاء داخل _render.
  const driverDefinition = component.indexOf('\n  _driveAutoStep()');
  assert(driverDefinition !== -1, 'missing _driveAutoStep definition');
  const driver = methodBody(component.slice(driverDefinition), '_driveAutoStep()');
  assert(driver.includes('deriveAutoStep(this._state'),
    'driver must consume deriveAutoStep — no parallel gating logic');
  assert(!driver.includes('_merge') && !driver.includes('_startExecution'),
    'the auto driver must never reach merge or execution start');
  assert(driver.includes('this._startReview()') && driver.includes('this._prepareVerification()')
    && driver.includes('this._runVerification({ auto: true })'),
    'driver invokes exactly the three middle steps');

  const labelsStart = component.indexOf('const AUTO_STOP_LABELS');
  assert(labelsStart !== -1, 'AUTO_STOP_LABELS closed map missing');
  const labelsSource = component.slice(labelsStart, component.indexOf('});', labelsStart));
  for (const code of ['merge_gate', 'loop_not_passed', 'execution_alert', 'execution_stopped',
    'review_not_approved', 'review_incomplete', 'verification_failed', 'step_error']) {
    assert(labelsSource.includes(code + ':'), 'AUTO_STOP_LABELS must translate ' + code);
  }
  assert(driver.includes('AUTO_STOP_LABELS[auto.stop] || AUTO_STOP_LABELS.step_error'),
    'unknown stop codes must fall back fail-closed');

  const autoRun = methodBody(component, 'async startAutoRun(task)');
  assert(autoRun.includes("['**']"), 'auto mode runs a single worker owning the whole project');
  assert(autoRun.includes('max_iterations: 3') && autoRun.includes('budget_tokens: 400000')
    && autoRun.includes('timeout_seconds: 300'), 'fixed approved defaults (owner decision 4)');
  assert(autoRun.includes("kind: 'auto-start'") && autoRun.includes('لن يندمج شيء تلقائياً'),
    'the single approval dialog must state the human merge gate');
  assert(autoRun.indexOf('this.seedTask(task)') === autoRun.search(/\S/),
    'seeding must happen first so cancel leaves the task seeded (owner decision 2)');

  const verify = methodBody(component, 'async _runVerification(options)');
  assert(verify.includes('options && options.auto === true') && verify.includes('this._confirm'),
    'only the auto driver skips the verify confirm — the manual dialog must remain');

  const openBody = methodBody(component, 'async open(cwd)');
  assert(openBody.includes('this._autoMode = false') && openBody.includes('nextCwd !== this._cwd'),
    'switching projects resets automation, while reopening the same project preserves it');
  assert(!/localStorage[^\r\n]*[Aa]uto|[Aa]uto[^\r\n]*localStorage/.test(component),
    'auto flag must never persist to disk (restart drops to the guided path)');

  assert(chat.includes('auto: true'), 'chat button must request the auto path');
  assert(shell.includes('startAutoRun') && shell.includes('opsRoomEl.seedTask'),
    'shell must call startAutoRun with a seedTask fallback');
}

async function main() {
  await testReducer();
  await testLifecycleLabels();
  await testDeriveStations();
  await testDeriveAutoStep();
  testAutoModeSurface();
  testDesignGuard();
  console.log('opsroom-ui: reducer, gates, event order, stale artifacts, CSP and design guard passed');
}

main().catch((error) => {
  console.error(error && error.stack || error);
  process.exitCode = 1;
});
