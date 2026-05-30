'use strict';

/**
 * Builds GeoJSON Feature objects from Elasticsearch hit documents.
 *
 * response_mode controls which fields are included:
 *   - 'standard': core identity, basic address, category (default)
 *   - 'full': + POI details, routing, all address parts, names
 *   - 'debug': + ranking internals, source_tags, rank_debug
 */

const HIERARCHY_FIELDS = [
  'country', 'country_a', 'region', 'region_a',
  'county', 'locality', 'localadmin', 'neighbourhood'
];

const ADDRESS_FIELDS = [
  'street', 'housenumber', 'postalcode'
];

const POI_FIELDS = [
  'phone', 'website', 'opening_hours', 'brand',
  'operator', 'cuisine', 'wheelchair', 'delivery', 'takeaway'
];

function featureFromHit(hit, options = {}) {
  const doc = hit._source || {};
  const responseMode = options.response_mode || 'standard';
  const sourceId = doc.source_id != null ? String(doc.source_id) : hit._id;
  const name = nameValue(doc.name);
  const coordinates = doc.center_point
    ? [doc.center_point.lon, doc.center_point.lat]
    : [null, null];
  const category = Array.isArray(doc.category) ? doc.category : [];
  const addendum = parseAddendum(doc.addendum);

  // ── Base identity (always returned) ────────────────────────────
  const properties = {
    id: sourceId,
    gid: `${doc.source || 'unknown'}:${doc.layer || 'venue'}:${sourceId}`,
    layer: doc.layer,
    source: doc.source,
    source_id: sourceId,
    name,
    label: buildLabel(name, doc.parent),
    accuracy: 'point'
  };

  // ── Category (always returned when present) ────────────────────
  if (category.length > 0) {
    properties.category = category[0];
    properties.categories = category;
    properties.category_ids = category;
  }

  // ── Confidence / match quality (always returned when present) ──
  if (doc.confidence != null) properties.confidence = doc.confidence;
  if (doc.match_type != null) properties.match_type = doc.match_type;
  if (doc.bearing != null) properties.bearing = doc.bearing;
  if (doc.distance_score != null) properties.distance_score = doc.distance_score;
  if (doc.popularity != null) properties.popularity_score = doc.popularity;
  if (hit._score != null) properties.final_score = hit._score;

  // ── Address parts (always returned when present) ───────────────
  if (doc.address_parts && Object.keys(doc.address_parts).length > 0) {
    properties.address_parts = doc.address_parts;
  }

  // ── Hierarchy from parent (always) ─────────────────────────────
  extractHierarchy(properties, doc.parent);

  // ── Address fields from address_parts (always) ─────────────────
  extractAddressFields(properties, doc.address_parts);

  // ── Center ─────────────────────────────────────────────────────
  if (doc.center_point) {
    properties.center = [doc.center_point.lon, doc.center_point.lat];
  }

  // ── Routable point (always returned — fallback to center) ──────
  const routablePoint = buildRoutablePoint(doc);
  if (routablePoint) {
    properties.routable_point = [routablePoint.lon, routablePoint.lat];
  }

  // ── Distance from sort (nearby/reverse) ────────────────────────
  if (options.include_distance !== false && hit.sort && Array.isArray(hit.sort) && typeof hit.sort[0] === 'number') {
    properties.distance_meters = Math.round(hit.sort[0] * 100) / 100;
  }

  // ── Full mode: POI details, routing arrays, names ──────────────
  if (responseMode === 'full' || responseMode === 'debug') {
    enrichPOIFields(properties, doc, addendum);
    enrichRoutingArrays(properties, doc);
    enrichNamesObject(properties, doc);
  }

  // ── Debug mode: ranking internals, source_tags ─────────────────
  if (responseMode === 'debug') {
    if (hit._score != null) properties.relevance_score = hit._score;
    if (addendum) properties.source_tags = addendum.postgis || {};
    if (hit._explanation) properties.rank_debug = hit._explanation;
  }

  // ── Addendum (always if present) ───────────────────────────────
  if (addendum) properties.addendum = addendum;

  addLanguageFields(properties, doc, options);

  return {
    type: 'Feature',
    geometry: {
      type: 'Point',
      coordinates
    },
    properties
  };
}

function addLanguageFields(properties, doc, options = {}) {
  const names = doc.name && typeof doc.name === 'object' ? doc.name : {};
  const preferredLang = normalizeLangCode(options.lang);
  const fallbackLang = normalizeLangCode(options.fallback_lang);
  if (!preferredLang && !fallbackLang) return;

  const preferred = (preferredLang && names[preferredLang]) || names.default || properties.name;
  if (preferred) {
    properties.name_preferred = preferred;
    properties.label_preferred = buildLabel(preferred, doc.parent);
    if (preferredLang) properties.lang = preferredLang;
  }

  if (fallbackLang && fallbackLang !== preferredLang && names[fallbackLang]) {
    properties.name_fallback = names[fallbackLang];
    properties.label_fallback = buildLabel(names[fallbackLang], doc.parent);
    properties.fallback_lang = fallbackLang;
  }
}

