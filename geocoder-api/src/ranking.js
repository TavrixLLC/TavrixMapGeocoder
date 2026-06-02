'use strict';

const fs = require('fs');
const path = require('path');
const { analyzeQueryExpansion } = require('./query-expansion');

let _rankingConfig = null;

/**
 * Loads ranking config from JSON file. Cached at startup.
 */
function loadRankingConfig(configPath) {
  if (_rankingConfig) return _rankingConfig;

  const candidates = [
    configPath,
    path.join(process.cwd(), 'config', 'ranking.json'),
    path.join(__dirname, '..', '..', 'config', 'ranking.json'),
    '/app/config/ranking.json'
  ].filter(Boolean);

  for (const candidate of candidates) {
    try {
      const raw = fs.readFileSync(candidate, 'utf8');
      _rankingConfig = JSON.parse(raw);
      return _rankingConfig;
    } catch (_) {
      // Try next candidate
    }
  }

  // Sensible defaults
  _rankingConfig = {
    layers: { venue: 1.0, address: 1.0, street: 0.8, locality: 0.6, region: 0.4, country: 0.2 },
    distance: {
      enabled: true,
      decay_km: 3,
      offset_km: 0.2,
      weight: 15,
      proximity_boosts: [
        { distance: '5km', weight: 40 },
        { distance: '25km', weight: 15 },
        { distance: '100km', weight: 5 }
      ]
    },
    dedupe: { enabled: true, distance_threshold_meters: 30 },
    exact_match_boost: 2.0,
    prefix_match_boost: 1.5,
    category_match_boost: 1.3,
    popularity_weight: 0.1
  };
  return _rankingConfig;
}

function getRankingFormula() {
  const rc = _rankingConfig || loadRankingConfig();
  return {
    formula: 'final_score = text_relevance + proximity_score + popularity_importance + category_boost + exact_name_boost + layer_boost',
    components: {
      text_relevance: 'Elasticsearch multi_match score over name, label, phrase, admin, category_terms, intent_groups, category_ids, and OSM source tag fields.',
      proximity_score: `Gauss decay on center_point when a focus point is supplied; scale=${((rc.distance || {}).decay_km || 5)}km.`,
      popularity_importance: `log1p(popularity) and log1p(importance) with popularity factor ${(rc.popularity_weight == null ? 0.1 : rc.popularity_weight)}.`,
      category_boost: `Additional weight ${(rc.category_match_boost || 1.3)} when requested categories, taxonomy category_terms, intent_groups, or OSM tags match.`,
      exact_name_boost: `Exact and phrase name matches use boost ${(rc.exact_match_boost || 2.0)}.`,
      layer_boost: 'Layer weights are applied as filter functions from config/ranking.json.',
      semantic_expansion: 'In-memory category taxonomy resolves multilingual aliases and Iraqi/Kurdish/Latin spelling variants before query construction.'
    },
    boost_mode: 'sum; multiply when focus.point is supplied',
    score_mode: 'sum'
  };
}

/**
 * Builds a full-text search ES query with ranking.
 */
function buildSearchQuery(text, options = {}) {
  const rc = _rankingConfig || loadRankingConfig();
  const size = options.size || 10;
  const filters = [];
  const should = [];
  const expansion = analyzeQueryExpansion(text, { ...options, mode: 'search' });

  // Layer filter
  addListFilter(filters, 'layer', options.layers);
  // Source filter
  addListFilter(filters, 'source', options.sources);
  // Category filter
  if (options.categories) {
    addListFilter(filters, 'category', options.categories);
  }
  // Boundary filters
  addBoundaryFilters(filters, options);

  const must = buildSemanticMustClauses(text, expansion);

  // Exact match boost
  should.push({
    term: {
      'name.default': {
        value: text,
        boost: rc.exact_match_boost || 2.0
      }
    }
  });

  // Category match boost when searching with category-related text
  if (options.categories) {
    const catValues = Array.isArray(options.categories) ? options.categories : [options.categories];
    for (const cat of catValues) {
      should.push({
        term: { category: { value: cat, boost: rc.category_match_boost || 1.3 } }
      });
    }
  }

  for (const category of expansion.categoryIds) {
    should.push({ term: { category_ids: { value: category, boost: (rc.category_match_boost || 1.3) + 2 } } });
  }

  for (const group of expansion.intentGroups || []) {
    should.push({ term: { intent_groups: { value: group, boost: rc.category_match_boost || 1.3 } } });
  }

  const query = {
    bool: {
      must,
      should,
      filter: filters.length > 0 ? filters : undefined
    }
  };

  return {
    size,
    query: applyRankingFormula(query, { ...options, categoryExpansion: expansion })
  };
}

