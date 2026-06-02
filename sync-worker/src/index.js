'use strict';

require('dotenv').config();

const { Client: EsClient } = require('@elastic/elasticsearch');
const { loadConfig } = require('./config-validator');
const Logger = require('./logger');
const Metrics = require('./metrics');
const PostgisReader = require('./postgis-reader');
const Transform = require('./transform');
const Enrichment = require('./enrichment');
const AdminLookup = require('./admin-lookup');
const EsWriter = require('./es-writer');
const IndexManager = require('./index-manager');
const StateStore = require('./state-store');
const { migrateJsonToSqlite } = require('./state-store');
const HealthServer = require('./health-server');
const Scheduler = require('./scheduler');

class SourceCountDropError extends Error {
  constructor(sourceName, previousCount, currentCount, maxDropRatio) {
    const dropRatio = previousCount === 0 ? 0 : (previousCount - currentCount) / previousCount;
    super(`Source ${sourceName} document count dropped unexpectedly: previous=${previousCount}, current=${currentCount}, drop_ratio=${dropRatio.toFixed(4)}, max_drop_ratio=${maxDropRatio}`);
    this.name = 'SourceCountDropError';
    this.code = 'unexpected_source_drop';
    this.details = {
      source: sourceName,
      previous_count: previousCount,
      current_count: currentCount,
      drop_ratio: dropRatio,
      max_drop_ratio: maxDropRatio
    };
  }
}

class ReindexValidationError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'ReindexValidationError';
    this.code = code;
    this.details = details;
  }
}

class AliasRollbackError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'AliasRollbackError';
    this.code = code;
    this.details = details;
  }
}

class SourceFailureToleranceError extends Error {
  constructor(sourceName, readCount, failedCount, maxFailedRatio, failureSamples = []) {
    const failedRatio = readCount === 0 ? (failedCount > 0 ? 1 : 0) : failedCount / readCount;
    super(`Source ${sourceName} failed too many records: read=${readCount}, failed=${failedCount}, failed_ratio=${failedRatio.toFixed(4)}, max_failed_ratio=${maxFailedRatio}`);
    this.name = 'SourceFailureToleranceError';
    this.code = 'source_failed_too_many_records';
    this.details = {
      source: sourceName,
      read_count: readCount,
      failed_count: failedCount,
      failed_ratio: failedRatio,
      max_failed_ratio: maxFailedRatio,
      failure_samples: failureSamples
    };
  }
}

