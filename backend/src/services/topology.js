'use strict';

/**
 * topology.js — In-memory adjacency-list cache for all DT trees.
 *
 * Loaded once at server startup from the `topology_edges` table
 * (populated by seed: 40% from parent_pole_id registry, 60% Prim's MST).
 *
 * Cache structure per DT:
 * {
 *   dt:    { dt_id, feeder_id, lat, lon, households_served }
 *   nodes: Map<pole_id, {
 *             pole:          { pole_id, lat, lon, device_id, fw_version, ward, pincode }
 *             parent:        string | null   ← null = DT is parent
 *             children:      string[]        ← child pole IDs
 *             inferred:      boolean
 *             edge_length_m: number
 *           }>
 *   roots: string[]   ← poles whose parent IS the DT (parent_pole_id = null)
 * }
 *
 * poleIndex: Map<pole_id, dtId>   — reverse lookup to find a pole's DT
 * dtsByFeeder: Map<feeder_id, dtId[]>  — all DTs on a feeder
 */

const { pool } = require('../db/pool');

const dtCache = new Map();
const poleIndex = new Map();
const dtsByFeeder = new Map();

let loaded = false;

/**
 * Load the entire topology into memory.
 * Must be called once during server startup (after migrations + seed).
 * Safe to call again — will reload from DB.
 */
async function buildTopologyCache() {
  console.log('[Topology] Building in-memory tree cache...');

  const dtRows = await pool.query(
    'SELECT dt_id, feeder_id, lat, lon, households_served FROM distribution_transformers'
  );
  const dtMap = new Map(dtRows.rows.map((r) => [r.dt_id, r]));

  const poleRows = await pool.query(
    'SELECT pole_id, lat, lon, feeder_id, dt_id, device_id, fw_version, ward, pincode FROM poles'
  );
  const poleMap = new Map(poleRows.rows.map((r) => [r.pole_id, r]));

  const edgeRows = await pool.query(
    'SELECT child_pole_id, parent_pole_id, dt_id, inferred, edge_length_m FROM topology_edges'
  );

  dtCache.clear();
  poleIndex.clear();
  dtsByFeeder.clear();

  for (const dt of dtMap.values()) {
    dtCache.set(dt.dt_id, {
      dt,
      nodes: new Map(),
      roots: [],
    });

    const list = dtsByFeeder.get(dt.feeder_id) || [];
    list.push(dt.dt_id);
    dtsByFeeder.set(dt.feeder_id, list);
  }

  for (const pole of poleMap.values()) {
    poleIndex.set(pole.pole_id, pole.dt_id);
    const tree = dtCache.get(pole.dt_id);
    if (!tree) continue;
    tree.nodes.set(pole.pole_id, {
      pole,
      parent: null,
      children: [],
      inferred: false,
      edge_length_m: 0,
    });
  }

  for (const edge of edgeRows.rows) {
    const tree = dtCache.get(edge.dt_id);
    if (!tree) continue;

    const node = tree.nodes.get(edge.child_pole_id);
    if (!node) continue;

    node.parent = edge.parent_pole_id || null;
    node.inferred = edge.inferred;
    node.edge_length_m = parseFloat(edge.edge_length_m) || 0;

    if (edge.parent_pole_id) {
      const parentNode = tree.nodes.get(edge.parent_pole_id);
      if (parentNode) {
        parentNode.children.push(edge.child_pole_id);
      }
    } else {
      tree.roots.push(edge.child_pole_id);
    }
  }

  loaded = true;

  const totalPoles = poleIndex.size;
  const totalDTs = dtCache.size;
  const totalFeeders = dtsByFeeder.size;
  console.log(
    `[Topology] Cache ready: ${totalDTs} DTs, ${totalPoles} poles, ${totalFeeders} feeders`
  );
}

// ─── Accessors ────────────────────────────────────────────────────────────────

function getTree(dtId) {
  return dtCache.get(dtId) || null;
}

function getDtIdForPole(poleId) {
  return poleIndex.get(poleId) || null;
}

function getDtIdsForFeeder(feederId) {
  return dtsByFeeder.get(feederId) || [];
}

function getAllDtIds() {
  return [...dtCache.keys()];
}

function isLoaded() {
  return loaded;
}

/**
 * Collect all pole IDs in a subtree rooted at `poleId` (inclusive).
 * Used by the localization engine to enumerate affected poles.
 */
function collectSubtree(tree, poleId) {
  const result = [];
  const stack = [poleId];
  while (stack.length > 0) {
    const id = stack.pop();
    result.push(id);
    const node = tree.nodes.get(id);
    if (node) stack.push(...node.children);
  }
  return result;
}

module.exports = {
  buildTopologyCache,
  getTree,
  getDtIdForPole,
  getDtIdsForFeeder,
  getAllDtIds,
  collectSubtree,
  isLoaded,
};
