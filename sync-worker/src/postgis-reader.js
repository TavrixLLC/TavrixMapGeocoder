'use strict';

const { Pool } = require('pg');
const QueryStream = require('pg-query-stream');

class PostgisReader {
  constructor(config, logger) {
    this.config = config;
    this.log = logger;
    this.pool = new Pool({
      host: requiredEnv('POSTGIS_HOST'),
      port: Number(process.env.POSTGIS_PORT || 5432),
      database: requiredEnv('POSTGIS_DB'),
      user: requiredEnv('POSTGIS_USER'),
      password: requiredEnv('POSTGIS_PASSWORD'),
      max: Number(process.env.POSTGIS_POOL_SIZE || 4),
      application_name: 'pelias_postgis_readonly_sync',
      options: [
        '-c default_transaction_read_only=on',
        `-c statement_timeout=${config.postgis.statement_timeout_ms}`,
        `-c idle_in_transaction_session_timeout=${config.postgis.idle_in_transaction_session_timeout_ms}`
      ].join(' ')
    });
    this.closed = false;
  }

  async ping() {
    await this.assertReadOnlySession(this.pool);
    await this.pool.query('SELECT 1');
  }

  async close() {
    if (this.closed) return;
    this.closed = true;
    await this.pool.end();
  }

  async *streamSource(source, limit) {
    const client = await this.pool.connect();
    const startedAt = Date.now();
    const batchSize = source.batch_size || this.config.postgis.fetch_size || 1000;

    try {
      await client.query('BEGIN READ ONLY');
      await this.assertReadOnlySession(client);
      const sql = this.buildSql(source, limit);
      const stream = client.query(new QueryStream(sql, [], { batchSize }));

      for await (const row of stream) {
        yield row;
      }

      await client.query('COMMIT');
      this.log.info('PostGIS source query finished', {
        source: source.name,
        duration_ms: Date.now() - startedAt
      });
    } catch (err) {
      try {
        await client.query('ROLLBACK');
      } catch (_) {
        // Ignore rollback failure so the original error is preserved.
      }
      throw err;
    } finally {
      client.release();
    }
  }

  async queryReadOnly(sql, params = [], options = {}) {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN READ ONLY');
      await this.assertReadOnlySession(client);
      const statementTimeoutMs = Number(options.statementTimeoutMs || 0);
      if (Number.isFinite(statementTimeoutMs) && statementTimeoutMs > 0) {
        await client.query(`SET LOCAL statement_timeout = ${Math.floor(statementTimeoutMs)}`);
      }
      const response = await client.query(sql, params);
      await client.query('COMMIT');
      return response.rows || [];
    } catch (err) {
      try {
        await client.query('ROLLBACK');
      } catch (_) {
        // Preserve original error.
      }
      throw err;
    } finally {
      client.release();
    }
  }

  buildSql(source, limit) {
    const geom = quoteIdentifier(source.geometry_field);

    let sql = `
      SELECT
        q.*,
        ST_X(ST_Transform(ST_PointOnSurface(q.${geom}), 4326)) AS _lon,
        ST_Y(ST_Transform(ST_PointOnSurface(q.${geom}), 4326)) AS _lat
      FROM (
        ${source.sql}
      ) AS q
      WHERE q.${geom} IS NOT NULL
    `;

    if (limit !== undefined && limit !== null) {
      const parsedLimit = Number(limit);
      if (Number.isInteger(parsedLimit) && parsedLimit >= 0) {
        sql += ` LIMIT ${parsedLimit}`;
      }
    }

    return sql;
  }

  async assertReadOnlySession(client) {
    const response = await client.query('SHOW transaction_read_only');
    const value = response && response.rows && response.rows[0]
      ? response.rows[0].transaction_read_only
      : null;
    if (String(value).toLowerCase() !== 'on') {
      throw new Error('PostGIS connection is not read-only');
    }
  }
}

function quoteIdentifier(identifier) {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(identifier)) {
    throw new Error(`Invalid SQL identifier: ${identifier}`);
  }
  return `"${identifier}"`;
}

function requiredEnv(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable ${name}`);
  }
  return value;
}

module.exports = PostgisReader;
