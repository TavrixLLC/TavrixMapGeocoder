'use strict';

const { ApiError } = require('./errors');

const VALID_RESPONSE_MODES = new Set(['standard', 'full', 'debug']);
const VALID_SORT_MODES = new Set(['distance', 'relevance', 'hybrid']);
const VALID_CATEGORY_MODES = new Set(['any', 'all']);

const SEARCH_ALLOWED = new Set([
  'text',
  'size',
  'layers',
  'sources',
  'boundary.country',
  'boundary.rect.min_lon',
  'boundary.rect.min_lat',
  'boundary.rect.max_lon',
  'boundary.rect.max_lat',
  'boundary.circle.lat',
  'boundary.circle.lon',
  'boundary.circle.radius',
  'focus.point.lat',
  'focus.point.lon',
  'lang',
  'fallback_lang',
  'categories',
  'response_mode',
  'dedupe'
]);

const STRUCTURED_FIELDS = [
  'address', 'street', 'housenumber', 'neighbourhood',
  'locality', 'county', 'region', 'region_a',
  'postalcode', 'country', 'country_a'
];

function numberParam(query, name, { min = -Infinity, max = Infinity, required = false } = {}) {
  const raw = query[name];
  if (raw == null || raw === '') {
    if (required) throw new ApiError('invalid_request', `Missing required parameter: ${name}`, 400, { parameter: name });
    return undefined;
  }

  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < min || parsed > max) {
    throw new ApiError('invalid_request', `Invalid parameter: ${name}`, 400, { parameter: name, min, max });
  }
  return parsed;
}

function integerParam(query, name, { min = 1, max = 100, defaultValue } = {}) {
  const raw = query[name];
  if (raw == null || raw === '') return defaultValue;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw new ApiError('invalid_request', `Invalid parameter: ${name}`, 400, { parameter: name, min, max });
  }
  return parsed;
}

function stringParam(query, name, { maxLength, required = false, allowed } = {}) {
  const raw = query[name];
  if (raw == null || raw === '') {
    if (required) throw new ApiError('invalid_request', `Missing required parameter: ${name}`, 400, { parameter: name });
    return undefined;
  }
  const value = String(raw);
  if (maxLength && value.length > maxLength) {
    throw new ApiError('invalid_request', `Parameter ${name} exceeds maximum length of ${maxLength}`, 400, {
      parameter: name, max_length: maxLength
    });
  }
  if (allowed && !allowed.has(value)) {
    throw new ApiError('invalid_request', `Invalid value for ${name}: ${value}`, 400, {
      parameter: name, allowed: Array.from(allowed)
    });
  }
  return value;
}

function booleanParam(query, name, { defaultValue = undefined } = {}) {
  const raw = query[name];
  if (raw == null || raw === '') return defaultValue;
  const lower = String(raw).toLowerCase();
  if (lower === 'true' || lower === '1' || lower === 'yes') return true;
  if (lower === 'false' || lower === '0' || lower === 'no') return false;
  throw new ApiError('invalid_request', `Invalid boolean value for ${name}`, 400, { parameter: name });
}

function validateBoundary(query) {
  const minLon = numberParam(query, 'boundary.rect.min_lon', { min: -180, max: 180 });
  const maxLon = numberParam(query, 'boundary.rect.max_lon', { min: -180, max: 180 });
  const minLat = numberParam(query, 'boundary.rect.min_lat', { min: -90, max: 90 });
  const maxLat = numberParam(query, 'boundary.rect.max_lat', { min: -90, max: 90 });

  const rectValues = [minLon, maxLon, minLat, maxLat];
  const hasAnyRect = rectValues.some(value => value !== undefined);
  const hasAllRect = rectValues.every(value => value !== undefined);

  if (hasAnyRect && !hasAllRect) {
    throw new ApiError('invalid_request', 'All boundary.rect parameters are required together', 400, {
      required: ['boundary.rect.min_lon', 'boundary.rect.min_lat', 'boundary.rect.max_lon', 'boundary.rect.max_lat']
    });
  }

  if (hasAllRect && (minLon > maxLon || minLat > maxLat)) {
    throw new ApiError('invalid_request', 'Invalid boundary rectangle', 400, {
      min_lon: minLon,
      min_lat: minLat,
      max_lon: maxLon,
      max_lat: maxLat
    });
  }

  const circleLat = numberParam(query, 'boundary.circle.lat', { min: -90, max: 90 });
  const circleLon = numberParam(query, 'boundary.circle.lon', { min: -180, max: 180 });
  const circleRadius = numberParam(query, 'boundary.circle.radius', { min: 0.001, max: 50000000 });

  const circleValues = [circleLat, circleLon, circleRadius];
  const hasAnyCircle = circleValues.some(value => value !== undefined);
  const hasAllCircle = circleValues.every(value => value !== undefined);

  if (hasAnyCircle && !hasAllCircle) {
    throw new ApiError('invalid_request', 'All boundary.circle parameters are required together', 400, {
      required: ['boundary.circle.lat', 'boundary.circle.lon', 'boundary.circle.radius']
    });
  }

  return {
    rect: hasAllRect ? { minLon, minLat, maxLon, maxLat } : null,
    circle: hasAllCircle ? { lat: circleLat, lon: circleLon, radius: circleRadius } : null
  };
}

