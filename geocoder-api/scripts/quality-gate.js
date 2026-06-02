'use strict';

const { spawnSync } = require('node:child_process');

const envBase = {
  ...process.env,
  GEOCODER_E2E_URL: process.env.GEOCODER_E2E_URL || 'http://localhost:4000',
  SEARCH_P95_LIMIT_MS: process.env.SEARCH_P95_LIMIT_MS || '250'
};

const steps = [
  {
    name: 'relevance E2E',
    args: ['--test', 'test/e2e-quality.test.js'],
    env: { ...envBase, RUN_E2E_QUALITY: '1' }
  },
  {
    name: 'latency budget',
    args: ['--test', 'test/performance.test.js'],
    env: { ...envBase, RUN_PERF_TESTS: '1' }
  }
];

for (const step of steps) {
  console.log(`\n== ${step.name} ==`);
  const result = spawnSync(process.execPath, step.args, {
    cwd: process.cwd(),
    env: step.env,
    stdio: 'inherit'
  });
  if (result.status !== 0) {
    console.error(`\nQuality gate failed at: ${step.name}`);
    process.exit(result.status || 1);
  }
}

console.log('\nQuality gate passed: relevance improved inside the p95 latency budget.');
