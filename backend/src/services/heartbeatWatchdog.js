'use strict';

const cron = require('node-cron');
const { pool } = require('../db/pool');

/**
 * Heartbeat Watchdog
 *
 * Problem this solves (02-data-and-systems.md §3):
 *   Devices running firmware 1.2.x DO NOT send `power_lost` events.
 *   When power cuts they simply go silent — the server never receives a
 *   dark-state message.  Without a watchdog these poles would remain
 *   energized=true in pole_state forever, making the fault invisible.
 *
 * Strategy:
 *   Every 2 minutes, find poles whose device has been silent for longer
 *   than HEARTBEAT_TIMEOUT_MS (default: 20 min — covers the 15-min
 *   heartbeat interval plus 45-second jitter plus ~4 minutes of buffer).
 *   Mark them energized=false, last_event='watchdog_timeout'.
 *
 *   The localization engine (Phase 3) then sees these as dark and raises
 *   a ticket.  It will flag topology_mode='inferred' and reduce confidence
 *   to LOW/MEDIUM for these cases because we cannot tell from telemetry
 *   alone whether the silence is a real outage or a dead modem/SIM.
 *
 * Caveat stored in ARCHITECTURE.md:
 *   "A watchdog-flagged pole could be a network issue, not a power issue.
 *    The localization engine checks whether its neighbours are also dark
 *    (real fault) or if it's the only dark node on an otherwise live branch
 *    (sensor failure)."
 */

const WATCHDOG_CRON = '*/2 * * * *'; // every 2 minutes

let cronTask = null;

async function runWatchdogCycle(io) {
  const timeoutMs = parseInt(process.env.HEARTBEAT_TIMEOUT_MS || '1200000', 10);

  try {
    const result = await pool.query(
      `UPDATE pole_state ps
       SET
         energized  = false,
         last_event = 'watchdog_timeout',
         updated_at = NOW()
       FROM poles p
       WHERE ps.pole_id = p.pole_id
         AND p.device_id IS NOT NULL
         AND ps.last_seen IS NOT NULL
         AND ps.last_seen < NOW() - ($1 || ' milliseconds')::INTERVAL
         AND ps.last_event IS DISTINCT FROM 'watchdog_timeout'
         AND (ps.energized = true OR ps.energized IS NULL)
       RETURNING ps.pole_id`,
      [timeoutMs]
    );

    if (result.rows.length > 0) {
      const flagged = result.rows.map((r) => r.pole_id);
      console.log(
        `[Watchdog] Flagged ${flagged.length} silent pole(s) as possibly dark:`,
        flagged.slice(0, 5).join(', ') + (flagged.length > 5 ? '...' : '')
      );

      if (io) {
        io.emit('watchdog:poles_flagged', {
          pole_ids: flagged,
          flagged_at: new Date().toISOString(),
        });
      }
    }
  } catch (err) {
    console.error('[Watchdog] Error during cycle:', err.message);
  }
}

/**
 * Start the heartbeat watchdog cron job.
 * Call once during server startup (after DB is ready).
 *
 * @param {import('socket.io').Server} io  Socket.io server instance
 */
function startWatchdog(io) {
  if (cronTask) {
    console.warn('[Watchdog] Already running — skipping duplicate start');
    return;
  }

  cronTask = cron.schedule(WATCHDOG_CRON, () => runWatchdogCycle(io), {
    scheduled: true,
    timezone: 'Asia/Kolkata',
  });

  console.log(
    `[Watchdog] Started — checking every 2 min, timeout=${process.env.HEARTBEAT_TIMEOUT_MS || 1200000}ms`
  );
}

function stopWatchdog() {
  if (cronTask) {
    cronTask.stop();
    cronTask = null;
    console.log('[Watchdog] Stopped');
  }
}

module.exports = { startWatchdog, stopWatchdog, runWatchdogCycle };
