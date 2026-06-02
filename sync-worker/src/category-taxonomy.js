'use strict';

const fs = require('fs');
const path = require('path');

class CategoryTaxonomy {
  constructor(config = {}) {
    this.taxonomy = loadTaxonomy(config);
    this.categories = this.taxonomy.categories || [];
    this.intentGroups = this.taxonomy.intent_groups || {};
    this.byOsmTag = buildOsmTagIndex(this.categories);
  }

  enrich(sourceTags = {}) {
    const categoryIds = new Set();
    const categoryAliases = new Set();
    const categoryTerms = new Set();
    const intentGroups = new Set();
    let importance = 0;

    for (const [key, rawValue] of Object.entries(sourceTags)) {
      const value = clean(rawValue);
      if (!value) continue;

      addSearchTerms(categoryAliases, [key, value, `${key}:${value}`]);
      addSearchTerms(categoryTerms, [key, value, `${key}:${value}`]);

      const matches = this.byOsmTag.get(`${key}:${value}`) || [];
      if (matches.length === 0) {
        categoryIds.add(value);
        continue;
      }

      for (const category of matches) {
        categoryIds.add(category.id);
        importance = Math.max(importance, Number(category.importance) || 0);
        for (const group of category.intent_groups || []) {
          intentGroups.add(group);
          addSearchTerms(categoryTerms, [group, ...intentGroupTerms(this.intentGroups[group])]);
        }
        const terms = categoryTermsFor(category);
        addSearchTerms(categoryAliases, terms);
        addSearchTerms(categoryTerms, terms);
      }
    }

    return {
      categoryIds: [...categoryIds],
      categoryAliases: [...categoryAliases],
      categoryTerms: [...categoryTerms],
      intentGroups: [...intentGroups],
      importance
    };
  }
}

function loadTaxonomy(config) {
  const candidates = [
    config.category_taxonomy_path,
    config.categories_config_path,
    config.worker && config.worker.category_taxonomy_path,
    config.worker && config.worker.categories_config_path,
    path.join(process.cwd(), 'config', 'category-taxonomy.json'),
    path.join(__dirname, '..', '..', 'config', 'category-taxonomy.json'),
    '/app/config/category-taxonomy.json',
    path.join(process.cwd(), 'config', 'categories.json'),
    path.join(__dirname, '..', '..', 'config', 'categories.json'),
    '/app/config/categories.json'
  ].filter(Boolean);

  for (const candidate of candidates) {
    try {
      return normalizeTaxonomy(JSON.parse(fs.readFileSync(candidate, 'utf8')));
    } catch (_) {
      // Try next candidate.
    }
  }
  return { categories: [], intent_groups: {} };
}

function normalizeTaxonomy(raw) {
  if (Array.isArray(raw)) {
    return {
      version: 0,
      intent_groups: {},
      categories: raw.map(category => ({
        ...category,
        intent_groups: category.parent ? [category.parent] : [],
        aliases: Array.isArray(category.aliases) ? { en: category.aliases } : (category.aliases || {}),
        osm_tags: tagsToArray(category.osm_tags)
      }))
    };
  }

  return {
    ...raw,
    intent_groups: raw.intent_groups || {},
    categories: (raw.categories || []).map(category => ({
      ...category,
      intent_groups: category.intent_groups || (category.parent ? [category.parent] : []),
      aliases: Array.isArray(category.aliases) ? { en: category.aliases } : (category.aliases || {}),
      osm_tags: tagsToArray(category.osm_tags)
    }))
  };
}

function buildOsmTagIndex(categories) {
  const index = new Map();
  for (const category of categories) {
    for (const tag of tagsToArray(category.osm_tags)) {
      if (!tag.key || tag.value == null) continue;
      const indexKey = `${tag.key}:${tag.value}`;
      if (!index.has(indexKey)) index.set(indexKey, []);
      index.get(indexKey).push(category);
    }
  }
  return index;
}

function tagsToArray(value) {
  if (Array.isArray(value)) return value;
  if (!value || typeof value !== 'object') return [];
  return Object.entries(value).map(([key, tagValue]) => ({ key, value: tagValue }));
}

function categoryTermsFor(category) {
  return [
    category.id,
    ...Object.values(category.names || {}),
    ...Object.values(category.aliases || {}).flatMap(values => Array.isArray(values) ? values : [values]),
    ...(category.intent_groups || [])
  ];
}

function intentGroupTerms(group) {
  if (!group) return [];
  return [
    ...Object.values(group.names || {}),
    ...Object.values(group.aliases || {}).flatMap(values => Array.isArray(values) ? values : [values])
  ];
}

function addSearchTerms(set, terms) {
  for (const term of terms) {
    const value = clean(term);
    if (!value) continue;
    set.add(value);
    set.add(normalizeArabicForSearch(value));
    set.add(value.toLowerCase());
  }
}

function clean(value) {
  if (value == null) return '';
  return String(value).trim();
}

function normalizeArabicForSearch(value) {
  return String(value)
    .normalize('NFKC')
    .replace(/[\u064B-\u065F\u0670]/g, '')
    .replace(/\u0640/g, '')
    .replace(/[\u0623\u0625\u0622\u0671]/g, '\u0627')
    .replace(/\u0649/g, '\u064a')
    .replace(/\u0624/g, '\u0648')
    .replace(/\u0626/g, '\u064a')
    .replace(/[\u06a9\u06aa]/g, '\u0643')
    .replace(/[\u06cc\u06ce]/g, '\u064a')
    .replace(/[\u0660-\u0669]/g, digit => String(digit.charCodeAt(0) - 0x0660))
    .replace(/[\u06F0-\u06F9]/g, digit => String(digit.charCodeAt(0) - 0x06F0))
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

module.exports = CategoryTaxonomy;
