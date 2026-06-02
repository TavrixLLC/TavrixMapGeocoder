'use strict';

const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

const compose = fs.readFileSync(path.join(__dirname, '..', '..', 'docker-compose.yml'), 'utf8');
const prodCompose = fs.readFileSync(path.join(__dirname, '..', '..', 'docker-compose.prod.yml'), 'utf8');

test('docker-compose: worker HTTP port is internal-only', () => {
  const block = serviceBlock(compose, 'postgis-readonly-sync-worker');

  assert.ok(block);
  assert.match(block, /^\s+expose:\s*$/m);
  assert.match(block, /^\s+- "9090"\s*$/m);
  assert.doesNotMatch(block, /^\s+ports:\s*$/m);
});

test('docker-compose: worker keeps PostGIS env isolated to worker service', () => {
  const workerBlock = serviceBlock(compose, 'postgis-readonly-sync-worker');
  const apiBlock = serviceBlock(compose, 'geocoder-api');

  assert.match(workerBlock, /^\s+env_file:\s*$/m);
  assert.doesNotMatch(apiBlock, /POSTGIS_/);
});

test('docker-compose: worker mounts writable state volume and uses SQLite state env', () => {
  const workerBlock = serviceBlock(compose, 'postgis-readonly-sync-worker');
  const apiBlock = serviceBlock(compose, 'geocoder-api');

  assert.match(workerBlock, /SYNC_STATE_BACKEND:\s*sqlite/);
  assert.match(workerBlock, /SYNC_STATE_PATH:\s*\/app\/state\/sync-state\.sqlite/);
  assert.match(workerBlock, /SYNC_STATE_SNAPSHOT_PATH:\s*\/app\/state\/sync-state\.json/);
  assert.match(workerBlock, /^\s+- \.\/state:\/app\/state\s*$/m);

  assert.match(apiBlock, /WORKER_STATE_PATH:\s*\/app\/state\/sync-state\.json/);
  assert.match(apiBlock, /^\s+- \.\/state:\/app\/state:ro\s*$/m);
});

test('docker-compose.prod: Elasticsearch ports are not public', () => {
  const block = serviceBlock(prodCompose, 'elasticsearch');

  assert.ok(block);
  assert.match(block, /^\s+expose:\s*$/m);
  assert.match(block, /^\s+- "9200"\s*$/m);
  assert.match(block, /^\s+- "9300"\s*$/m);
  assert.doesNotMatch(block, /^\s+ports:\s*$/m);
  assert.doesNotMatch(block, /9200:9200/);
  assert.doesNotMatch(block, /9300:9300/);
});

test('docker-compose.prod: worker HTTP port remains internal-only', () => {
  const block = serviceBlock(prodCompose, 'postgis-readonly-sync-worker');

  assert.ok(block);
  assert.match(block, /^\s+expose:\s*$/m);
  assert.match(block, /^\s+- "9090"\s*$/m);
  assert.doesNotMatch(block, /^\s+ports:\s*$/m);
});

test('docker-compose.prod: uses persistent ES data and snapshot volumes with sizing env', () => {
  const esBlock = serviceBlock(prodCompose, 'elasticsearch');
  const workerBlock = serviceBlock(prodCompose, 'postgis-readonly-sync-worker');
  const apiBlock = serviceBlock(prodCompose, 'geocoder-api');

  assert.match(esBlock, /ES_JAVA_OPTS:\s*-Xms\$\{ES_HEAP_SIZE:-4g\}\s+-Xmx\$\{ES_HEAP_SIZE:-4g\}/);
  assert.match(esBlock, /pelias_elasticsearch_prod_data:\/usr\/share\/elasticsearch\/data/);
  assert.match(esBlock, /pelias_elasticsearch_snapshots:\/usr\/share\/elasticsearch\/snapshots/);
  assert.match(esBlock, /path\.repo:\s*\/usr\/share\/elasticsearch\/snapshots/);
  assert.match(workerBlock, /PELIAS_INDEX_SHARDS:\s*\$\{PELIAS_INDEX_SHARDS:-3\}/);
  assert.match(workerBlock, /PELIAS_INDEX_REPLICAS:\s*\$\{PELIAS_INDEX_REPLICAS:-0\}/);
  assert.match(apiBlock, /ES_EXPECTED_REPLICAS:\s*\$\{ES_EXPECTED_REPLICAS:-0\}/);
});

function serviceBlock(text, serviceName) {
  const match = text.match(new RegExp(`\\n  ${serviceName}:\\n([\\s\\S]*?)(?=\\n  [A-Za-z0-9_-]+:\\n|\\nnetworks:|\\nvolumes:|$)`));
  return match && match[1];
}
