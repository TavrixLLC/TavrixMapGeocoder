'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { analyzeQueryExpansion } = require('../src/query-expansion');

test('query expansion: Arabic/Iraqi category synonyms map to canonical categories', () => {
  const cases = [
    ['\u0645\u0637\u0627\u0639\u0645', 'restaurant'],
    ['\u0623\u0643\u0644', 'restaurant'],
    ['\u0645\u0642\u0647\u0649', 'cafe'],
    ['\u0635\u064a\u062f\u0644\u064a\u0627\u062a', 'pharmacy'],
    ['\u0645\u0633\u062a\u0634\u0641\u0649', 'hospital'],
    ['\u0641\u0646\u062f\u0642', 'hotel'],
    ['\u0645\u062d\u0637\u0629 \u0628\u0646\u0632\u064a\u0646', 'fuel'],
    ['\u062d\u0644\u0627\u0642', 'hairdresser'],
    ['\u0635\u0645\u0648\u0646', 'bakery']
  ];

  for (const [text, category] of cases) {
    const expansion = analyzeQueryExpansion(text);
    assert.ok(expansion.categoryIds.includes(category), `${text} should include ${category}`);
  }
});

test('query expansion: Iraqi city spelling variants are recognized', () => {
  const expansion = analyzeQueryExpansion('Bagdad restaurant');
  assert.ok(expansion.categoryIds.includes('restaurant'));
  assert.ok(expansion.placeTerms.includes('baghdad'));
  assert.ok(expansion.placeTerms.includes('\u0628\u063a\u062f\u0627\u062f'));
});

test('query expansion: keeps unmatched business name terms for precise search', () => {
  const expansion = analyzeQueryExpansion('Naranj restaurant Baghdad');
  assert.ok(expansion.categoryIds.includes('restaurant'));
  assert.ok(expansion.placeTerms.includes('baghdad'));
  assert.equal(expansion.unmatchedText, 'naranj');
});
