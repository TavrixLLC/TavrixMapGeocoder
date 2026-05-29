'use strict';

class StateFetcher {
  constructor(pool, sourcesConfig, logger) {
    this.pool = pool;
    this.sourcesConfig = sourcesConfig;
    this.log = logger;
    this._configMap = new Map();
    for (const src of sourcesConfig) {
      this._configMap.set(src.table, src);
    }
  }

  async fetchCurrentStates(events) {
    const results = [];
    const byTable = this._groupBy(events, 'table_name');

    for (const [tableName, tableEvents] of Object.entries(byTable)) {
      const sourceConfig = this._configMap.get(tableName);

      if (!sourceConfig) {
        for (const e of tableEvents) {
          results.push({ event: e, state: null, action: 'ERROR', error: `Unknown table: ${tableName}` });
        }
        continue;
      }

      // Separate deletes from upserts
      const deletes = tableEvents.filter(e => e.action === 'DELETE');
      const upserts = tableEvents.filter(e => e.action !== 'DELETE');

      for (const e of deletes) {
        results.push({ event: e, state: null, action: 'DELETE' });
      }

      if (upserts.length === 0) continue;

      // Batch fetch current state from PostGIS
      const ids = upserts.map(e => e.record_id);
      const idField = sourceConfig.id_field || 'id';
      const geomField = sourceConfig.geometry_field || 'geom';

      let softDeleteClause = '';
      if (sourceConfig.soft_delete) {
        const sd = sourceConfig.soft_delete;
        if (sd.delete_when === 'not_null') {
          softDeleteClause = `AND ${sd.field} IS NULL`;
        } else if (sd.delete_when === 'true') {
          softDeleteClause = `AND (${sd.field} = FALSE OR ${sd.field} IS NULL)`;
        }
      }

      try {
        const { rows } = await this.pool.query(`
          SELECT *,
                 ST_Y(ST_Transform(ST_Centroid(${geomField}), 4326)) AS _lat,
                 ST_X(ST_Transform(ST_Centroid(${geomField}), 4326)) AS _lon,
                 EXTRACT(EPOCH FROM NOW()) * 1000 AS _fetched_at
          FROM ${tableName}
          WHERE ${idField}::text = ANY($1::text[])
          ${softDeleteClause}
        `, [ids]);

        const rowMap = new Map(rows.map(r => [String(r[idField]), r]));

        for (const e of upserts) {
          const row = rowMap.get(e.record_id);
          if (!row) {
            // Record was deleted or doesn't pass soft-delete filter
            results.push({ event: e, state: null, action: 'DELETE' });
          } else {
            results.push({ event: e, state: row, action: 'UPSERT' });
          }
        }
      } catch (err) {
        this.log.error('Failed to fetch states from PostGIS', {
          table: tableName,
          error: err.message,
          recordCount: ids.length
        });
        for (const e of upserts) {
          results.push({ event: e, state: null, action: 'ERROR', error: err.message });
        }
      }
    }

    return results;
  }

  _groupBy(arr, key) {
    const groups = {};
    for (const item of arr) {
      const k = item[key];
      if (!groups[k]) groups[k] = [];
      groups[k].push(item);
    }
    return groups;
  }
}

module.exports = StateFetcher;
