'use strict';

class Metrics {
  constructor() {
    this.startedAt = Date.now();
    this.counters = {
      events_processed_total: 0,
      events_failed_total: 0,
      events_sent_to_dlq_total: 0,
      batches_processed_total: 0
    };
    this.gauges = {
      outbox_depth_pending: 0,
      outbox_depth_processing: 0,
      outbox_depth_failed: 0,
      dlq_depth: 0,
      oldest_pending_event_age_seconds: 0,
      event_processing_lag_seconds: 0,
      batch_duration_milliseconds: 0,
      bulk_index_duration_milliseconds: 0,
      fetch_state_duration_milliseconds: 0,
      transform_duration_milliseconds: 0,
      worker_events_per_second: 0,
      retry_rate: 0,
      queue_growth_rate: 0,
      pg_listener_connected: 0,
      pg_pool_connected: 0,
      es_connected: 0
    };
    this.perSource = {};
    this._lastProcessedCount = 0;
    this._lastRateCheck = Date.now();
  }

  inc(name, amount = 1) {
    if (this.counters[name] != null) {
      this.counters[name] += amount;
    }
  }

  set(name, value) {
    if (this.gauges[name] != null) {
      this.gauges[name] = value;
    }
  }

  incSource(source, name, amount = 1) {
    if (!this.perSource[source]) {
      this.perSource[source] = { processed: 0, failed: 0, lag_seconds: 0 };
    }
    if (this.perSource[source][name] != null) {
      this.perSource[source][name] += amount;
    }
  }

  setSource(source, name, value) {
    if (!this.perSource[source]) {
      this.perSource[source] = { processed: 0, failed: 0, lag_seconds: 0 };
    }
    this.perSource[source][name] = value;
  }

  updateRates() {
    const now = Date.now();
    const elapsed = (now - this._lastRateCheck) / 1000;
    if (elapsed > 0) {
      const processed = this.counters.events_processed_total - this._lastProcessedCount;
      this.gauges.worker_events_per_second = Math.round((processed / elapsed) * 100) / 100;
      this._lastProcessedCount = this.counters.events_processed_total;
      this._lastRateCheck = now;
    }
  }

  toPrometheus() {
    const lines = [];
    const uptimeSeconds = Math.floor((Date.now() - this.startedAt) / 1000);

    // Counters
    for (const [name, value] of Object.entries(this.counters)) {
      lines.push(`# HELP ${name} Counter`);
      lines.push(`# TYPE ${name} counter`);
      lines.push(`${name} ${value}`);
    }

    // Gauges
    for (const [name, value] of Object.entries(this.gauges)) {
      lines.push(`# HELP ${name} Gauge`);
      lines.push(`# TYPE ${name} gauge`);
      lines.push(`${name} ${value}`);
    }

    lines.push(`# HELP uptime_seconds Worker uptime`);
    lines.push(`# TYPE uptime_seconds gauge`);
    lines.push(`uptime_seconds ${uptimeSeconds}`);

    // Per-source
    for (const [source, data] of Object.entries(this.perSource)) {
      for (const [key, val] of Object.entries(data)) {
        lines.push(`per_source_${key}{source="${source}"} ${val}`);
      }
    }

    return lines.join('\n') + '\n';
  }

  toJSON() {
    return {
      uptime_seconds: Math.floor((Date.now() - this.startedAt) / 1000),
      counters: { ...this.counters },
      gauges: { ...this.gauges },
      per_source: { ...this.perSource }
    };
  }
}

module.exports = Metrics;
