'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const Transform = require('../src/transform');
const PeliasDocumentBuilder = require('../src/pelias-document-builder');

const sourceConfig = {
  name: 'osm_pois',
  layer: 'venue',
  source_label: 'osm_postgis',
  id_field: 'osm_id',
  geometry_field: 'way',
  name_fields: ['name', 'name_en', 'name_ar'],
  category_fields: ['amenity', 'shop'],
  address_fields: { number: 'housenumber', name: 'housename' },
  addendum_fields: ['amenity', 'brand', 'phone', 'website', 'opening_hours']
};

const logger = { info() {}, warn() {}, error() {} };

test('transform: creates domain doc with correct id format', () => {
  const transform = new Transform({}, logger);
  const row = {
    osm_id: '12345',
    name: 'Test Place',
    name_en: 'Test Place EN',
    name_ar: 'مكان اختبار',
    amenity: 'restaurant',
    _lat: 33.3152,
    _lon: 44.3661
  };
  const doc = transform.toDomainDoc(sourceConfig, row);
  assert.equal(doc.id, 'postgis:osm_pois:12345');
  assert.equal(doc.recordId, '12345');
  assert.equal(doc.source, 'osm_postgis');
  assert.equal(doc.layer, 'venue');
});

test('transform: extracts multilingual names', () => {
  const transform = new Transform({}, logger);
  const row = {
    osm_id: '1',
    name: 'مطعم',
    name_en: 'Restaurant',
    name_ar: 'مطعم',
    amenity: 'restaurant',
    _lat: 33.3, _lon: 44.3
  };
  const doc = transform.toDomainDoc(sourceConfig, row);
  assert.equal(doc.names.default, 'مطعم');
  assert.equal(doc.names.en, 'Restaurant');
  assert.equal(doc.names.ar, 'مطعم');
});

test('transform: extracts Kurdish name fields', () => {
  const transform = new Transform({}, logger);
  const row = {
    osm_id: '1',
    name: 'Test',
    name_ku: 'تێست',
    amenity: 'cafe',
    _lat: 33.3, _lon: 44.3
  };
  const doc = transform.toDomainDoc(sourceConfig, row);
  assert.equal(doc.names.ku, 'تێست');
});

test('transform: extracts categories from fields', () => {
  const transform = new Transform({}, logger);
  const row = {
    osm_id: '1',
    name: 'Test',
    amenity: 'restaurant',
    shop: null,
    _lat: 33.3, _lon: 44.3
  };
  const doc = transform.toDomainDoc(sourceConfig, row);
  assert.deepEqual(doc.categories, ['restaurant']);
});

test('transform: extracts addendum fields', () => {
  const transform = new Transform({}, logger);
  const row = {
    osm_id: '1',
    name: 'Test',
    amenity: 'restaurant',
    brand: 'TestBrand',
    phone: '+964-770-1234567',
    website: 'https://example.test',
    opening_hours: 'Mo-Sa 08:00-22:00',
    _lat: 33.3, _lon: 44.3
  };
  const doc = transform.toDomainDoc(sourceConfig, row);
  assert.equal(doc.addendum.phone, '+964-770-1234567');
  assert.equal(doc.addendum.website, 'https://example.test');
  assert.equal(doc.addendum.brand, 'TestBrand');
});

test('transform: includes routable_point placeholder', () => {
  const transform = new Transform({}, logger);
  const row = {
    osm_id: '1', name: 'Test', amenity: 'cafe',
    _lat: 33.3, _lon: 44.3
  };
  const doc = transform.toDomainDoc(sourceConfig, row);
  assert.equal(doc.routable_point, null);
  assert.deepEqual(doc.entrances, []);
});

test('transform: throws on missing id field', () => {
  const transform = new Transform({}, logger);
  const row = { name: 'Test', _lat: 33.3, _lon: 44.3 };
  assert.throws(() => transform.toDomainDoc(sourceConfig, row));
});

test('transform: throws on invalid geometry', () => {
  const transform = new Transform({}, logger);
  const row = { osm_id: '1', name: 'Test', _lat: NaN, _lon: 44.3 };
  assert.throws(() => transform.toDomainDoc(sourceConfig, row));
});

test('transform: throws on missing name', () => {
  const transform = new Transform({}, logger);
  const row = { osm_id: '1', _lat: 33.3, _lon: 44.3 };
  assert.throws(() => transform.toDomainDoc(sourceConfig, row));
});

// ── PeliasDocumentBuilder tests ─────────────────────────────

test('builder: includes routable_point with centroid_fallback', () => {
  const builder = new PeliasDocumentBuilder();
  const domainDoc = {
    source: 'osm_postgis', layer: 'venue', recordId: '1',
    name: 'Test', names: { default: 'Test', en: 'Test' },
    lat: 33.3, lon: 44.3,
    categories: ['restaurant'], address: {}, parent: {},
    addendum: {}, popularity: null,
    routable_point: null, routable_points: [], entrances: []
  };
  const doc = builder.build(domainDoc);
  assert.ok(doc.routable_point);
  assert.equal(doc.routable_point.lat, 33.3);
  assert.equal(doc.routable_point.lon, 44.3);
  assert.equal(doc.routable_point_type, 'centroid_fallback');
  assert.equal(doc.routable_point_source, 'center_point');
});

test('builder: includes updated_at timestamp', () => {
  const builder = new PeliasDocumentBuilder();
  const domainDoc = {
    source: 'osm_postgis', layer: 'venue', recordId: '1',
    name: 'Test', names: { default: 'Test' },
    lat: 33.3, lon: 44.3,
    categories: [], address: {}, parent: {},
    addendum: {}, popularity: null,
    routable_point: null, routable_points: [], entrances: []
  };
  const doc = builder.build(domainDoc);
  assert.ok(doc.updated_at);
  assert.ok(new Date(doc.updated_at).getTime() > 0);
});
