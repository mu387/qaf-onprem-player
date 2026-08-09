const TERMINAL_STATES = new Set(['completed', 'failed', 'canceled']);

const ALLOWED_TRANSITIONS = {
  idle: new Set(['starting', 'recovery_prompt']),
  starting: new Set(['running', 'canceling', 'failed']),
  running: new Set(['paused', 'reexecute_prompt', 'canceling', 'completed', 'failed']),
  paused: new Set(['running', 'reexecute_prompt', 'canceling', 'completed', 'failed']),
  recovery_prompt: new Set(['starting', 'idle', 'canceling']),
  reexecute_prompt: new Set(['running', 'paused', 'canceling', 'failed']),
  canceling: new Set(['canceled']),
  completed: new Set(['idle']),
  failed: new Set(['idle']),
  canceled: new Set(['idle']),
};

const canTransition = (from, to) => {
  if (from === to) return true;
  const allowed = ALLOWED_TRANSITIONS[from];
  return !!allowed && allowed.has(to);
};

const createExecutionStateTracker = ({
  initialState = 'idle',
  onTransition = null,
} = {}) => {
  let currentState = initialState;
  let transitionSeq = 0;

  const emit = (from, to, meta = {}) => {
    if (typeof onTransition === 'function') {
      try {
        onTransition({
          seq: ++transitionSeq,
          from,
          to,
          trigger: meta.trigger || 'unknown',
          reason: meta.reason || null,
          runId: meta.runId || null,
          at: new Date().toISOString(),
        });
      } catch (_) {}
    }
  };

  return {
    getState: () => currentState,
    isTerminal: () => TERMINAL_STATES.has(currentState),
    canTransitionTo: nextState => canTransition(currentState, nextState),
    transition: (nextState, meta = {}) => {
      if (!canTransition(currentState, nextState)) {
        return false;
      }
      const prev = currentState;
      currentState = nextState;
      emit(prev, nextState, meta);
      return true;
    },
    forceTransition: (nextState, meta = {}) => {
      const prev = currentState;
      currentState = nextState;
      emit(prev, nextState, { ...meta, forced: true });
      return true;
    },
    requestCancel: (meta = {}) => {
      if (currentState === 'canceling' || currentState === 'canceled') {
        return true;
      }
      if (TERMINAL_STATES.has(currentState)) {
        return false;
      }
      if (!canTransition(currentState, 'canceling')) {
        return false;
      }
      const prev = currentState;
      currentState = 'canceling';
      emit(prev, 'canceling', { trigger: meta.trigger || 'cancel', reason: meta.reason || null, runId: meta.runId || null });
      return true;
    },
  };
};

module.exports = {
  createExecutionStateTracker,
};
