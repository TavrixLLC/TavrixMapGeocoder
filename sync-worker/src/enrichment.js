'use strict';

class Enrichment {
  constructor(config) {
    this.config = config;
  }

  enrich(domainDoc) {
    const country = this.config.worker.default_country;
    const countryA = this.config.worker.default_country_a;

    if (country && !domainDoc.parent.country) {
      domainDoc.parent.country = [country];
    }

    if (countryA && !domainDoc.parent.country_a) {
      domainDoc.parent.country_a = [countryA];
    }

    domainDoc.categories = normalizeCategories(domainDoc.categories);
    domainDoc.address = normalizeAddress(domainDoc.address);

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

module.exports = Enrichment;
