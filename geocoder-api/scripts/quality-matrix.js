'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const DEFAULT_CONFIG_PATH = path.join(REPO_ROOT, 'config', 'quality-matrix.json');
const DEFAULT_REPORT_DIR = path.join(REPO_ROOT, 'reports');

async function main() {
  const configPath = process.env.COUNTRY_QUALITY_CONFIG || DEFAULT_CONFIG_PATH;
  const config = await loadMatrixConfig(configPath);
  const strict = process.env.COUNTRY_QUALITY_STRICT === '1';
  const result = await runQualityMatrix({
    config,
    strict,
    outputDir: resolveOutputDir(config.output_dir)
  });

  console.log(`Country quality matrix ${result.report.ok ? 'passed' : 'failed'}`);
  console.log(`JSON report: ${result.files.json}`);
  console.log(`Markdown report: ${result.files.markdown}`);

  if (strict && !result.report.ok) {
    for (const failure of result.report.failures) {
      console.error(`- ${failure.code}: ${failure.message}`);
    }
    process.exit(1);
  }
}

async function loadMatrixConfig(configPath = DEFAULT_CONFIG_PATH) {
  const raw = await fs.readFile(configPath, 'utf8');
  return normalizeConfig(JSON.parse(raw));
}

async function runQualityMatrix(options = {}) {
  const config = normalizeConfig(options.config || {});
  const fetchImpl = options.fetchImpl || global.fetch;
  if (typeof fetchImpl !== 'function') {
    throw new Error('Country quality matrix runner requires fetch support');
  }

  const strict = Boolean(options.strict);
  const clock = options.clock || fetchImpl.clock || { now: () => Date.now() };
  const timestamp = options.timestamp || new Date(clock.now()).toISOString();
  const baseUrl = options.baseUrl || config.base_url;
  const outputDir = options.outputDir || resolveOutputDir(config.output_dir);
  const enabledCountries = config.countries.filter(country => country.enabled !== false);
  const endpointState = { seen: new Set() };
  const allRequests = [];

  const report = {
    generated_at: timestamp,
    base_url: baseUrl,
    strict,
    warmup_rounds: config.warmup_rounds,
    repeats: config.repeats,
    thresholds: config.thresholds,
    countries_tested: enabledCountries.map(country => country.code),
    index_stats: null,
    index_stats_latency_ms: null,
    missing_country_a: null,
    latency_by_endpoint: {},
    endpoint_latency: {},
    slowest_requests: { search: [], autocomplete: [] },
    per_query_latency: [],
    cold_start_requests: [],
    countries: [],
    failures: []
  };

  const statsRequest = await runRawRequest({
    fetchImpl,
    baseUrl,
    endpoint: '/v1/index/stats',
    endpointName: 'index_stats',
    params: {},
    clock,
    endpointState,
    phase: 'measured',
    counted: true
  });
  allRequests.push(statsRequest);
  report.index_stats = statsRequest.json;
  report.index_stats_latency_ms = statsRequest.latency_ms;
  report.missing_country_a = summarizeMissingCountryA(statsRequest.json);

  for (const country of enabledCountries) {
    const countryReport = {
      code: country.code,
      name: country.name || country.code,
      search: [],
      autocomplete: []
    };

    const searchTasks = endpointTasks({ config, country, endpointName: 'search' });
    const autocompleteTasks = config.autocomplete.enabled && country.autocomplete !== false
      ? endpointTasks({ config, country, endpointName: 'autocomplete' })
      : [];

    await runWarmupTasks({
      fetchImpl,
      baseUrl,
      tasks: [...searchTasks, ...autocompleteTasks],
      clock,
      endpointState,
      allRequests,
      rounds: config.warmup_rounds
    });

    countryReport.search = await runMeasuredTasks({
      fetchImpl,
      baseUrl,
      tasks: searchTasks,
      clock,
      endpointState,
      allRequests,
      repeats: config.repeats
    });

    countryReport.autocomplete = await runMeasuredTasks({
      fetchImpl,
      baseUrl,
      tasks: autocompleteTasks,
      clock,
      endpointState,
      allRequests,
      repeats: config.repeats
    });

    report.countries.push(countryReport);
  }

  report.cold_start_requests = allRequests
    .filter(request => request.cold_start)
    .map(requestSummary);
  report.latency_by_endpoint = latencyByEndpoint(allRequests);
  report.endpoint_latency = report.latency_by_endpoint;
  report.slowest_requests = {
    search: slowestRequests(allRequests, 'search', 10),
    autocomplete: slowestRequests(allRequests, 'autocomplete', 10)
  };
  report.per_query_latency = perQueryLatency(report.countries);
  report.failures = evaluateFailures(report, config.thresholds);
  report.ok = report.failures.length === 0;

  const files = await writeReports(report, outputDir, safeTimestamp(timestamp));
  return { ok: report.ok, exit_code: strict && !report.ok ? 1 : 0, report, files };
}

