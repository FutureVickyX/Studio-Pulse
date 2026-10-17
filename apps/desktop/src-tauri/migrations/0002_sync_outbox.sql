-- Studio Pulse local database, schema version 2 (Phase 2A): sync outbox bookkeeping.
-- Strictly additive: existing rows and columns are untouched, so all Phase 1 history survives.
--
-- tracking_events already has user_id (NULL until an account owns the row) and
-- sync_status ('pending' | 'synced' | 'failed'). This adds where and when a row was uploaded and
-- why the last attempt did not succeed.

ALTER TABLE tracking_events ADD COLUMN workspace_id TEXT;           -- set when uploaded
ALTER TABLE tracking_events ADD COLUMN synced_at_ms INTEGER;        -- server-confirmed upload time
ALTER TABLE tracking_events ADD COLUMN sync_attempts INTEGER NOT NULL DEFAULT 0;
ALTER TABLE tracking_events ADD COLUMN last_sync_error TEXT;        -- short reason, no secrets

-- The outbox query: closed, pending rows of one user, oldest first.
CREATE INDEX tracking_events_outbox_by_user
    ON tracking_events (user_id, sync_status, started_at_ms)
    WHERE state = 'closed';
