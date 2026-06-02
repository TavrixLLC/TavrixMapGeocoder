# TavrixMap Geocoder - Production Hardening Checklist

This checklist converts the architecture review into an actionable production hardening plan.

Scope:

- Production reliability
- Operational safety
- Data durability
- Deployment readiness
- Rollback readiness
- Quality validation infrastructure

Non-goals:

- No new public search endpoints
- No new relevance/search features
- No changes to the OpenAPI contract unless required for operational metadata
- No request-time PostGIS access
- No request-time routing snap calls

---

## Priority Order

1. Move sync state from JSON to SQLite or Elasticsearch metadata index.
2. Add offline routable-point snap integration.
3. Add production Elasticsearch deployment profile.
4. Add rollback command for alias switch.
5. Add country quality matrix runner.
6. Add address geocoding roadmap as a separate milestone.

---

## P0 - State Store Hardening

### Goal

Replace `state/sync-state.json` with a durable production state backend.

Current risk:

- JSON state stores `seen_ids`, source counters, run history, index version, and failures.
- For larger regional/global datasets, `seen_ids` can become too large.
- JSON file rewrites are fragile under crash/restart scenarios.
- Worker state is currently mounted as a file, which is acceptable for MVP but weak for production.

### Recommended Backend Options

Option A: SQLite

- Best near-term path.
- Simple operational model.
- Works with Docker volume.
- Supports transactions.
- No dependency on Elasticsearch for worker correctness.

Option B: Elasticsearch metadata index

- Good if the team wants all operational metadata in ES.
- Easier to inspect through ES tooling.
- Must avoid coupling sync correctness too tightly to the same cluster being reindexed.

Recommended first implementation:

```text
SQLite state backend
```

### Implementation Tasks

- [ ] Add state backend config:

```json
{
  "state": {
    "backend": "sqlite",
    "path": "/app/state/sync-state.sqlite"
  }
}
```

- [ ] Keep JSON backend available for local/dev compatibility.
- [ ] Create `StateStore` interface:
  - `load()`
  - `source(name)`
  - `previousIds(name)`
  - `markStart(name)`
  - `markSuccess(name, result, seenIds, details)`
  - `markFailure(name, err)`
  - `writeFailureSamples(name, samples)`
  - `setIndexVersion(indexName)`
  - `startRun({ source, mode })`
  - `finishRun(runId, status, result, error)`
  - `listRuns()`
  - `getRun(runId)`
- [ ] Implement `JsonStateStore` using current behavior.
- [ ] Implement `SqliteStateStore`.
- [ ] Add database schema:

```sql
CREATE TABLE sync_sources (
  source_name TEXT PRIMARY KEY,
  last_success_timestamp TEXT,
  last_started_timestamp TEXT,
  last_finished_at TEXT,
  last_duration_seconds REAL,
  last_indexed_count INTEGER NOT NULL DEFAULT 0,
  last_failed_count INTEGER NOT NULL DEFAULT 0,
  last_deleted_count INTEGER NOT NULL DEFAULT 0,
  failure_count INTEGER NOT NULL DEFAULT 0,
  last_error_json TEXT
);

CREATE TABLE source_seen_ids (
  source_name TEXT NOT NULL,
  document_id TEXT NOT NULL,
  PRIMARY KEY (source_name, document_id)
);

CREATE TABLE sync_runs (
  run_id TEXT PRIMARY KEY,
  source TEXT NOT NULL,
  mode TEXT NOT NULL,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  status TEXT NOT NULL,
  indexed_count INTEGER NOT NULL DEFAULT 0,
  deleted_count INTEGER NOT NULL DEFAULT 0,
  failed_count INTEGER NOT NULL DEFAULT 0,
  error TEXT
);

CREATE TABLE index_state (
  key TEXT PRIMARY KEY,
  value TEXT,
  updated_at TEXT NOT NULL
);
```

- [ ] Update worker startup to select backend by config/env.
- [ ] Add migration tool:

```bash
docker compose exec -T postgis-readonly-sync-worker npm run state:migrate-json-to-sqlite
```

- [ ] Ensure `markSuccess` updates seen IDs transactionally:
  - delete previous seen IDs for source
  - insert current seen IDs
  - update counters
  - commit
- [ ] Add WAL mode for SQLite:

