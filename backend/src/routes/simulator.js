'use strict';

const { Router } = require('express');
const { runScenario, repairFault, getScenarios } = require('../services/simulatorService');
const { pool } = require('../db/pool');

const router = Router();

/**
 * GET /api/simulator/scenarios
 * Returns the catalog of pre-built demo scenarios.
 */
router.get('/scenarios', (req, res) => {
  res.json({ scenarios: getScenarios() });
});

/**
 * GET /api/simulator/status
 * Quick snapshot: how many poles are dark, how many open tickets.
 */
router.get('/status', async (req, res) => {
  try {
    const [poleRows, ticketRows] = await Promise.all([
      pool.query(
        `SELECT energized, COUNT(*) AS count FROM pole_state GROUP BY energized`
      ),
      pool.query(
        `SELECT status, COUNT(*) AS count FROM fault_tickets GROUP BY status`
      ),
    ]);

    const poleCounts = { live: 0, dark: 0, unknown: 0 };
    for (const r of poleRows.rows) {
      if (r.energized === true)  poleCounts.live  = parseInt(r.count);
      if (r.energized === false) poleCounts.dark  = parseInt(r.count);
      if (r.energized === null)  poleCounts.unknown = parseInt(r.count);
    }

    const ticketCounts = {};
    for (const r of ticketRows.rows) {
      ticketCounts[r.status] = parseInt(r.count);
    }

    res.json({
      poles: poleCounts,
      tickets: ticketCounts,
      timestamp: new Date().toISOString(),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/simulator/fault
 * Inject a fault scenario.
 *
 * Body options:
 *   { type: 'span', min_affected: 5, max_affected: 50, noise: true, dt_id: 'D-0001' }
 *   { type: 'dt', dt_id: 'D-0001', noise: true }
 *   { type: 'feeder', feeder_id: 'F-01', noise: true }
 *   { type: 'sensor_failure', dt_id: 'D-0001' }
 *   { type: 'multi_fault', dt_id: 'D-0001' }
 *
 * Or use a pre-built scenario:
 *   { scenario_id: 'span_large' }
 */
router.post('/fault', async (req, res) => {
  try {
    let body = req.body;

    if (body.scenario_id) {
      const scenario = getScenarios().find((s) => s.id === body.scenario_id);
      if (!scenario) {
        return res.status(400).json({ error: `Unknown scenario_id: ${body.scenario_id}` });
      }
      body = { ...scenario.body, ...body };
    }

    if (!body.type) {
      return res.status(400).json({
        error: 'Body must include { type } or { scenario_id }',
        available_types: ['span', 'dt', 'feeder', 'sensor_failure', 'multi_fault'],
        available_scenarios: getScenarios().map((s) => s.id),
      });
    }

    const result = await runScenario(body);

    const io = req.app.get('io');
    if (io) {
      io.emit('simulator:fault_injected', result);
    }

    return res.json({ ok: true, ...result });
  } catch (err) {
    console.error('[Simulator] Fault injection error:', err.message);
    return res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/simulator/repair
 * Restore power after a simulated fault.
 *
 * Body:
 *   { dt_id: 'D-0001' }               — restores all dark poles in DT
 *   { dt_id: 'D-0001', pole_ids: [...] } — restores specific poles
 */
router.post('/repair', async (req, res) => {
  try {
    const { dt_id, pole_ids } = req.body;

    if (!dt_id) {
      return res.status(400).json({ error: 'Body must include { dt_id }' });
    }

    const result = await repairFault(dt_id, pole_ids || null);

    const io = req.app.get('io');
    if (io) {
      io.emit('simulator:repair_injected', result);
    }

    return res.json({ ok: true, ...result });
  } catch (err) {
    console.error('[Simulator] Repair error:', err.message);
    return res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/simulator/reset
 * Restore ALL poles to energized=true (full system reset for demo cleanup).
 */
router.post('/reset', async (req, res) => {
  try {
    const result = await pool.query(
      `UPDATE pole_state
       SET energized = true,
           last_event = 'heartbeat',
           last_seen = NOW(),
           updated_at = NOW()
       WHERE energized = false OR energized IS NULL
       RETURNING pole_id`
    );

    if (req.body.clear_tickets) {
      await pool.query(
        `UPDATE fault_tickets SET status='closed', closed_at=NOW(), updated_at=NOW()
         WHERE status NOT IN ('closed')`
      );
    }

    const io = req.app.get('io');
    if (io) io.emit('simulator:reset', { restored: result.rows.length });

    return res.json({
      ok: true,
      poles_restored: result.rows.length,
      tickets_cleared: req.body.clear_tickets ? true : false,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
