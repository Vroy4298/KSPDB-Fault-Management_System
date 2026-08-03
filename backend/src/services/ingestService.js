'use strict';

const { pool } = require('../db/pool');
const { resolveEnergized } = require('../validation/telemetrySchema');
const { triggerForPole } = require('./localizationTrigger');

// ─── SQL templates (prepared once, reused) ───────────────────────────────────

/**
 * Insert a telemetry event.
 *
 * ON CONFLICT handling:
 *   The partial unique index on (pole_id, device_id, seq) catches duplicates.
 *   We UPDATE is_duplicate = true so the row is updated in place — this lets
 *   us RETURNING to detect whether the row was new or a dup.
 *
 * Out-of-order dedup:
 *   A `power_lost` from 6 hours ago with the same (pole_id, device_id, seq)
 *   as one we already processed will hit the conflict and be marked as a dup.
 */
const INSERT_EVENT_SQL = `
  INSERT INTO telemetry_events
    (device_id, pole_id, event, energized, ts, received_at, seq, battery_mv, rssi, fw, is_duplicate)
  VALUES ($1, $2, $3, $4, $5::timestamptz, NOW(), $6, $7, $8, $9, false)
  ON CONFLICT (pole_id, device_id, seq)
    WHERE seq IS NOT NULL AND device_id IS NOT NULL
  DO UPDATE SET is_duplicate = true
  RETURNING id, is_duplicate
`;

/**
 * Upsert pole_state with out-of-order (OOO) protection:
 *
 * Rule: skip the update if the incoming message is OLDER than what we have.
 * "Older" = same device AND smaller seq.
 *
 * Exceptions (always update):
 *   - `boot` or `power_restored` — restoration signals must never be dropped,
 *     even if seq wrapped to 0 after a reboot.
 *   - Device swap  — different device_id = new hardware on the pole.
 *   - First message — pole_state.device_id IS NULL.
 */
const UPSERT_STATE_SQL = `
  INSERT INTO pole_state
    (pole_id, energized, last_seen, last_event, last_seq, device_id, battery_mv, rssi, fw, updated_at)
  VALUES ($1, $2, NOW(), $3, $4, $5, $6, $7, $8, NOW())
  ON CONFLICT (pole_id) DO UPDATE SET
    energized  = EXCLUDED.energized,
    last_seen  = EXCLUDED.last_seen,
    last_event = EXCLUDED.last_event,
    last_seq   = EXCLUDED.last_seq,
    device_id  = EXCLUDED.device_id,
    battery_mv = EXCLUDED.battery_mv,
    rssi       = EXCLUDED.rssi,
    fw         = EXCLUDED.fw,
    updated_at = NOW()
  WHERE
    -- Restoration events always win (seq resets to 0 after boot)
    EXCLUDED.last_event IN ('boot', 'power_restored')
    -- Device swap: new hardware replaces old
    OR (pole_state.device_id IS DISTINCT FROM EXCLUDED.device_id)
    -- No prior state
    OR pole_state.device_id IS NULL
    -- Same device, newer seq
    OR (
      pole_state.device_id = EXCLUDED.device_id
      AND (pole_state.last_seq IS NULL OR pole_state.last_seq < EXCLUDED.last_seq)
    )
`;

// ─── Core processing functions ────────────────────────────────────────────────

/**
 * Process a single validated telemetry payload.
 *
 * @param {object} payload   Validated, stripped payload from Zod
 * @param {object} client    Optional pg client (for batch transactions)
 * @returns {{ status: 'processed' | 'duplicate', energized: boolean }}
 */
async function processEvent(payload, client = pool) {
  const { device_id, pole_id, event, ts, seq, battery_mv, rssi, fw } = payload;
  const energized = resolveEnergized(payload);

  // 1. Insert event record (dedup via unique index)
  const evtResult = await client.query(INSERT_EVENT_SQL, [
    device_id, pole_id, event, energized,
    ts || null, seq ?? null,
    battery_mv ?? null, rssi ?? null, fw ?? null,
  ]);

  const isDuplicate = evtResult.rows[0]?.is_duplicate ?? false;
  if (isDuplicate) {
    return { status: 'duplicate', energized };
  }

  // 2. Update pole live/dark state
  await client.query(UPSERT_STATE_SQL, [
    pole_id, energized, event, seq ?? null,
    device_id, battery_mv ?? null, rssi ?? null, fw ?? null,
  ]);

  // 3. Fire localization when pole goes dark (power_lost or watchdog already
  //    marks energized=false in pole_state).  Trigger uses per-DT debounce
  //    so rapid bursts collapse into one localization run.
  if (!energized && client === pool) {
    // Only trigger from pool (not batch tx client) to avoid nested tx issues.
    // Batch trigger is handled separately after the transaction commits.
    triggerForPole(pole_id);
  }

  return { status: 'processed', energized };
}

/**
 * Process a batch of validated payloads in a single transaction.
 * Used by the simulator and load tests for high-throughput ingestion.
 *
 * Processes all events individually (respects dedup + OOO logic per event)
 * but wraps them in one DB transaction to reduce round-trips.
 *
 * @param {object[]} payloads  Array of validated payloads
 * @returns {{ processed: number, duplicates: number }}
 */
async function processBatch(payloads) {
  let processed = 0;
  let duplicates = 0;
  const darkPoles = new Set();
  const restoredPoles = new Set();

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    for (const payload of payloads) {
      const result = await processEvent(payload, client);
      if (result.status === 'duplicate') {
        duplicates++;
      } else {
        processed++;
        if (!result.energized) darkPoles.add(payload.pole_id);
        else restoredPoles.add(payload.pole_id);
      }
    }

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }

  // After commit: fire localization for DTs with new dark poles
  for (const poleId of darkPoles) {
    triggerForPole(poleId);
  }

  // Auto-verify tickets for restored poles
  if (restoredPoles.size > 0) {
    const { autoVerifyRestoredTickets } = require('./ticketService');
    for (const poleId of restoredPoles) {
      autoVerifyRestoredTickets(poleId).catch((e) =>
        console.warn('[Batch] Auto-verify error:', e.message)
      );
    }
  }

  return { processed, duplicates };
}

/**
 * Returns current state summary for a single pole.
 * Used by tests and the health route.
 */
async function getPoleState(poleId) {
  const { rows } = await pool.query(
    'SELECT * FROM pole_state WHERE pole_id = $1',
    [poleId]
  );
  return rows[0] ?? null;
}

module.exports = { processEvent, processBatch, getPoleState };
