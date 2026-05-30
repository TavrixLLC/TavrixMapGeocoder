'use strict';

const client = require('prom-client');

class Metrics {
  constructor() {
    this.registry = new client.Registry();
    client.collectDefaultMetrics({ register: this.registry });

    this.lastSuccess = new client.Gauge({
      name: 'sync_last_success_timestamp',
      help: 'Last successful sync timestamp by source as Unix seconds',
      labelNames: ['source']
    });
    this.duration = new client.Histogram({
      name: 'sync_duration_seconds',
      help: 'Sync duration by source',
      labelNames: ['source', 'mode'],
      buckets: [1, 5, 15, 30, 60, 120, 300, 900, 1800, 3600]
    });
    this.rowsRead = new client.Counter({
      name: 'sync_rows_read_total',
      help: 'Rows read from PostGIS',
      labelNames: ['source']
    });
    this.docsIndexed = new client.Counter({
      name: 'sync_docs_indexed_total',
      help: 'Documents indexed into Elasticsearch',
      labelNames: ['source']
    });
    this.docsDeleted = new client.Counter({
      name: 'sync_docs_deleted_total',
      help: 'Documents deleted from Elasticsearch',
      labelNames: ['source']
    });
    this.docsFailed = new client.Counter({
      name: 'sync_docs_failed_total',
      help: 'Documents that failed transform or indexing',
      labelNames: ['source']
    });
    this.esBulkDuration = new client.Histogram({
      name: 'es_bulk_duration_ms',
      help: 'Elasticsearch bulk request duration in milliseconds',
      labelNames: ['source'],
      buckets: [10, 50, 100, 250, 500, 1000, 2500, 5000, 10000, 30000]
    });
    this.postgisQueryDuration = new client.Histogram({
      name: 'postgis_query_duration_ms',
      help: 'PostGIS query duration in milliseconds',
      labelNames: ['source'],
      buckets: [50, 100, 250, 500, 1000, 2500, 5000, 10000, 30000, 120000, 600000]
    });
    this.currentIndexAlias = new client.Gauge({
      name: 'current_index_alias',
      help: 'Current Pelias alias target marker',
      labelNames: ['alias', 'index']
    });
    this.scheduleStatus = new client.Gauge({
      name: 'schedule_status',
      help: 'Schedule status by source. 1 active, 0 inactive',
      labelNames: ['source']
    });
    this.lastError = new client.Gauge({
      name: 'sync_last_error_timestamp',
      help: 'Last error timestamp by source as Unix seconds',
      labelNames: ['source', 'message']
    });
    this.health = new client.Gauge({
      name: 'dependency_available',
      help: 'Dependency health. 1 available, 0 unavailable',
      labelNames: ['dependency']
    });

    this.registry.registerMetric(this.lastSuccess);
    this.registry.registerMetric(this.duration);
    this.registry.registerMetric(this.rowsRead);
    this.registry.registerMetric(this.docsIndexed);
    this.registry.registerMetric(this.docsDeleted);
    this.registry.registerMetric(this.docsFailed);
    this.registry.registerMetric(this.esBulkDuration);
    this.registry.registerMetric(this.postgisQueryDuration);
    this.registry.registerMetric(this.currentIndexAlias);
    this.registry.registerMetric(this.scheduleStatus);
    this.registry.registerMetric(this.lastError);
    this.registry.registerMetric(this.health);
  }

  markLastSuccess(source) {
    this.lastSuccess.labels(source).set(Math.floor(Date.now() / 1000));
  }

  markLastError(source, error) {
    const message = String(error && error.message ? error.message : error).slice(0, 160);
    this.lastError.labels(source, message).set(Math.floor(Date.now() / 1000));
  }

  async render() {
    return this.registry.metrics();
  }

  contentType() {
    return this.registry.contentType;
  }
}

module.exports = Metrics;
