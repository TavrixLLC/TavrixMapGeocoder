'use strict';

const fs = require('fs');
const path = require('path');
const { normalizeText } = require('./normalizer');

const DEFAULT_LANGS = ['en', 'ar', 'ku', 'ckb'];
const MAX_EXPANDED_TERMS = 32;
const MAX_CACHE_ENTRIES = 10000;

let cachedResolver = null;
let cachedResolverKey = null;

class CategoryResolver {
  constructor({ taxonomy, wikidataLabels = {}, source = 'memory' } = {}) {
    const normalized = normalizeTaxonomy(taxonomy || {});
    this.source = source;
    this.version = normalized.version || 1;
    this.languages = normalized.languages || DEFAULT_LANGS;
    this.intentGroups = normalized.intent_groups || {};
    this.categories = normalized.categories || [];
    this.placeVariants = normalized.place_variants || [];
    this.wikidataLabels = wikidataLabels || {};
    this.cache = new Map();

    this.categoriesById = new Map(this.categories.map(category => [category.id, category]));
    this.intentGroupsById = new Map(Object.entries(this.intentGroups));
    this.termRecords = [];
    this.termIndex = new Map();
    this.prefixIndex = new Map();
    this.placeRecords = [];
    this.osmTagIndex = new Map();

    this.buildIndexes();
  }

  buildIndexes() {
    for (const [groupId, group] of this.intentGroupsById.entries()) {
      for (const term of collectLocalizedTerms({ id: groupId, ...group })) {
        this.addTerm(term.value, {
          type: 'intent_group',
          intent_group: groupId,
          lang: term.lang,
          source: term.source,
          boost: Number(group.boost) || 1
        });
      }
    }

    for (const category of this.categories) {
      const wikidataTerms = this.wikidataTerms(category.id);
      const categoryTerms = [
        ...collectLocalizedTerms(category),
        ...wikidataTerms
      ];

      for (const tag of category.osm_tags || []) {
        if (!tag || !tag.key || tag.value == null) continue;
        this.addOsmTag(tag.key, tag.value, category);
        categoryTerms.push(
          { value: String(tag.value), source: 'osm_tag', lang: null },
          { value: `${tag.key}:${tag.value}`, source: 'osm_tag', lang: null }
        );
      }

      for (const term of categoryTerms) {
        this.addTerm(term.value, {
          type: 'category',
          category_id: category.id,
          intent_groups: category.intent_groups || [],
          lang: term.lang,
          source: term.source,
          boost: Number(category.boost) || 1,
          importance: Number(category.importance) || 0
        });
      }
    }

    for (const variant of this.placeVariants) {
      const normalizedTerms = unique((variant.terms || [])
        .map(term => normalizeForSearch(term))
        .filter(Boolean));
      if (normalizedTerms.length === 0) continue;
      this.placeRecords.push({
        id: variant.id,
        terms: normalizedTerms
      });
    }
  }

  addTerm(value, record) {
    const normalized = normalizeForSearch(value);
    if (!isSafeTerm(normalized)) return;

    const finalRecord = {
      ...record,
      term: String(value),
      normalized
    };
    this.termRecords.push(finalRecord);
    addToMapList(this.termIndex, normalized, finalRecord);

    for (let length = 3; length <= Math.min(normalized.length, 20); length++) {
      addToMapList(this.prefixIndex, normalized.slice(0, length), finalRecord);
    }
  }

  addOsmTag(key, value, category) {
    const mapKey = `${String(key).trim()}:${String(value).trim()}`;
    addToMapList(this.osmTagIndex, mapKey, category);
  }

