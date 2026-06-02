'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const IndexManager = require('../src/index-manager');
const { extendedMappingProperties } = require('../src/index-manager');

test('extended mappings include production category/ranking fields', () => {
  const mappings = extendedMappingProperties();

  assert.equal(mappings.id.type, 'keyword');
  assert.equal(mappings.gid.type, 'keyword');
  assert.equal(mappings.category_terms.type, 'text');
  assert.equal(mappings.category_terms.fields.keyword.type, 'keyword');
  assert.equal(mappings.intent_groups.type, 'keyword');
  assert.equal(mappings.importance.type, 'float');
});

test('createGenericIndex: uses shard and replica environment settings', async () => {
  const previousShards = process.env.PELIAS_INDEX_SHARDS;
  const previousReplicas = process.env.PELIAS_INDEX_REPLICAS;
  process.env.PELIAS_INDEX_SHARDS = '5';
  process.env.PELIAS_INDEX_REPLICAS = '2';

  let createRequest = null;
  const manager = new IndexManager({
    indices: {
      async create(request) {
        createRequest = request;
      }
    }
  }, {
    elasticsearch: {}
  }, {}, { info() {}, warn() {}, error() {} });

  try {
    await manager.createGenericIndex('pelias_v99');
  } finally {
    if (previousShards == null) delete process.env.PELIAS_INDEX_SHARDS;
    else process.env.PELIAS_INDEX_SHARDS = previousShards;
    if (previousReplicas == null) delete process.env.PELIAS_INDEX_REPLICAS;
    else process.env.PELIAS_INDEX_REPLICAS = previousReplicas;
  }

  assert.equal(createRequest.body.settings.number_of_shards, 5);
  assert.equal(createRequest.body.settings.number_of_replicas, 2);
});

test('ensureAliases: preserves existing alias targets instead of forcing initial index', async () => {
  const updateRequests = [];
  const manager = new IndexManager({
    indices: {
      async updateAliases(request) {
        updateRequests.push(request);
      }
    }
  }, {
    elasticsearch: {
      read_alias: 'pelias',
      write_alias: 'pelias_write',
      initial_index: 'pelias_v1'
    }
  }, {}, { info() {}, warn() {}, error() {} });

  manager.indexExists = async () => true;
  manager.aliasTargets = async alias => (
    alias === 'pelias' || alias === 'pelias_write' ? ['pelias_v2'] : []
  );
  manager.ensureExtendedMappingsForAliases = async () => {};
  manager.updateAliasMetrics = async () => {};

  await manager.ensureAliases();

  assert.deepEqual(updateRequests, []);
});
