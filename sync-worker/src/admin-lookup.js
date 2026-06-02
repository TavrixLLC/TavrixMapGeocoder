'use strict';

const ADMIN_FIELDS = [
  'country',
  'country_a',
  'region',
  'region_a',
  'county',
  'locality',
  'localadmin',
  'neighbourhood'
];

class AdminLookup {
  constructor(config, postgisReader, logger) {
    this.config = config;
    this.postgisReader = postgisReader;
    this.log = logger;
    this.options = config.admin_enrichment || {};
    this.enabled = this.options.enabled !== false;
    this.cache = new Map();
    this.boundarySource = (config.sources || []).find(source =>
      source.name === (this.options.boundaries_source || 'admin_boundaries')
    );
  }

  async enrichBatch(docs, source) {
    if (!Array.isArray(docs) || docs.length === 0) return docs;

    if (!this.enabled) {
      for (const doc of docs) markStatus(doc, 'admin_enrichment_disabled', 'disabled_by_config');
      return docs;
    }

    if (!this.boundarySource) {
      for (const doc of docs) markMissingCountry(doc, 'boundary_source_not_configured');
      this.log.warn('Admin enrichment boundary source is not configured', {
        boundary_source: this.options.boundaries_source || 'admin_boundaries'
      });
      return docs;
    }

    const points = docs
      .map((doc, index) => ({ doc, index, key: cacheKey(doc, this.options.cache_grid_precision || 5) }))
      .filter(item => Number.isFinite(Number(item.doc.lon)) && Number.isFinite(Number(item.doc.lat)));
    const pointDocs = new Set(points.map(item => item.doc));
    for (const doc of docs) {
      if (!pointDocs.has(doc)) markMissingCountry(doc, 'missing_coordinates');
    }

    const misses = [];
    for (const item of points) {
      if (this.options.cache_enabled !== false && this.cache.has(item.key)) {
        applyAdmin(item.doc, this.cache.get(item.key));
      } else {
        misses.push(item);
      }
    }

    if (misses.length > 0) {
      try {
        const lookups = await this.lookupPoints(misses);
        for (const item of misses) {
          const admin = lookups.get(String(item.index)) || {};
          if (this.options.cache_enabled !== false) this.cache.set(item.key, admin);
          applyAdmin(item.doc, admin);
          if (!Object.keys(admin).length) {
            item.doc.admin_enrichment_reason = 'no_covering_admin_boundary';
          }
        }
      } catch (err) {
        this.log.error('Admin enrichment lookup failed; indexing documents with missing_country status', {
          source: source && source.name,
          error: err.message
        });
        for (const item of misses) markStatus(item.doc, 'admin_lookup_failed', 'lookup_failed');
      }
    }

    for (const doc of docs) {
      copyParentToAdminFields(doc);
      if (!doc.admin_enrichment_status) {
        markStatus(doc, hasCountryCode(doc) ? 'enriched' : 'missing_country',
          hasCountryCode(doc) ? null : (doc.admin_enrichment_reason || 'country_code_not_found'));
      }
    }

    return docs;
  }

  async lookupPoints(items) {
    const { sql, params } = buildAdminLookupSql(this.boundarySource, this.options, items);
    const rows = await this.postgisReader.queryReadOnly(sql, params);
    const byDoc = new Map();
    const levelMap = adminLevelMap(this.options);

    for (const row of rows) {
      const docKey = String(row.doc_key);
      if (!byDoc.has(docKey)) byDoc.set(docKey, {});
      const admin = byDoc.get(docKey);
      const field = levelMap.get(String(row.admin_level));
      if (!field) continue;

      if (row.name && !admin[field]) admin[field] = [String(row.name)];
      if (field === 'country' && row.country_a && !admin.country_a) {
        admin.country_a = [String(row.country_a).toUpperCase()];
      }
      if (field === 'region' && row.region_a && !admin.region_a) {
        admin.region_a = [String(row.region_a).toUpperCase()];
      }
    }

    return byDoc;
  }
}

function buildAdminLookupSql(boundarySource, options, items) {
  const params = [];
  const values = items.map((item, index) => {
    const base = index * 3;
    params.push(String(item.index), Number(item.doc.lon), Number(item.doc.lat));
    return `($${base + 1}::text, $${base + 2}::double precision, $${base + 3}::double precision)`;
  });
  const levels = [...adminLevelMap(options).keys()].map(level => `'${escapeLiteral(level)}'`).join(', ');
  const geom = quoteIdentifier(boundarySource.geometry_field);

  return {
    params,
    sql: `
      WITH input(doc_key, lon, lat) AS (
        VALUES ${values.join(', ')}
      ),
      points AS (
        SELECT doc_key, ST_SetSRID(ST_Point(lon, lat), 4326) AS geom
        FROM input
      ),
      boundaries AS (
        SELECT b.*
        FROM (
          ${boundarySource.sql}
        ) AS b
        WHERE b.${geom} IS NOT NULL
          AND b.admin_level::text IN (${levels})
      )
      SELECT
        p.doc_key,
        b.admin_level::text AS admin_level,
        b.name,
        NULLIF(b.country_a, '') AS country_a,
        NULLIF(b.region_a, '') AS region_a
      FROM points p
      JOIN boundaries b
        ON ST_Covers(b.${geom}, ST_Transform(p.geom, ST_SRID(b.${geom})))
      ORDER BY p.doc_key, b.admin_level::int ASC, ST_Area(b.${geom}) ASC
    `
  };
}

function adminLevelMap(options = {}) {
  return new Map([
    [String(options.country_admin_level || 2), 'country'],
    [String(options.region_admin_level || 4), 'region'],
    [String(options.county_admin_level || 6), 'county'],
    [String(options.locality_admin_level || 8), 'locality'],
    [String(options.localadmin_admin_level || 9), 'localadmin'],
    [String(options.neighbourhood_admin_level || 10), 'neighbourhood']
  ]);
}

function applyAdmin(doc, admin) {
  doc.parent = doc.parent || {};
  for (const field of ADMIN_FIELDS) {
    const values = admin[field];
    if (Array.isArray(values) && values.length > 0 && !doc.parent[field]) {
      doc.parent[field] = values;
    }
  }
}

function copyParentToAdminFields(doc) {
  for (const field of ADMIN_FIELDS) {
    const value = firstValue(doc.parent && doc.parent[field]);
    if (value) doc[field] = value;
  }
}

function markMissingCountry(doc, reason) {
  copyParentToAdminFields(doc);
  markStatus(doc, hasCountryCode(doc) ? 'enriched' : 'missing_country',
    hasCountryCode(doc) ? null : reason);
}

function markStatus(doc, status, reason) {
  doc.admin_enrichment_status = status;
  if (reason) doc.admin_enrichment_reason = reason;
}

function hasCountryCode(doc) {
  return Boolean(firstValue(doc.parent && doc.parent.country_a) || doc.country_a);
}

function firstValue(value) {
  if (Array.isArray(value)) return value.find(Boolean);
  return value || null;
}

function cacheKey(doc, precision) {
  const digits = Number.isFinite(Number(precision)) ? Number(precision) : 5;
  return `${Number(doc.lon).toFixed(digits)}:${Number(doc.lat).toFixed(digits)}`;
}

function quoteIdentifier(identifier) {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(identifier)) {
    throw new Error(`Invalid SQL identifier: ${identifier}`);
  }
  return `"${identifier}"`;
}

function escapeLiteral(value) {
  return String(value).replace(/'/g, "''");
}

module.exports = AdminLookup;
module.exports.buildAdminLookupSql = buildAdminLookupSql;
module.exports.adminLevelMap = adminLevelMap;