function endpointTasks({ config, country, endpointName }) {
  const rawQueries = endpointName === 'autocomplete'
    ? (country.autocomplete_queries || country.queries || [])
    : (country.queries || []);
  const size = endpointName === 'autocomplete' ? config.autocomplete.size : config.search.size;
  const cities = countryCities(country);

  const tasks = [];
  for (const city of cities) {
    for (const query of rawQueries) {
      tasks.push({
        endpoint: endpointName === 'autocomplete' ? '/v1/autocomplete' : '/v1/search',
        endpointName,
        country,
        city,
        query,
        size: Number(query.size || city.size || country.size || size),
        min_results: Number(query.min_results
          ?? city.min_results_per_query
          ?? country.min_results_per_query
          ?? config.thresholds.min_results_per_query
          ?? 0)
      });
    }
  }
  return tasks;
}

function countryCities(country) {
  if (Array.isArray(country.cities) && country.cities.length > 0) {
    return country.cities.map(city => ({
      name: city.name || city.city || null,
      focus: city.focus || country.focus || null,
      size: city.size,
      min_results_per_query: city.min_results_per_query
    }));
  }
  return [{
    name: country.city || null,
    focus: country.focus || null,
    size: country.size,
    min_results_per_query: country.min_results_per_query
  }];
}

async function runWarmupTasks(opts) {
  for (let round = 1; round <= opts.rounds; round++) {
    for (const task of opts.tasks) {
      const sample = await runTaskRequest({
        ...opts,
        task,
        phase: 'warmup',
        counted: false,
        warmup_round: round,
        repeat: 0
      });
      opts.allRequests.push(sample);
    }
  }
}

async function runMeasuredTasks(opts) {
  const aggregates = [];
  for (const task of opts.tasks) {
    const measuredSamples = [];
    for (let repeat = 1; repeat <= opts.repeats; repeat++) {
      const sample = await runTaskRequest({
        ...opts,
        task,
        phase: 'measured',
        counted: true,
        repeat
      });
      measuredSamples.push(sample);
      opts.allRequests.push(sample);
    }
    aggregates.push(aggregateTask(task, measuredSamples, opts.allRequests));
  }
  return aggregates;
}

async function runTaskRequest(opts) {
  const params = taskParams(opts.task);
  const raw = await runRawRequest({
    fetchImpl: opts.fetchImpl,
    baseUrl: opts.baseUrl,
    endpoint: opts.task.endpoint,
    endpointName: opts.task.endpointName,
    params,
    clock: opts.clock,
    endpointState: opts.endpointState,
    phase: opts.phase,
    counted: opts.counted
  });

  const features = raw.ok && raw.json && Array.isArray(raw.json.features) ? raw.json.features : [];
  const top = topResultSummary(features[0]);
  return {
    ...raw,
    country: opts.task.country.code,
    city: opts.task.city.name || null,
    query: opts.task.query.text,
    expected_category: opts.task.query.category || null,
    min_results: opts.task.min_results,
    repeat: opts.repeat,
    warmup_round: opts.warmup_round || null,
    result_count: features.length,
    top_result: top,
    top_result_label: top ? top.label : null,
    top_result_category: top ? top.category : null,
    country_mismatches: raw.ok ? countryMismatches(features, opts.task.country.code) : []
  };
}

