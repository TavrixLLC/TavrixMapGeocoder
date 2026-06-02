'use strict';

const fs = require('fs');
const Ajv = require('ajv');

const schema = {
  type: 'object',
  required: ['worker', 'postgis', 'elasticsearch', 'state', 'sources'],
  properties: {
    worker: {
      type: 'object',
      properties: {
        mode: { enum: ['scheduled', 'one-shot'] },
        dry_run: { type: 'boolean' },
        health_port: { type: 'integer', minimum: 1 }
      },
      additionalProperties: true
    },
    admin_enrichment: {
      type: 'object',
      properties: {
        enabled: { type: 'boolean' },
        boundaries_source: { type: 'string' },
        country_admin_level: { type: 'integer', minimum: 1 },
        region_admin_level: { type: 'integer', minimum: 1 },
        county_admin_level: { type: 'integer', minimum: 1 },
        locality_admin_level: { type: 'integer', minimum: 1 },
        localadmin_admin_level: { type: 'integer', minimum: 1 },
        neighbourhood_admin_level: { type: 'integer', minimum: 1 },
        use_point_on_surface_for_polygons: { type: 'boolean' },
        cache_enabled: { type: 'boolean' },
        cache_grid_precision: { type: 'integer', minimum: 0, maximum: 8 }
      },
      additionalProperties: false
    },
    postgis: {
      type: 'object',
      properties: {
        statement_timeout_ms: { type: 'integer', minimum: 1000 },
        idle_in_transaction_session_timeout_ms: { type: 'integer', minimum: 1000 },
        fetch_size: { type: 'integer', minimum: 1 }
      },
      additionalProperties: false
    },
    elasticsearch: {
      type: 'object',
      required: ['url', 'read_alias', 'write_alias', 'index_prefix', 'initial_index'],
      properties: {
        url: { type: 'string' },
        read_alias: { type: 'string' },
        write_alias: { type: 'string' },
        index_prefix: { type: 'string' },
        initial_index: { type: 'string' },
        request_timeout_ms: { type: 'integer', minimum: 1000 },
        max_retries: { type: 'integer', minimum: 0 },
        retry_base_delay_ms: { type: 'integer', minimum: 1 },
        max_bulk_docs: { type: 'integer', minimum: 1 },
        max_bulk_bytes: { type: 'integer', minimum: 1024 },
        number_of_shards: { type: 'integer', minimum: 1 },
        number_of_replicas: { type: 'integer', minimum: 0 }
      },
      additionalProperties: false
    },
    state: {
      type: 'object',
      required: ['path'],
      properties: {
        backend: { enum: ['json', 'sqlite'] },
        path: { type: 'string' },
        sqlite_path: { type: 'string' },
        json_path: { type: 'string' },
        json_snapshot_path: { type: 'string' },
        snapshot_path: { type: 'string' },
        store_seen_ids: { type: 'boolean' },
        failed_sample_path: { type: 'string' }
      },
      additionalProperties: false
    },
    sources: {
      type: 'array',
      minItems: 1,
      items: {
        type: 'object',
        required: ['name', 'layer', 'source_label', 'id_field', 'geometry_field', 'sql', 'name_fields'],
        properties: {
          name: { type: 'string', pattern: '^[a-zA-Z0-9_-]+$' },
          enabled: { type: 'boolean' },
          layer: { type: 'string' },
          source_label: { type: 'string' },
          id_field: { type: 'string' },
          geometry_field: { type: 'string' },
          sql: { type: 'string' },
          name_fields: { type: 'array', items: { type: 'string' }, minItems: 1 },
          category_fields: { type: 'array', items: { type: 'string' } },
          address_fields: { type: 'object', additionalProperties: { type: 'string' } },
          hierarchy_fields: { type: 'object', additionalProperties: { type: 'string' } },
          popularity_field: { type: 'string' },
          addendum_fields: { type: 'array', items: { type: 'string' } },
          update_timestamp_field: { type: 'string' },
          schedule: { type: 'string' },
          stale_after_seconds: { type: 'integer', minimum: 1 },
          batch_size: { type: 'integer', minimum: 1 },
          delete_strategy: { enum: ['none', 'source_diff'] },
          drop_check_min_previous_count: { type: 'integer', minimum: 0 },
          max_drop_ratio: { type: 'number', minimum: 0, maximum: 1 },
          max_failed_ratio: { type: 'number', minimum: 0, maximum: 1 },
          allow_count_drop: { type: 'boolean' },
          layer_map: {
            type: 'object',
            required: ['field', 'values'],
            properties: {
              field: { type: 'string' },
              values: { type: 'object', additionalProperties: { type: 'string' } }
            },
            additionalProperties: false
          }
        },
        additionalProperties: false
      }
    }
  },
  additionalProperties: false
};

function loadConfig(path = process.env.SYNC_CONFIG_PATH || '/app/config/pelias-postgis-readonly-sync.json') {
  const raw = fs.readFileSync(path, 'utf8');
  const config = JSON.parse(raw);
  validateConfig(config);
  return config;
}

function validateConfig(config) {
  const ajv = new Ajv({ allErrors: true });
  const validate = ajv.compile(schema);

  if (!validate(config)) {
    const details = validate.errors.map(err => `${err.instancePath || '/'} ${err.message}`).join('; ');
    throw new Error(`Invalid sync config: ${details}`);
  }

  const seen = new Set();
  for (const source of config.sources) {
    if (seen.has(source.name)) {
      throw new Error(`Duplicate source name: ${source.name}`);
    }
    seen.add(source.name);

    validateReadOnlySql(source);
  }
}

function validateReadOnlySql(source) {
  const sql = source.sql.trim();
  if (!/^select\b/i.test(sql)) {
    throw new Error(`Source ${source.name} must use a SELECT query`);
  }

  if (sql.includes(';')) {
    throw new Error(`Source ${source.name} SQL must be a single SELECT without semicolons`);
  }

  if (/\bfor\s+(update|share|no\s+key\s+update|key\s+share)\b/i.test(sql)) {
    throw new Error(`Source ${source.name} SQL contains a row-locking clause`);
  }

  const blocked = /\b(insert|update|delete|merge|copy|create|alter|drop|truncate|grant|revoke|vacuum|analyze|listen|notify|call)\b/i;
  if (blocked.test(sql)) {
    throw new Error(`Source ${source.name} SQL contains a non-read-only keyword`);
  }

  if (/\bfrom\s+planet_osm_/i.test(sql) && !/\bwhere\b/i.test(sql)) {
    throw new Error(`Source ${source.name} SQL must filter planet_osm rows with a WHERE clause`);
  }
}

module.exports = {
  loadConfig,
  validateConfig,
  schema
};
