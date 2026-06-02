'use strict';

const {
  loadCategoryResolver
} = require('./category-resolver');

let resolver = null;

function loadCategories(configPath, options = {}) {
  resolver = loadCategoryResolver({
    taxonomyPath: options.categoryTaxonomyPath || configPath,
    generatedLabelsPath: options.categoryLabelsPath
  });
  return resolver.categories;
}

function listCategories(options = {}) {
  return (resolver || loadCategoryResolver()).listCategories(options);
}

function getCategoryById(id) {
  return (resolver || loadCategoryResolver()).getCategoryById(id);
}

function resolveCategoryAliases(categories) {
  return (resolver || loadCategoryResolver()).resolveCategoryAliases(categories);
}

function mapOsmTagToCategories(tagKey, tagValue) {
  const activeResolver = resolver || loadCategoryResolver();
  const matches = activeResolver.osmTagIndex.get(`${tagKey}:${tagValue}`) || [];
  return matches.map(category => category.id);
}

module.exports = {
  loadCategories,
  listCategories,
  getCategoryById,
  resolveCategoryAliases,
  mapOsmTagToCategories
};