function taskParams(task) {
  const params = {
    text: task.query.text,
    size: String(task.size),
    'boundary.country': task.country.code
  };
  const focus = task.city.focus || task.country.focus;
  if (focus && focus.lat != null && focus.lon != null) {
    params['focus.point.lat'] = String(focus.lat);
    params['focus.point.lon'] = String(focus.lon);
  }
  return params;
}

async function runRawRequest(opts) {
  const url = new URL(opts.endpoint, opts.baseUrl);
  for (const [key, value] of Object.entries(opts.params || {})) {
    if (value != null && value !== '') url.searchParams.set(key, String(value));
  }

  const coldStart = !opts.endpointState.seen.has(opts.endpointName);
  opts.endpointState.seen.add(opts.endpointName);
  const started = opts.clock.now();

  try {
    const response = await opts.fetchImpl(url);
    const latency = Math.max(0, opts.clock.now() - started);
    if (!response || response.status < 200 || response.status >= 300) {
      return {
        endpoint: opts.endpointName,
        path: opts.endpoint,
        phase: opts.phase,
        counted: opts.counted,
        cold_start: coldStart,
        latency_ms: latency,
        status: response && response.status ? response.status : null,
        ok: false,
        json: null,
        error: `${url.pathname} returned ${response ? response.status : 'no response'}`
      };
    }
    const json = await response.json();
    return {
      endpoint: opts.endpointName,
      path: opts.endpoint,
      phase: opts.phase,
      counted: opts.counted,
      cold_start: coldStart,
      latency_ms: latency,
      status: response.status,
      ok: true,
      json,
      error: null
    };
  } catch (err) {
    return {
      endpoint: opts.endpointName,
      path: opts.endpoint,
      phase: opts.phase,
      counted: opts.counted,
      cold_start: coldStart,
      latency_ms: Math.max(0, opts.clock.now() - started),
      status: null,
      ok: false,
      json: null,
      error: err.message || String(err)
    };
  }
}

function aggregateTask(task, samples, allRequests) {
  const warmupSamples = allRequests.filter(sample => (
    sample.phase === 'warmup'
      && sample.endpoint === task.endpointName
      && sample.country === task.country.code
      && (sample.city || null) === (task.city.name || null)
      && sample.query === task.query.text
  ));
  const failures = samples.filter(sample => !sample.ok || sample.error);
  const zeroResultSamples = samples.filter(sample => sample.min_results > 0 && sample.result_count < sample.min_results);
  const mismatchSamples = samples.filter(sample => sample.country_mismatches && sample.country_mismatches.length > 0);
  const summary = latencySummary(samples.map(sample => sample.latency_ms));
  const firstSuccessful = samples.find(sample => sample.ok && sample.top_result) || samples[0] || null;

  return {
    endpoint: task.endpointName,
    country: task.country.code,
    city: task.city.name || null,
    query: task.query.text,
    text: task.query.text,
    expected_category: task.query.category || null,
    min_results: task.min_results,
    count: samples.length,
    failures: failures.length,
    result_count: firstSuccessful ? firstSuccessful.result_count : 0,
    latency_ms: summary.p50_ms,
    median_latency_ms: summary.p50_ms,
    latency_summary: summary,
    samples: samples.map(requestSummary),
    warmup_samples: warmupSamples.map(requestSummary),
    top_result: firstSuccessful ? firstSuccessful.top_result : null,
    country_mismatches: mismatchSamples.flatMap(sample => sample.country_mismatches || []).slice(0, 20),
    zero_result_samples: zeroResultSamples.map(requestSummary)
  };
}

function requestSummary(sample) {
  return {
    endpoint: sample.endpoint,
    country: sample.country || null,
    city: sample.city || null,
    query: sample.query || null,
    phase: sample.phase,
    counted: Boolean(sample.counted),
    repeat: sample.repeat || null,
    warmup_round: sample.warmup_round || null,
    cold_start: Boolean(sample.cold_start),
    latency_ms: sample.latency_ms,
    status: sample.status,
    ok: sample.ok,
    result_count: sample.result_count == null ? null : sample.result_count,
    top_result_label: sample.top_result_label || null,
    top_result_category: sample.top_result_category || null,
    error: sample.error || null
  };
}

