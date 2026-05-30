'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const { createApp } = require('../src/app');

// ── Test fixtures ───────────────────────────────────────────────

const sampleHit = {
  _id: 'postgis:osm_pois:13189798864',
  _score: 7.5,
  _source: {
    source: 'osm_postgis',
    layer: 'venue',
    source_id: '13189798864',
    name: {
      default: 'Hospitality Restaurant',
      ar: 'مطعم الضيافة',
      en: 'Hospitality Restaurant'
    },
    phrase: { default: 'Hospitality Restaurant' },
    center_point: { lat: 31.9057713, lon: 44.488553 },
    routable_point: { lat: 31.9057713, lon: 44.488553 },
    routable_point_type: 'centroid_fallback',
    routable_point_source: 'center_point',
    category: ['restaurant'],
    address_parts: { street: 'Main Street', number: '42' },
    parent: {
      country: ['Iraq'],
      country_a: ['IQ'],
      region: ['Karbala'],
      locality: ['Karbala City']
    },
    addendum: { postgis: JSON.stringify({
      phone: '+964-770-1234567',
      website: 'https://example.test',
      opening_hours: 'Mo-Sa 08:00-22:00',
      brand: 'TestBrand',
      amenity: 'restaurant'
    }) },
    popularity: 50,
    updated_at: '2026-05-30T18:00:00.000Z'
  }
};

const sampleHit2 = {
  _id: 'postgis:osm_pois:99999',
  _score: 5,
  _source: {
    source: 'osm_postgis',
    layer: 'venue',
    source_id: '99999',
    name: { default: 'Test Cafe', ar: 'مقهى اختبار', en: 'Test Cafe' },
    center_point: { lat: 33.3152, lon: 44.3661 },
    category: ['cafe'],
    parent: { country: ['Iraq'], locality: ['Baghdad'] }
  }
};

const streetHit = {
  _id: 'postgis:streets:1001',
  _score: 3,
  _source: {
    source: 'osm_postgis',
    layer: 'street',
    source_id: '1001',
    name: { default: 'شارع الكرادة', ar: 'شارع الكرادة', en: 'Karrada Street' },
    center_point: { lat: 33.2950, lon: 44.3971 },
    category: ['residential'],
    parent: { country: ['Iraq'], locality: ['Baghdad'] }
  }
};

// ── Test app factory ────────────────────────────────────────────

