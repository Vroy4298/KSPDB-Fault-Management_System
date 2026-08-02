-- ═══════════════════════════════════════════════════════════════
-- 001_init.sql — KSPDB Fault Management System schema
-- All statements use IF NOT EXISTS → fully idempotent on re-run.
-- ═══════════════════════════════════════════════════════════════

-- Required for gen_random_uuid()
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ─────────────────────────────────────────────────────────────
-- NETWORK TOPOLOGY
-- ─────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS feeders (
  feeder_id     VARCHAR(20) PRIMARY KEY,
  substation_id VARCHAR(20) NOT NULL,
  name          VARCHAR(60),
  created_at    TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS distribution_transformers (
  dt_id             VARCHAR(20) PRIMARY KEY,
  feeder_id         VARCHAR(20) NOT NULL REFERENCES feeders(feeder_id),
  lat               DOUBLE PRECISION NOT NULL,
  lon               DOUBLE PRECISION NOT NULL,
  capacity_kva      INTEGER,
  households_served INTEGER,
  created_at        TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS poles (
  pole_id        VARCHAR(20) PRIMARY KEY,
  lat            DOUBLE PRECISION NOT NULL,
  lon            DOUBLE PRECISION NOT NULL,
  feeder_id      VARCHAR(20) NOT NULL REFERENCES feeders(feeder_id),
  dt_id          VARCHAR(20) NOT NULL REFERENCES distribution_transformers(dt_id),
  -- seq_on_line and parent_pole_id are NULL for ~60% of DTs
  -- (the central design challenge — see ARCHITECTURE.md)
  seq_on_line    INTEGER,
  parent_pole_id VARCHAR(20),        -- self-referential, FK enforced at app level
  pole_type      VARCHAR(30) DEFAULT 'LT-9m-PCC',
  ward           VARCHAR(20),
  pincode        VARCHAR(10),        -- NULL for ~3% of poles
  device_id      VARCHAR(40),        -- NULL for ~9% of poles (no device fitted)
  fw_version     VARCHAR(10),        -- '1.4.2' = normal; '1.2.x' = silent on power loss
  created_at     TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_poles_dt_id      ON poles(dt_id);
CREATE INDEX IF NOT EXISTS idx_poles_feeder_id  ON poles(feeder_id);
CREATE INDEX IF NOT EXISTS idx_poles_device_id  ON poles(device_id) WHERE device_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_poles_coords     ON poles(lat, lon);

-- Adjacency list for the localization tree.
-- One row per pole: who is its parent?
-- parent_pole_id IS NULL  → parent is the DT itself (root pole of that line)
-- inferred = TRUE         → edge was computed by geometric MST (60% of DTs)
-- inferred = FALSE        → edge comes from the pole registry (parent_pole_id)
CREATE TABLE IF NOT EXISTS topology_edges (
  child_pole_id  VARCHAR(20) PRIMARY KEY REFERENCES poles(pole_id),
  parent_pole_id VARCHAR(20),          -- NULL = parent is DT; FK at app level
  dt_id          VARCHAR(20) NOT NULL REFERENCES distribution_transformers(dt_id),
  inferred       BOOLEAN DEFAULT FALSE,
  edge_length_m  DOUBLE PRECISION,
  created_at     TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_topology_dt     ON topology_edges(dt_id);
CREATE INDEX IF NOT EXISTS idx_topology_parent ON topology_edges(parent_pole_id);

-- ─────────────────────────────────────────────────────────────
-- TELEMETRY
-- ─────────────────────────────────────────────────────────────

-- Current live/dark state of every pole with a device.
-- Updated on every ingest event. Read by the localization engine.
CREATE TABLE IF NOT EXISTS pole_state (
  pole_id      VARCHAR(20) PRIMARY KEY REFERENCES poles(pole_id),
  energized    BOOLEAN,
  -- last_seen uses server-received timestamp (reliable), not device ts (skewed ±90s)
  last_seen    TIMESTAMPTZ,
  last_event   VARCHAR(20),   -- heartbeat | power_lost | power_restored | boot
  last_seq     INTEGER,       -- used for deduplication
  device_id    VARCHAR(40),
  battery_mv   INTEGER,
  rssi         INTEGER,
  fw           VARCHAR(10),
  updated_at   TIMESTAMPTZ DEFAULT NOW()
);

-- Raw event log — one row per unique device+seq pair.
-- Purpose: audit trail, deduplication, debugging.
CREATE TABLE IF NOT EXISTS telemetry_events (
  id           BIGSERIAL PRIMARY KEY,
  device_id    VARCHAR(40),
  pole_id      VARCHAR(20) NOT NULL,
  event        VARCHAR(20) NOT NULL
                 CHECK (event IN ('heartbeat','power_lost','power_restored','boot')),
  energized    BOOLEAN,
  ts           TIMESTAMPTZ,            -- device clock (may be skewed ±90s)
  received_at  TIMESTAMPTZ DEFAULT NOW(),  -- server wall clock (reliable for ordering)
  seq          INTEGER,
  battery_mv   INTEGER,
  rssi         INTEGER,
  fw           VARCHAR(10),
  is_duplicate BOOLEAN DEFAULT FALSE
);

-- Index for querying recent events per pole
CREATE INDEX IF NOT EXISTS idx_telemetry_pole     ON telemetry_events(pole_id, received_at DESC);
CREATE INDEX IF NOT EXISTS idx_telemetry_received ON telemetry_events(received_at DESC);

-- Deduplication: one row per (pole_id, device_id, seq).
-- A stale power_lost arriving 6 hours later will be caught here.
CREATE UNIQUE INDEX IF NOT EXISTS idx_telemetry_dedup
  ON telemetry_events(pole_id, device_id, seq)
  WHERE seq IS NOT NULL AND device_id IS NOT NULL;

-- ─────────────────────────────────────────────────────────────
-- FAULT TICKETS
-- ─────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS fault_tickets (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Classification
  fault_type           VARCHAR(10) NOT NULL
                         CHECK (fault_type IN ('span','dt','feeder')),
  status               VARCHAR(15) NOT NULL DEFAULT 'detected'
                         CHECK (status IN (
                           'detected','acknowledged','crew_assigned',
                           'resolved','verified','closed'
                         )),

  -- Fault location (span fault: both poles set; dt fault: dt_id; feeder fault: feeder_id)
  upstream_pole_id     VARCHAR(20),   -- last live pole before the break
  downstream_pole_id   VARCHAR(20),   -- first dark pole after the break
  dt_id                VARCHAR(20),
  feeder_id            VARCHAR(20),

  -- Navigation coordinates (midpoint of span, or DT/feeder location)
  fault_lat            DOUBLE PRECISION,
  fault_lon            DOUBLE PRECISION,
  pincode              VARCHAR(10),
  ward                 VARCHAR(20),

  -- Impact
  affected_poles       INTEGER DEFAULT 0,
  estimated_households INTEGER DEFAULT 0,

  -- Confidence
  -- HIGH   = known topology, clean boundary
  -- MEDIUM = inferred topology (MST), or some poles missing devices
  -- LOW    = DT-level only (cannot determine span)
  confidence           VARCHAR(6)  CHECK (confidence IN ('HIGH','MEDIUM','LOW')),
  topology_mode        VARCHAR(10) CHECK (topology_mode IN ('known','inferred','dt_level')),
  confidence_reason    TEXT,

  -- AI-generated plain-language summary (Groq / Llama)
  -- NULL if API unavailable — UI falls back to structured fields
  ai_summary           TEXT,

  -- Lifecycle timestamps
  detected_at          TIMESTAMPTZ DEFAULT NOW(),
  acknowledged_at      TIMESTAMPTZ,
  crew_assigned_at     TIMESTAMPTZ,
  resolved_at          TIMESTAMPTZ,
  verified_at          TIMESTAMPTZ,
  closed_at            TIMESTAMPTZ,

  created_at           TIMESTAMPTZ DEFAULT NOW(),
  updated_at           TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_tickets_status   ON fault_tickets(status);
CREATE INDEX IF NOT EXISTS idx_tickets_detected ON fault_tickets(detected_at DESC);
CREATE INDEX IF NOT EXISTS idx_tickets_dt       ON fault_tickets(dt_id) WHERE dt_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_tickets_feeder   ON fault_tickets(feeder_id) WHERE feeder_id IS NOT NULL;

-- Which poles are affected by each ticket
-- Used for: auto-verification (check all affected poles live), UI display
CREATE TABLE IF NOT EXISTS ticket_poles (
  ticket_id  UUID        NOT NULL REFERENCES fault_tickets(id) ON DELETE CASCADE,
  pole_id    VARCHAR(20) NOT NULL REFERENCES poles(pole_id),
  PRIMARY KEY (ticket_id, pole_id)
);

CREATE INDEX IF NOT EXISTS idx_ticket_poles_ticket ON ticket_poles(ticket_id);
CREATE INDEX IF NOT EXISTS idx_ticket_poles_pole   ON ticket_poles(pole_id);

-- ─────────────────────────────────────────────────────────────
-- SCHEDULED OUTAGES (mocked feed)
-- ─────────────────────────────────────────────────────────────

-- Caution: this feed is unreliable.
-- ~10% of outages are cancelled without the feed being updated.
-- Outages overrun by 20-40 minutes routinely.
-- The localization engine uses this as a soft signal, not a hard gate.
CREATE TABLE IF NOT EXISTS scheduled_outages (
  id         VARCHAR(30) PRIMARY KEY,
  scope      VARCHAR(10) NOT NULL CHECK (scope IN ('feeder','dt')),
  target_id  VARCHAR(20) NOT NULL,
  start_time TIMESTAMPTZ NOT NULL,
  end_time   TIMESTAMPTZ NOT NULL,
  reason     TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_outages_target ON scheduled_outages(target_id, start_time, end_time);
