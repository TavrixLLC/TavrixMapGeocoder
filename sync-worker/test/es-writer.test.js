'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const EsWriter = require('../src/es-writer');

test('deleteIds: rejects cross-source IDs before bulk delete', async () => {
  const bulkActions = [];
  const writer = new EsWriter(
    {
      async bulk({ body }) {
        bulkActions.push(...body);
        return {
          items: body.map(item => item.delete ? { delete: { status: 200 } } : { index: { status: 200 } })
        };
      }
    },
    {
      elasticsearch: {
        write_alias: 'pelias_write',
        max_bulk_docs: 100,
        max_bulk_bytes: 1024 * 1024,
        max_retries: 0
      }
    },
    { esBulkDuration: { labels: () => ({ observe() {} }) } },
    { warn() {}, error() {} }
  );

  const result = await writer.deleteIds('osm_pois', [
    'postgis:osm_pois:1',
    'postgis:streets:2'
  ]);

  assert.equal(result.deleted, 1);
  assert.equal(result.failed, 1);
  assert.equal(bulkActions.length, 1);
  assert.equal(bulkActions[0].delete._id, 'postgis:osm_pois:1');
});
