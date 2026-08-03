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

// ─── Module-level caches ──────────────────────────────────────────────────────

/** @type {Map<string, object>}  dtId → tree */
const dtCache = new Map();

/** @type {Map<string, string>}  pole_id → dt_id */
const poleIndex = new Map();

/** @type {Map<string, string[]>}  feeder_id → [dt_id, ...] */
const dtsByFeeder = new Map();

let loaded = false;

// ─── Loader ───────────────────────────────────────────────────────────────────

/**
 * Load the entire topology into memory.
 * Must be called once during server startup (after migrations + seed).
 * Safe to call again — will reload from DB.
 */
async function buildTopologyCache() {
  console.log('[Topology] Building in-memory tree cache...');

  // 1. Load all DTs
  const dtRows = await pool.query(
    'SELECT dt_id, feeder_id, lat, lon, households_served FROM distribution_transformers'
  );
  const dtMap = new Map(dtRows.rows.map((r) => [r.dt_id, r]));

  // 2. Load all poles (only fields needed for localization)
  const poleRows = await pool.query(
    'SELECT pole_id, lat, lon, feeder_id, dt_id, device_id, fw_version, ward, pincode FROM poles'
  );
  const poleMap = new Map(poleRows.rows.map((r) => [r.pole_id, r]));

  // 3. Load all topology edges
  const edgeRows = await pool.query(
    'SELECT child_pole_id, parent_pole_id, dt_id, inferred, edge_length_m FROM topology_edges'
  );

  // 4. Build DT trees
  dtCache.clear();
  poleIndex.clear();
  dtsByFeeder.clear();

  // Initialise empty trees for all DTs
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

  // Add poles to tree nodes (without edges yet)
  for (const pole of poleMap.values()) {
    poleIndex.set(pole.pole_id, pole.dt_id);
    const tree = dtCache.get(pole.dt_id);
    if (!tree) continue; // orphan pole (shouldn't happen)
    tree.nodes.set(pole.pole_id, {
      pole,
      parent: null,
      children: [],
      inferred: false,
      edge_length_m: 0,
    });
  }

  // Wire edges (parent ↔ children)
  for (const edge of edgeRows.rows) {
    const tree = dtCache.get(edge.dt_id);
    if (!tree) continue;

    const node = tree.nodes.get(edge.child_pole_id);
    if (!node) continue;

    node.parent = edge.parent_pole_id || null;
    node.inferred = edge.inferred;
    node.edge_length_m = parseFloat(edge.edge_length_m) || 0;

    if (edge.parent_pole_id) {
      // Wire parent's children array
      const parentNode = tree.nodes.get(edge.parent_pole_id);
      if (parentNode) {
        parentNode.children.push(edge.child_pole_id);
      }
    } else {
      // parent_pole_id = null → this pole is a root (directly under DT)
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
