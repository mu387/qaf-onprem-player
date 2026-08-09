const fs = require('fs');
const path = require('path');

const CURRENT_JOURNAL_VERSION = 2;

const nowIso = () => new Date().toISOString();

const readJsonSafe = filePath => {
  try {
    if (!fs.existsSync(filePath)) return null;
    const raw = fs.readFileSync(filePath, 'utf8');
    if (!raw || !raw.trim()) return null;
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch (_) {
    return null;
  }
};

const writeJsonAtomic = (filePath, payload) => {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  const tmpPath = `${filePath}.tmp`;
  fs.writeFileSync(tmpPath, JSON.stringify(payload, null, 2), 'utf8');
  fs.renameSync(tmpPath, filePath);
};

const clearFileSafe = filePath => {
  try {
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }
    return true;
  } catch (_) {
    return false;
  }
};

const normalizeJournal = input => {
  if (!input || typeof input !== 'object') return null;

  const state = String(input.state || 'running').toLowerCase();
  const normalized = {
    version: Number.isFinite(Number(input.version)) ? Number(input.version) : 1,
    state,
    created_at: input.created_at || nowIso(),
    updated_at: input.updated_at || nowIso(),
    recovery_enabled: input.recovery_enabled === true,
    meta: {
      source: input?.meta?.source || 'unknown',
      queue_id: Number(input?.meta?.queue_id || 0) || null,
      queue_item_id: Number(input?.meta?.queue_item_id || 0) || null,
      claim_token: input?.meta?.claim_token || null,
      attempt_no: Number(input?.meta?.attempt_no || 0) || null,
      test_suite_id: Number(input?.meta?.test_suite_id || 0) || null,
      test_plan_item_id: Number(input?.meta?.test_plan_item_id || 0) || null,
      cancel_source: input?.meta?.cancel_source || null,
      cancel_reason: input?.meta?.cancel_reason || null,
    },
    payload: Object.prototype.hasOwnProperty.call(input, 'payload') ? input.payload : null,
    progress: {
      current_runner: Number(input?.progress?.current_runner || 0) || 0,
      current_step: Number(input?.progress?.current_step || 0) || 0,
      is_paused: input?.progress?.is_paused === true,
      reason: input?.progress?.reason || 'initialized',
      steps_snapshot: Array.isArray(input?.progress?.steps_snapshot)
        ? input.progress.steps_snapshot
        : null,
      web_session_snapshot: input?.progress?.web_session_snapshot || null,
    },
  };

  normalized.version = CURRENT_JOURNAL_VERSION;
  return normalized;
};

const buildCanceledJournal = ({ existing = null, source = 'unknown', reason = 'canceled' } = {}) => {
  const current = normalizeJournal(existing) || {};
  return {
    version: CURRENT_JOURNAL_VERSION,
    state: 'canceled',
    created_at: current.created_at || nowIso(),
    updated_at: nowIso(),
    recovery_enabled: false,
    meta: {
      ...(current.meta || {}),
      cancel_source: source,
      cancel_reason: reason,
    },
    payload: null,
    progress: {
      current_runner: Number(current?.progress?.current_runner || 0) || 0,
      current_step: Number(current?.progress?.current_step || 0) || 0,
      is_paused: true,
      reason,
      steps_snapshot: null,
      web_session_snapshot: null,
    },
  };
};

const buildInitialJournal = ({ payload, meta = {}, recoveryEnabled = false }) => ({
  version: CURRENT_JOURNAL_VERSION,
  state: 'running',
  created_at: nowIso(),
  updated_at: nowIso(),
  recovery_enabled: !!recoveryEnabled,
  meta: {
    source: meta.source || 'unknown',
    queue_id: meta.queue?.id ?? null,
    queue_item_id: meta.item?.id ?? null,
    claim_token: meta.claimToken || meta.claim_token || null,
    attempt_no: Number(meta.item?.attempts || 0) || null,
    test_suite_id: Number(meta.item?.test_suite_id || 0) || null,
    test_plan_item_id: Number(meta.item?.test_plan_item_id || 0) || null,
  },
  payload: payload || null,
  progress: {
    current_runner: 0,
    current_step: 0,
    is_paused: false,
    reason: 'initialized',
    steps_snapshot: null,
  },
});

module.exports = {
  CURRENT_JOURNAL_VERSION,
  nowIso,
  readJsonSafe,
  writeJsonAtomic,
  clearFileSafe,
  normalizeJournal,
  buildCanceledJournal,
  buildInitialJournal,
};

