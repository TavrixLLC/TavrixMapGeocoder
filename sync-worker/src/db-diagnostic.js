'use strict';

require('dotenv').config();
const { Pool } = require('pg');

async function main() {
  const pool = new Pool({
    host: process.env.POSTGIS_HOST,
    port: Number(process.env.POSTGIS_PORT || 5432),
    database: process.env.POSTGIS_DB,
    user: process.env.POSTGIS_USER,
    password: process.env.POSTGIS_PASSWORD,
    max: 1
  });

  try {
    console.log('Connecting to database...');
    const client = await pool.connect();
    console.log('Connected.');

    // 1. Check SRID of planet_osm_line.way
    console.log('\n--- Checking SRID of planet_osm_line.way ---');
    const sridRes = await client.query(`
      SELECT Find_SRID('public', 'planet_osm_line', 'way') AS srid
    `);
    const srid = sridRes.rows[0]?.srid;
    console.log(`SRID: ${srid}`);

    // Check one row geometry details
    const geomDetails = await client.query(`
      SELECT ST_SRID(way) as row_srid, GeometryType(way) as geom_type
      FROM planet_osm_line
      LIMIT 1
    `);
    console.log('Sample row details:', geomDetails.rows[0]);

    // 2. Check if GiST index exists on planet_osm_line(way)
    console.log('\n--- Checking GiST indexes on planet_osm_line ---');
    const indexRes = await client.query(`
      SELECT
        t.relname as table_name,
        i.relname as index_name,
        a.attname as column_name,
        am.amname as index_type
      FROM
        pg_class t,
        pg_class i,
        pg_index ix,
        pg_attribute a,
        pg_am am
      WHERE
        t.oid = ix.indrelid
        and i.oid = ix.indexrelid
        and a.attrelid = t.oid
        and a.attnum = ANY(ix.indkey)
        and t.relkind = 'r'
        and t.relname = 'planet_osm_line'
        and a.attname = 'way'
        and i.relam = am.oid;
    `);
    console.log('Index query results:', indexRes.rows);

    // 3. Count roads with highway filter
    console.log('\n--- Counting roads with highway filter ---');
    const roadFilter = "highway IN ('motorway', 'trunk', 'primary', 'secondary', 'tertiary', 'unclassified', 'residential', 'service', 'living_street', 'pedestrian')";
    const countRes = await client.query(`
      SELECT COUNT(*) as total_roads
      FROM planet_osm_line
      WHERE ${roadFilter}
    `);
    console.log(`Total roads matching filter: ${countRes.rows[0]?.total_roads}`);

    client.release();
  } catch (err) {
    console.error('Error running diagnostics:', err);
  } finally {
    await pool.end();
  }
}

main();
