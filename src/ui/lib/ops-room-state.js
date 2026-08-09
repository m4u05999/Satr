const TERMINAL_TEAM_STATES = new Set([
  'completed', 'failed', 'timed_out', 'stopped', 'conflict', 'cleanup_failed',
]);
const TERMINAL_REVIEW_STATES = new Set(['completed', 'failed', 'timed_out', 'stopped']);
const TERMINAL_AGENT_STATES = new Set(['completed', 'failed', 'timed_out', 'stopped', 'cleanup_failed']);
const TERMINAL_LOOP_STATES = new Set([
  'passed', 'failed_after_n', 'budget_exhausted', 'failed', 'stopped',
]);

export const INHERIT_TEMPLATE_TEAM_STATES = new Set([
  'failed', 'timed_out', 'stopped', 'conflict', 'cleanup_failed',
]);

export const OBSERVABLE_ACTIVITY_QUIET_MS = 60 * 1000;

export function deriveAgentActivity(agent, currentTime) {
  const value = agent && typeof agent === 'object' ? agent : {};
  const suppliedTime = Number(currentTime);
  const now = currentTime != null && Number.isFinite(suppliedTime) ? suppliedTime : Date.now();
  const lastActivityAt = Math.max(0, Number(value.last_activity_at) || 0);
  const observed = lastActivityAt > 0 && Boolean(value.last_tool || value.last_file);
  const elapsedMs = lastActivityAt > 0 ? Math.max(0, now - lastActivityAt) : 0;
  let kind = 'waiting';
  if (TERMINAL_AGENT_STATES.has(value.state)) kind = 'terminal';
  else if (observed) kind = elapsedMs >= OBSERVABLE_ACTIVITY_QUIET_MS ? 'quiet' : 'recent';
  return { kind, observed, lastActivityAt, elapsedMs };
}

export function createOpsRoomState() {
  return {
    room: null,
    entries: [],
    team: null,
    review: null,
    verification: null,
    preview: null,
    loop: null,
    pending: '',
    status: '',
  };
}

function orderedEntries(entries) {
  const byId = new Map();
  for (const entry of Array.isArray(entries) ? entries : []) {
    if (entry && typeof entry.id === 'string') byId.set(entry.id, { ...entry });
  }
  return [...byId.values()].sort((left, right) => {
    const time = (Number(left.created_at) || 0) - (Number(right.created_at) || 0);
    return time || left.id.localeCompare(right.id);
  });
}

function loopSnapshot(value) {
  if (!value || typeof value !== 'object') return null;
  const snapshot = { ...value };
  if (Object.prototype.hasOwnProperty.call(value, 'review')
      && value.review && typeof value.review === 'object' && !Array.isArray(value.review)) {
    snapshot.review = { ...value.review };
  }
  return snapshot;
}

function reduceRuntimeEvent(state, event) {
  if (!event || typeof event !== 'object') return state;
  if (event.type === 'ops_room_update' && event.entry) {
    if (state.room && event.room_id !== state.room.room_id) return state;
    return { ...state, entries: orderedEntries(state.entries.concat(event.entry)) };
  }
  if (event.type === 'execution_team_update' && event.team) {
    const teamChanged = !!(state.team && state.team.id !== event.team.id);
    const replaced = !!(state.team && (state.team.id !== event.team.id
      || state.team.artifact_id && state.team.artifact_id !== event.team.artifact_id));
    return {
      ...state,
      team: { ...event.team },
      ...(replaced ? { room: null, entries: [], review: null, verification: null, preview: null } : {}),
      ...(teamChanged ? { loop: null } : {}),
    };
  }
  if (event.type === 'loop_update') {
    if (state.room && event.room_id !== state.room.room_id) return state;
    if (state.team && event.team_id !== state.team.id) return state;
    return { ...state, loop: loopSnapshot(event) };
  }
  if (event.type === 'execution_review_update' && event.review) {
    if (state.team && event.review.team_id !== state.team.id) return state;
    return { ...state, review: { ...event.review } };
  }
  if (event.type === 'execution_verification_update' && event.verification) {
    return { ...state, verification: { ...event.verification } };
  }
  if (event.type === 'execution_preview_update') {
    if (event.preview && state.team && event.preview.artifact_id !== state.team.artifact_id) return state;
    return { ...state, preview: event.preview ? { ...event.preview } : null };
  }
  return state;
}

