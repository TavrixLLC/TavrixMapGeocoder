# Pelias PostGIS Read-Only Geocoder

This project runs a Docker-based Pelias stack that reads selected searchable features from an existing PostGIS database and indexes them into Pelias Elasticsearch.

PostGIS is read-only for this system. The worker uses `SELECT` queries only, starts Postgres sessions with `default_transaction_read_only=on`, and stores sync state outside PostGIS.

## Architecture

```text
Existing PostGIS DB
  -> read-only SELECT queries
PostGIS read-only sync worker
  -> transform + basic enrichment
Pelias-compatible documents
  -> Elasticsearch Bulk API
Elasticsearch
  -> Pelias API
```

The Pelias API queries Elasticsearch only. It does not query PostGIS at request time.

## Services

- `elasticsearch`: Pelias-compatible Elasticsearch.
- `pelias-schema`: initializes `pelias_v1`.
- `libpostal`: address parsing service for Pelias API.
- `pelias-api`: internal Pelias API used by the gateway.
- `geocoder-api`: public internal geocoder gateway on port `4000`.
- `postgis-readonly-sync-worker`: scheduled reader/indexer with `/health` and `/metrics` on internal Docker port `9090`.
- `swagger-ui`: OpenAPI UI on port `8099`.

## Current PostGIS Connection

The local `.env` is configured for the running database:

```bash
POSTGIS_HOST=map-data-pipeline-postgis-1
POSTGIS_PORT=5432
POSTGIS_DB=gis
POSTGIS_USER=pelias_readonly
POSTGIS_PASSWORD=change_me_readonly_password
POSTGIS_DOCKER_NETWORK=map-data-pipeline_map-data
```

Use a true read-only database role. The worker also forces read-only sessions with `default_transaction_read_only=on` and `BEGIN READ ONLY`, and it refuses a PostGIS connection when the session is not read-only.

## Config-Driven Sources

The sync source definitions live in `config/pelias-postgis-readonly-sync.json`.

Enabled default sources:

- `osm_pois`: named POIs from `planet_osm_point`.
- `streets`: named roads from `planet_osm_line`.
- `places`: named OSM places from `planet_osm_point`.
- `admin_boundaries`: admin polygons from `planet_osm_polygon`.

Disabled example:

- `addresses`: hstore-based address points if useful address tags are available.

Each source defines:

- `sql`: one read-only `SELECT`.
- `id_field`: stable record id.
- `geometry_field`: PostGIS geometry column from the query result.
- `layer`: Pelias layer, optionally overridden by `layer_map`.
- `name_fields`, `category_fields`, `address_fields`, `hierarchy_fields`.
- `schedule`, `batch_size`, and `delete_strategy`.

The worker wraps each source query to calculate WGS84 `_lon` and `_lat` from `ST_PointOnSurface(geometry)`.

## Example SQL Patterns

Named POIs:

```sql
SELECT osm_id, name, amenity, shop, tourism, way
FROM planet_osm_point
WHERE name IS NOT NULL
  AND (amenity IS NOT NULL OR shop IS NOT NULL OR tourism IS NOT NULL);
```

Named streets:

```sql
SELECT osm_id, name, highway, ref, way
FROM planet_osm_line
WHERE name IS NOT NULL
  AND highway IS NOT NULL;
```

Admin boundaries:

```sql
SELECT osm_id, name, boundary, admin_level, way
FROM planet_osm_polygon
WHERE boundary = 'administrative'
  AND admin_level IN ('2', '4', '6', '8', '10')
  AND name IS NOT NULL;
```

Address example using `hstore` tags:

```sql
SELECT osm_id,
       tags -> 'addr:housenumber' AS housenumber,
       tags -> 'addr:street' AS street,
       tags -> 'addr:postcode' AS postalcode,
       way
FROM planet_osm_point
WHERE tags ? 'addr:housenumber';
```

## Transform And Enrichment

The worker builds deterministic Pelias document IDs:

```text
postgis:<source_name>:<record_id>
```

It maps rows to Pelias-style documents with:

- `source`, `layer`, `source_id`.
- `name.default` and multilingual aliases from configured name fields.
- `center_point`.
- `category`.
- `address_parts`.
- `parent` hierarchy.
- `popularity` where available.
- `addendum.postgis` metadata.

Admin enrichment is world-ready and read-only:

