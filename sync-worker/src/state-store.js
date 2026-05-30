'use strict';

const fs = require('fs/promises');
const path = require('path');

class StateStore {
  constructor(config, logger) {
    this.path = process.env.SYNC_STATE_PATH || config.state.path;
    this.storeSeenIds = config.state.store_seen_ids !== false;
    this.log = logger;
    this.state = {
      version: 1,
      sources: {},
      indexes: {},
      runs: []
    };
  }

  async load() {
    try {
      const raw = await fs.readFile(this.path, 'utf8');
      this.state = JSON.parse(raw);
      this.state.sources = this.state.sources || {};
      this.state.indexes = this.state.indexes || {};
      this.state.runs = this.state.runs || [];
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
      await this.save();
    }
  }

  async save() {
    await fs.mkdir(path.dirname(this.path), { recursive: true });
    const temp = `${this.path}.tmp`;
    await fs.writeFile(temp, JSON.stringify(this.state, null, 2));
    await fs.rename(temp, this.path);
  }

  source(name) {
    if (!this.state.sources[name]) {
      this.state.sources[name] = {
        last_success_timestamp: null,
        last_started_timestamp: null,
        last_finished_at: null,
        last_duration_seconds: null,
        last_indexed_count: 0,
        last_failed_count: 0,
        last_deleted_count: 0,
        failure_count: 0,
        last_error: null,
        seen_ids: []
      };
    }
    return this.state.sources[name];
  }

  /**
   * Returns the number of seconds since last successful sync for a source.
   * Returns null if no successful sync has occurred.
   */
  stalenessSeconds(name) {
    const source = this.state.sources[name];
    if (!source || !source.last_success_timestamp) return null;
    return Math.floor((Date.now() - new Date(source.last_success_timestamp).getTime()) / 1000);
  }

  /**
   * Returns true if any source is stale beyond the given threshold.
   */
  isStale(thresholdSeconds) {
    for (const [name] of Object.entries(this.state.sources || {})) {
      const staleness = this.stalenessSeconds(name);
      if (staleness === null || staleness > thresholdSeconds) return true;
    }
    return false;
  }

  previousIds(name) {
    return new Set(this.source(name).seen_ids || []);
  }

  async markStart(name) {
    const source = this.source(name);
    source.last_started_timestamp = new Date().toISOString();
    await this.save();
  }

  async markSuccess(name, result, seenIds) {
    const source = this.source(name);
    source.last_success_timestamp = new Date().toISOString();
    source.last_finished_at = new Date().toISOString();
    source.last_duration_seconds = result.durationSeconds;
    source.last_indexed_count = result.indexed;
    source.last_failed_count = result.failed;
    source.last_deleted_count = result.deleted;
    source.failure_count = 0;
    source.last_error = null;

    if (this.storeSeenIds) {
      source.seen_ids = Array.from(seenIds).sort();
    }

    await this.save();
  }

  async markFailure(name, err) {
    const source = this.source(name);
    source.failure_count += 1;
    source.last_error = {
      timestamp: new Date().toISOString(),
      message: String(err && err.message ? err.message : err)
    };
    await this.save();
  }

  async setIndexVersion(indexName) {
    this.state.indexes.last_index_version = indexName;
    this.state.indexes.updated_at = new Date().toISOString();
    await this.save();
  }

  async startRun({ source, mode }) {
    const run = {
      run_id: createRunId(),
      source,
      mode,
      started_at: new Date().toISOString(),
      finished_at: null,
      status: 'running',
      indexed_count: 0,
      deleted_count: 0,
      failed_count: 0,
      error: null
    };
    this.state.runs = this.state.runs || [];
    this.state.runs.unshift(run);
    this.state.runs = this.state.runs.slice(0, 200);
    await this.save();
    return run;
  }

  async finishRun(runId, status, result = {}, error = null) {
    const run = this.getRun(runId);
    if (!run) return null;

    run.finished_at = new Date().toISOString();
    run.status = status;
    run.indexed_count = result.indexed || 0;
    run.deleted_count = result.deleted || 0;
    run.failed_count = result.failed || 0;
    run.error = error ? String(error.message || error) : null;
    await this.save();
    return run;
  }

  listRuns() {
    return this.state.runs || [];
  }

  getRun(runId) {
    return (this.state.runs || []).find(run => run.run_id === runId) || null;
  }
}

function createRunId() {
  return `run_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

module.exports = StateStore;
