'use strict';

const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  syncSource,
  reindexAll,
  rollbackAliases,
  SourceCountDropError,
  ReindexValidationError,
  AliasRollbackError
} = require('../src/index');
const StateStore = require('../src/state-store');

const source = {
  name: 'osm_pois',
  enabled: true,
  delete_strategy: 'source_diff',
  batch_size: 10
};

function makeDeps(rows, previousIds = [], overrides = {}) {
  const calls = {
    indexed: [],
    deleted: [],
    targets: [],
    validation: [],
    successes: [],
    failures: [],
    aliasSwitches: [],
    runs: []
  };

  const deps = {
    config: {
      worker: {
        dry_run: false,
        source_drop_min_previous_count: 1,
        source_drop_max_ratio: 0.75
      },
      elasticsearch: {
        max_bulk_docs: 10,
        read_alias: 'pelias',
        write_alias: 'pelias_write'
      },
      sources: [source]
    },
    postgisReader: {
      async *streamSource() {
        for (const row of rows) yield row;
      }
    },
    transform: {
      toDomainDoc(_source, row) {
        return { id: row.id };
      }
    },
    enrichment: {
      enrich(doc) {
        return doc;
      }
    },
    esWriter: {
      targetIndex: 'pelias_write',
      setTargetIndex(target) {
        calls.targets.push(target);
        this.targetIndex = target;
      },
      async indexDocuments(_sourceName, docs) {
        calls.indexed.push(...docs.map(doc => doc.id));
        return { indexed: docs.length, failed: 0 };
      },
      async deleteIds(_sourceName, ids) {
        calls.deleted.push(...ids);
        return { deleted: ids.length, failed: 0 };
      }
    },
    esClient: {
      async count({ index }) {
        calls.validation.push(`count:${index}`);
        return { count: rows.length };
      },
      async search({ index, body }) {
        calls.validation.push(`search:${index}`);
        calls.sampleSearch = body.query;
        return { hits: { hits: rows.length > 0 ? [{ _id: rows[0].id }] : [] } };
      }
    },
    stateStore: {
      previousIds() {
        return new Set(previousIds);
      },
      async markStart() {},
      async markSuccess(name, result, seenIds) {
        calls.successes.push({ name, result, seenIds: [...seenIds].sort() });
      },
      async markFailure(name, err) {
        calls.failures.push({ name, err });
      },
      async writeFailureSamples() {
        return null;
      },
      async setIndexVersion(indexName) {
        calls.indexVersion = indexName;
      },
      async recordAliasSwitch(entry) {
        calls.aliasSwitches.unshift(entry);
        return entry;
      },
      aliasSwitches() {
        return calls.aliasSwitches;
      },
      latestAliasSwitch(filter = {}) {
        return calls.aliasSwitches.find(item => (
          (!filter.status || item.status === filter.status)
            && (!filter.type || item.type === filter.type)
        )) || null;
      },
      async startRun({ source, mode }) {
        const run = {
          run_id: `run_${calls.runs.length + 1}`,
          source,
          mode,
          status: 'running'
        };
        calls.runs.unshift(run);
        return run;
      },
      async finishRun(runId, status, result = {}, error = null) {
        const run = calls.runs.find(item => item.run_id === runId);
        Object.assign(run, {
          status,
          indexed_count: result.indexed || 0,
          deleted_count: result.deleted || 0,
          failed_count: result.failed || 0,
          error: error ? String(error.message || error) : null
        });
        return run;
      }
    },
    metrics: {
      rowsRead: metric(),
      docsFailed: metric(),
      docsDeleted: metric(),
      docsIndexed: metric(),
      duration: { labels: () => ({ observe() {} }) },
      postgisQueryDuration: { labels: () => ({ observe() {} }) },
      markLastSuccess() {},
      markLastError() {}
    },
    indexManager: {
      async createNextVersionIndex() {
        return 'pelias_v2';
      },
      async indexExists(indexName) {
        calls.validation.push(`exists:${indexName}`);
        return true;
      },
      async aliasTargets(alias) {
        calls.validation.push(`alias:${alias}`);
        return ['pelias_v1'];
      },
      async switchAliases(indexName) {
        calls.validation.push(`switch:${indexName}`);
        calls.switchedAlias = indexName;
        return {
          target_index: indexName,
          read_alias: 'pelias',
          write_alias: 'pelias_write',
          previous_read_targets: ['pelias_v1'],
          previous_write_targets: ['pelias_v1']
        };
      }
    },
    log: { info() {}, warn() {}, error() {} }
  };

  return { deps: merge(deps, overrides), calls };
}

