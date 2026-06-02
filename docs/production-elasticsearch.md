# Production Elasticsearch Deployment

This runbook covers the P2 production Elasticsearch profile only. It does not introduce new search features or public API endpoints.

## Production Profile

Run the production stack with:

```powershell
docker compose -f docker-compose.prod.yml up -d --build
```

Check service status:

```powershell
docker compose -f docker-compose.prod.yml ps
curl http://localhost:4000/health/ready
```

The production compose file keeps Elasticsearch private to the Docker network. Only `geocoder-api` publishes port `4000` by default. The sync worker keeps port `9090` internal with `expose`.

## Required Environment

Set these before production startup:

```powershell
$env:ES_HEAP_SIZE="4g"
$env:PELIAS_INDEX_SHARDS="3"
$env:PELIAS_INDEX_REPLICAS="0"
$env:ES_EXPECTED_REPLICAS="0"
$env:PELIAS_API_PORT="4000"
$env:WORKER_INTERNAL_TOKEN="change-this"
$env:INTERNAL_TOKEN="change-this"
```

Sizing knobs:

| Variable | Purpose | Starting point |
| --- | --- | --- |
| `ES_HEAP_SIZE` | Elasticsearch JVM heap | 50% of container RAM, max 31g |
| `PELIAS_INDEX_SHARDS` | Primary shards for new generic indices | 1 for country-scale, 3-6 for regional/world-scale |
| `PELIAS_INDEX_REPLICAS` | Replica count for production resilience | 0 for single-node, 1+ for multi-node |
| `ES_EXPECTED_REPLICAS` | API readiness expectation | Match `PELIAS_INDEX_REPLICAS` |

The compose profile starts as a single-node deployment, so the default is `PELIAS_INDEX_REPLICAS=0` and `ES_EXPECTED_REPLICAS=0`. For a multi-node production cluster, set both values to `1` or higher. Otherwise yellow cluster health will intentionally degrade readiness because expected replicas are not allocated.

## Readiness Rules

`/health/ready` requires:

- Elasticsearch reachable.
- Read alias exists.
- Alias target has documents.
- Cluster health is not red.
- Cluster health is not yellow when replicas are expected.
- Worker state is fresh.
- Source document counts have not dropped abnormally.

Yellow cluster status is acceptable only when `ES_EXPECTED_REPLICAS=0`.

## Snapshot Repository

The production compose mounts a persistent snapshot repository at:

```text
/usr/share/elasticsearch/snapshots
```

Register the repository:

```powershell
docker compose -f docker-compose.prod.yml exec -T elasticsearch `
  curl -sS -X PUT http://localhost:9200/_snapshot/pelias_snapshots `
  -H "Content-Type: application/json" `
  -d "{\"type\":\"fs\",\"settings\":{\"location\":\"/usr/share/elasticsearch/snapshots\",\"compress\":true}}"
```

Verify it:

```powershell
docker compose -f docker-compose.prod.yml exec -T elasticsearch `
  curl -sS http://localhost:9200/_snapshot/pelias_snapshots?pretty
```

## Snapshot Command

Create a snapshot before reindex, alias switch, or deployment:

```powershell
$snapshot = "pelias_$(Get-Date -Format yyyyMMdd_HHmmss)"
docker compose -f docker-compose.prod.yml exec -T elasticsearch `
  curl -sS -X PUT "http://localhost:9200/_snapshot/pelias_snapshots/$snapshot?wait_for_completion=true" `
  -H "Content-Type: application/json" `
  -d "{\"indices\":\"pelias*,.tasks\",\"ignore_unavailable\":true,\"include_global_state\":false}"
```

List snapshots:

```powershell
docker compose -f docker-compose.prod.yml exec -T elasticsearch `
  curl -sS http://localhost:9200/_snapshot/pelias_snapshots/_all?pretty
```

## Restore Command

Stop writes before restore:

```powershell
docker compose -f docker-compose.prod.yml stop postgis-readonly-sync-worker
```

Restore a specific index from a snapshot:

```powershell
$snapshot = "pelias_YYYYMMDD_HHMMSS"
docker compose -f docker-compose.prod.yml exec -T elasticsearch `
  curl -sS -X POST "http://localhost:9200/_snapshot/pelias_snapshots/$snapshot/_restore" `
  -H "Content-Type: application/json" `
  -d "{\"indices\":\"pelias_v2\",\"ignore_unavailable\":false,\"include_global_state\":false}"
```

After restore, switch aliases only after validating the target index:

```powershell
docker compose -f docker-compose.prod.yml exec -T postgis-readonly-sync-worker npm run rollback:aliases -- pelias_v2
curl http://localhost:4000/health/ready
```

Restart the worker:

```powershell
docker compose -f docker-compose.prod.yml start postgis-readonly-sync-worker
```

## Index Retention

Keep at least:

- Current alias target.
- Previous alias target for rollback.
- One successful snapshot older than the current alias target.

Suggested retention:

- Keep 2-3 `pelias_v*` indices locally.
- Keep daily snapshots for 7 days.
- Keep weekly snapshots for 4 weeks.
- Delete old indices only after a successful snapshot and a passing `/health/ready`.

List versioned indices:

```powershell
docker compose -f docker-compose.prod.yml exec -T elasticsearch `
  curl -sS "http://localhost:9200/_cat/indices/pelias_v*?h=index,docs.count,store.size&s=index"
```

Delete an old version only by exact name:

```powershell
docker compose -f docker-compose.prod.yml exec -T elasticsearch `
  curl -sS -X DELETE http://localhost:9200/pelias_v1
```

Elasticsearch is configured with `action.destructive_requires_name=true` in production.

## Production Sizing Checklist

- Use dedicated persistent disk for `pelias_elasticsearch_prod_data`.
- Keep snapshot storage on separate durable storage.
- Set heap to 50% of available memory, max 31g.
- Leave enough OS page cache for Lucene segments.
- Use replicas only on multi-node clusters.
- Keep shard size roughly 20-50 GB for large world-scale indices.
- Monitor JVM pressure, disk watermarks, search p95 latency, indexing throughput, and unassigned shards.
- Run blue/green reindex during low-traffic windows.
- Snapshot before any alias switch or index deletion.
