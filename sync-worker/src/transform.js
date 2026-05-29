'use strict';

class Transform {
  constructor(sourcesConfig, logger) {
    this.log = logger;
    this._configMap = new Map();
    for (const src of sourcesConfig) {
      this._configMap.set(src.table, src);
    }
  }

  toDomainModel(fetchedItem) {
    const { event, state, action } = fetchedItem;
    const sourceConfig = this._configMap.get(event.table_name);

    if (!sourceConfig) {
      return { event, action: 'ERROR', error: `No config for table ${event.table_name}` };
    }

    const esId = `postgis:${event.table_name}:${event.record_id}`;

    if (action === 'DELETE') {
      return { event, esId, action: 'DELETE' };
    }

    if (action === 'ERROR') {
      return fetchedItem;
    }

    // Build domain model from config-driven field mapping
    const doc = {
      esId,
      action: 'UPSERT',
      event,
      fetchedAt: Math.floor(state._fetched_at || Date.now()),
      source: sourceConfig.source_label || 'postgis',
      layer: sourceConfig.layer || 'venue',
      name: state[sourceConfig.name_field] || '',
      lat: parseFloat(state._lat),
      lon: parseFloat(state._lon),
      address: {},
      parent: {},
      nameAliases: {},
      category: [],
      popularity: null,
      addendum: null,
      raw: state
    };

    // Address fields
    if (sourceConfig.address_fields) {
      for (const [peliasField, dbField] of Object.entries(sourceConfig.address_fields)) {
        if (state[dbField] != null) {
          doc.address[peliasField] = String(state[dbField]);
        }
      }
    }

    // I18n name fields
    if (sourceConfig.name_fields_i18n) {
      for (const [lang, dbField] of Object.entries(sourceConfig.name_fields_i18n)) {
        if (state[dbField] != null) {
          doc.nameAliases[lang] = state[dbField];
        }
      }
    }

    // Parent fields (hierarchy)
    if (sourceConfig.parent_fields) {
      for (const [level, dbField] of Object.entries(sourceConfig.parent_fields)) {
        if (state[dbField] != null) {
          doc.parent[level] = [state[dbField]];
        }
      }
    }

    // Popularity
    if (sourceConfig.popularity_field && state[sourceConfig.popularity_field] != null) {
      doc.popularity = parseInt(state[sourceConfig.popularity_field], 10);
    }

    // Category
    if (sourceConfig.category_field && state[sourceConfig.category_field]) {
      doc.category = [state[sourceConfig.category_field]];
    }

    // Addendum fields
    if (sourceConfig.addendum_fields && sourceConfig.addendum_fields.length > 0) {
      const addendum = {};
      for (const field of sourceConfig.addendum_fields) {
        if (state[field] != null) {
          addendum[field] = state[field];
        }
      }
      if (Object.keys(addendum).length > 0) {
        doc.addendum = addendum;
      }
    }

    return doc;
  }

  transformBatch(fetchedItems) {
    return fetchedItems.map(item => this.toDomainModel(item));
  }
}

module.exports = Transform;
