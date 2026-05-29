'use strict';

require('dotenv').config();

const { Pool } = require('pg');
const { Client: EsClient } = require('@elastic/elasticsearch');
const { loadConfig, validateConfig } = require('./config-validator');
const Logger = require('./logger');
const Metrics = require('./metrics');
const Backpressure = require('./backpressure');
const PgListener = require('./pg-listener');
const EventReader = require('./event-reader');
const StateFetcher = require('./state-fetcher');
const Transform = require('./transform');
const Enrichment = require('./enrichment');
const EsWriter = require('./es-writer');
const EsIndexManager = require('./es-index-manager');
const ErrorHandler = require('./error-handler');
const DlqManager = require('./dlq-manager');
const ReplayManager = require('./replay-manager');
const HealthServer = require('./health-server');
const AdminServer = require('./admin-server');

// --- Globals ---
const log = new Logger(process.env.WORKER_ID);
const metrics = new Metrics();
const backpressure = new Backpressure();
let processing = false;
let shutdownRequested = false;

// --- Main ---
async function main() {
  log.info('Starting Pelias PostGIS Sync Worker');

  // 1. Load and validate config
  const config = loadConfig();
  validateConfig(config);
  log.info('Configuration validated successfully');

  // 2. Connect to PostGIS
  const pgConnStr = `postgresql://${process.env.POSTGIS_USER}:${process.env.POSTGIS_PASSWORD}@${process.env.POSTGIS_HOST}:${process.env.POSTGIS_PORT || 5432}/${process.env.POSTGIS_DB}`;
  const pgPool = new Pool({ connectionString: pgConnStr, max: 5 });

  try {
    await pgPool.query('SELECT 1');
    log.info('PostGIS connection established');
    metrics.set('pg_pool_connected', 1);
  } catch (err) {
    log.error('Failed to connect to PostGIS', { error: err.message });
    process.exit(1);
  }

  // 3. Connect to Elasticsearch
  const esHost = config.esclient.hosts[0];
  const esClient = new EsClient({
    node: `http://${esHost.host}:${esHost.port}`,
    requestTimeout: config.esclient.requestTimeout || 30000,
    maxRetries: 3
  });

  try {
    await esClient.ping();
    log.info('Elasticsearch connection established');
    metrics.set('es_connected', 1);
  } catch (err) {
    log.warn('Elasticsearch not ready yet — will retry during processing', { error: err.message });
  }

  // 4. Initialize components
  const sources = config.postgis_sync.sources;
  const eventReader = new EventReader(pgPool, config, log);
  const stateFetcher = new StateFetcher(pgPool, sources, log);
  const transform = new Transform(sources, log);
  const enrichment = new Enrichment(config, log);
  const esWriter = new EsWriter(esClient, config, log);
  const esIndexManager = new EsIndexManager(esClient, config, log);
  const errorHandler = new ErrorHandler(pgPool, log);
  const dlqManager = new DlqManager(pgPool, log);
  const replayManager = new ReplayManager(pgPool, log);

  // 5. Ensure ES aliases
  await esIndexManager.ensureAliases();

  // 6. Start PG LISTEN
  const pgListener = new PgListener(pgConnStr, 'pelias_outbox_event', log);
  pgListener.onNotification = () => {
    if (!processing) {
      processBatch();
    }
  };
  await pgListener.connect();
  metrics.set('pg_listener_connected', pgListener.isHealthy() ? 1 : 0);

  // 7. Start health server
  const healthServer = new HealthServer({
    metrics, pgPool, pgListener, esClient, esIndexManager, logger: log
  });
  healthServer.start();

  // 8. Start admin server
  const adminServer = new AdminServer({
    replayManager, dlqManager, esIndexManager, logger: log
  });
  adminServer.start();

  // 9. Processing loop
  async function processBatch() {
    if (processing || shutdownRequested) return;
    processing = true;

    try {
      // Check backpressure
      if (backpressure.shouldPause()) {
        const pauseMs = backpressure.getPauseMs();
        log.warn('Backpressure active', { pauseMs });
        await sleep(pauseMs);
      }

      const batchStart = Date.now();

      // Step 1: Claim and collapse
      const { collapsed, allEventIds } = await eventReader.claimAndCollapse(sources);

      if (collapsed.length === 0) {
        processing = false;
        return;
      }

      // Step 2: Fetch current state from PostGIS
      const fetchStart = Date.now();
      const fetchedItems = await stateFetcher.fetchCurrentStates(collapsed);
      metrics.set('fetch_state_duration_milliseconds', Date.now() - fetchStart);

      // Step 3: Separate errors from valid items
      const errors = fetchedItems.filter(i => i.action === 'ERROR');
      const valid = fetchedItems.filter(i => i.action !== 'ERROR');

      // Handle fetch errors
      for (const errItem of errors) {
        const errType = errorHandler.classifyError({ message: errItem.error });
        if (errType === 'PERMANENT' || errItem.event.retry_count >= (config.postgis_sync.max_retries - 1)) {
          await errorHandler.sendToDlq(errItem.event, errItem.error, errType);
          metrics.inc('events_sent_to_dlq_total');
        } else {
          await eventReader.markFailed([errItem.event.id], errItem.error);
          metrics.inc('events_failed_total');
        }
      }

      if (valid.length === 0) {
        processing = false;
        return;
      }

      // Step 4: Transform
      const transformStart = Date.now();
      const domainDocs = transform.transformBatch(valid);
      metrics.set('transform_duration_milliseconds', Date.now() - transformStart);

      // Step 5: Enrich
      const enrichedDocs = await enrichment.enrichBatch(domainDocs);

      // Filter out transform errors
      const docsToIndex = enrichedDocs.filter(d => d.action !== 'ERROR');
      const transformErrors = enrichedDocs.filter(d => d.action === 'ERROR');

      for (const errDoc of transformErrors) {
        await errorHandler.sendToDlq(errDoc.event, errDoc.error, 'PERMANENT');
        metrics.inc('events_sent_to_dlq_total');
      }

      // Step 6: Write to Elasticsearch
      const bulkStart = Date.now();
      const { successIds, failedItems } = await esWriter.writeAll(docsToIndex);
      metrics.set('bulk_index_duration_milliseconds', Date.now() - bulkStart);

      // Step 7: Update outbox status
      if (successIds.length > 0) {
        await eventReader.markProcessed(successIds);
        metrics.inc('events_processed_total', successIds.length);
        backpressure.recordSuccess();
      }

      // Step 8: Handle failures
      if (failedItems.length > 0) {
        const { retriedCount, dlqCount } = await errorHandler.handleBulkFailures(
          failedItems, eventReader, config.postgis_sync.max_retries
        );
        metrics.inc('events_failed_total', retriedCount);
        metrics.inc('events_sent_to_dlq_total', dlqCount);
      }

      // Update per-source metrics
      for (const doc of docsToIndex) {
        if (doc.event) {
          metrics.incSource(doc.event.table_name, 'processed');
        }
      }

      const batchDuration = Date.now() - batchStart;
      metrics.set('batch_duration_milliseconds', batchDuration);
      metrics.inc('batches_processed_total');

      log.info('Batch processed', {
        claimed: allEventIds.length,
        collapsed: collapsed.length,
        indexed: successIds.length,
        failed: failedItems.length,
        duration_ms: batchDuration
      });

      // If there were events, try again immediately (there might be more)
      processing = false;
      setImmediate(processBatch);
      return;

    } catch (err) {
      log.error('Batch processing error', { error: err.message, stack: err.stack });
      backpressure.recordFailure();
      metrics.inc('events_failed_total');
    }

    processing = false;
  }

  // 10. Safety-net poll
  const pollInterval = (config.postgis_sync.safety_net_poll_seconds || 30) * 1000;
  const safetyNetTimer = setInterval(async () => {
    if (shutdownRequested) return;

    // Update metrics
    try {
      const depth = await eventReader.getOutboxDepth();
      metrics.set('outbox_depth_pending', parseInt(depth.pending, 10));
      metrics.set('outbox_depth_processing', parseInt(depth.processing, 10));
      metrics.set('outbox_depth_failed', parseInt(depth.failed, 10));

      const age = await eventReader.getOldestPendingAge();
      metrics.set('oldest_pending_event_age_seconds', Math.round(age));

      const dlqDepth = await dlqManager.getDepth();
      metrics.set('dlq_depth', dlqDepth);

      metrics.set('pg_listener_connected', pgListener.isHealthy() ? 1 : 0);
      metrics.set('pg_pool_connected', 1);

      try {
        await esClient.ping();
        metrics.set('es_connected', 1);
      } catch (_) {
        metrics.set('es_connected', 0);
      }
    } catch (err) {
      log.error('Metrics update failed', { error: err.message });
    }

    // Process pending events (safety net)
    if (!processing) {
      processBatch();
    }
  }, pollInterval);

  // 11. Graceful shutdown
  async function shutdown(signal) {
    log.info('Shutdown requested', { signal });
    shutdownRequested = true;
    clearInterval(safetyNetTimer);

    // Wait for current batch to finish
    let waitCount = 0;
    while (processing && waitCount < 30) {
      await sleep(1000);
      waitCount++;
    }

    healthServer.stop();
    adminServer.stop();
    await pgListener.destroy();
    await pgPool.end();
    await esClient.close();

    log.info('Shutdown complete');
    process.exit(0);
  }

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  // 12. Initial processing
  log.info('Sync worker ready — processing initial events');
  processBatch();
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
