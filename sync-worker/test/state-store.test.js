'use strict';

const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');
const StateStore = require('../src/state-store');
const { SqliteStateStore, migrateJsonToSqlite } = require('../src/state-store');

const logger = { info() {}, warn() {}, error() {} };

test('json stateStore: markSuccess persists last_deleted_count and seen IDs', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sync-state-'));
  const statePath = path.join(dir, 'state.json');
  const store = new StateStore({ state: { backend: 'json', path: statePath, store_seen_ids: true } }, logger);

  await store.load();
  await store.markSuccess('osm_pois', {
    indexed: 2,
    failed: 0,
    deleted: 3,
    durationSeconds: 1.25
  }, new Set(['postgis:osm_pois:2', 'postgis:osm_pois:1']));

  const saved = JSON.parse(await fs.readFile(statePath, 'utf8'));
  assert.equal(saved.sources.osm_pois.last_deleted_count, 3);
  assert.deepEqual(saved.sources.osm_pois.seen_ids, ['postgis:osm_pois:1', 'postgis:osm_pois:2']);
});

test('sqlite stateStore: uses WAL and persists source state, seen IDs, and JSON snapshot', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sync-state-sqlite-'));
  const sqlitePath = path.join(dir, 'state.sqlite');
  const snapshotPath = path.join(dir, 'state.json');
  const store = new StateStore({
    state: {
      backend: 'sqlite',
      path: sqlitePath,
      json_snapshot_path: snapshotPath,
      store_seen_ids: true
    }
  }, logger);

  await store.load();
  assert.equal(store.backend, 'sqlite');
  assert.equal(store.journalMode, 'wal');

  await store.markSuccess('osm_pois', {
    indexed: 2,
    failed: 0,
    deleted: 1,
    read: 2,
    durationSeconds: 1
  }, new Set(['postgis:osm_pois:2', 'postgis:osm_pois:1']));
  await store.setIndexVersion('pelias_v3');
  await store.close();

  const reloaded = new StateStore({
    state: {
      backend: 'sqlite',
      path: sqlitePath,
      json_snapshot_path: snapshotPath,
      store_seen_ids: true
    }
  }, logger);
  await reloaded.load();

  assert.deepEqual([...reloaded.previousIds('osm_pois')], ['postgis:osm_pois:1', 'postgis:osm_pois:2']);
  assert.equal(reloaded.state.sources.osm_pois.last_indexed_count, 2);
  assert.equal(reloaded.state.sources.osm_pois.last_deleted_count, 1);
  assert.equal(reloaded.state.indexes.last_index_version, 'pelias_v3');

  const snapshot = JSON.parse(await fs.readFile(snapshotPath, 'utf8'));
  assert.equal(snapshot.sources.osm_pois.last_indexed_count, 2);
  assert.deepEqual(snapshot.sources.osm_pois.seen_ids, ['postgis:osm_pois:1', 'postgis:osm_pois:2']);
  await reloaded.close();
});

test('sqlite stateStore: markSuccess replaces seen IDs transactionally', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sync-state-sqlite-'));
  const sqlitePath = path.join(dir, 'state.sqlite');
  const store = new SqliteStateStore({
    state: {
      backend: 'sqlite',
      path: sqlitePath,
      json_snapshot_path: path.join(dir, 'state.json'),
      store_seen_ids: true
    }
  }, logger);

  await store.load();
  await store.markSuccess('streets', {
    indexed: 3,
    failed: 0,
    deleted: 0,
    read: 3,
    durationSeconds: 1
  }, new Set(['postgis:streets:1', 'postgis:streets:2', 'postgis:streets:3']));

  await store.markSuccess('streets', {
    indexed: 1,
    failed: 0,
    deleted: 2,
    read: 1,
    durationSeconds: 1
  }, new Set(['postgis:streets:3']));

  assert.deepEqual([...store.previousIds('streets')], ['postgis:streets:3']);
  assert.equal(store.state.sources.streets.last_deleted_count, 2);
  await store.close();
});