  resolve(input, options = {}) {
    const text = typeof input === 'string' ? input : (input && input.text);
    const lang = options.lang || (typeof input === 'object' && input && input.lang);
    const mode = options.mode || (typeof input === 'object' && input && input.mode) || 'search';
    const normalized = normalizeText(text || '', lang);
    const cacheKey = stableKey({ text: normalized.normalized, lang, mode });
    const cached = this.cache.get(cacheKey);
    if (cached) return clone(cached);

    const tokens = normalized.tokens || [];
    const matchedRecords = new Map();

    addRecords(matchedRecords, this.termIndex.get(normalized.normalized));
    for (const token of tokens) {
      addRecords(matchedRecords, this.termIndex.get(token));
      if (token.length >= 3) addRecords(matchedRecords, this.prefixIndex.get(token));
    }

    for (const record of this.termRecords) {
      if (record.normalized.includes(' ') && containsTerm(normalized.normalized, tokens, record.normalized)) {
        matchedRecords.set(recordKey(record), record);
      }
    }

    const placeTerms = this.resolvePlaceTerms(normalized.normalized, tokens);
    const categoryIds = [];
    const intentGroups = [];
    const sourceTags = [];
    const matchedTerms = [];
    const categoryTerms = [];
    const queryTerms = new Set();
    const expandedTerms = new Set([normalized.normalized].filter(Boolean));

    for (const record of matchedRecords.values()) {
      matchedTerms.push({
        term: record.term,
        normalized: record.normalized,
        type: record.type,
        category_id: record.category_id || null,
        intent_group: record.intent_group || null,
        lang: record.lang || null,
        source: record.source || null,
        boost: record.boost || 1
      });

      if (record.type === 'category') {
        pushUnique(categoryIds, record.category_id);
        queryTerms.add(record.normalized);
        queryTerms.add(record.category_id);
        for (const group of record.intent_groups || []) pushUnique(intentGroups, group);
      } else if (record.type === 'intent_group') {
        pushUnique(intentGroups, record.intent_group);
        queryTerms.add(record.normalized);
        queryTerms.add(record.intent_group);
      }
    }

    for (const categoryId of categoryIds) {
      const category = this.categoriesById.get(categoryId);
      if (!category) continue;
      for (const group of category.intent_groups || []) pushUnique(intentGroups, group);
      for (const tag of category.osm_tags || []) {
        if (tag && tag.key && tag.value != null) {
          sourceTags.push({ field: tag.key, value: String(tag.value) });
        }
      }
      for (const term of this.categorySearchTerms(category, { includeGenerated: true })) {
        const key = normalizeForSearch(term);
        if (!key) continue;
        categoryTerms.push(key);
        expandedTerms.add(key);
      }
    }

    for (const groupId of intentGroups) {
      const group = this.intentGroupsById.get(groupId);
      if (!group) continue;
      for (const term of collectLocalizedTerms({ id: groupId, ...group })) {
        const key = normalizeForSearch(term.value);
        if (key) expandedTerms.add(key);
      }
    }

    for (const term of placeTerms) expandedTerms.add(term);

    const matchedTokenParts = new Set([
      ...matchedTerms.flatMap(match => match.normalized.split(/\s+/)),
      ...placeTerms.flatMap(term => term.split(/\s+/))
    ]);
    const unmatchedText = tokens
      .filter(token => !matchedTokenParts.has(token))
      .join(' ')
      .trim();
    if (unmatchedText) expandedTerms.add(unmatchedText);

    const result = {
      normalized: normalized.normalized,
      tokens,
      matched_category_ids: categoryIds,
      matched_intent_groups: intentGroups,
      expanded_terms: limit(unique([...expandedTerms].filter(Boolean)), MAX_EXPANDED_TERMS),
      category_terms: limit(unique(categoryTerms), MAX_EXPANDED_TERMS),
      query_terms: limit(unique([...queryTerms]), MAX_EXPANDED_TERMS),
      source_tags: uniqueSourceTags(sourceTags),
      place_terms: placeTerms,
      unmatched_text: unmatchedText,
      matched_terms: matchedTerms,
      confidence: confidenceFor({ categoryIds, intentGroups, matchedTerms, mode }),
      resolver_source: this.source
    };

    this.setCache(cacheKey, result);
    return clone(result);
  }

  resolveCategoryAliases(values) {
    const list = Array.isArray(values) ? values : String(values || '').split(',');
    const resolved = new Set();
    for (const raw of list) {
      const value = String(raw).trim();
      if (!value) continue;
      const direct = this.categoriesById.get(value);
      if (direct) {
        resolved.add(direct.id);
        continue;
      }
      const match = this.resolve(value).matched_category_ids[0];
      resolved.add(match || value);
    }
    return [...resolved];
  }

  categorySearchTerms(category, { includeGenerated = false } = {}) {
    const terms = collectLocalizedTerms(category).map(term => term.value);
    if (includeGenerated) {
      for (const term of this.wikidataTerms(category.id)) terms.push(term.value);
    }
    for (const groupId of category.intent_groups || []) terms.push(groupId);
    return unique(terms.map(String).filter(Boolean));
  }