```sql
PRAGMA journal_mode=WAL;
PRAGMA synchronous=NORMAL;
```

- [ ] Mount SQLite path on persistent volume.
- [ ] Keep failed sample JSONL as append-only file or move it into SQLite table later.

### Tests

- [ ] Existing state-store tests pass for JSON backend.
- [ ] New SQLite backend tests:
  - create schema on first start
  - source state roundtrip
  - previous IDs roundtrip
  - markSuccess transaction writes counters and seen IDs
  - markFailure persists error details
  - run history persists
  - migration from JSON preserves source counts and seen IDs
- [ ] Sync service tests run against SQLite backend.
- [ ] Crash-safety test:
  - simulate failure during markSuccess
  - verify previous committed state remains valid

### Acceptance Criteria

- [ ] Worker can run full sync using SQLite state.
- [ ] `last_indexed_count`, `last_deleted_count`, `last_failed_count` remain correct.
- [ ] Source diff delete handling still works.
- [ ] `/v1/index/stats` still reads source freshness correctly.
- [ ] `/health/ready` still reports stale sources and source count drops.
- [ ] JSON backend remains usable for local fallback.

---

## P1 - Offline Routable-Point Snap Integration

### Goal

Replace centroid fallback routable points with offline snapped routable points where possible.

Current behavior:

- `routable_point` falls back to `center_point`.
- This is good enough for MVP but can produce poor routing starts for POIs inside large polygons, malls, campuses, parks, or admin polygons.

Constraint:

- Snapping must happen offline during indexing.
- Public search endpoints must not call Valhalla or routing snap APIs at request time.

### Design

Add an optional worker-side routable-point enrichment step:

```text
PostGIS row -> domain doc -> admin enrichment -> routing snap enrichment -> ES document
```

Supported modes:

| Mode | Behavior |
|---|---|
| `disabled` | Current fallback to center point |
| `valhalla_snap_api` | Worker calls internal Valhalla locate/snap endpoint during indexing |
| `postgis_nearest_road` | Worker uses read-only PostGIS nearest routable road query |
| `precomputed` | Worker reads routable point fields from source query |

Recommended initial mode:

```text
postgis_nearest_road
```

Reason:

- Preserves read-only PostGIS design.
- Avoids dependency on Valhalla availability during indexing.
- Can use GiST/KNN indexes if source roads are indexed.

### Config

Add worker config:

```json
{
  "routable_point_enrichment": {
    "enabled": true,
    "mode": "postgis_nearest_road",
    "roads_source": "streets",
    "max_snap_distance_meters": 100,
    "batch_size": 500,
    "fallback_to_center": true
  }
}
```

### Implementation Tasks

- [ ] Add `sync-worker/src/routable-point-lookup.js`.
- [ ] Add config validation for `routable_point_enrichment`.
- [ ] Add batch snap function:
  - input: docs with lon/lat
  - output: `routable_point`, `routable_point_type`, `routable_point_source`
- [ ] Use read-only SQL only.
- [ ] Prefer batch query, not one query per document.
- [ ] Mark fallback reason:

```json
{
  "routable_point_type": "centroid_fallback",
  "routable_point_source": "center_point",
  "routable_point_status": "snap_not_found"
}
```

- [ ] Extend mappings for:
  - `routable_point_status`
  - `routable_point_distance_meters`
- [ ] Keep response shape backward compatible.
- [ ] Add stats aggregation for routable point status if needed internally.

### Candidate PostGIS Pattern

Use batch points and nearest named/routable road lines:

```sql
WITH input(doc_key, lon, lat) AS (
  VALUES ...
),
points AS (
  SELECT doc_key, ST_SetSRID(ST_Point(lon, lat), 4326) AS geom
  FROM input
),
roads AS (
  SELECT osm_id, way
  FROM planet_osm_line
  WHERE highway IN (
    'motorway', 'trunk', 'primary', 'secondary', 'tertiary',
    'unclassified', 'residential', 'service', 'living_street'
  )
)
SELECT DISTINCT ON (p.doc_key)
  p.doc_key,
  ST_X(ST_Transform(ST_ClosestPoint(r.way, ST_Transform(p.geom, ST_SRID(r.way))), 4326)) AS lon,
  ST_Y(ST_Transform(ST_ClosestPoint(r.way, ST_Transform(p.geom, ST_SRID(r.way))), 4326)) AS lat,
  ST_Distance(
    ST_Transform(p.geom, 3857),
    ST_Transform(ST_ClosestPoint(r.way, ST_Transform(p.geom, ST_SRID(r.way))), 3857)
  ) AS distance_meters
FROM points p
JOIN roads r
  ON ST_DWithin(
    ST_Transform(p.geom, ST_SRID(r.way)),
    r.way,
    <max_distance_in_source_units>
  )
ORDER BY p.doc_key, distance_meters ASC;
```