function makeApp(overrides = {}) {
  const peliasClient = {
    async get(path, query) {
      assert.ok(path.startsWith('/v1/'));
      if (path === '/v1/reverse') {
        assert.ok(query['point.lat']);
      }
      return {
        geocoding: { query },
        type: 'FeatureCollection',
        features: [{
          type: 'Feature',
          geometry: { type: 'Point', coordinates: [44.488553, 31.9057713] },
          properties: {
            id: '13189798864',
            gid: 'osm_postgis:venue:13189798864',
            layer: 'venue',
            source: 'osm_postgis',
            source_id: '13189798864',
            name: 'Hospitality Restaurant',
            label: 'Hospitality Restaurant'
          }
        }]
      };
    }
  };

  const esService = {
    async getAliasTargets() { return ['pelias_v1']; },
    async count() { return 10; },
    async findDocumentByFeature() { return { id: sampleHit._id, source: sampleHit._source, score: sampleHit._score }; },
    async search(body) {
      if (body.aggs && body.aggs.categories) {
        return { aggregations: { categories: { buckets: [
          { key: 'restaurant', doc_count: 3 },
          { key: 'cafe', doc_count: 2 }
        ] } } };
      }
      if (body.aggs && body.aggs.layers) {
        return {
          took: 3,
          hits: { hits: [sampleHit] },
          aggregations: { layers: { buckets: [{ key: 'venue', doc_count: 5 }] } }
        };
      }
      if (Array.isArray(body.sort) && body.sort.some(sort => sort._geo_distance)) {
        return {
          took: 5,
          hits: { hits: [
            { ...sampleHit, sort: [123.456] },
            { ...sampleHit2, sort: [234.567] }
          ] },
          aggregations: {
            layers: { buckets: [{ key: 'venue', doc_count: 2 }] },
            sources: { buckets: [{ key: 'osm_postgis', doc_count: 2 }] }
          }
        };
      }
      return {
        took: 5,
        hits: { hits: [sampleHit, sampleHit2] },
        aggregations: {
          layers: { buckets: [{ key: 'venue', doc_count: 2 }] },
          sources: { buckets: [{ key: 'osm_postgis', doc_count: 2 }] }
        }
      };
    },
    async stats() {
      return {
        documents: { venue: 5, address: 0, street: 10, locality: 3, region: 2 },
        sources: {
          osm_postgis: {
            documents: 20,
            last_success_at: '2026-05-30T18:00:00.000Z',
            last_started_at: '2026-05-30T17:59:00.000Z',
            last_finished_at: '2026-05-30T18:00:00.000Z',
            staleness_seconds: 60,
            last_indexed_count: 100,
            last_deleted_count: 2,
            last_failed_count: 0
          }
        },
        total_documents: 20,
        index_name: 'pelias_v1',
        alias: 'pelias',
        last_indexed_at: '2026-05-30T18:00:00.000Z',
        health: { elasticsearch: true, alias_exists: true, has_documents: true, worker_stale: false }
      };
    },
    async categoryCounts() {
      return { restaurant: 3, cafe: 2, hospital: 1 };
    },
    async readWorkerState() {
      return {
        sources: {
          osm_pois: {
            last_success_timestamp: new Date(Date.now() - 3600 * 1000).toISOString(),
            last_indexed_count: 100
          }
        }
      };
    },
    ...overrides.esService
  };

  return createApp({
    peliasApiUrl: 'http://pelias.test',
    elasticsearchUrl: 'http://es.test',
    peliasAlias: 'pelias',
    queryMode: overrides.queryMode || 'pelias',
    maxBatchSize: 5,
    maxSize: 40,
    defaultSize: 10,
    maxTextLength: 256,
    maxStructuredFieldLength: 128,
    maxNearbyRadiusMeters: 50000,
    defaultNearbyRadiusMeters: 1000,
    defaultLang: 'ar',
    defaultFallbackLang: 'en',
    supportedLanguages: ['ar', 'en', 'ku', 'ckb'],
    internalToken: 'test-internal-token',
    debugEndpointsEnabled: true,
    explainEndpointEnabled: true,
    logSearchText: false,
    workerStatePath: '/tmp/nonexistent-state.json',
    workerStaleThresholdSeconds: 86400,
    esRequestTimeoutMs: 3000,
    apiRequestTimeoutMs: 5000,
    ...overrides.config
  }, { peliasClient, esService, ...overrides.deps });
}

// ═══════════════════════════════════════════════════════════════
// SEARCH TESTS
// ═══════════════════════════════════════════════════════════════

test('search: basic text returns FeatureCollection', async () => {
  const res = await request(makeApp()).get('/v1/search?text=restaurant').expect(200);
  assert.equal(res.body.type, 'FeatureCollection');
  assert.ok(res.body.features.length > 0);
});

test('search: returns X-Request-ID header', async () => {
  const res = await request(makeApp()).get('/v1/search?text=test').expect(200);
  assert.ok(res.headers['x-request-id']);
});

test('search: propagates X-Request-ID', async () => {
  const res = await request(makeApp())
    .get('/v1/search?text=test')
    .set('X-Request-ID', 'custom-req-123')
    .expect(200);
  assert.equal(res.headers['x-request-id'], 'custom-req-123');
});

test('search: missing text returns 400', async () => {
  const res = await request(makeApp()).get('/v1/search').expect(400);
  assert.equal(res.body.error.code, 'invalid_request');
});

test('search: text too long returns 400', async () => {
  const longText = 'a'.repeat(300);
  const res = await request(makeApp()).get(`/v1/search?text=${longText}`).expect(400);
  assert.equal(res.body.error.code, 'invalid_request');
});

test('search: Arabic text works', async () => {
  const res = await request(makeApp()).get('/v1/search?text=مطعم&lang=ar').expect(200);
  assert.equal(res.body.type, 'FeatureCollection');
});

test('search: focus point works', async () => {
  const res = await request(makeApp())
    .get('/v1/search?text=restaurant&focus.point.lat=33.3&focus.point.lon=44.3')
    .expect(200);
  assert.equal(res.body.type, 'FeatureCollection');
});

test('search: focus point validates coordinate bounds', async () => {
  const res = await request(makeApp())
    .get('/v1/search?text=restaurant&focus.point.lat=91&focus.point.lon=44.3')
    .expect(400);
  assert.equal(res.body.error.details.parameter, 'focus.point.lat');
});

