'use strict';

const express = require('express');

class HealthServer {
  constructor({ config, metrics, postgisReader, esClient, indexManager, stateStore, syncService, logger }) {
    this.config = config;
    this.metrics = metrics;
    this.postgisReader = postgisReader;
    this.esClient = esClient;
    this.indexManager = indexManager;
    this.stateStore = stateStore;
    this.syncService = syncService;
    this.log = logger;
    this.server = null;
  }

  start() {
    const app = express();

    app.get('/health', async (_req, res) => {
      try {
        await this.stateStore.load();
      } catch (err) {
        this.log.warn('Failed to refresh state for health response', { error: err.message });
      }

      const checks = await this.checks();
      const ok = Object.values(checks).every(Boolean);
      res.status(ok ? 200 : 503).json({
        status: ok ? 'ok' : 'degraded',
        checks,
        sources: summarizeSources(this.stateStore.state.sources)
      });
    });

    app.get('/health/live', (_req, res) => {
      res.json({ status: 'ok' });
    });

    app.get('/health/ready', async (_req, res) => {
      const checks = await this.checks();
      let documentCount = 0;
      try {
        const response = await this.esClient.count({ index: this.config.elasticsearch.read_alias });
        const body = response.body || response;
        documentCount = body.count || 0;
      } catch (_) {
        documentCount = 0;
      }
      checks.index_has_documents = documentCount > 0;

      // Staleness check
      const staleThreshold = Number(process.env.WORKER_STALE_THRESHOLD_SECONDS || 86400);
      try {
        await this.stateStore.load();
        const staleSources = this.stateStore.staleSources
          ? this.stateStore.staleSources(staleThreshold, this.config.sources || [])
          : [];
        checks.worker_stale = staleSources.length > 0;
        checks.source_counts_ok = sourceCountsOk(this.stateStore.state);
      } catch (_) {
        checks.worker_stale = false;
        checks.source_counts_ok = true;
      }

      const ok = checks.postgis && checks.elasticsearch && checks.aliases
        && checks.index_has_documents && !checks.worker_stale && checks.source_counts_ok;
      res.status(ok ? 200 : 503).json({
        status: ok ? 'ok' : 'degraded',
        checks,
        documents: documentCount,
        stale_sources: this.stateStore.staleSources
          ? this.stateStore.staleSources(staleThreshold, this.config.sources || [])
          : []
      });
    });

    app.get('/health/dependencies', async (_req, res) => {
      const checks = await this.checks();
      const ok = Object.values(checks).every(Boolean);
      res.status(ok ? 200 : 503).json({
        status: ok ? 'ok' : 'degraded',
        dependencies: checks
      });
    });

    app.get('/metrics', async (_req, res) => {
      res.set('Content-Type', this.metrics.contentType());
      res.send(await this.metrics.render());
    });

    app.post('/worker/sync/:source', this.requireInternalToken(), async (req, res, next) => {
      try {
        const run = await this.startRun(req.params.source, 'sync', () => (
          this.syncService.syncSource(req.params.source, { mode: 'worker-sync' })
        ));
        res.status(202).json(run);
      } catch (err) {
        next(err);
      }
    });

    app.post('/worker/reindex/:source', this.requireInternalToken(), async (req, res, next) => {
      try {
        const run = await this.startRun(req.params.source, 'reindex', () => (
          this.syncService.syncSource(req.params.source, { mode: 'worker-reindex', forceDeleteDiff: true })
        ));
        res.status(202).json(run);
      } catch (err) {
        next(err);
      }
    });

    app.post('/worker/reindex-all', this.requireInternalToken(), async (_req, res, next) => {
      try {
        const run = await this.startRun('all', 'reindex', () => this.syncService.reindexAll());
        res.status(202).json(run);
      } catch (err) {
        next(err);
      }
    });

    app.get('/worker/runs', this.requireInternalToken(), async (_req, res, next) => {
      try {
        await this.stateStore.load();
        res.json({ runs: this.stateStore.listRuns() });
      } catch (err) {
        next(err);
      }
    });

    app.get('/worker/runs/:run_id', this.requireInternalToken(), async (req, res, next) => {
      try {
        await this.stateStore.load();
        const run = this.stateStore.getRun(req.params.run_id);
        if (!run) {
          res.status(404).json(errorBody('not_found', 'Run not found'));
          return;
        }
        res.json(run);
      } catch (err) {
        next(err);
      }
    });

    app.use((err, _req, res, _next) => {
      this.log.error('Worker HTTP error', { error: err.message });
      res.status(500).json(errorBody('internal_error', 'Worker operation failed', {
        message: err.message
      }));
    });

    const port = Number(process.env.HEALTH_PORT || this.config.worker.health_port || 9090);
    this.server = app.listen(port, () => {
      this.log.info('Health server listening', { port });
    });
  }

  async stop() {
    if (!this.server) return;
    await new Promise(resolve => this.server.close(resolve));
  }

  async checks() {
    const checks = {
      postgis: false,
      elasticsearch: false,
      aliases: false
    };

    try {
      await this.postgisReader.ping();
      checks.postgis = true;
      this.metrics.health.labels('postgis').set(1);
    } catch (err) {
      this.metrics.health.labels('postgis').set(0);
    }

    try {
      await this.esClient.ping();
      checks.elasticsearch = true;
      this.metrics.health.labels('elasticsearch').set(1);
    } catch (err) {
      this.metrics.health.labels('elasticsearch').set(0);
    }

    try {
      const target = await this.indexManager.currentWriteTarget();
      checks.aliases = Boolean(target);
    } catch (_) {
      checks.aliases = false;
    }

    return checks;
  }

  requireInternalToken() {
    return (req, res, next) => {
      const expected = process.env.WORKER_INTERNAL_TOKEN;
      if (!expected) {
        res.status(503).json(errorBody('internal_token_not_configured', 'WORKER_INTERNAL_TOKEN is not configured'));
        return;
      }

      const bearer = String(req.get('authorization') || '').replace(/^Bearer\s+/i, '');
      const header = req.get('x-internal-token');
      if (bearer === expected || header === expected) {
        next();
        return;
      }

      res.status(401).json(errorBody('unauthorized', 'Internal token is required'));
    };
  }

  async startRun(source, mode, fn) {
    const run = await this.stateStore.startRun({ source, mode });
    Promise.resolve()
      .then(fn)
      .then(result => this.stateStore.finishRun(run.run_id, 'success', result || {}))
      .catch(err => {
        this.log.error('Controlled worker run failed', {
          run_id: run.run_id,
          source,
          mode,
          error: err.message
        });
        return this.stateStore.finishRun(run.run_id, 'failed', {}, err);
      });
    return run;
  }
}

function summarizeSources(sources) {
  const summary = {};
  for (const [name, state] of Object.entries(sources || {})) {
    const { seen_ids: seenIds, ...rest } = state;
    summary[name] = {
      ...rest,
      seen_id_count: Array.isArray(seenIds) ? seenIds.length : 0
    };
  }
  return summary;
}

function sourceCountsOk(state) {
  return !Object.values((state && state.sources) || {})
    .some(source => source.last_error && source.last_error.code === 'unexpected_source_drop');
}

function errorBody(code, message, details = {}) {
  return { error: { code, message, details } };
}

module.exports = HealthServer;
