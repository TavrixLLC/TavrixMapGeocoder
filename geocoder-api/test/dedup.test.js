'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { deduplicateFeatures, areDuplicates, areNamesSimilar, haversineMeters } = require('../src/dedup');

function makeFeature(name, lat, lon, extras = {}) {
  return {
    type: 'Feature',
    geometry: { type: 'Point', coordinates: [lon, lat] },
    properties: {
      id: extras.id || '1',
      gid: extras.gid || `osm_postgis:venue:${extras.id || '1'}`,
      layer: extras.layer || 'venue',
      source: extras.source || 'osm_postgis',
      source_id: extras.source_id || extras.id || '1',
      name,
      ...extras
    }
  };
}

test('dedup: removes exact duplicates by gid', () => {
  const features = [
    makeFeature('Test', 33.3, 44.3, { id: '1', gid: 'osm:venue:1' }),
    makeFeature('Test', 33.3, 44.3, { id: '1', gid: 'osm:venue:1' })
  ];
  const result = deduplicateFeatures(features);
  assert.equal(result.features.length, 1);
  assert.equal(result.deduped_count, 1);
});

test('dedup: removes nearby features with same name', () => {
  const features = [
    makeFeature('Restaurant', 33.3000, 44.3000, { id: '1' }),
    makeFeature('Restaurant', 33.3001, 44.3001, { id: '2' }) // ~15m away
  ];
  const result = deduplicateFeatures(features, { distance_threshold_meters: 50 });
  assert.equal(result.features.length, 1);
  assert.equal(result.deduped_count, 1);
});

test('dedup: keeps distant features with same name', () => {
  const features = [
    makeFeature('Restaurant', 33.3, 44.3, { id: '1' }),
    makeFeature('Restaurant', 33.5, 44.5, { id: '2' }) // ~30km away
  ];
  const result = deduplicateFeatures(features);
  assert.equal(result.features.length, 2);
  assert.equal(result.deduped_count, 0);
});

test('dedup: keeps nearby features with different names', () => {
  const features = [
    makeFeature('Restaurant A', 33.3000, 44.3000, { id: '1' }),
    makeFeature('Cafe B', 33.3001, 44.3001, { id: '2' })
  ];
  const result = deduplicateFeatures(features);
  assert.equal(result.features.length, 2);
});

test('dedup: single feature returns unchanged', () => {
  const features = [makeFeature('Test', 33.3, 44.3)];
  const result = deduplicateFeatures(features);
  assert.equal(result.features.length, 1);
  assert.equal(result.deduped_count, 0);
});

test('dedup: empty array returns empty', () => {
  const result = deduplicateFeatures([]);
  assert.equal(result.features.length, 0);
  assert.equal(result.deduped_count, 0);
});

test('areNamesSimilar: exact match', () => {
  assert.ok(areNamesSimilar('Baghdad', 'Baghdad'));
});

test('areNamesSimilar: substring match', () => {
  assert.ok(areNamesSimilar('Baghdad City', 'Baghdad'));
});

test('areNamesSimilar: different names', () => {
  assert.ok(!areNamesSimilar('Baghdad', 'Basra'));
});

test('areNamesSimilar: null handling', () => {
  assert.ok(!areNamesSimilar(null, 'test'));
  assert.ok(!areNamesSimilar('test', null));
});

test('haversineMeters: known distance', () => {
  // Baghdad to Karbala ≈ ~100km
  const dist = haversineMeters(33.3, 44.3, 32.6, 44.0);
  assert.ok(dist > 50000);
  assert.ok(dist < 150000);
});

test('haversineMeters: same point = 0', () => {
  const dist = haversineMeters(33.3, 44.3, 33.3, 44.3);
  assert.ok(dist < 0.01);
});

test('haversineMeters: null coordinates', () => {
  assert.equal(haversineMeters(null, 44.3, 33.3, 44.3), null);
});
