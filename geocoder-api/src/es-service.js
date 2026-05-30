'use strict';

const fs = require('fs/promises');

class EsService {
  constructor(esClient, config) {
    this.es = esClient;
    this.config = config;
  }

  async search(body, options = {}) {
    const response = await this.es.search({
      index: options.index || this.config.peliasAlias,
      body
    });
    return response.body || response;
  }

  async count() {
    const response = await this.es.count({ index: this.config.peliasAlias });
    const body = response.body || response;
    return body.count || 0;
  }

  async getAliasTargets(alias = this.config.peliasAlias) {
    try {
      const response = await this.es.indices.getAlias({ name: alias });
      const body = response.body || response;
      return Object.keys(body);
    } catch (err) {
      if (err.meta && err.meta.statusCode === 404) return [];
      if (err.statusCode === 404) return [];
      throw err;
    }
  }

  async findDocumentByFeature(feature) {
    const props = feature && feature.properties ? feature.properties : {};
    if (!props.source_id) return null;

    const filter = [
      { term: { source_id: String(props.source_id) } }
    ];
    if (props.source) filter.push({ term: { source: props.source } });
    if (props.layer) filter.push({ term: { layer: props.layer } });

    const result = await this.search({
      size: 1,
      query: { bool: { filter } }
    });

    const hit = result.hits && result.hits.hits ? result.hits.hits[0] : null;
    return hit ? { id: hit._id, source: hit._source, score: hit._score } : null;
  }

  async stats() {
    const body = {
      size: 0,
      aggs: {
        layers: { terms: { field: 'layer', size: 50 } },
        sources: { terms: { field: 'source', size: 50 } }
      }
    };
    const result = await this.search(body);
    const layers = bucketsToObject(result.aggregations && result.aggregations.layers);
    const sourceAgg = bucketsToObject(result.aggregations && result.aggregations.sources);
    const targets = await this.getAliasTargets();
    const state = await this.readWorkerState();
    const totalDocs = await this.count();

    // Build per-source details from worker state
    const sources = {};
    if (state && state.sources) {
      for (const [name, sourceState] of Object.entries(state.sources)) {
        const staleness = sourceState.last_success_timestamp
          ? Math.floor((Date.now() - new Date(sourceState.last_success_timestamp).getTime()) / 1000)
          : null;
        sources[name] = {
          documents: sourceAgg[name] || 0,
          last_success_at: sourceState.last_success_timestamp || null,
          last_started_at: sourceState.last_started_timestamp || null,
          last_finished_at: sourceState.last_finished_at || sourceState.last_success_timestamp || null,
          staleness_seconds: staleness,
          last_indexed_count: sourceState.last_indexed_count || 0,
          last_deleted_count: sourceState.last_deleted_count || 0,
          last_failed_count: sourceState.last_failed_count || 0
        };
      }
    } else {
      // Fallback keeps the documented freshness shape even when worker state is unavailable.
      for (const [name, count] of Object.entries(sourceAgg)) {
        sources[name] = emptySourceFreshness(count);
      }
    }

    // Health checks
    const staleThreshold = this.config.workerStaleThresholdSeconds || 86400;
    const workerStale = isWorkerStale(state, staleThreshold);

    return {
      documents: {
        venue: layers.venue || 0,
        address: layers.address || 0,
        street: layers.street || 0,
        locality: layers.locality || 0,
        region: layers.region || 0,
        ...layers
      },
      sources,
      total_documents: totalDocs,
      index_name: targets[0] || null,
      alias: this.config.peliasAlias,
      last_indexed_at: latestSourceSuccess(state),
      health: {
        elasticsearch: true,
        alias_exists: targets.length > 0,
        has_documents: totalDocs > 0,
        worker_stale: workerStale
      }
    };
  }

  /**
   * Gets category counts from ES for the categories endpoint.
   */
  async categoryCounts(categoryIds = []) {
    if (Array.isArray(categoryIds) && categoryIds.length > 0) {
      const entries = await Promise.all(categoryIds.map(async id => {
        try {
          const response = await this.es.count({
            index: this.config.peliasAlias,
            body: { query: { term: { category: id } } }
          });
          const body = response.body || response;
          return [id, body.count || 0];
        } catch (_) {
          return [id, 0];
        }
      }));
      return Object.fromEntries(entries);
    }

    try {
      const result = await this.search({
        size: 0,
        aggs: {
          categories: { terms: { field: 'category', size: 500 } }
        }
      });
      const buckets = ((result.aggregations || {}).categories || {}).buckets || [];
      const counts = {};
      for (const bucket of buckets) {
        counts[bucket.key] = bucket.doc_count;
      }
      return counts;
    } catch (_) {
      return {};
    }
  }

  async readWorkerState() {
    try {
      const raw = await fs.readFile(this.config.workerStatePath, 'utf8');
      return JSON.parse(raw);
    } catch (_) {
      return null;
    }
  }
}

function emptySourceFreshness(documents = 0) {
  return {
    documents,
    last_success_at: null,
    last_started_at: null,
    last_finished_at: null,
    staleness_seconds: null,
    last_indexed_count: 0,
    last_deleted_count: 0,
    last_failed_count: 0
  };
}

function bucketsToObject(agg) {
  const out = {};
  for (const bucket of (agg && agg.buckets) || []) {
    out[bucket.key] = bucket.doc_count;
  }
  return out;
}

function latestSourceSuccess(state) {
  const timestamps = Object.values((state && state.sources) || {})
    .map(source => source.last_success_timestamp)
    .filter(Boolean)
    .sort();
  return timestamps.length > 0 ? timestamps[timestamps.length - 1] : null;
}

function isWorkerStale(state, thresholdSeconds) {
  if (!state || !state.sources) return false;
  const timestamps = Object.values(state.sources)
    .map(s => s.last_success_timestamp)
    .filter(Boolean);
  if (timestamps.length === 0) return true;
  const latest = Math.max(...timestamps.map(t => new Date(t).getTime()));
  const ageSec = (Date.now() - latest) / 1000;
  return ageSec > thresholdSeconds;
}

module.exports = EsService;
