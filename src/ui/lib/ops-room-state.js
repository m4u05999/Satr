const TERMINAL_TEAM_STATES = new Set([
  'completed', 'failed', 'timed_out', 'stopped', 'conflict', 'cleanup_failed',
]);
const TERMINAL_REVIEW_STATES = new Set(['completed', 'failed', 'timed_out', 'stopped']);

export function createOpsRoomState() {
  return {
    room: null,
    entries: [],
    team: null,
    review: null,
    verification: null,
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

function reduceRuntimeEvent(state, event) {
  if (!event || typeof event !== 'object') return state;
  if (event.type === 'ops_room_update' && event.entry) {
    if (state.room && event.room_id !== state.room.room_id) return state;
    return { ...state, entries: orderedEntries(state.entries.concat(event.entry)) };
  }
  if (event.type === 'execution_team_update' && event.team) {
    const replaced = !!(state.team && (state.team.id !== event.team.id
      || state.team.artifact_id && state.team.artifact_id !== event.team.artifact_id));
    return {
      ...state,
      team: { ...event.team },
      ...(replaced ? { room: null, entries: [], review: null, verification: null } : {}),
    };
  }
  if (event.type === 'execution_review_update' && event.review) {
    if (state.team && event.review.team_id !== state.team.id) return state;
    return { ...state, review: { ...event.review } };
  }
  if (event.type === 'execution_verification_update' && event.verification) {
    return { ...state, verification: { ...event.verification } };
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
  const artifactId = team && typeof team.artifact_id === 'string' ? team.artifact_id : '';
  const teamTerminal = !!(team && TERMINAL_TEAM_STATES.has(team.state));
  const reviewActive = !!(current.review && !TERMINAL_REVIEW_STATES.has(current.review.state));
  const verificationCurrent = !!(current.verification && artifactId
    && current.verification.artifact_id === artifactId);
  const verificationActive = verificationCurrent && current.verification.state === 'running';
  const reviewApproved = approvedReviewForArtifact(current.review, team, artifactId);
  const verificationPassed = verificationCurrent && current.verification.state === 'passed';
  const busy = !!current.pending;
  return {
    artifactId,
    teamActive: !!(team && !teamTerminal),
    reviewActive,
    verificationActive,
    reviewApproved,
    verificationPassed,
    canStart: !busy && (!team || teamTerminal) && !reviewActive && !verificationActive,
    canStop: !busy && (!!(team && !teamTerminal) || reviewActive || verificationActive),
    canReview: !busy && !!(team && team.state === 'completed' && team.merge_supported
      && artifactId && !current.review),
    canPrepareVerification: !busy && !!(team && team.merge_supported && reviewApproved
      && !verificationCurrent),
    canRunVerification: !busy && verificationCurrent
      && current.verification.state === 'pending_confirmation',
    canMerge: !busy && !!(team && team.merge_supported && !team.merged
      && reviewApproved && verificationPassed),
  };
}

export function isCurrentArtifact(value, state) {
  const artifactId = state && state.team && state.team.artifact_id;
  return !!(artifactId && value && value.artifact_id === artifactId);
}
