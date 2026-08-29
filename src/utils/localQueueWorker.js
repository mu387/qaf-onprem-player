const axios = require('axios');

const DEFAULT_POLL_MS = 4000;
const DEFAULT_HEARTBEAT_MS = 5000;
const MAX_CLAIM_BACKOFF_MS = 30000;

const toBool = value => value === true || value === 'true';

const toNumber = (value, fallback) => {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.floor(n);
};

const normalizeBase = raw => {
  const text = String(raw || '').trim();
  if (!text) return '';
  return text.endsWith('/') ? text.slice(0, -1) : text;
};

const normalizeQueueStatus = statusName => {
  const status = String(statusName || '').toLowerCase();
  if (status.includes('pass')) return 'passed';
  if (status.includes('glitch')) return 'glitch';
  if (status.includes('fail')) return 'failed';
  if (status.includes('cancel')) return 'canceled';
  return null;
};

class LocalQueueWorker {
  constructor({ onExecute, canClaim, onQueueKilled, shouldSkipFinalize }) {
    this.onExecute = onExecute;
    this.canClaim = canClaim || (() => true);
    this.onQueueKilled = typeof onQueueKilled === 'function' ? onQueueKilled : null;
    this.shouldSkipFinalize = typeof shouldSkipFinalize === 'function' ? shouldSkipFinalize : () => false;
    this.enabled = false;
    this.running = false;
    this.busy = false;
    this.pollMs = DEFAULT_POLL_MS;
    this.apiBaseUrl = '';
    this.token = '';
    this.useRunnerSession = true;
    this.runnerId = '';
    this.runnerVersion = '';
    this.runnerSessionToken = '';
    this.currentCorrelationId = '';
    this.currentQueue = null;
    this.currentItem = null;
    this.currentClaimToken = '';
    this.timer = null;
    this.heartbeatTimer = null;
    this.heartbeatMs = DEFAULT_HEARTBEAT_MS;
    this.pendingFinalize = null;
    this.lastError = null;
    this.claimBackoffMs = 0;
  }

  configure(next = {}) {
    const nextApiBaseUrl = Object.prototype.hasOwnProperty.call(next, 'apiBaseUrl')
      ? normalizeBase(next.apiBaseUrl)
      : this.apiBaseUrl;
    const nextToken = Object.prototype.hasOwnProperty.call(next, 'token')
      ? String(next.token || '').trim()
      : this.token;
    const nextRunnerId = Object.prototype.hasOwnProperty.call(next, 'runnerId')
      ? String(next.runnerId || '').trim()
      : this.runnerId;
    const queueTargetChanged =
      nextApiBaseUrl !== this.apiBaseUrl ||
      nextToken !== this.token ||
      nextRunnerId !== this.runnerId;

    if (Object.prototype.hasOwnProperty.call(next, 'enabled')) {
      this.enabled = toBool(next.enabled);
    }
    if (Object.prototype.hasOwnProperty.call(next, 'pollMs')) {
      this.pollMs = toNumber(next.pollMs, DEFAULT_POLL_MS);
    }
    if (Object.prototype.hasOwnProperty.call(next, 'apiBaseUrl')) {
      this.apiBaseUrl = nextApiBaseUrl;
    }
    if (Object.prototype.hasOwnProperty.call(next, 'token')) {
      this.token = nextToken;
    }
    if (Object.prototype.hasOwnProperty.call(next, 'useRunnerSession')) {
      this.useRunnerSession = toBool(next.useRunnerSession);
      if (!this.useRunnerSession) {
        this.runnerSessionToken = '';
      }
    }
    if (Object.prototype.hasOwnProperty.call(next, 'runnerId')) {
      this.runnerId = nextRunnerId;
    }
    if (Object.prototype.hasOwnProperty.call(next, 'runnerVersion')) {
      this.runnerVersion = String(next.runnerVersion || '').trim();
    }
    if (queueTargetChanged) {
      this.runnerSessionToken = '';
      this.currentCorrelationId = '';
      this.claimBackoffMs = 0;
      this.lastError = null;
    }
    return this.status();
  }

  status() {
    return {
      enabled: this.enabled,
      running: this.running,
      busy: this.busy,
      pollMs: this.pollMs,
      apiBaseUrl: this.apiBaseUrl,
      hasToken: !!this.token,
      runnerSessionEnabled: this.useRunnerSession,
      hasRunnerSession: !!this.runnerSessionToken,
      currentQueueId: this.currentQueue?.id || null,
      currentQueueItemId: this.currentItem?.id || null,
      currentClaimToken: this.currentClaimToken || null,
      correlationId: this.currentCorrelationId || null,
      pendingFinalize: !!this.pendingFinalize,
      lastError: this.lastError,
    };
  }

