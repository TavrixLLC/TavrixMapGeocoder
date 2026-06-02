'use strict';

class PeliasDocumentBuilder {
  build(domainDoc) {
    const name = {};
    const phrase = {};

    for (const [lang, value] of Object.entries(domainDoc.names)) {
      if (value) {
        name[lang] = value;
        phrase[lang] = value;
      }
    }

    if (!name.default && domainDoc.name) {
      name.default = domainDoc.name;
      phrase.default = domainDoc.name;
    }

    const centerPoint = {
      lat: domainDoc.lat,
      lon: domainDoc.lon
    };

    const doc = {
      id: String(domainDoc.recordId),
      gid: `${domainDoc.source || 'unknown'}:${domainDoc.layer || 'venue'}:${domainDoc.recordId}`,
      source: domainDoc.source,
      source_config: domainDoc.sourceName,
      layer: domainDoc.layer,
      source_id: domainDoc.recordId,
      name,
      names: name,
      phrase,
      label: buildLabel(domainDoc, name.default || domainDoc.name),
      center_point: centerPoint,
      updated_at: new Date().toISOString()
    };

    // Routable point: use indexed data if available, else fallback to center
    if (domainDoc.routable_point && domainDoc.routable_point.lat != null) {
      doc.routable_point = domainDoc.routable_point;
      doc.routable_point_type = domainDoc.routable_point_type || 'indexed';
      doc.routable_point_status = domainDoc.routable_point_status || doc.routable_point_type;
      doc.routable_point_source = domainDoc.routable_point_source || 'index';
    } else {
      doc.routable_point = centerPoint;
      doc.routable_point_type = 'centroid_fallback';
      doc.routable_point_status = 'centroid_fallback';
      doc.routable_point_source = 'center_point';
    }
    if (Number.isFinite(domainDoc.routable_point_distance_meters)) {
      doc.routable_point_distance_meters = domainDoc.routable_point_distance_meters;
    }
    if (domainDoc.routable_point_reason) {
      doc.routable_point_reason = domainDoc.routable_point_reason;
    }

    // Entrances array (empty until entrance data is available)
    if (Array.isArray(domainDoc.entrances) && domainDoc.entrances.length > 0) {
      doc.entrances = domainDoc.entrances;
    }

    // Routable points array
    if (Array.isArray(domainDoc.routable_points) && domainDoc.routable_points.length > 0) {
      doc.routable_points = domainDoc.routable_points;
    }

    if (Object.keys(domainDoc.address).length > 0) {
      doc.address_parts = domainDoc.address;
    }

    if (Object.keys(domainDoc.parent).length > 0) {
      doc.parent = domainDoc.parent;
      addTopLevelAdminFields(doc, domainDoc.parent);
    }

    for (const field of ['country', 'country_a', 'region', 'region_a', 'county', 'locality', 'localadmin', 'neighbourhood']) {
      if (domainDoc[field] && !doc[field]) doc[field] = domainDoc[field];
    }

    if (domainDoc.admin_enrichment_status) {
      doc.admin_enrichment_status = domainDoc.admin_enrichment_status;
    }
    if (domainDoc.admin_enrichment_reason) {
      doc.admin_enrichment_reason = domainDoc.admin_enrichment_reason;
    }

    if (domainDoc.categories.length > 0) {
      doc.category = domainDoc.categories;
      doc.categories = domainDoc.categories;
    }

    if (Array.isArray(domainDoc.categoryIds) && domainDoc.categoryIds.length > 0) {
      doc.category_ids = domainDoc.categoryIds;
    } else if (domainDoc.categories.length > 0) {
      doc.category_ids = domainDoc.categories;
    }

    if (Array.isArray(domainDoc.categoryAliases) && domainDoc.categoryAliases.length > 0) {
      doc.category_aliases = domainDoc.categoryAliases;
    }

    if (Array.isArray(domainDoc.categoryTerms) && domainDoc.categoryTerms.length > 0) {
      doc.category_terms = unique(domainDoc.categoryTerms);
    } else if (Array.isArray(domainDoc.categoryAliases) && domainDoc.categoryAliases.length > 0) {
      doc.category_terms = unique(domainDoc.categoryAliases);
    }

    if (Array.isArray(domainDoc.intentGroups) && domainDoc.intentGroups.length > 0) {
      doc.intent_groups = unique(domainDoc.intentGroups);
    }

    if (domainDoc.sourceTags && Object.keys(domainDoc.sourceTags).length > 0) {
      doc.source_tags = domainDoc.sourceTags;
    }

    if (Number.isFinite(domainDoc.popularity)) {
      doc.popularity = domainDoc.popularity;
    }

    if (Number.isFinite(domainDoc.importance)) {
      doc.importance = domainDoc.importance;
    }

    if (Object.keys(domainDoc.addendum).length > 0) {
      doc.addendum = {
        postgis: JSON.stringify(domainDoc.addendum)
      };
    }

    return doc;
  }
}

function buildLabel(domainDoc, fallbackName) {
  const parts = [fallbackName];
  const parent = domainDoc.parent || {};
  for (const key of ['neighbourhood', 'locality', 'region', 'country']) {
    const values = Array.isArray(parent[key]) ? parent[key] : [];
    const value = values.find(Boolean);
    if (value && !parts.includes(value)) parts.push(value);
  }
  return parts.filter(Boolean).join(', ');
}

function addTopLevelAdminFields(doc, parent) {
  for (const field of ['country', 'country_a', 'region', 'region_a', 'county', 'locality', 'localadmin', 'neighbourhood']) {
    const value = Array.isArray(parent[field]) ? parent[field][0] : parent[field];
    if (value) doc[field] = value;
  }
}

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

module.exports = PeliasDocumentBuilder;
