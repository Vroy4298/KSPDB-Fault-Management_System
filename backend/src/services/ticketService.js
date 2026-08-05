'use strict';

/**
 * ticketService.js — Fault Ticket Lifecycle Manager
 *
 * Lifecycle states (spec §03-deliverables):
 *   detected → acknowledged → crew_assigned → resolved → verified → closed
 *
 * Key behaviours:
 *  - Idempotency: only one active ticket per fault location (upstream+downstream poles)
 *  - Reject resolution if affected poles are still dark (auto-reopen guard)
 *  - Auto-verify when ALL affected poles send power_restored / heartbeat
 *  - Scheduled outage suppression (ticket still created, but flagged)
 *  - AI summary generated async via Groq (stub here, called from aiService.js)
 */

const { pool } = require('../db/pool');

/** Check if there is already an active (non-closed) ticket for this fault location. */
async function findExistingTicket(upstreamPoleId, downstreamPoleId, dtId) {
  let query, params;

  if (upstreamPoleId && downstreamPoleId) {
    query = `
      SELECT id, status FROM fault_tickets
      WHERE upstream_pole_id = $1
        AND downstream_pole_id = $2
        AND status NOT IN ('verified', 'closed')
      LIMIT 1
    `;
    params = [upstreamPoleId, downstreamPoleId];
  } else if (dtId) {
    query = `
      SELECT id, status FROM fault_tickets
      WHERE dt_id = $1
        AND fault_type = 'dt'
        AND status NOT IN ('verified', 'closed')
      LIMIT 1
    `;
    params = [dtId];
  } else {
    return null;
  }

  const { rows } = await pool.query(query, params);
  return rows[0] || null;
}

/** Find active feeder-level ticket. */
async function findExistingFeederTicket(feederId) {
  const { rows } = await pool.query(
    `SELECT id, status FROM fault_tickets
     WHERE feeder_id = $1
       AND fault_type = 'feeder'
       AND status NOT IN ('verified', 'closed')
     LIMIT 1`,
    [feederId]
  );
  return rows[0] || null;
}

/**
 * Create a new fault ticket from a localization fault descriptor.
 * Idempotent: returns existing ticket ID if one already exists for this location.
 *
 * @param {object} fault  Output from localization engine
 * @param {function} [aiSummarize]  Optional async fn(fault) → string
 * @param {object}  [io]  Socket.io server for real-time broadcast
 * @returns {{ ticket_id: string, created: boolean }}
 */
async function createTicket(fault, aiSummarize = null, io = null) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    let existing = null;
    if (fault.fault_type === 'feeder') {
      existing = await findExistingFeederTicket(fault.feeder_id);
    } else {
      existing = await findExistingTicket(
        fault.upstream_pole_id,
        fault.downstream_pole_id,
        fault.dt_id
      );
    }

    if (existing) {
      await client.query('ROLLBACK');
      return { ticket_id: existing.id, created: false };
    }

    const scheduledNote = fault.scheduled_outage
      ? `Scheduled outage SO-${fault.scheduled_outage.id} may explain this fault.`
      : null;

    const { rows: ticketRows } = await client.query(
      `INSERT INTO fault_tickets (
        fault_type, status,
        upstream_pole_id, downstream_pole_id, dt_id, feeder_id,
        fault_lat, fault_lon, pincode, ward,
        affected_poles, estimated_households,
        confidence, topology_mode, confidence_reason,
        detected_at, created_at, updated_at
      ) VALUES (
        $1, 'detected',
        $2, $3, $4, $5,
        $6, $7, $8, $9,
        $10, $11,
        $12, $13, $14,
        NOW(), NOW(), NOW()
      ) RETURNING id`,
      [
        fault.fault_type,
        fault.upstream_pole_id || null,
        fault.downstream_pole_id || null,
        fault.dt_id || null,
        fault.feeder_id || null,
        fault.fault_lat,
        fault.fault_lon,
        fault.pincode || null,
        fault.ward || null,
        fault.affected_poles,
        fault.estimated_households,
        fault.confidence,
        fault.topology_mode,
        fault.confidence_reason + (scheduledNote ? ' | ' + scheduledNote : ''),
      ]
    );
    const ticketId = ticketRows[0].id;

    if (
      fault.raw_dark_pole_ids &&
      fault.raw_dark_pole_ids.length > 0 &&
      fault.fault_type === 'span'
    ) {
      const poleValues = fault.raw_dark_pole_ids
        .map((_, i) => `($1, $${i + 2})`)
        .join(', ');
      await client.query(
        `INSERT INTO ticket_poles (ticket_id, pole_id) VALUES ${poleValues} ON CONFLICT DO NOTHING`,
        [ticketId, ...fault.raw_dark_pole_ids]
      );
    }

    await client.query('COMMIT');

    if (aiSummarize) {
      aiSummarize(fault)
        .then((summary) => {
          if (summary) {
            pool.query(
              'UPDATE fault_tickets SET ai_summary=$1, updated_at=NOW() WHERE id=$2',
              [summary, ticketId]
            );
          }
        })
        .catch((err) =>
          console.warn(`[Ticket] AI summary failed for ${ticketId}:`, err.message)
        );
    }

    if (io) {
      io.emit('ticket:new', {
        id: ticketId,
        fault_type: fault.fault_type,
        status: 'detected',
        confidence: fault.confidence,
        affected_poles: fault.affected_poles,
        fault_lat: fault.fault_lat,
        fault_lon: fault.fault_lon,
        detected_at: new Date().toISOString(),
      });
    }

    console.log(
      `[Ticket] Created ${ticketId} | type=${fault.fault_type} | conf=${fault.confidence} | affected=${fault.affected_poles}`
    );
    return { ticket_id: ticketId, created: true };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