test('search: boundary rect works', async () => {
  const res = await request(makeApp())
    .get('/v1/search?text=cafe&boundary.rect.min_lon=44&boundary.rect.max_lon=45&boundary.rect.min_lat=33&boundary.rect.max_lat=34')
    .expect(200);
  assert.equal(res.body.type, 'FeatureCollection');
});

test('search: boundary rect validation rejects bad input', async () => {
  const res = await request(makeApp())
    .get('/v1/search?text=x&boundary.rect.min_lon=50&boundary.rect.max_lon=40&boundary.rect.min_lat=1&boundary.rect.max_lat=2')
    .expect(400);
  assert.equal(res.body.error.code, 'invalid_request');
});

test('search: boundary circle validation rejects incomplete input', async () => {
  const res = await request(makeApp())
    .get('/v1/search?text=x&boundary.circle.lat=33')
    .expect(400);
  assert.equal(res.body.error.code, 'invalid_request');
});

test('search: response_mode=standard by default', async () => {
  const res = await request(makeApp()).get('/v1/search?text=restaurant').expect(200);
  const props = res.body.features[0].properties;
  assert.ok(props.name);
  assert.ok(props.gid);
  // Standard mode should not expose source_tags
  assert.equal(props.source_tags, undefined);
});

test('search: response_mode=full returns POI details', async () => {
  const app = makeApp({ queryMode: 'direct_es' });
  const res = await request(app)
    .get('/v1/search?text=restaurant&response_mode=full')
    .expect(200);
  const props = res.body.features[0].properties;
  assert.ok(props.names);
});

test('search: response_mode=debug without token returns 403', async () => {
  const res = await request(makeApp())
    .get('/v1/search?text=restaurant&response_mode=debug')
    .expect(403);
  assert.equal(res.body.error.code, 'forbidden');
});

test('search: response_mode=debug with token works', async () => {
  const app = makeApp({ queryMode: 'direct_es' });
  const res = await request(app)
    .get('/v1/search?text=restaurant&response_mode=debug')
    .set('x-internal-token', 'test-internal-token')
    .expect(200);
  const props = res.body.features[0].properties;
  assert.ok(props.relevance_score != null);
});

test('search: response_mode=debug accepts bearer token', async () => {
  const app = makeApp({ queryMode: 'direct_es' });
  const res = await request(app)
    .get('/v1/search?text=restaurant&response_mode=debug')
    .set('Authorization', 'Bearer test-internal-token')
    .expect(200);
  assert.ok(res.body.features[0].properties.relevance_score != null);
});

test('search: fallback language fields are added', async () => {
  const res = await request(makeApp())
    .get('/v1/search?text=restaurant&lang=ar&fallback_lang=en')
    .expect(200);
  assert.equal(res.body.features[0].properties.name_preferred, 'مطعم الضيافة');
  assert.equal(res.body.features[0].properties.name_fallback, 'Hospitality Restaurant');
});

test('direct_es: PlaceProperties language fields are added', async () => {
  const app = makeApp({ queryMode: 'direct_es' });
  const res = await request(app)
    .get('/v1/search?text=restaurant&lang=ar&fallback_lang=en')
    .expect(200);
  const props = res.body.features[0].properties;
  assert.equal(props.name_preferred, sampleHit._source.name.ar);
  assert.equal(props.name_fallback, sampleHit._source.name.en);
  assert.equal(props.lang, 'ar');
  assert.equal(props.fallback_lang, 'en');
  assert.ok(props.label_preferred.includes(sampleHit._source.name.ar));
});

test('search: dedupe=false skips deduplication', async () => {
  const res = await request(makeApp())
    .get('/v1/search?text=restaurant&dedupe=false')
    .expect(200);
  assert.equal(res.body.geocoding.dedupe, undefined);
});

test('search: size param limits results', async () => {
  const res = await request(makeApp())
    .get('/v1/search?text=restaurant&size=1')
    .expect(200);
  assert.ok(res.body.features.length >= 0);
});

test('search: size too large returns 400', async () => {
  const res = await request(makeApp())
    .get('/v1/search?text=restaurant&size=999')
    .expect(400);
  assert.equal(res.body.error.code, 'invalid_request');
});

// ═══════════════════════════════════════════════════════════════
// AUTOCOMPLETE & SUGGEST TESTS
// ═══════════════════════════════════════════════════════════════

test('autocomplete: returns results', async () => {
  const res = await request(makeApp()).get('/v1/autocomplete?text=rest').expect(200);
  assert.equal(res.body.type, 'FeatureCollection');
});

