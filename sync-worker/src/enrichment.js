'use strict';

class Enrichment {
  constructor(config) {
    this.config = config;
  }

  enrich(domainDoc) {
    domainDoc.categories = normalizeCategories(domainDoc.categories);
    domainDoc.address = normalizeAddress(domainDoc.address);
    domainDoc.parent = normalizeParent(domainDoc.parent);

    return domainDoc;
  }
}

function normalizeCategories(categories) {
  const normalized = [];
  const seen = new Set();

  for (const category of categories) {
    const value = String(category || '').trim().toLowerCase().replace(/\s+/g, '_');
    if (value && !seen.has(value)) {
      normalized.push(value);
      seen.add(value);
    }
  }

  return normalized;
}

function normalizeAddress(address) {
  const out = {};
  for (const [key, value] of Object.entries(address)) {
    if (value == null) continue;
    const clean = String(value).trim();
    if (clean) {
      out[key] = clean;
    }
  }
  return out;
}

function normalizeParent(parent) {
  const out = {};
  for (const [key, value] of Object.entries(parent || {})) {
    const values = Array.isArray(value) ? value : [value];
    const clean = values.map(item => String(item || '').trim()).filter(Boolean);
    if (clean.length > 0) out[key] = [...new Set(clean)];
  }
  return out;
}

module.exports = Enrichment;