function metric() {
  return { labels: () => ({ inc() {} }) };
}

function merge(base, overrides) {
  for (const [key, value] of Object.entries(overrides)) {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      base[key] = merge(base[key] || {}, value);
    } else {
      base[key] = value;
    }
  }
  return base;
}

test('syncSource: deletes IDs missing from the latest source-scoped run', async () => {
  const { deps, calls } = makeDeps(
    [{ id: 'postgis:osm_pois:1' }],
    ['postgis:osm_pois:1', 'postgis:osm_pois:2']
  );

  const result = await syncSource(deps, 'osm_pois', { mode: 'test-sync' });

  assert.deepEqual(calls.indexed, ['postgis:osm_pois:1']);
  assert.deepEqual(calls.deleted, ['postgis:osm_pois:2']);
  assert.equal(result.deleted, 1);
  assert.equal(calls.successes[0].result.deleted, 1);
  assert.deepEqual(calls.successes[0].seenIds, ['postgis:osm_pois:1']);
});

test('syncSource: source diff deletes work with SQLite state backend', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sync-service-sqlite-'));
  const store = new StateStore({
    state: {
      backend: 'sqlite',
      path: path.join(dir, 'sync-state.sqlite'),
      json_snapshot_path: path.join(dir, 'sync-state.json'),
      store_seen_ids: true
    }
  }, { info() {}, warn() {}, error() {} });
  await store.load();
  await store.markSuccess('osm_pois', {
    indexed: 2,
    failed: 0,
    deleted: 0,
    read: 2,
    durationSeconds: 1
  }, new Set(['postgis:osm_pois:1', 'postgis:osm_pois:2']));

  const { deps, calls } = makeDeps([{ id: 'postgis:osm_pois:1' }], []);
  deps.stateStore = store;

  const result = await syncSource(deps, 'osm_pois', { mode: 'sqlite-test-sync' });

  assert.deepEqual(calls.deleted, ['postgis:osm_pois:2']);
  assert.equal(result.deleted, 1);
  assert.deepEqual([...store.previousIds('osm_pois')], ['postgis:osm_pois:1']);

  const snapshot = JSON.parse(await fs.readFile(path.join(dir, 'sync-state.json'), 'utf8'));
  assert.equal(snapshot.sources.osm_pois.last_deleted_count, 1);
  assert.deepEqual(snapshot.sources.osm_pois.seen_ids, ['postgis:osm_pois:1']);
  await store.close();
});

test('syncSource: blocks delete diff when source count drops unexpectedly', async () => {
  const { deps, calls } = makeDeps(
    [],
    ['postgis:osm_pois:1', 'postgis:osm_pois:2'],
    { config: { worker: { source_drop_max_ratio: 0.25 } } }
  );

  await assert.rejects(
    () => syncSource(deps, 'osm_pois', { mode: 'test-sync' }),
    SourceCountDropError
  );

  assert.deepEqual(calls.deleted, []);
  assert.equal(calls.failures[0].err.code, 'unexpected_source_drop');
});

test('syncSource: admin enrichment missing_country status does not drop documents', async () => {
  const { deps, calls } = makeDeps(
    [{ id: 'postgis:osm_pois:1' }],
    [],
    {
      adminLookup: {
        async enrichBatch(docs) {
          calls.adminEnriched = docs.length;
          docs[0].admin_enrichment_status = 'missing_country';
          return docs;
        }
      }
    }
  );

  const result = await syncSource(deps, 'osm_pois', { mode: 'test-sync' });

  assert.equal(calls.adminEnriched, 1);
  assert.deepEqual(calls.indexed, ['postgis:osm_pois:1']);
  assert.equal(result.indexed, 1);
  assert.equal(result.failed, 0);
});

