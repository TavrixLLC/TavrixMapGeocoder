'use strict';

const express = require('express');
const { Client: EsClient } = require('@elastic/elasticsearch');
const PeliasClient = require('./pelias-client');
const EsService = require('./es-service');
const ApiMetrics = require('./api-metrics');
const { ApiError, asyncHandler, errorBody, errorMiddleware } = require('./errors');
const { featureFromHit } = require('./feature-builder');
const { normalizeText } = require('./normalizer');
const { enrichFeatureCollection } = require('./response-enricher');
const { deduplicateFeatures } = require('./dedup');
const { loadCategories, listCategories, resolveCategoryAliases } = require('./categories');
const { loadRankingConfig, buildSearchQuery, buildAutocompleteQuery,
  buildStructuredQuery, buildReverseQuery, buildNearbyQuery,
  buildExplainQuery } = require('./ranking');
const { requestIdMiddleware, accessLogMiddleware,
  requireInternalToken, gateDebugResponseMode } = require('./middleware');
const {
  copyAllowed,
  booleanParam,
  integerParam,
  stringParam,
  validateBatchBody,
  validateBoundary,
  validateDedupe,
  validateFocus,
  validateNearbyQuery,
  validateResponseMode,
  validateReverseQuery,
  validateSearchQuery,
  validateStructuredQuery,
  STRUCTURED_FIELDS
} = require('./validation');

