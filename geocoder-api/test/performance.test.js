'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const BASE_URL = process.env.GEOCODER_E2E_URL || 'http://localhost:4000';
const RUN = process.env.RUN_PERF_TESTS === '1';
const P95_LIMIT_MS = Number(process.env.SEARCH_P95_LIMIT_MS || 250);
const AUTOCOMPLETE_P95_LIMIT_MS = Number(process.env.AUTOCOMPLETE_P95_LIMIT_MS || 150);

test('performance: search holds p95 under threshold at 100 and 300 RPS', { skip: !RUN, timeout: 120000 }, async () => {
  await warmup();

  const r100 = await runLoad({ rps: 100, durationSeconds: 5 });
  report('100rps', r100);
  assert.equal(r100.failures, 0, `100 RPS had ${r100.failures} failed requests`);
  assert.ok(r100.p95 <= P95_LIMIT_MS, `100 RPS p95 ${r100.p95}ms > ${P95_LIMIT_MS}ms`);

  const r300 = await runLoad({ rps: 300, durationSeconds: 5 });
  report('300rps', r300);
  assert.equal(r300.failures, 0, `300 RPS had ${r300.failures} failed requests`);
  assert.ok(r300.p95 <= P95_LIMIT_MS, `300 RPS p95 ${r300.p95}ms > ${P95_LIMIT_MS}ms`);

  const ac100 = await runLoad({ rps: 100, durationSeconds: 5, endpoint: 'autocomplete' });
  report('autocomplete-100rps', ac100);
  assert.equal(ac100.failures, 0, `autocomplete 100 RPS had ${ac100.failures} failed requests`);
  assert.ok(ac100.p95 <= AUTOCOMPLETE_P95_LIMIT_MS, `autocomplete p95 ${ac100.p95}ms > ${AUTOCOMPLETE_P95_LIMIT_MS}ms`);
});

async function warmup() {
  const requests = [];
  for (let i = 0; i < 30; i++) {
    requests.push(searchOnce(i));
  }
  await Promise.all(requests);
}

async function runLoad({ rps, durationSeconds, endpoint = 'search' }) {
  const total = rps * durationSeconds;
  const intervalMs = 1000 / rps;
  const startedAt = Date.now();
  const latencies = [];
  let failures = 0;

  await Promise.all(Array.from({ length: total }, (_, index) => new Promise(resolve => {
    const dueMs = Math.max(0, Math.round(index * intervalMs - (Date.now() - startedAt)));
    setTimeout(async () => {
      const t0 = Date.now();
      try {
        await requestOnce(index, endpoint);
        latencies.push(Date.now() - t0);
      } catch (_) {
        failures++;
      }
      resolve();
    }, dueMs);
  })));

  latencies.sort((a, b) => a - b);
  return {
    rps,
    total,
    ok: latencies.length,
    failures,
    p50: percentile(latencies, 50),
    p95: percentile(latencies, 95),
    p99: percentile(latencies, 99)
  };
}

async function searchOnce(index) {
  return requestOnce(index, 'search');
}

async function requestOnce(index, endpoint) {
  const queries = [
    ['restaurant', '33.3152', '44.3661'],
    ['\u0645\u0637\u0639\u0645', '33.3152', '44.3661'],
    ['pharmacy Baghdad', '33.3152', '44.3661'],
    ['\u0645\u0642\u0647\u0649 Basra', '30.5085', '47.7804']
  ];
  const [text, lat, lon] = queries[index % queries.length];
  const url = new URL(endpoint === 'autocomplete' ? '/v1/autocomplete' : '/v1/search', BASE_URL);
  url.searchParams.set('text', text);
  url.searchParams.set('focus.point.lat', lat);
  url.searchParams.set('focus.point.lon', lon);
  url.searchParams.set('boundary.country', 'IQ');
  url.searchParams.set('size', '5');
  const response = await fetch(url);
  if (response.status !== 200) {
    throw new Error(`search returned ${response.status}`);
  }
  await response.arrayBuffer();
}

function percentile(sorted, p) {
  if (sorted.length === 0) return Infinity;
  const index = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[index];
}

function report(label, result) {
  console.log(`${label}: ok=${result.ok}/${result.total} failures=${result.failures} p50=${result.p50}ms p95=${result.p95}ms p99=${result.p99}ms`);
}