  formatError(err) {
    if (!err) return 'unknown';
    const status = err?.response?.status;
    const body = err?.response?.data;
    const bodyMessage =
      (body && (body.message || body.error)) ||
      (Array.isArray(body?.errors) ? body.errors.join(', ') : null) ||
      (body?.errors && typeof body.errors === 'object' ? JSON.stringify(body.errors) : null);
    const base = bodyMessage || err?.message || 'unknown';
    return status ? `${status}:${base}` : String(base);
  }

  isQueueKillError(err) {
    const status = Number(err?.response?.status || 0);
    const message = String(
      err?.response?.data?.message ||
      err?.response?.data?.error ||
      err?.message ||
      '',
    ).toLowerCase();
    if (status !== 409) return false;
    return message.includes('cancel') || message.includes('killed');
  }

  handleQueueKilled(err) {
    if (!this.isQueueKillError(err)) return false;
    this.pendingFinalize = null;
    this.stopHeartbeat();
    this.busy = false;
    this.currentQueue = null;
    this.currentItem = null;
    this.currentClaimToken = '';
    this.currentCorrelationId = '';
    this.lastError = `queue_killed:${this.formatError(err)}`;
    try {
      this.onQueueKilled?.({ message: this.lastError });
    } catch (_) {}
    return true;
  }

  isStaleClaimError(err) {
    const status = Number(err?.response?.status || 0);
    const message = String(
      err?.response?.data?.message ||
      err?.response?.data?.error ||
      err?.message ||
      '',
    ).toLowerCase();
    if (status !== 409) return false;
    return message.includes('stale claim') || message.includes('invalid or stale claim token');
  }

  handleStaleClaimFinalizeError(err) {
    if (!this.isStaleClaimError(err)) return false;
    this.pendingFinalize = null;
    this.lastError = `stale_claim:${this.formatError(err)}`;
    return true;
  }

  isThrottleError(err) {
    return Number(err?.response?.status || 0) === 429;
  }

  nextClaimBackoff(err) {
    const startMs = this.isThrottleError(err) ? 5000 : Math.max(this.pollMs, 5000);
    this.claimBackoffMs = this.claimBackoffMs > 0
      ? Math.min(this.claimBackoffMs * 2, MAX_CLAIM_BACKOFF_MS)
      : startMs;
    return this.claimBackoffMs;
  }

  start() {
    if (this.running) return this.status();
    this.running = true;
    this.lastError = null;
    this.scheduleNext(0);
    return this.status();
  }

  stop() {
    this.running = false;
    this.busy = false;
    this.currentQueue = null;
    this.currentItem = null;
    this.currentClaimToken = '';
    this.stopHeartbeat();
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    return this.status();
  }

  scheduleNext(ms = this.pollMs) {
    if (!this.running) return;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.timer = setTimeout(async () => {
      let nextMs = this.pollMs;
      try {
        const suggested = await this.tick();
        if (Number.isFinite(suggested) && suggested > 0) {
          nextMs = suggested;
        }
      } catch (err) {
        this.lastError = `tick_failed:${this.formatError(err)}`;
        nextMs = Math.max(this.pollMs, 5000);
      } finally {
        this.scheduleNext(nextMs);
      }
    }, Math.max(0, ms));
  }

