'use strict';

require('dotenv').config();
const { Client: EsClient } = require('@elastic/elasticsearch');
const { loadConfig } = require('./config-validator');

async function runVerificationCheck(esClient, index, log) {
  log.info('Running P1 verification query against Elasticsearch', { index });
  try {
    try {
      await esClient.indices.refresh({ index });
    } catch (refreshErr) {
      if (typeof log.warn === 'function') {
        log.warn('Could not refresh Elasticsearch index before verification query', { error: refreshErr.message });
      }
    }
    const countsResponse = await esClient.search({
      index,
      body: {
        size: 0,
        aggs: {
          status_counts: {
            terms: {
              field: 'routable_point_status',
              missing: 'missing',
              size: 10
            }
          }
        }
      }
    });

    const countsBody = countsResponse.body || countsResponse;
    const buckets = countsBody.aggregations?.status_counts?.buckets || [];

    console.log('\n================ P1 VERIFICATION REPORT ================');
    console.log(`Index: ${index}`);
    console.log('\n--- Routable Point Status Counts ---');
    if (buckets.length === 0) {
      console.log('  No status counts found.');
    } else {
      buckets.forEach(b => {
        console.log(`  ${b.key}: ${b.doc_count}`);
      });
    }

    const snappedResponse = await esClient.search({
      index,
      body: {
        size: 3,
        query: { term: { routable_point_status: 'snapped' } }
      }
    });
    const snappedBody = snappedResponse.body || snappedResponse;
    const snappedHits = snappedBody.hits?.hits || [];
    console.log('\n--- Sample Snapped Documents ---');
    if (snappedHits.length === 0) {
      console.log('  No snapped documents found.');
    } else {
      snappedHits.forEach(hit => {
        const src = hit._source;
        console.log(`  ID: ${hit._id}`);
        console.log(`    Name: ${src.name?.default || 'N/A'}`);
        console.log(`    Center Lat/Lon: ${src.center_point?.lat}, ${src.center_point?.lon}`);
        console.log(`    Routable Point: ${src.routable_point?.lat}, ${src.routable_point?.lon}`);
        console.log(`    Distance: ${src.routable_point_distance_meters || 'N/A'} meters`);
      });
    }

    const fallbackResponse = await esClient.search({
      index,
      body: {
        size: 3,
        query: { term: { routable_point_status: 'centroid_fallback' } }
      }
    });
    const fallbackBody = fallbackResponse.body || fallbackResponse;
    const fallbackHits = fallbackBody.hits?.hits || [];
    console.log('\n--- Sample Fallback Documents ---');
    if (fallbackHits.length === 0) {
      console.log('  No fallback documents found.');
    } else {
      fallbackHits.forEach(hit => {
        const src = hit._source;
        console.log(`  ID: ${hit._id}`);
        console.log(`    Name: ${src.name?.default || 'N/A'}`);
        console.log(`    Center Lat/Lon: ${src.center_point?.lat}, ${src.center_point?.lon}`);
        console.log(`    Routable Point: ${src.routable_point?.lat}, ${src.routable_point?.lon}`);
        console.log(`    Reason: ${src.routable_point_reason || 'N/A'}`);
      });
    }
    console.log('========================================================\n');
  } catch (err) {
    log.error('Failed to run verification check', { error: err.message });
  }
}

async function verify() {
  const log = {
    info(msg, meta) { console.log(`INFO: ${msg}`, meta ? JSON.stringify(meta) : ''); },
    error(msg, meta) { console.error(`ERROR: ${msg}`, meta ? JSON.stringify(meta) : ''); }
  };
  const config = loadConfig(process.env.SYNC_CONFIG_PATH);
  config.elasticsearch.url = process.env.ELASTICSEARCH_URL || config.elasticsearch.url;

  const esClient = new EsClient({
    node: config.elasticsearch.url,
    requestTimeout: config.elasticsearch.request_timeout_ms
  });

  const index = process.env.P1_VERIFY_INDEX || config.elasticsearch.write_alias;
  const readAlias = config.elasticsearch.read_alias || 'pelias';
  const writeAlias = config.elasticsearch.write_alias || 'pelias_write';

  if (index === readAlias || index === writeAlias || index === 'pelias' || index === 'pelias_write') {
    if (process.env.P1_VERIFY_ALLOW_WRITE_ALIAS !== 'true') {
      const errMsg = `Safety Error: Verification target index '${index}' is a production alias. Verifying production alias is forbidden unless P1_VERIFY_ALLOW_WRITE_ALIAS=true is explicitly set.`;
      log.error(errMsg);
      throw new Error(errMsg);
    }
  }

  try {
    await runVerificationCheck(esClient, index, log);
  } finally {
    await esClient.close();
  }
}

if (require.main === module) {
  verify().catch(err => {
    console.error(err);
    process.exit(1);
  });
}

module.exports = {
  runVerificationCheck,
  verify
};
