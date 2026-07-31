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
      this.dir = '';
    }

    appendChild(child) {
      this.children.push(child);
      return child;
    }

    addEventListener(type, listener) {
      this.listeners[type] = listener;
    }
  }
  const document = { createElement: (tagName) => new FakeElement(tagName) };
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

  const reviewSections = new Function('text',
    'return function (summary, recommendation) {'
      + methodBody(component, 'function reviewSections(summary, recommendation)') + '};')(safeText);
  const reviewStateLabel = new Function('return function (state) {'
    + methodBody(component, 'function reviewStateLabel(state)') + '};')();
  const reviewDecisionLabel = new Function('return function (decision) {'
    + methodBody(component, 'function reviewDecisionLabel(decision)') + '};')();
  const appendReviewSections = new Function('document',
    'return function (container, sections) {'
      + methodBody(component, '  _appendReviewSections(container, sections)') + '};')(document);
  const renderReview = new Function(
    'document', 'deriveOpsRoomState', 'reviewSections', 'engineLabel', 'text',
    'LENS_LABELS', 'reviewStateLabel', 'reviewDecisionLabel',
    'return function () {' + methodBody(component, '  _renderReview()') + '};',
  )(document, () => ({ canMerge: false }), reviewSections, engineLabel, safeText,
    lensLabels, reviewStateLabel, reviewDecisionLabel);
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
    OBSERVABLE_ACTIVITY_QUIET_MS,
  } = stateModule;
  const artifact = 'a'.repeat(64);
  const staleArtifact = 'b'.repeat(64);
  const current = fixture(artifact);

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

  let loopState = opsRoomReducer(createOpsRoomState(), {
    type: 'hydrate', room: { room_id: current.team.room_id, entries: [] }, team: current.team,
    loop: loopFixture({ state: 'preparing', iteration: 1 }),
  });
  assert.strictEqual(loopState.loop.state, 'preparing', 'hydrate accepts the latest loop snapshot');
  loopState = opsRoomReducer(loopState, { type: 'event', event: loopFixture() });
  assert.strictEqual(loopState.loop.iteration, 2, 'matching loop_update is consumed');
  const runningLoop = deriveOpsRoomState(loopState);
  assert.strictEqual(runningLoop.loopActive, true, 'non-terminal loop is active');
  assert.strictEqual(runningLoop.loopTerminal, false, 'non-terminal loop is not terminal');
  assert.strictEqual(runningLoop.canStart, false, 'active loop owns the execution start gate');
  assert.strictEqual(runningLoop.canStop, false, 'active loop uses its own stop button, not the team stop button');
  assert.strictEqual(runningLoop.canReview, false, 'active loop blocks review');
  assert.strictEqual(runningLoop.canPrepareVerification, false, 'active loop blocks formal verification preparation');
  assert.strictEqual(runningLoop.nextAction.key, 'loop_running', 'active loop precedes team-running guidance');
  assert.strictEqual(runningLoop.nextAction.action, '', 'loop_running is descriptive only');
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
  assert(component.includes('adoptedStyleSheets'), 'ops room must use constructable stylesheets');
  assert(component.includes("makeElement('button', 'verify-config', 'إعداد التحقق')")
    && component.includes("new CustomEvent('verify-config-open'"),
  'ops room must expose the manual verification config wizard without a slash command');
  assert(!component.includes('innerHTML') && !component.includes('insertAdjacentHTML'),
    'ops room must construct UI with safe DOM methods only');
  for (const group of ["id: 'work', label: 'العمل'", "id: 'results', label: 'النتائج'", "id: 'log', label: 'السجل'"]) {
    assert(component.includes(group), 'missing calm ops-room group ' + group);
  }
  assert(component.includes("const STAGES = ['الإعداد', 'التنفيذ', 'التحقق', 'الاعتماد']"),
    'presentational ops-room stages missing');
  assert(component.includes('.stage-indicator li::before')
    && component.includes('.stage-indicator li:not(:last-child)::after')
    && component.includes('padding: var(--space-1) var(--space-3)'),
  'ops-room stages must remain a compact descriptive progress rail');
  assert(component.includes('const action = derived.nextAction && derived.nextAction.action'),
    'primary action must come directly from derived nextAction');
  assert(component.includes("const actionBar = makeElement('div', 'action-bar')")
    && component.includes('actionBar.appendChild(nextStep); actionBar.appendChild(primaryReason); actionBar.appendChild(previewButton);')
    && component.includes('actionBar.appendChild(previewStopButton); actionBar.appendChild(primaryButton);')
    && component.includes('[head, stageIndicator, nav, statusRow, timeoutRow, list, actionBar, resizeHandle]')
    && !component.includes('room-actions'),
  'primary nextAction must live in the bottom action bar after scrollable content');
  assert(component.includes("const primaryReason = makeElement('span', 'primary-reason')")
    && component.includes("this._primaryReason.textContent = reason")
    && component.includes("this._actionBar.toggleAttribute('data-attention', Boolean(reason))"),
  'disabled primary action must expose its reason beside the button');
  assert(component.includes("source: this._primaryAction === options.kind ? this._primaryButton : this"),
    'confirmation focus source must follow the single primary action');
  assert(component.includes("const LOOP_STATES = {") && component.includes("failed_after_n: 'فشلت بعد نفاد الدورات'")
    && component.includes("budget_exhausted: 'نفدت الميزانية'"),
  'loop card must localize all terminal loop outcomes');
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
  assert(component.includes(':host([compact]) {') && component.includes('width: var(--space-7); min-width: var(--space-7)'),
    'compact ops room must reclaim width through spacing tokens');
  assert(component.includes("makeElement('div', 'status-row')") && component.includes("makeElement('div', 'timeout-row')"),
    'stop and timeout extension must remain visible in their live context');
  assert(component.includes("observable.className = 'observable-activity'")
    && component.includes('syncActivityElement(observable, agent, Date.now())')
    && component.includes('لم يصل نشاط أداة أو ملف قابل للرصد منذ'),
  'worker cards must expose truthful observable activity without inventing progress');
  const setupCard = component.slice(component.indexOf('  _setupCard(template) {'), component.indexOf('\n  _syncSetupActions() {'));
  const workerInputs = setupCard.indexOf('setup.appendChild(worker); inputs.push(worker);');
  const secondarySetup = setupCard.indexOf('setup.appendChild(note); setup.appendChild(planRow);');
  assert(workerInputs !== -1 && secondarySetup !== -1 && workerInputs < secondarySetup,
    'worker task and ownership inputs must precede secondary setup guidance and planning actions');
  assert(component.includes('.task, .ownership { flex: 1 1 auto; }')
    && component.includes('.task { min-height: calc(var(--space-7) + var(--space-6)); }')
    && component.includes('min-height: calc(var(--space-7) + var(--space-3));'),
  'task and ownership fields must grow with token-based usable heights');
  assert(component.includes('color: var(--text-dim); background: transparent; border-color: transparent;')
    && component.includes('.subnav button[aria-selected="true"]'),
  'local subnavigation must stay visually secondary');
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
    && component.includes('views: { ...this._groupViews }'),
  'ops-room width and section preferences must be scoped per project');
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
  assert(app.includes('opsRoomEl.seedTask(taskSeed)') && component.includes('seedTask(task)'));
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
  const repairTask = component.slice(component.indexOf('  _repairTaskFromReport('),
    component.indexOf('\n  _renderMergedReport(', component.indexOf('  _repairTaskFromReport(')));
  assert(repairTask.includes("item.severity === 'critical' || item.severity === 'high'")
    && repairTask.includes('truncatePoints(') && repairTask.includes('2000')
    && repairTask.includes('this.seedTask('),
  'repair must seed only critical/high notes through the 2000-code-point bound');
  assert(!repairTask.includes('executionTeamStart') && !repairTask.includes('_startExecution('),
    'repair must fill the setup form without starting execution');
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

async function main() {
  await testReducer();
  testDesignGuard();
  console.log('opsroom-ui: reducer, gates, event order, stale artifacts, CSP and design guard passed');
}

main().catch((error) => {
  console.error(error && error.stack || error);
  process.exitCode = 1;
});
