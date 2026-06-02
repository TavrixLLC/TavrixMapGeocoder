'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { ResponseCache, stableCacheKey } = require('../src/response-cache');

test('ResponseCache: returns cloned values and expires entries', async () => {
  const cache = new ResponseCache({ ttlMs: 20, maxEntries: 10 });
  cache.set('a', { hits: { hits: [{ id: 1 }] } });
  const first = cache.get('a');
  first.hits.hits[0].id = 2;
  assert.equal(cache.get('a').hits.hits[0].id, 1);

  await new Promise(resolve => setTimeout(resolve, 25));
  assert.equal(cache.get('a'), null);
});

test('stableCacheKey: sorts object keys', () => {
  assert.equal(
    stableCacheKey({ b: 2, a: { d: 4, c: 3 } }),
    stableCacheKey({ a: { c: 3, d: 4 }, b: 2 })
  );
});