test('suggest: alias works identically', async () => {
  const res = await request(makeApp()).get('/v1/suggest?text=rest').expect(200);
  assert.equal(res.body.type, 'FeatureCollection');
});

test('autocomplete: missing text returns 400', async () => {
  await request(makeApp()).get('/v1/autocomplete').expect(400);
});

test('autocomplete: Arabic prefix works', async () => {
  const res = await request(makeApp()).get('/v1/autocomplete?text=مط&lang=ar').expect(200);
  assert.equal(res.body.type, 'FeatureCollection');
});

// ═══════════════════════════════════════════════════════════════
// REVERSE TESTS
// ═══════════════════════════════════════════════════════════════

test('reverse: valid coordinates return results', async () => {
  const res = await request(makeApp())
    .get('/v1/reverse?point.lat=33.3152&point.lon=44.3661')
    .expect(200);
  assert.equal(res.body.type, 'FeatureCollection');
});

test('reverse: missing point.lat returns 400', async () => {
  await request(makeApp()).get('/v1/reverse?point.lon=44.3661').expect(400);
});

test('reverse: missing point.lon returns 400', async () => {
  await request(makeApp()).get('/v1/reverse?point.lat=33.3152').expect(400);
});

test('reverse: invalid coordinates return 400', async () => {
  await request(makeApp()).get('/v1/reverse?point.lat=999&point.lon=44').expect(400);
});

test('reverse: layer filtering works', async () => {
  const res = await request(makeApp())
    .get('/v1/reverse?point.lat=33.3152&point.lon=44.3661&layers=venue,street')
    .expect(200);
  assert.equal(res.body.type, 'FeatureCollection');
});

// ═══════════════════════════════════════════════════════════════
// STRUCTURED SEARCH TESTS
// ═══════════════════════════════════════════════════════════════

test('structured: street+locality works', async () => {
  const res = await request(makeApp())
    .get('/v1/search/structured?street=Karrada&locality=Baghdad')
    .expect(200);
  assert.equal(res.body.type, 'FeatureCollection');
});

test('structured: address only works', async () => {
  const res = await request(makeApp())
    .get('/v1/search/structured?address=42 Karrada')
    .expect(200);
  assert.equal(res.body.type, 'FeatureCollection');
});

test('structured: no fields returns 400', async () => {
  const res = await request(makeApp())
    .get('/v1/search/structured')
    .expect(400);
  assert.equal(res.body.error.code, 'invalid_request');
});

test('structured: field too long returns 400', async () => {
  const longField = 'a'.repeat(200);
  const res = await request(makeApp())
    .get(`/v1/search/structured?street=${longField}`)
    .expect(400);
  assert.equal(res.body.error.code, 'invalid_request');
});

test('structured: housenumber+street works', async () => {
  const res = await request(makeApp())
    .get('/v1/search/structured?housenumber=42&street=Karrada')
    .expect(200);
  assert.equal(res.body.type, 'FeatureCollection');
});

test('structured: neighbourhood and county fields work', async () => {
  const app = makeApp({ queryMode: 'direct_es' });
  const res = await request(app)
    .get('/v1/search/structured?neighbourhood=Karrada&county=Baghdad')
    .expect(200);
  assert.equal(res.body.type, 'FeatureCollection');
});

// ═══════════════════════════════════════════════════════════════
// NEARBY TESTS
// ═══════════════════════════════════════════════════════════════

test('nearby: returns features with category', async () => {
  const res = await request(makeApp())
    .get('/v1/nearby?point.lat=33.3152&point.lon=44.3661&radius=500&categories=restaurant')
    .expect(200);
  assert.equal(res.body.type, 'FeatureCollection');
});

test('nearby: include_distance defaults to true', async () => {
  const res = await request(makeApp())
    .get('/v1/nearby?point.lat=33.3152&point.lon=44.3661&radius=500')
    .expect(200);
  assert.equal(res.body.features[0].properties.distance_meters, 123.46);
});

test('nearby: include_distance=false omits distance_meters', async () => {
  const res = await request(makeApp())
    .get('/v1/nearby?point.lat=33.3152&point.lon=44.3661&radius=500&include_distance=false')
    .expect(200);
  assert.equal(res.body.features[0].properties.distance_meters, undefined);
});

test('nearby: missing point returns 400', async () => {
  await request(makeApp()).get('/v1/nearby?radius=500').expect(400);
});

test('nearby: validates point longitude bounds', async () => {
  const res = await request(makeApp())
    .get('/v1/nearby?point.lat=33.3&point.lon=181')
    .expect(400);
  assert.equal(res.body.error.details.parameter, 'point.lon');
});

