'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { validateConfig } = require('../src/config-validator');
const syncConfig = require('../../config/pelias-postgis-readonly-sync.json');

function baseConfig(sql) {
  return {
    worker: { mode: 'scheduled', dry_run: false, health_port: 9090 },
    postgis: {
      statement_timeout_ms: 1000,
      idle_in_transaction_session_timeout_ms: 1000,
      fetch_size: 100
    },
    elasticsearch: {
      url: 'http://elasticsearch:9200',
      read_alias: 'pelias',
      write_alias: 'pelias_write',
      index_prefix: 'pelias',
      initial_index: 'pelias_v1',
      request_timeout_ms: 1000,
      max_retries: 1,
      retry_base_delay_ms: 1,
      max_bulk_docs: 100,
      max_bulk_bytes: 1024
    },
    state: { path: '/tmp/sync-state.json', store_seen_ids: true },
    sources: [{
      name: 'osm_pois',
      layer: 'venue',
      source_label: 'osm_postgis',
      id_field: 'osm_id',
      geometry_field: 'way',
      sql,
      name_fields: ['name'],
      delete_strategy: 'source_diff'
    }]
  };
}

test('validateConfig: rejects row-locking SELECT clauses', () => {
  assert.throws(
    () => validateConfig(baseConfig('SELECT osm_id, name, way FROM planet_osm_point WHERE name IS NOT NULL FOR UPDATE')),
    /row-locking/
  );
});

test('validateConfig: rejects unfiltered planet_osm scans', () => {
  assert.throws(
    () => validateConfig(baseConfig('SELECT osm_id, name, way FROM planet_osm_point')),
    /WHERE clause/
  );
});

test('validateConfig: accepts filtered read-only source SQL', () => {
  assert.doesNotThrow(() => validateConfig(baseConfig(
    "SELECT osm_id, name, way FROM planet_osm_point WHERE name IS NOT NULL AND amenity IS NOT NULL"
  )));
});

test('validateConfig: validates routable point enrichment config when enabled', () => {
  const config = baseConfig("SELECT osm_id, name, way FROM planet_osm_point WHERE name IS NOT NULL AND amenity IS NOT NULL");
  config.sources.push({
    name: 'streets',
    layer: 'street',
    source_label: 'osm_postgis',
    id_field: 'osm_id',
    geometry_field: 'way',
    sql: "SELECT osm_id, name, highway, way FROM planet_osm_line WHERE name IS NOT NULL AND highway IS NOT NULL",
    name_fields: ['name'],
    delete_strategy: 'source_diff'
  });
  config.routable_point_enrichment = {
    enabled: true,
    mode: 'postgis_nearest_road',
    roads_source: 'streets',
    max_snap_distance_meters: 50,
    batch_size: 100,
    fallback_to_center: true
  };

  assert.doesNotThrow(() => validateConfig(config));
});

test('validateConfig: rejects missing routable roads source', () => {
  const config = baseConfig("SELECT osm_id, name, way FROM planet_osm_point WHERE name IS NOT NULL AND amenity IS NOT NULL");
  config.routable_point_enrichment = {
    enabled: true,
    mode: 'postgis_nearest_road',
    roads_source: 'missing_roads',
    max_snap_distance_meters: 50,
    batch_size: 100,
    fallback_to_center: true
  };

  assert.throws(() => validateConfig(config), /roads_source not found/);
});

test('validateConfig: rejects unsafe SQL on routable roads source', () => {
  const config = baseConfig("SELECT osm_id, name, way FROM planet_osm_point WHERE name IS NOT NULL AND amenity IS NOT NULL");
  config.sources.push({
    name: 'streets',
    layer: 'street',
    source_label: 'osm_postgis',
    id_field: 'osm_id',
    geometry_field: 'way',
    sql: "SELECT osm_id, name, highway, way FROM planet_osm_line WHERE name IS NOT NULL FOR UPDATE",
    name_fields: ['name'],
    delete_strategy: 'source_diff'
  });
  config.routable_point_enrichment = {
    enabled: true,
    mode: 'postgis_nearest_road',
    roads_source: 'streets',
    max_snap_distance_meters: 50,
    batch_size: 100,
    fallback_to_center: true
  };

  assert.throws(() => validateConfig(config), /row-locking/);
});

test('source config: keeps planet_osm reads filtered and POIs scoped to allowed named categories', () => {
  assert.doesNotThrow(() => validateConfig(syncConfig));
  assert.equal(syncConfig.worker.default_country, undefined);
  assert.equal(syncConfig.worker.default_country_a, undefined);
  assert.equal(syncConfig.admin_enrichment.enabled, true);
  assert.equal(syncConfig.admin_enrichment.boundaries_source, 'admin_boundaries');
  assert.equal(syncConfig.routable_point_enrichment.enabled, false);
  assert.equal(syncConfig.routable_point_enrichment.roads_source, 'streets');

  const sources = Object.fromEntries(syncConfig.sources.map(source => [source.name, source]));
  const pois = sources.osm_pois;
  assert.match(pois.sql, /\bfrom\s+planet_osm_point\b/i);
  assert.match(pois.sql, /\bwhere\b/i);
  assert.match(pois.sql, /\bname\s+is\s+not\s+null\b/i);
  assert.match(pois.sql, /\bname\s+<>\s+''/i);

  for (const field of ['amenity', 'shop', 'tourism', 'leisure', 'office']) {
    assert.match(pois.sql, new RegExp(`\\b${field}\\s+is\\s+not\\s+null\\b`, 'i'));
    assert.ok(pois.category_fields.includes(field));
    assert.ok(pois.addendum_fields.includes(field));
  }
  assert.doesNotMatch(pois.sql, /\bhistoric\b/i);
  assert.ok(!pois.category_fields.includes('historic'));
  assert.ok(!pois.addendum_fields.includes('historic'));

  assert.match(sources.streets.sql, /\bhighway\s+in\s+\(/i);
  assert.match(sources.admin_boundaries.sql, /\bboundary\s*=\s*'administrative'/i);
  assert.match(sources.admin_boundaries.sql, /\badmin_level\s+in\s+\(/i);
  assert.match(sources.admin_boundaries.sql, /'2'/);
  assert.match(sources.admin_boundaries.sql, /'4'/);
  assert.match(sources.admin_boundaries.sql, /'6'/);
  assert.match(sources.admin_boundaries.sql, /'8'/);

  for (const source of syncConfig.sources) {
    if (/\bfrom\s+planet_osm_/i.test(source.sql)) {
      assert.match(source.sql, /\bwhere\b/i, `${source.name} must not scan planet_osm blindly`);
    }
  }
});