/**
 * Builds an autocomplete/prefix ES query.
 * Optimized for speed: fewer fields, match_phrase_prefix, lower size.
 */
function buildAutocompleteQuery(text, options = {}) {
  const size = options.size || 5;
  const filters = [];
  const expansion = analyzeQueryExpansion(text, { ...options, mode: 'autocomplete' });

  addListFilter(filters, 'layer', options.layers);
  addListFilter(filters, 'source', options.sources);
  if (options.categories) {
    addListFilter(filters, 'category', options.categories);
  }
  addBoundaryFilters(filters, options);

  const must = buildAutocompleteMustClauses(text, expansion);

  const query = {
    bool: {
      must,
      filter: filters.length > 0 ? filters : undefined
    }
  };

  return {
    size,
    query: applyRankingFormula(query, { ...options, categoryExpansion: expansion })
  };
}

/**
 * Builds a structured/field-aware search ES query.
 * Uses field-specific matching when structured fields are provided,
 * with fallback to text query for sparse inputs.
 */
function buildStructuredQuery(fields, options = {}) {
  const size = options.size || 10;
  const filters = [];
  const must = [];
  const should = [];

  addListFilter(filters, 'layer', options.layers);
  addListFilter(filters, 'source', options.sources);
  addBoundaryFilters(filters, options);

  // Field-specific queries
  const fieldMappings = {
    housenumber: 'address_parts.number',
    street: 'address_parts.street',
    postalcode: 'address_parts.zip',
    locality: 'parent.locality',
    region: 'parent.region',
    country: 'parent.country',
    country_a: 'parent.country_a',
    region_a: 'parent.region_a',
    county: 'parent.county',
    neighbourhood: 'parent.neighbourhood'
  };

  let hasFieldQuery = false;

  for (const [field, esField] of Object.entries(fieldMappings)) {
    const value = fields[field];
    if (!value || !String(value).trim()) continue;
    hasFieldQuery = true;

    should.push({
      match: { [esField]: { query: String(value).trim(), boost: 2 } }
    });
  }

  // Address field (free text for address)
  if (fields.address && String(fields.address).trim()) {
    hasFieldQuery = true;
    must.push({
      multi_match: {
        query: String(fields.address).trim(),
        fields: ['name.default^3', 'address_parts.street^2', 'address_parts.number'],
        type: 'cross_fields'
      }
    });
  }

  // Street + name matching
  if (fields.street && String(fields.street).trim()) {
    must.push({
      multi_match: {
        query: String(fields.street).trim(),
        fields: ['name.default^2', 'address_parts.street^3'],
        type: 'best_fields'
      }
    });
  }

  // If no field-specific queries were built, fall back to text concat
  if (!hasFieldQuery) {
    const textParts = Object.values(fields).filter(v => v && String(v).trim());
    if (textParts.length > 0) {
      must.push({
        multi_match: {
          query: textParts.join(' '),
          fields: ['name.default^4', 'phrase.default^3', 'name.ar^3', 'name.en^3'],
          type: 'best_fields'
        }
      });
    }
  }

  // Determine match_type and confidence
  let matchType = 'partial_match';
  if (fields.housenumber && fields.street) {
    matchType = fields.locality ? 'exact_address' : 'street_only';
  } else if (fields.street) {
    matchType = 'street_only';
  } else if (fields.locality) {
    matchType = 'locality_match';
  }

  const body = {
    size,
    query: {
      bool: {
        must: must.length > 0 ? must : [{ match_all: {} }],
        should,
        filter: filters.length > 0 ? filters : undefined,
        minimum_should_match: should.length > 0 ? 1 : 0
      }
    },
    _matchType: matchType
  };

  // Focus point
  if (options.focusLat != null && options.focusLon != null) {
    const innerQuery = body.query;
    body.query = {
      function_score: {
        query: innerQuery,
        functions: [{
          gauss: {
            center_point: {
              origin: { lat: options.focusLat, lon: options.focusLon },
              scale: '5km',
              offset: '0.5km',
              decay: 0.5
            }
          },
          weight: 1.0
        }],
        score_mode: 'sum',
        boost_mode: 'multiply'
      }
    };
  }

  return body;
}