function createApp(config, deps = {}) {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '1mb' }));

  // ── Dependencies ──────────────────────────────────────────────
  const esClient = deps.esClient || new EsClient({
    node: config.elasticsearchUrl,
    requestTimeout: config.esRequestTimeoutMs
  });
  const peliasClient = deps.peliasClient || new PeliasClient(config.peliasApiUrl, deps.fetch);
  const esService = deps.esService || new EsService(esClient, config);
  const apiMetrics = deps.apiMetrics || new ApiMetrics();

  // ── Load config files ─────────────────────────────────────────
  loadCategories(config.categoriesConfigPath);
  loadRankingConfig(config.rankingConfigPath);

  // ── Global middleware ─────────────────────────────────────────
  app.use(requestIdMiddleware());
  app.use(accessLogMiddleware(config));
  app.use(gateDebugResponseMode(config));

  // ── Query mode: 'pelias' | 'direct_es' | 'hybrid' ────────────
  const queryMode = config.queryMode || 'pelias';

  // ── Health endpoints ──────────────────────────────────────────

  app.get('/health/live', (_req, res) => res.json({ status: 'ok' }));

  app.get('/health', asyncHandler(async (_req, res) => {
    res.json({ status: 'ok', service: 'geocoder-api' });
  }));

  app.get('/health/ready', asyncHandler(async (req, res) => {
    try {
      const targets = await esService.getAliasTargets();
      const count = await esService.count();
      const state = await esService.readWorkerState();
      const staleThreshold = config.workerStaleThresholdSeconds;
      let workerStale = false;
      if (state && state.sources) {
        const timestamps = Object.values(state.sources)
          .map(s => s.last_success_timestamp).filter(Boolean);
        if (timestamps.length > 0) {
          const latest = Math.max(...timestamps.map(t => new Date(t).getTime()));
          workerStale = (Date.now() - latest) / 1000 > staleThreshold;
        }
      }

      const ready = targets.length > 0 && count > 0 && !workerStale;
      res.status(ready ? 200 : 503).json({
        status: ready ? 'ok' : 'degraded',
        checks: {
          elasticsearch: true,
          alias_exists: targets.length > 0,
          index_has_documents: count > 0,
          worker_stale: workerStale
        },
        documents: count,
        alias: config.peliasAlias,
        index_name: targets[0] || null
      });
    } catch (err) {
      apiMetrics.readinessFailures.inc();
      res.status(503).json({
        status: 'degraded',
        checks: {
          elasticsearch: false,
          alias_exists: false,
          index_has_documents: false,
          worker_stale: false
        },
        error: errorBody('dependency_unavailable', 'Elasticsearch is unavailable', {
          message: err.message
        }, req.requestId).error
      });
    }
  }));

  app.get('/health/dependencies', asyncHandler(async (_req, res) => {
    const deps = { elasticsearch: { ok: false }, pelias_api: { ok: true, url: config.peliasApiUrl } };
    try {
      const targets = await esService.getAliasTargets();
      deps.elasticsearch = { ok: true, alias: config.peliasAlias, targets };
    } catch (err) {
      deps.elasticsearch = { ok: false, alias: config.peliasAlias, error: err.message };
    }
    const allOk = Object.values(deps).every(d => d.ok);
    res.status(allOk ? 200 : 503).json({
      status: allOk ? 'ok' : 'degraded',
      dependencies: deps
    });
  }));

  // ── Metrics ───────────────────────────────────────────────────

  app.get('/metrics', asyncHandler(async (_req, res) => {
    res.set('Content-Type', apiMetrics.registry.contentType);
    res.send(await apiMetrics.registry.metrics());
  }));

  // ── Search ────────────────────────────────────────────────────

  app.get('/v1/search', asyncHandler(async (req, res) => {
    validateSearchQuery(req.query, config);
    const responseMode = validateResponseMode(req.query, config);
    const dedupe = validateDedupe(req.query);
    const options = { response_mode: responseMode };

    const payload = await executeSearch(req.query, queryMode, peliasClient, esService, config, options);
    const enriched = await enrichFeatureCollection(payload, esService, { ...req.query, response_mode: responseMode }, config);
    const result = applyDedupe(enriched, dedupe, config);
    res.json(result);
  }));

  // ── Autocomplete / Suggest ────────────────────────────────────

  const autocompleteHandler = asyncHandler(async (req, res) => {
    validateSearchQuery(req.query, config);
    const responseMode = validateResponseMode(req.query, config);
    const dedupe = validateDedupe(req.query);
    const options = { response_mode: responseMode };

    const payload = await executeAutocomplete(req.query, queryMode, peliasClient, esService, config, options);
    const enriched = await enrichFeatureCollection(payload, esService, { ...req.query, response_mode: responseMode }, config);
    const result = applyDedupe(enriched, dedupe, config);
    res.json(result);
  });

  app.get('/v1/autocomplete', autocompleteHandler);
  app.get('/v1/suggest', autocompleteHandler);

  // ── Reverse ───────────────────────────────────────────────────

  app.get('/v1/reverse', asyncHandler(async (req, res) => {
    validateReverseQuery(req.query, config);
    const responseMode = validateResponseMode(req.query, config);

    const payload = await executeReverse(req.query, queryMode, peliasClient, esService, config, { response_mode: responseMode });
    const enriched = await enrichFeatureCollection(payload, esService, { ...req.query, response_mode: responseMode }, config);
    res.json(enriched);
  }));

  // ── Place ─────────────────────────────────────────────────────

  app.get('/v1/place', asyncHandler(async (req, res) => {
    if (!req.query.ids) throw new ApiError('invalid_request', 'Missing required parameter: ids', 400);
    const responseMode = validateResponseMode(req.query, config);
    const payload = await peliasClient.get('/v1/place', req.query);
    const enriched = await enrichFeatureCollection(payload, esService, { ...req.query, response_mode: responseMode }, config);
    res.json(enriched);
  }));

  // ── Batch Search ──────────────────────────────────────────────

  app.post('/v1/batch/search', asyncHandler(async (req, res) => {
    validateBatchBody(req.body, config.maxBatchSize);
    apiMetrics.batchSize.observe(req.body.queries.length);
    const batchStart = Date.now();
    const results = [];
    let okCount = 0;
    let errorCount = 0;

    for (let i = 0; i < req.body.queries.length; i++) {
      const itemStart = Date.now();
      const item = await runBatchItem(i, req.body.queries[i], req.requestId, async query => {
        validateSearchQuery(query, config);
        const payload = await executeSearch(query, queryMode, peliasClient, esService, config, {});
        const enriched = await enrichFeatureCollection(payload, esService, query, config);
        return { features: enriched.features || [] };
      });
      item.took_ms = Date.now() - itemStart;
      if (item.status === 'ok') okCount++; else errorCount++;
      results.push(item);
    }

    res.json({
      results,
      summary: {
        total: results.length,
        ok: okCount,
        error: errorCount,
        took_ms: Date.now() - batchStart
      }
    });
  }));

  // ── Batch Reverse ─────────────────────────────────────────────

  app.post('/v1/batch/reverse', asyncHandler(async (req, res) => {
    validateBatchBody(req.body, config.maxBatchSize);
    apiMetrics.batchSize.observe(req.body.queries.length);
    const batchStart = Date.now();
    const results = [];
    let okCount = 0;
    let errorCount = 0;

    for (let i = 0; i < req.body.queries.length; i++) {
      const itemStart = Date.now();
      const item = await runBatchItem(i, req.body.queries[i], req.requestId, async query => {
        validateReverseQuery(query, config);
        const payload = await executeReverse(query, queryMode, peliasClient, esService, config, {});
        const enriched = await enrichFeatureCollection(payload, esService, query, config);
        return { features: enriched.features || [] };
      });
      item.took_ms = Date.now() - itemStart;
      if (item.status === 'ok') okCount++; else errorCount++;
      results.push(item);
    }

    res.json({
      results,
      summary: {
        total: results.length,
        ok: okCount,
        error: errorCount,
        took_ms: Date.now() - batchStart
      }
    });
  }));

  // ── Structured Search ─────────────────────────────────────────

  app.get('/v1/search/structured', asyncHandler(async (req, res) => {
    validateStructuredQuery(req.query, config);
    const responseMode = validateResponseMode(req.query, config);
    const dedupe = validateDedupe(req.query);

    const payload = await executeStructuredSearch(req.query, queryMode, peliasClient, esService, config, { response_mode: responseMode });
    const enriched = await enrichFeatureCollection(payload, esService, { ...req.query, response_mode: responseMode }, config);
    const result = applyDedupe(enriched, dedupe, config);
    res.json(result);
  }));

  // ── Nearby ────────────────────────────────────────────────────

  app.get('/v1/nearby', asyncHandler(async (req, res) => {
    validateNearbyQuery(req.query, config);
    const responseMode = validateResponseMode(req.query, config);
    const dedupe = validateDedupe(req.query);
    const includeDistance = booleanParam(req.query, 'include_distance', { defaultValue: true });

    const body = buildNearbyQuery(req.query, config);
    const result = await esService.search(body);
    const collection = featureCollectionFromHits(result, req.query, {
      response_mode: responseMode,
      include_distance: includeDistance
    });
    const final = applyDedupe(collection, dedupe, config);
    res.json(final);
  }));

  // ── Categories ────────────────────────────────────────────────

  app.get('/v1/categories', asyncHandler(async (req, res) => {
    apiMetrics.categoryLookups.inc();
    const lang = stringParam(req.query, 'lang', { allowed: new Set(['ar', 'en', 'ku', 'ckb']) });
    const q = stringParam(req.query, 'q', { maxLength: 128 });
    const categoryIds = listCategories({}).map(category => category.id);
    const counts = await esService.categoryCounts(categoryIds);
    const categories = listCategories({ lang, q, counts });
    res.json({ categories });
  }));

  // ── Debug / Normalize ─────────────────────────────────────────

  app.post('/v1/debug/normalize', asyncHandler(async (req, res) => {
    if (!config.debugEndpointsEnabled) {
      throw new ApiError('not_found', 'Endpoint not found', 404);
    }
    if (!req.body || typeof req.body.text !== 'string') {
      throw new ApiError('invalid_request', 'Body must contain text', 400);
    }
    res.json(normalizeText(req.body.text, req.body.lang));
  }));

  // ── Debug / Explain (protected) ───────────────────────────────

  app.get('/v1/debug/explain', requireInternalToken(config), asyncHandler(async (req, res) => {
    if (!config.explainEndpointEnabled) {
      throw new ApiError('not_found', 'Endpoint not found', 404);
    }
    validateSearchQuery(req.query, config);
    const normalized = normalizeText(req.query.text, req.query.lang);
    const body = buildExplainQuery(req.query, normalized.normalized);
    const result = await esService.search(body);
    const hits = (((result || {}).hits || {}).hits || []).slice(0, 5);
    res.json({
      generated_query: body.query,
      elastic_took_ms: result.took,
      matched_layers: Object.fromEntries(
        (((result.aggregations || {}).layers || {}).buckets || []).map(b => [b.key, b.doc_count])
      ),
      top_results: hits.map(hit => ({
        id: hit._id,
        score: hit._score,
        source_id: hit._source && hit._source.source_id,
        layer: hit._source && hit._source.layer
      })),
      normalization: normalized
    });
  }));

  // ── Index Stats ───────────────────────────────────────────────

  app.get('/v1/index/stats', asyncHandler(async (_req, res) => {
    res.json(await esService.stats());
  }));

  // ── 404 handler ───────────────────────────────────────────────

  app.use((req, res) => {
    res.status(404).json(errorBody('not_found', 'Endpoint not found', {}, req.requestId));
  });

  app.use(errorMiddleware);
  return app;
}

