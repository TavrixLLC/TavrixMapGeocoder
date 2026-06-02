'use strict';

class ResponseCache {
  constructor({ ttlMs = 5000, maxEntries = 1000 } = {}) {
    this.ttlMs = Number(ttlMs) || 0;
    this.maxEntries = Number(maxEntries) || 0;
    this.store = new Map();
  }

  get(key) {
    if (this.ttlMs <= 0 || this.maxEntries <= 0) return null;
    const entry = this.store.get(key);
    if (!entry) return null;
    if (entry.expiresAt <= Date.now()) {
      this.store.delete(key);
      return null;
    }
    this.store.delete(key);
    this.store.set(key, entry);
    return clone(entry.value);
  }

  set(key, value) {
    if (this.ttlMs <= 0 || this.maxEntries <= 0) return;
    if (this.store.has(key)) this.store.delete(key);
    this.store.set(key, {
      expiresAt: Date.now() + this.ttlMs,
      value: clone(value)
    });
    while (this.store.size > this.maxEntries) {
      const oldest = this.store.keys().next().value;
      this.store.delete(oldest);
    }
  }
}

function stableCacheKey(parts) {
  return JSON.stringify(sortValue(parts));
}

function sortValue(value) {
  if (Array.isArray(value)) return value.map(sortValue);
  if (value && typeof value === 'object') {
    const out = {};
    for (const key of Object.keys(value).sort()) {
      if (value[key] !== undefined) out[key] = sortValue(value[key]);
    }
    return out;
  }
  return value;
}

function clone(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

module.exports = {
  ResponseCache,
  stableCacheKey
};