/**
 * Builds a reverse geocoding ES query.
 * Prefers address/venue/street over large admin polygons.
 */
function buildReverseQuery(lat, lon, options = {}) {
  const size = options.size || 1;
  const radius = options.radius || 500;
  const filters = [
    { geo_distance: { distance: `${radius}m`, center_point: { lat, lon } } }
  ];

  addListFilter(filters, 'layer', options.layers || 'venue,address,street');
  addListFilter(filters, 'source', options.sources);
  addBoundaryFilters(filters, options);

  return {
    size,
    query: { bool: { filter: filters } },
    sort: [
      {
        _geo_distance: {
          center_point: { lat, lon },
          order: 'asc',
          unit: 'm',
          mode: 'min',
          distance_type: 'arc'
        }
      },
      { _score: 'desc' }
    ]
  };
}

/**
 * Builds a nearby search ES query with configurable sort modes.
 * - distance: pure geo distance
 * - relevance: category/text relevance
 * - hybrid: combined category match + distance
 */
function buildNearbyQuery(query, config = {}) {
  const size = Number(query.size) || config.defaultSize || 10;
  const lat = Number(query['point.lat']);
  const lon = Number(query['point.lon']);
  const radius = query.radius
    ? `${Number(query.radius)}m`
    : `${config.defaultNearbyRadiusMeters || 1000}m`;
  const sortMode = query.sort || 'distance';
  const categoryMode = query.category_mode || 'any';

  const filters = [
    { geo_distance: { distance: radius, center_point: { lat, lon } } }
  ];

  addListFilter(filters, 'layer', query.layers || 'venue');

  // Category filter with any/all modes
  if (query.categories) {
    const catValues = String(query.categories).split(',').map(c => c.trim()).filter(Boolean);
    if (catValues.length > 0) {
      if (categoryMode === 'all') {
        for (const cat of catValues) {
          filters.push({ term: { category: cat } });
        }
      } else {
        filters.push({ terms: { category: catValues } });
      }
    }
  }

  addBoundaryFilters(filters, query);

  const body = {
    size,
    query: { bool: { filter: filters } }
  };

  // Sort strategy
  if (sortMode === 'relevance') {
    body.sort = [{ _score: 'desc' }];
    // Add text relevance if categories provided
    if (query.categories) {
      body.query = {
        bool: {
          must: [{ terms: { category: String(query.categories).split(',').map(c => c.trim()) } }],
          filter: filters
        }
      };
    }
  } else if (sortMode === 'hybrid') {
    body.query = {
      function_score: {
        query: { bool: { filter: filters } },
        functions: [{
          gauss: {
            center_point: {
              origin: { lat, lon },
              scale: '1km',
              offset: '0.1km',
              decay: 0.5
            }
          },
          weight: 2.0
        }],
        score_mode: 'sum',
        boost_mode: 'multiply'
      }
    };
    body.sort = [{ _score: 'desc' }];
  } else {
    // distance (default)
    body.sort = [
      {
        _geo_distance: {
          center_point: { lat, lon },
          order: 'asc',
          unit: 'm',
          mode: 'min',
          distance_type: 'arc'
        }
      },
      { _score: 'desc' }
    ];
  }

  return body;
}

// ── Shared filter helpers ─────────────────────────────────────────

