'use strict';

const fsSync = require('fs');
const fs = require('fs/promises');
const path = require('path');

class StateStore {
  constructor(config, logger) {
    const backend = stateBackend(config);
    if (backend === 'sqlite') return new SqliteStateStore(config, logger);
    return new JsonStateStore(config, logger);
  }
}

class JsonStateStore {
  constructor(config, logger) {
    this.backend = 'json';
    this.path = process.env.SYNC_STATE_PATH || config.state.path;
    this.failedSamplePath = process.env.SYNC_FAILED_SAMPLE_PATH
      || config.state.failed_sample_path
      || path.join(path.dirname(this.path), 'failed-record-samples.jsonl');
    this.storeSeenIds = config.state.store_seen_ids !== false;
    this.log = logger;
    this.state = emptyState();
  }

  async load() {
    try {
      const raw = await fs.readFile(this.path, 'utf8');
      this.state = normalizeState(JSON.parse(raw));
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
      await this.save();
    }
  }

  async save() {
    await writeJsonAtomic(this.path, this.state);
  }

  source(name) {
    return ensureSourceState(this.state, name);
  }

  stalenessSeconds(name) {
    return stalenessSeconds(this.state, name);
  }

  isStale(thresholdSeconds) {
    return isStateStale(this.state, thresholdSeconds);
  }

  staleSources(defaultThresholdSeconds, sourceConfig = []) {
    return staleSources(this.state, defaultThresholdSeconds, sourceConfig);
  }

  previousIds(name) {
    return new Set(this.source(name).seen_ids || []);
  }

  async markStart(name) {
    const source = this.source(name);
    source.last_started_timestamp = new Date().toISOString();
    await this.save();
  }

  async markSuccess(name, result, seenIds, details = {}) {
    const source = this.source(name);
    applySuccessState(source, name, result, details);

    if (this.storeSeenIds) {
      source.seen_ids = Array.from(seenIds).sort();
    }

    await this.save();
  }

  async markFailure(name, err) {
    const source = this.source(name);
    applyFailureState(source, err);
    await this.save();
  }

  async writeFailureSamples(name, samples = []) {
    return writeFailureSamples(this.failedSamplePath, name, samples);
  }

  async setIndexVersion(indexName) {
    this.state.indexes.last_index_version = indexName;
    this.state.indexes.updated_at = new Date().toISOString();
    await this.save();
  }

  async recordAliasSwitch(entry) {
    const aliasSwitch = recordAliasSwitchState(this.state, entry);
    await this.save();
    return clone(aliasSwitch);
  }

  aliasSwitches() {
    return this.state.alias_switches || [];
  }

  latestAliasSwitch(filter = {}) {
    return latestAliasSwitchState(this.state, filter);
  }

  async startRun({ source, mode }) {
    const run = createRun({ source, mode });
    this.state.runs.unshift(run);
    this.state.runs = this.state.runs.slice(0, 200);
    await this.save();
    return clone(run);
  }

  async finishRun(runId, status, result = {}, error = null) {
    const run = this.getRun(runId);
    if (!run) return null;

    finishRunState(run, status, result, error);
    await this.save();
    return clone(run);
  }

  listRuns() {
    return this.state.runs || [];
  }

  getRun(runId) {
    return (this.state.runs || []).find(run => run.run_id === runId) || null;
  }

  exportState() {
    return clone(this.state);
  }

  async importState(state) {
    this.state = normalizeState(state);
    await this.save();
  }
}

class SqliteStateStore {
  constructor(config, logger) {
    this.backend = 'sqlite';
    this.path = sqliteStatePath(config);
    this.snapshotPath = sqliteSnapshotPath(config, this.path);
    this.failedSamplePath = process.env.SYNC_FAILED_SAMPLE_PATH
      || config.state.failed_sample_path
      || path.join(path.dirname(this.snapshotPath || this.path), 'failed-record-samples.jsonl');
    this.storeSeenIds = config.state.store_seen_ids !== false;
    this.log = logger;
    this.db = null;
    this.state = emptyState();
    this.journalMode = null;
  }

