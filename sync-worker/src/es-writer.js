'use strict';

const PeliasDocumentBuilder = require('./pelias-document-builder');

class EsWriter {
  constructor(esClient, config, metrics, logger) {
    this.es = esClient;
    this.config = config;
    this.metrics = metrics;
    this.log = logger;
    this.builder = new PeliasDocumentBuilder();
    this.targetIndex = config.elasticsearch.write_alias;
    this.maxBulkDocs = config.elasticsearch.max_bulk_docs || 1000;
    this.maxBulkBytes = config.elasticsearch.max_bulk_bytes || 10 * 1024 * 1024;
    this.maxRetries = config.elasticsearch.max_retries || 3;
    this.retryBaseDelayMs = config.elasticsearch.retry_base_delay_ms || 500;
  }

  setTargetIndex(targetIndex) {
    this.targetIndex = targetIndex;
  }

  async indexDocuments(sourceName, documents) {
    let indexed = 0;
    let failed = 0;

    for (const bulk of this.toBulks(documents, 'index')) {
      const result = await this.writeBulkWithRetry(sourceName, bulk);
      indexed += result.success;
      failed += result.failed;
    }

    return { indexed, failed };
  }

  async deleteIds(sourceName, ids) {
    const deleteDocs = ids.map(id => ({ id }));
    let deleted = 0;
    let failed = 0;

    for (const bulk of this.toBulks(deleteDocs, 'delete')) {
      const result = await this.writeBulkWithRetry(sourceName, bulk);
      deleted += result.success;
      failed += result.failed;
    }

    return { deleted, failed };
  }

  toBulks(documents, operation) {
    const bulks = [];
    let current = [];
    let currentBytes = 0;

    for (const doc of documents) {
      const action = operation === 'delete'
        ? { delete: { _index: this.targetIndex, _id: doc.id } }
        : { index: { _index: this.targetIndex, _id: doc.id } };
      const payload = operation === 'delete' ? null : this.builder.build(doc);
      const bytes = Buffer.byteLength(JSON.stringify(action)) + (payload ? Buffer.byteLength(JSON.stringify(payload)) : 0);

      if (current.length > 0 && (current.length >= this.maxBulkDocs || currentBytes + bytes > this.maxBulkBytes)) {
        bulks.push(current);
        current = [];
        currentBytes = 0;
      }

      current.push({ action, payload, id: doc.id });
      currentBytes += bytes;
    }

    if (current.length > 0) {
      bulks.push(current);
    }

    return bulks;
  }

  async writeBulkWithRetry(sourceName, bulk) {
    let pending = bulk;
    let totalSuccess = 0;
    let totalFailed = 0;

    for (let attempt = 0; attempt <= this.maxRetries && pending.length > 0; attempt++) {
      if (attempt > 0) {
        await sleep(this.retryBaseDelayMs * Math.pow(2, attempt - 1));
      }

      const started = Date.now();
      const response = await this.writeBulk(pending);
      this.metrics.esBulkDuration.labels(sourceName).observe(Date.now() - started);

      totalSuccess += response.successItems.length;
      totalFailed += response.permanentFailures.length;

      if (response.permanentFailures.length > 0) {
        this.log.warn('Permanent Elasticsearch bulk failures', {
          source: sourceName,
          count: response.permanentFailures.length,
          examples: response.permanentFailures.slice(0, 3)
        });
      }

      pending = response.transientFailures;
    }

    if (pending.length > 0) {
      totalFailed += pending.length;
      this.log.error('Elasticsearch bulk items exhausted retries', {
        source: sourceName,
        count: pending.length,
        examples: pending.slice(0, 3).map(item => item.id)
      });
    }

    return { success: totalSuccess, failed: totalFailed };
  }

  async writeBulk(items) {
    const body = [];
    for (const item of items) {
      body.push(item.action);
      if (item.payload) body.push(item.payload);
    }

    const response = await this.es.bulk({ body, refresh: false });
    const bodyResponse = response.body || response;
    const resultItems = bodyResponse.items || [];

    const successItems = [];
    const transientFailures = [];
    const permanentFailures = [];

    for (let i = 0; i < resultItems.length; i++) {
      const result = resultItems[i].index || resultItems[i].delete;
      const original = items[i];

      if (!result || !result.error) {
        successItems.push(original);
        continue;
      }

      const status = Number(result.status);
      const type = result.error.type || 'unknown_error';

      if (original.action.delete && status === 404) {
        successItems.push(original);
      } else if (status === 429 || status === 502 || status === 503 || status === 504) {
        transientFailures.push(original);
      } else {
        permanentFailures.push({
          id: original.id,
          status,
          type,
          reason: result.error.reason
        });
      }
    }

    return { successItems, transientFailures, permanentFailures };
  }
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

module.exports = EsWriter;
