'use strict';

const { normalizeText } = require('./normalizer');

/**
 * Deduplicates GeoJSON features based on:
 *   1. Normalized name similarity
 *   2. Coordinate proximity
 *   3. source_id / gid match
 *   4. Address hierarchy match
 *
 * Preference order when merging duplicates:
 *   higher confidence → better layer → richer metadata →
 *   has routable_point → has categories → better distance
 */

const DEFAULT_DISTANCE_THRESHOLD_METERS = 30;

function deduplicateFeatures(features, options = {}) {
  if (!Array.isArray(features) || features.length <= 1) {
    return { features: features || [], deduped_count: 0 };
  }

  const threshold = options.distance_threshold_meters || DEFAULT_DISTANCE_THRESHOLD_METERS;
  const kept = [];
  const removed = [];

  for (const feature of features) {
    const isDuplicate = kept.some(existing => areDuplicates(existing, feature, threshold));
    if (isDuplicate) {
      removed.push(feature);
    } else {
      kept.push(feature);
    }
  }

  return {
    features: kept,
    deduped_count: removed.length
  };
}

/**
 * Determines if two features are duplicates.
 */
function areDuplicates(a, b, threshold) {
  const pa = a.properties || {};
  const pb = b.properties || {};

  // Same GID → definite duplicate
  if (pa.gid && pb.gid && pa.gid === pb.gid) return true;

  // Same source + source_id → definite duplicate
  if (pa.source && pb.source && pa.source_id && pb.source_id) {
    if (pa.source === pb.source && pa.source_id === pb.source_id) return true;
  }

  // Name similarity + proximity check
  const nameSimilar = areNamesSimilar(pa.name, pb.name);
  if (!nameSimilar) return false;

  // Check coordinate proximity
  const dist = haversineMeters(
    getCoordinate(a, 'lat'), getCoordinate(a, 'lon'),
    getCoordinate(b, 'lat'), getCoordinate(b, 'lon')
  );

  if (dist === null) return false;
  if (dist > threshold) return false;

  // Close + similar name → likely duplicate
  // Extra check: same layer makes it more certain
  if (pa.layer === pb.layer) return true;

  // Different layers but very close with same name → still duplicate
  return dist < threshold / 2;
}

/**
 * Checks if two names are similar after normalization.
 */
function areNamesSimilar(nameA, nameB) {
  if (!nameA || !nameB) return false;

  const a = normalizeForDedup(nameA);
  const b = normalizeForDedup(nameB);

  if (a === b) return true;

  // One contains the other (for cases like "Baghdad" vs "Baghdad City")
  if (a.length > 3 && b.length > 3) {
    if (a.includes(b) || b.includes(a)) return true;
  }

  return false;
}

function normalizeForDedup(name) {
  const result = normalizeText(name);
  return result.normalized;
}

/**
 * Extracts lat/lon from a GeoJSON feature.
 */
function getCoordinate(feature, axis) {
  if (feature.geometry && feature.geometry.coordinates) {
    return axis === 'lon' ? feature.geometry.coordinates[0] : feature.geometry.coordinates[1];
  }
  return null;
}

/**
 * Computes approximate distance in meters between two lat/lon points.
 */
function haversineMeters(lat1, lon1, lat2, lon2) {
  if ([lat1, lon1, lat2, lon2].some(v => v == null || !Number.isFinite(v))) return null;

  const R = 6371000; // Earth radius in meters
  const toRad = deg => deg * Math.PI / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

/**
 * Picks the better feature from a pair of duplicates.
 */
function pickBetter(a, b) {
  const pa = a.properties || {};
  const pb = b.properties || {};

  // Higher confidence wins
  if ((pa.confidence || 0) !== (pb.confidence || 0)) {
    return (pa.confidence || 0) > (pb.confidence || 0) ? a : b;
  }

  // Has routable_point wins
  if (pa.routable_point && !pb.routable_point) return a;
  if (pb.routable_point && !pa.routable_point) return b;

  // Has categories wins
  if (pa.categories && !pb.categories) return a;
  if (pb.categories && !pa.categories) return b;

  // More properties wins (richer metadata)
  if (Object.keys(pa).length !== Object.keys(pb).length) {
    return Object.keys(pa).length > Object.keys(pb).length ? a : b;
  }

  // Better distance wins
  if (pa.distance_meters != null && pb.distance_meters != null) {
    return pa.distance_meters <= pb.distance_meters ? a : b;
  }

  return a; // Default to first
}

module.exports = {
  deduplicateFeatures,
  areDuplicates,
  areNamesSimilar,
  haversineMeters,
  pickBetter
};
