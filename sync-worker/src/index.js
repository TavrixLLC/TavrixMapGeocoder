'use strict';

require('dotenv').config();

const { Client: EsClient } = require('@elastic/elasticsearch');
const { loadConfig } = require('./config-validator');
const Logger = require('./logger');
const Metrics = require('./metrics');
const PostgisReader = require('./postgis-reader');
const Transform = require('./transform');
const Enrichment = require('./enrichment');
const EsWriter = require('./es-writer');
const IndexManager = require('./index-manager');
const StateStore = require('./state-store');
const HealthServer = require('./health-server');
const Scheduler = require('./scheduler');

async function main() {
  const command = process.argv[2] || 'schedule';
  const arg = process.argv[3];
  const log = new Logger();
  const config = loadConfig(process.env.SYNC_CONFIG_PATH);
  config.elasticsearch.url = process.env.ELASTICSEARCH_URL || config.elasticsearch.url;

  if (command === 'health') {
    await healthCheck(config, log);
    return;
  }

  const app = await createApp(config, log);

  try {
    if (command === 'schedule') {
      await app.indexManager.ensureAliases();
      app.healthServer.start();
      const scheduler = new Scheduler(app.syncService, app.metrics, log);
      scheduler.start(config.sources);

      log.info('Read-only sync worker started in scheduled mode');
      await waitForever(async signal => {
        log.info('Shutdown requested', { signal });
        scheduler.stop();
        await app.shutdown();
      });
      return;
    }

    await app.indexManager.ensureAliases();

    if (command === 'sync:all') {
      await app.syncService.syncAll({ mode: 'manual' });
    } else if (command === 'sync:source') {
      requiredArg(arg, 'source name');
      await app.syncService.syncSource(arg, { mode: 'manual' });
    } else if (command === 'reindex:all') {
      await app.syncService.reindexAll();
    } else if (command === 'reindex:source') {
      requiredArg(arg, 'source name');
      await app.syncService.syncSource(arg, { mode: 'source-reindex', forceDeleteDiff: true });
    } else {
      throw new Error(`Unknown command: ${command}`);
    }
  } finally {
    await app.shutdown();
  }
}

async function createApp(config, log) {
  const metrics = new Metrics();
  const postgisReader = new PostgisReader(config, log);
  const esClient = new EsClient({
    node: config.elasticsearch.url,
    requestTimeout: config.elasticsearch.request_timeout_ms
  });
  const indexManager = new IndexManager(esClient, config, metrics, log);
  const stateStore = new StateStore(config, log);
  const transform = new Transform(config, log);
  const enrichment = new Enrichment(config);
  const esWriter = new EsWriter(esClient, config, metrics, log);

  await stateStore.load();

  const syncService = {
    syncAll: opts => syncAll({ config, postgisReader, transform, enrichment, esWriter, stateStore, metrics, log }, opts),
    syncSource: (name, opts) => syncSource({ config, postgisReader, transform, enrichment, esWriter, stateStore, metrics, log }, name, opts),
    reindexAll: () => reindexAll({ config, postgisReader, transform, enrichment, esWriter, stateStore, metrics, indexManager, log })
  };

  const healthServer = new HealthServer({
    config,
    metrics,
    postgisReader,
    esClient,
    indexManager,
    stateStore,
    syncService,
    logger: log
  });
  let closed = false;

  return {
    metrics,
    postgisReader,
    esClient,
    indexManager,
    stateStore,
    syncService,
    healthServer,
    shutdown: async () => {
      if (closed) return;
      closed = true;
      await healthServer.stop();
      await postgisReader.close();
      await esClient.close();
    }
  };
}

async function syncAll(deps, opts = {}) {
  const totals = { indexed: 0, failed: 0, deleted: 0 };
  for (const source of deps.config.sources.filter(src => src.enabled !== false)) {
    const result = await syncSource(deps, source.name, opts);
    totals.indexed += result.indexed || 0;
    totals.failed += result.failed || 0;
    totals.deleted += result.deleted || 0;
  }
  return totals;
}

async function reindexAll(deps) {
  const targetIndex = await deps.indexManager.createNextVersionIndex();
  const previousTarget = deps.esWriter.targetIndex;
  deps.esWriter.setTargetIndex(targetIndex);

  try {
    const result = await syncAll(deps, {
      mode: 'blue-green-reindex',
      skipDeleteDiff: true
    });
    await deps.indexManager.switchAliases(targetIndex);
    await deps.stateStore.setIndexVersion(targetIndex);
    return result;
  } finally {
    deps.esWriter.setTargetIndex(previousTarget);
  }
}