function topResultSummary(feature) {
  if (!feature || !feature.properties) return null;
  const props = feature.properties;
  return {
    name: props.name || null,
    label: props.label || props.name || null,
    country: props.country || null,
    country_a: props.country_a || null,
    region: props.region || null,
    locality: props.locality || null,
    category: firstValue(props.category || props.categories || props.category_ids)
  };
}

function countryMismatches(features, expectedCountry) {
  const expected = String(expectedCountry || '').toUpperCase();
  if (!expected) return [];
  return (features || []).map((feature, index) => {
    const props = feature.properties || {};
    const actual = props.country_a == null ? null : String(props.country_a).toUpperCase();
    return actual === expected ? null : {
      index,
      gid: props.gid || null,
      name: props.name || props.label || null,
      country_a: props.country_a || null,
      locality: props.locality || null
    };
  }).filter(Boolean);
}

function latencyByEndpoint(samples) {
  const out = {};
  for (const endpoint of ['index_stats', 'search', 'autocomplete']) {
    const endpointSamples = samples.filter(sample => sample.endpoint === endpoint);
    const measured = endpointSamples.filter(sample => sample.counted);
    out[endpoint] = {
      all: latencySummary(measured.map(sample => sample.latency_ms)),
      cold: latencySummary(measured.filter(sample => sample.cold_start).map(sample => sample.latency_ms)),
      warm: latencySummary(measured.filter(sample => !sample.cold_start).map(sample => sample.latency_ms)),
      warmup: latencySummary(endpointSamples.filter(sample => sample.phase === 'warmup').map(sample => sample.latency_ms))
    };
  }
  return out;
}

function slowestRequests(samples, endpoint, limit = 10) {
  return samples
    .filter(sample => sample.endpoint === endpoint && sample.counted)
    .sort((a, b) => b.latency_ms - a.latency_ms)
    .slice(0, limit)
    .map(sample => ({
      endpoint: sample.endpoint,
      country: sample.country || null,
      city: sample.city || null,
      query: sample.query || null,
      latency_ms: sample.latency_ms,
      result_count: sample.result_count == null ? null : sample.result_count,
      top_result_label: sample.top_result_label || null,
      top_result_category: sample.top_result_category || null,
      cold_start: Boolean(sample.cold_start),
      repeat: sample.repeat || null
    }));
}

function perQueryLatency(countries) {
  const out = [];
  for (const country of countries) {
    for (const result of [...country.search, ...country.autocomplete]) {
      out.push({
        country: result.country,
        city: result.city,
        endpoint: result.endpoint,
        query: result.query,
        count: result.count,
        p50_ms: result.latency_summary.p50_ms,
        p95_ms: result.latency_summary.p95_ms,
        max_ms: result.latency_summary.max_ms,
        failures: result.failures
      });
    }
  }
  return out;
}