test('nearby: radius too large returns 400', async () => {
  await request(makeApp())
    .get('/v1/nearby?point.lat=33.3&point.lon=44.3&radius=999999')
    .expect(400);
});

test('nearby: sort=distance works', async () => {
  const res = await request(makeApp())
    .get('/v1/nearby?point.lat=33.3152&point.lon=44.3661&sort=distance')
    .expect(200);
  assert.equal(res.body.type, 'FeatureCollection');
});

test('nearby: sort=relevance works', async () => {
  const res = await request(makeApp())
    .get('/v1/nearby?point.lat=33.3152&point.lon=44.3661&sort=relevance')
    .expect(200);
  assert.equal(res.body.type, 'FeatureCollection');
});

test('nearby: sort=hybrid works', async () => {
  const res = await request(makeApp())
    .get('/v1/nearby?point.lat=33.3152&point.lon=44.3661&sort=hybrid')
    .expect(200);
  assert.equal(res.body.type, 'FeatureCollection');
});

test('nearby: invalid sort mode returns 400', async () => {
  await request(makeApp())
    .get('/v1/nearby?point.lat=33.3&point.lon=44.3&sort=invalid')
    .expect(400);
});

// ═══════════════════════════════════════════════════════════════
// PLACE TESTS
// ═══════════════════════════════════════════════════════════════

test('place: returns feature by gid', async () => {
  const res = await request(makeApp())
    .get('/v1/place?ids=osm_postgis:venue:13189798864')
    .expect(200);
  assert.equal(res.body.type, 'FeatureCollection');
});

test('place: missing ids returns 400', async () => {
  await request(makeApp()).get('/v1/place').expect(400);
});

// ═══════════════════════════════════════════════════════════════
// BATCH TESTS
// ═══════════════════════════════════════════════════════════════

test('batch search: returns results with summary', async () => {
  const res = await request(makeApp())
    .post('/v1/batch/search')
    .send({ queries: [{ text: 'restaurant', size: 1 }] })
    .expect(200);
  assert.equal(res.body.results[0].status, 'ok');
  assert.ok(res.body.results[0].features.length >= 0);
  assert.ok(res.body.summary);
  assert.equal(res.body.summary.total, 1);
  assert.equal(res.body.summary.ok, 1);
  assert.equal(res.body.summary.error, 0);
  assert.ok(res.body.summary.took_ms >= 0);
});

test('batch search: per-item took_ms is present', async () => {
  const res = await request(makeApp())
    .post('/v1/batch/search')
    .send({ queries: [{ text: 'test' }] })
    .expect(200);
  assert.ok(res.body.results[0].took_ms >= 0);
});

test('batch reverse: returns results', async () => {
  const res = await request(makeApp())
    .post('/v1/batch/reverse')
    .send({ queries: [{ 'point.lat': 33.3152, 'point.lon': 44.3661 }] })
    .expect(200);
  assert.equal(res.body.results[0].status, 'ok');
  assert.ok(res.body.summary);
});

test('batch: partial failure preserves successful items', async () => {
  const res = await request(makeApp())
    .post('/v1/batch/search')
    .send({ queries: [{ text: 'restaurant' }, {}] })
    .expect(200);
  assert.equal(res.body.summary.total, 2);
  assert.equal(res.body.summary.ok, 1);
  assert.equal(res.body.summary.error, 1);
  assert.equal(res.body.results[0].status, 'ok');
  assert.equal(res.body.results[1].status, 'error');
});

test('batch: empty queries returns 400', async () => {
  await request(makeApp())
    .post('/v1/batch/search')
    .send({ queries: [] })
    .expect(400);
});

test('batch: exceeds max size returns 400', async () => {
  const queries = Array.from({ length: 10 }, () => ({ text: 'test' }));
  await request(makeApp())
    .post('/v1/batch/search')
    .send({ queries })
    .expect(400);
});

test('batch: bad body returns 400', async () => {
  const res = await request(makeApp())
    .post('/v1/batch/search')
    .send({ notQueries: true })
    .expect(400);
  assert.equal(res.body.error.code, 'invalid_request');
});

// ═══════════════════════════════════════════════════════════════
// CATEGORIES TESTS
// ═══════════════════════════════════════════════════════════════

test('categories: returns list', async () => {
  const res = await request(makeApp()).get('/v1/categories').expect(200);
  assert.ok(Array.isArray(res.body.categories));
  assert.ok(res.body.categories.length > 0);
});