- normalize categories and address strings;
- perform batched spatial joins against the configured `admin_boundaries` source;
- never hardcode a country or country code;
- keep the Pelias `source` field stable and add `source_config` for internal stats;
- index documents with `admin_enrichment_status = "missing_country"` when country metadata is unavailable.

PostGIS performance requirements for admin enrichment:

```sql
CREATE INDEX CONCURRENTLY IF NOT EXISTS planet_osm_polygon_way_gist
  ON planet_osm_polygon USING GIST (way);

CREATE INDEX CONCURRENTLY IF NOT EXISTS planet_osm_point_way_gist
  ON planet_osm_point USING GIST (way);

CREATE INDEX CONCURRENTLY IF NOT EXISTS planet_osm_line_way_gist
  ON planet_osm_line USING GIST (way);
```

Run those outside this project with a database owner role. The sync worker remains read-only and never creates indexes itself.

## Indexing Strategy

The worker uses Elasticsearch Bulk API with:

- deterministic document IDs;
- batch by document count and byte size;
- transient retry for `429`, `502`, `503`, and `504`;
- permanent failure logging;
- per-source metrics;
- no crash on a single bad row.

Aliases:

- `pelias`: read alias used by Pelias API.
- `pelias_write`: write alias used by the worker.
- Versioned indexes: `pelias_v1`, `pelias_v2`, ...

## Delete Handling

The MVP supports two safe read-only strategies:

- Blue/green full rebuild: `npm run reindex:all` creates the next `pelias_vN`, indexes current rows, then swaps `pelias` and `pelias_write`.
- Source-scoped replace: normal source sync stores seen IDs in local state and deletes IDs that disappeared from the latest query result.

Blue/green is safest for avoiding stale deleted documents. Source diff is reasonable for medium datasets.

## Local State

State is stored outside PostGIS in `state/sync-state.json`.

It tracks:

- last successful run per source;
- duration and counts;
- failure count and last error;
- previous seen document IDs for source-scoped delete handling;
- last index version.

For very large datasets, replace JSON state with SQLite or an Elasticsearch metadata index.

## Health And Metrics

Worker HTTP endpoints are available only inside the Docker network:

- `GET http://postgis-readonly-sync-worker:9090/health`
- `GET http://postgis-readonly-sync-worker:9090/metrics`

Metrics include:

- `sync_last_success_timestamp`
- `sync_duration_seconds`
- `sync_rows_read_total`
- `sync_docs_indexed_total`
- `sync_docs_failed_total`
- `sync_docs_deleted_total`
- `es_bulk_duration_ms`
- `postgis_query_duration_ms`
- `current_index_alias`
- `sync_last_error_timestamp`
- `schedule_status`

Alert on stale sources, unavailable Elasticsearch/PostGIS, high failure rate, or unexpected document drops.

## Commands

Start the full stack:

```bash
docker compose up -d --build
```

Run a one-shot sync from inside the worker container:

```bash
docker compose exec postgis-readonly-sync-worker npm run sync:all
docker compose exec postgis-readonly-sync-worker npm run sync:source -- osm_pois
```

Run blue/green full reindex:

```bash
docker compose exec postgis-readonly-sync-worker npm run reindex:all
```

Run source-specific replace:

```bash
docker compose exec postgis-readonly-sync-worker npm run reindex:source -- streets
```

Run worker health check:

```bash
docker compose exec postgis-readonly-sync-worker npm run health
```

Search through Pelias:

```bash
curl "http://localhost:4000/v1/search?text=Baghdad"
curl "http://localhost:4000/v1/autocomplete?text=Bagh"
```

New internal geocoder API endpoints:

```bash
curl "http://localhost:4000/v1/search/structured?street=Karrada&locality=Baghdad"
curl "http://localhost:4000/v1/nearby?point.lat=33.3152&point.lon=44.3661&radius=1000&categories=restaurant"
curl "http://localhost:4000/v1/categories"
curl "http://localhost:4000/v1/index/stats"
curl -X POST "http://localhost:4000/v1/debug/normalize" -H "Content-Type: application/json" -d "{\"text\":\"شارع الكرادة\",\"lang\":\"ar\"}"
```

Batch search:

```bash
curl -X POST "http://localhost:4000/v1/batch/search" \
  -H "Content-Type: application/json" \
  -d "{\"queries\":[{\"text\":\"Karrada Baghdad\",\"size\":10,\"layers\":\"venue,street,locality\"}]}"
```

Protected worker controls:

