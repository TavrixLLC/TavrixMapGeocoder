'use strict';

class EsWriter {
  constructor(esClient, config, logger) {
    this.es = esClient;
    this.log = logger;
    this.writeAlias = 'pelias_write';
    this.maxBulkItems = config.postgis_sync?.batch_size || 500;
    this.maxBulkBytes = config.postgis_sync?.max_bulk_bytes || 10 * 1024 * 1024;
  }

  buildEsDocument(doc) {
    const esDoc = {
      source: doc.source,
      layer: doc.layer,
      name: { default: doc.name },
      phrase: { default: doc.name },
      center_point: { lat: doc.lat, lon: doc.lon },
      source_id: doc.event.record_id,
      parent: {}
    };

    // Names in other languages
    if (doc.nameAliases) {
      for (const [lang, name] of Object.entries(doc.nameAliases)) {
        esDoc.name[lang] = name;
        esDoc.phrase[lang] = name;
      }
    }

    // Address parts
    if (doc.address && Object.keys(doc.address).length > 0) {
      esDoc.address_parts = {};
      if (doc.address.housenumber) esDoc.address_parts.number = doc.address.housenumber;
      if (doc.address.street) esDoc.address_parts.street = doc.address.street;
      if (doc.address.postalcode) esDoc.address_parts.zip = doc.address.postalcode;
    }

    // Parent hierarchy
    if (doc.parent) {
      for (const [level, values] of Object.entries(doc.parent)) {
        esDoc.parent[level] = Array.isArray(values) ? values : [values];
      }
    }

    // Popularity
    if (doc.popularity != null) {
      esDoc.popularity = doc.popularity;
    }

    // Category
    if (doc.category && doc.category.length > 0) {
      esDoc.category = doc.category;
    }

    // Addendum
    if (doc.addendum) {
      esDoc.addendum = { postgis: JSON.stringify(doc.addendum) };
    }

    return esDoc;
  }

  splitIntoBulks(documents) {
    const bulks = [[]];
    let currentBytes = 0;
    let currentItems = 0;

    for (const doc of documents) {
      let ops;
      if (doc.action === 'DELETE') {
        ops = { action: { delete: { _index: this.writeAlias, _id: doc.esId } }, doc: null };
      } else {
        const esDoc = this.buildEsDocument(doc);
        ops = {
          action: {
            index: {
              _index: this.writeAlias,
              _id: doc.esId,
              version: doc.fetchedAt,
              version_type: 'external'
            }
          },
          doc: esDoc
        };
      }

      const opsSize = Buffer.byteLength(JSON.stringify(ops.action))
        + (ops.doc ? Buffer.byteLength(JSON.stringify(ops.doc)) : 0);

      if ((currentBytes + opsSize > this.maxBulkBytes || currentItems >= this.maxBulkItems)
          && bulks[bulks.length - 1].length > 0) {
        bulks.push([]);
        currentBytes = 0;
        currentItems = 0;
      }

      bulks[bulks.length - 1].push({ ...ops, originalDoc: doc });
      currentBytes += opsSize;
      currentItems++;
    }

    return bulks;
  }

  async writeBulk(bulkItems) {
    if (bulkItems.length === 0) return { successIds: [], failedItems: [] };

    const body = [];
    for (const item of bulkItems) {
      body.push(item.action);
      if (item.doc) body.push(item.doc);
    }

    const response = await this.es.bulk({ body, refresh: false });

    const successIds = [];
    const failedItems = [];

    const items = response.items || [];
    for (let i = 0; i < items.length; i++) {
      const result = items[i].index || items[i].delete;
      const original = bulkItems[i];

      if (result.error) {
        // version_conflict_engine_exception means a newer version exists — that's OK
        if (result.error.type === 'version_conflict_engine_exception') {
          successIds.push(original.originalDoc.event.id);
        } else {
          failedItems.push({
            event: original.originalDoc.event,
            error: result.error
          });
        }
      } else {
        successIds.push(original.originalDoc.event.id);
      }
    }

    return { successIds, failedItems };
  }

  async writeAll(documents) {
    const bulks = this.splitIntoBulks(documents);
    const allSuccessIds = [];
    const allFailedItems = [];

    for (const bulk of bulks) {
      if (bulk.length === 0) continue;
      const { successIds, failedItems } = await this.writeBulk(bulk);
      allSuccessIds.push(...successIds);
      allFailedItems.push(...failedItems);
    }

    return { successIds: allSuccessIds, failedItems: allFailedItems };
  }
}

module.exports = EsWriter;