function evaluateFailures(report, thresholds = {}) {
  const failures = [];
  const thresholdFailures = [];
  const zeroResultGaps = [];
  const countryMismatches = [];

  for (const country of report.countries) {
    for (const result of [...country.search, ...country.autocomplete]) {
      if (result.failures > 0) {
        failures.push({
          code: 'request_failed',
          country: country.code,
          city: result.city,
          endpoint: result.endpoint,
          query: result.query,
          failures: result.failures,
          message: `${result.endpoint} ${country.code} ${cityText(result.city)}"${result.query}" had ${result.failures} failed requests`
        });
      }
      if (result.zero_result_samples.length > 0) {
        const failure = {
          code: 'zero_results',
          country: country.code,
          city: result.city,
          endpoint: result.endpoint,
          query: result.query,
          min_results: result.min_results,
          samples: result.zero_result_samples,
          message: `${result.endpoint} ${country.code} ${cityText(result.city)}"${result.query}" had ${result.zero_result_samples.length} samples below ${result.min_results} required results`
        };
        failures.push(failure);
        zeroResultGaps.push(failure);
      }
      if (result.country_mismatches.length > 0) {
        const failure = {
          code: 'country_filter_mismatch',
          country: country.code,
          city: result.city,
          endpoint: result.endpoint,
          query: result.query,
          mismatches: result.country_mismatches.slice(0, 5),
          message: `${result.endpoint} ${country.code} ${cityText(result.city)}"${result.query}" returned results outside boundary.country`
        };
        failures.push(failure);
        countryMismatches.push(failure);
      }
    }
  }

  const searchP95 = report.latency_by_endpoint.search.all.p95_ms;
  const searchLimit = Number(thresholds.search_max_p95_ms || 0);
  if (searchLimit > 0 && searchP95 > searchLimit) {
    thresholdFailures.push({
      code: 'search_p95_latency_exceeded',
      endpoint: 'search',
      p95_ms: searchP95,
      threshold_ms: searchLimit,
      message: `search p95 latency ${searchP95}ms exceeded ${searchLimit}ms`
    });
  }

  const autocompleteP95 = report.latency_by_endpoint.autocomplete.all.p95_ms;
  const autocompleteLimit = Number(thresholds.autocomplete_max_p95_ms || 0);
  if (autocompleteLimit > 0 && autocompleteP95 > autocompleteLimit) {
    thresholdFailures.push({
      code: 'autocomplete_p95_latency_exceeded',
      endpoint: 'autocomplete',
      p95_ms: autocompleteP95,
      threshold_ms: autocompleteLimit,
      message: `autocomplete p95 latency ${autocompleteP95}ms exceeded ${autocompleteLimit}ms`
    });
  }

  const indexStatsLimit = Number(thresholds.index_stats_max_ms || 0);
  if (indexStatsLimit > 0 && report.index_stats_latency_ms > indexStatsLimit) {
    thresholdFailures.push({
      code: 'index_stats_latency_exceeded',
      endpoint: 'index_stats',
      latency_ms: report.index_stats_latency_ms,
      threshold_ms: indexStatsLimit,
      message: `index stats latency ${report.index_stats_latency_ms}ms exceeded ${indexStatsLimit}ms`
    });
  }

  const maxMissingRatio = Number(thresholds.max_missing_country_a_ratio);
  if (Number.isFinite(maxMissingRatio)
    && report.missing_country_a
    && report.missing_country_a.ratio > maxMissingRatio) {
    thresholdFailures.push({
      code: 'missing_country_a_ratio_exceeded',
      ratio: report.missing_country_a.ratio,
      threshold: maxMissingRatio,
      missing: report.missing_country_a.missing,
      total: report.missing_country_a.total,
      message: `missing country_a ratio ${formatRatio(report.missing_country_a.ratio)} exceeded ${formatRatio(maxMissingRatio)}`
    });
  }

  report.failed_thresholds = thresholdFailures;
  report.zero_result_gaps = zeroResultGaps;
  report.country_mismatches = countryMismatches;
  return [...failures, ...thresholdFailures];
}

async function writeReports(report, outputDir = DEFAULT_REPORT_DIR, timestamp = safeTimestamp(report.generated_at)) {
  await fs.mkdir(outputDir, { recursive: true });
  const base = `country-quality-matrix-${timestamp}`;
  const jsonPath = path.join(outputDir, `${base}.json`);
  const markdownPath = path.join(outputDir, `${base}.md`);
  await fs.writeFile(jsonPath, `${JSON.stringify(report, null, 2)}\n`);
  await fs.writeFile(markdownPath, markdownReport(report));
  return { json: jsonPath, markdown: markdownPath };
}

