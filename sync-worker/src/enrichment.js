'use strict';

class Enrichment {
  constructor(config, logger) {
    this.log = logger;
    this.strategy = config.postgis_sync?.enrichment?.strategy || 'config';
    this.defaultParent = config.postgis_sync?.enrichment?.default_parent || {};
  }

  async enrich(domainDoc) {
    if (domainDoc.action !== 'UPSERT') return domainDoc;

    // Apply default parent hierarchy if not provided by transform
    if (Object.keys(domainDoc.parent).length === 0) {
      domainDoc.parent = { ...this.defaultParent };
    } else {
      // Merge: keep existing and fill gaps with defaults
      for (const [key, value] of Object.entries(this.defaultParent)) {
        if (!domainDoc.parent[key]) {
          domainDoc.parent[key] = value;
        }
      }
    }

    return domainDoc;
  }

  async enrichBatch(domainDocs) {
    const results = [];
    for (const doc of domainDocs) {
      results.push(await this.enrich(doc));
    }
    return results;
  }
}

module.exports = Enrichment;
