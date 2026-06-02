'use strict';

const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

const {
  runQualityMatrix,
  latencySummary,
  markdownReport
} = require('../scripts/quality-matrix');

test('quality matrix: reports slowest search and autocomplete requests', async () => {
  const result = await runTestMatrix({
    config: matrixConfig({
      warmup_rounds: 0,
      repeats: 3,
      autocomplete: { enabled: true },
      countries: [countryFixture({
        queries: [{ text: 'restaurant', min_results: 1 }],
        autocomplete_queries: [{ text: 'rest', min_results: 1 }]
      })]
    }),
    fetchImpl: makeFetch({
      latencies: [1, 20, 300, 40, 15, 200, 30],
      searchFeatures: [feature({ category: 'restaurant', label: 'Slow Restaurant' })],
      autocompleteFeatures: [feature({ category: 'restaurant', label: 'Slow Autocomplete' })]
    })
  });

  assert.equal(result.report.slowest_requests.search[0].latency_ms, 300);
  assert.equal(result.report.slowest_requests.search[0].country, 'IQ');
  assert.equal(result.report.slowest_requests.search[0].city, 'Baghdad');
  assert.equal(result.report.slowest_requests.search[0].top_result_label, 'Slow Restaurant');
  assert.equal(result.report.slowest_requests.search[0].top_result_category, 'restaurant');

  assert.equal(result.report.slowest_requests.autocomplete[0].latency_ms, 200);
  assert.equal(result.report.slowest_requests.autocomplete[0].endpoint, 'autocomplete');
});

test('quality matrix: excludes index_stats latency from search p95', async () => {
  const result = await runTestMatrix({
    config: matrixConfig({
      warmup_rounds: 0,
      repeats: 3,
      thresholds: { search_max_p95_ms: 100, index_stats_max_ms: 10 }
    }),
    fetchImpl: makeFetch({
      latencies: [1000, 5, 10, 20],
      searchFeatures: [feature()]
    })
  });

  assert.equal(result.report.index_stats_latency_ms, 1000);
  assert.equal(result.report.latency_by_endpoint.search.all.p95_ms, 20);
  assert.ok(result.report.failures.some(failure => failure.code === 'index_stats_latency_exceeded'));
  assert.ok(!result.report.failures.some(failure => failure.code === 'search_p95_latency_exceeded'));
});

test('quality matrix: excludes warmup requests from measured p95', async () => {
  const result = await runTestMatrix({
    config: matrixConfig({
      warmup_rounds: 1,
      repeats: 2,
      thresholds: { search_max_p95_ms: 50 }
    }),
    fetchImpl: makeFetch({
      latencies: [1, 1000, 10, 20],
      searchFeatures: [feature()]
    })
  });

  assert.equal(result.report.latency_by_endpoint.search.warmup.p95_ms, 1000);
  assert.equal(result.report.latency_by_endpoint.search.all.p95_ms, 20);
  assert.equal(result.report.cold_start_requests.some(request => request.endpoint === 'search' && request.phase === 'warmup'), true);
});

test('quality matrix: strict mode fails on search p95 threshold', async () => {
  const result = await runTestMatrix({
    strict: true,
    config: matrixConfig({
      warmup_rounds: 0,
      repeats: 3,
      thresholds: { search_max_p95_ms: 50 }
    }),
    fetchImpl: makeFetch({
      latencies: [1, 10, 20, 120],
      searchFeatures: [feature()]
    })
  });

  assert.equal(result.exit_code, 1);
  assert.ok(result.report.failures.some(failure => failure.code === 'search_p95_latency_exceeded'));
});

test('quality matrix: strict mode fails on autocomplete p95 threshold', async () => {
  const result = await runTestMatrix({
    strict: true,
    config: matrixConfig({
      warmup_rounds: 0,
      repeats: 3,
      autocomplete: { enabled: true },
      thresholds: {
        search_max_p95_ms: 1000,
        autocomplete_max_p95_ms: 50
      },
      countries: [countryFixture({
        queries: [{ text: 'restaurant', min_results: 1 }],
        autocomplete_queries: [{ text: 'rest', min_results: 1 }]
      })]
    }),
    fetchImpl: makeFetch({
      latencies: [1, 5, 5, 5, 10, 120, 130],
      searchFeatures: [feature()],
      autocompleteFeatures: [feature()]
    })
  });

  assert.equal(result.exit_code, 1);
  assert.ok(result.report.failures.some(failure => failure.code === 'autocomplete_p95_latency_exceeded'));
});