  async request(method, path, data = undefined) {
    const base = normalizeBase(this.apiBaseUrl);
    if (!base) throw new Error('Queue worker apiBaseUrl is missing.');
    if (!this.token) throw new Error('Queue worker token is missing.');
    const url = `${base}${path}`;
    const response = await axios.request({
      url,
      method,
      data,
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${this.token}`,
        ...(this.useRunnerSession && this.runnerSessionToken
          ? { 'X-Runner-Session': this.runnerSessionToken }
          : {}),
        ...(this.currentCorrelationId
          ? { 'X-Correlation-Id': this.currentCorrelationId }
          : {}),
      },
      timeout: 15000,
    });
    return response?.data;
  }

  async ensureRunnerSession() {
    if (!this.useRunnerSession) return;
    if (this.runnerSessionToken) return;
    if (!this.runnerId) {
      throw new Error('runner_session_missing_runner_id');
    }
    const data = await this.request('post', '/execution-queue/runner/bootstrap', {
      runner_id: this.runnerId,
      runner_version: this.runnerVersion || null,
    });
    const token = String(data?.data?.runner_session_token || '').trim();
    if (!token) {
      throw new Error('runner_session_bootstrap_failed');
    }
    this.runnerSessionToken = token;
  }

  async claim() {
    const data = await this.request('post', '/execution-queue/claim-local', {});
    return data?.data || null;
  }

  async fetchExecutionPayload(item) {
    const executionId = item?.execution_id ?? item?.test_suite_id;
    const testPlanItemId = item?.test_plan_item_id;
    if (!executionId || !testPlanItemId) {
      throw new Error('Queue claim missing execution identity or test_plan_item_id.');
    }
    const data = await this.request('post', '/automation/get/testsuites/steps', {
      test_suites: [Number(executionId)],
      test_plan_item_id: Number(testPlanItemId),
      invoked_via_tests: true,
    });
    const payload = data?.data || data || {};
    if (!Array.isArray(payload?.test_runner_steps)) {
      throw new Error('Automation payload missing test_runner_steps.');
    }
    return payload;
  }

  async resolveSuiteStatus(item) {
    const testPlanItemId = item?.test_plan_item_id;
    const executionId = item?.execution_id ?? item?.test_suite_id;
    if (!testPlanItemId || !executionId) return null;
    const data = await this.request(
      'get',
      `/get/testsuites/against/testplanitems/${Number(testPlanItemId)}/light`,
    );
    const rows = data?.data || data || [];
    const list = Array.isArray(rows) && rows[0]?.added_suites ? rows[0].added_suites : [];
    const match = list.find(row => {
      const rowExecutionId = Number(row?.execution_id ?? 0);
      const designId = Number(row?.test_design_id ?? row?.id ?? 0);
      return rowExecutionId === Number(executionId) || designId === Number(executionId);
    });
    return normalizeQueueStatus(match?.status?.name || '');
  }

  async report(queue, item, status, claimToken) {
    const queueId = queue?.id;
    const executionId = item?.execution_id ?? item?.test_suite_id;
    if (!queueId || !executionId || !status || !claimToken) return;
    await this.request('post', `/execution-queue/${Number(queueId)}/items/finish`, {
      queue_run_id: item?.queue_run_id || null,
      claim_token: String(claimToken),
      attempt_no: Number(item?.attempts || 0) || null,
      test_suite_id: Number(item?.base_test_suite_id ?? item?.test_suite_id ?? executionId),
      execution_id: Number(executionId),
      status,
    });
  }

  async startHandshake(queue, item, claimToken) {
    const queueId = queue?.id;
    const executionId = item?.execution_id ?? item?.test_suite_id;
    if (!queueId || !executionId || !claimToken) return;
    await this.request('post', `/execution-queue/${Number(queueId)}/items/start`, {
      queue_run_id: item?.queue_run_id || null,
      claim_token: String(claimToken),
      attempt_no: Number(item?.attempts || 0) || null,
      test_suite_id: Number(item?.base_test_suite_id ?? item?.test_suite_id ?? executionId),
      execution_id: Number(executionId),
    });
  }

  async heartbeat(queue, item, claimToken) {
    const queueId = queue?.id;
    const executionId = item?.execution_id ?? item?.test_suite_id;
    if (!queueId || !executionId || !claimToken) return;
    await this.request('post', `/execution-queue/${Number(queueId)}/items/heartbeat`, {
      queue_run_id: item?.queue_run_id || null,
      claim_token: String(claimToken),
      attempt_no: Number(item?.attempts || 0) || null,
      test_suite_id: Number(item?.base_test_suite_id ?? item?.test_suite_id ?? executionId),
      execution_id: Number(executionId),
    });
  }

  async reportInterrupted(queue, item, claimToken, reason = 'waiting_recovery') {
    const queueId = queue?.id;
    const executionId = item?.execution_id ?? item?.test_suite_id;
    if (!queueId || !executionId || !claimToken) return;
    await this.request('post', `/execution-queue/${Number(queueId)}/items/interrupted`, {
      queue_run_id: item?.queue_run_id || null,
      claim_token: String(claimToken),
      attempt_no: Number(item?.attempts || 0) || null,
      test_suite_id: Number(item?.base_test_suite_id ?? item?.test_suite_id ?? executionId),
      execution_id: Number(executionId),
      reason: String(reason || 'waiting_recovery'),
    });
  }

  async reportInterruptedFromJournalMeta(meta = {}, reason = 'runner_restarted_recovery_disabled') {
    const queueId = Number(meta?.queue_id || 0);
    const executionId = Number(meta?.execution_id || 0) || Number(meta?.test_suite_id || 0);
    const baseTestSuiteId = Number(meta?.test_suite_id || 0);
    const claimToken = String(meta?.claim_token || '').trim();
    if (!queueId || !executionId || !baseTestSuiteId || !claimToken) {
      throw new Error('Journal is missing queue interrupt identifiers.');
    }

    await this.request('post', `/execution-queue/${Number(queueId)}/items/interrupted`, {
      queue_run_id: Number(meta?.queue_run_id || 0) || null,
      claim_token: claimToken,
      attempt_no: Number(meta?.attempt_no || 0) || null,
      test_suite_id: baseTestSuiteId,
      execution_id: executionId,
      reason: String(reason || 'runner_restarted_recovery_disabled'),
    });
  }

  clearActiveExecution(reason = '') {
    this.busy = false;
    this.currentQueue = null;
    this.currentItem = null;
    this.currentClaimToken = '';
    this.currentCorrelationId = '';
    this.pendingFinalize = null;
    this.stopHeartbeat();
    if (reason) {
      this.lastError = String(reason);
    }
    return this.status();
  }

  startHeartbeat(queue, item, claimToken) {
    this.stopHeartbeat();
    this.heartbeatTimer = setInterval(async () => {
      try {
        await this.heartbeat(queue, item, claimToken);
      } catch (err) {
        if (this.handleQueueKilled(err)) {
          return;
        }
        this.lastError = `heartbeat_failed:${this.formatError(err)}`;
        if (this.useRunnerSession && String(this.lastError).includes('401')) {
          this.runnerSessionToken = '';
        }
      }
    }, Math.max(1000, this.heartbeatMs));
  }

  stopHeartbeat() {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  async flushPendingFinalize() {
    if (!this.pendingFinalize) return true;
    if (this.shouldSkipFinalize(this.pendingFinalize)) {
      this.pendingFinalize = null;
      return true;
    }
    try {
      await this.report(
        this.pendingFinalize.queue,
        this.pendingFinalize.item,
        this.pendingFinalize.status,
        this.pendingFinalize.claimToken,
      );
      this.pendingFinalize = null;
      if (this.lastError && this.lastError.startsWith('report_failed:')) {
        this.lastError = null;
      }
      return true;
    } catch (reportErr) {
      if (this.handleQueueKilled(reportErr)) {
        return true;
      }
      if (this.handleStaleClaimFinalizeError(reportErr)) {
        return true;
      }
      this.lastError = `report_failed:${this.formatError(reportErr)}`;
      if (this.useRunnerSession && String(this.lastError).includes('401')) {
        this.runnerSessionToken = '';
      }
      return false;
    }
  }

  async tick() {
    if (!this.running || !this.enabled) return this.pollMs;
    if (this.pendingFinalize) {
      const flushed = await this.flushPendingFinalize();
      return flushed ? this.pollMs : this.nextClaimBackoff();
    }
    if (this.busy) return this.pollMs;
    if (!this.canClaim()) return this.pollMs;
    if (!this.apiBaseUrl || !this.token) return this.pollMs;
    if (this.useRunnerSession) {
      try {
        await this.ensureRunnerSession();
      } catch (err) {
        this.lastError = `bootstrap_failed:${this.formatError(err)}`;
        return this.nextClaimBackoff(err);
      }
    }

    let claim = null;
    try {
      claim = await this.claim();
    } catch (err) {
      if (this.handleQueueKilled(err)) {
        return this.pollMs;
      }
      this.lastError = `claim_failed:${this.formatError(err)}`;
      if (this.useRunnerSession && String(this.lastError).includes('401')) {
        this.runnerSessionToken = '';
      }
      return this.nextClaimBackoff(err);
    }

    const queue = claim?.queue || null;
    const item = claim?.item || null;
    const claimToken = claim?.claim_token || item?.claim_token || null;
    if (!queue || !item) {
      this.lastError = null;
      this.claimBackoffMs = 0;
      return this.pollMs;
    }
    this.claimBackoffMs = 0;

    this.busy = true;
    this.currentQueue = queue;
    this.currentItem = item;
    this.currentClaimToken = claimToken ? String(claimToken) : '';
    this.currentCorrelationId = `q-${Number(queue?.id || 0)}-i-${Number(item?.id || 0)}-a-${Number(item?.attempts || 0)}-${Date.now()}`;
    let status = 'failed';
    try {
      await this.startHandshake(queue, item, claimToken);
      this.startHeartbeat(queue, item, claimToken);
      const payload = await this.fetchExecutionPayload(item);
      await this.onExecute(payload, {
        token: this.token,
        apiBaseUrl: this.apiBaseUrl,
        queue,
        item,
        claimToken,
        reportInterrupted: async reason => this.reportInterrupted(queue, item, claimToken, reason),
      });
      const resolved = await this.resolveSuiteStatus(item);
      status = resolved || 'passed';
      this.lastError = null;
    } catch (err) {
      if (this.handleQueueKilled(err)) {
        return this.pollMs;
      }
      this.lastError = `execute_failed:${this.formatError(err)}`;
      status = 'failed';
    } finally {
      this.stopHeartbeat();
      this.pendingFinalize = { queue, item, status, claimToken };
      await this.flushPendingFinalize();
      this.busy = false;
      this.currentQueue = null;
      this.currentItem = null;
      this.currentClaimToken = '';
      this.currentCorrelationId = '';
    }
    return this.pollMs;
  }
}

module.exports = {
  LocalQueueWorker,
};