function addBoundaryFilters(filters, query) {
  // Rect boundary
  const minLon = parseFloat(query['boundary.rect.min_lon']);
  const maxLon = parseFloat(query['boundary.rect.max_lon']);
  const minLat = parseFloat(query['boundary.rect.min_lat']);
  const maxLat = parseFloat(query['boundary.rect.max_lat']);
  if ([minLon, maxLon, minLat, maxLat].every(Number.isFinite)) {
    filters.push({
      geo_bounding_box: {
        center_point: {
          top_left: { lat: maxLat, lon: minLon },
          bottom_right: { lat: minLat, lon: maxLon }
        }
      }
    });
  }

  // Circle boundary
  const circleLat = parseFloat(query['boundary.circle.lat']);
  const circleLon = parseFloat(query['boundary.circle.lon']);
  const circleRadius = parseFloat(query['boundary.circle.radius']);
  if ([circleLat, circleLon, circleRadius].every(Number.isFinite)) {
    filters.push({
      geo_distance: {
        distance: `${circleRadius}m`,
        center_point: { lat: circleLat, lon: circleLon }
      }
    });
  }

  // Country boundary
  if (query['boundary.country']) {
    const code = normalizeCountryCode(query['boundary.country']);
    filters.push({
      bool: {
        should: [
          { term: { country_a: code } },
          { match: { 'parent.country_a': code } }
        ],
        minimum_should_match: 1
      }
    });
  }
}

function normalizeCountryCode(value) {
  return String(value || '').trim().toUpperCase();
}

function buildSemanticMustClauses(text, expansion) {
  const must = [];

  if (expansion.categoryIds.length > 0 || (expansion.intentGroups || []).length > 0) {
    must.push(buildCategoryIntentClause(expansion));
  }

  if (expansion.placeTerms.length > 0) {
    must.push(buildPlaceIntentClause(expansion.placeTerms));
  }

  if (expansion.unmatchedText) {
    must.push(buildTextIntentClause([expansion.unmatchedText], { operator: 'and' }));
  }

  if (must.length === 0) {
    must.push(buildTextIntentClause(expansion.expandedTerms.length ? expansion.expandedTerms : [text]));
  }

  return must;
}

function buildAutocompleteMustClauses(text, expansion) {
  const must = [];

  if (expansion.categoryIds.length > 0 || (expansion.intentGroups || []).length > 0) {
    must.push(buildCategoryIntentClause(expansion, { autocomplete: true }));
  }

  if (expansion.placeTerms.length > 0) {
    must.push(buildPlacePrefixClause(expansion.placeTerms));
  }

  const remainingTerms = expansion.unmatchedText
    ? [expansion.unmatchedText]
    : [expansion.normalized || text].filter(Boolean);
  must.push(buildAutocompleteTextClause(remainingTerms));

  return must;
}

function buildTextIntentClause(terms, opts = {}) {
  const clauses = unique(terms).map((term, index) => ({
    multi_match: {
      query: term,
      fields: searchTextFields(),
      type: 'best_fields',
      operator: opts.operator || 'or',
      fuzziness: 'AUTO',
      boost: index === 0 ? 1 : 0.65
    }
  }));

  return {
    bool: {
      should: clauses,
      minimum_should_match: 1
    }
  };
}

function buildCategoryIntentClause(expansion, opts = {}) {
  const boost = opts.autocomplete ? 7 : 8;
  const should = [];

  for (const category of expansion.categoryIds) {
    should.push({ term: { category_ids: { value: category, boost } } });
    should.push({ term: { categories: { value: category, boost: boost - 1 } } });
    should.push({ term: { category: { value: category, boost: boost - 1 } } });
  }

  for (const group of expansion.intentGroups || []) {
    should.push({ term: { intent_groups: { value: group, boost: opts.autocomplete ? 4 : 3 } } });
  }

  for (const tag of expansion.sourceTags) {
    should.push({ term: { [`source_tags.${tag.field}`]: { value: tag.value, boost: boost - 1 } } });
  }

  const categoryTerms = opts.autocomplete
    ? (expansion.categoryTerms || []).slice(0, 6)
    : (expansion.categoryTerms || []);
  for (const term of categoryTerms) {
    should.push({
      match: {
        category_aliases: {
          query: term,
          boost: opts.autocomplete ? 4 : 3
        }
      }
    });
    should.push({
      match: {
        category_terms: {
          query: term,
          boost: opts.autocomplete ? 5 : 4
        }
      }
    });
  }

  return {
    bool: {
      should,
      minimum_should_match: 1
    }
  };
}

