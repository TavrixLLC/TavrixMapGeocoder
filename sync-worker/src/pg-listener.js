'use strict';

const { Client } = require('pg');

class PgListener {
  constructor(connectionString, channel, logger) {
    this.connStr = connectionString;
    this.channel = channel;
    this.log = logger;
    this.client = null;
    this.connected = false;
    this._reconnecting = false;
    this._destroyed = false;
    this._baseDelay = 1000;
    this._maxDelay = 30000;
    this._attempt = 0;
    this.onNotification = null;
  }

  async connect() {
    if (this._destroyed) return;

    try {
      if (this.client) {
        try { await this.client.end(); } catch (_) {}
      }

      this.client = new Client({ connectionString: this.connStr });

      this.client.on('error', (err) => {
        this.log.error('PG listener connection error', { error: err.message });
        this.connected = false;
        this._scheduleReconnect();
      });

      this.client.on('end', () => {
        if (!this._destroyed) {
          this.log.warn('PG listener connection ended unexpectedly');
          this.connected = false;
          this._scheduleReconnect();
        }
      });

      await this.client.connect();
      await this.client.query(`LISTEN ${this.channel}`);

      this.connected = true;
      this._attempt = 0;
      this.log.info('PG LISTEN established', { channel: this.channel });

      this.client.on('notification', (msg) => {
        if (this.onNotification) {
          this.onNotification(msg);
        }
      });
    } catch (err) {
      this.log.error('PG listener connect failed', { error: err.message });
      this.connected = false;
      this._scheduleReconnect();
    }
  }

  _scheduleReconnect() {
    if (this._reconnecting || this._destroyed) return;
    this._reconnecting = true;
    this._attempt++;

    const delay = Math.min(
      this._baseDelay * Math.pow(2, this._attempt - 1),
      this._maxDelay
    );

    this.log.info('PG listener reconnecting', { delayMs: delay, attempt: this._attempt });

    setTimeout(async () => {
      this._reconnecting = false;
      await this.connect();
    }, delay);
  }

  isHealthy() {
    return this.connected;
  }

  async destroy() {
    this._destroyed = true;
    this.connected = false;
    if (this.client) {
      try { await this.client.end(); } catch (_) {}
    }
  }
}

module.exports = PgListener;
