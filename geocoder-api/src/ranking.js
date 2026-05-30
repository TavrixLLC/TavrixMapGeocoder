'use strict';

const fs = require('fs');
const path = require('path');

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
    distance: { enabled: true, decay_km: 5 },
    dedupe: { enabled: true, distance_threshold_meters: 30 },
    exact_match_boost: 2.0,
    prefix_match_boost: 1.5,
    category_match_boost: 1.3
  };
  return _rankingConfig;
}

/**
 * Builds a full-text search ES query with ranking.
 */
function buildSearchQuery(text, options = {}) {
  const rc = _rankingConfig || {};
  const size = options.size || 10;
  const filters = [];
  const should = [];

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

  // Main multi-match query
  const must = [{
    multi_match: {
      query: text,
      fields: [
        'name.default^4',
        'name.ar^3',
        'name.en^3',
        'name.ku^2',
        'phrase.default^3',
        'phrase.ar^2',
        'phrase.en^2',
        'category^1'
      ],
      type: 'best_fields',
      operator: 'or',
      fuzziness: 'AUTO'
    }
  }];

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

  const query = {
    bool: {
      must,
      should,
      filter: filters.length > 0 ? filters : undefined
    }
  };

  const body = { size, query };

  // Focus point distance decay
  if (options.focusLat != null && options.focusLon != null && rc.distance && rc.distance.enabled) {
    body.query = {
      function_score: {
        query,
        functions: [{
          gauss: {
            center_point: {
              origin: { lat: options.focusLat, lon: options.focusLon },
              scale: `${rc.distance.decay_km || 5}km`,
              offset: '0.5km',
              decay: 0.5
            }
          },
          weight: 1.5
        }],
        score_mode: 'sum',
        boost_mode: 'multiply'
      }
    };
  }

  return body;
}

/**
 * Builds an autocomplete/prefix ES query.
 * Optimized for speed: fewer fields, match_phrase_prefix, lower size.
 */
function buildAutocompleteQuery(text, options = {}) {
  const size = options.size || 5;
  const filters = [];

  addListFilter(filters, 'layer', options.layers);
  addListFilter(filters, 'source', options.sources);
  if (options.categories) {
    addListFilter(filters, 'category', options.categories);
  }
  addBoundaryFilters(filters, options);

  const must = [{
    bool: {
      should: [
        {
          match_phrase_prefix: {
            'name.default': { query: text, boost: 4 }
          }
        },
        {
          match_phrase_prefix: {
            'name.ar': { query: text, boost: 3 }
          }
        },
        {
          match_phrase_prefix: {
            'name.en': { query: text, boost: 3 }
          }
        },
        {
          match_phrase_prefix: {
            'phrase.default': { query: text, boost: 2 }
          }
        }
      ],
      minimum_should_match: 1
    }
  }];

  const query = {
    bool: {
      must,
      filter: filters.length > 0 ? filters : undefined
    }
  };

  const body = { size, query };

  // Focus point scoring
  if (options.focusLat != null && options.focusLon != null) {
    body.query = {
      function_score: {
        query,
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
    filters.push({
      term: { 'parent.country_a': query['boundary.country'].toUpperCase() }
    });
  }
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

/**
 * Builds a debug/explain ES query for internal introspection.
 */
function buildExplainQuery(query, text) {
  const filters = [];
  addListFilter(filters, 'layer', query.layers);
  addListFilter(filters, 'source', query.sources);
  addBoundaryFilters(filters, query);

  if (query['point.lat'] && query['point.lon']) {
    filters.push({
      geo_distance: {
        distance: query.radius ? `${Number(query.radius)}m` : '50000m',
        center_point: {
          lat: Number(query['point.lat']),
          lon: Number(query['point.lon'])
        }
      }
    });
  }

  return {
    size: 10,
    query: {
      bool: {
        must: [{
          multi_match: {
            query: text,
            fields: ['name.default^4', 'phrase.default^3', 'name.en^3', 'name.ar^3', 'category']
          }
        }],
        filter: filters
      }
    },
    aggs: {
      layers: { terms: { field: 'layer', size: 20 } }
    }
  };
}

module.exports = {
  loadRankingConfig,
  buildSearchQuery,
  buildAutocompleteQuery,
  buildStructuredQuery,
  buildReverseQuery,
  buildNearbyQuery,
  buildExplainQuery,
  addBoundaryFilters,
  addListFilter
};
