'use strict';

const SECRET_KEYS = new Set(['password', 'pass', 'pwd', 'token', 'secret']);

class Logger {
  constructor(scope = 'postgis-readonly-sync') {
    this.scope = scope;
  }

  info(message, meta) {
    this.write('info', message, meta);
  }

  warn(message, meta) {
    this.write('warn', message, meta);
  }

  error(message, meta) {
    this.write('error', message, meta);
  }

  debug(message, meta) {
    if (process.env.LOG_LEVEL === 'debug') {
      this.write('debug', message, meta);
    }
  }

  write(level, message, meta = undefined) {
    const entry = {
      ts: new Date().toISOString(),
      level,
      scope: this.scope,
      message
    };

    if (meta && Object.keys(meta).length > 0) {
      entry.meta = scrub(meta);
    }

    const line = JSON.stringify(entry);
    if (level === 'error') {
      console.error(line);
    } else {
      console.log(line);
    }
  }
}

function scrub(value) {
  if (Array.isArray(value)) {
    return value.map(scrub);
  }

  if (value && typeof value === 'object') {
    const out = {};
    for (const [key, val] of Object.entries(value)) {
      if (SECRET_KEYS.has(key.toLowerCase()) || key.toLowerCase().includes('password')) {
        out[key] = '[redacted]';
      } else {
        out[key] = scrub(val);
      }
    }
    return out;
  }

  return value;
}

module.exports = Logger;
