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
    }
  };

  const server = new HealthServer({
    config: { worker: { health_port: 0 }, elasticsearch: { read_alias: 'pelias' } },
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