  async load() {
    await this.ensureWritableStatePath();
    try {
      this.open();
      this.configurePragmas();
      this.ensureSchema();
      this.assertWritable();
    } catch (err) {
      throw new Error(`SQLite state backend failed to open/write database at ${this.path}: ${err.message}`);
    }

    const dbState = this.readStateFromDb();
    const snapshotState = await this.readBootstrapSnapshot();
    if (isEmptyState(dbState) && hasUsefulState(snapshotState)) {
      this.state = snapshotState;
      this.replaceState(snapshotState);
      if (this.log && this.log.info) {
        this.log.info('Bootstrapped SQLite state from JSON snapshot', {
          sqlite_path: this.path,
          snapshot_path: this.snapshotPath,
          sources: Object.keys(snapshotState.sources || {}).length
        });
      }
    } else {
      this.state = dbState;
    }
    await this.writeSnapshot();
  }

  open() {
    if (this.db) return;
    let DatabaseSync;
    try {
      ({ DatabaseSync } = require('node:sqlite'));
    } catch (err) {
      throw new Error('SQLite state backend requires a Node.js runtime with node:sqlite support');
    }
    this.db = new DatabaseSync(this.path);
  }

  configurePragmas() {
    this.journalMode = String((this.db.prepare('PRAGMA journal_mode=WAL').get() || {}).journal_mode || '').toLowerCase();
    this.db.exec('PRAGMA synchronous=NORMAL');
    this.db.exec('PRAGMA foreign_keys=ON');
  }

  ensureSchema() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS sync_sources (
        source_name TEXT PRIMARY KEY,
        last_success_timestamp TEXT,
        last_started_timestamp TEXT,
        last_finished_at TEXT,
        last_duration_seconds REAL,
        last_indexed_count INTEGER NOT NULL DEFAULT 0,
        last_failed_count INTEGER NOT NULL DEFAULT 0,
        last_deleted_count INTEGER NOT NULL DEFAULT 0,
        failure_count INTEGER NOT NULL DEFAULT 0,
        last_error_json TEXT
      );

      CREATE TABLE IF NOT EXISTS source_seen_ids (
        source_name TEXT NOT NULL,
        document_id TEXT NOT NULL,
        PRIMARY KEY (source_name, document_id),
        FOREIGN KEY (source_name) REFERENCES sync_sources(source_name) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS sync_runs (
        run_id TEXT PRIMARY KEY,
        source TEXT NOT NULL,
        mode TEXT NOT NULL,
        started_at TEXT NOT NULL,
        finished_at TEXT,
        status TEXT NOT NULL,
        indexed_count INTEGER NOT NULL DEFAULT 0,
        deleted_count INTEGER NOT NULL DEFAULT 0,
        failed_count INTEGER NOT NULL DEFAULT 0,
        error TEXT
      );

      CREATE TABLE IF NOT EXISTS index_state (
        key TEXT PRIMARY KEY,
        value TEXT,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS alias_switch_history (
        switch_id TEXT PRIMARY KEY,
        type TEXT NOT NULL,
        read_alias TEXT,
        write_alias TEXT,
        previous_read_index TEXT,
        previous_write_index TEXT,
        target_index TEXT NOT NULL,
        switched_at TEXT NOT NULL,
        status TEXT NOT NULL,
        details_json TEXT
      );
    `);
  }

  async ensureWritableStatePath() {
    const dir = path.dirname(this.path);
    try {
      await fs.mkdir(dir, { recursive: true });
      await fs.access(dir, fsSync.constants.W_OK);
    } catch (err) {
      throw new Error(`SQLite state directory is not writable: ${dir}: ${err.message}`);
    }
  }

  assertWritable() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS state_store_write_check (id INTEGER);
      DELETE FROM state_store_write_check;
      INSERT INTO state_store_write_check (id) VALUES (1);
      DELETE FROM state_store_write_check;
    `);
  }

  async save() {
    this.open();
    this.replaceState(this.state);
    await this.writeSnapshot();
  }

  source(name) {
    return ensureSourceState(this.state, name);
  }

  stalenessSeconds(name) {
    return stalenessSeconds(this.state, name);
  }

  isStale(thresholdSeconds) {
    return isStateStale(this.state, thresholdSeconds);
  }

  staleSources(defaultThresholdSeconds, sourceConfig = []) {
    return staleSources(this.state, defaultThresholdSeconds, sourceConfig);
  }

  previousIds(name) {
    return new Set(this.source(name).seen_ids || []);
  }

  async markStart(name) {
    const source = this.source(name);
    source.last_started_timestamp = new Date().toISOString();
    this.transaction(() => {
      this.upsertSource(name, source);
    });
    await this.writeSnapshot();
  }