The exact SQL must be adjusted to the SRID and schema details.

### Required Indexes

```sql
CREATE INDEX CONCURRENTLY IF NOT EXISTS planet_osm_line_way_gist
  ON planet_osm_line USING GIST (way);
```

### Tests

- [ ] Unit test SQL builder rejects unsafe modes.
- [ ] Batch snap returns nearest road point.
- [ ] If no road within threshold, fallback to center.
- [ ] Worker indexes `routable_point` from snap result.
- [ ] API response still returns `routable_point`.
- [ ] Routing integration test uses top result routable point and verifies route succeeds when Valhalla is configured.

### Acceptance Criteria

- [ ] No request-time routing calls.
- [ ] No PostGIS writes.
- [ ] Majority of venue docs receive snapped routable points where roads are available.
- [ ] Documents without a snap are still indexed with fallback status.
- [ ] Routing test passes in an environment with Valhalla.

---

## P2 - Production Elasticsearch Deployment Profile

### Goal

Add a production deployment profile for Elasticsearch and related services.

Current local compose:

- single-node Elasticsearch
- `1g` heap
- `number_of_replicas=0`
- host ports exposed for local development

This is not production-ready.

### Implementation Tasks

- [ ] Add `docker-compose.prod.yml` or deployment docs for production.
- [ ] Do not expose Elasticsearch host ports by default.
- [ ] Add production env variables:

```text
ES_JAVA_OPTS=-Xms8g -Xmx8g
ELASTICSEARCH_NUMBER_OF_REPLICAS=1
ELASTICSEARCH_NUMBER_OF_SHARDS=<based_on_dataset_size>
```

- [ ] Add persistent named volumes or external disks.
- [ ] Add snapshot repository configuration.
- [ ] Add index lifecycle guidance:
  - keep current index
  - keep previous index for rollback
  - clean older indexes after snapshot
- [ ] Add cluster health readiness check:
  - fail on red
  - warn/degrade on yellow if replicas expected
- [ ] Add ES memory/disk alert thresholds.
- [ ] Add deployment recommendation for managed Elasticsearch/OpenSearch if preferred.

### Production Sizing Checklist

- [ ] Estimate docs per country/region.
- [ ] Estimate full-world docs.
- [ ] Measure index size after full reindex.
- [ ] Set shard count based on target shard size.
- [ ] Configure replicas based on HA requirement.
- [ ] Validate p95 under target after warmup.
- [ ] Validate reindex throughput.
- [ ] Validate snapshot/restore.

### Tests / Validation

- [ ] Compose config test verifies worker port is not publicly exposed.
- [ ] Compose config test verifies API has no PostGIS network.
- [ ] ES readiness test fails on missing alias.
- [ ] ES readiness test fails on empty index.
- [ ] Reindex validation passes on production profile.

### Acceptance Criteria

- [ ] Production compose/profile does not expose Elasticsearch publicly.
- [ ] Elasticsearch storage is persistent.
- [ ] Snapshot/restore runbook exists.
- [ ] p95 search remains within configured threshold after production-sized data load.
- [ ] Blue/green reindex works on production profile.

---

## P3 - Alias Rollback Command

### Goal

Add a safe rollback command for Elasticsearch alias switches.

Current behavior:

- Blue/green reindex creates a new `pelias_vN`.
- Validates target.
- Switches `pelias` and `pelias_write` aliases to new index.
- Old index remains available.

Missing hardening:

- No explicit rollback command.

### Implementation Tasks

- [ ] Store alias switch history in state backend:

```json
{
  "previous_read_index": "pelias_v2",
  "current_read_index": "pelias_v3",
  "switched_at": "..."
}
```

- [ ] Add worker command:

```bash
npm run rollback:aliases
```

- [ ] Add optional explicit target:

