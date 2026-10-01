-- ATLAS core schema. All timestamps are naive UTC. JSON columns are VARCHAR holding
-- UTF-8 JSON so the schema ports cleanly to PostgreSQL (jsonb) if a deployment outgrows
-- the embedded engine.
--
-- Indexing policy: DuckDB filters with per-row-group min/max zone maps, which are fast at
-- ATLAS's scale. ART indexes are kept only where a PRIMARY KEY is semantically required,
-- and never on high-churn tables (fire detections/clusters are rewritten every run).

CREATE TABLE IF NOT EXISTS observations (
    id                 VARCHAR PRIMARY KEY,       -- "<source>:<external_id>"
    source             VARCHAR NOT NULL,
    external_id        VARCHAR NOT NULL,
    hazard             VARCHAR NOT NULL,
    title              VARCHAR NOT NULL,
    lat                DOUBLE,
    lon                DOUBLE,
    depth_km           DOUBLE,
    magnitude          DOUBLE,
    magnitude_unit     VARCHAR,
    alert_level        VARCHAR,
    status             VARCHAR,
    event_time         TIMESTAMP NOT NULL,
    end_time           TIMESTAMP,
    source_updated_at  TIMESTAMP,
    first_seen_at      TIMESTAMP NOT NULL,
    last_seen_at       TIMESTAMP NOT NULL,
    url                VARCHAR,
    country_iso3       VARCHAR,
    description        VARCHAR,
    metrics            VARCHAR,
    geometry           VARCHAR,
    track              VARCHAR,
    external_refs      VARCHAR,
    names              VARCHAR,
    content_hash       VARCHAR NOT NULL,
    version            INTEGER NOT NULL,
    incident_id        VARCHAR,
    incident_candidate BOOLEAN NOT NULL DEFAULT TRUE,
    retracted          BOOLEAN NOT NULL DEFAULT FALSE
);

-- Append-only history: every material revision of an observation. Powers the audit
-- trail and the "what was known at time T" Data Time Machine.
CREATE TABLE IF NOT EXISTS observation_versions (
    observation_id     VARCHAR NOT NULL,
    version            INTEGER NOT NULL,
    recorded_at        TIMESTAMP NOT NULL,
    source_updated_at  TIMESTAMP,
    lat                DOUBLE,
    lon                DOUBLE,
    depth_km           DOUBLE,
    magnitude          DOUBLE,
    alert_level        VARCHAR,
    status             VARCHAR,
    metrics            VARCHAR,
    content_hash       VARCHAR NOT NULL,
    PRIMARY KEY (observation_id, version)
);

CREATE TABLE IF NOT EXISTS incidents (
    id                   VARCHAR PRIMARY KEY,
    hazard               VARCHAR NOT NULL,
    title                VARCHAR NOT NULL,
    status               VARCHAR NOT NULL,
    lat                  DOUBLE,
    lon                  DOUBLE,
    bbox                 VARCHAR,
    geometry             VARCHAR,
    started_at           TIMESTAMP NOT NULL,
    ended_at             TIMESTAMP,
    created_at           TIMESTAMP NOT NULL,
    updated_at           TIMESTAMP NOT NULL,
    last_observation_at  TIMESTAMP NOT NULL,
    severity_level       INTEGER NOT NULL,
    severity             VARCHAR NOT NULL,
    confidence           VARCHAR NOT NULL,
    headline             VARCHAR NOT NULL,
    country_iso3         VARCHAR,
    country_name         VARCHAR,
    place                VARCHAR,
    source_count         INTEGER NOT NULL,
    sources              VARCHAR NOT NULL,
    primary_observation  VARCHAR NOT NULL,
    revision             INTEGER NOT NULL DEFAULT 1
);