  async markSuccess(name, result, seenIds, details = {}) {
    const source = this.source(name);
    applySuccessState(source, name, result, details);
    const sortedSeenIds = Array.from(seenIds || []).sort();
    if (this.storeSeenIds) {
      source.seen_ids = sortedSeenIds;
    }

    this.transaction(() => {
      this.upsertSource(name, source);
      if (this.storeSeenIds) {
        this.replaceSeenIds(name, sortedSeenIds);
      }
    });
    await this.writeSnapshot();
  }

  async markFailure(name, err) {
    const source = this.source(name);
    applyFailureState(source, err);
    this.transaction(() => {
      this.upsertSource(name, source);
    });
    await this.writeSnapshot();
  }

  async writeFailureSamples(name, samples = []) {
    return writeFailureSamples(this.failedSamplePath, name, samples);
  }

  async setIndexVersion(indexName) {
    this.state.indexes.last_index_version = indexName;
    this.state.indexes.updated_at = new Date().toISOString();
    this.transaction(() => {
      this.upsertIndexValue('last_index_version', indexName, this.state.indexes.updated_at);
      this.upsertIndexValue('updated_at', this.state.indexes.updated_at, this.state.indexes.updated_at);
    });
    await this.writeSnapshot();
  }

  async recordAliasSwitch(entry) {
    const aliasSwitch = recordAliasSwitchState(this.state, entry);
    this.transaction(() => {
      this.insertAliasSwitch(aliasSwitch);
      this.pruneAliasSwitches();
    });
    await this.writeSnapshot();
    return clone(aliasSwitch);
  }

  aliasSwitches() {
    return this.state.alias_switches || [];
  }

  latestAliasSwitch(filter = {}) {
    return latestAliasSwitchState(this.state, filter);
  }

  async startRun({ source, mode }) {
    const run = createRun({ source, mode });
    this.state.runs.unshift(run);
    this.state.runs = this.state.runs.slice(0, 200);

    this.transaction(() => {
      this.insertRun(run);
      this.pruneRuns();
    });
    await this.writeSnapshot();
    return clone(run);
  }

  async finishRun(runId, status, result = {}, error = null) {
    const run = this.getRun(runId);
    if (!run) return null;

    finishRunState(run, status, result, error);
    this.transaction(() => {
      this.updateRun(run);
    });
    await this.writeSnapshot();
    return clone(run);
  }

  listRuns() {
    return this.state.runs || [];
  }

  getRun(runId) {
    return (this.state.runs || []).find(run => run.run_id === runId) || null;
  }

  exportState() {
    return clone(this.state);
  }

  async importState(state) {
    this.state = normalizeState(state);
    this.open();
    this.ensureSchema();
    this.replaceState(this.state);
    await this.writeSnapshot();
  }

  replaceState(state) {
    const normalized = normalizeState(state);
    this.transaction(() => {
      this.db.exec('DELETE FROM source_seen_ids');
      this.db.exec('DELETE FROM sync_sources');
      this.db.exec('DELETE FROM sync_runs');
      this.db.exec('DELETE FROM index_state');
      this.db.exec('DELETE FROM alias_switch_history');

      for (const [name, source] of Object.entries(normalized.sources || {})) {
        this.upsertSource(name, source);
        if (this.storeSeenIds) this.replaceSeenIds(name, source.seen_ids || []);
      }
      for (const run of normalized.runs || []) {
        this.insertRun(run);
      }
      for (const aliasSwitch of normalized.alias_switches || []) {
        this.insertAliasSwitch(aliasSwitch);
      }
      const updatedAt = normalized.indexes.updated_at || new Date().toISOString();
      for (const [key, value] of Object.entries(normalized.indexes || {})) {
        this.upsertIndexValue(key, value, updatedAt);
      }
    });
    this.state = normalized;
  }

