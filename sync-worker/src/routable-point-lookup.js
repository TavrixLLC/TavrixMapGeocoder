'use strict';

const DEFAULT_SNAP_LAYERS = new Set(['venue', 'address']);

class RoutablePointLookup {
  constructor(config, postgisReader, logger) {
    this.config = config;
    this.postgisReader = postgisReader;
    this.log = logger;
    this.options = normalizeOptions(config.routable_point_enrichment || {});
    this.enabled = this.options.enabled === true || process.env.P1_ENABLED === 'true' || process.env.ROUTABLE_POINT_ENRICHMENT_ENABLED === 'true';
    this.roadsSource = (config.sources || []).find(source =>
      source.name === this.options.roads_source
    );
    this.stats = new Map();
    this.roadsSrid = 4326;
    this.gistIndexExists = true;
    this.roadsCount = 0;
  }

  async init() {
    if (!this.enabled || !this.roadsSource) return;

    const geomField = this.roadsSource.geometry_field || 'way';
    let tableName = 'planet_osm_line';
    if (this.roadsSource.sql && /from\s+([A-Za-z0-9_]+)/i.test(this.roadsSource.sql)) {
      const match = this.roadsSource.sql.match(/from\s+([A-Za-z0-9_]+)/i);
      if (match) tableName = match[1];
    }

    try {
      const sridRes = await this.postgisReader.queryReadOnly(`
        SELECT Find_SRID('public', $1, $2) AS srid
      `, [tableName, geomField]);
      let srid = Number(sridRes[0]?.srid || 0);

      if (srid === 0) {
        const rowSridRes = await this.postgisReader.queryReadOnly(`
          SELECT ST_SRID("${geomField}") AS srid
          FROM (
            ${this.roadsSource.sql}
          ) AS sub
          WHERE "${geomField}" IS NOT NULL
          LIMIT 1;
        `);
        srid = Number(rowSridRes[0]?.srid || 0);
      }

      this.roadsSrid = srid || 4326;
    } catch (err) {
      this.log.warn('Could not determine roads source SRID; defaulting to 4326', { error: err.message });
      this.roadsSrid = 4326;
    }

    try {
      const indexRes = await this.postgisReader.queryReadOnly(`
        SELECT i.relname as index_name
        FROM pg_class t, pg_class i, pg_index ix, pg_attribute a, pg_am am
        WHERE t.oid = ix.indrelid
          AND i.oid = ix.indexrelid
          AND a.attrelid = t.oid
          AND a.attnum = ANY(ix.indkey)
          AND t.relkind = 'r'
          AND t.relname = $1
          AND a.attname = $2
          AND i.relam = am.oid
          AND am.amname = 'gist'
        LIMIT 1;
      `, [tableName, geomField]);

      if (indexRes.length === 0) {
        this.gistIndexExists = false;
      } else {
        this.gistIndexExists = true;
        this.gistIndexName = indexRes[0].index_name;
      }
    } catch (err) {
      this.log.warn('Could not verify spatial index existence', { error: err.message });
      this.gistIndexExists = true;
    }

    try {
      let filter = 'highway IS NOT NULL';
      if (this.roadsSource.sql && /where\s+([\s\S]+)$/i.test(this.roadsSource.sql)) {
        const match = this.roadsSource.sql.match(/where\s+([\s\S]+)$/i);
        if (match) filter = match[1];
      }
      const countRes = await this.postgisReader.queryReadOnly(`
        SELECT COUNT(*) as total_roads
        FROM ${tableName}
        WHERE ${filter}
      `);
      this.roadsCount = Number(countRes[0]?.total_roads || 0);
    } catch (err) {
      this.roadsCount = 0;
    }

    const maxDist = this.options.max_snap_distance_meters;
    const isProjected = (this.roadsSrid !== 4326 && this.roadsSrid !== 4269);
    const maxDistSourceUnits = isProjected ? maxDist : (maxDist / 111000.0);

    this.log.info('P1 Routable Point Snapping Diagnostics', {
      road_srid: this.roadsSrid,
      road_count: this.roadsCount,
      gist_index_exists: this.gistIndexExists,
      gist_index_name: this.gistIndexName || 'none',
      max_snap_distance_meters: maxDist,
      max_snap_distance_source_units: maxDistSourceUnits,
      batch_size: this.options.batch_size
    });
  }

  initStats(sourceName) {
    this.stats.set(sourceName, {
      snapped_count: 0,
      fallback_count: 0,
      not_applicable_count: 0,
      snap_failed_count: 0,
      distances: [],
      query_durations: []
    });
  }

  getStats(sourceName) {
    return this.stats.get(sourceName);
  }