async function main() {
  const command = process.argv[2] || 'schedule';
  const commandOptions = parseCommandArgs(process.argv.slice(3));
  const arg = commandOptions.target;
  const log = new Logger();
  const config = loadConfig(process.env.SYNC_CONFIG_PATH);
  config.elasticsearch.url = process.env.ELASTICSEARCH_URL || config.elasticsearch.url;

  if (command === 'health') {
    await healthCheck(config, log);
    return;
  }

  if (command === 'state:migrate-json-to-sqlite') {
    const result = await migrateJsonToSqlite(config, log);
    log.info('State migration finished', result);
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

    if (command !== 'rollback:aliases') {
      await app.indexManager.ensureAliases();
    }

    if (command === 'sync:all') {
      await app.syncService.syncAll({ mode: 'manual' });
    } else if (command === 'sync:source') {
      requiredArg(arg, 'source name');
      await app.syncService.syncSource(arg, { mode: 'manual' });
    } else if (command === 'reindex:all') {
      await app.syncService.reindexAll();
    } else if (command === 'rollback:aliases') {
      const result = await app.syncService.rollbackAliases(arg, { dryRun: commandOptions.dryRun });
      console.log(JSON.stringify(result, null, 2));
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
  const adminLookup = new AdminLookup(config, postgisReader, log);
  const esWriter = new EsWriter(esClient, config, metrics, log);

  await stateStore.load();

  const syncService = {
    syncAll: opts => syncAll({ config, postgisReader, transform, enrichment, adminLookup, esWriter, stateStore, metrics, log }, opts),
    syncSource: (name, opts) => syncSource({ config, postgisReader, transform, enrichment, adminLookup, esWriter, stateStore, metrics, log }, name, opts),
    reindexAll: () => reindexAll({ config, postgisReader, transform, enrichment, adminLookup, esWriter, stateStore, metrics, indexManager, esClient, log }),
    rollbackAliases: (targetIndex, opts) => rollbackAliases({ config, stateStore, metrics, indexManager, esClient, log }, targetIndex, opts)
  };

  const healthServer = new HealthServer({
    config,
    metrics,
    postgisReader,
    adminLookup,
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
      if (typeof stateStore.close === 'function') await stateStore.close();
      await postgisReader.close();
      await esClient.close();
    }
  };
}

async function syncAll(deps, opts = {}) {
  const totals = { indexed: 0, unique_indexed: 0, failed: 0, deleted: 0, read: 0 };
  for (const source of deps.config.sources.filter(src => src.enabled !== false)) {
    const result = await syncSource(deps, source.name, opts);
    totals.indexed += result.indexed || 0;
    totals.unique_indexed += result.unique_indexed == null ? (result.indexed || 0) : result.unique_indexed;
    totals.failed += result.failed || 0;
    totals.deleted += result.deleted || 0;
    totals.read += result.read || 0;
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
    const validation = await validateReindexTarget(deps, targetIndex, result);
    deps.log.info('Blue/green reindex validation passed', {
      index: targetIndex,
      document_count: validation.document_count,
      sample_hits: validation.sample_hits
    });
    const switchResult = await deps.indexManager.switchAliases(targetIndex);
    await deps.stateStore.setIndexVersion(targetIndex);
    await recordAliasSwitch(deps, {
      type: 'blue_green_reindex',
      target_index: targetIndex,
      switchResult,
      previousAliases: validation.aliases,
      validation
    });
    return { ...result, validation };
  } finally {
    deps.esWriter.setTargetIndex(previousTarget);
  }
}

async function rollbackAliases(deps, targetIndexArg, opts = {}) {
  const dryRun = Boolean(opts.dryRun);
  const selected = targetIndexArg
    ? { targetIndex: String(targetIndexArg).trim(), inferred: false, skipped_candidates: [] }
    : await selectRollbackTarget(deps);
  const targetIndex = String(selected.targetIndex || '').trim();
  if (!targetIndex) {
    throw new AliasRollbackError('no_valid_rollback_target', 'No valid rollback target exists in alias history', {
      skipped_candidates: selected.skipped_candidates || []
    });
  }

  const run = deps.stateStore && deps.stateStore.startRun
    ? await deps.stateStore.startRun({ source: 'aliases', mode: 'rollback' })
    : null;

  try {
    const validation = await validateRollbackTarget(deps, targetIndex);
    deps.log.info('Alias rollback validation passed', {
      index: targetIndex,
      document_count: validation.document_count,
      sample_hits: validation.sample_hits
    });

    if (dryRun) {
      deps.log.info('Alias rollback dry run passed; aliases were not switched', {
        index: targetIndex,
        document_count: validation.document_count,
        sample_hits: validation.sample_hits
      });
      if (run && deps.stateStore.finishRun) {
        await deps.stateStore.finishRun(run.run_id, 'success', { indexed: 0, failed: 0, deleted: 0 });
      }
      return {
        dry_run: true,
        target_index: targetIndex,
        inferred: Boolean(selected.inferred),
        skipped_candidates: selected.skipped_candidates || [],
        validation,
        history: null
      };
    }

    const switchResult = await deps.indexManager.switchAliases(targetIndex);
    if (deps.stateStore && deps.stateStore.setIndexVersion) {
      await deps.stateStore.setIndexVersion(targetIndex);
    }
    const history = await recordAliasSwitch(deps, {
      type: 'rollback',
      target_index: targetIndex,
      switchResult,
      previousAliases: validation.current_aliases,
      validation
    });

    if (run && deps.stateStore.finishRun) {
      await deps.stateStore.finishRun(run.run_id, 'success', { indexed: 0, failed: 0, deleted: 0 });
    }

    return {
      dry_run: false,
      target_index: targetIndex,
      inferred: Boolean(selected.inferred),
      skipped_candidates: selected.skipped_candidates || [],
      validation,
      history
    };
  } catch (err) {
    if (run && deps.stateStore && deps.stateStore.finishRun) {
      await deps.stateStore.finishRun(run.run_id, 'failed', { indexed: 0, failed: 1, deleted: 0 }, err);
    }
    throw err;
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
  const failureSamples = [];
  const mode = opts.mode || 'manual';
  const dryRun = deps.config.worker.dry_run || process.env.DRY_RUN === '1';
  const maxFailureSamples = Number(deps.config.worker.max_failure_samples || 20);

  deps.log.info('Starting source sync', { source: source.name, mode, dryRun });
  await deps.stateStore.markStart(source.name);

  try {
    const queryStarted = Date.now();
    for await (const row of deps.postgisReader.streamSource(source)) {
      read += 1;
      deps.metrics.rowsRead.labels(source.name).inc();

      try {
        const doc = deps.transform.toDomainDoc(source, row);
        seenIds.add(doc.id);
        batch.push(doc);
      } catch (err) {
        failed += 1;
        deps.metrics.docsFailed.labels(source.name).inc();
        collectFailureSamples(failureSamples, [{
          stage: 'transform',
          id: valueFromRow(row, source.id_field),
          error: err.message,
          row: sanitizeRow(row)
        }], maxFailureSamples);
        deps.log.warn('Row skipped during transform', {
          source: source.name,
          error: err.message,
          row_sample: sanitizeRow(row)
        });
      }

      const batchSize = source.batch_size || deps.config.elasticsearch.max_bulk_docs;
      if (batch.length >= batchSize) {
        const result = await flushBatch(deps, source, batch, dryRun);
        indexed += result.indexed;
        failed += result.failed;
        collectFailureSamples(failureSamples, result.failedSamples, maxFailureSamples);
        batch = [];
      }
    }
    deps.metrics.postgisQueryDuration.labels(source.name).observe(Date.now() - queryStarted);

    if (batch.length > 0) {
      const result = await flushBatch(deps, source, batch, dryRun);
      indexed += result.indexed;
      failed += result.failed;
      collectFailureSamples(failureSamples, result.failedSamples, maxFailureSamples);
    }

    validateFailureTolerance(source, read, failed, deps.config.worker, failureSamples, opts);

    const previousIds = deps.stateStore.previousIds(source.name);
    validateSourceCountDrop(source, previousIds.size, seenIds.size, deps.config.worker, opts);

    const shouldDiffDeletes = !dryRun
      && !opts.skipDeleteDiff
      && (opts.forceDeleteDiff || source.delete_strategy === 'source_diff');
    if (shouldDiffDeletes) {
      const missing = [...previousIds].filter(id => !seenIds.has(id));
      if (missing.length > 0) {
        const result = await deps.esWriter.deleteIds(source.name, missing);
        deleted = result.deleted;
        failed += result.failed;
        collectFailureSamples(failureSamples, result.failedSamples, maxFailureSamples);
        deps.metrics.docsDeleted.labels(source.name).inc(deleted);
        deps.metrics.docsFailed.labels(source.name).inc(result.failed);
      }
    }

    const durationSeconds = (Date.now() - started) / 1000;
    deps.metrics.duration.labels(source.name, mode).observe(durationSeconds);
    deps.metrics.markLastSuccess(source.name);
    const failedSamplePath = await deps.stateStore.writeFailureSamples(source.name, failureSamples);
    await deps.stateStore.markSuccess(
      source.name,
      { indexed, failed, deleted, read, durationSeconds },
      seenIds,
      { failedSamplePath, failureSamples }
    );

    deps.log.info('Source sync finished', {
      source: source.name,
      read,
      indexed,
      deleted,
      failed,
      duration_seconds: durationSeconds
    });
    return { indexed, unique_indexed: seenIds.size, failed, deleted, read, durationSeconds };
  } catch (err) {
    if (err.details && Array.isArray(err.details.failure_samples)) {
      const failedSamplePath = await deps.stateStore.writeFailureSamples(source.name, err.details.failure_samples);
      err.details.failed_sample_path = failedSamplePath;
    }
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

async function flushBatch(deps, source, batch, dryRun) {
  if (dryRun) {
    deps.log.info('Dry run batch transformed', { source: source.name, count: batch.length });
    return { indexed: batch.length, failed: 0 };
  }

  if (deps.adminLookup && deps.adminLookup.enrichBatch) {
    await deps.adminLookup.enrichBatch(batch, source);
  }

  const enriched = batch.map(doc => deps.enrichment.enrich(doc));
  const result = await deps.esWriter.indexDocuments(source.name, enriched);
  deps.metrics.docsIndexed.labels(source.name).inc(result.indexed);
  deps.metrics.docsFailed.labels(source.name).inc(result.failed);
  return result;
}

function validateSourceCountDrop(source, previousCount, currentCount, workerConfig = {}, opts = {}) {
  if (opts.skipSourceDropCheck || source.allow_count_drop === true) {
    return { ok: true, skipped: true };
  }

  const minPrevious = Number(source.drop_check_min_previous_count
    ?? workerConfig.source_drop_min_previous_count
    ?? 100);
  const maxDropRatio = Number(source.max_drop_ratio
    ?? workerConfig.source_drop_max_ratio
    ?? 0.5);

  if (!Number.isFinite(previousCount) || previousCount < minPrevious) {
    return { ok: true, skipped: true, reason: 'insufficient_previous_count' };
  }

  if (!Number.isFinite(currentCount)) {
    throw new SourceCountDropError(source.name, previousCount, 0, maxDropRatio);
  }

  const dropRatio = previousCount === 0 ? 0 : (previousCount - currentCount) / previousCount;
  if (dropRatio > maxDropRatio) {
    throw new SourceCountDropError(source.name, previousCount, currentCount, maxDropRatio);
  }

  return { ok: true, previousCount, currentCount, dropRatio };
}

function validateFailureTolerance(source, readCount, failedCount, workerConfig = {}, failureSamples = [], opts = {}) {
  if (opts.skipFailureToleranceCheck || failedCount === 0) {
    return { ok: true, failedRatio: 0 };
  }

  const maxFailedRatio = Number(source.max_failed_ratio
    ?? workerConfig.source_max_failed_ratio
    ?? 0.01);
  const failedRatio = readCount === 0 ? 1 : failedCount / readCount;
  if (failedRatio > maxFailedRatio) {
    throw new SourceFailureToleranceError(source.name, readCount, failedCount, maxFailedRatio, failureSamples);
  }

  return { ok: true, failedRatio, maxFailedRatio };
}

async function validateReindexTarget(deps, targetIndex, result = {}) {
  if (deps.indexManager.indexExists && !(await deps.indexManager.indexExists(targetIndex))) {
    throw new ReindexValidationError('reindex_target_missing', `Reindex target index does not exist: ${targetIndex}`, {
      index: targetIndex
    });
  }

  const aliases = {};
  if (deps.indexManager.aliasTargets) {
    for (const alias of [deps.config.elasticsearch.read_alias, deps.config.elasticsearch.write_alias]) {
      if (!alias) continue;
      const targets = await deps.indexManager.aliasTargets(alias);
      aliases[alias] = targets;
      if (!Array.isArray(targets) || targets.length === 0) {
        throw new ReindexValidationError('alias_missing', `Required Elasticsearch alias is missing: ${alias}`, {
          alias,
          index: targetIndex
        });
      }
    }
  }

  const esClient = deps.esClient || deps.indexManager.es;
  if (!esClient || typeof esClient.count !== 'function' || typeof esClient.search !== 'function') {
    throw new ReindexValidationError('elasticsearch_validation_unavailable', 'Elasticsearch count/search client is unavailable for reindex validation', {
      index: targetIndex
    });
  }

  const countResponse = await esClient.count({ index: targetIndex });
  const countBody = responseBody(countResponse);
  const documentCount = Number(countBody.count || 0);
  if (!Number.isFinite(documentCount) || documentCount <= 0) {
    throw new ReindexValidationError('empty_reindex_target', `Reindex target index is empty: ${targetIndex}`, {
      index: targetIndex,
      document_count: documentCount
    });
  }

  const expectedIndexedCount = result.unique_indexed == null ? result.indexed : result.unique_indexed;
  const expectedMinCount = Math.max(1, Number(expectedIndexedCount || 0) - Number(result.failed || 0));
  if (documentCount < expectedMinCount) {
    throw new ReindexValidationError('reindex_document_count_mismatch', `Reindex target has fewer documents than the run indexed: ${targetIndex}`, {
      index: targetIndex,
      document_count: documentCount,
      expected_min_count: expectedMinCount,
      indexed_operations: Number(result.indexed || 0),
      unique_indexed: Number(result.unique_indexed || 0)
    });
  }

  const sampleQuery = buildReindexSampleQuery(deps.config.worker);
  const sampleResponse = await esClient.search({
    index: targetIndex,
    body: {
      size: 1,
      track_total_hits: false,
      _source: false,
      query: sampleQuery
    }
  });
  const hits = (((responseBody(sampleResponse).hits || {}).hits) || []);
  if (hits.length === 0) {
    throw new ReindexValidationError('reindex_sample_search_empty', `Reindex target returned no sample search hits: ${targetIndex}`, {
      index: targetIndex,
      sample_query: sampleQuery
    });
  }

  return {
    aliases,
    document_count: documentCount,
    sample_hits: hits.length,
    sample_query: sampleQuery
  };
}

async function selectRollbackTarget(deps) {
  const candidates = await rollbackTargetCandidates(deps);
  const skipped = [];

  for (const targetIndex of candidates) {
    try {
      const validation = await validateRollbackTarget(deps, targetIndex);
      return {
        targetIndex,
        inferred: true,
        validation,
        skipped_candidates: skipped
      };
    } catch (err) {
      skipped.push({
        target_index: targetIndex,
        code: err.code || 'rollback_target_validation_failed',
        message: err.message || String(err)
      });
    }
  }

  throw new AliasRollbackError('no_valid_rollback_target', 'No valid rollback target exists in alias history', {
    candidates,
    skipped_candidates: skipped
  });
}

async function rollbackTargetCandidates(deps) {
  if (!deps.stateStore) return [];

  let history = [];
  if (typeof deps.stateStore.aliasSwitches === 'function') {
    history = await deps.stateStore.aliasSwitches();
  } else if (typeof deps.stateStore.latestAliasSwitch === 'function') {
    const latest = await deps.stateStore.latestAliasSwitch({ status: 'success' });
    history = latest ? [latest] : [];
  }

  const candidates = [];
  const seen = new Set();
  for (const entry of history || []) {
    if (!entry || entry.status !== 'success') continue;
    for (const indexName of [entry.previous_read_index, entry.previous_write_index]) {
      const candidate = String(indexName || '').trim();
      if (!candidate || seen.has(candidate)) continue;
      seen.add(candidate);
      candidates.push(candidate);
    }
  }
  return candidates;
}

async function validateRollbackTarget(deps, targetIndex) {
  const readAlias = deps.config.elasticsearch.read_alias;
  const writeAlias = deps.config.elasticsearch.write_alias;
  const currentAliases = {};

  if (!deps.indexManager.aliasTargets) {
    throw new AliasRollbackError('rollback_alias_resolution_unavailable', 'Alias target resolver is unavailable for rollback safety checks', {
      index: targetIndex,
      read_alias: readAlias,
      write_alias: writeAlias
    });
  }

  for (const alias of [readAlias, writeAlias]) {
    if (!alias) continue;
    currentAliases[alias] = await deps.indexManager.aliasTargets(alias);
    if (!Array.isArray(currentAliases[alias]) || currentAliases[alias].length === 0) {
      throw new AliasRollbackError('rollback_alias_unresolved', `Rollback safety check could not resolve alias: ${alias}`, {
        index: targetIndex,
        alias,
        current_aliases: currentAliases
      });
    }
  }

  const currentReadTargets = currentAliases[readAlias] || [];
  const currentWriteTargets = currentAliases[writeAlias] || [];
  if (currentReadTargets.includes(targetIndex) && currentWriteTargets.includes(targetIndex)) {
    throw new AliasRollbackError('rollback_target_already_current', `Rollback target is already current for both aliases: ${targetIndex}`, {
      index: targetIndex,
      current_aliases: currentAliases
    });
  }

  if (deps.indexManager.indexExists && !(await deps.indexManager.indexExists(targetIndex))) {
    throw new AliasRollbackError('rollback_target_missing', `Rollback target index does not exist: ${targetIndex}`, {
      index: targetIndex,
      current_aliases: currentAliases
    });
  }

  const esClient = deps.esClient || deps.indexManager.es;
  if (!esClient || typeof esClient.count !== 'function' || typeof esClient.search !== 'function') {
    throw new AliasRollbackError('elasticsearch_validation_unavailable', 'Elasticsearch count/search client is unavailable for alias rollback validation', {
      index: targetIndex
    });
  }

  const countResponse = await esClient.count({ index: targetIndex });
  const countBody = responseBody(countResponse);
  const documentCount = Number(countBody.count || 0);
  if (!Number.isFinite(documentCount) || documentCount <= 0) {
    throw new AliasRollbackError('empty_rollback_target', `Rollback target index is empty: ${targetIndex}`, {
      index: targetIndex,
      document_count: documentCount
    });
  }

  const sampleQuery = buildReindexSampleQuery(deps.config.worker);
  const sampleResponse = await esClient.search({
    index: targetIndex,
    body: {
      size: 1,
      track_total_hits: false,
      _source: false,
      query: sampleQuery
    }
  });
  const hits = (((responseBody(sampleResponse).hits || {}).hits) || []);
  if (hits.length === 0) {
    throw new AliasRollbackError('rollback_sample_search_empty', `Rollback target returned no sample search hits: ${targetIndex}`, {
      index: targetIndex,
      sample_query: sampleQuery
    });
  }

  return {
    current_aliases: currentAliases,
    document_count: documentCount,
    sample_hits: hits.length,
    sample_query: sampleQuery,
    safety_checks: {
      aliases_resolved: true,
      target_not_already_current: true,
      target_exists: true,
      target_has_documents: true,
      sample_search_has_hits: true
    }
  };
}

async function recordAliasSwitch(deps, opts) {
  if (!deps.stateStore || typeof deps.stateStore.recordAliasSwitch !== 'function') return null;
  return deps.stateStore.recordAliasSwitch(buildAliasSwitchHistoryEntry(deps, opts));
}

function buildAliasSwitchHistoryEntry(deps, opts = {}) {
  const readAlias = deps.config.elasticsearch.read_alias;
  const writeAlias = deps.config.elasticsearch.write_alias;
  const previousAliases = opts.previousAliases || {};
  const switchResult = opts.switchResult || {};
  const validation = opts.validation || {};
  const previousReadTargets = switchResult.previous_read_targets || previousAliases[readAlias] || [];
  const previousWriteTargets = switchResult.previous_write_targets || previousAliases[writeAlias] || [];

  return {
    type: opts.type,
    read_alias: readAlias,
    write_alias: writeAlias,
    previous_read_index: firstTarget(previousReadTargets),
    previous_write_index: firstTarget(previousWriteTargets),
    target_index: opts.target_index,
    status: 'success',
    details: {
      previous_read_targets: previousReadTargets,
      previous_write_targets: previousWriteTargets,
      document_count: validation.document_count,
      sample_hits: validation.sample_hits,
      sample_query: validation.sample_query
    }
  };
}

function firstTarget(targets) {
  return Array.isArray(targets) && targets.length > 0 ? targets[0] : null;
}

function buildReindexSampleQuery(workerConfig = {}) {
  const sampleText = String(workerConfig.reindex_validation_sample_text || '').trim();
  if (!sampleText) return { match_all: {} };

  return {
    multi_match: {
      query: sampleText,
      fields: [
        'name.default^4',
        'name.en^3',
        'name.ar^3',
        'name.ku^3',
        'name.ckb^3',
        'phrase.default^2'
      ],
      type: 'best_fields'
    }
  };
}

function responseBody(response) {
  return response && response.body ? response.body : response;
}

function parseCommandArgs(args = []) {
  const parsed = {
    target: null,
    dryRun: false
  };

  for (const arg of args) {
    if (arg === '--dry-run') {
      parsed.dryRun = true;
    } else if (!parsed.target) {
      parsed.target = arg;
    } else {
      throw new Error(`Unexpected argument: ${arg}`);
    }
  }

  return parsed;
}

function collectFailureSamples(target, samples = [], limit = 20) {
  if (!Array.isArray(samples)) return;
  for (const sample of samples) {
    if (target.length >= limit) return;
    target.push(sample);
  }
}

function sanitizeRow(row) {
  const out = {};
  for (const [key, value] of Object.entries(row || {})) {
    if (key === 'way' || key === 'tags') continue;
    out[key] = typeof value === 'string' && value.length > 500 ? `${value.slice(0, 500)}...` : value;
  }
  return out;
}

function valueFromRow(row, field) {
  if (!field || !row) return undefined;
  return row[field];
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

if (require.main === module) {
  main().catch(err => {
    console.error(err);
    process.exit(1);
  });
}

module.exports = {
  createApp,
  syncAll,
  syncSource,
  reindexAll,
  rollbackAliases,
  validateSourceCountDrop,
  validateFailureTolerance,
  validateReindexTarget,
  validateRollbackTarget,
  SourceCountDropError,
  ReindexValidationError,
  AliasRollbackError,
  SourceFailureToleranceError
};