export function opsRoomReducer(state, action) {
  const current = state || createOpsRoomState();
  const input = action || {};
  if (input.type === 'reset') return createOpsRoomState();
  if (input.type === 'hydrate') {
    const room = input.room && typeof input.room === 'object' ? { ...input.room } : null;
    return {
      ...current,
      room,
      entries: orderedEntries(room && room.entries),
      team: input.team ? { ...input.team } : null,
      review: input.review ? { ...input.review } : null,
      verification: input.verification ? { ...input.verification } : null,
      preview: input.preview ? { ...input.preview } : null,
      loop: loopSnapshot(input.loop),
      pending: '',
      status: '',
    };
  }
  if (input.type === 'event') return reduceRuntimeEvent(current, input.event);
  if (input.type === 'pending') return { ...current, pending: String(input.action || '') };
  if (input.type === 'settled') {
    return {
      ...current,
      pending: '',
      status: typeof input.status === 'string' ? input.status : current.status,
      ...(input.team ? { team: { ...input.team } } : {}),
      ...(input.review ? { review: { ...input.review } } : {}),
      ...(input.verification ? { verification: { ...input.verification } } : {}),
      ...(Object.prototype.hasOwnProperty.call(input, 'preview')
        ? { preview: input.preview ? { ...input.preview } : null } : {}),
    };
  }
  if (input.type === 'status') return { ...current, status: String(input.status || '') };
  return current;
}

function approvedReviewForArtifact(review, team, artifactId) {
  if (!review || !team || !artifactId || review.team_id !== team.id
    || review.artifact_id !== artifactId || review.state !== 'completed') return false;
  const required = Array.isArray(review.required_review_engines) ? review.required_review_engines : [];
  const reviews = Array.isArray(review.reviews) ? review.reviews : [];
  if (!required.length || reviews.length !== required.length) return false;
  const byEngine = new Map(reviews.map((item) => [item && item.engine, item]));
  if (byEngine.size !== required.length) return false;
  return required.every((engine) => {
    const item = byEngine.get(engine);
    return item && item.artifact_id === artifactId && item.state === 'completed'
      && item.verdict && item.verdict.schema_version === 1
      && item.verdict.decision === 'approve';
  });
}