// ── Query mode dispatch ─────────────────────────────────────────

async function executeSearch(query, mode, peliasClient, esService, config, options) {
  if (mode === 'direct_es') {
    return directEsSearch(query, esService, config, options);
  }
  if (mode === 'hybrid') {
    try {
      return await directEsSearch(query, esService, config, options);
    } catch (_) {
      return peliasClient.get('/v1/search', copyAllowed(query));
    }
  }
  // pelias (default)
  return peliasClient.get('/v1/search', copyAllowed(query));
}

async function executeAutocomplete(query, mode, peliasClient, esService, config, options) {
  if (mode === 'direct_es') {
    return directEsAutocomplete(query, esService, config, options);
  }
  if (mode === 'hybrid') {
    try {
      return await directEsAutocomplete(query, esService, config, options);
    } catch (_) {
      return peliasClient.get('/v1/autocomplete', copyAllowed(query));
    }
  }
  return peliasClient.get('/v1/autocomplete', copyAllowed(query));
}

async function executeReverse(query, mode, peliasClient, esService, config, options) {
  if (mode === 'direct_es') {
    return directEsReverse(query, esService, config, options);
  }
  if (mode === 'hybrid') {
    try {
      return await directEsReverse(query, esService, config, options);
    } catch (_) {
      return peliasClient.get('/v1/reverse', query);
    }
  }
  return peliasClient.get('/v1/reverse', query);
}

