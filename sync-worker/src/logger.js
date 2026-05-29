'use strict';

const LOG_LEVELS = { error: 0, warn: 1, info: 2, debug: 3 };
const currentLevel = LOG_LEVELS[process.env.LOG_LEVEL || 'info'] ?? LOG_LEVELS.info;

class Logger {
  constructor(workerId) {
    this.workerId = workerId || process.env.WORKER_ID || 'worker';
  }

  _write(level, msg, meta = {}) {
    if (LOG_LEVELS[level] > currentLevel) return;
    const entry = {
      ts: new Date().toISOString(),
      level,
      worker: this.workerId,
      msg,
      ...meta
    };
    const stream = level === 'error' ? process.stderr : process.stdout;
    stream.write(JSON.stringify(entry) + '\n');
  }

  info(msg, meta) { this._write('info', msg, meta); }
  warn(msg, meta) { this._write('warn', msg, meta); }
  error(msg, meta) { this._write('error', msg, meta); }
  debug(msg, meta) { this._write('debug', msg, meta); }

  batch(batchId, msg, meta = {}) {
    this._write('info', msg, { batchId, ...meta });
  }
}

module.exports = Logger;