```bash
npm run rollback:aliases -- pelias_v2
```

- [ ] Add `IndexManager.rollbackAliases(targetIndex)`.
- [ ] Safety checks before rollback:
  - target index exists
  - target index has documents
  - sample search returns hits
  - target is not already current
- [ ] Switch both aliases atomically:
  - `pelias`
  - `pelias_write`
- [ ] Record rollback run in state.
- [ ] Log rollback event with previous/current aliases.

### Tests

- [ ] Rollback refuses missing target.
- [ ] Rollback refuses empty target.
- [ ] Rollback switches read/write aliases atomically.
- [ ] Rollback records state.
- [ ] Rollback command works after blue/green reindex test.

### Acceptance Criteria

- [ ] Operator can rollback with one command.
- [ ] Rollback never switches to an empty index.
- [ ] Rollback state is visible in worker run history.
- [ ] Old index retention policy keeps at least one rollback target.

---

## P4 - Country Quality Matrix Runner

### Goal

Add a production quality validation runner that measures current behavior by country/city/category without adding new search features.

Purpose:

- Prove country readiness.
- Detect regressions.
- Identify data gaps.
- Keep quality improvements inside latency budget.

This is validation infrastructure only.

### Config Format

Add:

```text
config/quality-matrix.json
```

Example:

```json
{
  "version": 1,
  "countries": [
    {
      "country_a": "IQ",
      "cities": [
        { "name": "Baghdad", "lat": 33.3152, "lon": 44.3661 },
        { "name": "Basra", "lat": 30.5085, "lon": 47.7804 },
        { "name": "Erbil", "lat": 36.1911, "lon": 44.0094 }
      ],
      "queries": [
        "restaurant",
        "مطعم",
        "pharmacy",
        "صيدلية",
        "cafe",
        "مقهى",
        "hospital",
        "مستشفى",
        "hotel",
        "فندق",
        "fuel",
        "محطة بنزين"
      ]
    }
  ],
  "thresholds": {
    "min_results_per_query": 1,
    "max_p95_ms": 250,
    "max_missing_country_a_ratio": 0.02
  }
}
```

### Runner Behavior

- [ ] Read matrix config.
- [ ] For each country/city/query:
  - call `/v1/search`
  - include `boundary.country`
  - include focus point when city has coordinates
  - record result count
  - record top result country/locality
  - record latency
- [ ] Optionally test autocomplete for same query set.
- [ ] Pull `/v1/index/stats`.
- [ ] Report:
  - pass/fail by query
  - p50/p95/p99 by country
  - zero-result gaps
  - country filter failures
  - missing `country_a` ratio
  - top-result locality mismatch samples
- [ ] Produce machine-readable JSON report:

```text
reports/quality-matrix-<timestamp>.json
```

- [ ] Produce concise Markdown summary:

```text
reports/quality-matrix-<timestamp>.md
```

### Commands

Add script:

```bash
cd geocoder-api
npm run test:quality-matrix
```

Optional strict mode:

```bash
COUNTRY_QUALITY_STRICT=1 npm run test:quality-matrix
```

### Tests

- [ ] Runner handles zero-result query.
- [ ] Runner fails strict mode on zero results.
- [ ] Runner reports p95.
- [ ] Runner fails when p95 exceeds threshold.
- [ ] Runner reports country filter mismatch.
- [ ] Runner writes JSON and Markdown reports.

### Acceptance Criteria

- [ ] Matrix runner exists and is documented.
- [ ] Iraq matrix passes with current dataset.
- [ ] Adding a new country requires config only.
- [ ] Runner does not add or change search behavior.
- [ ] Runner fails if latency budget is exceeded.

---

## P5 - Address Geocoding Roadmap Milestone

### Goal

Define address geocoding as a separate milestone so production hardening does not blur into new search feature work.

Current status:

- `addresses` source exists but is disabled.
- Public endpoints already include structured search capability.
- High-quality address geocoding is not production-complete.

### Milestone Scope

This milestone should be planned separately from hardening.

It may include:

- enabling address source when source data is trustworthy
- housenumber extraction
- street association
- postcode support
- address interpolation, if needed
- country-specific address normalization
- structured search confidence scoring
- address QA matrix

### Required Inputs

- [ ] Decide address data source:
  - OSM point addresses
  - external national address dataset
  - imported building centroids
  - interpolated street ranges