  readStateFromDb() {
    const state = emptyState();
    const sources = this.db.prepare(`
      SELECT source_name, last_success_timestamp, last_started_timestamp,
             last_finished_at, last_duration_seconds, last_indexed_count,
             last_failed_count, last_deleted_count, failure_count, last_error_json
      FROM sync_sources
      ORDER BY source_name ASC
    `).all();

    for (const row of sources) {
      state.sources[row.source_name] = {
        last_success_timestamp: row.last_success_timestamp || null,
        last_started_timestamp: row.last_started_timestamp || null,
        last_finished_at: row.last_finished_at || null,
        last_duration_seconds: nullableNumber(row.last_duration_seconds),
        last_indexed_count: Number(row.last_indexed_count || 0),
        last_failed_count: Number(row.last_failed_count || 0),
        last_deleted_count: Number(row.last_deleted_count || 0),
        failure_count: Number(row.failure_count || 0),
        last_error: parseJson(row.last_error_json),
        seen_ids: []
      };
    }

    if (this.storeSeenIds) {
      const seenRows = this.db.prepare(`
        SELECT source_name, document_id
        FROM source_seen_ids
        ORDER BY source_name ASC, document_id ASC
      `).all();
      for (const row of seenRows) {
        ensureSourceState(state, row.source_name).seen_ids.push(row.document_id);
      }
    }

    state.runs = this.db.prepare(`
      SELECT run_id, source, mode, started_at, finished_at, status,
             indexed_count, deleted_count, failed_count, error
      FROM sync_runs
      ORDER BY started_at DESC
      LIMIT 200
    `).all().map(row => ({
      run_id: row.run_id,
      source: row.source,
      mode: row.mode,
      started_at: row.started_at,
      finished_at: row.finished_at || null,
      status: row.status,
      indexed_count: Number(row.indexed_count || 0),
      deleted_count: Number(row.deleted_count || 0),
      failed_count: Number(row.failed_count || 0),
      error: row.error || null
    }));

    const indexRows = this.db.prepare('SELECT key, value FROM index_state').all();
    for (const row of indexRows) {
      state.indexes[row.key] = row.value;
    }

    state.alias_switches = this.db.prepare(`
      SELECT switch_id, type, read_alias, write_alias, previous_read_index,
             previous_write_index, target_index, switched_at, status, details_json
      FROM alias_switch_history
      ORDER BY switched_at DESC
      LIMIT 200
    `).all().map(row => normalizeAliasSwitch({
      switch_id: row.switch_id,
      type: row.type,
      read_alias: row.read_alias,
      write_alias: row.write_alias,
      previous_read_index: row.previous_read_index,
      previous_write_index: row.previous_write_index,
      target_index: row.target_index,
      switched_at: row.switched_at,
      status: row.status,
      details: parseJson(row.details_json) || {}
    }));

    return normalizeState(state);
  }

  upsertSource(name, source) {
    this.db.prepare(`
      INSERT INTO sync_sources (
        source_name, last_success_timestamp, last_started_timestamp,
        last_finished_at, last_duration_seconds, last_indexed_count,
        last_failed_count, last_deleted_count, failure_count, last_error_json
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(source_name) DO UPDATE SET
        last_success_timestamp = excluded.last_success_timestamp,
        last_started_timestamp = excluded.last_started_timestamp,
        last_finished_at = excluded.last_finished_at,
        last_duration_seconds = excluded.last_duration_seconds,
        last_indexed_count = excluded.last_indexed_count,
        last_failed_count = excluded.last_failed_count,
        last_deleted_count = excluded.last_deleted_count,
        failure_count = excluded.failure_count,
        last_error_json = excluded.last_error_json
    `).run(
      name,
      source.last_success_timestamp || null,
      source.last_started_timestamp || null,
      source.last_finished_at || null,
      source.last_duration_seconds == null ? null : Number(source.last_duration_seconds),
      Number(source.last_indexed_count || 0),
      Number(source.last_failed_count || 0),
      Number(source.last_deleted_count || 0),
      Number(source.failure_count || 0),
      source.last_error ? JSON.stringify(source.last_error) : null
    );
  }

  replaceSeenIds(name, ids) {
    this.db.prepare('DELETE FROM source_seen_ids WHERE source_name = ?').run(name);
    const insert = this.db.prepare('INSERT INTO source_seen_ids (source_name, document_id) VALUES (?, ?)');
    for (const id of ids || []) {
      insert.run(name, String(id));
    }
  }