function markdownReport(report) {
  const lines = [];
  lines.push('# Country Quality Matrix');
  lines.push('');
  lines.push(`Generated: ${report.generated_at}`);
  lines.push(`Base URL: ${report.base_url}`);
  lines.push(`Strict: ${report.strict ? 'yes' : 'no'}`);
  lines.push(`Status: ${report.ok ? 'PASS' : 'FAIL'}`);
  lines.push(`Warmup rounds: ${report.warmup_rounds}`);
  lines.push(`Repeats: ${report.repeats}`);
  lines.push('');
  lines.push('## Missing Country Ratio');
  lines.push('');
  lines.push('| Metric | Value |');
  lines.push('| --- | --- |');
  lines.push(`| Total documents | ${report.missing_country_a ? report.missing_country_a.total : 'n/a'} |`);
  lines.push(`| Missing country_a | ${report.missing_country_a ? `${report.missing_country_a.missing} (${formatRatio(report.missing_country_a.ratio)})` : 'n/a'} |`);
  lines.push('');
  lines.push('## Latency By Endpoint');
  lines.push('');
  lines.push('| Endpoint | Count | p50 ms | p95 ms | p99 ms | Max ms | Warmup p95 ms | Cold p95 ms | Warm p95 ms |');
  lines.push('| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |');
  for (const endpoint of ['index_stats', 'search', 'autocomplete']) {
    const stats = report.latency_by_endpoint[endpoint] || { all: emptyLatencySummary(), warmup: emptyLatencySummary(), cold: emptyLatencySummary(), warm: emptyLatencySummary() };
    lines.push(`| ${endpoint} | ${stats.all.count} | ${stats.all.p50_ms} | ${stats.all.p95_ms} | ${stats.all.p99_ms} | ${stats.all.max_ms} | ${stats.warmup.p95_ms} | ${stats.cold.p95_ms} | ${stats.warm.p95_ms} |`);
  }
  lines.push('');
  lines.push('## Slowest Search Requests');
  slowestTable(lines, report.slowest_requests.search || []);
  lines.push('');
  lines.push('## Slowest Autocomplete Requests');
  slowestTable(lines, report.slowest_requests.autocomplete || []);
  lines.push('');
  lines.push('## Per-Query Latency');
  lines.push('');
  lines.push('| Country | City | Endpoint | Query | Count | p50 ms | p95 ms | Max ms | Failures |');
  lines.push('| --- | --- | --- | --- | ---: | ---: | ---: | ---: | ---: |');
  for (const row of report.per_query_latency || []) {
    lines.push(`| ${row.country} | ${escapeMd(row.city || '')} | ${row.endpoint} | ${escapeMd(row.query)} | ${row.count} | ${row.p50_ms} | ${row.p95_ms} | ${row.max_ms} | ${row.failures} |`);
  }
  lines.push('');
  lines.push('## Failed Thresholds');
  failureList(lines, report.failed_thresholds || []);
  lines.push('');
  lines.push('## Zero-Result Gaps');
  failureList(lines, report.zero_result_gaps || []);
  lines.push('');
  lines.push('## Country Mismatches');
  failureList(lines, report.country_mismatches || []);
  lines.push('');
  lines.push('## All Failures');
  failureList(lines, report.failures || []);
  lines.push('');
  return `${lines.join('\n')}\n`;
}

function slowestTable(lines, rows) {
  lines.push('');
  lines.push('| Country | City | Endpoint | Query | Latency ms | Results | Top label | Top category | Cold start |');
  lines.push('| --- | --- | --- | --- | ---: | ---: | --- | --- | --- |');
  if (rows.length === 0) {
    lines.push('|  |  |  | none | 0 | 0 |  |  |  |');
    return;
  }
  for (const row of rows) {
    lines.push(`| ${row.country || ''} | ${escapeMd(row.city || '')} | ${row.endpoint} | ${escapeMd(row.query || '')} | ${row.latency_ms} | ${row.result_count == null ? '' : row.result_count} | ${escapeMd(row.top_result_label || '')} | ${escapeMd(row.top_result_category || '')} | ${row.cold_start ? 'yes' : 'no'} |`);
  }
}

function failureList(lines, failures) {
  if (!failures || failures.length === 0) {
    lines.push('None.');
    return;
  }
  for (const failure of failures) {
    lines.push(`- ${failure.code}: ${escapeMd(failure.message)}`);
  }
}

