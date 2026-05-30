'use strict';

const fs = require('fs');
const path = require('path');

let _taxonomy = null;
let _aliasIndex = null;

/**
 * Loads the category taxonomy from a JSON file.
 * Caches on first load; requires restart to reload.
 */
function loadCategories(configPath) {
  if (_taxonomy) return _taxonomy;

  const candidates = [
    configPath,
    path.join(process.cwd(), 'config', 'categories.json'),
    path.join(__dirname, '..', '..', 'config', 'categories.json'),
    '/app/config/categories.json'
  ].filter(Boolean);

  for (const candidate of candidates) {
    try {
      const raw = fs.readFileSync(candidate, 'utf8');
      _taxonomy = JSON.parse(raw);
      _aliasIndex = buildAliasIndex(_taxonomy);
      return _taxonomy;
    } catch (_) {
      // Try next candidate
    }
  }

  // Fallback to empty taxonomy
  _taxonomy = [];
  _aliasIndex = {};
  return _taxonomy;
}

/**
 * Builds a reverse index: alias → canonical category id
 */
function buildAliasIndex(taxonomy) {
  const index = {};
  for (const cat of taxonomy) {
    index[cat.id] = cat.id;
    for (const alias of (cat.aliases || [])) {
      const key = alias.toLowerCase().replace(/\s+/g, '_');
      if (!index[key]) index[key] = cat.id;
    }
  }
  return index;
}

/**
 * Returns the category taxonomy, optionally filtered.
 */
function listCategories(options = {}) {
  const { lang, q, counts } = options;
  const taxonomy = _taxonomy || [];

  let results = taxonomy.map(cat => {
    const name = (lang && cat.names && cat.names[lang]) || cat.names.en || cat.id;

    const entry = {
      id: cat.id,
      name,
      names: cat.names || {},
      aliases: cat.aliases || [],
      parent: cat.parent || null,
      osm_tags: cat.osm_tags || {},
      available_count: counts && counts[cat.id] != null ? counts[cat.id] : 0
    };

    return entry;
  });

  // Filter by query if provided
  if (q) {
    const lowerQ = q.toLowerCase();
    results = results.filter(cat =>
      cat.id.includes(lowerQ)
      || cat.name.toLowerCase().includes(lowerQ)
      || Object.values(cat.names).some(name => String(name).toLowerCase().includes(lowerQ))
      || cat.aliases.some(a => a.toLowerCase().includes(lowerQ))
      || Object.entries(cat.osm_tags).some(([key, value]) =>
        `${key}:${value}`.toLowerCase().includes(lowerQ))
    );
  }

  return results;
}

/**
 * Gets a category by ID.
 */
function getCategoryById(id) {
  if (!_taxonomy) return null;
  return _taxonomy.find(cat => cat.id === id) || null;
}

/**
 * Resolves a list of category query values to canonical IDs.
 * Handles aliases: 'food' → 'restaurant', 'coffee' → 'cafe', etc.
 */
function resolveCategoryAliases(categories) {
  if (!categories || !_aliasIndex) return categories;
  const values = String(categories).split(',').map(c => c.trim().toLowerCase().replace(/\s+/g, '_')).filter(Boolean);
  const resolved = new Set();
  for (const value of values) {
    const canonical = _aliasIndex[value] || value;
    resolved.add(canonical);
  }
  return Array.from(resolved);
}

/**
 * Maps an OSM tag value to canonical category IDs.
 * Used during indexing to normalize category fields.
 */
function mapOsmTagToCategories(tagKey, tagValue) {
  if (!_taxonomy) return [];
  const result = [];
  for (const cat of _taxonomy) {
    if (cat.osm_tags && cat.osm_tags[tagKey] === tagValue) {
      result.push(cat.id);
    }
  }
  return result;
}

module.exports = {
  loadCategories,
  listCategories,
  getCategoryById,
  resolveCategoryAliases,
  mapOsmTagToCategories
};