```bash
# From inside the Docker network only.
curl -X POST "http://postgis-readonly-sync-worker:9090/worker/sync/osm_pois" -H "Authorization: Bearer $WORKER_INTERNAL_TOKEN"
curl "http://postgis-readonly-sync-worker:9090/worker/runs" -H "Authorization: Bearer $WORKER_INTERNAL_TOKEN"
```

## Swagger

Swagger UI is available at:

```text
http://localhost:8099
```

The OpenAPI document is stored at `docs/openapi.json`. It documents the Pelias search endpoints plus the read-only sync worker health and metrics endpoints.

The gateway exposes:

- `GET /v1/search`
- `GET /v1/autocomplete`
- `GET /v1/reverse`
- `GET /v1/place`
- `POST /v1/batch/search`
- `POST /v1/batch/reverse`
- `GET /v1/search/structured`
- `GET /v1/nearby`
- `GET /v1/categories`
- `POST /v1/debug/normalize`
- `GET /v1/debug/explain`
- `GET /v1/index/stats`
- `GET /health/live`
- `GET /health/ready`
- `GET /health/dependencies`

All API errors use:

```json
{
  "error": {
    "code": "invalid_request",
    "message": "Human readable message",
    "details": {}
  }
}
```

## How Data Updates Work

The existing PostGIS database is updated outside this project by your OSM data pipeline. This Pelias stack does not write to PostGIS and does not create triggers, outbox tables, or database schema.

The update flow is:

1. The external pipeline updates PostGIS.
2. The sync worker runs each enabled source on its cron schedule.
3. The worker opens a read-only PostgreSQL session and executes the configured source `SELECT`.
4. Each row is transformed into a Pelias-compatible document.
5. Documents are written to Elasticsearch through the Bulk API using deterministic IDs like `postgis:osm_pois:123`.
6. The Pelias-compatible geocoder gateway serves user requests from Elasticsearch only.

Current source schedules:

- `osm_pois`: every 6 hours.
- `streets`: daily at 02:00.
- `places`: daily at 02:30.
- `admin_boundaries`: weekly on Sunday at 03:00.
- `addresses`: disabled in the config.

For deletes, normal sync uses source-scoped ID diffing: the worker stores the IDs seen in the previous successful run in `state/sync-state.json`; if an ID disappears from the next SELECT result, the worker deletes that document from Elasticsearch. The worker rejects cross-source delete IDs and blocks the delete diff when a source document count drops beyond the configured safety threshold. For clean full rebuilds, use blue/green reindex:

```bash
docker compose exec postgis-readonly-sync-worker npm run reindex:all
```

Worker control endpoints start runs asynchronously and store run history in `state/sync-state.json`:

- `POST /worker/sync/{source}`
- `POST /worker/reindex/{source}`
- `POST /worker/reindex-all`
- `GET /worker/runs`
- `GET /worker/runs/{run_id}`

These endpoints require `Authorization: Bearer <WORKER_INTERNAL_TOKEN>` or `x-internal-token: <WORKER_INTERNAL_TOKEN>`.

## Security Checklist

- Use a read-only PostGIS role for `POSTGIS_USER`.
- Keep PostGIS on a private Docker network.
- Do not expose PostGIS publicly.
- Do not log database passwords.
- Keep Elasticsearch internal where possible.
- Do not add admin mutation endpoints without token protection.

## Warnings

- Do not modify the existing PostGIS schema.
- Do not create triggers or outbox tables for this design.
- Do not index every `planet_osm_*` row blindly.
- Do not schedule full-planet sync every few minutes.
- Do not expect perfect real-time deletes without blue/green rebuilds or ID diffing.
- Do not query PostGIS from Pelias API at request time.

## Phased Roadmap

Phase 1:

- Run Docker Pelias stack.
- Sync named POIs, streets, places, and admin boundaries.
- Verify `/v1/search` and `/v1/autocomplete`.
- Keep PostGIS read-only.

Phase 2:

- Tune source schedules.
- Tune source-specific delete thresholds.
- Improve spatial hierarchy enrichment.

Phase 3:

- Add production hierarchy enrichment.
- Move state to SQLite or Elasticsearch metadata.
- Add Prometheus/Grafana dashboards and alerting.

## Final Recommendation

Start with scheduled selective sync and blue/green reindex for clean rebuilds. Keep PostGIS as the source of truth, filter aggressively, and only graduate to heavier enrichment once the basic Pelias search quality is proven.
