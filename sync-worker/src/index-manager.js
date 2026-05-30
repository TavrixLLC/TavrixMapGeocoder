'use strict';

class IndexManager {
  constructor(esClient, config, metrics, logger) {
    this.es = esClient;
    this.config = config;
    this.metrics = metrics;
    this.log = logger;
  }

  async ensureAliases() {
    const readAlias = this.config.elasticsearch.read_alias;
    const writeAlias = this.config.elasticsearch.write_alias;
    const initialIndex = this.config.elasticsearch.initial_index;

    if (!(await this.indexExists(initialIndex))) {
      this.log.warn('Initial Pelias index is missing; creating generic index. Run pelias-schema for production mappings.', {
        index: initialIndex
      });
      await this.createGenericIndex(initialIndex);
    }

    await this.ensureAlias(readAlias, initialIndex);
    await this.ensureAlias(writeAlias, initialIndex);
    await this.updateAliasMetrics();
  }

  async currentWriteTarget() {
    const aliases = await this.aliasTargets(this.config.elasticsearch.write_alias);
    if (aliases.length > 0) return aliases[0];
    return this.config.elasticsearch.initial_index;
  }

  async createNextVersionIndex() {
    const prefix = this.config.elasticsearch.index_prefix;
    const indices = await this.versionIndices();
    const versions = indices
      .map(name => Number((name.match(new RegExp(`^${escapeRegExp(prefix)}_v(\\d+)$`)) || [])[1]))
      .filter(Number.isFinite);
    const nextVersion = versions.length === 0 ? 1 : Math.max(...versions) + 1;
    const indexName = `${prefix}_v${nextVersion}`;

    if (!(await this.indexExists(indexName))) {
      await this.createGenericIndex(indexName);
    }

    return indexName;
  }

  async switchAliases(indexName) {
    // Safety check: never switch alias to an empty index
    try {
      const response = await this.es.count({ index: indexName });
      const body = response.body || response;
      const count = body.count || 0;
      if (count === 0) {
        this.log.error('Refusing to switch aliases: target index is empty', { index: indexName, count });
        throw new Error(`Cannot switch aliases to empty index ${indexName} (0 documents)`);
      }
      this.log.info('Alias switch safety check passed', { index: indexName, count });
    } catch (err) {
      if (err.message && err.message.includes('Cannot switch aliases')) throw err;
      this.log.error('Failed to verify document count before alias switch', { index: indexName, error: err.message });
      throw err;
    }

    const readAlias = this.config.elasticsearch.read_alias;
    const writeAlias = this.config.elasticsearch.write_alias;
    const actions = [];

    for (const alias of [readAlias, writeAlias]) {
      const targets = await this.aliasTargets(alias);
      for (const target of targets) {
        actions.push({ remove: { index: target, alias } });
      }
      actions.push({ add: { index: indexName, alias } });
    }

    await this.es.indices.updateAliases({ body: { actions } });
    await this.updateAliasMetrics();
    this.log.info('Pelias aliases switched', { index: indexName, readAlias, writeAlias });
  }

  async updateAliasMetrics() {
    for (const alias of [this.config.elasticsearch.read_alias, this.config.elasticsearch.write_alias]) {
      const targets = await this.aliasTargets(alias);
      for (const target of targets) {
        this.metrics.currentIndexAlias.labels(alias, target).set(1);
      }
    }
  }

  async ensureAlias(alias, indexName) {
    const targets = await this.aliasTargets(alias);
    if (targets.includes(indexName)) return;

    await this.es.indices.updateAliases({
      body: {
        actions: [
          ...targets.map(index => ({ remove: { index, alias } })),
          { add: { index: indexName, alias } }
        ]
      }
    });
  }

  async aliasTargets(alias) {
    try {
      const response = await this.es.indices.getAlias({ name: alias });
      const body = response.body || response;
      return Object.keys(body);
    } catch (err) {
      if (err.meta && err.meta.statusCode === 404) return [];
      if (err.statusCode === 404) return [];
      throw err;
    }
  }

  async indexExists(indexName) {
    const response = await this.es.indices.exists({ index: indexName });
    if (typeof response === 'boolean') return response;
    if (typeof response.body === 'boolean') return response.body;
    return response.statusCode === 200;
  }

  async versionIndices() {
    const prefix = this.config.elasticsearch.index_prefix;
    try {
      const response = await this.es.cat.indices({
        index: `${prefix}_v*`,
        format: 'json',
        h: 'index'
      });
      const body = response.body || response;
      return body.map(item => item.index).filter(Boolean);
    } catch (err) {
      if (err.meta && err.meta.statusCode === 404) return [];
      throw err;
    }
  }

  async createGenericIndex(indexName) {
    await this.es.indices.create({
      index: indexName,
      body: {
        settings: {
          number_of_shards: 1,
          number_of_replicas: 0
        },
        mappings: {
          dynamic: true,
          properties: {
            source: { type: 'keyword' },
            layer: { type: 'keyword' },
            source_id: { type: 'keyword' },
            name: { type: 'object', dynamic: true },
            phrase: { type: 'object', dynamic: true },
            center_point: { type: 'geo_point' },
            routable_point: { type: 'geo_point' },
            routable_point_type: { type: 'keyword' },
            routable_point_source: { type: 'keyword' },
            routable_points: {
              type: 'nested',
              properties: {
                lat: { type: 'float' },
                lon: { type: 'float' },
                type: { type: 'keyword' },
                source: { type: 'keyword' }
              }
            },
            entrances: {
              type: 'nested',
              properties: {
                lat: { type: 'float' },
                lon: { type: 'float' },
                name: { type: 'text' }
              }
            },
            category: { type: 'keyword' },
            popularity: { type: 'float' },
            parent: { type: 'object', dynamic: true },
            address_parts: { type: 'object', dynamic: true },
            addendum: { type: 'object', enabled: false },
            updated_at: { type: 'date' }
          }
        }
      }
    });
  }
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

module.exports = IndexManager;