// ─── Ticket lifecycle ─────────────────────────────────────────────────────────

/** Valid state machine transitions. */
const TRANSITIONS = {
  detected:      ['acknowledged'],
  acknowledged:  ['crew_assigned'],
  crew_assigned: ['resolved'],
  resolved:      ['verified'],
  verified:      ['closed'],
};

/**
 * Transition a ticket to a new status.
 * Returns { ok: true } or { ok: false, reason: string }.
 */
async function updateTicketStatus(ticketId, newStatus, io = null) {
  const { rows } = await pool.query(
    'SELECT id, status, downstream_pole_id FROM fault_tickets WHERE id = $1',
    [ticketId]
  );
  if (!rows.length) return { ok: false, reason: 'Ticket not found' };

  const ticket = rows[0];
  const allowed = TRANSITIONS[ticket.status] || [];

  if (!allowed.includes(newStatus)) {
    return {
      ok: false,
      reason: `Cannot transition from '${ticket.status}' to '${newStatus}'. Allowed: [${allowed.join(', ')}]`,
    };
  }

  // ── Reject resolution if downstream pole is still dark ──────────────────
  if (newStatus === 'resolved' && ticket.downstream_pole_id) {
    const { rows: stateRows } = await pool.query(
      'SELECT energized FROM pole_state WHERE pole_id = $1',
      [ticket.downstream_pole_id]
    );
    if (stateRows.length && stateRows[0].energized === false) {
      return {
        ok: false,
        reason: `Cannot mark resolved: pole ${ticket.downstream_pole_id} is still dark according to telemetry.`,
      };
    }
  }

  // Build timestamp column
  const tsCol = {
    acknowledged:  'acknowledged_at',
    crew_assigned: 'crew_assigned_at',
    resolved:      'resolved_at',
    verified:      'verified_at',
    closed:        'closed_at',
  }[newStatus];

  await pool.query(
    `UPDATE fault_tickets SET status=$1, ${tsCol}=NOW(), updated_at=NOW() WHERE id=$2`,
    [newStatus, ticketId]
  );

  if (io) {
    io.emit('ticket:updated', { id: ticketId, status: newStatus, updated_at: new Date().toISOString() });
  }

  return { ok: true };
}

// ─── Auto-verification ────────────────────────────────────────────────────────

/**
 * Called after a pole sends `power_restored` or `heartbeat`.
 * Checks if any open ticket has ALL its affected poles back online.
 * If yes, auto-advances to 'verified'.
 */
async function autoVerifyRestoredTickets(restoredPoleId, io = null) {
  // Find open tickets that include this pole
  const { rows: tickets } = await pool.query(
    `SELECT DISTINCT ft.id, ft.status
     FROM fault_tickets ft
     JOIN ticket_poles tp ON tp.ticket_id = ft.id
     WHERE tp.pole_id = $1
       AND ft.status IN ('resolved', 'crew_assigned', 'acknowledged', 'detected')`,
    [restoredPoleId]
  );

  for (const ticket of tickets) {
    // Check if ALL affected poles for this ticket are now live
    const { rows: darkPoles } = await pool.query(
      `SELECT tp.pole_id
       FROM ticket_poles tp
       JOIN pole_state ps ON ps.pole_id = tp.pole_id
       WHERE tp.ticket_id = $1
         AND ps.energized = false`,
      [ticket.id]
    );

    if (darkPoles.length === 0) {
      // All poles live → auto-verify
      await pool.query(
        `UPDATE fault_tickets
         SET status='verified', verified_at=NOW(), updated_at=NOW()
         WHERE id=$1 AND status NOT IN ('verified','closed')`,
        [ticket.id]
      );
      console.log(`[Ticket] Auto-verified ${ticket.id} — all affected poles restored`);
      if (io) {
        io.emit('ticket:updated', {
          id: ticket.id,
          status: 'verified',
          updated_at: new Date().toISOString(),
          auto_verified: true,
        });
      }
    }
  }
}

// ─── Queries for API routes ───────────────────────────────────────────────────

async function getTickets({ status, limit = 50, offset = 0 } = {}) {
  const conditions = [];
  const params = [];
  if (status) {
    params.push(status);
    conditions.push(`status = $${params.length}`);
  }
  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  const { rows } = await pool.query(
    `SELECT * FROM fault_tickets ${where}
     ORDER BY detected_at DESC
     LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
    [...params, limit, offset]
  );
  return rows;
}

async function getTicketById(ticketId) {
  const { rows: ticket } = await pool.query(
    'SELECT * FROM fault_tickets WHERE id = $1',
    [ticketId]
  );
  if (!ticket.length) return null;

  const { rows: poles } = await pool.query(
    'SELECT pole_id FROM ticket_poles WHERE ticket_id = $1',
    [ticketId]
  );
  return { ...ticket[0], affected_pole_ids: poles.map((r) => r.pole_id) };
}

module.exports = {
  createTicket,
  updateTicketStatus,
  autoVerifyRestoredTickets,
  getTickets,
  getTicketById,
};
