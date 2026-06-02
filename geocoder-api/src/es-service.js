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

  async clusterHealth() {
    const response = await this.es.cluster.health({});
    return response.body || response;
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
        sources: { terms: { field: 'source', size: 50 } },
        source_configs: { terms: { field: 'source_config', size: 100 } },
        countries: { terms: { field: 'country_a', size: 500 } },
        missing_country_a: {
          filter: { bool: { must_not: [{ exists: { field: 'country_a' } }] } },
          aggs: {
            layers: { terms: { field: 'layer', size: 50 } },
            source_configs: { terms: { field: 'source_config', size: 100 } },
            reasons: { terms: { field: 'admin_enrichment_reason', size: 50 } },
            statuses: { terms: { field: 'admin_enrichment_status', size: 50 } },
            samples: {
              top_hits: {
                size: 10,
                _source: {
                  includes: [
                    'source',
                    'source_config',
                    'layer',
                    'source_id',
                    'name',
                    'admin_enrichment_status',
                    'admin_enrichment_reason',
                    'center_point'
                  ]
                }
              }
            }
          }
        }
      }
    };
    const result = await this.search(body);
    const layers = bucketsToObject(result.aggregations && result.aggregations.layers);
    const sourceAgg = bucketsToObject(result.aggregations && result.aggregations.sources);
    const sourceConfigAgg = bucketsToObject(result.aggregations && result.aggregations.source_configs);
    const countryAgg = bucketsToObject(result.aggregations && result.aggregations.countries);
    const missingCountryByLayer = bucketsToObject(
      result.aggregations
      && result.aggregations.missing_country_a
      && result.aggregations.missing_country_a.layers
    );
    const missingCountryBySourceConfig = bucketsToObject(
      result.aggregations
      && result.aggregations.missing_country_a
      && result.aggregations.missing_country_a.source_configs
    );
    const missingCountryReasons = bucketsToObject(
      result.aggregations
      && result.aggregations.missing_country_a
      && result.aggregations.missing_country_a.reasons
    );
    const adminEnrichmentStatusCounts = bucketsToObject(
      result.aggregations
      && result.aggregations.missing_country_a
      && result.aggregations.missing_country_a.statuses
    );
    const missingCountrySamples = sampleHits(
      result.aggregations
      && result.aggregations.missing_country_a
      && result.aggregations.missing_country_a.samples
    );
    const targets = await this.getAliasTargets();
    const state = await this.readWorkerState();
    const syncConfig = await this.readSyncConfig();
    const totalDocs = await this.count();

    // Build per-source details from worker state
    const sources = {};
    if (state && state.sources) {
      for (const [name, sourceState] of Object.entries(state.sources)) {
        const staleness = sourceState.last_success_timestamp
          ? Math.floor((Date.now() - new Date(sourceState.last_success_timestamp).getTime()) / 1000)
          : null;
        sources[name] = {
          documents: sourceConfigAgg[name] || 0,
          last_success_at: sourceState.last_success_timestamp || null,
          last_started_at: sourceState.last_started_timestamp || null,
          last_finished_at: sourceState.last_finished_at || sourceState.last_success_timestamp || null,
          staleness_seconds: staleness,
          freshness_threshold_seconds: sourceThresholdSeconds(name, syncConfig, this.config.workerStaleThresholdSeconds || 86400),
          last_indexed_count: sourceState.last_indexed_count || 0,
          last_deleted_count: sourceState.last_deleted_count || 0,
          last_failed_count: sourceState.last_failed_count || 0,
          last_error: sourceState.last_error || null
        };
      }
    } else {
      // Fallback keeps the documented freshness shape even when worker state is unavailable.
      for (const [name, count] of Object.entries(sourceConfigAgg)) {
        sources[name] = emptySourceFreshness(count);
      }
    }

    // Health checks
    const freshness = sourceFreshness(state, syncConfig, this.config.workerStaleThresholdSeconds || 86400);
    const workerStale = freshness.worker_stale;
    const sourceCountsOk = areSourceCountsOk(state);

    return {
      documents: {
        venue: layers.venue || 0,
        address: layers.address || 0,
        street: layers.street || 0,
        locality: layers.locality || 0,
        region: layers.region || 0,
        ...layers
      },
      documents_missing_country_a: missingCountryByLayer,
      documents_missing_country_a_by_source_config: missingCountryBySourceConfig,
      documents_by_country_a: countryAgg,
      source_config_documents: sourceConfigAgg,
      documents_by_source_config: sourceConfigAgg,
      admin_enrichment_missing_country_reasons: missingCountryReasons,
      admin_enrichment_missing_country_statuses: adminEnrichmentStatusCounts,
      missing_country_a_samples: missingCountrySamples,
      sources,
      total_documents: totalDocs,
      index_name: targets[0] || null,
      alias: this.config.peliasAlias,
      last_indexed_at: latestSourceSuccess(state),
      health: {
        elasticsearch: true,
        alias_exists: targets.length > 0,
        has_documents: totalDocs > 0,
        worker_stale: workerStale,
        source_counts_ok: sourceCountsOk,
        stale_sources: freshness.stale_sources
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

  async readSyncConfig() {
    try {
      const raw = await fs.readFile(this.config.syncConfigPath, 'utf8');
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

function sampleHits(agg) {
  const hits = agg && agg.hits && Array.isArray(agg.hits.hits) ? agg.hits.hits : [];
  return hits.map(hit => {
    const doc = hit._source || {};
    const sourceId = doc.source_id != null ? String(doc.source_id) : hit._id;
    return {
      _id: hit._id,
      gid: `${doc.source || 'unknown'}:${doc.layer || 'venue'}:${sourceId}`,
      source: doc.source || null,
      source_config: doc.source_config || null,
      layer: doc.layer || null,
      source_id: sourceId,
      name: doc.name || null,
      admin_enrichment_status: doc.admin_enrichment_status || null,
      admin_enrichment_reason: doc.admin_enrichment_reason || null,
      center_point: doc.center_point || null
    };
  });
}

function latestSourceSuccess(state) {
  const timestamps = Object.values((state && state.sources) || {})
    .map(source => source.last_success_timestamp)
    .filter(Boolean)
    .sort();
  return timestamps.length > 0 ? timestamps[timestamps.length - 1] : null;
}

function isWorkerStale(state, thresholdSeconds) {
  return sourceFreshness(state, null, thresholdSeconds).worker_stale;
}

function sourceFreshness(state, syncConfig, defaultThresholdSeconds = 86400) {
  if (!state || !state.sources) return { worker_stale: false, stale_sources: [] };
  const sources = Object.entries(state.sources);
  if (sources.length === 0) return { worker_stale: false, stale_sources: [] };

  const staleSources = [];
  for (const [name, source] of sources) {
    const threshold = sourceThresholdSeconds(name, syncConfig, defaultThresholdSeconds);
    const lastSuccess = source.last_success_timestamp || null;
    const timestamp = lastSuccess ? new Date(lastSuccess).getTime() : NaN;
    const staleness = Number.isFinite(timestamp)
      ? Math.floor((Date.now() - timestamp) / 1000)
      : null;
    if (!Number.isFinite(timestamp) || staleness > threshold) {
      staleSources.push({
        source: name,
        last_success_at: lastSuccess,
        staleness_seconds: staleness,
        freshness_threshold_seconds: threshold
      });
    }
  }

  return {
    worker_stale: staleSources.length > 0,
    stale_sources: staleSources
  };
}

function sourceThresholdSeconds(sourceName, syncConfig, defaultThresholdSeconds = 86400) {
  const source = syncConfig && Array.isArray(syncConfig.sources)
    ? syncConfig.sources.find(item => item.name === sourceName)
    : null;
  return Number(source && source.stale_after_seconds) || Number(defaultThresholdSeconds) || 86400;
}

function areSourceCountsOk(state) {
  return !Object.values((state && state.sources) || {})
    .some(source => source.last_error && source.last_error.code === 'unexpected_source_drop');
}

module.exports = EsService;
module.exports.sourceFreshness = sourceFreshness;
module.exports.sourceThresholdSeconds = sourceThresholdSeconds;
