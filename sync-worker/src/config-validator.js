'use strict';

const fs = require('fs');
const path = require('path');

const VALID_LAYERS = [
  'venue', 'address', 'street', 'locality', 'county',
  'region', 'country', 'neighbourhood', 'borough',
  'localadmin', 'macrocounty', 'macroregion', 'continent'
];

function loadConfig() {
  const configPaths = [
    path.resolve('/app/pelias.json'),
    path.resolve(process.cwd(), 'pelias.json'),
    path.resolve(__dirname, '../../pelias.json')
  ];

  let configPath = null;
  for (const p of configPaths) {
    if (fs.existsSync(p)) {
      configPath = p;
      break;
    }
  }

  if (!configPath) {
    console.error('FATAL: pelias.json not found in any of:', configPaths);
    process.exit(1);
  }

  try {
    const raw = fs.readFileSync(configPath, 'utf8');
    return JSON.parse(raw);
  } catch (err) {
    console.error(`FATAL: Failed to parse ${configPath}: ${err.message}`);
    process.exit(1);
  }
}

function validateConfig(config) {
  const errors = [];
  const sync = config.postgis_sync;

  if (!sync) {
    errors.push('Missing postgis_sync section');
    return failOnErrors(errors);
  }

  if (!Array.isArray(sync.sources) || sync.sources.length === 0) {
    errors.push('postgis_sync.sources must be a non-empty array');
    return failOnErrors(errors);
  }

  for (let i = 0; i < sync.sources.length; i++) {
    const src = sync.sources[i];
    const prefix = `sources[${i}] (${src.table || 'unnamed'})`;

    if (!src.table) errors.push(`${prefix}: missing table`);
    if (!src.id_field) errors.push(`${prefix}: missing id_field`);
    if (!src.name_field) errors.push(`${prefix}: missing name_field`);
    if (!src.geometry_field) errors.push(`${prefix}: missing geometry_field`);
    if (!src.layer) {
      errors.push(`${prefix}: missing layer`);
    } else if (!VALID_LAYERS.includes(src.layer)) {
      errors.push(`${prefix}: invalid layer '${src.layer}', must be one of: ${VALID_LAYERS.join(', ')}`);
    }
    if (!src.source_label) errors.push(`${prefix}: missing source_label`);

    if (src.weight != null && (src.weight < 1 || src.weight > 100)) {
      errors.push(`${prefix}: weight must be between 1 and 100`);
    }

    if (src.soft_delete) {
      if (!src.soft_delete.field) {
        errors.push(`${prefix}: soft_delete.field is required`);
      }
      if (!['not_null', 'true'].includes(src.soft_delete.delete_when)) {
        errors.push(`${prefix}: soft_delete.delete_when must be 'not_null' or 'true'`);
      }
    }
  }

  // Validate esclient
  if (!config.esclient || !config.esclient.hosts || config.esclient.hosts.length === 0) {
    errors.push('esclient.hosts must be a non-empty array');
  }

  failOnErrors(errors);
  return config;
}

function failOnErrors(errors) {
  if (errors.length > 0) {
    console.error('Configuration validation failed:');
    errors.forEach(e => console.error(`  ✗ ${e}`));
    process.exit(1);
  }
}

module.exports = { loadConfig, validateConfig };