- [ ] Define target countries.
- [ ] Define minimum acceptance quality per country.
- [ ] Define address-specific OpenAPI behavior if response fields change.
- [ ] Define privacy/legal constraints for address sources.

### Proposed Roadmap

Phase A: Discovery

- [ ] Audit available address tags in PostGIS.
- [ ] Count address rows by country/region.
- [ ] Measure missing street/housenumber/postcode ratio.
- [ ] Identify duplicate address records.

Phase B: Indexing MVP

- [ ] Enable address source for one country/region.
- [ ] Add strict SQL filters.
- [ ] Add admin enrichment.
- [ ] Add source count sanity thresholds.
- [ ] Add address-specific tests.

Phase C: Quality

- [ ] Add structured address matrix.
- [ ] Test exact housenumber/street/locality queries.
- [ ] Test Arabic/Kurdish/Latin variants.
- [ ] Test reverse geocoding near address points.

Phase D: Production

- [ ] Add monitoring for address source freshness.
- [ ] Add rollback/reindex runbook.
- [ ] Validate p95 under production load.

### Acceptance Criteria For Starting Address Work

- [ ] P0 state hardening complete.
- [ ] P2 production ES profile complete.
- [ ] Country quality matrix runner available.
- [ ] Clear source dataset selected.
- [ ] Address work tracked as separate milestone/epic.

---

## Cross-Cutting Production Controls

### No New Search Features Guard

For all hardening work:

- [ ] Do not add public endpoints unless required for operations.
- [ ] Do not alter ranking behavior as part of hardening tasks.
- [ ] Do not add new query expansion behavior.
- [ ] Do not change OpenAPI search contract.
- [ ] Keep all new scripts operational/test tooling only.

### Performance Guard

- [ ] Run quality gate before merging:

```bash
cd geocoder-api
npm run test:quality-gate
```

- [ ] Reject changes if:
  - search p95 exceeds `SEARCH_P95_LIMIT_MS`
  - autocomplete p95 exceeds `AUTOCOMPLETE_P95_LIMIT_MS`
  - failures are non-zero under load test

### Security Guard

- [ ] API service still has no PostGIS dependency.
- [ ] API service still has no PostGIS Docker network.
- [ ] Worker port `9090` remains internal only.
- [ ] Worker control endpoints require token.
- [ ] Debug explain remains protected.
- [ ] Elasticsearch is not publicly exposed in production profile.

### Data Safety Guard

- [ ] Source SQL remains SELECT-only.
- [ ] Worker uses read-only transactions.
- [ ] Source diff deletes remain source-scoped.
- [ ] Source count drop detection remains enabled.
- [ ] Blue/green reindex validation remains enabled.
- [ ] Rollback target must be non-empty.

---

## Suggested Execution Plan

### Sprint 1

- [ ] Implement SQLite state backend.
- [ ] Add JSON-to-SQLite migration command.
- [ ] Update tests for state backend.
- [ ] Validate source diff deletes with SQLite.

### Sprint 2

- [ ] Add alias rollback command.
- [ ] Add production Elasticsearch profile.
- [ ] Add snapshot/restore and index retention runbooks.

### Sprint 3

- [ ] Add offline routable-point snap integration.
- [ ] Add snap status stats.
- [ ] Run routing integration test in environment with Valhalla.

### Sprint 4

- [ ] Add country quality matrix runner.
- [ ] Add reports output.
- [ ] Add CI/manual quality gate profile.

### Separate Milestone

- [ ] Address geocoding roadmap discovery.
- [ ] Address source audit.
- [ ] Address MVP planning.

---

## Definition of Production-Ready

The geocoder can be considered production-hardened when:

- [ ] State backend is transactional and durable.
- [ ] Worker can recover safely after restart/crash.
- [ ] Blue/green reindex has validated rollback.
- [ ] Elasticsearch production profile is documented and tested.
- [ ] API remains PostGIS-isolated.
- [ ] Worker remains read-only against PostGIS.
- [ ] Worker controls are internal and token-protected.
- [ ] Routable points are snapped offline or explicitly marked as fallback.
- [ ] Country quality matrix runner exists and passes for launch countries.
- [ ] Performance quality gate passes under target load.
- [ ] Address geocoding is tracked separately and not mixed into hardening work.