function buildPlaceIntentClause(placeTerms) {
  const should = [];
  for (const term of unique(placeTerms)) {
    should.push({
      multi_match: {
        query: term,
        fields: placeTextFields(),
        type: 'best_fields',
        operator: 'and',
        fuzziness: 'AUTO'
      }
    });
  }

  return {
    bool: {
      should,
      minimum_should_match: 1
    }
  };
}

function buildPlacePrefixClause(placeTerms) {
  const should = [];
  for (const term of unique(placeTerms)) {
    should.push({
      multi_match: {
        query: term,
        fields: placeTextFields(),
        type: 'bool_prefix',
        fuzziness: 'AUTO'
      }
    });
    should.push({
      match_phrase_prefix: {
        label: { query: term, boost: 3 }
      }
    });
  }

  return {
    bool: {
      should,
      minimum_should_match: 1
    }
  };
}

function buildAutocompleteTextClause(terms) {
  const should = [];
  for (const term of unique(terms)) {
    should.push({
      multi_match: {
        query: term,
        fields: autocompleteTextFields(),
        type: 'bool_prefix',
        fuzziness: 'AUTO'
      }
    });
    for (const field of ['name.default', 'label', 'name.ar', 'name.en', 'name.ku', 'name.ckb', 'category_aliases']) {
      should.push({
        match_phrase_prefix: {
          [field]: { query: term, boost: field === 'category_aliases' || field === 'category_terms' ? 3 : 4 }
        }
      });
    }
  }

  return {
    bool: {
      should,
      minimum_should_match: 1
    }
  };
}

function searchTextFields() {
  return [
    'name.default^5',
    'label^4',
    'names.*^3',
    'name.ar^3',
    'name.en^3',
    'name.ku^2',
    'name.ckb^2',
    'phrase.default^3',
    'phrase.ar^2',
    'phrase.en^2',
    'parent.locality^2',
    'locality^2',
    'parent.region^1.5',
    'region^1.5',
    'country^1',
    'category^2',
    'categories^2',
    'category_ids^2',
    'category_terms^4',
    'intent_groups^2',
    'category_aliases^3',
    'source_tags.amenity^2',
    'source_tags.shop^2',
    'source_tags.tourism^2',
    'source_tags.leisure^2',
    'source_tags.office^2'
  ];
}

function placeTextFields() {
  return [
    'parent.locality^4',
    'locality^4',
    'parent.localadmin^3',
    'localadmin^3',
    'parent.region^3',
    'region^3',
    'parent.county^2',
    'county^2',
    'parent.neighbourhood^2',
    'neighbourhood^2'
  ];
}

function autocompleteTextFields() {
  return [
    'name.default^5',
    'label^4',
    'names.*^3',
    'name.ar^3',
    'name.en^3',
    'name.ku^2',
    'name.ckb^2',
    'phrase.default^2',
    'category_terms^5',
    'category_aliases^4',
    'intent_groups^2',
    'parent.locality^2',
    'locality^2',
    'region^1.5'
  ];
}

function addListFilter(filters, field, value) {
  if (!value) return;
  const values = (Array.isArray(value) ? value : String(value).split(','))
    .map(item => item.trim())
    .filter(Boolean);
  if (values.length === 1) {
    filters.push({ term: { [field]: values[0] } });
  } else if (values.length > 1) {
    filters.push({ terms: { [field]: values } });
  }
}

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

function applyRankingFormula(query, options = {}) {
  const functions = buildRankingFunctions(options);
  if (functions.length === 0) return query;
  const hasFocus = options.focusLat != null && options.focusLon != null;

  return {
    function_score: {
      query,
      functions,
      score_mode: 'sum',
      boost_mode: hasFocus ? 'multiply' : 'sum'
    }
  };
}