test('reindexAll: indexes into a new version before switching aliases', async () => {
  const { deps, calls } = makeDeps([{ id: 'postgis:osm_pois:1' }], []);

  const result = await reindexAll(deps);

  assert.deepEqual(calls.targets, ['pelias_v2', 'pelias_write']);
  assert.deepEqual(calls.validation, [
    'exists:pelias_v2',
    'alias:pelias',
    'alias:pelias_write',
    'count:pelias_v2',
    'search:pelias_v2',
    'switch:pelias_v2'
  ]);
  assert.equal(calls.switchedAlias, 'pelias_v2');
  assert.equal(calls.indexVersion, 'pelias_v2');
  assert.equal(result.indexed, 1);
  assert.equal(result.validation.document_count, 1);
  assert.deepEqual(result.validation.aliases, {
    pelias: ['pelias_v1'],
    pelias_write: ['pelias_v1']
  });
  assert.deepEqual(calls.sampleSearch, { match_all: {} });
  assert.deepEqual(calls.deleted, []);
});

test('reindexAll: records source success and index version with SQLite state backend', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'reindex-sqlite-'));
  const store = new StateStore({
    state: {
      backend: 'sqlite',
      path: path.join(dir, 'sync-state.sqlite'),
      json_snapshot_path: path.join(dir, 'sync-state.json'),
      store_seen_ids: true
    }
  }, { info() {}, warn() {}, error() {} });
  await store.load();

  const { deps, calls } = makeDeps([{ id: 'postgis:osm_pois:1' }], []);
  deps.stateStore = store;

  const result = await reindexAll(deps);

  assert.equal(result.indexed, 1);
  assert.equal(calls.switchedAlias, 'pelias_v2');
  assert.equal(store.state.sources.osm_pois.last_indexed_count, 1);
  assert.equal(store.state.indexes.last_index_version, 'pelias_v2');

  const snapshot = JSON.parse(await fs.readFile(path.join(dir, 'sync-state.json'), 'utf8'));
  assert.equal(snapshot.sources.osm_pois.last_indexed_count, 1);
  assert.equal(snapshot.indexes.last_index_version, 'pelias_v2');
  await store.close();
});

test('reindexAll: validates against unique source IDs, not bulk operation count', async () => {
  const { deps, calls } = makeDeps(
    [{ id: 'postgis:osm_pois:1' }, { id: 'postgis:osm_pois:1' }],
    [],
    {
      esClient: {
        async count({ index }) {
          calls.validation.push(`count:${index}`);
          return { count: 1 };
        }
      }
    }
  );

  const result = await reindexAll(deps);

  assert.equal(result.indexed, 2);
  assert.equal(result.unique_indexed, 1);
  assert.equal(result.validation.document_count, 1);
  assert.equal(calls.switchedAlias, 'pelias_v2');
});

test('reindexAll: does not switch aliases when target validation fails', async () => {
  const { deps, calls } = makeDeps(
    [{ id: 'postgis:osm_pois:1' }],
    [],
    {
      esClient: {
        async count({ index }) {
          calls.validation.push(`count:${index}`);
          return { count: 0 };
        }
      }
    }
  );

  await assert.rejects(
    () => reindexAll(deps),
    ReindexValidationError
  );

  assert.equal(calls.switchedAlias, undefined);
  assert.deepEqual(calls.targets, ['pelias_v2', 'pelias_write']);
  assert.ok(!calls.validation.includes('switch:pelias_v2'));
});

