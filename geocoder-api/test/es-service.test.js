'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const EsService = require('../src/es-service');
const { sourceFreshness } = require('../src/es-service');

test('EsService.stats: counts documents by source_config and missing country_a by layer', async () => {
  const es = {
    async search() {
      return {
        aggregations: {
          layers: { buckets: [{ key: 'venue', doc_count: 10 }] },
          sources: { buckets: [{ key: 'osm_postgis', doc_count: 10 }] },
          source_configs: { buckets: [{ key: 'osm_pois', doc_count: 10 }] },
          countries: { buckets: [{ key: 'IQ', doc_count: 9 }] },
          missing_country_a: {
            layers: { buckets: [{ key: 'venue', doc_count: 1 }] },
            source_configs: { buckets: [{ key: 'osm_pois', doc_count: 1 }] },
            reasons: { buckets: [{ key: 'no_covering_admin_boundary', doc_count: 1 }] },
            statuses: { buckets: [{ key: 'missing_country', doc_count: 1 }] },
            samples: {
              hits: {
                hits: [{
                  _id: 'postgis:osm_pois:1',
                  _source: {
                    source: 'osm_postgis',
                    source_config: 'osm_pois',
                    layer: 'venue',
                    source_id: '1',
                    name: { default: 'Missing Country Cafe' },
                    admin_enrichment_status: 'missing_country',
                    admin_enrichment_reason: 'no_covering_admin_boundary'
                  }
                }]
              }
            }
          }
        }
      };
    },
    async count() { return { count: 10 }; },
    indices: {
      async getAlias() { return { pelias_v1: {} }; }
    }
  };
  const service = new EsService(es, {
    peliasAlias: 'pelias',
    workerStatePath: '/tmp/missing-state.json',
    syncConfigPath: '/tmp/missing-sync-config.json',
    workerStaleThresholdSeconds: 86400
  });
  service.readWorkerState = async () => ({
    sources: {
      osm_pois: {
        last_success_timestamp: new Date().toISOString(),
        last_indexed_count: 10,
        last_failed_count: 0,
        last_deleted_count: 0
      }
    }
  });
  service.readSyncConfig = async () => ({
    sources: [{ name: 'osm_pois', stale_after_seconds: 43200 }]
  });

  const stats = await service.stats();

  assert.equal(stats.sources.osm_pois.documents, 10);
  assert.equal(stats.source_config_documents.osm_pois, 10);
  assert.equal(stats.documents_by_source_config.osm_pois, 10);
  assert.equal(stats.documents_by_country_a.IQ, 9);
  assert.equal(stats.documents_missing_country_a.venue, 1);
  assert.equal(stats.documents_missing_country_a_by_source_config.osm_pois, 1);
  assert.equal(stats.admin_enrichment_missing_country_reasons.no_covering_admin_boundary, 1);
  assert.equal(stats.admin_enrichment_missing_country_statuses.missing_country, 1);
  assert.equal(stats.missing_country_a_samples[0].gid, 'osm_postgis:venue:1');
});

test('sourceFreshness: source-specific thresholds avoid stale admin boundaries', () => {
  const state = {
    sources: {
      admin_boundaries: {
        last_success_timestamp: new Date(Date.now() - 48 * 3600 * 1000).toISOString()
      }
    }
  };
  const syncConfig = {
    sources: [{ name: 'admin_boundaries', stale_after_seconds: 604800 }]
  };

  const freshness = sourceFreshness(state, syncConfig, 86400);

  assert.equal(freshness.worker_stale, false);
  assert.deepEqual(freshness.stale_sources, []);
});
