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
    && verifyPreload.includes("verifyConfigCreate: (cwd, commands, overwrite, confirmed)"),
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
