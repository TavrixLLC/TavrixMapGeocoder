'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { loadRankingConfig, buildSearchQuery, buildAutocompleteQuery,
  buildStructuredQuery, buildReverseQuery, buildNearbyQuery,
  buildExplainQuery } = require('../src/ranking');

// Initialize ranking config
loadRankingConfig();

test('buildSearchQuery: generates multi_match with text', () => {
  const body = buildSearchQuery('restaurant', { size: 10 });
  assert.ok(body.query);
  assert.equal(body.size, 10);
  // Should have a bool query
  const boolQuery = body.query.bool || (body.query.function_score && body.query.function_score.query.bool);
  assert.ok(boolQuery);
  assert.ok(boolQuery.must);
  assert.ok(boolQuery.must[0].multi_match);
  assert.equal(boolQuery.must[0].multi_match.query, 'restaurant');
});

test('buildSearchQuery: includes focus point decay', () => {
  const body = buildSearchQuery('test', { focusLat: 33.3, focusLon: 44.3 });
  assert.ok(body.query.function_score);
  assert.ok(body.query.function_score.functions[0].gauss);
});

test('buildSearchQuery: adds layer filter', () => {
  const body = buildSearchQuery('test', { layers: 'venue,street' });
  const boolQuery = body.query.bool || (body.query.function_score && body.query.function_score.query.bool);
  const filters = boolQuery.filter;
  assert.ok(filters);
  assert.ok(filters.some(f => f.terms && f.terms.layer));
});

test('buildSearchQuery: adds category filter', () => {
  const body = buildSearchQuery('test', { categories: ['restaurant', 'cafe'] });
  const boolQuery = body.query.bool || (body.query.function_score && body.query.function_score.query.bool);
  const filters = boolQuery.filter;
  assert.ok(filters.some(f => f.terms && f.terms.category));
});

test('buildAutocompleteQuery: uses match_phrase_prefix', () => {
  const body = buildAutocompleteQuery('rest', { size: 5 });
  assert.ok(body.query);
  assert.equal(body.size, 5);
  // Should use match_phrase_prefix in should clauses
  const boolQuery = body.query.bool || (body.query.function_score && body.query.function_score.query.bool);
  const must = boolQuery.must[0].bool.should;
  assert.ok(must.some(s => s.match_phrase_prefix));
});

test('buildStructuredQuery: handles street+locality', () => {
  const body = buildStructuredQuery({ street: 'Karrada', locality: 'Baghdad' }, {});
  assert.ok(body.query);
  assert.equal(body._matchType, 'street_only');
});

test('buildStructuredQuery: handles housenumber+street', () => {
  const body = buildStructuredQuery({ housenumber: '42', street: 'Karrada' }, {});
  assert.equal(body._matchType, 'street_only');
});

test('buildStructuredQuery: handles housenumber+street+locality', () => {
  const body = buildStructuredQuery({ housenumber: '42', street: 'Karrada', locality: 'Baghdad' }, {});
  assert.equal(body._matchType, 'exact_address');
});

test('buildStructuredQuery: locality only', () => {
  const body = buildStructuredQuery({ locality: 'Baghdad' }, {});
  assert.equal(body._matchType, 'locality_match');
});

test('buildReverseQuery: generates geo_distance filter', () => {
  const body = buildReverseQuery(33.3, 44.3, { size: 1, radius: 500 });
  assert.equal(body.size, 1);
  assert.ok(body.query.bool.filter.some(f => f.geo_distance));
  assert.ok(body.sort);
  assert.ok(body.sort[0]._geo_distance);
});

test('buildReverseQuery: default layers are venue,address,street', () => {
  const body = buildReverseQuery(33.3, 44.3, {});
  const filters = body.query.bool.filter;
  const termFilters = filters.filter(f => f.terms && f.terms.layer);
  assert.ok(termFilters.length > 0);
  assert.ok(termFilters[0].terms.layer.includes('venue'));
});

test('buildNearbyQuery: distance sort', () => {
  const body = buildNearbyQuery({
    'point.lat': '33.3', 'point.lon': '44.3',
    sort: 'distance', categories: 'restaurant'
  });
  assert.ok(body.sort[0]._geo_distance);
});

test('buildNearbyQuery: relevance sort', () => {
  const body = buildNearbyQuery({
    'point.lat': '33.3', 'point.lon': '44.3',
    sort: 'relevance', categories: 'restaurant'
  });
  assert.ok(body.sort[0]._score);
});

test('buildNearbyQuery: hybrid sort', () => {
  const body = buildNearbyQuery({
    'point.lat': '33.3', 'point.lon': '44.3',
    sort: 'hybrid', categories: 'restaurant'
  });
  assert.ok(body.query.function_score);
});

test('buildNearbyQuery: category_mode=all uses per-term filters', () => {
  const body = buildNearbyQuery({
    'point.lat': '33.3', 'point.lon': '44.3',
    categories: 'restaurant,cafe', category_mode: 'all'
  });
  const filters = body.query.bool.filter;
  const termFilters = filters.filter(f => f.term && f.term.category);
  assert.equal(termFilters.length, 2);
});

test('buildExplainQuery: generates explain body', () => {
  const body = buildExplainQuery({ layers: 'venue' }, 'test');
  assert.ok(body.query);
  assert.ok(body.aggs);
  assert.ok(body.aggs.layers);
});