export function deriveOpsRoomState(state) {
  const current = state || createOpsRoomState();
  const team = current.team;
  const loop = current.loop;
  const loopTerminal = !!(loop && TERMINAL_LOOP_STATES.has(loop.state));
  const loopActive = !!(loop && !loopTerminal);
  const artifactId = team && typeof team.artifact_id === 'string' ? team.artifact_id : '';
  const teamTerminal = !!(team && TERMINAL_TEAM_STATES.has(team.state));
  const reviewActive = !!(current.review && !TERMINAL_REVIEW_STATES.has(current.review.state));
  const verificationCurrent = !!(current.verification && artifactId
    && current.verification.artifact_id === artifactId);
  const verificationActive = verificationCurrent && current.verification.state === 'running';
  const reviewApproved = approvedReviewForArtifact(current.review, team, artifactId);
  const verificationPassed = verificationCurrent && current.verification.state === 'passed';
  const previewCurrent = !!(current.preview && artifactId && current.preview.artifact_id === artifactId);
  const previewActive = previewCurrent && ['starting', 'running', 'stopping'].includes(current.preview.state);
  const previewNeedsCleanup = previewCurrent && current.preview.state === 'cleanup_failed';
  const busy = !!current.pending;
  const canStart = !loopActive && !busy && (!team || teamTerminal) && !reviewActive && !verificationActive;
  const canStop = !loopActive && !busy && (!!(team && !teamTerminal) || reviewActive || verificationActive);
  const reviewIncomplete = !!(current.review
    && ['stopped', 'failed', 'timed_out'].includes(current.review.state));
  const canReview = !loopActive && !busy && !!(team && team.state === 'completed'
    && team.merge_supported && artifactId && (!current.review || reviewIncomplete));
  const canPrepareVerification = !loopActive && !busy && !!(team && team.merge_supported && reviewApproved
    && !verificationCurrent);
  const canRunVerification = !busy && verificationCurrent
    && current.verification.state === 'pending_confirmation';
  const canMerge = !busy && !!(team && team.merge_supported && !team.merged
    && reviewApproved && verificationPassed);
  const showPreview = !!(team && team.merge_supported && !team.merged && verificationPassed);
  const canPreview = !busy && showPreview && !previewActive && !previewNeedsCleanup;
  const canStopPreview = !busy && (previewActive || previewNeedsCleanup);
  let nextAction = { key: 'wait', action: '', label: 'لا يوجد انتقال مطلوب حالياً.' };
  if (busy) nextAction = { key: 'pending', action: '', label: 'جارٍ تنفيذ الانتقال المطلوب…' };
  else if (canMerge) nextAction = { key: 'merge', action: 'merge', label: 'نجح التحقق ووافقت المراجعات؛ الخطوة التالية دمج الأثر بتأكيد صريح.' };
  else if (canRunVerification) nextAction = { key: 'verify', action: 'verify', label: 'ثُبّتت الاختبارات؛ الخطوة التالية تشغيلها بتأكيد صريح.' };
  else if (canPrepareVerification) nextAction = { key: 'prepare', action: 'prepare', label: 'وافقت المراجعات؛ الخطوة التالية تثبيت تحقق الأثر الحالي.' };
  else if (canReview) nextAction = { key: 'review', action: 'review', label: reviewIncomplete
    ? 'لم تكتمل أحكام المراجعة السابقة؛ الخطوة التالية إعادة المراجعة للأثر نفسه.'
    : 'اكتمل التنفيذ؛ الخطوة التالية بدء المراجعات المستقلة.' };
  else if (team && team.merged) nextAction = canStart
    ? { key: 'merged', action: 'start', label: 'طُبّق الأثر على شجرة العمل بلا commit — راجع النتيجة والتزم بها متى شئت، ثم ابدأ مهمة جديدة.' }
    : { key: 'merged', action: '', label: 'طُبّق الأثر على شجرة العمل بلا commit.' };
  else if (canStart && team && team.state === 'timed_out') nextAction = {
    key: 'retry_timeout', action: 'start',
    label: 'انتهت المهلة؛ ضيّق المهمة أو اختر مهلة أطول، ثم ابدأ فريقاً جديداً صراحةً.',
  };
  else if (canStart && team && team.state === 'conflict') nextAction = {
    key: 'retry_conflict', action: 'start',
    label: 'تعارضت ملكيات الملفات؛ افصل الملكيات، ثم ابدأ فريقاً جديداً صراحةً.',
  };
  else if (canStart && team && team.state === 'cleanup_failed') nextAction = {
    key: 'retry_cleanup', action: 'start',
    label: 'فشل تنظيف نسخة عمل معزولة؛ نظّفها يدوياً قبل بدء فريق جديد.',
  };
  else if (canStart && team && team.state === 'failed') nextAction = {
    key: 'retry_failed', action: 'start',
    label: 'فشل التنفيذ؛ راجع السبب وإرشاد التعافي، ثم ابدأ فريقاً جديداً صراحةً.',
  };
  else if (canStart && team && team.state === 'stopped') nextAction = {
    key: 'retry_stopped', action: 'start',
    label: 'توقف الفريق بطلب المستخدم؛ راجع النتيجة ثم ابدأ فريقاً جديداً عند الحاجة.',
  };
  else if (canStart) nextAction = team
    ? { key: 'start', action: 'start', label: 'انتهى الفريق الحالي؛ راجع النتيجة ثم أنشئ فريقاً جديداً عند الحاجة.' }
    : { key: 'start', action: 'start', label: 'حدّد مهام العوامل وملكياتها، ثم ابدأ التنفيذ صراحةً.' };
  else if (loopActive) nextAction = { key: 'loop_running', action: '', label: 'الحلقة المحدودة تعمل الآن؛ راقب الدورة الحالية أو أوقف الحلقة من بطاقتها.' };
  else if (verificationActive) nextAction = { key: 'verification_running', action: '', label: 'التحقق التكاملي يعمل الآن؛ انتظر النتيجة أو أوقف المرحلة.' };
  else if (reviewActive) nextAction = { key: 'review_running', action: '', label: 'المراجعات المستقلة تعمل الآن؛ انتظر الأحكام أو أوقف المرحلة.' };
  else if (team && !teamTerminal) nextAction = { key: 'team_running', action: '', label: 'العوامل تنفّذ داخل النسخ المعزولة؛ راقب النشاط أو أوقف المرحلة.' };
  return {
    artifactId,
    loopActive,
    loopTerminal,
    teamActive: !!(team && !teamTerminal),
    reviewActive,
    verificationActive,
    reviewApproved,
    verificationPassed,
    previewActive,
    previewNeedsCleanup,
    canStart,
    canStop,
    canReview,
    canPrepareVerification,
    canRunVerification,
    canMerge,
    showPreview,
    canPreview,
    canStopPreview,
    nextAction,
  };
}

export function isCurrentArtifact(value, state) {
  const artifactId = state && state.team && state.team.artifact_id;
  return !!(artifactId && value && value.artifact_id === artifactId);
}