function buildRankingFunctions(options = {}) {
  const rc = _rankingConfig || loadRankingConfig();
  const functions = [];

  if (options.focusLat != null && options.focusLon != null && (!rc.distance || rc.distance.enabled !== false)) {
    const distance = rc.distance || {};
    const offsetKm = distance.offset_km == null ? 0.2 : distance.offset_km;
    functions.push({
      gauss: {
        center_point: {
          origin: { lat: options.focusLat, lon: options.focusLon },
          scale: `${distance.decay_km || 3}km`,
          offset: `${offsetKm}km`,
          decay: 0.5
        }
      },
      weight: distance.weight || 15
    });

    const proximityBoosts = Array.isArray(distance.proximity_boosts)
      ? distance.proximity_boosts
      : [
          { distance: '5km', weight: 40 },
          { distance: '25km', weight: 15 },
          { distance: '100km', weight: 5 }
        ];
    for (const boost of proximityBoosts) {
      if (!boost || !boost.distance || !Number.isFinite(Number(boost.weight))) continue;
      functions.push({
        filter: {
          geo_distance: {
            distance: String(boost.distance),
            center_point: { lat: options.focusLat, lon: options.focusLon }
          }
        },
        weight: Number(boost.weight)
      });
    }
  }

  functions.push({
    field_value_factor: {
      field: 'popularity',
      factor: rc.popularity_weight == null ? 0.1 : rc.popularity_weight,
      modifier: 'log1p',
      missing: 0
    },
    weight: 1
  });

  functions.push({
    field_value_factor: {
      field: 'importance',
      factor: rc.importance_weight == null ? 1 : rc.importance_weight,
      modifier: 'log1p',
      missing: 0
    },
    weight: 1
  });

  const categories = normalizeList(options.categories);
  const resolvedCategories = unique([
    ...categories,
    ...((options.categoryExpansion && options.categoryExpansion.categoryIds) || [])
  ]);
  if (resolvedCategories.length > 0) {
    functions.push({
      filter: { terms: { category_ids: resolvedCategories } },
      weight: rc.category_match_boost || 1.3
    });
  }

  const intentGroups = unique((options.categoryExpansion && options.categoryExpansion.intentGroups) || []);
  if (intentGroups.length > 0) {
    functions.push({
      filter: { terms: { intent_groups: intentGroups } },
      weight: Math.max(1, (rc.category_match_boost || 1.3) - 0.15)
    });
  }

  for (const [layer, weight] of Object.entries(rc.layers || {})) {
    if (Number.isFinite(Number(weight)) && Number(weight) !== 1) {
      functions.push({
        filter: { term: { layer } },
        weight: Number(weight)
      });
    }
  }

  return functions;
}

function normalizeList(value) {
  if (!value) return [];
  return (Array.isArray(value) ? value : String(value).split(','))
    .map(item => String(item).trim())
    .filter(Boolean);
}

/**
 * Builds a debug/explain ES query for internal introspection.
 */
function buildExplainQuery(query, text) {
  const focusLat = query['focus.point.lat'] != null ? Number(query['focus.point.lat']) : undefined;
  const focusLon = query['focus.point.lon'] != null ? Number(query['focus.point.lon']) : undefined;
  const body = buildSearchQuery(text, {
    ...query,
    size: Number(query.size) || 10,
    focusLat,
    focusLon
  });

  body.aggs = {
    layers: { terms: { field: 'layer', size: 20 } }
  };
  body.track_total_hits = true;

  return body;
}

module.exports = {
  loadRankingConfig,
  getRankingFormula,
  buildSearchQuery,
  buildAutocompleteQuery,
  buildStructuredQuery,
  buildReverseQuery,
  buildNearbyQuery,
  buildExplainQuery,
  addBoundaryFilters,
  addListFilter,
  applyRankingFormula,
  buildRankingFunctions,
  normalizeCountryCode
};