test('sqlite stateStore: run history and failures persist', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sync-state-sqlite-'));
  const sqlitePath = path.join(dir, 'state.sqlite');
  const store = new StateStore({
    state: {
      backend: 'sqlite',
      path: sqlitePath,
      json_snapshot_path: path.join(dir, 'state.json'),
      store_seen_ids: true
    }
  }, logger);

  await store.load();
  const run = await store.startRun({ source: 'osm_pois', mode: 'sync' });
  await store.finishRun(run.run_id, 'failed', { indexed: 1, failed: 2, deleted: 0 }, new Error('boom'));
  await store.markFailure('osm_pois', Object.assign(new Error('source failed'), {
    code: 'source_failed',
    details: { reason: 'test' }
  }));
  await store.close();

  const reloaded = new StateStore({
    state: {
      backend: 'sqlite',
      path: sqlitePath,
      json_snapshot_path: path.join(dir, 'state.json'),
      store_seen_ids: true
    }
  }, logger);
  await reloaded.load();

  assert.equal(reloaded.listRuns()[0].status, 'failed');
  assert.equal(reloaded.listRuns()[0].error, 'boom');
  assert.equal(reloaded.state.sources.osm_pois.failure_count, 1);
  assert.equal(reloaded.state.sources.osm_pois.last_error.code, 'source_failed');
  await reloaded.close();
});

test('json stateStore: records alias switch history', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sync-state-alias-json-'));
  const statePath = path.join(dir, 'state.json');
  const store = new StateStore({ state: { backend: 'json', path: statePath, store_seen_ids: true } }, logger);

  await store.load();
  const history = await store.recordAliasSwitch({
    type: 'rollback',
    read_alias: 'pelias',
    write_alias: 'pelias_write',
    previous_read_index: 'pelias_v3',
    previous_write_index: 'pelias_v3',
    target_index: 'pelias_v2',
    details: { sample_hits: 1 }
  });

  assert.equal(history.type, 'rollback');
  assert.equal(store.latestAliasSwitch({ status: 'success' }).target_index, 'pelias_v2');

  const saved = JSON.parse(await fs.readFile(statePath, 'utf8'));
  assert.equal(saved.alias_switches[0].previous_read_index, 'pelias_v3');
  assert.equal(saved.alias_switches[0].target_index, 'pelias_v2');
});

test('sqlite stateStore: records alias switch history and writes compatibility snapshot', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sync-state-alias-sqlite-'));
  const sqlitePath = path.join(dir, 'state.sqlite');
  const snapshotPath = path.join(dir, 'state.json');
  const store = new StateStore({
    state: {
      backend: 'sqlite',
      path: sqlitePath,
      json_snapshot_path: snapshotPath,
      store_seen_ids: true
    }
  }, logger);

  await store.load();
  await store.recordAliasSwitch({
    type: 'blue_green_reindex',
    read_alias: 'pelias',
    write_alias: 'pelias_write',
    previous_read_index: 'pelias_v1',
    previous_write_index: 'pelias_v1',
    target_index: 'pelias_v2',
    details: { document_count: 10 }
  });
  await store.close();

  const reloaded = new StateStore({
    state: {
      backend: 'sqlite',
      path: sqlitePath,
      json_snapshot_path: snapshotPath,
      store_seen_ids: true
    }
  }, logger);
  await reloaded.load();

  assert.equal(reloaded.aliasSwitches()[0].type, 'blue_green_reindex');
  assert.equal(reloaded.latestAliasSwitch({ status: 'success' }).previous_read_index, 'pelias_v1');

  const snapshot = JSON.parse(await fs.readFile(snapshotPath, 'utf8'));
  assert.equal(snapshot.alias_switches[0].target_index, 'pelias_v2');
  await reloaded.close();
});