  async enrichBatch(docs, source = {}) {
    if (!Array.isArray(docs) || docs.length === 0) return docs;
    if (!this.enabled) return docs;

    const started = Date.now();
    const stats = this.stats.get(source.name);

    const candidates = docs.filter(doc => shouldSnap(doc, source, this.options));
    const ignored = docs.filter(doc => !candidates.includes(doc));
    for (const doc of ignored) {
      if (!isSnapLayer(doc.layer || source.layer, this.options)) {
        applyFallback(doc, 'not_applicable', this.options);
        if (stats) stats.not_applicable_count++;
      } else {
        applyFallback(doc, 'not_applicable', this.options);
        if (stats) stats.not_applicable_count++;
      }
    }

    if (candidates.length === 0) return docs;
    if (!this.roadsSource) {
      this.log.warn('Routable point roads source is not configured; using center fallback', {
        source: source.name,
        roads_source: this.options.roads_source
      });
      for (const doc of candidates) {
        applyFallback(doc, 'roads_source_not_configured', this.options);
        if (stats) stats.snap_failed_count++;
      }
      return docs;
    }

    let snapped = 0;
    let fallback = 0;
    let failed = 0;
    const distances = [];

    for (const chunk of chunks(candidates, this.options.batch_size)) {
      try {
        const queryStarted = Date.now();
        const rows = await this.lookupRoads(chunk);
        const queryDurationMs = Date.now() - queryStarted;
        if (stats) stats.query_durations.push(queryDurationMs);

        const byKey = new Map(rows.map(row => [String(row.doc_key), row]));

        for (let index = 0; index < chunk.length; index++) {
          const doc = chunk[index];
          const row = byKey.get(String(index));
          if (row && Number.isFinite(Number(row.lon)) && Number.isFinite(Number(row.lat))) {
            const distance = Number(row.distance_meters);
            doc.routable_point = {
              lat: Number(row.lat),
              lon: Number(row.lon)
            };
            doc.routable_point_type = 'snapped';
            doc.routable_point_status = 'snapped';
            doc.routable_point_source = 'postgis_nearest_road';
            if (Number.isFinite(distance)) {
              doc.routable_point_distance_meters = distance;
              distances.push(distance);
              if (stats) stats.distances.push(distance);
            }
            doc.routable_points = [{
              lat: doc.routable_point.lat,
              lon: doc.routable_point.lon,
              type: 'snapped',
              source: 'postgis_nearest_road',
              distance_meters: Number.isFinite(distance) ? distance : undefined
            }];
            snapped += 1;
            if (stats) stats.snapped_count++;
          } else {
            applyFallback(doc, 'no_road_found', this.options);
            fallback += 1;
            if (stats) stats.fallback_count++;
          }
        }
      } catch (err) {
        failed += chunk.length;
        fallback += chunk.length;
        if (stats) stats.snap_failed_count += chunk.length;
        this.log.error('Routable point snap batch failed; using center fallback', {
          source: source.name,
          batch_size: chunk.length,
          error: err.message
        });
        for (const doc of chunk) applyFallback(doc, snapFailureReason(err), this.options);
      }
    }

    const durationMs = Date.now() - started;
    const maxDistance = distances.length > 0 ? Math.max(...distances) : 0;
    const avgDistance = distances.length > 0
      ? distances.reduce((sum, value) => sum + value, 0) / distances.length
      : 0;

    this.log.info('Routable point snap finished', {
      source: source.name,
      batch_size: candidates.length,
      snapped_count: snapped,
      fallback_count: fallback,
      failed_count: failed,
      avg_snap_distance_meters: roundDistance(avgDistance),
      max_snap_distance_meters: roundDistance(maxDistance),
      query_duration_ms: durationMs
    });

    return docs;
  }

  async lookupRoads(docs) {
    const items = docs.map((doc, index) => ({ doc, index }));
    const { sql, params } = buildRoutablePointSnapSql(this.roadsSource, this.options, items, this.roadsSrid);
    return this.postgisReader.queryReadOnly(sql, params, {
      statementTimeoutMs: this.options.query_timeout_ms
    });
  }
}

function buildRoutablePointSnapSql(roadsSource, options, items, roadSrid) {
  const params = [];
  const values = items.map((item, index) => {
    const base = index * 3;
    params.push(String(index), Number(item.doc.lon), Number(item.doc.lat));
    return `($${base + 1}::text, $${base + 2}::double precision, $${base + 3}::double precision)`;
  });

  const srid = Number(roadSrid || 4326);
  const isLatLon = (srid === 4326 || srid === 4269);
  const maxDistanceMeters = Number(options.max_snap_distance_meters || 50);
  
  // Safe bbox degree prefilter: 1 degree latitude is ~111,000m
  const radius = isLatLon ? (maxDistanceMeters / 111000.0) : maxDistanceMeters;

  const radiusParam = params.length + 1;
  params.push(Number(radius));

  const maxMetersParam = params.length + 1;
  params.push(Number(maxDistanceMeters));

  const geom = quoteIdentifier(roadsSource.geometry_field || 'way');

  return {
    params,
    sql: `
      WITH input(doc_key, lon, lat) AS (
        VALUES ${values.join(', ')}
      ),
      points AS (
        SELECT
          doc_key,
          ST_SetSRID(ST_Point(lon, lat), 4326) AS geom_4326,
          ST_Transform(ST_SetSRID(ST_Point(lon, lat), 4326), ${srid}) AS geom_road_srid
        FROM input
        WHERE lon BETWEEN -180 AND 180
          AND lat BETWEEN -90 AND 90
      ),
      roads AS (
        SELECT *
        FROM (
          ${roadsSource.sql}
        ) AS r
        WHERE r.${geom} IS NOT NULL
      ),
      snapped AS (
        SELECT
          p.doc_key,
          snap.distance_meters,
          snap.snapped_4326
        FROM points p
        LEFT JOIN LATERAL (
          SELECT
            ST_Transform(
              ST_ClosestPoint(r.${geom}, p.geom_road_srid),
              4326
            ) AS snapped_4326,
            ST_Distance(
              ST_Transform(ST_ClosestPoint(r.${geom}, p.geom_road_srid), 4326)::geography,
              p.geom_4326::geography
            ) AS distance_meters
          FROM roads r
          WHERE r.${geom} && ST_Expand(p.geom_road_srid, $${radiusParam}::double precision)
            AND ST_DWithin(r.${geom}, p.geom_road_srid, $${radiusParam}::double precision)
          ORDER BY r.${geom} <-> p.geom_road_srid
          LIMIT 1
        ) snap ON true
      )
      SELECT
        doc_key,
        ST_X(snapped_4326) AS lon,
        ST_Y(snapped_4326) AS lat,
        distance_meters
      FROM snapped
      WHERE snapped_4326 IS NOT NULL
        AND distance_meters <= $${maxMetersParam}::double precision
    `
  };
}

