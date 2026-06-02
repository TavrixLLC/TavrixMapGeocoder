'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { performance } = require('node:perf_hooks');
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  loadCategoryResolver,
  resetCategoryResolverForTests
} = require('../src/category-resolver');

const taxonomyPath = path.join(__dirname, '..', '..', 'config', 'category-taxonomy.json');

test('category resolver: maps Arabic/Iraqi synonyms to canonical categories', () => {
  const resolver = loadCategoryResolver({ taxonomyPath, forceReload: true });
  const cases = [
    ['\u0645\u0637\u0627\u0639\u0645', 'restaurant'],
    ['\u0623\u0643\u0644', 'restaurant'],
    ['\u0645\u0642\u0647\u0649', 'cafe'],
    ['\u0643\u0627\u0641\u064a\u0647', 'cafe'],
    ['\u0635\u064a\u062f\u0644\u064a\u0627\u062a', 'pharmacy'],
    ['\u0645\u0633\u062a\u0634\u0641\u0649', 'hospital'],
    ['\u0641\u0646\u062f\u0642', 'hotel'],
    ['\u0645\u062d\u0637\u0629 \u0628\u0646\u0632\u064a\u0646', 'fuel'],
    ['\u062d\u0644\u0627\u0642', 'hairdresser'],
    ['\u0635\u0645\u0648\u0646', 'bakery']
  ];

  for (const [text, category] of cases) {
    const resolution = resolver.resolve(text);
    assert.ok(resolution.matched_category_ids.includes(category), `${text} should include ${category}`);
  }
});

test('category resolver: resolves broad intent groups and place variants', () => {
  const resolver = loadCategoryResolver({ taxonomyPath, forceReload: true });
  const food = resolver.resolve('food');
  assert.ok(food.matched_intent_groups.includes('food'));

  const baghdad = resolver.resolve('Bagdad restaurant');
  assert.ok(baghdad.matched_category_ids.includes('restaurant'));
  assert.ok(baghdad.place_terms.includes('baghdad'));
  assert.ok(baghdad.place_terms.includes('\u0628\u063a\u062f\u0627\u062f'));
});

test('category resolver: resolveCategoryAliases canonicalizes user filters', () => {
  const resolver = loadCategoryResolver({ taxonomyPath, forceReload: true });
  assert.deepEqual(resolver.resolveCategoryAliases('coffee,صيدليه'), ['cafe', 'pharmacy']);
});

test('category resolver: resolves from memory without per-request file reads', () => {
  const resolver = loadCategoryResolver({ taxonomyPath, forceReload: true });
  const original = fs.readFileSync;
  fs.readFileSync = () => {
    throw new Error('readFileSync should not be called during resolve');
  };
  try {
    const resolution = resolver.resolve('\u0645\u0637\u0639\u0645');
    assert.ok(resolution.matched_category_ids.includes('restaurant'));
  } finally {
    fs.readFileSync = original;
  }
});

test('category resolver: hot p95 stays below 5ms', () => {
  const resolver = loadCategoryResolver({ taxonomyPath, forceReload: true });
  const samples = [];
  const queries = ['restaurant', '\u0645\u0637\u0639\u0645', 'Bagdad cafe', '\u0635\u064a\u062f\u0644\u064a\u0629 Baghdad'];

  for (let i = 0; i < 1000; i++) {
    const start = performance.now();
    resolver.resolve(queries[i % queries.length]);
    samples.push(performance.now() - start);
  }

  samples.sort((a, b) => a - b);
  const p95 = samples[Math.ceil(samples.length * 0.95) - 1];
  assert.ok(p95 < 5, `category resolver p95 ${p95.toFixed(3)}ms >= 5ms`);
  resetCategoryResolverForTests();
});