async function executeStructuredSearch(query, mode, peliasClient, esService, config, options) {
  if (mode === 'direct_es') {
    return directEsStructured(query, esService, config, options);
  }
  if (mode === 'hybrid') {
    try {
      return await directEsStructured(query, esService, config, options);
    } catch (_) {
      // Fallback: concatenate fields into text query
      const text = STRUCTURED_FIELDS.map(f => query[f]).filter(Boolean).join(' ');
      return peliasClient.get('/v1/search', { ...copyAllowed(query), text });
    }
  }
  // pelias: concatenate fields
  const text = STRUCTURED_FIELDS.map(f => query[f]).filter(Boolean).join(' ');
  return peliasClient.get('/v1/search', { ...copyAllowed(query), text });
}

// ── Direct ES query implementations ─────────────────────────────

async function directEsSearch(query, esService, config, options) {
  const normalized = normalizeText(query.text, query.lang);
  const categories = query.categories ? resolveCategoryAliases(query.categories) : undefined;
  const size = integerParam(query, 'size', { min: 1, max: config.maxSize, defaultValue: config.defaultSize });
  const focus = extractFocus(query);

  const body = buildSearchQuery(normalized.normalized, {
    size,
    layers: query.layers,
    sources: query.sources,
    categories,
    focusLat: focus.lat,
    focusLon: focus.lon,
    ...query
  });

  const result = await esService.search(body);
  return featureCollectionFromHits(result, query, options);
}

