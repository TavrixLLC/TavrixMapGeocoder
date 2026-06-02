'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const RoutablePointLookup = require('../src/routable-point-lookup');
const { buildRoutablePointSnapSql } = require('../src/routable-point-lookup');

const roadsSource = {
  name: 'streets',
  layer: 'street',
  geometry_field: 'way',
  sql: "SELECT osm_id, name, highway, way FROM planet_osm_line WHERE name IS NOT NULL AND highway IS NOT NULL"
};

const source = { name: 'osm_pois', layer: 'venue' };
const logger = { info() {}, warn() {}, error() {} };

function makeLookup(rowsOrFn, options = {}) {
  const calls = [];
  const postgisReader = {
    async queryReadOnly(sql, params, queryOptions) {
      calls.push({ sql, params, queryOptions });
      if (typeof rowsOrFn === 'function') return rowsOrFn(sql, params, queryOptions);
      return rowsOrFn || [];
    }
  };
  const lookup = new RoutablePointLookup({
    routable_point_enrichment: {
      enabled: true,
      mode: 'postgis_nearest_road',
      roads_source: 'streets',
      max_snap_distance_meters: 50,
      batch_size: 500,
      fallback_to_center: true,
      query_timeout_ms: 2500,
      source_srid_if_missing: 3857,
      layers: ['venue', 'address'],
      snap_admin_polygons: false,
      ...options
    },
    sources: [roadsSource]
  }, postgisReader, logger);
  return { lookup, calls };
}

test('routablePointLookup: disabled keeps old behavior', async () => {
  const lookup = new RoutablePointLookup({
    routable_point_enrichment: { enabled: false },
    sources: [roadsSource]
  }, {
    async queryReadOnly() {
      throw new Error('should not query PostGIS');
    }
  }, logger);
  const docs = [{ id: 'postgis:osm_pois:1', layer: 'venue', lat: 33.31, lon: 44.36, routable_point: null }];

  await lookup.enrichBatch(docs, source);

  assert.equal(docs[0].routable_point, null);
  assert.equal(docs[0].routable_point_status, undefined);
});

test('routablePointLookup: batch snap success', async () => {
  const { lookup, calls } = makeLookup([
    { doc_key: '0', lon: 44.3605, lat: 33.3105, distance_meters: 12.4 }
  ]);
  const docs = [{ id: 'postgis:osm_pois:1', layer: 'venue', lat: 33.31, lon: 44.36 }];

  await lookup.enrichBatch(docs, source);

  assert.equal(calls.length, 1);
  assert.match(calls[0].sql, /VALUES/i);
  assert.match(calls[0].sql, /ST_DWithin/i);
  assert.match(calls[0].sql, /::geography/i);
  assert.match(calls[0].sql, /LATERAL/i);
  assert.match(calls[0].sql, /ST_ClosestPoint/i);
  assert.deepEqual(calls[0].params.slice(0, 3), ['0', 44.36, 33.31]);
  assert.equal(calls[0].queryOptions.statementTimeoutMs, 2500);
  assert.deepEqual(docs[0].routable_point, { lat: 33.3105, lon: 44.3605 });
  assert.equal(docs[0].routable_point_status, 'snapped');
  assert.equal(docs[0].routable_point_source, 'postgis_nearest_road');
  assert.equal(docs[0].routable_point_distance_meters, 12.4);
});

test('routablePointLookup: no road falls back to center point', async () => {
  const { lookup } = makeLookup([]);
  const docs = [{ id: 'postgis:osm_pois:1', layer: 'venue', lat: 33.31, lon: 44.36 }];

  await lookup.enrichBatch(docs, source);

  assert.deepEqual(docs[0].routable_point, { lat: 33.31, lon: 44.36 });
  assert.equal(docs[0].routable_point_status, 'centroid_fallback');
  assert.equal(docs[0].routable_point_source, 'center_point');
  assert.equal(docs[0].routable_point_reason, 'no_road_found');
});

test('routablePointLookup: bad SRID does not crash whole sync', async () => {
  const { lookup } = makeLookup(() => {
    throw new Error('Operation on mixed SRID geometries');
  });
  const docs = [{ id: 'postgis:osm_pois:1', layer: 'venue', lat: 33.31, lon: 44.36 }];

  await lookup.enrichBatch(docs, source);

  assert.deepEqual(docs[0].routable_point, { lat: 33.31, lon: 44.36 });
  assert.equal(docs[0].routable_point_status, 'centroid_fallback');
  assert.equal(docs[0].routable_point_reason, 'snap_srid_error');
});

test('routablePointLookup: venue docs can be snapped', async () => {
  const { lookup } = makeLookup([
    { doc_key: '0', lon: 44.1, lat: 33.1, distance_meters: 5 }
  ]);
  const docs = [{ id: 'postgis:osm_pois:1', layer: 'venue', lat: 33, lon: 44 }];

  await lookup.enrichBatch(docs, source);

  assert.equal(docs[0].routable_point_status, 'snapped');
});

test('routablePointLookup: locality and admin docs are not incorrectly snapped', async () => {
  const { lookup, calls } = makeLookup([
    { doc_key: '0', lon: 44.1, lat: 33.1, distance_meters: 5 }
  ]);
  const docs = [{ id: 'postgis:places:1', layer: 'locality', lat: 33, lon: 44 }];

  await lookup.enrichBatch(docs, { name: 'places', layer: 'locality' });

  assert.equal(calls.length, 0);
  assert.deepEqual(docs[0].routable_point, { lat: 33, lon: 44 });
  assert.equal(docs[0].routable_point_status, 'not_applicable');
  assert.equal(docs[0].routable_point_source, 'center_point');
});

test('buildRoutablePointSnapSql: uses batched values and configured missing SRID fallback', () => {
  const { sql, params } = buildRoutablePointSnapSql(roadsSource, {
    max_snap_distance_meters: 75,
    source_srid_if_missing: 3857
  }, [
    { doc: { lon: 44, lat: 33 }, index: 0 },
    { doc: { lon: 45, lat: 34 }, index: 1 }
  ], 3857);

  assert.match(sql, /VALUES \(\$1::text/i);
  assert.match(sql, /ST_ClosestPoint\(r\."way", p\.geom_road_srid\)/i);
  assert.equal(params[6], 75);
  assert.equal(params[7], 75);
});

test('routablePointLookup: query timeout is mapped to statement_timeout fallback', async () => {
  const { lookup } = makeLookup(() => {
    const err = new Error('canceling statement due to statement timeout');
    err.code = '57014';
    throw err;
  });
  const docs = [{ id: 'postgis:osm_pois:1', layer: 'venue', lat: 33.31, lon: 44.36 }];

  await lookup.enrichBatch(docs, source);

  assert.deepEqual(docs[0].routable_point, { lat: 33.31, lon: 44.36 });
  assert.equal(docs[0].routable_point_status, 'centroid_fallback');
  assert.equal(docs[0].routable_point_reason, 'statement_timeout');
});

