'use strict';

const { enrichPOIFields, extractHierarchy, extractTopLevelHierarchy, extractAddressFields, buildRoutablePoint } = require('./feature-builder');

/**
 * Enriches a Pelias FeatureCollection response with additional data
 * from Elasticsearch documents: language fallback, POI metadata,
 * routing points, address hierarchy, and category details.
 */
async function enrichFeatureCollection(collection, esService, query, config = {}) {
  if (!collection || !Array.isArray(collection.features)) return collection;

  const responseMode = query.response_mode || 'standard';

  for (const feature of collection.features) {
    const hit = await esService.findDocumentByFeature(feature);
    if (!hit) continue;

    const doc = hit.source;

    // ── Address hierarchy ──────────────────────────────────────
    if (doc.parent) {
      extractHierarchy(feature.properties, doc.parent);
    }
    extractTopLevelHierarchy(feature.properties, doc);
    if (doc.admin_enrichment_status) {
      feature.properties.admin_enrichment_status = doc.admin_enrichment_status;
    }

    // ── Address parts ──────────────────────────────────────────
    if (doc.address_parts && !feature.properties.address_parts) {
      feature.properties.address_parts = doc.address_parts;
    }
    extractAddressFields(feature.properties, doc.address_parts);

    // ── Categories ─────────────────────────────────────────────
    if (Array.isArray(doc.category) && doc.category.length > 0) {
      feature.properties.category = feature.properties.category || doc.category[0];
      feature.properties.categories = feature.properties.categories || doc.category;
      feature.properties.category_ids = feature.properties.category_ids || doc.category_ids || doc.category;
    }

    if (doc.bearing != null && feature.properties.bearing == null) feature.properties.bearing = doc.bearing;
    if (doc.distance_score != null && feature.properties.distance_score == null) {
      feature.properties.distance_score = doc.distance_score;
    }
    if (doc.popularity != null && feature.properties.popularity_score == null) {
      feature.properties.popularity_score = doc.popularity;
    }
    if (hit.score != null && feature.properties.final_score == null) feature.properties.final_score = hit.score;

    // ── Routable point (always, with fallback) ─────────────────
    const rp = buildRoutablePoint(doc);
    if (rp && !feature.properties.routable_point) {
      feature.properties.routable_point = [rp.lon, rp.lat];
    }

    // ── Center ─────────────────────────────────────────────────
    if (doc.center_point && !feature.properties.center) {
      feature.properties.center = [doc.center_point.lon, doc.center_point.lat];
    }

    // ── Full/Debug: POI details ────────────────────────────────
    if (responseMode === 'full' || responseMode === 'debug') {
      const addendum = parseAddendumSafe(doc.addendum);
      enrichPOIFields(feature.properties, doc, addendum);

      // Names object
      if (doc.name && typeof doc.name === 'object') {
        const names = {};
        for (const [lang, value] of Object.entries(doc.name)) {
          if (lang !== 'default' && value) names[lang] = value;
        }
        if (Object.keys(names).length > 0) {
          feature.properties.names = names;
        }
      }

      // Routing arrays
      if (Array.isArray(doc.routable_points) && doc.routable_points.length > 0) {
        feature.properties.routable_points = doc.routable_points;
      } else if (rp) {
        feature.properties.routable_points = [{
          lon: rp.lon,
          lat: rp.lat,
          type: rp.type || 'centroid_fallback',
          source: rp.source || 'center_point'
        }];
      }

      if (Array.isArray(doc.entrances) && doc.entrances.length > 0) {
        feature.properties.entrances = doc.entrances;
      }
    }

    // ── Debug: ranking/source details ──────────────────────────
    if (responseMode === 'debug') {
      if (hit.score != null) feature.properties.relevance_score = hit.score;
      const addendum = parseAddendumSafe(doc.addendum);
      if (doc.source_tags) {
        feature.properties.source_tags = doc.source_tags;
      } else if (addendum && addendum.postgis) {
        feature.properties.source_tags = addendum.postgis;
      }
    }

    // ── Language fallback ──────────────────────────────────────
    addLanguageFallback(feature.properties, doc, query, config);
  }

  return collection;
}

/**
 * Applies language fallback using the configured chain:
 * 1. Requested lang
 * 2. Explicit fallback_lang
 * 3. Config default_lang
 * 4. Config default_fallback_lang
 * 5. name.default
 */
function addLanguageFallback(properties, doc, query, config = {}) {
  const names = doc.name || {};
  const preferredLang = normalizeLangCode(query.lang || config.defaultLang || '');
  const fallbackLang = normalizeLangCode(query.fallback_lang || config.defaultFallbackLang || '');

  // Resolve preferred name
  const preferred = names[preferredLang] || names.default || properties.name;

  // Resolve fallback name
  let fallback = null;
  if (fallbackLang && fallbackLang !== preferredLang) {
    fallback = names[fallbackLang] || null;
  }

  // If neither lang nor fallback_lang is specified by user, skip
  const userRequestedLang = query.lang || query.fallback_lang;
  if (!userRequestedLang) return;

  if (preferred) {
    properties.name_preferred = preferred;
    properties.label_preferred = replaceFirstLabelPart(properties.label, preferred);
    properties.lang = preferredLang || undefined;
  }

  if (fallback) {
    properties.name_fallback = fallback;
    properties.label_fallback = replaceFirstLabelPart(properties.label, fallback);
    properties.fallback_lang = fallbackLang || undefined;
  }
}

function normalizeLangCode(lang) {
  return String(lang || '').split('-')[0].toLowerCase();
}

function replaceFirstLabelPart(label, name) {
  const parts = String(label || '').split(',').map(part => part.trim()).filter(Boolean);
  if (parts.length === 0) return name;
  parts[0] = name;
  return parts.join(', ');
}

function parseAddendumSafe(addendum) {
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
  enrichFeatureCollection,
  addLanguageFallback,
  normalizeLangCode
};
