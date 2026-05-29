'use strict';

class EventReader {
  constructor(pool, config, logger) {
    this.pool = pool;
    this.config = config;
    this.log = logger;
    this.workerId = process.env.WORKER_ID || 'worker-01';
    this.batchSize = config.postgis_sync?.batch_size || 500;
    this.maxRetries = config.postgis_sync?.max_retries || 5;
    this.claimTimeoutMin = config.postgis_sync?.claim_timeout_minutes || 5;
  }

  async claimAndCollapse(sources) {
    const totalWeight = sources.reduce((s, src) => s + (src.weight || 1), 0);
    const allEvents = [];

    for (const source of sources) {
      const weight = source.weight || 1;
      const quota = Math.max(1, Math.floor(this.batchSize * weight / totalWeight));

      const { rows } = await this.pool.query(`
        WITH claimable AS (
            SELECT id, created_at
            FROM pelias_outbox
            WHERE table_name = $1
              AND (
                status = 'pending'
                OR (status = 'failed' AND retry_count < $3)
                OR (status = 'processing' AND claimed_at < NOW() - INTERVAL '${this.claimTimeoutMin} minutes')
              )
            ORDER BY created_at, id
            LIMIT $2
            FOR UPDATE SKIP LOCKED
        )
        UPDATE pelias_outbox o
        SET status = 'processing',
            claimed_by = $4,
            claimed_at = NOW()
        FROM claimable c
        WHERE o.id = c.id AND o.created_at = c.created_at
        RETURNING o.*
      `, [source.table, quota, this.maxRetries, this.workerId]);

      allEvents.push(...rows);
    }

    if (allEvents.length === 0) return { collapsed: [], allEventIds: [] };

    // Collapse: keep only latest event per (table_name, record_id)
    // Exception: DELETE always wins
    const collapsed = new Map();
    for (const event of allEvents) {
      const key = `${event.table_name}:${event.record_id}`;
      const existing = collapsed.get(key);

      if (!existing) {
        collapsed.set(key, event);
      } else if (event.action === 'DELETE') {
        collapsed.set(key, event);
      } else if (existing.action !== 'DELETE' && event.id > existing.id) {
        collapsed.set(key, event);
      }
    }

    this.log.info('Claimed and collapsed events', {
      claimed: allEvents.length,
      collapsed: collapsed.size
    });

    return {
      collapsed: Array.from(collapsed.values()),
      allEventIds: allEvents.map(e => e.id)
    };
  }

  async markProcessed(eventIds) {
    if (eventIds.length === 0) return;
    await this.pool.query(
      `UPDATE pelias_outbox SET status = 'processed' WHERE id = ANY($1::bigint[])`,
      [eventIds]
    );
  }

  async markFailed(eventIds, errorMsg) {
    if (eventIds.length === 0) return;
    await this.pool.query(
      `UPDATE pelias_outbox
       SET status = 'failed',
           retry_count = retry_count + 1,
           last_error = $2,
           claimed_by = NULL,
           claimed_at = NULL
       WHERE id = ANY($1::bigint[])`,
      [eventIds, errorMsg]
    );
  }

  async getOutboxDepth() {
    const { rows } = await this.pool.query(`
      SELECT
        COUNT(*) FILTER (WHERE status = 'pending') AS pending,
        COUNT(*) FILTER (WHERE status = 'processing') AS processing,
        COUNT(*) FILTER (WHERE status = 'failed') AS failed
      FROM pelias_outbox
    `);
    return rows[0];
  }

  async getOldestPendingAge() {
    const { rows } = await this.pool.query(`
      SELECT EXTRACT(EPOCH FROM (NOW() - MIN(created_at))) AS age_seconds
      FROM pelias_outbox
      WHERE status = 'pending'
    `);
    return rows[0]?.age_seconds || 0;
  }
}

module.exports = EventReader;
