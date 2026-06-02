'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { loadRankingConfig, getRankingFormula, buildSearchQuery, buildAutocompleteQuery,
  buildStructuredQuery, buildReverseQuery, buildNearbyQuery,
  buildExplainQuery, buildRankingFunctions, normalizeCountryCode } = require('../src/ranking');

// Initialize ranking config
loadRankingConfig();

test('buildSearchQuery: generates multi_match with text', () => {
  const body = buildSearchQuery('restaurant', { size: 10 });
  assert.ok(body.query);
  assert.equal(body.size, 10);
  const boolQuery = body.query.bool || (body.query.function_score && body.query.function_score.query.bool);
  assert.ok(boolQuery);
  assert.ok(boolQuery.must);
  assert.ok(JSON.stringify(boolQuery.must).includes('restaurant'));
});

test('buildSearchQuery: includes focus point decay', () => {
  const body = buildSearchQuery('test', { focusLat: 33.3, focusLon: 44.3 });
  assert.ok(body.query.function_score);
  assert.ok(body.query.function_score.functions.some(fn => fn.gauss));
  assert.ok(body.query.function_score.functions.some(fn => fn.filter && fn.filter.geo_distance));
});

test('buildSearchQuery: applies explicit ranking formula components', () => {
  const body = buildSearchQuery('restaurant', {
    focusLat: 33.3,
    focusLon: 44.3,
    categories: ['restaurant']
  });
  const functions = body.query.function_score.functions;
  assert.ok(functions.some(fn => fn.gauss && fn.gauss.center_point));
  assert.ok(functions.some(fn => fn.field_value_factor && fn.field_value_factor.field === 'popularity'));
  assert.ok(functions.some(fn => fn.field_value_factor && fn.field_value_factor.field === 'importance'));
  assert.ok(functions.some(fn => fn.filter && fn.filter.terms && fn.filter.terms.category_ids));
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

test('buildSearchQuery: boundary.country filters normalized top-level country_a', () => {
  const body = buildSearchQuery('restaurant', { 'boundary.country': 'iq' });
  const boolQuery = body.query.bool || (body.query.function_score && body.query.function_score.query.bool);
  const countryFilter = boolQuery.filter.find(f => f.bool && f.bool.should);
  assert.ok(countryFilter);
  assert.deepEqual(countryFilter.bool.should[0], { term: { country_a: 'IQ' } });
  assert.equal(normalizeCountryCode('iq'), 'IQ');
});

test('buildSearchQuery: category text fields include aliases and source tags', () => {
  const body = buildSearchQuery('\u0645\u0637\u0639\u0645', {});
  const boolQuery = body.query.bool || (body.query.function_score && body.query.function_score.query.bool);
  const serialized = JSON.stringify(boolQuery.must);
  assert.ok(serialized.includes('category_aliases'));
  assert.ok(serialized.includes('category_terms'));
  assert.ok(serialized.includes('intent_groups'));
  assert.ok(serialized.includes('source_tags.amenity'));
  assert.ok(serialized.includes('restaurant'));
});

test('buildSearchQuery: restaurant plus Baghdad requires category and place intent', () => {
  const body = buildSearchQuery('Bagdad restaurant', { focusLat: 33.3152, focusLon: 44.3661 });
  const boolQuery = body.query.function_score.query.bool;
  const serialized = JSON.stringify(boolQuery.must);
  assert.ok(serialized.includes('category_ids'));
  assert.ok(serialized.includes('baghdad'));
  assert.ok(serialized.includes('\u0628\u063a\u062f\u0627\u062f'));
});

test('buildRankingFunctions: Baghdad focus adds strong nearby boosts', () => {
  const functions = buildRankingFunctions({ focusLat: 33.3152, focusLon: 44.3661 });
  const boosts = functions
    .filter(fn => fn.filter && fn.filter.geo_distance)
    .map(fn => fn.weight);
  assert.ok(boosts.includes(40));
  assert.ok(boosts.includes(15));
  assert.ok(boosts.includes(5));
});

test('buildAutocompleteQuery: uses match_phrase_prefix', () => {
  const body = buildAutocompleteQuery('rest', { size: 5 });
  assert.ok(body.query);
  assert.equal(body.size, 5);
  // Should use match_phrase_prefix in should clauses
  const boolQuery = body.query.bool || (body.query.function_score && body.query.function_score.query.bool);
  assert.ok(JSON.stringify(boolQuery.must).includes('match_phrase_prefix'));
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
  assert.ok(body.query.function_score);
  assert.ok(body.aggs);
  assert.ok(body.aggs.layers);
});

test('getRankingFormula: documents score components', () => {
  const formula = getRankingFormula();
  assert.equal(formula.formula, 'final_score = text_relevance + proximity_score + popularity_importance + category_boost + exact_name_boost + layer_boost');
  assert.ok(formula.components.text_relevance);
  assert.ok(formula.components.proximity_score);
  assert.ok(formula.components.popularity_importance);
  assert.ok(formula.components.category_boost);
  assert.ok(formula.components.exact_name_boost);
  assert.ok(formula.components.layer_boost);
});

test('buildRankingFunctions: includes popularity even without focus point', () => {
  const functions = buildRankingFunctions({});
  assert.ok(functions.some(fn => fn.field_value_factor && fn.field_value_factor.field === 'popularity'));
  assert.ok(functions.some(fn => fn.field_value_factor && fn.field_value_factor.field === 'importance'));
});

test('buildSearchQuery: avoids slow wildcard regexp and script_score clauses', () => {
  const body = buildSearchQuery('restaurant Baghdad', { focusLat: 33.3152, focusLon: 44.3661 });
  const serialized = JSON.stringify(body);
  assert.equal(serialized.includes('wildcard'), false);
  assert.equal(serialized.includes('regexp'), false);
  assert.equal(serialized.includes('script_score'), false);
});