  insertRun(run) {
    this.db.prepare(`
      INSERT OR REPLACE INTO sync_runs (
        run_id, source, mode, started_at, finished_at, status,
        indexed_count, deleted_count, failed_count, error
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      run.run_id,
      run.source,
      run.mode,
      run.started_at,
      run.finished_at || null,
      run.status,
      Number(run.indexed_count || 0),
      Number(run.deleted_count || 0),
      Number(run.failed_count || 0),
      run.error || null
    );
  }

  updateRun(run) {
    this.insertRun(run);
  }

  insertAliasSwitch(aliasSwitch) {
    this.db.prepare(`
      INSERT OR REPLACE INTO alias_switch_history (
        switch_id, type, read_alias, write_alias, previous_read_index,
        previous_write_index, target_index, switched_at, status, details_json
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      aliasSwitch.switch_id,
      aliasSwitch.type,
      aliasSwitch.read_alias || null,
      aliasSwitch.write_alias || null,
      aliasSwitch.previous_read_index || null,
      aliasSwitch.previous_write_index || null,
      aliasSwitch.target_index,
      aliasSwitch.switched_at,
      aliasSwitch.status,
      aliasSwitch.details ? JSON.stringify(aliasSwitch.details) : null
    );
  }

  pruneRuns() {
    this.db.exec(`
      DELETE FROM sync_runs
      WHERE run_id NOT IN (
        SELECT run_id FROM sync_runs ORDER BY started_at DESC LIMIT 200
      )
    `);
  }

  pruneAliasSwitches() {
    this.db.exec(`
      DELETE FROM alias_switch_history
      WHERE switch_id NOT IN (
        SELECT switch_id FROM alias_switch_history ORDER BY switched_at DESC LIMIT 200
      )
    `);
  }

  upsertIndexValue(key, value, updatedAt = new Date().toISOString()) {
    this.db.prepare(`
      INSERT INTO index_state (key, value, updated_at)
      VALUES (?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET
        value = excluded.value,
        updated_at = excluded.updated_at
    `).run(key, value == null ? null : String(value), updatedAt);
  }

  transaction(fn) {
    this.open();
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = fn();
      this.db.exec('COMMIT');
      return result;
    } catch (err) {
      try {
        this.db.exec('ROLLBACK');
      } catch (_) {
        // Preserve the original error.
      }
      throw err;
    }
  }

  async writeSnapshot() {
    if (!this.snapshotPath) return;
    await writeJsonAtomic(this.snapshotPath, this.state);
  }

  async readBootstrapSnapshot() {
    if (!this.snapshotPath || this.snapshotPath === this.path) return null;
    try {
      const raw = await fs.readFile(this.snapshotPath, 'utf8');
      return normalizeState(JSON.parse(raw));
    } catch (_) {
      return null;
    }
  }

  async close() {
    if (!this.db) return;
    this.db.close();
    this.db = null;
  }
}

async function migrateJsonToSqlite(config, logger, options = {}) {
  const jsonPath = options.jsonPath
    || process.env.SYNC_JSON_STATE_PATH
    || process.env.SYNC_STATE_JSON_PATH
    || config.state.json_path
    || config.state.json_snapshot_path
    || config.state.snapshot_path
    || (stateBackend(config) === 'sqlite' ? defaultJsonSnapshotPath(config) : config.state.path);
  const envSqliteStatePath = stateBackend(config) === 'sqlite' && process.env.SYNC_STATE_PATH
    && !String(process.env.SYNC_STATE_PATH).toLowerCase().endsWith('.json')
    ? process.env.SYNC_STATE_PATH
    : null;
  const sqlitePath = options.sqlitePath
    || process.env.SYNC_SQLITE_STATE_PATH
    || envSqliteStatePath
    || config.state.sqlite_path
    || (stateBackend(config) === 'sqlite' ? config.state.path : replaceExtension(config.state.path, '.sqlite'));

  const raw = await fs.readFile(jsonPath, 'utf8');
  const state = normalizeState(JSON.parse(raw));
  const store = new SqliteStateStore({
    ...config,
    state: {
      ...config.state,
      backend: 'sqlite',
      path: sqlitePath,
      json_snapshot_path: jsonPath
    }
  }, logger);
  await store.load();
  await store.importState(state);
  await store.close();

  return {
    json_path: jsonPath,
    sqlite_path: sqlitePath,
    sources: Object.keys(state.sources || {}),
    runs: (state.runs || []).length,
    alias_switches: (state.alias_switches || []).length,
    seen_id_count: Object.values(state.sources || {})
      .reduce((sum, source) => sum + ((source.seen_ids || []).length), 0)
  };
}