async function syncSource(deps, sourceName, opts = {}) {
  const source = deps.config.sources.find(item => item.name === sourceName);
  if (!source) throw new Error(`Unknown source: ${sourceName}`);
  if (source.enabled === false) throw new Error(`Source is disabled: ${sourceName}`);

  const started = Date.now();
  const seenIds = new Set();
  let indexed = 0;
  let failed = 0;
  let deleted = 0;
  let read = 0;
  let batch = [];
  const mode = opts.mode || 'manual';
  const dryRun = deps.config.worker.dry_run || process.env.DRY_RUN === '1';

  deps.log.info('Starting source sync', { source: source.name, mode, dryRun });
  await deps.stateStore.markStart(source.name);

  try {
    const queryStarted = Date.now();
    for await (const row of deps.postgisReader.streamSource(source)) {
      read += 1;
      deps.metrics.rowsRead.labels(source.name).inc();

      try {
        const doc = deps.enrichment.enrich(deps.transform.toDomainDoc(source, row));
        seenIds.add(doc.id);
        batch.push(doc);
      } catch (err) {
        failed += 1;
        deps.metrics.docsFailed.labels(source.name).inc();
        deps.log.warn('Row skipped during transform', {
          source: source.name,
          error: err.message
        });
      }

      const batchSize = source.batch_size || deps.config.elasticsearch.max_bulk_docs;
      if (batch.length >= batchSize) {
        const result = await flushBatch(deps, source.name, batch, dryRun);
        indexed += result.indexed;
        failed += result.failed;
        batch = [];
      }
    }
    deps.metrics.postgisQueryDuration.labels(source.name).observe(Date.now() - queryStarted);

    if (batch.length > 0) {
      const result = await flushBatch(deps, source.name, batch, dryRun);
      indexed += result.indexed;
      failed += result.failed;
    }

    const shouldDiffDeletes = !dryRun
      && !opts.skipDeleteDiff
      && (opts.forceDeleteDiff || source.delete_strategy === 'source_diff');
    if (shouldDiffDeletes) {
      const previousIds = deps.stateStore.previousIds(source.name);
      const missing = [...previousIds].filter(id => !seenIds.has(id));
      if (missing.length > 0) {
        const result = await deps.esWriter.deleteIds(source.name, missing);
        deleted = result.deleted;
        failed += result.failed;
        deps.metrics.docsDeleted.labels(source.name).inc(deleted);
        deps.metrics.docsFailed.labels(source.name).inc(result.failed);
      }
    }

    const durationSeconds = (Date.now() - started) / 1000;
    deps.metrics.duration.labels(source.name, mode).observe(durationSeconds);
    deps.metrics.markLastSuccess(source.name);
    await deps.stateStore.markSuccess(source.name, { indexed, failed, deleted, durationSeconds }, seenIds);

    deps.log.info('Source sync finished', {
      source: source.name,
      read,
      indexed,
      deleted,
      failed,
      duration_seconds: durationSeconds
    });
    return { indexed, failed, deleted, read, durationSeconds };
  } catch (err) {
    deps.metrics.markLastError(source.name, err);
    await deps.stateStore.markFailure(source.name, err);
    deps.log.error('Source sync failed', {
      source: source.name,
      error: err.message,
      stack: err.stack
    });
    throw err;
  }
}

async function flushBatch(deps, sourceName, batch, dryRun) {
  if (dryRun) {
    deps.log.info('Dry run batch transformed', { source: sourceName, count: batch.length });
    return { indexed: batch.length, failed: 0 };
  }

  const result = await deps.esWriter.indexDocuments(sourceName, batch);
  deps.metrics.docsIndexed.labels(sourceName).inc(result.indexed);
  deps.metrics.docsFailed.labels(sourceName).inc(result.failed);
  return result;
}

async function healthCheck(config, log) {
  const app = await createApp(config, log);
  try {
    await app.postgisReader.ping();
    await app.esClient.ping();
    await app.indexManager.currentWriteTarget();
    log.info('Health check passed');
  } finally {
    await app.shutdown();
  }
}

function requiredArg(value, description) {
  if (!value) {
    throw new Error(`Missing required ${description}`);
  }
}

function waitForever(onShutdown) {
  return new Promise(resolve => {
    let shuttingDown = false;
    const handler = signal => {
      if (shuttingDown) return;
      shuttingDown = true;
      Promise.resolve(onShutdown(signal))
        .catch(err => console.error(err))
        .finally(resolve);
    };
    process.on('SIGINT', () => handler('SIGINT'));
    process.on('SIGTERM', () => handler('SIGTERM'));
  });
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