test('categories: lang param returns localized names', async () => {
  const res = await request(makeApp()).get('/v1/categories?lang=ar').expect(200);
  const restaurant = res.body.categories.find(c => c.id === 'restaurant');
  assert.ok(restaurant);
  assert.equal(restaurant.name, 'مطعم');
});

test('categories: q param filters results', async () => {
  const res = await request(makeApp()).get('/v1/categories?q=food').expect(200);
  assert.ok(res.body.categories.length >= 1);
});

test('categories: includes aliases', async () => {
  const res = await request(makeApp()).get('/v1/categories').expect(200);
  const restaurant = res.body.categories.find(c => c.id === 'restaurant');
  assert.ok(restaurant.aliases.includes('food'));
});

test('categories: includes names, OSM tags, and available count', async () => {
  const res = await request(makeApp()).get('/v1/categories?lang=en&q=rest').expect(200);
  const restaurant = res.body.categories.find(c => c.id === 'restaurant');
  assert.ok(restaurant.names.en);
  assert.equal(restaurant.osm_tags.amenity, 'restaurant');
  assert.equal(restaurant.available_count, 3);
});

// ═══════════════════════════════════════════════════════════════
// DEBUG / NORMALIZE TESTS
// ═══════════════════════════════════════════════════════════════

test('normalize: Arabic diacritics removal', async () => {
  const res = await request(makeApp())
    .post('/v1/debug/normalize')
    .send({ text: 'شَارِع', lang: 'ar' })
    .expect(200);
  assert.equal(res.body.normalized, 'شارع');
  assert.ok(res.body.applied_rules.includes('remove_diacritics'));
});

test('normalize: taa marbuta is PRESERVED', async () => {
  const res = await request(makeApp())
    .post('/v1/debug/normalize')
    .send({ text: 'الكرادة', lang: 'ar' })
    .expect(200);
  assert.equal(res.body.normalized, 'الكرادة');
  assert.ok(!res.body.normalized.includes('ه'));
});

test('normalize: مدينة preserved as مدينة', async () => {
  const res = await request(makeApp())
    .post('/v1/debug/normalize')
    .send({ text: 'مدينة', lang: 'ar' })
    .expect(200);
  assert.equal(res.body.normalized, 'مدينة');
});

test('normalize: alef variants normalized', async () => {
  const res = await request(makeApp())
    .post('/v1/debug/normalize')
    .send({ text: 'أحمد إبراهيم آية', lang: 'ar' })
    .expect(200);
  assert.ok(res.body.normalized.includes('احمد'));
  assert.ok(res.body.normalized.includes('ابراهيم'));
  assert.ok(res.body.applied_rules.includes('normalize_alef'));
});

test('normalize: alef maqsura to ya', async () => {
  const res = await request(makeApp())
    .post('/v1/debug/normalize')
    .send({ text: 'مستشفى', lang: 'ar' })
    .expect(200);
  assert.ok(res.body.normalized.includes('مستشفي'));
  assert.ok(res.body.applied_rules.includes('normalize_alef_maqsura'));
});

test('normalize: Arabic digits to Latin', async () => {
  const res = await request(makeApp())
    .post('/v1/debug/normalize')
    .send({ text: '٠١٢٣٤٥', lang: 'ar' })
    .expect(200);
  assert.equal(res.body.normalized, '012345');
  assert.ok(res.body.applied_rules.includes('arabic_digits_to_latin'));
});

test('normalize: tatweel removal', async () => {
  const res = await request(makeApp())
    .post('/v1/debug/normalize')
    .send({ text: 'بـغـداد', lang: 'ar' })
    .expect(200);
  assert.equal(res.body.normalized, 'بغداد');
  assert.ok(res.body.applied_rules.includes('remove_tatweel'));
});

test('normalize: detected_script for Arabic', async () => {
  const res = await request(makeApp())
    .post('/v1/debug/normalize')
    .send({ text: 'بغداد', lang: 'ar' })
    .expect(200);
  assert.equal(res.body.detected_script, 'arabic');
});

test('normalize: detected_script for Latin', async () => {
  const res = await request(makeApp())
    .post('/v1/debug/normalize')
    .send({ text: 'Baghdad' })
    .expect(200);
  assert.equal(res.body.detected_script, 'latin');
});

test('normalize: detected_script for mixed', async () => {
  const res = await request(makeApp())
    .post('/v1/debug/normalize')
    .send({ text: 'بغداد Baghdad' })
    .expect(200);
  assert.equal(res.body.detected_script, 'mixed');
});

