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

test('reindexAll: passes with routable point enrichment disabled', async () => {
  const { deps, calls } = makeDeps([{ id: 'postgis:osm_pois:1' }], []);
  deps.config.routable_point_enrichment = { enabled: false };
  deps.routablePointLookup = {
    enabled: false,
    async enrichBatch(docs) {
      calls.routableDisabledDocs = docs.length;
      return docs;
    }
  };

  const result = await reindexAll(deps);

  assert.equal(result.validation.document_count, 1);
  assert.equal(calls.routableDisabledDocs, 1);
  assert.equal(calls.switchedAlias, 'pelias_v2');
});

test('reindexAll: passes with mocked routable point enrichment enabled', async () => {
  const { deps, calls } = makeDeps([{ id: 'postgis:osm_pois:1' }], []);
  deps.config.routable_point_enrichment = { enabled: true };
  deps.routablePointLookup = {
    enabled: true,
    async enrichBatch(docs) {
      calls.routableEnabledDocs = docs.length;
      for (const doc of docs) {
        doc.routable_point = { lat: 33.31, lon: 44.36 };
        doc.routable_point_status = 'snapped';
        doc.routable_point_type = 'snapped';
        doc.routable_point_source = 'postgis_nearest_road';
        doc.routable_point_distance_meters = 10;
      }
      return docs;
    }
  };
  deps.esWriter.indexDocuments = async (_sourceName, docs) => {
    calls.indexed.push(...docs.map(doc => doc.id));
    calls.indexedRoutableStatuses = docs.map(doc => doc.routable_point_status);
    return { indexed: docs.length, failed: 0 };
  };

  const result = await reindexAll(deps);

  assert.equal(result.validation.document_count, 1);
  assert.equal(calls.routableEnabledDocs, 1);
  assert.deepEqual(calls.indexedRoutableStatuses, ['snapped']);
  assert.equal(calls.switchedAlias, 'pelias_v2');
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

test('syncSource: verification mode refuses pelias_write by default', async () => {
  const { deps } = makeDeps([{ id: 'postgis:osm_pois:1' }]);
  deps.config.elasticsearch.write_alias = 'pelias_write';
  deps.config.elasticsearch.read_alias = 'pelias';
  
  process.env.P1_ENABLED = 'true';
  process.env.P1_VERIFY_INDEX = 'pelias_write';
  process.env.P1_VERIFY_ALLOW_WRITE_ALIAS = 'false';

  try {
    await assert.rejects(
      () => syncSource(deps, 'osm_pois', { mode: 'test-sync' }),
      err => err.message.includes('Safety Error: Target index')
    );
  } finally {
    delete process.env.P1_ENABLED;
    delete process.env.P1_VERIFY_INDEX;
    delete process.env.P1_VERIFY_ALLOW_WRITE_ALIAS;
  }
});

test('syncSource: verification mode writes to temp index and does not switch aliases', async () => {
  let createdIndex = null;
  let deletedIndex = null;
  const { deps, calls } = makeDeps([{ id: 'postgis:osm_pois:1' }], [], {
    indexManager: {
      async indexExists(indexName) {
        return indexName === createdIndex;
      },
      async createGenericIndex(indexName) {
        createdIndex = indexName;
      },
      async ensureExtendedMappings() {}
    },
    esClient: {
      async search() {
        return { hits: { hits: [] } };
      },
      indices: {
        async delete({ index }) {
          deletedIndex = index;
        }
      }
    }
  });

  process.env.P1_ENABLED = 'true';
  process.env.P1_VERIFY_INDEX = 'pelias_p1_temp_test';
  process.env.P1_VERIFY_ALLOW_WRITE_ALIAS = 'false';
  process.env.P1_VERIFY_KEEP_INDEX = 'false';

  try {
    const result = await syncSource(deps, 'osm_pois', { mode: 'test-sync' });
    assert.equal(createdIndex, 'pelias_p1_temp_test');
    assert.equal(deletedIndex, 'pelias_p1_temp_test');
    assert.ok(calls.targets.includes('pelias_p1_temp_test'));
    assert.equal(deps.esWriter.targetIndex, 'pelias_write');
    assert.ok(!calls.validation.some(v => v.startsWith('switch:')));
  } finally {
    delete process.env.P1_ENABLED;
    delete process.env.P1_VERIFY_INDEX;
    delete process.env.P1_VERIFY_ALLOW_WRITE_ALIAS;
    delete process.env.P1_VERIFY_KEEP_INDEX;
  }
});

test('syncSource: verification mode keeps temp index when P1_VERIFY_KEEP_INDEX=true', async () => {
  let createdIndex = null;
  let deletedIndex = null;
  const { deps } = makeDeps([{ id: 'postgis:osm_pois:1' }], [], {
    indexManager: {
      async indexExists() { return false; },
      async createGenericIndex(indexName) { createdIndex = indexName; },
      async ensureExtendedMappings() {}
    },
    esClient: {
      async search() { return { hits: { hits: [] } }; },
      indices: {
        async delete({ index }) { deletedIndex = index; }
      }
    }
  });

  process.env.P1_ENABLED = 'true';
  process.env.P1_VERIFY_INDEX = 'pelias_p1_temp_test_keep';
  process.env.P1_VERIFY_KEEP_INDEX = 'true';

  try {
    await syncSource(deps, 'osm_pois', { mode: 'test-sync' });
    assert.equal(createdIndex, 'pelias_p1_temp_test_keep');
    assert.equal(deletedIndex, null);
  } finally {
    delete process.env.P1_ENABLED;
    delete process.env.P1_VERIFY_INDEX;
    delete process.env.P1_VERIFY_KEEP_INDEX;
  }
});

test('syncSource: SYNC_LIMIT_PER_SOURCE env variable and source test_limit applies to PostGIS query', async () => {
  let receivedLimit = null;
  const { deps } = makeDeps([{ id: 'postgis:osm_pois:1' }], [], {
    postgisReader: {
      async *streamSource(source, limit) {
        receivedLimit = limit;
        yield { id: 'postgis:osm_pois:1' };
      }
    }
  });

  process.env.SYNC_LIMIT_PER_SOURCE = '50';
  try {
    await syncSource(deps, 'osm_pois', { mode: 'test-sync' });
    assert.equal(receivedLimit, 50);
  } finally {
    delete process.env.SYNC_LIMIT_PER_SOURCE;
  }

  deps.config.sources[0].test_limit = 25;
  await syncSource(deps, 'osm_pois', { mode: 'test-sync' });
  assert.equal(receivedLimit, 25);
});

test('syncSource: P1 stats are logged upon sync completion when routable point enrichment is enabled', async () => {
  const loggedMessages = [];
  const loggedMetas = [];
  const { deps } = makeDeps([{ id: 'postgis:osm_pois:1' }], [], {
    log: {
      info(msg, meta) {
        loggedMessages.push(msg);
        loggedMetas.push(meta);
      },
      warn() {},
      error() {}
    },
    routablePointLookup: {
      enabled: true,
      initStats() {
        this.stats = {
          snapped_count: 5,
          fallback_count: 2,
          not_applicable_count: 1,
          snap_failed_count: 0,
          distances: [1.2, 3.4],
          query_durations: [15, 20]
        };
      },
      getStats() {
        return this.stats;
      }
    }
  });

  await syncSource(deps, 'osm_pois', { mode: 'test-sync' });

  const statsLogIndex = loggedMessages.indexOf('P1 Routable Point Enrichment Stats');
  assert.ok(statsLogIndex >= 0);
  const meta = loggedMetas[statsLogIndex];
  assert.equal(meta.source, 'osm_pois');
  assert.equal(meta.snapped_count, 5);
  assert.equal(meta.fallback_count, 2);
  assert.equal(meta.not_applicable_count, 1);
  assert.equal(meta.snap_failed_count, 0);
  assert.equal(meta.avg_distance_meters, 2.3);
  assert.equal(meta.max_distance_meters, 3.4);
  assert.equal(meta.snap_query_p95_ms, 20);
});

test('syncSource: verification disabled mode does not output P1 stats or create temp index', async () => {
  const loggedMessages = [];
  const { deps } = makeDeps([{ id: 'postgis:osm_pois:1' }], [], {
    log: {
      info(msg) { loggedMessages.push(msg); },
      warn() {},
      error() {}
    },
    routablePointLookup: {
      enabled: false
    }
  });

  await syncSource(deps, 'osm_pois', { mode: 'test-sync' });

  assert.ok(!loggedMessages.includes('P1 Routable Point Enrichment Stats'));
});

test('syncSource: preflight fail fast if GiST index is missing', async () => {
  const { deps } = makeDeps([{ id: 'postgis:osm_pois:1' }], [], {
    routablePointLookup: {
      enabled: true,
      gistIndexExists: false
    }
  });

  await assert.rejects(
    () => syncSource(deps, 'osm_pois', { mode: 'test-sync' }),
    err => err.message === 'missing_required_spatial_index'
  );
});

test('syncSource: handles query timeout and uses center fallback', async () => {
  const { deps } = makeDeps([{ id: 'postgis:osm_pois:1', lon: 44.36, lat: 33.31 }]);
  
  const mockLookup = {
    enabled: true,
    roadsSource: { name: 'streets', geometry_field: 'way', sql: 'SELECT way FROM planet_osm_line' },
    options: {
      batch_size: 100,
      fallback_to_center: true,
      query_timeout_ms: 1000
    },
    initStats() {
      this.stats = {
        snapped_count: 0,
        fallback_count: 0,
        not_applicable_count: 0,
        snap_failed_count: 0,
        distances: [],
        query_durations: []
      };
    },
    getStats() {
      return this.stats;
    },
    async enrichBatch(docs, source) {
      const err = new Error('canceling statement due to statement timeout');
      err.code = '57014';
      
      const stats = this.stats;
      stats.snap_failed_count += docs.length;
      
      for (const doc of docs) {
        doc.routable_point = { lat: Number(doc.lat), lon: Number(doc.lon) };
        doc.routable_point_type = 'centroid_fallback';
        doc.routable_point_status = 'centroid_fallback';
        doc.routable_point_source = 'center_point';
        doc.routable_point_reason = 'statement_timeout';
      }
      return docs;
    }
  };
  
  const depsWithLookup = {
    ...deps,
    routablePointLookup: mockLookup
  };

  await syncSource(depsWithLookup, 'osm_pois', { mode: 'test-sync' });
  
  assert.equal(mockLookup.stats.snap_failed_count, 1);
});

test('verify:enrichment: verify() refuses production write_alias by default', async () => {
  const { verify } = require('../src/verify-enrichment');
  const oldConfigPath = process.env.SYNC_CONFIG_PATH;
  const oldVerifyIndex = process.env.P1_VERIFY_INDEX;
  const oldAllowAlias = process.env.P1_VERIFY_ALLOW_WRITE_ALIAS;

  process.env.SYNC_CONFIG_PATH = 'c:/TavrixMap/TavrixMapGeocoder/config/pelias-postgis-readonly-sync.json';
  process.env.P1_VERIFY_INDEX = 'pelias_write';
  process.env.P1_VERIFY_ALLOW_WRITE_ALIAS = 'false';

  try {
    await assert.rejects(
      () => verify(),
      err => err.message.includes('Safety Error: Verification target index')
    );
  } finally {
    if (oldConfigPath !== undefined) process.env.SYNC_CONFIG_PATH = oldConfigPath;
    else delete process.env.SYNC_CONFIG_PATH;

    if (oldVerifyIndex !== undefined) process.env.P1_VERIFY_INDEX = oldVerifyIndex;
    else delete process.env.P1_VERIFY_INDEX;

    if (oldAllowAlias !== undefined) process.env.P1_VERIFY_ALLOW_WRITE_ALIAS = oldAllowAlias;
    else delete process.env.P1_VERIFY_ALLOW_WRITE_ALIAS;
  }
});

test('syncSource: reindex mode with P1 enabled does not use verification temp index', async () => {
  const { deps, calls } = makeDeps([{ id: 'postgis:osm_pois:1' }], [], {
    indexManager: {
      async indexExists() { return false; },
      async createGenericIndex() { throw new Error('Should not create temp index in reindex mode'); },
      async ensureExtendedMappings() {}
    }
  });

  process.env.P1_ENABLED = 'true';
  process.env.P1_VERIFY_INDEX = 'pelias_p1_temp_test';

  try {
    await syncSource(deps, 'osm_pois', { mode: 'blue-green-reindex' });
    assert.deepEqual(calls.targets, []);
  } finally {
    delete process.env.P1_ENABLED;
    delete process.env.P1_VERIFY_INDEX;
  }
});

test('reindexPreflight: prints stats correctly', async () => {
  const printed = [];
  const originalLog = console.log;
  console.log = (...args) => printed.push(args.join(' '));

  const mockApp = {
    indexManager: {
      async aliasTargets(aliasName) {
        return [aliasName + '_target'];
      },
      async nextVersionIndexName() {
        return 'pelias_v4';
      }
    },
    routablePointLookup: {
      enabled: true,
      roadsSrid: 4326,
      gistIndexExists: true,
      options: {
        batch_size: 50,
        max_snap_distance_meters: 30
      }
    }
  };

  try {
    const { reindexPreflight } = require('../src/index');
    await reindexPreflight(mockApp, {
      elasticsearch: {
        read_alias: 'pelias',
        write_alias: 'pelias_write'
      }
    }, { info() {}, warn() {}, error() {} });

    const output = printed.join('\n');
    assert.ok(output.includes('Target Index (Next Version): pelias_v4'));
    assert.ok(output.includes('pelias -> ["pelias_target"]'));
    assert.ok(output.includes('pelias_write -> ["pelias_write_target"]'));
    assert.ok(output.includes('P1 Enabled: true'));
    assert.ok(output.includes('Road SRID: 4326'));
    assert.ok(output.includes('GiST Index Exists: true'));
    assert.ok(output.includes('Batch Size: 50'));
    assert.ok(output.includes('Max Snap Distance Meters: 30'));
  } finally {
    console.log = originalLog;
  }
});