function normalizeLangCode(lang) {
  return String(lang || '').split('-')[0].toLowerCase();
}

// ── Hierarchy extraction ──────────────────────────────────────────

function extractHierarchy(properties, parent) {
  if (!parent) return;
  for (const field of HIERARCHY_FIELDS) {
    const value = Array.isArray(parent[field]) ? parent[field][0] : parent[field];
    if (value) properties[field] = value;
  }
}

// ── Address field extraction ──────────────────────────────────────

function extractAddressFields(properties, addressParts) {
  if (!addressParts) return;
  for (const field of ADDRESS_FIELDS) {
    if (addressParts[field]) properties[field] = addressParts[field];
  }
  // Map 'number' to 'housenumber' for backward compatibility
  if (addressParts.number && !properties.housenumber) {
    properties.housenumber = addressParts.number;
  }
}

// ── POI field enrichment (full/debug modes) ───────────────────────

function enrichPOIFields(properties, doc, addendum) {
  const postgis = addendum && addendum.postgis ? addendum.postgis : {};

  for (const field of POI_FIELDS) {
    const candidates = [field, `contact:${field}`, `contact_${field}`];
    for (const key of candidates) {
      if (postgis[key] != null && properties[field] == null) {
        properties[field] = postgis[key];
      }
    }
    // Also check top-level doc fields
    if (doc[field] != null && properties[field] == null) {
      properties[field] = doc[field];
    }
  }
}

// ── Routing arrays (full/debug modes) ─────────────────────────────

function enrichRoutingArrays(properties, doc) {
  // Routable points array
  if (Array.isArray(doc.routable_points) && doc.routable_points.length > 0) {
    properties.routable_points = doc.routable_points;
  } else if (properties.routable_point) {
    // Build single-entry array from the main routable_point
    const rp = buildRoutablePoint(doc);
    if (rp) {
      properties.routable_points = [{
        lon: rp.lon,
        lat: rp.lat,
        type: rp.type || 'centroid_fallback',
        source: rp.source || 'center_point'
      }];
    }
  }

  // Entrances
  if (Array.isArray(doc.entrances) && doc.entrances.length > 0) {
    properties.entrances = doc.entrances;
  }
}

// ── Names object (full/debug modes) ──────────────────────────────

function enrichNamesObject(properties, doc) {
  if (doc.name && typeof doc.name === 'object') {
    const names = {};
    for (const [lang, value] of Object.entries(doc.name)) {
      if (lang !== 'default' && value) {
        names[lang] = value;
      }
    }
    if (Object.keys(names).length > 0) {
      properties.names = names;
    }
  }
}

// ── Routable point builder ────────────────────────────────────────

function buildRoutablePoint(doc) {
  // Prefer indexed routable_point
  if (doc.routable_point && doc.routable_point.lat != null && doc.routable_point.lon != null) {
    return {
      lon: doc.routable_point.lon,
      lat: doc.routable_point.lat,
      type: doc.routable_point_type || 'indexed',
      source: doc.routable_point_source || 'index'
    };
  }
  // Fallback to center_point
  if (doc.center_point && doc.center_point.lat != null && doc.center_point.lon != null) {
    return {
      lon: doc.center_point.lon,
      lat: doc.center_point.lat,
      type: 'centroid_fallback',
      source: 'center_point'
    };
  }
  return null;
}

// ── Name extraction ───────────────────────────────────────────────

function nameValue(name) {
  if (!name) return '';
  if (typeof name === 'string') return name;
  return name.default || name.en || name.ar || Object.values(name).find(Boolean) || '';
}

// ── Label builder ─────────────────────────────────────────────────

function buildLabel(name, parent) {
  const parts = [name];
  if (parent) {
    for (const key of ['locality', 'region', 'country']) {
      const value = Array.isArray(parent[key]) ? parent[key][0] : parent[key];
      if (value && !parts.includes(value)) parts.push(value);
    }
  }
  return parts.filter(Boolean).join(', ');
}

// ── Addendum parser ───────────────────────────────────────────────

function parseAddendum(addendum) {
  if (!addendum) return null;
  const out = { ...addendum };
  if (typeof out.postgis === 'string') {
    try {
      out.postgis = JSON.parse(out.postgis);
    } catch (_) {
      out.postgis = { raw: out.postgis };
    }
  }
  return out;
}

module.exports = {
  featureFromHit,
  enrichPOIFields,
  extractHierarchy,
  extractAddressFields,
  buildRoutablePoint,
  addLanguageFields,
  nameValue,
  buildLabel,
  parseAddendum
};
