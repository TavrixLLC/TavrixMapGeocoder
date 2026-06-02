'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const GEOCODER_URL = process.env.GEOCODER_E2E_URL || 'http://localhost:4000';
const VALHALLA_URL = process.env.VALHALLA_URL || 'http://localhost:8002';
const RUN = process.env.RUN_ROUTING_TESTS === '1';

test('routing integration: top geocoder routable_point can route through Valhalla', { skip: !RUN, timeout: 30000 }, async () => {
  const search = await getJson(GEOCODER_URL, '/v1/search', {
    text: 'restaurant',
    'focus.point.lat': '33.3152',
    'focus.point.lon': '44.3661',
    'boundary.country': 'IQ',
    size: '5',
    response_mode: 'full'
  });

  const points = (search.features || [])
    .map(feature => feature.properties && feature.properties.routable_point)
    .filter(point => Array.isArray(point) && point.length === 2);
  assert.ok(points.length >= 2, 'need at least two routable search results');

  const from = points[0];
  const to = points.find(point => distanceApproxMeters(from, point) > 50) || points[1];
  const route = await postJson(VALHALLA_URL, '/route', {
    locations: [
      { lon: from[0], lat: from[1] },
      { lon: to[0], lat: to[1] }
    ],
    costing: 'auto',
    directions_options: { units: 'kilometers' }
  });

  assert.ok(route.trip || route.directions || route.alternates, 'Valhalla route response has no trip');
});

async function getJson(base, path, query) {
  const url = new URL(path, base);
  for (const [key, value] of Object.entries(query || {})) url.searchParams.set(key, value);
  const response = await fetch(url);
  assert.equal(response.status, 200, `${url} returned ${response.status}`);
  return response.json();
}

async function postJson(base, path, body) {
  const response = await fetch(new URL(path, base), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body)
  });
  assert.equal(response.status, 200, `Valhalla returned ${response.status}`);
  return response.json();
}

function distanceApproxMeters(a, b) {
  const dx = (a[0] - b[0]) * 111320;
  const dy = (a[1] - b[1]) * 110540;
  return Math.sqrt(dx * dx + dy * dy);
}