test('quality matrix: report contains endpoint-specific latency sections', async () => {
  const result = await runTestMatrix({
    config: matrixConfig({
      warmup_rounds: 0,
      repeats: 1,
      autocomplete: { enabled: true },
      countries: [countryFixture({
        queries: [{ text: 'restaurant', min_results: 1 }],
        autocomplete_queries: [{ text: 'rest', min_results: 1 }]
      })]
    }),
    fetchImpl: makeFetch({
      latencies: [1, 10, 20],
      searchFeatures: [feature()],
      autocompleteFeatures: [feature()]
    })
  });

  const markdown = markdownReport(result.report);
  assert.match(markdown, /## Latency By Endpoint/);
  assert.match(markdown, /## Slowest Search Requests/);
  assert.match(markdown, /## Slowest Autocomplete Requests/);
  assert.match(markdown, /## Failed Thresholds/);
  assert.match(markdown, /\| search \|/);
  assert.match(markdown, /\| autocomplete \|/);
});

test('quality matrix: reports zero-result gaps and country mismatches', async () => {
  const result = await runTestMatrix({
    config: matrixConfig({
      warmup_rounds: 0,
      repeats: 1
    }),
    fetchImpl: makeFetch({
      latencies: [1, 5],
      searchFeatures: [feature({ country_a: 'TR', locality: 'Istanbul' })]
    })
  });

  assert.ok(result.report.failures.some(failure => failure.code === 'country_filter_mismatch'));
  assert.equal(result.report.country_mismatches[0].mismatches[0].country_a, 'TR');

  const zero = await runTestMatrix({
    config: matrixConfig({ warmup_rounds: 0, repeats: 1 }),
    fetchImpl: makeFetch({
      latencies: [1, 5],
      searchFeatures: []
    })
  });
  assert.ok(zero.report.zero_result_gaps.length > 0);
});

test('quality matrix: writes JSON and Markdown reports with raw samples', async () => {
  const result = await runTestMatrix({
    config: matrixConfig({ warmup_rounds: 0, repeats: 2 }),
    fetchImpl: makeFetch({
      latencies: [1, 10, 20],
      searchFeatures: [feature({ country_a: 'IQ', locality: 'Baghdad', category: 'restaurant' })]
    })
  });

  const json = JSON.parse(await fs.readFile(result.files.json, 'utf8'));
  const markdown = await fs.readFile(result.files.markdown, 'utf8');

  assert.equal(json.countries[0].search[0].samples.length, 2);
  assert.equal(json.countries[0].search[0].median_latency_ms, 10);
  assert.match(markdown, /Per-Query Latency/);
  assert.deepEqual(latencySummary([5, 10, 20, 300]), {
    count: 4,
    p50_ms: 10,
    p95_ms: 300,
    p99_ms: 300,
    max_ms: 300
  });
});

async function runTestMatrix(options) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'quality-matrix-'));
  return runQualityMatrix({
    outputDir: dir,
    timestamp: '2026-06-02T00:00:00.000Z',
    ...options
  });
}

function matrixConfig(overrides = {}) {
  return {
    base_url: 'http://geocoder.test',
    warmup_rounds: overrides.warmup_rounds ?? 0,
    repeats: overrides.repeats ?? 1,
    thresholds: {
      search_max_p95_ms: 250,
      autocomplete_max_p95_ms: 150,
      index_stats_max_ms: 500,
      max_missing_country_a_ratio: 0.05,
      min_results_per_query: 1,
      ...(overrides.thresholds || {})
    },
    search: { size: 5, ...(overrides.search || {}) },
    autocomplete: { enabled: false, size: 5, ...(overrides.autocomplete || {}) },
    countries: overrides.countries || [countryFixture()]
  };
}

function countryFixture(overrides = {}) {
  return {
    code: 'IQ',
    name: 'Iraq',
    focus: { lat: 33.3152, lon: 44.3661 },
    cities: [{ name: 'Baghdad', focus: { lat: 33.3152, lon: 44.3661 } }],
    queries: [{ text: 'restaurant', min_results: 1 }],
    autocomplete_queries: [{ text: 'rest', min_results: 1 }],
    ...overrides
  };
}

function makeFetch(options = {}) {
  const clock = options.clock || { value: 0 };
  const latencies = options.latencies || [5, 5, 5, 5, 5];
  let calls = 0;

  const fetchImpl = async urlLike => {
    const url = new URL(String(urlLike));
    clock.value += latencies[Math.min(calls, latencies.length - 1)] || 0;
    calls += 1;

    if (url.pathname === '/v1/index/stats') {
      return jsonResponse(options.stats || statsFixture());
    }
    if (url.pathname === '/v1/autocomplete') {
      return jsonResponse({ type: 'FeatureCollection', features: options.autocompleteFeatures || [] });
    }
    if (url.pathname === '/v1/search') {
      return jsonResponse({ type: 'FeatureCollection', features: options.searchFeatures || [] });
    }
    return jsonResponse({ error: 'not found' }, 404);
  };
  fetchImpl.clock = { now: () => clock.value };
  return fetchImpl;
}

function jsonResponse(body, status = 200) {
  return {
    status,
    async json() {
      return body;
    }
  };
}

function feature(props = {}) {
  return {
    type: 'Feature',
    properties: {
      gid: 'osm_postgis:venue:1',
      name: 'Hospitality Restaurant',
      label: 'Hospitality Restaurant, Baghdad, Iraq',
      country: 'Iraq',
      country_a: 'IQ',
      locality: 'Baghdad',
      category: 'restaurant',
      ...props
    }
  };
}

function statsFixture(overrides = {}) {
  return {
    total_documents: 100,
    documents_missing_country_a: { venue: 1 },
    documents_missing_country_a_by_source_config: { osm_pois: 1 },
    documents_by_country_a: { IQ: 99 },
    ...overrides
  };
}
