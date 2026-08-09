const { api } = require('./api');
const { getBulkStepLogV2Url } = require('./endpoint');
const { buildStepStatusEvent } = require('./stepLog');

class StepStatusReporter {
  constructor(options = {}) {
    this.queue = [];
    this.timer = null;
    this.inflight = 0;
    this.maxInflight = Number(options.maxInflight || 2);
    this.maxBatchSize = Number(options.maxBatchSize || 25);
    this.flushIntervalMs = Number(options.flushIntervalMs || 300);
    this.stopped = false;
  }

  enqueue(payload) {
    if (this.stopped) return;
    const event = buildStepStatusEvent(payload);
    if (!event) return;
    this.queue.push(event);
    this.ensureTimer();
    if (this.queue.length >= this.maxBatchSize) {
      this.drain();
    }
  }

  async flushImmediate(payload) {
    if (this.stopped) return;
    const event = buildStepStatusEvent(payload);
    if (!event) return;
    await this.sendGroup([event]);
  }

  ensureTimer() {
    if (this.timer || this.stopped) return;
    this.timer = setInterval(() => {
      this.drain();
    }, this.flushIntervalMs);
  }

  stopTimer() {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = null;
  }

  async drain() {
    if (this.stopped) return;
    while (this.inflight < this.maxInflight && this.queue.length > 0) {
      const chunk = this.queue.splice(0, this.maxBatchSize);
      this.inflight += 1;
      this.sendChunk(chunk)
        .catch(() => {})
        .finally(() => {
          this.inflight -= 1;
          if (this.queue.length === 0 && this.inflight === 0) {
            this.stopTimer();
          } else if (this.queue.length > 0) {
            this.drain();
          }
        });
    }
  }

  async sendChunk(chunk) {
    const groups = this.groupByContext(chunk);
    const tasks = groups.map(group => this.sendGroup(group));
    await Promise.allSettled(tasks);
  }

  groupByContext(events) {
    const map = new Map();
    for (const event of events) {
      const key = [
        event.token || '',
        event.runnerId || 0,
        event.testSuiteId || 0,
        event.testPlanItemId || 0,
      ].join('|');
      if (!map.has(key)) {
        map.set(key, []);
      }
      map.get(key).push(event);
    }
    return Array.from(map.values());
  }

  buildBatchId() {
    return `batch-${Date.now()}-${Math.random().toString(16).slice(2, 10)}`;
  }

  async sendGroup(events) {
    if (!events.length) return;
    const first = events[0];
    const config = {
      url: getBulkStepLogV2Url(),
      method: 'post',
      data: {
        test_runner_id: first.runnerId,
        test_suite_id: first.testSuiteId,
        ...(first.testPlanItemId ? { test_plan_item_id: first.testPlanItemId } : {}),
        batch_id: this.buildBatchId(),
        steps: events.map(event => event.step),
      },
      token: first.token,
    };

    try {
      const response = await api.request(config);
      const summary = response?.data?.summary || response?.summary || null;
      if (summary) {
        console.log(
          `[step-status-v2] batch ok accepted=${summary.accepted ?? 'n/a'} matched=${summary.matched ?? 'n/a'} updated=${summary.updated ?? 'n/a'} suite_status=${summary.suite_status ?? 'n/a'}`,
        );
      } else {
        console.log(`[step-status-v2] batch ok count=${events.length}`);
      }
    } catch (error) {
      const status = error?.response?.status ?? 'unknown';
      console.log('step status v2 batch send failed -- code -- ' + status);
      await this.sendLegacyFallback(events);
    }
  }

  async sendLegacyFallback(events) {
    const tasks = events.map(event => this.sendOneLegacy(event?.legacyConfig));
    await Promise.allSettled(tasks);
  }

  async sendOneLegacy(config) {
    if (!config) return;
    try {
      await api.request(config);
    } catch (error) {
      const status = error?.response?.status ?? 'unknown';
      console.log('step status legacy send failed -- code -- ' + status);
    }
  }

  async flushAll({ timeoutMs = 6000, force = false } = {}) {
    if (this.stopped && !force) return;
    this.ensureTimer();
    this.drain();
    const started = Date.now();
    while ((this.queue.length > 0 || this.inflight > 0) && Date.now() - started < timeoutMs) {
      await new Promise(resolve => setTimeout(resolve, 50));
      this.drain();
    }
  }

  async shutdown() {
    await this.flushAll({ timeoutMs: 6000, force: true });
    this.stopped = true;
    this.stopTimer();
  }
}

module.exports = {
  StepStatusReporter,
};