test('rollbackAliases: refuses missing target index', async () => {
  const { deps, calls } = makeDeps(
    [{ id: 'postgis:osm_pois:1' }],
    [],
    {
      indexManager: {
        async indexExists(indexName) {
          calls.validation.push(`exists:${indexName}`);
          return false;
        },
        async aliasTargets(alias) {
          calls.validation.push(`alias:${alias}`);
          return ['pelias_v3'];
        }
      }
    }
  );

  await assert.rejects(
    () => rollbackAliases(deps, 'pelias_missing'),
    err => err instanceof AliasRollbackError && err.code === 'rollback_target_missing'
  );

  assert.ok(!calls.validation.includes('switch:pelias_missing'));
  assert.equal(calls.runs[0].status, 'failed');
  assert.equal(calls.runs[0].error.includes('does not exist'), true);
});

test('rollbackAliases: refuses empty target index', async () => {
  const { deps, calls } = makeDeps(
    [{ id: 'postgis:osm_pois:1' }],
    [],
    {
      esClient: {
        async count({ index }) {
          calls.validation.push(`count:${index}`);
          return { count: 0 };
        }
      },
      indexManager: {
        async aliasTargets(alias) {
          calls.validation.push(`alias:${alias}`);
          return ['pelias_v3'];
        }
      }
    }
  );

  await assert.rejects(
    () => rollbackAliases(deps, 'pelias_v2'),
    err => err instanceof AliasRollbackError && err.code === 'empty_rollback_target'
  );

  assert.ok(!calls.validation.includes('switch:pelias_v2'));
  assert.equal(calls.runs[0].status, 'failed');
});

test('rollbackAliases: no-arg rollback skips empty previous index', async () => {
  const counts = {
    pelias_v1: 0,
    pelias_v2: 42
  };
  const { deps, calls } = makeDeps(
    [{ id: 'postgis:osm_pois:1' }],
    [],
    {
      esClient: {
        async count({ index }) {
          calls.validation.push(`count:${index}`);
          return { count: counts[index] || 0 };
        },
        async search({ index }) {
          calls.validation.push(`search:${index}`);
          return { hits: { hits: counts[index] > 0 ? [{ _id: `${index}:sample` }] : [] } };
        }
      },
      indexManager: {
        async aliasTargets(alias) {
          calls.validation.push(`alias:${alias}`);
          return ['pelias_v3'];
        }
      }
    }
  );
  calls.aliasSwitches.push(
    {
      type: 'blue_green_reindex',
      status: 'success',
      previous_read_index: 'pelias_v1',
      previous_write_index: 'pelias_v1',
      target_index: 'pelias_v3'
    },
    {
      type: 'blue_green_reindex',
      status: 'success',
      previous_read_index: 'pelias_v2',
      previous_write_index: 'pelias_v2',
      target_index: 'pelias_v1'
    }
  );

  const result = await rollbackAliases(deps);

  assert.equal(result.target_index, 'pelias_v2');
  assert.equal(result.inferred, true);
  assert.equal(result.skipped_candidates[0].target_index, 'pelias_v1');
  assert.equal(result.skipped_candidates[0].code, 'empty_rollback_target');
  assert.equal(calls.switchedAlias, 'pelias_v2');
  assert.ok(!calls.validation.includes('switch:pelias_v1'));
});

test('rollbackAliases: no-arg rollback refuses when previous indexes are empty', async () => {
  const { deps, calls } = makeDeps(
    [{ id: 'postgis:osm_pois:1' }],
    [],
    {
      esClient: {
        async count({ index }) {
          calls.validation.push(`count:${index}`);
          return { count: 0 };
        }
      },
      indexManager: {
        async aliasTargets(alias) {
          calls.validation.push(`alias:${alias}`);
          return ['pelias_v2'];
        }
      }
    }
  );
  calls.aliasSwitches.push({
    type: 'blue_green_reindex',
    status: 'success',
    previous_read_index: 'pelias_v1',
    previous_write_index: 'pelias_v1',
    target_index: 'pelias_v2'
  });

  await assert.rejects(
    () => rollbackAliases(deps),
    err => err instanceof AliasRollbackError && err.code === 'no_valid_rollback_target'
  );

  assert.ok(!calls.validation.includes('switch:pelias_v1'));
  assert.equal(calls.runs.length, 0);
});

