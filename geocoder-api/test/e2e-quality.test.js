'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const BASE_URL = process.env.GEOCODER_E2E_URL || 'http://localhost:4000';
const RUN = process.env.RUN_E2E_QUALITY === '1';
const STRICT_CITY_SMOKE = process.env.CITY_SMOKE_STRICT === '1';

const CITIES = [
  'Baghdad',
  'Basra',
  'Erbil',
  'Najaf',
  'Mosul',
  'Sulaymaniyah',
  'Karbala'
];

const QUERIES = [
  '\u0645\u0637\u0639\u0645',
  '\u0635\u064a\u062f\u0644\u064a\u0629',
  '\u0645\u0642\u0647\u0649',
  '\u0645\u0633\u062a\u0634\u0641\u0649',
  '\u0641\u0646\u062f\u0642',
  '\u0645\u062d\u0637\u0629 \u0628\u0646\u0632\u064a\u0646'
];

test('e2e quality: Baghdad-focused restaurant ranks Baghdad first', { skip: !RUN }, async () => {
  const result = await getJson('/v1/search', {
    text: 'restaurant',
    'focus.point.lat': '33.3152',
    'focus.point.lon': '44.3661',
    'boundary.country': 'IQ',
    size: '5'
  });

  assert.ok(result.features.length > 0);
  const props = result.features[0].properties;
  const haystack = [
    props.locality,
    props.region,
    props.label,
    props.name
  ].filter(Boolean).join(' ').toLowerCase();

  assert.match(haystack, /baghdad|\u0628\u063a\u062f\u0627\u062f/);
  assert.equal(props.country_a, 'IQ');
});

test('e2e quality: city/category smoke matrix returns results', { skip: !RUN }, async () => {
  const failures = [];
  for (const city of CITIES) {
    for (const query of QUERIES) {
      const result = await getJson('/v1/search', {
        text: `${query} ${city}`,
        'boundary.country': 'IQ',
        size: '3'
      });
      if (!Array.isArray(result.features) || result.features.length === 0) {
        failures.push(`${query} ${city}`);
        continue;
      }
      assert.equal(result.features[0].properties.country_a, 'IQ');
    }
  }

  if (failures.length > 0) {
    console.warn(`city/category smoke gaps (${failures.length}): ${failures.join('; ')}`);
  }
  if (STRICT_CITY_SMOKE) {
    assert.deepEqual(failures, []);
  }
});

async function getJson(path, query) {
  const url = new URL(path, BASE_URL);
  for (const [key, value] of Object.entries(query || {})) {
    url.searchParams.set(key, value);
  }
  const response = await fetch(url);
  assert.equal(response.status, 200, `${url} returned ${response.status}`);
  return response.json();
}
