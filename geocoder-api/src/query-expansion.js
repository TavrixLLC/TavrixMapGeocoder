'use strict';

const { loadCategoryResolver } = require('./category-resolver');

function analyzeQueryExpansion(text, options = {}) {
  const resolver = options.categoryResolver || loadCategoryResolver({
    taxonomyPath: options.categoryTaxonomyPath,
    generatedLabelsPath: options.categoryLabelsPath
  });
  const resolution = resolver.resolve({
    text,
    lang: options.lang,
    mode: options.mode || 'search'
  });

  return {
    normalized: resolution.normalized,
    tokens: resolution.tokens,
    expandedTerms: resolution.expanded_terms,
    categoryIds: resolution.matched_category_ids,
    categoryTerms: resolution.query_terms && resolution.query_terms.length > 0
      ? resolution.query_terms
      : resolution.category_terms,
    intentGroups: resolution.matched_intent_groups,
    sourceTags: resolution.source_tags,
    placeTerms: resolution.place_terms,
    unmatchedText: resolution.unmatched_text,
    categoryResolution: resolution
  };
}

module.exports = {
  analyzeQueryExpansion
};