function stateBackend(config) {
  return String(process.env.SYNC_STATE_BACKEND || (config.state && config.state.backend) || 'json')
    .trim()
    .toLowerCase();
}

function sqliteStatePath(config) {
  const envStatePath = process.env.SYNC_STATE_PATH;
  const envSqliteStatePath = envStatePath && !String(envStatePath).toLowerCase().endsWith('.json')
    ? envStatePath
    : null;
  return process.env.SYNC_SQLITE_STATE_PATH
    || envSqliteStatePath
    || config.state.sqlite_path
    || config.state.path
    || '/app/state/sync-state.sqlite';
}

function sqliteSnapshotPath(config, sqlitePath) {
  const configured = process.env.SYNC_STATE_SNAPSHOT_PATH
    || config.state.json_snapshot_path
    || config.state.snapshot_path;
  if (configured) return configured;
  return defaultJsonSnapshotPath({ ...config, state: { ...config.state, path: sqlitePath } });
}

function defaultJsonSnapshotPath(config) {
  const configuredPath = config.state && config.state.path ? config.state.path : '/app/state/sync-state.sqlite';
  if (configuredPath.endsWith('.json')) return configuredPath;
  return path.join(path.dirname(configuredPath), 'sync-state.json');
}

function emptyState() {
  return {
    version: 1,
    sources: {},
    indexes: {},
    runs: [],
    alias_switches: []
  };
}

function normalizeState(value) {
  const state = {
    ...emptyState(),
    ...(value || {})
  };
  state.sources = state.sources || {};
  state.indexes = state.indexes || {};
  state.runs = Array.isArray(state.runs) ? state.runs : [];
  state.alias_switches = Array.isArray(state.alias_switches)
    ? state.alias_switches.map(normalizeAliasSwitch).filter(Boolean).slice(0, 200)
    : [];
  for (const [name, source] of Object.entries(state.sources)) {
    state.sources[name] = normalizeSourceState(source);
  }
  return state;
}

function ensureSourceState(state, name) {
  if (!state.sources[name]) {
    state.sources[name] = normalizeSourceState();
  }
  return state.sources[name];
}

function normalizeSourceState(source = {}) {
  return {
    last_success_timestamp: source.last_success_timestamp || null,
    last_started_timestamp: source.last_started_timestamp || null,
    last_finished_at: source.last_finished_at || null,
    last_duration_seconds: source.last_duration_seconds == null ? null : Number(source.last_duration_seconds),
    last_indexed_count: Number(source.last_indexed_count || 0),
    last_failed_count: Number(source.last_failed_count || 0),
    last_deleted_count: Number(source.last_deleted_count || 0),
    failure_count: Number(source.failure_count || 0),
    last_error: source.last_error || null,
    seen_ids: Array.isArray(source.seen_ids) ? [...source.seen_ids].sort() : []
  };
}

function applySuccessState(source, name, result, details = {}) {
  source.last_success_timestamp = new Date().toISOString();
  source.last_finished_at = new Date().toISOString();
  source.last_duration_seconds = result.durationSeconds;
  source.last_indexed_count = result.indexed;
  source.last_failed_count = result.failed;
  source.last_deleted_count = result.deleted;
  source.failure_count = 0;
  source.last_error = result.failed > 0 ? {
    timestamp: new Date().toISOString(),
    code: 'source_sync_partial_failures',
    message: `Source ${name} synced with ${result.failed} failed records`,
    details: {
      failed_count: result.failed,
      indexed_count: result.indexed,
      deleted_count: result.deleted,
      read_count: result.read,
      failed_sample_path: details.failedSamplePath || null,
      failure_samples: details.failureSamples || []
    }
  } : null;
}

function applyFailureState(source, err) {
  source.failure_count += 1;
  source.last_error = {
    timestamp: new Date().toISOString(),
    code: err && err.code ? err.code : 'sync_failed',
    message: String(err && err.message ? err.message : err),
    details: err && err.details ? err.details : {}
  };
}

async function writeFailureSamples(failedSamplePath, name, samples = []) {
  if (!Array.isArray(samples) || samples.length === 0) return null;

  await fs.mkdir(path.dirname(failedSamplePath), { recursive: true });
  const timestamp = new Date().toISOString();
  const lines = samples.map(sample => JSON.stringify({
    timestamp,
    source: name,
    ...sample
  }));
  await fs.appendFile(failedSamplePath, `${lines.join('\n')}\n`);
  return failedSamplePath;
}

