'use strict';

const { pool } = require('../db/pool');
const { generateNetwork } = require('./generateNetwork');

const BATCH_SIZE = 200;

/**
 * Insert rows in batches to avoid PostgreSQL parameter limit (65535).
 * @param {string} table
 * @param {string[]} columns
 * @param {Array} rows
 */
async function batchInsert(table, columns, rows) {
  if (rows.length === 0) return;

  for (let i = 0; i < rows.length; i += BATCH_SIZE) {
    const batch = rows.slice(i, i + BATCH_SIZE);
    const values = [];
    const placeholders = batch.map((row, rowIdx) => {
      const rowPlaceholders = columns.map((_, colIdx) => {
        values.push(row[columns[colIdx]] ?? null);
        return `$${rowIdx * columns.length + colIdx + 1}`;
      });
      return `(${rowPlaceholders.join(', ')})`;
    });

    const sql = `INSERT INTO ${table} (${columns.join(', ')}) VALUES ${placeholders.join(', ')} ON CONFLICT DO NOTHING`;
    await pool.query(sql, values);
  }
}

/**
 * Seeds the database with a synthetic network.
 * Idempotent: only runs if the poles table is empty.
 */
async function runSeed() {
  const { rows } = await pool.query('SELECT COUNT(*) FROM poles');
  if (parseInt(rows[0].count, 10) > 0) {
    console.log(`[Seed] Database already seeded (${rows[0].count} poles). Skipping.`);
    return;
  }

  console.log('[Seed] Generating synthetic network...');
  const { feeders, dts, poles, topologyEdges, poleStates, scheduledOutages } = generateNetwork();

  console.log('[Seed] Inserting feeders...');
  await batchInsert('feeders', ['feeder_id', 'substation_id', 'name'], feeders);

  console.log('[Seed] Inserting distribution_transformers...');
  await batchInsert(
    'distribution_transformers',
    ['dt_id', 'feeder_id', 'lat', 'lon', 'capacity_kva', 'households_served'],
    dts
  );

  console.log('[Seed] Inserting poles...');
  await batchInsert(
    'poles',
    ['pole_id', 'lat', 'lon', 'feeder_id', 'dt_id',
      'seq_on_line', 'parent_pole_id', 'pole_type',
      'ward', 'pincode', 'device_id', 'fw_version'],
    poles
  );

  console.log('[Seed] Inserting topology_edges...');
  await batchInsert(
    'topology_edges',
    ['child_pole_id', 'parent_pole_id', 'dt_id', 'inferred', 'edge_length_m'],
    topologyEdges
  );

  console.log('[Seed] Inserting pole_state (initial: all energized)...');
  await batchInsert(
    'pole_state',
    ['pole_id', 'energized', 'last_seen', 'last_event',
      'last_seq', 'device_id', 'battery_mv', 'rssi', 'fw'],
    poleStates
  );

  console.log('[Seed] Inserting scheduled_outages...');
  await batchInsert(
    'scheduled_outages',
    ['id', 'scope', 'target_id', 'start_time', 'end_time', 'reason'],
    scheduledOutages
  );

  const totals = await pool.query(`
    SELECT
      (SELECT COUNT(*) FROM feeders)                   AS feeders,
      (SELECT COUNT(*) FROM distribution_transformers) AS dts,
      (SELECT COUNT(*) FROM poles)                     AS poles,
      (SELECT COUNT(*) FROM topology_edges)            AS edges,
      (SELECT COUNT(*) FROM pole_state)                AS pole_states
  `);

  const t = totals.rows[0];
  console.log('[Seed] ✓ Done. Final counts:');
  console.log(`  feeders=${t.feeders}  dts=${t.dts}  poles=${t.poles}  edges=${t.edges}  pole_states=${t.pole_states}`);
}

module.exports = { runSeed };
