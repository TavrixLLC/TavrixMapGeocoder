-- ============================================
-- Pelias Sync: Partition Management (Phase 2)
-- ============================================
-- This script is for future use when the Outbox table
-- is converted to a partitioned table.
--
-- Prerequisites:
--   1. The pelias_outbox table must be recreated as:
--      CREATE TABLE pelias_outbox (...) PARTITION BY RANGE (created_at);
--   2. Data from the original table must be migrated.
-- ============================================

-- Create a partition for the current week
DO $$
DECLARE
    start_date DATE := date_trunc('week', NOW());
    end_date   DATE := start_date + INTERVAL '1 week';
    part_name  TEXT := 'pelias_outbox_w' || to_char(start_date, 'IYYY_IW');
BEGIN
    EXECUTE format(
        'CREATE TABLE IF NOT EXISTS %I PARTITION OF pelias_outbox
         FOR VALUES FROM (%L) TO (%L)',
        part_name, start_date, end_date
    );
    RAISE NOTICE 'Created partition: %', part_name;
END $$;

-- Create a partition for next week (pre-creation)
DO $$
DECLARE
    start_date DATE := date_trunc('week', NOW() + INTERVAL '1 week');
    end_date   DATE := start_date + INTERVAL '1 week';
    part_name  TEXT := 'pelias_outbox_w' || to_char(start_date, 'IYYY_IW');
BEGIN
    EXECUTE format(
        'CREATE TABLE IF NOT EXISTS %I PARTITION OF pelias_outbox
         FOR VALUES FROM (%L) TO (%L)',
        part_name, start_date, end_date
    );
    RAISE NOTICE 'Created partition: %', part_name;
END $$;

-- Drop partitions older than 30 days
-- WARNING: This will permanently delete processed events.
-- Run only after verifying retention requirements.
DO $$
DECLARE
    cutoff_date DATE := date_trunc('week', NOW() - INTERVAL '30 days');
    part RECORD;
    part_start DATE;
BEGIN
    FOR part IN
        SELECT inhrelid::regclass::text AS partition_name
        FROM pg_inherits
        WHERE inhparent = 'pelias_outbox'::regclass
        ORDER BY inhrelid::regclass::text
    LOOP
        -- Extract date from partition name (format: pelias_outbox_wYYYY_WW)
        BEGIN
            part_start := to_date(
                substring(part.partition_name from 'w(\d{4}_\d{2})'),
                'IYYY_IW'
            );
            IF part_start < cutoff_date THEN
                EXECUTE format('ALTER TABLE pelias_outbox DETACH PARTITION %s', part.partition_name);
                EXECUTE format('DROP TABLE %s', part.partition_name);
                RAISE NOTICE 'Dropped partition: %', part.partition_name;
            END IF;
        EXCEPTION
            WHEN OTHERS THEN
                RAISE NOTICE 'Skipping partition %: %', part.partition_name, SQLERRM;
        END;
    END LOOP;
END $$;
