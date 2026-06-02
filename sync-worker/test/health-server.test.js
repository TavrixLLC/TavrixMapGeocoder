'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const HealthServer = require('../src/health-server');

function makeServer() {
  process.env.HEALTH_PORT = '0';
  process.env.WORKER_INTERNAL_TOKEN = 'test-token';
  const stateStore = {
    state: { sources: {}, runs: [] },
    async load() {},
    async startRun({ source, mode }) {
      const run = {
        run_id: 'run_test',
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
      this.state.runs.unshift(run);
      return run;
    },
    async finishRun(runId, status, result) {
      const run = this.state.runs.find(item => item.run_id === runId);
      run.status = status;
      run.finished_at = new Date().toISOString();
      run.indexed_count = result.indexed || 0;
      return run;
    },
    listRuns() {
      return this.state.runs;
    },
    getRun(runId) {
      return this.state.runs.find(item => item.run_id === runId) || null;
    },
    staleSources(defaultThreshold, sources) {
      const stale = [];
      for (const [name, state] of Object.entries(this.state.sources || {})) {
        const source = (sources || []).find(item => item.name === name);
        const threshold = (source && source.stale_after_seconds) || defaultThreshold;
        if (!state.last_success_timestamp) continue;
        const staleness = Math.floor((Date.now() - new Date(state.last_success_timestamp).getTime()) / 1000);
        if (staleness > threshold) {
          stale.push({ source: name, staleness_seconds: staleness, freshness_threshold_seconds: threshold });
        }
      }
      return stale;
    }
  };

  const server = new HealthServer({
    config: {
      worker: { health_port: 0 },
      elasticsearch: { read_alias: 'pelias' },
      sources: [{ name: 'admin_boundaries', stale_after_seconds: 604800 }]
    },
    metrics: {
      contentType: 'text/plain',
      async render() { return ''; },
      health: { labels: () => ({ set() {} }) }
    },
    postgisReader: { async ping() {} },
    esClient: { async ping() {}, async count() { return { count: 1 }; } },
    indexManager: { async currentWriteTarget() { return 'pelias_v1'; } },
    stateStore,
    syncService: {
      async syncSource() { return { indexed: 1, failed: 0, deleted: 0 }; },
      async reindexAll() { return { indexed: 1, failed: 0, deleted: 0 }; }
    },
    logger: { info() {}, warn() {}, error() {} }
  });
  return server;
}

test('worker run endpoints require internal token and list runs', async () => {
  const server = makeServer();
  server.start();
  const port = server.server.address().port;

  try {
    const unauthorized = await fetch(`http://127.0.0.1:${port}/worker/runs`);
    assert.equal(unauthorized.status, 401);

    const started = await fetch(`http://127.0.0.1:${port}/worker/sync/osm_pois`, {
      method: 'POST',
      headers: { authorization: 'Bearer test-token' }
    });
    assert.equal(started.status, 202);
    const run = await started.json();
    assert.equal(run.run_id, 'run_test');

    await new Promise(resolve => setTimeout(resolve, 20));

    const list = await fetch(`http://127.0.0.1:${port}/worker/runs`, {
      headers: { 'x-internal-token': 'test-token' }
    });
    assert.equal(list.status, 200);
    const body = await list.json();
    assert.equal(body.runs[0].run_id, 'run_test');
  } finally {
    await server.stop();
  }
});

test('worker ready uses source-specific stale thresholds', async () => {
  const server = makeServer();
  server.stateStore.state.sources = {
    admin_boundaries: {
      last_success_timestamp: new Date(Date.now() - 48 * 3600 * 1000).toISOString()
    }
  };
  server.start();
  const port = server.server.address().port;

  try {
    const res = await fetch(`http://127.0.0.1:${port}/health/ready`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.checks.worker_stale, false);
    assert.deepEqual(body.stale_sources, []);
  } finally {
    await server.stop();
  }
});

test('worker ready reports degraded after unexpected source count drop', async () => {
  const server = makeServer();
  server.stateStore = server.stateStore || null;
  server.stateStore.state.sources = {
    osm_pois: {
      last_error: { code: 'unexpected_source_drop' }
    }
  };
  server.start();
  const port = server.server.address().port;

  try {
    const res = await fetch(`http://127.0.0.1:${port}/health/ready`);
    assert.equal(res.status, 503);
    const body = await res.json();
    assert.equal(body.checks.source_counts_ok, false);
  } finally {
    await server.stop();
  }
});
