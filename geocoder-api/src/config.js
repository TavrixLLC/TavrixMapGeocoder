'use strict';

require('dotenv').config();

function loadConfig(overrides = {}) {
  return {
    // Server
    port: Number(process.env.PORT || process.env.GEOCODER_API_PORT || 4000),

    // Upstream Pelias API (used in pelias/hybrid query modes)
    peliasApiUrl: process.env.PELIAS_API_URL || 'http://pelias-api:4000',

    // Elasticsearch
    elasticsearchUrl: process.env.ELASTICSEARCH_URL || 'http://elasticsearch:9200',
    peliasAlias: process.env.PELIAS_INDEX_ALIAS || 'pelias',
    esRequestTimeoutMs: Number(process.env.ES_REQUEST_TIMEOUT_MS || 3000),
    esExpectedReplicas: Number(process.env.ES_EXPECTED_REPLICAS || process.env.PELIAS_INDEX_REPLICAS || 0),

    // API request timeout
    apiRequestTimeoutMs: Number(process.env.API_REQUEST_TIMEOUT_MS || 5000),

    // Query mode: 'pelias' | 'direct_es' | 'hybrid'
    queryMode: process.env.GEOCODER_QUERY_MODE || 'hybrid',

    // Worker state
    workerStatePath: process.env.WORKER_STATE_PATH || '/app/state/sync-state.json',
    syncConfigPath: process.env.SYNC_CONFIG_PATH || '/app/config/pelias-postgis-readonly-sync.json',
    workerStaleThresholdSeconds: Number(process.env.WORKER_STALE_THRESHOLD_SECONDS || 86400),

    // Batch
    maxBatchSize: Number(process.env.MAX_BATCH_SIZE || 100),

    // Result limits
    maxSize: Number(process.env.MAX_SIZE || 40),
    defaultSize: Number(process.env.DEFAULT_SIZE || 10),
    searchCacheTtlMs: Number(process.env.SEARCH_CACHE_TTL_MS || 5000),
    searchCacheMaxEntries: Number(process.env.SEARCH_CACHE_MAX_ENTRIES || 1000),
    categoriesCacheTtlMs: Number(process.env.CATEGORIES_CACHE_TTL_MS || 300000),
    categoriesCacheMaxEntries: Number(process.env.CATEGORIES_CACHE_MAX_ENTRIES || 100),
    indexStatsCacheTtlMs: Number(process.env.INDEX_STATS_CACHE_TTL_MS || 30000),
    indexStatsCacheMaxEntries: Number(process.env.INDEX_STATS_CACHE_MAX_ENTRIES || 20),

    // Input limits
    maxTextLength: Number(process.env.MAX_TEXT_LENGTH || 256),
    maxStructuredFieldLength: Number(process.env.MAX_STRUCTURED_FIELD_LENGTH || 128),

    // Nearby limits
    maxNearbyRadiusMeters: Number(process.env.MAX_NEARBY_RADIUS_METERS || 50000),
    defaultNearbyRadiusMeters: Number(process.env.DEFAULT_NEARBY_RADIUS_METERS || 1000),

    // Language
    defaultLang: process.env.DEFAULT_LANG || 'ar',
    defaultFallbackLang: process.env.DEFAULT_FALLBACK_LANG || 'en',
    supportedLanguages: (process.env.SUPPORTED_LANGUAGES || 'ar,en,ku,ckb')
      .split(',').map(l => l.trim()).filter(Boolean),

    // Security
    internalToken: process.env.INTERNAL_TOKEN || process.env.WORKER_INTERNAL_TOKEN || '',
    debugEndpointsEnabled: process.env.DEBUG_ENDPOINTS_ENABLED !== 'false',
    explainEndpointEnabled: process.env.EXPLAIN_ENDPOINT_ENABLED !== 'false',

    // Logging
    logSearchText: process.env.LOG_SEARCH_TEXT === 'true',

    // Config file paths
    categoriesConfigPath: process.env.CATEGORIES_CONFIG_PATH || '',
    categoryTaxonomyPath: process.env.CATEGORY_TAXONOMY_PATH || '',
    categoryLabelsPath: process.env.CATEGORY_LABELS_PATH || '',
    rankingConfigPath: process.env.RANKING_CONFIG_PATH || '',
    synonymsDir: process.env.SYNONYMS_DIR || '',

    ...overrides
  };
}

module.exports = {
  loadConfig
};