CREATE SEQUENCE IF NOT EXISTS change_seq START 1;
CREATE TABLE IF NOT EXISTS incident_changes (
    id              BIGINT PRIMARY KEY DEFAULT nextval('change_seq'),
    incident_id     VARCHAR NOT NULL,
    changed_at      TIMESTAMP NOT NULL,
    kind            VARCHAR NOT NULL,
    field           VARCHAR,
    old_value       VARCHAR,
    new_value       VARCHAR,
    source          VARCHAR,
    observation_id  VARCHAR,
    summary         VARCHAR NOT NULL,
    significance    INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS fire_detections (
    key            VARCHAR NOT NULL,           -- dedupe key; uniqueness enforced by anti-join on load
    lat            DOUBLE NOT NULL,
    lon            DOUBLE NOT NULL,
    acq_time       TIMESTAMP NOT NULL,
    satellite      VARCHAR NOT NULL,
    instrument     VARCHAR NOT NULL,
    confidence     VARCHAR NOT NULL,     -- low | nominal | high (normalised)
    confidence_raw VARCHAR,
    brightness     DOUBLE,
    brightness2    DOUBLE,
    frp            DOUBLE,
    daynight       VARCHAR,
    scan           DOUBLE,
    track          DOUBLE,
    h3_r7          UBIGINT NOT NULL,
    h3_r9          UBIGINT NOT NULL,
    product        VARCHAR NOT NULL,
    ingested_at    TIMESTAMP NOT NULL
);

-- Significant fire clusters (ATLAS-derived). Cells are kept so a cluster keeps its
-- identity between runs as it grows, shrinks, merges or splits.
CREATE TABLE IF NOT EXISTS fire_clusters (
    id                VARCHAR NOT NULL,
    lat               DOUBLE NOT NULL,
    lon               DOUBLE NOT NULL,
    bbox              VARCHAR NOT NULL,
    hull              VARCHAR,
    detections        INTEGER NOT NULL,
    footprint_km2     DOUBLE NOT NULL,
    frp_total         DOUBLE,
    frp_max           DOUBLE,
    high_confidence   INTEGER NOT NULL,
    day_detections    INTEGER NOT NULL,
    first_seen        TIMESTAMP NOT NULL,
    last_seen         TIMESTAMP NOT NULL,
    recent_12h        INTEGER NOT NULL,
    prior_12h         INTEGER NOT NULL,
    instruments       VARCHAR NOT NULL,
    static_suspect    BOOLEAN NOT NULL,
    computed_at       TIMESTAMP NOT NULL
);
CREATE TABLE IF NOT EXISTS fire_cluster_cells (
    cluster_id VARCHAR NOT NULL,
    cell       UBIGINT NOT NULL
);

-- Index of upstream identifiers for exact cross-source linking (USGS id inside GDACS,
-- GLIDE numbers, NHC storm ids...).
CREATE TABLE IF NOT EXISTS external_refs (
    scheme          VARCHAR NOT NULL,
    ref             VARCHAR NOT NULL,
    observation_id  VARCHAR NOT NULL,
    PRIMARY KEY (scheme, ref, observation_id)
);

CREATE SEQUENCE IF NOT EXISTS sync_seq START 1;
CREATE TABLE IF NOT EXISTS sync_runs (
    id                BIGINT PRIMARY KEY DEFAULT nextval('sync_seq'),
    source            VARCHAR NOT NULL,
    started_at        TIMESTAMP NOT NULL,
    finished_at       TIMESTAMP,
    status            VARCHAR NOT NULL,     -- ok | degraded | error | skipped
    records_received  INTEGER NOT NULL DEFAULT 0,
    records_accepted  INTEGER NOT NULL DEFAULT 0,
    records_rejected  INTEGER NOT NULL DEFAULT 0,
    records_changed   INTEGER NOT NULL DEFAULT 0,
    bytes             BIGINT NOT NULL DEFAULT 0,
    latency_ms        DOUBLE,
    from_cache        BOOLEAN NOT NULL DEFAULT FALSE,
    stale             BOOLEAN NOT NULL DEFAULT FALSE,
    snapshot          BOOLEAN NOT NULL DEFAULT FALSE,   -- payload was a complete snapshot of current events
    data_time         TIMESTAMP,            -- newest timestamp contained in the payload
    message           VARCHAR
);