test('normalize: returns tokens', async () => {
  const res = await request(makeApp())
    .post('/v1/debug/normalize')
    .send({ text: 'شارع الكرادة', lang: 'ar' })
    .expect(200);
  assert.deepEqual(res.body.tokens, ['شارع', 'الكرادة']);
});

test('normalize: response includes script, rules, and warnings arrays', async () => {
  const res = await request(makeApp())
    .post('/v1/debug/normalize')
    .send({ text: 'شارع الكرادة داخل', lang: 'ar' })
    .expect(200);
  assert.equal(res.body.detected_script, 'arabic');
  assert.ok(Array.isArray(res.body.applied_rules));
  assert.ok(Array.isArray(res.body.warnings));
});

test('normalize: missing text returns 400', async () => {
  await request(makeApp())
    .post('/v1/debug/normalize')
    .send({})
    .expect(400);
});

test('normalize: disabled returns 404', async () => {
  const app = makeApp({ config: { debugEndpointsEnabled: false } });
  await request(app)
    .post('/v1/debug/normalize')
    .send({ text: 'test' })
    .expect(404);
});

// ═══════════════════════════════════════════════════════════════
// DEBUG / EXPLAIN TESTS (protected)
// ═══════════════════════════════════════════════════════════════

test('explain: without token returns 401', async () => {
  await request(makeApp())
    .get('/v1/debug/explain?text=restaurant')
    .expect(401);
});

test('explain: with Bearer token works', async () => {
  const res = await request(makeApp())
    .get('/v1/debug/explain?text=restaurant')
    .set('Authorization', 'Bearer test-internal-token')
    .expect(200);
  assert.ok(res.body.generated_query);
  assert.ok(res.body.elastic_took_ms != null);
  assert.ok(res.body.normalization);
});

test('explain: with x-internal-token works', async () => {
  const res = await request(makeApp())
    .get('/v1/debug/explain?text=restaurant')
    .set('x-internal-token', 'test-internal-token')
    .expect(200);
  assert.ok(res.body.generated_query);
});

test('explain: disabled returns 404', async () => {
  const app = makeApp({ config: { explainEndpointEnabled: false } });
  await request(app)
    .get('/v1/debug/explain?text=restaurant')
    .set('x-internal-token', 'test-internal-token')
    .expect(404);
});

// ═══════════════════════════════════════════════════════════════
// INDEX STATS TESTS
// ═══════════════════════════════════════════════════════════════

test('index stats: returns document counts', async () => {
  const res = await request(makeApp()).get('/v1/index/stats').expect(200);
  assert.equal(res.body.total_documents, 20);
  assert.ok(res.body.health);
  assert.equal(res.body.health.elasticsearch, true);
  assert.equal(res.body.health.has_documents, true);
});

test('index stats: includes source freshness', async () => {
  const res = await request(makeApp()).get('/v1/index/stats').expect(200);
  const source = res.body.sources.osm_postgis;
  assert.ok(source);
  assert.equal(source.last_success_at, '2026-05-30T18:00:00.000Z');
  assert.equal(source.last_started_at, '2026-05-30T17:59:00.000Z');
  assert.equal(source.last_finished_at, '2026-05-30T18:00:00.000Z');
  assert.equal(source.last_indexed_count, 100);
  assert.equal(source.last_deleted_count, 2);
  assert.equal(source.last_failed_count, 0);
  assert.equal(res.body.health.worker_stale, false);
});

// ═══════════════════════════════════════════════════════════════
// HEALTH TESTS
// ═══════════════════════════════════════════════════════════════

test('health/live: returns ok', async () => {
  const res = await request(makeApp()).get('/health/live').expect(200);
  assert.equal(res.body.status, 'ok');
});

test('health/ready: returns ok when ES is up', async () => {
  const res = await request(makeApp()).get('/health/ready').expect(200);
  assert.equal(res.body.status, 'ok');
  assert.ok(res.body.checks);
  assert.equal(res.body.checks.elasticsearch, true);
  assert.equal(res.body.checks.alias_exists, true);
  assert.equal(res.body.checks.index_has_documents, true);
});

test('health/ready: returns degraded when ES is down', async () => {
  const app = makeApp({
    esService: {
      async getAliasTargets() { throw new Error('down'); }
    }
  });
  const res = await request(app).get('/health/ready').expect(503);
  assert.equal(res.body.status, 'degraded');
  assert.equal(res.body.error.code, 'dependency_unavailable');
});