  wikidataTerms(categoryId) {
    const entry = (((this.wikidataLabels || {}).categories || {})[categoryId]) || {};
    const terms = [];
    for (const [lang, value] of Object.entries(entry.labels || {})) {
      terms.push({ value, lang, source: 'wikidata_label' });
    }
    for (const [lang, values] of Object.entries(entry.safe_aliases || entry.aliases || {})) {
      for (const value of arrayify(values)) {
        terms.push({ value, lang, source: 'wikidata_alias' });
      }
    }
    return terms;
  }

  resolvePlaceTerms(normalized, tokens) {
    const terms = new Set();
    for (const variant of this.placeRecords) {
      const matched = variant.terms.some(term => containsTerm(normalized, tokens, term));
      if (!matched) continue;
      for (const term of variant.terms) terms.add(term);
    }
    return [...terms];
  }

  listCategories({ lang, q, counts } = {}) {
    const query = normalizeForSearch(q || '');
    return this.categories
      .map(category => {
        const name = localizedName(category.names, lang) || category.id;
        return {
          id: category.id,
          name,
          names: category.names || {},
          aliases: flattenAliases(category.aliases || {}),
          intent_groups: category.intent_groups || [],
          parent: (category.intent_groups || [])[0] || null,
          osm_tags: tagsObject(category.osm_tags || []),
          osm_tag_filters: category.osm_tags || [],
          wikidata: category.wikidata || [],
          importance: Number(category.importance) || 0,
          available_count: counts && counts[category.id] != null ? counts[category.id] : 0
        };
      })
      .filter(category => {
        if (!query) return true;
        const haystack = [
          category.id,
          category.name,
          ...Object.values(category.names || {}),
          ...category.aliases,
          ...(category.intent_groups || []),
          ...(category.osm_tag_filters || []).flatMap(tag => [tag.key, tag.value, `${tag.key}:${tag.value}`])
        ].map(normalizeForSearch).join(' ');
        return haystack.includes(query);
      });
  }

  getCategoryById(id) {
    return this.categoriesById.get(id) || null;
  }

  setCache(key, value) {
    this.cache.set(key, clone(value));
    while (this.cache.size > MAX_CACHE_ENTRIES) {
      this.cache.delete(this.cache.keys().next().value);
    }
  }
}

function loadCategoryResolver(options = {}) {
  const requestedKey = stableKey({
    taxonomyPath: options.taxonomyPath || options.categoryTaxonomyPath || '',
    generatedLabelsPath: options.generatedLabelsPath || options.categoryLabelsPath || ''
  });
  if (cachedResolver && !options.forceReload && cachedResolverKey === requestedKey) return cachedResolver;
  const taxonomyInfo = readFirstJson(taxonomyCandidates(options.taxonomyPath || options.categoryTaxonomyPath));
  const labelsInfo = readFirstJson(labelCandidates(options.generatedLabelsPath || options.categoryLabelsPath));
  cachedResolver = new CategoryResolver({
    taxonomy: taxonomyInfo.value || {},
    wikidataLabels: labelsInfo.value || {},
    source: taxonomyInfo.path || 'empty'
  });
  cachedResolverKey = requestedKey;
  return cachedResolver;
}

function setCategoryResolver(resolver) {
  cachedResolver = resolver;
  cachedResolverKey = 'injected';
  return cachedResolver;
}

function resetCategoryResolverForTests() {
  cachedResolver = null;
  cachedResolverKey = null;
}

function taxonomyCandidates(configPath) {
  return [
    configPath,
    path.join(process.cwd(), 'config', 'category-taxonomy.json'),
    path.join(__dirname, '..', '..', 'config', 'category-taxonomy.json'),
    '/app/config/category-taxonomy.json',
    path.join(process.cwd(), 'config', 'categories.json'),
    path.join(__dirname, '..', '..', 'config', 'categories.json'),
    '/app/config/categories.json'
  ].filter(Boolean);
}

function labelCandidates(configPath) {
  return [
    configPath,
    path.join(process.cwd(), 'generated', 'category-labels.wikidata.json'),
    path.join(__dirname, '..', '..', 'generated', 'category-labels.wikidata.json'),
    '/app/generated/category-labels.wikidata.json'
  ].filter(Boolean);
}

function readFirstJson(candidates) {
  for (const candidate of candidates) {
    try {
      return {
        path: candidate,
        value: JSON.parse(fs.readFileSync(candidate, 'utf8'))
      };
    } catch (_) {
      // Try next candidate.
    }
  }
  return { path: null, value: null };
}