function normalizeOptions(options = {}) {
  let defaultBatchSize = 500;
  const isP1Verify = process.env.P1_ENABLED === 'true' || process.env.ROUTABLE_POINT_ENRICHMENT_ENABLED === 'true';
  if (isP1Verify) {
    defaultBatchSize = Number(process.env.P1_VERIFY_BATCH_SIZE || 100);
  }

  let batchSize = Number(options.batch_size || defaultBatchSize);
  if (isP1Verify && process.env.P1_VERIFY_BATCH_SIZE) {
    batchSize = Number(process.env.P1_VERIFY_BATCH_SIZE);
  }

  return {
    enabled: options.enabled === true,
    mode: options.mode || 'postgis_nearest_road',
    roads_source: options.roads_source || 'streets',
    max_snap_distance_meters: Number(options.max_snap_distance_meters || 50),
    batch_size: batchSize,
    fallback_to_center: options.fallback_to_center !== false,
    query_timeout_ms: Number(options.query_timeout_ms || 30000),
    source_srid_if_missing: Number(options.source_srid_if_missing || 0),
    layers: Array.isArray(options.layers) && options.layers.length > 0
      ? options.layers.map(String)
      : [...DEFAULT_SNAP_LAYERS],
    snap_admin_polygons: options.snap_admin_polygons === true
  };
}

function shouldSnap(doc, source, options) {
  if (!Number.isFinite(Number(doc.lon)) || !Number.isFinite(Number(doc.lat))) return false;
  if (!isSnapLayer(doc.layer || source.layer, options)) return false;
  return true;
}

function isSnapLayer(layer, options) {
  const value = String(layer || '');
  if (options.snap_admin_polygons && ['country', 'region', 'county', 'locality', 'localadmin', 'neighbourhood'].includes(value)) {
    return true;
  }
  return new Set(options.layers || [...DEFAULT_SNAP_LAYERS]).has(value);
}

function applyCenterFallback(doc, reason) {
  if (doc.routable_point || doc.routable_point_status === 'snapped') return;
  doc.routable_point = {
    lat: Number(doc.lat),
    lon: Number(doc.lon)
  };
  doc.routable_point_type = reason === 'not_applicable' ? 'not_applicable' : 'centroid_fallback';
  doc.routable_point_status = doc.routable_point_type;
  doc.routable_point_source = 'center_point';
  doc.routable_point_reason = reason;
  doc.routable_points = [{
    lat: doc.routable_point.lat,
    lon: doc.routable_point.lon,
    type: doc.routable_point_type,
    source: 'center_point'
  }];
}

function applyFallback(doc, reason, options = {}) {
  if (options.fallback_to_center === false) {
    doc.routable_point_status = reason;
    doc.routable_point_reason = reason;
    return;
  }
  applyCenterFallback(doc, reason);
}

function snapFailureReason(err) {
  if (err && (err.code === '57014' || /timeout|cancel/i.test(err.message || ''))) {
    return 'statement_timeout';
  }
  if (err && /srid/i.test(err.message || '')) {
    return 'snap_srid_error';
  }
  return 'snap_query_failed';
}

function chunks(items, size) {
  const chunkSize = Math.max(1, Number(size || 500));
  const out = [];
  for (let index = 0; index < items.length; index += chunkSize) {
    out.push(items.slice(index, index + chunkSize));
  }
  return out;
}

function quoteIdentifier(identifier) {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(identifier)) {
    throw new Error(`Invalid SQL identifier: ${identifier}`);
  }
  return `"${identifier}"`;
}

function roundDistance(value) {
  return Math.round(Number(value || 0) * 100) / 100;
}

module.exports = RoutablePointLookup;
module.exports.buildRoutablePointSnapSql = buildRoutablePointSnapSql;
module.exports.normalizeOptions = normalizeOptions;
module.exports.applyCenterFallback = applyCenterFallback;
