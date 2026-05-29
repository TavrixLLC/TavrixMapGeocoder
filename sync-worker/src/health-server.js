'use strict';

const http = require('http');

class HealthServer {
  constructor(opts) {
    this.port = parseInt(process.env.HEALTH_PORT) || 9090;
    this.metrics = opts.metrics;
    this.pgPool = opts.pgPool;
    this.pgListener = opts.pgListener;
    this.esClient = opts.esClient;
    this.esIndexManager = opts.esIndexManager;
    this.log = opts.logger;
    this.server = null;
  }

  start() {
    this.server = http.createServer(async (req, res) => {
      try {
        if (req.method === 'GET' && req.url === '/health') {
          return await this._handleHealth(req, res);
        }
        if (req.method === 'GET' && req.url === '/metrics') {
          return await this._handleMetrics(req, res);
        }
        res.writeHead(404);
        res.end('Not found');
      } catch (err) {
        this.log.error('Health server error', { error: err.message });
        res.writeHead(500);
        res.end('Internal error');
      }
    });

    this.server.listen(this.port, () => {
      this.log.info('Health server started', { port: this.port });
    });
  }

  async _handleHealth(req, res) {
    const checks = {};

    // PG Pool
    try {
      await this.pgPool.query('SELECT 1');
      checks.pg_pool = { status: 'up' };
    } catch (err) {
      checks.pg_pool = { status: 'down', error: err.message };
    }

    // PG Listener
    checks.pg_listener = {
      status: this.pgListener.isHealthy() ? 'up' : 'down'
    };

    // Elasticsearch
    try {
      const esHealthy = await this.esIndexManager.isHealthy();
      checks.elasticsearch = { status: esHealthy ? 'up' : 'degraded' };
    } catch (err) {
      checks.elasticsearch = { status: 'down', error: err.message };
    }

    const allUp = Object.values(checks).every(c => c.status === 'up');

    const body = {
      status: allUp ? 'healthy' : 'degraded',
      worker: process.env.WORKER_ID || 'worker',
      uptime_s: Math.floor((Date.now() - this.metrics.startedAt) / 1000),
      checks
    };

    res.writeHead(allUp ? 200 : 503, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body, null, 2));
  }

  async _handleMetrics(req, res) {
    this.metrics.updateRates();
    res.writeHead(200, { 'Content-Type': 'text/plain; version=0.0.4' });
    res.end(this.metrics.toPrometheus());
  }

  stop() {
    if (this.server) this.server.close();
  }
}

module.exports = HealthServer;