test('sqlite stateStore: bootstraps from existing JSON snapshot before writing compatibility snapshot', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sync-state-bootstrap-'));
  const sqlitePath = path.join(dir, 'state.sqlite');
  const snapshotPath = path.join(dir, 'state.json');
  const snapshotState = {
    version: 1,
    sources: {
      osm_pois: {
        last_success_timestamp: '2026-06-01T00:00:00.000Z',
        last_started_timestamp: null,
        last_finished_at: '2026-06-01T00:00:01.000Z',
        last_duration_seconds: 1,
        last_indexed_count: 2,
        last_failed_count: 0,
        last_deleted_count: 0,
        failure_count: 0,
        last_error: null,
        seen_ids: ['postgis:osm_pois:1', 'postgis:osm_pois:2']
      }
    },
    indexes: { last_index_version: 'pelias_v3' },
    runs: [],
    alias_switches: [{
      switch_id: 'alias_1',
      type: 'blue_green_reindex',
      read_alias: 'pelias',
      write_alias: 'pelias_write',
      previous_read_index: 'pelias_v2',
      previous_write_index: 'pelias_v2',
      target_index: 'pelias_v3',
      switched_at: '2026-06-01T00:00:02.000Z',
      status: 'success',
      details: {}
    }]
  };
  await fs.writeFile(snapshotPath, JSON.stringify(snapshotState, null, 2));

  const store = new StateStore({
    state: {
      backend: 'sqlite',
      path: sqlitePath,
      json_snapshot_path: snapshotPath,
      store_seen_ids: true
    }
  }, logger);
  await store.load();

  assert.equal(store.state.sources.osm_pois.last_indexed_count, 2);
  assert.deepEqual([...store.previousIds('osm_pois')], ['postgis:osm_pois:1', 'postgis:osm_pois:2']);
  assert.equal(store.state.indexes.last_index_version, 'pelias_v3');
  assert.equal(store.latestAliasSwitch({ status: 'success' }).target_index, 'pelias_v3');

  const snapshotAfterLoad = JSON.parse(await fs.readFile(snapshotPath, 'utf8'));
  assert.equal(snapshotAfterLoad.sources.osm_pois.last_indexed_count, 2);
  assert.equal(snapshotAfterLoad.alias_switches[0].target_index, 'pelias_v3');
  await store.close();
});

test('sqlite stateStore: fails fast with clear error when state path parent is not writable directory', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sync-state-bad-path-'));
  const notDirectory = path.join(dir, 'not-a-directory');
  await fs.writeFile(notDirectory, 'x');

  const store = new StateStore({
    state: {
      backend: 'sqlite',
      path: path.join(notDirectory, 'state.sqlite'),
      json_snapshot_path: path.join(dir, 'state.json'),
      store_seen_ids: true
    }
  }, logger);

  await assert.rejects(
    () => store.load(),
    /SQLite state directory is not writable/
  );
});

test('stateStore: migrates JSON state to SQLite and keeps compatibility snapshot', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sync-state-migrate-'));
  const jsonPath = path.join(dir, 'sync-state.json');
  const sqlitePath = path.join(dir, 'sync-state.sqlite');
  const state = {
    version: 1,
    sources: {
      osm_pois: {
        last_success_timestamp: new Date().toISOString(),
        last_started_timestamp: null,
        last_finished_at: null,
        last_duration_seconds: 1,
        last_indexed_count: 2,
        last_failed_count: 0,
        last_deleted_count: 1,
        failure_count: 0,
        last_error: null,
        seen_ids: ['postgis:osm_pois:1', 'postgis:osm_pois:2']
      }
    },
    indexes: { last_index_version: 'pelias_v2', updated_at: new Date().toISOString() },
    runs: [{
      run_id: 'run_1',
      source: 'osm_pois',
      mode: 'sync',
      started_at: new Date().toISOString(),
      finished_at: null,
      status: 'running',
      indexed_count: 0,
      deleted_count: 0,
      failed_count: 0,
      error: null
    }],
    alias_switches: [{
      switch_id: 'alias_1',
      type: 'rollback',
      read_alias: 'pelias',
      write_alias: 'pelias_write',
      previous_read_index: 'pelias_v3',
      previous_write_index: 'pelias_v3',
      target_index: 'pelias_v2',
      switched_at: new Date().toISOString(),
      status: 'success',
      details: { sample_hits: 1 }
    }]
  };
  await fs.writeFile(jsonPath, JSON.stringify(state, null, 2));

  const result = await migrateJsonToSqlite({
    state: {
      backend: 'sqlite',
      path: sqlitePath,
      json_snapshot_path: jsonPath,
      store_seen_ids: true
    }
  }, logger);

  assert.equal(result.sqlite_path, sqlitePath);
  assert.deepEqual(result.sources, ['osm_pois']);
  assert.equal(result.seen_id_count, 2);

  const store = new StateStore({
    state: {
      backend: 'sqlite',
      path: sqlitePath,
      json_snapshot_path: jsonPath,
      store_seen_ids: true
    }
  }, logger);
  await store.load();
  assert.deepEqual([...store.previousIds('osm_pois')], ['postgis:osm_pois:1', 'postgis:osm_pois:2']);
  assert.equal(store.state.indexes.last_index_version, 'pelias_v2');
  assert.equal(store.listRuns()[0].run_id, 'run_1');
  assert.equal(store.aliasSwitches()[0].target_index, 'pelias_v2');
  await store.close();
});
