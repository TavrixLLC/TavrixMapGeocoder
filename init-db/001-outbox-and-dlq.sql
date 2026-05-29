-- ============================================
-- Pelias Sync: Outbox + Dead Letter Queue
-- ============================================

-- Event status lifecycle: pending → processing → processed → (archived/dlq)
DO $$ BEGIN
    CREATE TYPE outbox_status AS ENUM ('pending', 'processing', 'processed', 'failed');
EXCEPTION
    WHEN duplicate_object THEN NULL;
END $$;

-- Outbox: lightweight event notifications (no payload)
CREATE TABLE IF NOT EXISTS pelias_outbox (
    id              BIGSERIAL       NOT NULL,
    table_name      VARCHAR(100)    NOT NULL,
    action          VARCHAR(10)     NOT NULL,
    record_id       VARCHAR(255)    NOT NULL,
    status          outbox_status   NOT NULL DEFAULT 'pending',
    claimed_by      VARCHAR(100),
    claimed_at      TIMESTAMPTZ,
    retry_count     SMALLINT        NOT NULL DEFAULT 0,
    trigger_version SMALLINT        NOT NULL DEFAULT 1,
    last_error      TEXT,
    created_at      TIMESTAMPTZ     NOT NULL DEFAULT NOW(),
    PRIMARY KEY (id, created_at)
);

-- Index for fast claiming of pending/failed events
CREATE INDEX IF NOT EXISTS idx_outbox_claimable
    ON pelias_outbox (created_at, id)
    WHERE status IN ('pending', 'failed');

-- Aggressive autovacuum for high-churn table
ALTER TABLE pelias_outbox
    SET (
        autovacuum_vacuum_scale_factor = 0.01,
        autovacuum_analyze_scale_factor = 0.02,
        autovacuum_vacuum_cost_delay = 10
    );

-- Dead Letter Queue: permanently failed events
CREATE TABLE IF NOT EXISTS pelias_dlq (
    id                BIGSERIAL PRIMARY KEY,
    original_event_id BIGINT,
    table_name        VARCHAR(100),
    action            VARCHAR(10),
    record_id         VARCHAR(255),
    error_type        VARCHAR(20)     NOT NULL,
    error_message     TEXT,
    trigger_version   SMALLINT,
    failed_at         TIMESTAMPTZ     DEFAULT NOW(),
    replayed          BOOLEAN         DEFAULT FALSE,
    replayed_at       TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_dlq_unreplayed
    ON pelias_dlq (failed_at)
    WHERE replayed = FALSE;

-- ============================================
-- Phase 1: No partitioning (single table)
-- Phase 2: Convert to PARTITION BY RANGE (created_at)
-- ============================================
