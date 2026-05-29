'use strict';

const http = require('http');

class AdminServer {
  constructor(opts) {
    this.port = parseInt(process.env.ADMIN_PORT) || 9091;
    this.adminToken = process.env.ADMIN_TOKEN;
    this.replayManager = opts.replayManager;
    this.dlqManager = opts.dlqManager;
    this.esIndexManager = opts.esIndexManager;
    this.log = opts.logger;
    this.server = null;
  }

  start() {
    if (!this.adminToken) {
      this.log.warn('ADMIN_TOKEN not set — admin endpoints disabled');
      return;
    }

    this.server = http.createServer(async (req, res) => {
      try {
        // Authentication
        const auth = req.headers.authorization;
        if (auth !== `Bearer ${this.adminToken}`) {
          this.log.warn('Unauthorized admin access', {
            ip: req.socket.remoteAddress, path: req.url
          });
          res.writeHead(401, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ error: 'Unauthorized' }));
        }

        const url = new URL(req.url, `http://localhost:${this.port}`);
        const path = url.pathname;

        // Routing
        if (req.method === 'POST' && path === '/admin/replay') {
          return await this._handleReplay(req, res);
        }
        if (req.method === 'GET' && path === '/admin/replay/status') {
          return this._handleReplayStatus(req, res);
        }
        if (req.method === 'POST' && path === '/admin/replay/cancel') {
          return this._handleReplayCancel(req, res);
        }
        if (req.method === 'GET' && path === '/admin/dlq') {
          return await this._handleDlqQuery(req, res, url);
        }
        if (req.method === 'POST' && path === '/admin/dlq/replay') {
          return await this._handleDlqReplay(req, res);
        }
        if (req.method === 'GET' && path === '/admin/indices') {
          return await this._handleIndices(req, res);
        }

        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Not found' }));
      } catch (err) {
        this.log.error('Admin server error', { error: err.message, path: req.url });
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Internal error' }));
      }
    });

    this.server.listen(this.port, () => {
      this.log.info('Admin server started', { port: this.port });
    });
  }

  async _handleReplay(req, res) {
    const body = await this._parseBody(req);
    if (!body.from || !body.to) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'Missing from/to' }));
    }
    const result = await this.replayManager.start(body);
    const status = result.error ? 409 : 202;
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(result));
  }

  _handleReplayStatus(req, res) {
    const status = this.replayManager.getStatus();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(status || { status: 'no_active_job' }));
  }

  _handleReplayCancel(req, res) {
    const result = this.replayManager.cancel();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(result));
  }

  async _handleDlqQuery(req, res, url) {
    const opts = {
      limit: parseInt(url.searchParams.get('limit') || '50'),
      error_type: url.searchParams.get('error_type') || undefined,
      table_name: url.searchParams.get('table_name') || undefined,
      replayed: false
    };
    const rows = await this.dlqManager.query(opts);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ count: rows.length, items: rows }));
  }

  async _handleDlqReplay(req, res) {
    const body = await this._parseBody(req);
    const result = await this.dlqManager.replay(body);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(result));
  }

  async _handleIndices(req, res) {
    const info = await this.esIndexManager.getIndexInfo();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(info));
  }

  _parseBody(req) {
    return new Promise((resolve, reject) => {
      let data = '';
      req.on('data', chunk => { data += chunk; });
      req.on('end', () => {
        try {
          resolve(data ? JSON.parse(data) : {});
        } catch (err) {
          reject(new Error('Invalid JSON body'));
        }
      });
      req.on('error', reject);
    });
  }

  stop() {
    if (this.server) this.server.close();
  }
}

module.exports = AdminServer;