async function directEsAutocomplete(query, esService, config, options) {
  const normalized = normalizeText(query.text, query.lang);
  const categories = query.categories ? resolveCategoryAliases(query.categories) : undefined;
  const size = integerParam(query, 'size', { min: 1, max: config.maxSize, defaultValue: 5 });
  const focus = extractFocus(query);

  const body = buildAutocompleteQuery(normalized.normalized, {
    size,
    layers: query.layers,
    sources: query.sources,
    categories,
    focusLat: focus.lat,
    focusLon: focus.lon,
    ...query
  });

  const result = await esService.search(body);
  return featureCollectionFromHits(result, query, options);
}

async function directEsReverse(query, esService, config, options) {
  const lat = Number(query['point.lat']);
  const lon = Number(query['point.lon']);
  const size = integerParam(query, 'size', { min: 1, max: config.maxSize, defaultValue: 1 });
  const radius = Number(query.radius) || config.defaultNearbyRadiusMeters || 1000;

  const body = buildReverseQuery(lat, lon, {
    size,
    radius,
    layers: query.layers,
    sources: query.sources,
    ...query
  });

  const result = await esService.search(body);
  return featureCollectionFromHits(result, query, options);
}

async function directEsStructured(query, esService, config, options) {
  const fields = {};
  for (const f of STRUCTURED_FIELDS) {
    if (query[f]) fields[f] = query[f];
  }
  const size = integerParam(query, 'size', { min: 1, max: config.maxSize, defaultValue: config.defaultSize });
  const focus = extractFocus(query);

  const body = buildStructuredQuery(fields, {
    size,
    layers: query.layers,
    sources: query.sources,
    focusLat: focus.lat,
    focusLon: focus.lon,
    ...query
  });

  const matchType = body._matchType;
  delete body._matchType;

  const result = await esService.search(body);
  const collection = featureCollectionFromHits(result, query, options);

  // Annotate features with structured match_type
  for (const feature of collection.features) {
    feature.properties.match_type = matchType;
    feature.properties.confidence = matchType === 'exact_address' ? 1.0
      : matchType === 'street_only' ? 0.7
        : matchType === 'locality_match' ? 0.5
          : 0.3;
  }

  return collection;
}

// ── Helpers ─────────────────────────────────────────────────────

function extractFocus(query) {
  const lat = query['focus.point.lat'] ? Number(query['focus.point.lat']) : undefined;
  const lon = query['focus.point.lon'] ? Number(query['focus.point.lon']) : undefined;
  return { lat, lon };
}

function featureCollectionFromHits(result, query, options = {}) {
  const responseMode = options.response_mode || 'standard';
  return {
    geocoding: {
      version: '0.2',
      query,
      engine: { name: 'TavrixMap Geocoder' },
      timestamp: Date.now()
    },
    type: 'FeatureCollection',
    features: (((result || {}).hits || {}).hits || []).map(hit =>
      featureFromHit(hit, {
        response_mode: responseMode,
        include_distance: options.include_distance,
        lang: query.lang,
        fallback_lang: query.fallback_lang
      })
    )
  };
}

function applyDedupe(collection, dedupe, config) {
  if (dedupe === false || !collection || !Array.isArray(collection.features)) {
    return collection;
  }
  const threshold = 30; // default threshold meters
  const result = deduplicateFeatures(collection.features, {
    distance_threshold_meters: threshold
  });
  collection.features = result.features;
  if (!collection.geocoding) collection.geocoding = {};
  collection.geocoding.dedupe = true;
  collection.geocoding.deduped_count = result.deduped_count;
  return collection;
}

async function runBatchItem(index, query, requestId, fn) {
  try {
    const result = await fn(query || {});
    return {
      index,
      status: 'ok',
      features: result.features
    };
  } catch (err) {
    return {
      index,
      status: 'error',
      error: {
        code: err.code || 'internal_error',
        message: err.message || 'Request failed',
        request_id: requestId || 'unknown',
        details: err.details || {}
      }
    };
  }
}

module.exports = {
  createApp,
  featureCollectionFromHits
};
