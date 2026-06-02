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
    await this.ensureExtendedMappingsForAliases([readAlias, writeAlias, initialIndex]);
    await this.updateAliasMetrics();
  }

  async currentWriteTarget() {
    const aliases = await this.aliasTargets(this.config.elasticsearch.write_alias);
    if (aliases.length > 0) return aliases[0];
    return this.config.elasticsearch.initial_index;
  }

  async nextVersionIndexName() {
    const prefix = this.config.elasticsearch.index_prefix;
    const indices = await this.versionIndices();
    const versions = indices
      .map(name => Number((name.match(new RegExp(`^${escapeRegExp(prefix)}_v(\\d+)$`)) || [])[1]))
      .filter(Number.isFinite);
    const nextVersion = versions.length === 0 ? 1 : Math.max(...versions) + 1;
    return `${prefix}_v${nextVersion}`;
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
    await this.ensureExtendedMappings(indexName);

    return indexName;
  }

  async ensureExtendedMappingsForAliases(names) {
    const targets = new Set();
    for (const name of names) {
      if (!name) continue;
      const aliasTargets = await this.aliasTargets(name);
      if (aliasTargets.length > 0) {
        for (const target of aliasTargets) targets.add(target);
      } else if (await this.indexExists(name)) {
        targets.add(name);
      }
    }

    for (const target of targets) {
      await this.ensureExtendedMappings(target);
    }
  }

  async ensureExtendedMappings(indexName) {
    const existing = await this.indexProperties(indexName);
    const additions = missingMappingProperties(existing, extendedMappingProperties());
    if (Object.keys(additions).length === 0) return;

    await this.es.indices.putMapping({
      index: indexName,
      body: { properties: additions }
    });
    this.log.info('Ensured TavrixMap Pelias extension mappings', {
      index: indexName,
      fields: Object.keys(additions)
    });
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
    const previousTargets = {};

    for (const alias of [readAlias, writeAlias]) {
      const targets = await this.aliasTargets(alias);
      previousTargets[alias] = targets;
      for (const target of targets) {
        actions.push({ remove: { index: target, alias } });
      }
      actions.push({ add: { index: indexName, alias } });
    }

    await this.es.indices.updateAliases({ body: { actions } });
    await this.updateAliasMetrics();
    this.log.info('Pelias aliases switched', { index: indexName, readAlias, writeAlias });

    return {
      target_index: indexName,
      read_alias: readAlias,
      write_alias: writeAlias,
      previous_read_targets: previousTargets[readAlias] || [],
      previous_write_targets: previousTargets[writeAlias] || []
    };
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
    if (targets.length > 0) {
      this.log.info('Pelias alias already resolves; leaving target unchanged', {
        alias,
        targets
      });
      return;
    }

    await this.es.indices.updateAliases({
      body: {
        actions: [
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

  async indexProperties(indexName) {
    const response = await this.es.indices.getMapping({ index: indexName });
    const body = response.body || response;
    const first = body[indexName] || body[Object.keys(body)[0]] || {};
    return ((first.mappings || {}).properties) || {};
  }

  async createGenericIndex(indexName) {
    await this.es.indices.create({
      index: indexName,
      body: {
        settings: {
          number_of_shards: numberSetting(
            process.env.PELIAS_INDEX_SHARDS,
            this.config.elasticsearch.number_of_shards,
            1
          ),
          number_of_replicas: numberSetting(
            process.env.PELIAS_INDEX_REPLICAS,
            this.config.elasticsearch.number_of_replicas,
            0
          )
        },
        mappings: {
          dynamic: true,
          properties: {
            id: { type: 'keyword' },
            gid: { type: 'keyword' },
            source: { type: 'keyword' },
            source_config: { type: 'keyword' },
            layer: { type: 'keyword' },
            source_id: { type: 'keyword' },
            name: { type: 'object', dynamic: true },
            names: { type: 'object', dynamic: true },
            phrase: { type: 'object', dynamic: true },
            label: { type: 'text' },
            country: { type: 'text' },
            country_a: { type: 'keyword' },
            region: { type: 'text' },
            region_a: { type: 'keyword' },
            county: { type: 'text' },
            locality: { type: 'text' },
            localadmin: { type: 'text' },
            neighbourhood: { type: 'text' },
            admin_enrichment_status: { type: 'keyword' },
            admin_enrichment_reason: { type: 'keyword' },
            center_point: { type: 'geo_point' },
            routable_point: { type: 'geo_point' },
            routable_point_type: { type: 'keyword' },
            routable_point_status: { type: 'keyword' },
            routable_point_source: { type: 'keyword' },
            routable_point_reason: { type: 'keyword' },
            routable_point_distance_meters: { type: 'float' },
            routable_points: {
              type: 'nested',
              properties: {
                lat: { type: 'float' },
                lon: { type: 'float' },
                type: { type: 'keyword' },
                source: { type: 'keyword' },
                distance_meters: { type: 'float' }
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
            categories: { type: 'keyword' },
            category_ids: { type: 'keyword' },
            category_terms: { type: 'text', fields: { keyword: { type: 'keyword', ignore_above: 256 } } },
            intent_groups: { type: 'keyword' },
            category_aliases: { type: 'text' },
            source_tags: {
              type: 'object',
              dynamic: false,
              properties: {
                amenity: { type: 'keyword' },
                shop: { type: 'keyword' },
                tourism: { type: 'keyword' },
                leisure: { type: 'keyword' },
                office: { type: 'keyword' },
                highway: { type: 'keyword' },
                place: { type: 'keyword' },
                boundary: { type: 'keyword' },
                admin_level: { type: 'keyword' }
              }
            },
            popularity: { type: 'float' },
            importance: { type: 'float' },
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

function extendedMappingProperties() {
  return {
    id: { type: 'keyword' },
    gid: { type: 'keyword' },
    updated_at: { type: 'date' },
    source_config: { type: 'keyword' },
    label: { type: 'text' },
    country: { type: 'text' },
    country_a: { type: 'keyword' },
    region: { type: 'text' },
    region_a: { type: 'keyword' },
    county: { type: 'text' },
    locality: { type: 'text' },
    localadmin: { type: 'text' },
    neighbourhood: { type: 'text' },
    admin_enrichment_status: { type: 'keyword' },
    admin_enrichment_reason: { type: 'keyword' },
    names: { type: 'object', dynamic: true },
    routable_point: { type: 'geo_point' },
    routable_point_type: { type: 'keyword' },
    routable_point_status: { type: 'keyword' },
    routable_point_source: { type: 'keyword' },
    routable_point_reason: { type: 'keyword' },
    routable_point_distance_meters: { type: 'float' },
    routable_points: {
      type: 'nested',
      properties: {
        lat: { type: 'float' },
        lon: { type: 'float' },
        type: { type: 'keyword' },
        source: { type: 'keyword' },
        distance_meters: { type: 'float' }
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
    categories: { type: 'keyword' },
    category_ids: { type: 'keyword' },
    category_terms: { type: 'text', fields: { keyword: { type: 'keyword', ignore_above: 256 } } },
    intent_groups: { type: 'keyword' },
    category_aliases: { type: 'text' },
    source_tags: {
      type: 'object',
      dynamic: false,
      properties: {
        amenity: { type: 'keyword' },
        shop: { type: 'keyword' },
        tourism: { type: 'keyword' },
        leisure: { type: 'keyword' },
        office: { type: 'keyword' },
        highway: { type: 'keyword' },
        place: { type: 'keyword' },
        boundary: { type: 'keyword' },
        admin_level: { type: 'keyword' }
      }
    },
    importance: { type: 'float' }
  };
}

function missingMappingProperties(existing, desired) {
  const missing = {};
  for (const [field, mapping] of Object.entries(desired)) {
    if (!existing[field]) missing[field] = mapping;
  }
  return missing;
}

function numberSetting(...values) {
  for (const value of values) {
    if (value == null || value === '') continue;
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return 0;
}

module.exports = IndexManager;
module.exports.extendedMappingProperties = extendedMappingProperties;
module.exports.numberSetting = numberSetting;
