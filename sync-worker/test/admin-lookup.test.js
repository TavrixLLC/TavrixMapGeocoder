'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const AdminLookup = require('../src/admin-lookup');

const boundarySource = {
  name: 'admin_boundaries',
  geometry_field: 'way',
  sql: "SELECT osm_id, name, country_a, region_a, admin_level, way FROM admin_boundaries WHERE boundary = 'administrative'"
};

const source = { name: 'osm_pois' };
const logger = { info() {}, warn() {}, error() {} };

function makeLookup(rows) {
  const calls = [];
  const postgisReader = {
    async queryReadOnly(sql, params) {
      calls.push({ sql, params });
      return rows;
    }
  };
  const lookup = new AdminLookup({
    admin_enrichment: {
      enabled: true,
      boundaries_source: 'admin_boundaries',
      country_admin_level: 2,
      region_admin_level: 4,
      county_admin_level: 6,
      locality_admin_level: 8,
      cache_enabled: false
    },
    sources: [boundarySource]
  }, postgisReader, logger);
  return { lookup, calls };
}

test('adminLookup: batch spatial join enriches country and region without per-row queries', async () => {
  const { lookup, calls } = makeLookup([
    { doc_key: '0', admin_level: '2', name: 'Iraq', country_a: 'IQ' },
    { doc_key: '0', admin_level: '4', name: 'Baghdad Governorate', region_a: 'IQ-BG' }
  ]);
  const docs = [{ id: 'postgis:osm_pois:1', lon: 44.36, lat: 33.31, parent: {} }];

  await lookup.enrichBatch(docs, source);

  assert.equal(calls.length, 1);
  assert.match(calls[0].sql, /ST_Covers/i);
  assert.match(calls[0].sql, /VALUES/i);
  assert.deepEqual(calls[0].params, ['0', 44.36, 33.31]);
  assert.deepEqual(docs[0].parent.country, ['Iraq']);
  assert.deepEqual(docs[0].parent.country_a, ['IQ']);
  assert.deepEqual(docs[0].parent.region, ['Baghdad Governorate']);
  assert.deepEqual(docs[0].parent.region_a, ['IQ-BG']);
  assert.equal(docs[0].admin_enrichment_status, 'enriched');
  assert.equal(docs[0].admin_enrichment_reason, undefined);
});

test('adminLookup: missing country metadata does not drop documents', async () => {
  const { lookup } = makeLookup([]);
  const docs = [{ id: 'postgis:osm_pois:1', lon: 44.36, lat: 33.31, parent: {} }];

  await lookup.enrichBatch(docs, source);

  assert.equal(docs.length, 1);
  assert.equal(docs[0].admin_enrichment_status, 'missing_country');
  assert.equal(docs[0].admin_enrichment_reason, 'no_covering_admin_boundary');
  assert.equal(docs[0].country_a, undefined);
});

test('adminLookup: enriches admin boundary documents through the same batch lookup', async () => {
  const { lookup, calls } = makeLookup([
    { doc_key: '0', admin_level: '2', name: 'Iraq', country_a: 'IQ' },
    { doc_key: '0', admin_level: '4', name: 'Baghdad Governorate', region_a: 'IQ-BG' }
  ]);
  const docs = [{
    id: 'postgis:admin_boundaries:10',
    lon: 44.36,
    lat: 33.31,
    parent: { region: ['Baghdad Governorate'] }
  }];

  await lookup.enrichBatch(docs, { name: 'admin_boundaries' });

  assert.equal(calls.length, 1);
  assert.deepEqual(docs[0].parent.country_a, ['IQ']);
  assert.deepEqual(docs[0].parent.country, ['Iraq']);
  assert.equal(docs[0].country_a, 'IQ');
  assert.equal(docs[0].admin_enrichment_status, 'enriched');
});
