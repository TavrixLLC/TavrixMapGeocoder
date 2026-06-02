'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const PostgisReader = require('../src/postgis-reader');

const logger = { info() {}, warn() {}, error() {} };

test('postgisReader: configures sessions as read-only', async () => {
  const previous = snapshotEnv(['POSTGIS_HOST', 'POSTGIS_PORT', 'POSTGIS_DB', 'POSTGIS_USER', 'POSTGIS_PASSWORD']);
  Object.assign(process.env, {
    POSTGIS_HOST: 'postgis',
    POSTGIS_PORT: '5432',
    POSTGIS_DB: 'gis',
    POSTGIS_USER: 'pelias_readonly',
    POSTGIS_PASSWORD: 'secret'
  });

  const reader = new PostgisReader({
    postgis: {
      statement_timeout_ms: 1000,
      idle_in_transaction_session_timeout_ms: 1000
    }
  }, logger);

  try {
    assert.match(reader.pool.options.options, /default_transaction_read_only=on/);
    await assert.rejects(
      () => reader.assertReadOnlySession({ async query() { return { rows: [{ transaction_read_only: 'off' }] }; } }),
      /not read-only/
    );
    await assert.doesNotReject(
      () => reader.assertReadOnlySession({ async query() { return { rows: [{ transaction_read_only: 'on' }] }; } })
    );
  } finally {
    await reader.close();
    restoreEnv(previous);
  }
});

function snapshotEnv(keys) {
  return Object.fromEntries(keys.map(key => [key, process.env[key]]));
}

function restoreEnv(snapshot) {
  for (const [key, value] of Object.entries(snapshot)) {
    if (value == null) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
}
