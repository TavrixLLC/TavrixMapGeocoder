'use strict';

const crypto = require('crypto');

class ReplayManager {
  constructor(pool, logger) {
    this.pool = pool;
    this.log = logger;
    this.currentJob = null;
  }

  isActive() {
    return this.currentJob?.active || false;
  }

  getStatus() {
    if (!this.currentJob) return null;
    return { ...this.currentJob };
  }

  async start(opts) {
    if (this.isActive()) {
      return {
        error: 'Replay already in progress',
        jobId: this.currentJob.id,
        progress: this.currentJob.progress
      };
    }

    const job = {
      id: crypto.randomUUID(),
      active: true,
      from: opts.from,
      to: opts.to,
      table: opts.table || null,
      batchSize: Math.min(opts.batch_size || 1000, 5000),
      delayMs: opts.delay_ms || 500,
      totalReplayed: 0,
      progress: 'starting',
      cancelRequested: false,
      startedAt: new Date().toISOString(),
      error: null
    };

    this.currentJob = job;

    this._run(job).catch(err => {
      job.progress = 'failed';
      job.error = err.message;
      job.active = false;
      this.log.error('Replay job failed', { jobId: job.id, error: err.message });
    });

    return { jobId: job.id, status: 'accepted' };
  }

  cancel() {
    if (!this.currentJob || !this.currentJob.active) {
      return { error: 'No active replay job' };
    }
    this.currentJob.cancelRequested = true;
    return { jobId: this.currentJob.id, status: 'cancel_requested' };
  }

  async _run(job) {
    this.log.info('Replay job started', {
      jobId: job.id, from: job.from, to: job.to, table: job.table
    });

    while (!job.cancelRequested) {
      const params = [job.from, job.to];
      let tableFilter = '';
      if (job.table) {
        tableFilter = 'AND table_name = $3';
        params.push(job.table);
      }
      params.push(job.batchSize);

      const { rowCount } = await this.pool.query(`
        UPDATE pelias_outbox
        SET status = 'pending',
            claimed_by = NULL,
            claimed_at = NULL,
            retry_count = 0
        WHERE status = 'processed'
          AND created_at >= $1 AND created_at < $2
          ${tableFilter}
        LIMIT $${params.length}
      `, params);

      job.totalReplayed += rowCount;
      job.progress = `replayed ${job.totalReplayed} events`;

      if (rowCount === 0) break;

      // Throttle to avoid starving live processing
      await this._sleep(job.delayMs);
    }

    job.active = false;
    job.progress = job.cancelRequested ? 'cancelled' : 'completed';
    this.log.info('Replay job finished', {
      jobId: job.id,
      totalReplayed: job.totalReplayed,
      status: job.progress
    });
  }

  _sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

module.exports = ReplayManager;