function summarizeMissingCountryA(stats) {
  const total = Number(stats && stats.total_documents || 0);
  const byLayer = stats && stats.documents_missing_country_a ? stats.documents_missing_country_a : {};
  const missing = Object.values(byLayer).reduce((sum, value) => sum + Number(value || 0), 0);
  return {
    total,
    missing,
    ratio: total > 0 ? missing / total : 0,
    by_layer: byLayer,
    by_source_config: stats && stats.documents_missing_country_a_by_source_config
      ? stats.documents_missing_country_a_by_source_config
      : {}
  };
}

function latencySummary(latencies) {
  const sorted = [...(latencies || [])].filter(Number.isFinite).sort((a, b) => a - b);
  return {
    count: sorted.length,
    p50_ms: percentile(sorted, 50),
    p95_ms: percentile(sorted, 95),
    p99_ms: percentile(sorted, 99),
    max_ms: sorted.length ? sorted[sorted.length - 1] : 0
  };
}

function emptyLatencySummary() {
  return { count: 0, p50_ms: 0, p95_ms: 0, p99_ms: 0, max_ms: 0 };
}

function percentile(sorted, p) {
  if (!sorted.length) return 0;
  const index = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[index];
}

function normalizeConfig(config) {
  const thresholds = config.thresholds || {};
  const legacyP95 = thresholds.p95_latency_ms;
  return {
    base_url: config.base_url || process.env.GEOCODER_E2E_URL || 'http://localhost:4000',
    output_dir: config.output_dir || 'reports',
    warmup_rounds: integerEnv('MATRIX_WARMUP_ROUNDS', config.warmup_rounds, 1),
    repeats: integerEnv('MATRIX_REPEATS', config.repeats, 3),
    thresholds: {
      search_max_p95_ms: Number(thresholds.search_max_p95_ms ?? legacyP95 ?? 250),
      autocomplete_max_p95_ms: Number(thresholds.autocomplete_max_p95_ms ?? legacyP95 ?? 250),
      index_stats_max_ms: Number(thresholds.index_stats_max_ms ?? 500),
      max_missing_country_a_ratio: Number(thresholds.max_missing_country_a_ratio ?? 0.05),
      min_results_per_query: Number(thresholds.min_results_per_query ?? 1)
    },
    search: {
      size: Number(((config.search || {}).size) || 5)
    },
    autocomplete: {
      enabled: Boolean((config.autocomplete || {}).enabled),
      size: Number(((config.autocomplete || {}).size) || 5)
    },
    countries: Array.isArray(config.countries) ? config.countries.map(country => ({
      ...country,
      code: String(country.code || '').toUpperCase(),
      queries: Array.isArray(country.queries) ? country.queries : [],
      autocomplete_queries: Array.isArray(country.autocomplete_queries) ? country.autocomplete_queries : undefined,
      cities: Array.isArray(country.cities) ? country.cities : undefined
    })).filter(country => country.code) : []
  };
}

function integerEnv(name, configured, fallback) {
  const value = process.env[name] ?? configured ?? fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : fallback;
}

function resolveOutputDir(configured) {
  if (!configured) return DEFAULT_REPORT_DIR;
  return path.isAbsolute(configured) ? configured : path.join(REPO_ROOT, configured);
}

function safeTimestamp(value) {
  return String(value || new Date().toISOString()).replace(/[:.]/g, '-');
}

function firstValue(value) {
  return Array.isArray(value) ? (value[0] || null) : (value || null);
}

function formatRatio(value) {
  return `${(Number(value || 0) * 100).toFixed(2)}%`;
}

function cityText(city) {
  return city ? `${city} ` : '';
}

function escapeMd(value) {
  return String(value == null ? '' : value).replace(/\|/g, '\\|');
}

if (require.main === module) {
  main().catch(err => {
    console.error(err);
    process.exit(1);
  });
}

module.exports = {
  runQualityMatrix,
  evaluateFailures,
  writeReports,
  markdownReport,
  summarizeMissingCountryA,
  latencySummary,
  percentile,
  normalizeConfig,
  loadMatrixConfig,
  slowestRequests,
  latencyByEndpoint
};
