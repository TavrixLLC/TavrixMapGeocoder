-- ============================================
-- Pelias Sync: Lightweight Trigger Function
-- ============================================
-- Records only (table_name, action, record_id) — no payload.
-- The sync worker will fetch the current state from PostGIS at processing time.
-- ============================================

CREATE OR REPLACE FUNCTION pelias_outbox_notify()
RETURNS TRIGGER AS $$
DECLARE
    rec_id TEXT;
BEGIN
    -- Dynamically extract the identifier: first try 'osm_id', then 'id'.
    BEGIN
        IF TG_OP = 'DELETE' THEN
            rec_id := OLD.osm_id::text;
        ELSE
            rec_id := NEW.osm_id::text;
        END IF;
    EXCEPTION WHEN undefined_column THEN
        BEGIN
            IF TG_OP = 'DELETE' THEN
                rec_id := OLD.id::text;
            ELSE
                rec_id := NEW.id::text;
            END IF;
        EXCEPTION WHEN undefined_column THEN
            RAISE EXCEPTION 'Table % does not have a column named id or osm_id', TG_TABLE_NAME;
        END;
    END;

    INSERT INTO pelias_outbox (table_name, action, record_id, trigger_version)
    VALUES (
        TG_TABLE_NAME,
        TG_OP,
        rec_id,
        1  -- Increment when trigger logic changes
    );

    -- Wake up any listening workers immediately
    PERFORM pg_notify('pelias_outbox_event', '');

    RETURN NULL;
END;
$$ LANGUAGE plpgsql;

-- ============================================
-- USAGE: Attach this trigger to your source tables.
-- Replace 'your_table_name' with your actual table.
--
-- Example:
--   CREATE TRIGGER trg_locations_pelias
--       AFTER INSERT OR UPDATE OR DELETE ON locations
--       FOR EACH ROW EXECUTE FUNCTION pelias_outbox_notify();
--
--   CREATE TRIGGER trg_addresses_pelias
--       AFTER INSERT OR UPDATE OR DELETE ON addresses
--       FOR EACH ROW EXECUTE FUNCTION pelias_outbox_notify();
-- ============================================
