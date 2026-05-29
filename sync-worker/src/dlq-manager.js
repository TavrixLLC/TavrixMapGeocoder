'use strict';

class DlqManager {
  constructor(pool, logger) {
    this.pool = pool;
    this.log = logger;
  }

  async query(opts = {}) {
    const limit = Math.min(opts.limit || 50, 500);
    const conditions = [];
    const params = [];
    let paramIdx = 1;

    if (opts.error_type) {
      conditions.push(`error_type = $${paramIdx++}`);
      params.push(opts.error_type);
    }
    if (opts.table_name) {
      conditions.push(`table_name = $${paramIdx++}`);
      params.push(opts.table_name);
    }
    if (opts.replayed === false) {
      conditions.push(`replayed = FALSE`);
    }

    const whereClause = conditions.length > 0
      ? 'WHERE ' + conditions.join(' AND ')
      : '';

    params.push(limit);

    const { rows } = await this.pool.query(`
      SELECT * FROM pelias_dlq
      ${whereClause}
      ORDER BY failed_at DESC
      LIMIT $${paramIdx}
    `, params);

    return rows;
  }

  async getDepth() {
    const { rows } = await this.pool.query(
      `SELECT COUNT(*) AS depth FROM pelias_dlq WHERE replayed = FALSE`
    );
    return parseInt(rows[0].depth, 10);
  }

  async replay(filter = {}) {
    let whereClause = 'replayed = FALSE';
    const params = [];
    let paramIdx = 1;

    if (filter.ids && filter.ids.length > 0) {
      whereClause += ` AND id = ANY($${paramIdx++}::bigint[])`;
      params.push(filter.ids);
    }
    if (filter.error_type) {
      whereClause += ` AND error_type = $${paramIdx++}`;
      params.push(filter.error_type);
    }
    if (filter.table_name) {
      whereClause += ` AND table_name = $${paramIdx++}`;
      params.push(filter.table_name);
    }

    const { rows: dlqEntries } = await this.pool.query(
      `SELECT * FROM pelias_dlq WHERE ${whereClause} ORDER BY id LIMIT 10000`,
      params
    );

    if (dlqEntries.length === 0) return { replayed: 0 };

    let replayed = 0;
    for (const entry of dlqEntries) {
      await this.pool.query(`
        INSERT INTO pelias_outbox
          (table_name, action, record_id, status, trigger_version, created_at)
        VALUES ($1, $2, $3, 'pending', $4, NOW())
      `, [entry.table_name, entry.action, entry.record_id, entry.trigger_version || 1]);

      await this.pool.query(
        `UPDATE pelias_dlq SET replayed = TRUE, replayed_at = NOW() WHERE id = $1`,
        [entry.id]
      );
      replayed++;
    }

    this.log.info('DLQ replay completed', { replayed });
    return { replayed };
  }
}

module.exports = DlqManager;
