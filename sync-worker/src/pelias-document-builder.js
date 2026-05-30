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
      source: domainDoc.source,
      layer: domainDoc.layer,
      source_id: domainDoc.recordId,
      name,
      phrase,
      center_point: centerPoint,
      updated_at: new Date().toISOString()
    };

    // Routable point: use indexed data if available, else fallback to center
    if (domainDoc.routable_point && domainDoc.routable_point.lat != null) {
      doc.routable_point = domainDoc.routable_point;
      doc.routable_point_type = domainDoc.routable_point_type || 'indexed';
      doc.routable_point_source = domainDoc.routable_point_source || 'index';
    } else {
      doc.routable_point = centerPoint;
      doc.routable_point_type = 'centroid_fallback';
      doc.routable_point_source = 'center_point';
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
    }

    if (domainDoc.categories.length > 0) {
      doc.category = domainDoc.categories;
    }

    if (Number.isFinite(domainDoc.popularity)) {
      doc.popularity = domainDoc.popularity;
    }

    if (Object.keys(domainDoc.addendum).length > 0) {
      doc.addendum = {
        postgis: JSON.stringify(domainDoc.addendum)
      };
    }

    return doc;
  }
}

module.exports = PeliasDocumentBuilder;
