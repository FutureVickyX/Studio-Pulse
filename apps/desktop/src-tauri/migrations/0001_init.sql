-- Studio Pulse local database, schema version 1.
-- Embedded at compile time and applied by store::migrate() inside one transaction.
-- All instants are UTC epoch milliseconds. See docs/architecture.md §6.

CREATE TABLE meta (
    key   TEXT PRIMARY KEY NOT NULL,
    value TEXT NOT NULL
) STRICT;

-- One JSON document per key; currently only 'settings'. Validated by the Rust settings module.
CREATE TABLE preferences (
    key           TEXT PRIMARY KEY NOT NULL,
    value_json    TEXT NOT NULL CHECK (json_valid(value_json)),
    updated_at_ms INTEGER NOT NULL
) STRICT;

CREATE TABLE applications (
    id                 TEXT PRIMARY KEY NOT NULL
                       CHECK (length(id) BETWEEN 2 AND 64 AND id NOT GLOB '*[^a-z0-9-]*'),
    display_name       TEXT NOT NULL CHECK (length(trim(display_name)) BETWEEN 1 AND 80),
    category           TEXT NOT NULL
                       CHECK (category IN ('design','motion','video','3d','photo','audio','publishing','code','other')),
    matchers_json      TEXT NOT NULL CHECK (json_valid(matchers_json) AND json_type(matchers_json) = 'array'),
    enabled            INTEGER NOT NULL CHECK (enabled IN (0, 1)),
    include_in_reports INTEGER NOT NULL CHECK (include_in_reports IN (0, 1)),
    built_in           INTEGER NOT NULL CHECK (built_in IN (0, 1)),
    sort_order         INTEGER NOT NULL DEFAULT 0,
    created_at_ms      INTEGER NOT NULL,
    updated_at_ms      INTEGER NOT NULL
) STRICT;

CREATE TABLE tracking_events (
    id               TEXT PRIMARY KEY NOT NULL,          -- UUIDv7, stable idempotency key
    device_id        TEXT NOT NULL,
    user_id          TEXT,                               -- NULL until Phase 2 sign-in
    application_id   TEXT NOT NULL,                      -- no FK: history survives app deletion
    application_name TEXT NOT NULL,                      -- display-name snapshot
    kind             TEXT NOT NULL CHECK (kind IN ('active', 'idle')),
    started_at_ms    INTEGER NOT NULL,
    ended_at_ms      INTEGER NOT NULL,
    active_ms        INTEGER NOT NULL CHECK (active_ms >= 0),
    idle_ms          INTEGER NOT NULL CHECK (idle_ms >= 0),
    state            TEXT NOT NULL CHECK (state IN ('open', 'closed')),
    end_reason       TEXT CHECK (end_reason IS NULL OR end_reason IN (
                         'appSwitch','becameIdle','inputResumed','untracked','sessionAway','paused',
                         'disabled','timeGap','clockChange','shutdown','recovered','settingsChanged')),
    project_id       TEXT,
    task_id          TEXT,
    source           TEXT NOT NULL DEFAULT 'automatic' CHECK (source IN ('automatic', 'manual')),
    sync_status      TEXT NOT NULL DEFAULT 'pending' CHECK (sync_status IN ('pending', 'synced', 'failed')),
    revision         INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),
    created_at_ms    INTEGER NOT NULL,
    updated_at_ms    INTEGER NOT NULL,

    CHECK (ended_at_ms >= started_at_ms),
    CHECK (active_ms + idle_ms = ended_at_ms - started_at_ms),
    CHECK (kind <> 'active' OR idle_ms = 0),
    CHECK (kind <> 'idle' OR active_ms = 0),
    CHECK ((state = 'open') = (end_reason IS NULL))
) STRICT;

-- Invariant: at most one interval is being recorded per device at any time.
CREATE UNIQUE INDEX tracking_events_one_open_per_device
    ON tracking_events (device_id) WHERE state = 'open';

CREATE INDEX tracking_events_started_at ON tracking_events (started_at_ms);
CREATE INDEX tracking_events_ended_at ON tracking_events (ended_at_ms);
CREATE INDEX tracking_events_app_started ON tracking_events (application_id, started_at_ms);
CREATE INDEX tracking_events_sync_outbox ON tracking_events (sync_status) WHERE state = 'closed';
