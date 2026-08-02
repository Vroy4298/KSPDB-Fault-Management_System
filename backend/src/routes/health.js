'use strict';

const { Router } = require('express');
const { pool } = require('../db/pool');

const router = Router();

/**
 * GET /api/health
 * System health + network overview.
 * Used by the frontend landing screen and external monitoring.
 */
router.get('/', async (_req, res) => {
  try {
    const result = await pool.query(`
      SELECT
        (SELECT COUNT(*) FROM feeders)                   AS feeders,
        (SELECT COUNT(*) FROM distribution_transformers) AS dts,
        (SELECT COUNT(*) FROM poles)                     AS poles,
        (SELECT COUNT(*) FROM pole_state WHERE energized = true)  AS poles_live,
        (SELECT COUNT(*) FROM pole_state WHERE energized = false) AS poles_dark,
        (SELECT COUNT(*) FROM fault_tickets WHERE status NOT IN ('verified','closed')) AS active_tickets,
        (SELECT COUNT(*) FROM topology_edges WHERE inferred = false) AS known_edges,
        (SELECT COUNT(*) FROM topology_edges WHERE inferred = true)  AS inferred_edges
    `);

    const stats = result.rows[0];

    res.json({
      status: 'ok',
      timestamp: new Date().toISOString(),
      network: {
        feeders: parseInt(stats.feeders, 10),
        dts: parseInt(stats.dts, 10),
        poles: parseInt(stats.poles, 10),
        poles_live: parseInt(stats.poles_live, 10),
        poles_dark: parseInt(stats.poles_dark, 10),
      },
      topology: {
        known_edges: parseInt(stats.known_edges, 10),
        inferred_edges: parseInt(stats.inferred_edges, 10),
        known_pct: stats.known_edges + stats.inferred_edges > 0
          ? Math.round((stats.known_edges / (parseInt(stats.known_edges, 10) + parseInt(stats.inferred_edges, 10))) * 100)
          : 0,
      },
      active_tickets: parseInt(stats.active_tickets, 10),
    });
  } catch (err) {
    res.status(503).json({ status: 'error', message: err.message });
  }
});

module.exports = router;