test('rollbackAliases: updateAliases is not called if sample search fails', async () => {
  const { deps, calls } = makeDeps(
    [{ id: 'postgis:osm_pois:1' }],
    [],
    {
      esClient: {
        async count({ index }) {
          calls.validation.push(`count:${index}`);
          return { count: 10 };
        },
        async search({ index }) {
          calls.validation.push(`search:${index}`);
          return { hits: { hits: [] } };
        }
      }
    }
  );

  await assert.rejects(
    () => rollbackAliases(deps, 'pelias_v2'),
    err => err instanceof AliasRollbackError && err.code === 'rollback_sample_search_empty'
  );

  assert.ok(!calls.validation.includes('switch:pelias_v2'));
  assert.equal(calls.switchedAlias, undefined);
});

test('rollbackAliases: successful rollback switches both aliases and stores history', async () => {
  const { deps, calls } = makeDeps([{ id: 'postgis:osm_pois:1' }], []);

  const result = await rollbackAliases(deps, 'pelias_v2');

  assert.equal(calls.switchedAlias, 'pelias_v2');
  assert.equal(calls.indexVersion, 'pelias_v2');
  assert.equal(result.validation.document_count, 1);
  assert.equal(result.history.type, 'rollback');
  assert.equal(result.history.previous_read_index, 'pelias_v1');
  assert.equal(result.history.target_index, 'pelias_v2');
  assert.equal(calls.aliasSwitches[0].type, 'rollback');
  assert.equal(calls.runs[0].status, 'success');
});

test('rollbackAliases: refuses target that is already current for both aliases', async () => {
  const { deps, calls } = makeDeps(
    [{ id: 'postgis:osm_pois:1' }],
    [],
    {
      indexManager: {
        async aliasTargets(alias) {
          calls.validation.push(`alias:${alias}`);
          return ['pelias_v2'];
        }
      }
    }
  );

  await assert.rejects(
    () => rollbackAliases(deps, 'pelias_v2'),
    err => err instanceof AliasRollbackError && err.code === 'rollback_target_already_current'
  );

  assert.ok(!calls.validation.includes('switch:pelias_v2'));
  assert.ok(!calls.validation.includes('count:pelias_v2'));
});

test('rollbackAliases: dry-run validates target without switching aliases', async () => {
  const { deps, calls } = makeDeps([{ id: 'postgis:osm_pois:1' }], []);

  const result = await rollbackAliases(deps, 'pelias_v2', { dryRun: true });

  assert.equal(result.dry_run, true);
  assert.equal(result.target_index, 'pelias_v2');
  assert.equal(result.validation.document_count, 1);
  assert.equal(result.history, null);
  assert.equal(calls.switchedAlias, undefined);
  assert.ok(!calls.validation.includes('switch:pelias_v2'));
  assert.equal(calls.indexVersion, undefined);
});

test('rollbackAliases: switches both aliases only after safety checks pass', async () => {
  const { deps, calls } = makeDeps([{ id: 'postgis:osm_pois:1' }], []);

  await rollbackAliases(deps, 'pelias_v2');

  const switchAt = calls.validation.indexOf('switch:pelias_v2');
  assert.ok(switchAt > -1);
  for (const check of ['alias:pelias', 'alias:pelias_write', 'exists:pelias_v2', 'count:pelias_v2', 'search:pelias_v2']) {
    assert.ok(calls.validation.indexOf(check) > -1);
    assert.ok(calls.validation.indexOf(check) < switchAt);
  }
  assert.equal(calls.aliasSwitches[0].previous_read_index, 'pelias_v1');
  assert.equal(calls.aliasSwitches[0].previous_write_index, 'pelias_v1');
});

