'use strict';

class Backpressure {
  constructor(opts = {}) {
    this.baseDelayMs = opts.baseDelayMs || 1000;
    this.maxDelayMs = opts.maxDelayMs || 60000;
    this.consecutiveFailures = 0;
  }

  recordSuccess() {
    this.consecutiveFailures = 0;
  }

  recordFailure() {
    this.consecutiveFailures++;
  }

  shouldPause() {
    return this.consecutiveFailures > 0;
  }

  getPauseMs() {
    if (this.consecutiveFailures === 0) return 0;
    return Math.min(
      this.baseDelayMs * Math.pow(2, this.consecutiveFailures - 1),
      this.maxDelayMs
    );
  }

  reset() {
    this.consecutiveFailures = 0;
  }

  getState() {
    return {
      consecutiveFailures: this.consecutiveFailures,
      currentPauseMs: this.getPauseMs()
    };
  }
}

module.exports = Backpressure;