function validateFocus(query) {
  const hasLat = query['focus.point.lat'] != null && query['focus.point.lat'] !== '';
  const hasLon = query['focus.point.lon'] != null && query['focus.point.lon'] !== '';
  if (hasLat !== hasLon) {
    throw new ApiError('invalid_request', 'focus.point.lat and focus.point.lon must be supplied together', 400);
  }
  return {
    lat: numberParam(query, 'focus.point.lat', { min: -90, max: 90 }),
    lon: numberParam(query, 'focus.point.lon', { min: -180, max: 180 })
  };
}

function validatePoint(query) {
  return {
    lat: numberParam(query, 'point.lat', { min: -90, max: 90, required: true }),
    lon: numberParam(query, 'point.lon', { min: -180, max: 180, required: true })
  };
}

function validateResponseMode(query, config) {
  const mode = stringParam(query, 'response_mode', { allowed: VALID_RESPONSE_MODES });
  if (mode === 'debug') {
    // Debug mode authorization is checked at the app layer, not here.
    // We just validate the enum value.
  }
  return mode || 'standard';
}

function validateDedupe(query) {
  return booleanParam(query, 'dedupe', { defaultValue: true });
}

function validateSearchQuery(query, config = {}) {
  validateBoundary(query);
  validateFocus(query);
  const maxSize = config.maxSize || 40;
  integerParam(query, 'size', { min: 1, max: maxSize });
  const maxTextLength = config.maxTextLength || 256;
  if (query.text != null && String(query.text).length > maxTextLength) {
    throw new ApiError('invalid_request', `text exceeds maximum length of ${maxTextLength}`, 400, {
      parameter: 'text', max_length: maxTextLength
    });
  }
  if (!query.text || String(query.text).trim() === '') {
    throw new ApiError('invalid_request', 'Missing required parameter: text', 400, { parameter: 'text' });
  }
}

function validateReverseQuery(query, config = {}) {
  validatePoint(query);
  const maxSize = config.maxSize || 40;
  integerParam(query, 'size', { min: 1, max: maxSize });
  numberParam(query, 'radius', { min: 0.001, max: config.maxNearbyRadiusMeters || 50000 });
}

function validateStructuredQuery(query, config = {}) {
  validateBoundary(query);
  validateFocus(query);
  const maxSize = config.maxSize || 40;
  integerParam(query, 'size', { min: 1, max: maxSize });
  const maxFieldLen = config.maxStructuredFieldLength || 128;

  if (!STRUCTURED_FIELDS.some(field => query[field] && String(query[field]).trim() !== '')) {
    throw new ApiError('invalid_request', 'At least one structured search field is required', 400, {
      fields: STRUCTURED_FIELDS
    });
  }

  // Validate field lengths
  for (const field of STRUCTURED_FIELDS) {
    if (query[field] && String(query[field]).length > maxFieldLen) {
      throw new ApiError('invalid_request', `Field ${field} exceeds maximum length of ${maxFieldLen}`, 400, {
        parameter: field, max_length: maxFieldLen
      });
    }
  }
}

function validateNearbyQuery(query, config = {}) {
  validatePoint(query);
  validateBoundary(query);
  const maxSize = config.maxSize || 100;
  integerParam(query, 'size', { min: 1, max: maxSize, defaultValue: config.defaultSize || 10 });
  const maxRadius = config.maxNearbyRadiusMeters || 50000;
  numberParam(query, 'radius', { min: 0.001, max: maxRadius });
  stringParam(query, 'sort', { allowed: VALID_SORT_MODES });
  stringParam(query, 'category_mode', { allowed: VALID_CATEGORY_MODES });
  booleanParam(query, 'include_distance', { defaultValue: true });
}

function validateBatchBody(body, maxBatchSize) {
  if (!body || !Array.isArray(body.queries)) {
    throw new ApiError('invalid_request', 'Body must contain a queries array', 400);
  }
  if (body.queries.length === 0) {
    throw new ApiError('invalid_request', 'queries must not be empty', 400);
  }
  if (body.queries.length > maxBatchSize) {
    throw new ApiError('invalid_request', 'Batch size exceeds limit', 400, {
      max_batch_size: maxBatchSize
    });
  }
}

function copyAllowed(query, allowed = SEARCH_ALLOWED) {
  const out = {};
  for (const [key, value] of Object.entries(query)) {
    if (allowed.has(key) && value != null && value !== '') {
      out[key] = value;
    }
  }
  return out;
}

module.exports = {
  SEARCH_ALLOWED,
  STRUCTURED_FIELDS,
  VALID_RESPONSE_MODES,
  VALID_SORT_MODES,
  VALID_CATEGORY_MODES,
  booleanParam,
  copyAllowed,
  integerParam,
  numberParam,
  stringParam,
  validateBatchBody,
  validateBoundary,
  validateDedupe,
  validateFocus,
  validateNearbyQuery,
  validateResponseMode,
  validateReverseQuery,
  validateSearchQuery,
  validateStructuredQuery
};
