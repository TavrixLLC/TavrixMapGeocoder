'use strict';

class Transform {
  constructor(config, logger) {
    this.config = config;
    this.log = logger;
  }

  toDomainDoc(source, row) {
    const recordId = value(row, source.id_field);
    if (recordId == null || recordId === '') {
      throw new Error(`Source ${source.name} row has no id field ${source.id_field}`);
    }

    const lat = Number(row._lat);
    const lon = Number(row._lon);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
      throw new Error(`Source ${source.name} row ${recordId} has invalid geometry`);
    }

    const names = buildNames(row, source.name_fields);
    if (!names.default) {
      throw new Error(`Source ${source.name} row ${recordId} has no usable name`);
    }

    const layer = resolveLayer(source, row);
    const categories = collectValues(row, source.category_fields || []);
    const address = mapFields(row, source.address_fields || {});
    const parent = mapParentFields(row, source.hierarchy_fields || {});
    const addendum = mapAddendum(row, source.addendum_fields || []);
    const popularity = parsePopularity(value(row, source.popularity_field));

    return {
      id: `postgis:${source.name}:${recordId}`,
      recordId: String(recordId),
      sourceName: source.name,
      source: source.source_label,
      layer,
      name: names.default,
      names,
      lat,
      lon,
      categories,
      address,
      parent,
      addendum,
      popularity,
      // Routable point/entrances: not yet available from PostGIS queries
      // TODO: Add entrance extraction SQL and nearest-road enrichment
      routable_point: null,
      routable_points: [],
      entrances: [],
      raw: row
    };
  }
}

function buildNames(row, fields) {
  const names = {};

  fields.forEach((field, index) => {
    const raw = value(row, field);
    if (raw == null) return;

    const clean = String(raw).trim();
    if (!clean) return;

    if (index === 0 && !names.default) {
      names.default = clean;
    }

    const lang = languageFromField(field);
    if (lang && !names[lang]) {
      names[lang] = clean;
    }
  });

  // Also try Kurdish fields: name_ku, name:ku, name_ckb
  for (const kuField of ['name_ku', 'name:ku', 'name_ckb', 'name:ckb']) {
    const kuValue = value(row, kuField);
    if (kuValue && String(kuValue).trim()) {
      if (!names.ku) names.ku = String(kuValue).trim();
    }
  }

  return names;
}

function languageFromField(field) {
  const match = field.match(/(?:^|_)([a-z]{2,3})$/i);
  if (!match) return null;
  return match[1].toLowerCase();
}

function resolveLayer(source, row) {
  if (!source.layer_map) return source.layer;

  const key = value(row, source.layer_map.field);
  const mapped = source.layer_map.values[String(key)];
  return mapped || source.layer;
}

function collectValues(row, fields) {
  const out = [];
  for (const field of fields) {
    const raw = value(row, field);
    if (raw == null) continue;

    const clean = String(raw).trim();
    if (clean) out.push(clean);
  }
  return out;
}

function mapFields(row, mapping) {
  const out = {};
  for (const [targetField, sourceField] of Object.entries(mapping)) {
    const raw = value(row, sourceField);
    if (raw == null) continue;

    const clean = String(raw).trim();
    if (clean) out[targetField] = clean;
  }
  return out;
}

function mapParentFields(row, mapping) {
  const out = {};
  for (const [targetField, sourceField] of Object.entries(mapping)) {
    const raw = value(row, sourceField);
    if (raw == null) continue;

    const clean = String(raw).trim();
    if (clean) out[targetField] = [clean];
  }
  return out;
}

function mapAddendum(row, fields) {
  const out = {};
  for (const field of fields) {
    const raw = value(row, field);
    if (raw != null && String(raw).trim() !== '') {
      out[field] = raw;
    }
  }
  return out;
}

function parsePopularity(raw) {
  if (raw == null || raw === '') return null;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : null;
}

function value(row, field) {
  if (!field) return undefined;
  return row[field];
}

module.exports = Transform;