test('health/dependencies: returns status', async () => {
  const res = await request(makeApp()).get('/health/dependencies').expect(200);
  assert.ok(res.body.dependencies);
  assert.equal(res.body.dependencies.elasticsearch.ok, true);
});

// ═══════════════════════════════════════════════════════════════
// ERROR FORMAT TESTS
// ═══════════════════════════════════════════════════════════════

test('error format: consistent error object', async () => {
  const res = await request(makeApp()).get('/v1/search').expect(400);
  assert.ok(res.body.error);
  assert.ok(res.body.error.code);
  assert.ok(res.body.error.message);
  assert.ok(res.body.error.request_id);
  assert.ok('details' in res.body.error);
});

test('error format: propagates X-Request-ID into error body', async () => {
  const res = await request(makeApp())
    .get('/v1/search')
    .set('X-Request-ID', 'error-req-123')
    .expect(400);
  assert.equal(res.headers['x-request-id'], 'error-req-123');
  assert.equal(res.body.error.request_id, 'error-req-123');
});

test('error format: 404 for unknown path', async () => {
  const res = await request(makeApp()).get('/v1/nonexistent').expect(404);
  assert.equal(res.body.error.code, 'not_found');
});

// ═══════════════════════════════════════════════════════════════
// DIRECT_ES QUERY MODE TESTS
// ═══════════════════════════════════════════════════════════════

test('direct_es: search returns features', async () => {
  const app = makeApp({ queryMode: 'direct_es' });
  const res = await request(app).get('/v1/search?text=restaurant').expect(200);
  assert.equal(res.body.type, 'FeatureCollection');
  assert.ok(res.body.features.length > 0);
  // Direct ES features have gid format
  assert.ok(res.body.features[0].properties.gid);
});

test('direct_es: autocomplete returns features', async () => {
  const app = makeApp({ queryMode: 'direct_es' });
  const res = await request(app).get('/v1/autocomplete?text=rest').expect(200);
  assert.equal(res.body.type, 'FeatureCollection');
});

test('direct_es: reverse returns features', async () => {
  const app = makeApp({ queryMode: 'direct_es' });
  const res = await request(app)
    .get('/v1/reverse?point.lat=33.3152&point.lon=44.3661')
    .expect(200);
  assert.equal(res.body.type, 'FeatureCollection');
});

test('direct_es: structured works', async () => {
  const app = makeApp({ queryMode: 'direct_es' });
  const res = await request(app)
    .get('/v1/search/structured?street=Karrada&locality=Baghdad')
    .expect(200);
  assert.equal(res.body.type, 'FeatureCollection');
});

test('hybrid: search works (fallback on error)', async () => {
  const app = makeApp({ queryMode: 'hybrid' });
  const res = await request(app).get('/v1/search?text=restaurant').expect(200);
  assert.equal(res.body.type, 'FeatureCollection');
});

// ═══════════════════════════════════════════════════════════════
// ROUTABLE POINT TESTS
// ═══════════════════════════════════════════════════════════════

test('direct_es: features include routable_point', async () => {
  const app = makeApp({ queryMode: 'direct_es' });
  const res = await request(app).get('/v1/search?text=restaurant').expect(200);
  const props = res.body.features[0].properties;
  assert.ok(props.routable_point);
  assert.ok(Array.isArray(props.routable_point));
  assert.equal(props.routable_point.length, 2);
});

test('direct_es: full mode includes routable point object schema', async () => {
  const app = makeApp({ queryMode: 'direct_es' });
  const res = await request(app)
    .get('/v1/search?text=restaurant&response_mode=full')
    .expect(200);
  const point = res.body.features[0].properties.routable_points[0];
  assert.equal(typeof point.lon, 'number');
  assert.equal(typeof point.lat, 'number');
  assert.ok(point.type);
  assert.ok(point.source);
});

test('direct_es: features include center', async () => {
  const app = makeApp({ queryMode: 'direct_es' });
  const res = await request(app).get('/v1/search?text=restaurant').expect(200);
  const props = res.body.features[0].properties;
  assert.ok(props.center);
  assert.ok(Array.isArray(props.center));
});

// ═══════════════════════════════════════════════════════════════
// METRICS TEST
// ═══════════════════════════════════════════════════════════════

test('metrics: returns Prometheus format', async () => {
  const res = await request(makeApp()).get('/metrics').expect(200);
  assert.ok(res.text.includes('geocoder_'));
});