test('rollbackAliases: health after rollback points to non-empty index', async () => {
  const aliasMap = {
    pelias: ['pelias_v1'],
    pelias_write: ['pelias_v1']
  };
  const counts = {
    pelias_v1: 0,
    pelias_v2: 169886
  };
  const { deps, calls } = makeDeps(
    [{ id: 'postgis:osm_pois:1' }],
    [],
    {
      esClient: {
        async count({ index }) {
          calls.validation.push(`count:${index}`);
          return { count: counts[index] || 0 };
        },
        async search({ index }) {
          calls.validation.push(`search:${index}`);
          return { hits: { hits: counts[index] > 0 ? [{ _id: `${index}:sample` }] : [] } };
        }
      },
      indexManager: {
        async aliasTargets(alias) {
          calls.validation.push(`alias:${alias}`);
          return aliasMap[alias] || [];
        },
        async switchAliases(indexName) {
          calls.validation.push(`switch:${indexName}`);
          const previousRead = [...aliasMap.pelias];
          const previousWrite = [...aliasMap.pelias_write];
          aliasMap.pelias = [indexName];
          aliasMap.pelias_write = [indexName];
          calls.switchedAlias = indexName;
          return {
            target_index: indexName,
            read_alias: 'pelias',
            write_alias: 'pelias_write',
            previous_read_targets: previousRead,
            previous_write_targets: previousWrite
          };
        }
      }
    }
  );

  await rollbackAliases(deps, 'pelias_v2');

  assert.deepEqual(aliasMap.pelias, ['pelias_v2']);
  assert.deepEqual(aliasMap.pelias_write, ['pelias_v2']);
  assert.ok(counts[aliasMap.pelias[0]] > 0);
});

test('rollbackAliases: default target works after blue/green reindex with SQLite state', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'rollback-reindex-sqlite-'));
  const store = new StateStore({
    state: {
      backend: 'sqlite',
      path: path.join(dir, 'sync-state.sqlite'),
      json_snapshot_path: path.join(dir, 'sync-state.json'),
      store_seen_ids: true
    }
  }, { info() {}, warn() {}, error() {} });
  await store.load();

  const aliasMap = {
    pelias: ['pelias_v1'],
    pelias_write: ['pelias_v1']
  };
  const { deps, calls } = makeDeps([{ id: 'postgis:osm_pois:1' }], []);
  deps.stateStore = store;
  deps.indexManager.aliasTargets = async alias => {
    calls.validation.push(`alias:${alias}`);
    return aliasMap[alias] || [];
  };
  deps.indexManager.switchAliases = async indexName => {
    calls.validation.push(`switch:${indexName}`);
    const previousRead = [...aliasMap.pelias];
    const previousWrite = [...aliasMap.pelias_write];
    aliasMap.pelias = [indexName];
    aliasMap.pelias_write = [indexName];
    calls.switchedAlias = indexName;
    return {
      target_index: indexName,
      read_alias: 'pelias',
      write_alias: 'pelias_write',
      previous_read_targets: previousRead,
      previous_write_targets: previousWrite
    };
  };

  const reindexResult = await reindexAll(deps);
  assert.equal(reindexResult.validation.document_count, 1);
  assert.deepEqual(aliasMap.pelias, ['pelias_v2']);
  assert.equal(store.aliasSwitches()[0].type, 'blue_green_reindex');

  const rollbackResult = await rollbackAliases(deps);

  assert.equal(rollbackResult.target_index, 'pelias_v1');
  assert.deepEqual(aliasMap.pelias, ['pelias_v1']);
  assert.deepEqual(aliasMap.pelias_write, ['pelias_v1']);
  assert.equal(store.aliasSwitches()[0].type, 'rollback');
  assert.equal(store.aliasSwitches()[0].previous_read_index, 'pelias_v2');
  assert.equal(store.aliasSwitches()[1].target_index, 'pelias_v2');
  assert.equal(store.listRuns()[0].source, 'aliases');
  assert.equal(store.listRuns()[0].mode, 'rollback');
  assert.equal(store.listRuns()[0].status, 'success');

  const snapshot = JSON.parse(await fs.readFile(path.join(dir, 'sync-state.json'), 'utf8'));
  assert.equal(snapshot.alias_switches[0].type, 'rollback');
  assert.equal(snapshot.indexes.last_index_version, 'pelias_v1');
  await store.close();
});
