'use strict';

class EsIndexManager {
  constructor(esClient, config, logger) {
    this.es = esClient;
    this.log = logger;
    this.indexName = config.schema?.indexName || 'pelias';
    this.readAlias = config.schema?.indexName || 'pelias';
    this.writeAlias = (config.schema?.indexName || 'pelias') + '_write';
  }

  async ensureAliases() {
    try {
      const indexExists = await this.es.indices.exists({ index: this.indexName });

      if (!indexExists) {
        this.log.info('Index does not exist yet, aliases will be created after schema init', {
          index: this.indexName
        });
        return;
      }

      // Check and create write alias
      const writeAliasExists = await this.es.indices.existsAlias({ name: this.writeAlias });
      if (!writeAliasExists) {
        await this.es.indices.putAlias({ index: this.indexName, name: this.writeAlias });
        this.log.info('Created write alias', { alias: this.writeAlias, index: this.indexName });
      }

      // Check read alias — only create if indexName is different from readAlias (e.g. if we used _v1)
      if (this.indexName !== this.readAlias) {
        const readAliasExists = await this.es.indices.existsAlias({ name: this.readAlias });
        if (!readAliasExists) {
          await this.es.indices.putAlias({ index: this.indexName, name: this.readAlias });
          this.log.info('Created read alias', { alias: this.readAlias, index: this.indexName });
        }
      }

    } catch (err) {
      this.log.warn('Failed to ensure aliases (ES may not be ready)', { error: err.message });
    }
  }

  async getIndexInfo() {
    try {
      const aliases = await this.es.cat.aliases({ format: 'json' });
      const indices = await this.es.cat.indices({ format: 'json' });
      return { aliases, indices };
    } catch (err) {
      return { error: err.message };
    }
  }

  async isHealthy() {
    try {
      const health = await this.es.cluster.health({ timeout: '5s' });
      return health.status !== 'red';
    } catch (_) {
      return false;
    }
  }
}

module.exports = EsIndexManager;
