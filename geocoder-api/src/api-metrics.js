'use strict';

const client = require('prom-client');

/**
 * Prometheus metrics for the geocoder API.
 */
class ApiMetrics {
  constructor(registry) {
    this.registry = registry || new client.Registry();
    client.collectDefaultMetrics({ register: this.registry });

    this.requestTotal = new client.Counter({
      name: 'geocoder_request_total',
      help: 'Total API requests by endpoint and status',
      labelNames: ['endpoint', 'status'],
      registers: [this.registry]
    });

    this.requestDuration = new client.Histogram({
      name: 'geocoder_request_duration_seconds',
      help: 'API request duration in seconds by endpoint',
      labelNames: ['endpoint'],
      buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
      registers: [this.registry]
    });

    this.esQueryDuration = new client.Histogram({
      name: 'geocoder_es_query_duration_seconds',
      help: 'Elasticsearch query duration in seconds',
      labelNames: ['query_type'],
      buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
      registers: [this.registry]
    });

    this.esErrors = new client.Counter({
      name: 'geocoder_es_errors_total',
      help: 'Total Elasticsearch errors',
      labelNames: ['error_type'],
      registers: [this.registry]
    });

    this.batchSize = new client.Histogram({
      name: 'geocoder_batch_size',
      help: 'Batch request sizes',
      buckets: [1, 5, 10, 25, 50, 100],
      registers: [this.registry]
    });

    this.searchResultCount = new client.Histogram({
      name: 'geocoder_search_result_count',
      help: 'Number of results returned per search',
      labelNames: ['endpoint'],
      buckets: [0, 1, 5, 10, 20, 40],
      registers: [this.registry]
    });

    this.normalizationErrors = new client.Counter({
      name: 'geocoder_normalization_errors_total',
      help: 'Text normalization errors',
      registers: [this.registry]
    });

    this.categoryLookups = new client.Counter({
      name: 'geocoder_category_lookup_total',
      help: 'Category lookup requests',
      registers: [this.registry]
    });

    this.readinessFailures = new client.Counter({
      name: 'geocoder_readiness_failures_total',
      help: 'Readiness check failures',
      registers: [this.registry]
    });
  }

  /**
   * Express middleware that records request duration and status.
   */
  requestMetricsMiddleware() {
    return (req, res, next) => {
      const start = process.hrtime.bigint();
      const endpoint = req.route ? req.route.path : req.path;

      res.on('finish', () => {
        const durationNs = Number(process.hrtime.bigint() - start);
        const durationSec = durationNs / 1e9;
        const normalizedEndpoint = normalizeEndpoint(endpoint);
        this.requestTotal.labels(normalizedEndpoint, String(res.statusCode)).inc();
        this.requestDuration.labels(normalizedEndpoint).observe(durationSec);
      });

      next();
    };
  }
}

function normalizeEndpoint(path) {
  // Collapse path params
  return path
    .replace(/\/worker\/runs\/[^/]+/, '/worker/runs/:id')
    .replace(/\/worker\/sync\/[^/]+/, '/worker/sync/:source')
    .replace(/\/worker\/reindex\/[^/]+/, '/worker/reindex/:source');
}

module.exports = ApiMetrics;