async function writeJsonAtomic(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const temp = `${filePath}.tmp`;
  await fs.writeFile(temp, JSON.stringify(value, null, 2));
  await fs.rename(temp, filePath);
}

function stalenessSeconds(state, name) {
  const source = state.sources[name];
  if (!source || !source.last_success_timestamp) return null;
  return Math.floor((Date.now() - new Date(source.last_success_timestamp).getTime()) / 1000);
}

function isStateStale(state, thresholdSeconds) {
  for (const [name] of Object.entries(state.sources || {})) {
    const staleness = stalenessSeconds(state, name);
    if (staleness === null || staleness > thresholdSeconds) return true;
  }
  return false;
}

function isEmptyState(state) {
  return !hasUsefulState(state);
}

function hasUsefulState(state) {
  if (!state) return false;
  return Object.keys(state.sources || {}).length > 0
    || Object.keys(state.indexes || {}).length > 0
    || ((state.runs || []).length > 0)
    || ((state.alias_switches || []).length > 0);
}

function staleSources(state, defaultThresholdSeconds, sourceConfig = []) {
  const out = [];
  for (const [name, source] of Object.entries(state.sources || {})) {
    const configured = sourceConfig.find(item => item.name === name);
    const threshold = Number(configured && configured.stale_after_seconds)
      || Number(defaultThresholdSeconds)
      || 86400;
    const staleness = stalenessSeconds(state, name);
    if (staleness === null || staleness > threshold) {
      out.push({
        source: name,
        last_success_at: source.last_success_timestamp || null,
        staleness_seconds: staleness,
        freshness_threshold_seconds: threshold
      });
    }
  }
  return out;
}

function createRun({ source, mode }) {
  return {
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
}

function recordAliasSwitchState(state, entry = {}) {
  const aliasSwitch = normalizeAliasSwitch({
    ...entry,
    switch_id: entry.switch_id || createAliasSwitchId(),
    switched_at: entry.switched_at || new Date().toISOString()
  });
  if (!aliasSwitch) {
    throw new Error('Alias switch history requires target_index');
  }
  state.alias_switches = [aliasSwitch, ...(state.alias_switches || [])
    .filter(item => item && item.switch_id !== aliasSwitch.switch_id)]
    .slice(0, 200);
  return aliasSwitch;
}

function latestAliasSwitchState(state, filter = {}) {
  const expectedStatus = filter.status;
  const expectedType = filter.type;
  return (state.alias_switches || []).find(aliasSwitch => (
    (!expectedStatus || aliasSwitch.status === expectedStatus)
      && (!expectedType || aliasSwitch.type === expectedType)
  )) || null;
}

function normalizeAliasSwitch(entry = {}) {
  if (!entry || !entry.target_index) return null;
  return {
    switch_id: entry.switch_id || createAliasSwitchId(),
    type: String(entry.type || 'alias_switch'),
    read_alias: entry.read_alias || null,
    write_alias: entry.write_alias || null,
    previous_read_index: entry.previous_read_index || null,
    previous_write_index: entry.previous_write_index || null,
    target_index: String(entry.target_index),
    switched_at: entry.switched_at || new Date().toISOString(),
    status: String(entry.status || 'success'),
    details: entry.details && typeof entry.details === 'object' ? entry.details : {}
  };
}

function finishRunState(run, status, result = {}, error = null) {
  run.finished_at = new Date().toISOString();
  run.status = status;
  run.indexed_count = result.indexed || 0;
  run.deleted_count = result.deleted || 0;
  run.failed_count = result.failed || 0;
  run.error = error ? String(error.message || error) : null;
}

function createRunId() {
  return `run_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

function createAliasSwitchId() {
  return `alias_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

function parseJson(value) {
  if (!value) return null;
  try {
    return JSON.parse(value);
  } catch (_) {
    return null;
  }
}

function nullableNumber(value) {
  if (value == null) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function replaceExtension(filePath, ext) {
  const parsed = path.parse(filePath);
  return path.join(parsed.dir, `${parsed.name}${ext}`);
}

function clone(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

module.exports = StateStore;
module.exports.JsonStateStore = JsonStateStore;
module.exports.SqliteStateStore = SqliteStateStore;
module.exports.migrateJsonToSqlite = migrateJsonToSqlite;
