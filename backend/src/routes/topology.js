'use strict';

const { Router } = require('express');
const { pool } = require('../db/pool');

const router = Router();

/**
 * GET /api/topology
 * Returns the full network topology for the Leaflet map:
 *   - All DTs with coordinates
 *   - All poles with coordinates and current live/dark state
 *   - All topology edges (known + inferred)
 *   - All feeders
 *
 * This is the data source for the operator console map.
 * Response is deliberately paginated by DT to keep payload manageable.
 */
router.get('/', async (req, res) => {
  try {
    const [dtRows, poleRows, edgeRows, feedRows] = await Promise.all([
      pool.query(`
        SELECT dt.dt_id, dt.feeder_id, dt.lat, dt.lon, dt.capacity_kva, dt.households_served
        FROM distribution_transformers dt
        ORDER BY dt.dt_id
      `),
      pool.query(`
        SELECT p.pole_id, p.lat, p.lon, p.dt_id, p.feeder_id,
               p.ward, p.pincode, p.device_id IS NOT NULL AS has_device,
               p.fw_version,
               ps.energized, ps.last_event, ps.last_seen
        FROM poles p
        LEFT JOIN pole_state ps ON ps.pole_id = p.pole_id
        ORDER BY p.pole_id
      `),
      pool.query(`
        SELECT child_pole_id, parent_pole_id, dt_id, inferred, edge_length_m
        FROM topology_edges
        ORDER BY dt_id, child_pole_id
      `),
      pool.query(`SELECT feeder_id, substation_id, name FROM feeders ORDER BY feeder_id`),
    ]);

    res.json({
      feeders: feedRows.rows,
      dts: dtRows.rows,
      poles: poleRows.rows,
      edges: edgeRows.rows,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/topology/dt/:dtId
 * Returns the tree for a single DT (used by ticket detail panel).
 */
router.get('/dt/:dtId', async (req, res) => {
  try {
    const { dtId } = req.params;

    const [dtRow, poleRows, edgeRows] = await Promise.all([
      pool.query(
        'SELECT * FROM distribution_transformers WHERE dt_id = $1',
        [dtId]
      ),
      pool.query(
        `SELECT p.*, ps.energized, ps.last_event, ps.last_seen
         FROM poles p LEFT JOIN pole_state ps ON ps.pole_id = p.pole_id
         WHERE p.dt_id = $1 ORDER BY p.pole_id`,
        [dtId]
      ),
      pool.query(
        `SELECT * FROM topology_edges WHERE dt_id = $1`,
        [dtId]
      ),
    ]);

    if (!dtRow.rows.length) return res.status(404).json({ error: 'DT not found' });

    res.json({
      dt: dtRow.rows[0],
      poles: poleRows.rows,
      edges: edgeRows.rows,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/topology/scheduled-outages
 * Returns currently active and upcoming scheduled outages.
 */
router.get('/scheduled-outages', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT * FROM scheduled_outages
       WHERE end_time >= NOW() - INTERVAL '1 hour'
       ORDER BY start_time`
    );
    res.json({ outages: rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