function normalizeTaxonomy(raw) {
  if (Array.isArray(raw)) {
    return {
      version: 0,
      languages: DEFAULT_LANGS,
      intent_groups: {},
      categories: raw.map(category => ({
        ...category,
        aliases: Array.isArray(category.aliases) ? { en: category.aliases } : (category.aliases || {}),
        intent_groups: category.parent ? [category.parent] : [],
        osm_tags: objectTagsToArray(category.osm_tags)
      })),
      place_variants: []
    };
  }

  return {
    version: raw.version || 1,
    languages: raw.languages || DEFAULT_LANGS,
    intent_groups: raw.intent_groups || {},
    categories: (raw.categories || []).map(category => ({
      ...category,
      aliases: normalizeAliases(category.aliases),
      intent_groups: category.intent_groups || (category.parent ? [category.parent] : []),
      osm_tags: objectTagsToArray(category.osm_tags)
    })),
    place_variants: raw.place_variants || []
  };
}

function objectTagsToArray(value) {
  if (Array.isArray(value)) return value;
  if (!value || typeof value !== 'object') return [];
  return Object.entries(value).map(([key, tagValue]) => ({ key, value: tagValue }));
}

function normalizeAliases(value) {
  if (Array.isArray(value)) return { en: value };
  if (!value || typeof value !== 'object') return {};
  return value;
}

function collectLocalizedTerms(item) {
  const terms = [{ value: item.id, lang: null, source: 'id' }];
  for (const [lang, value] of Object.entries(item.names || {})) {
    terms.push({ value, lang, source: 'name' });
  }
  const aliases = normalizeAliases(item.aliases || {});
  for (const [lang, values] of Object.entries(aliases)) {
    for (const value of arrayify(values)) {
      terms.push({ value, lang, source: 'manual_alias' });
    }
  }
  return terms.filter(term => term.value != null && String(term.value).trim());
}

function normalizeForSearch(value) {
  return normalizeText(String(value || '')).normalized;
}

function isSafeTerm(term) {
  if (!term || term.length < 2) return false;
  if (/^q\d+$/i.test(term)) return false;
  return !new Set(['place', 'point', 'service', 'building', 'office']).has(term);
}

function containsTerm(text, tokens, term) {
  if (!text || !term) return false;
  if (text === term) return true;
  if (term.includes(' ')) return text.includes(term);
  return tokens.includes(term);
}

function addRecords(target, records) {
  for (const record of records || []) {
    target.set(recordKey(record), record);
  }
}

function recordKey(record) {
  return `${record.type}:${record.category_id || record.intent_group || ''}:${record.normalized}`;
}

function addToMapList(map, key, value) {
  if (!key) return;
  if (!map.has(key)) map.set(key, []);
  map.get(key).push(value);
}

function pushUnique(array, value) {
  if (value && !array.includes(value)) array.push(value);
}

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

function limit(values, max) {
  return values.slice(0, max);
}

function uniqueSourceTags(tags) {
  const seen = new Set();
  const out = [];
  for (const tag of tags) {
    const key = `${tag.field}:${tag.value}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(tag);
  }
  return out;
}

function confidenceFor({ categoryIds, intentGroups, matchedTerms, mode }) {
  if (categoryIds.length > 0) return mode === 'autocomplete' ? 0.9 : 1;
  if (intentGroups.length > 0) return 0.65;
  if (matchedTerms.length > 0) return 0.5;
  return 0;
}

function arrayify(value) {
  if (Array.isArray(value)) return value;
  if (value == null) return [];
  return [value];
}

function flattenAliases(aliases) {
  return unique(Object.values(normalizeAliases(aliases)).flatMap(arrayify));
}

function tagsObject(tags) {
  const out = {};
  for (const tag of tags || []) {
    if (tag && tag.key && tag.value != null && out[tag.key] == null) {
      out[tag.key] = tag.value;
    }
  }
  return out;
}

function localizedName(names, lang) {
  if (!names) return null;
  const normalizedLang = String(lang || '').split('-')[0].toLowerCase();
  return names[normalizedLang] || names.en || names.ar || Object.values(names).find(Boolean) || null;
}

function stableKey(value) {
  return JSON.stringify(value);
}

function clone(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

module.exports = {
  CategoryResolver,
  loadCategoryResolver,
  setCategoryResolver,
  resetCategoryResolverForTests,
  normalizeTaxonomy,
  normalizeForSearch
};
