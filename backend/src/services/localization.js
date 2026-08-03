'use strict';

/**
 * localization.js — BFS Fault Localization Engine
 *
 * Core algorithm: walk the radial distribution tree top-down from the DT
 * root. At each pole, check live/dark state. When a dark pole is reached:
 *
 *   (a) Sensor-failure check:
 *       If ANY child of the dark pole is LIVE, then power flows THROUGH
 *       this pole — it's a sensor/modem failure, not a real break.
 *       → Skip ticket; continue traversal.
 *
 *   (b) Real span fault:
 *       ALL children are also dark (or no children) and the pole has
 *       no downstream live children at any depth.
 *       → Record fault: upstream=parent, downstream=this pole.
 *       → Collect entire subtree as affected_poles.
 *       → Stop descending (subtree is one fault unit).
 *
 * After scanning all poles in a DT:
 *   - If EVERY device-equipped pole is dark → escalate to DT fault.
 *   - If every DT on a feeder is a DT fault → escalate to feeder fault.
 *
 * Confidence:
 *   HIGH   = known topology (inferred=false), <10% missing devices
 *   MEDIUM = any inferred edges in fault span, OR 10-30% missing devices
 *   LOW    = >30% missing devices, OR DT/feeder-level only (no span pinned)
 */

const { pool } = require('../db/pool');
const {
  getTree,
  getDtIdsForFeeder,
  collectSubtree,
} = require('./topology');

// ─── State loader ─────────────────────────────────────────────────────────────

/**
 * Fetch current pole states for all poles in a DT.
 * Returns Map<pole_id, { energized, last_event, device_id, fw_version }>
 */
async function loadPoleStates(dtId) {
  const { rows } = await pool.query(
    `SELECT ps.pole_id, ps.energized, ps.last_event, ps.device_id, ps.fw
     FROM pole_state ps
     JOIN poles p ON p.pole_id = ps.pole_id
     WHERE p.dt_id = $1`,
    [dtId]
  );
  return new Map(rows.map((r) => [r.pole_id, r]));
}

/**
 * Get scheduled outage (if any) that is currently active for a DT or feeder.
 * Uses a generous 40-minute overrun buffer (spec note: outages often overrun).
 */
async function getActiveOutage(scope, targetId) {
  const { rows } = await pool.query(
    `SELECT id, reason FROM scheduled_outages
     WHERE scope = $1
       AND target_id = $2
       AND start_time <= NOW()
       AND end_time   >= NOW() - INTERVAL '40 minutes'`,
    [scope, targetId]
  );
  return rows[0] || null;
}

// ─── Confidence computation ───────────────────────────────────────────────────

/**
 * Determine confidence level for a located fault span.
 * @param {string[]} affectedPoleIds
 * @param {object}   tree             DT tree from topology cache
 * @param {Map}      stateMap         pole_id → state
 */
function computeConfidence(affectedPoleIds, tree, stateMap) {
  let hasInferred = false;
  let noDeviceCount = 0;

  for (const poleId of affectedPoleIds) {
    const node = tree.nodes.get(poleId);
    if (node?.inferred) hasInferred = true;

    const pole = node?.pole;
    if (pole && !pole.device_id) noDeviceCount++;
  }

  const total = affectedPoleIds.length;
  const missingPct = total > 0 ? noDeviceCount / total : 0;

  if (!hasInferred && missingPct < 0.10) {
    return { confidence: 'HIGH', topology_mode: 'known' };
  }
  if (missingPct < 0.30) {
    return { confidence: 'MEDIUM', topology_mode: hasInferred ? 'inferred' : 'known' };
  }
  return { confidence: 'LOW', topology_mode: hasInferred ? 'inferred' : 'dt_level' };
}

/**
 * Build a human-readable confidence reason string.
 */
function buildConfidenceReason(confidence, topology_mode, hasInferred, missingPct) {
  const parts = [];
  if (topology_mode === 'known') parts.push('topology from device registry (40%)');
  if (topology_mode === 'inferred') parts.push('topology inferred via MST — branch attachment may be ±1 pole');
  if (missingPct > 0) parts.push(`${Math.round(missingPct * 100)}% of affected poles have no device`);
  if (confidence === 'LOW') parts.push('fault boundary cannot be precisely pinned');
  return parts.join('; ') || 'normal detection';
}

// ─── Midpoint / coordinate helpers ───────────────────────────────────────────

function midpoint(lat1, lon1, lat2, lon2) {
  return { lat: (lat1 + lat2) / 2, lon: (lon1 + lon2) / 2 };
}

// ─── Core BFS for one DT ─────────────────────────────────────────────────────

/**
 * Run fault localization for a single DT.
 *
 * @param {string} dtId
 * @returns {object[]}  Array of fault descriptors (may be empty, or one DT fault, or N span faults)
 */
async function localizeDT(dtId) {
  const tree = getTree(dtId);
  if (!tree) return [];

  const stateMap = await loadPoleStates(dtId);

  // ── Check scheduled outage first ──────────────────────────────────────────
  const outage = await getActiveOutage('dt', dtId);

  // ── Determine which poles have devices ────────────────────────────────────
  const devicePoles = [...tree.nodes.entries()].filter(([, n]) => n.pole.device_id);
  if (devicePoles.length === 0) return []; // no telemetry possible

  // Count dark poles (device-equipped only)
  const darkDevicePoles = devicePoles.filter(([id]) => {
    const s = stateMap.get(id);
    return s && s.energized === false;
  });

  // ── DT-level fault check ──────────────────────────────────────────────────
  // If ALL device-equipped poles are dark → DT fault (not a span issue)
  if (darkDevicePoles.length === devicePoles.length) {
    const dtObj = tree.dt;
    const householdCount = parseInt(dtObj.households_served || 0, 10);

    return [
      {
        fault_type: 'dt',
        dt_id: dtId,
        feeder_id: dtObj.feeder_id,
        upstream_pole_id: null,
        downstream_pole_id: null,
        fault_lat: dtObj.lat,
        fault_lon: dtObj.lon,
        pincode: null,
        ward: null,
        affected_poles: devicePoles.length,
        estimated_households: householdCount,
        confidence: 'LOW',
        topology_mode: 'dt_level',
        confidence_reason: 'All poles under DT are dark — DT hardware or LV busbar fault suspected',
        scheduled_outage: outage || null,
        raw_dark_pole_ids: darkDevicePoles.map(([id]) => id),
      },
    ];
  }

  // ── BFS span fault detection ──────────────────────────────────────────────
  const faults = [];
  const visited = new Set();
  const queue = [...tree.roots]; // start from DT-connected root poles

  while (queue.length > 0) {
    const poleId = queue.shift();
    if (visited.has(poleId)) continue;
    visited.add(poleId);

    const node = tree.nodes.get(poleId);
    if (!node) continue;

    const state = stateMap.get(poleId);

    // ── Unknown state (no device) → assume live, keep descending ──────────
    if (!state) {
      queue.push(...node.children);
      continue;
    }

    // ── Pole is live → keep descending ────────────────────────────────────
    if (state.energized === true) {
      queue.push(...node.children);
      continue;
    }

    // ── Pole is dark → investigate ────────────────────────────────────────
    // Sensor-failure check: if ANY child has a live device, power flows through.
    const liveChildExists = node.children.some((childId) => {
      const cs = stateMap.get(childId);
      return cs && cs.energized === true;
    });

    if (liveChildExists) {
      // Sensor / modem failure — not a real power fault
      // Continue traversal into children (they may have their own faults)
      queue.push(...node.children);
      continue;
    }

    // ── Real fault boundary: dark pole with no live children ──────────────
    const affectedPoleIds = collectSubtree(tree, poleId);

    // Total affected (including device-less poles)
    const affectedCount = affectedPoleIds.length;

    // Estimated households (sum of DT households proportional to affected poles)
    // Approximation: (affected poles / total poles) × DT households
    const dtHouseholds = parseInt(tree.dt.households_served || 0, 10);
    const totalPolesInDT = tree.nodes.size;
    const estHouseholds = Math.round((affectedCount / totalPolesInDT) * dtHouseholds);

    // Pincode and ward from the downstream (first dark) pole
    const downstreamPole = node.pole;

    // Upstream pole coords (parent of the dark pole, or DT if null)
    let upstreamLat = tree.dt.lat;
    let upstreamLon = tree.dt.lon;
    if (node.parent) {
      const upstreamNode = tree.nodes.get(node.parent);
      if (upstreamNode) {
        upstreamLat = upstreamNode.pole.lat;
        upstreamLon = upstreamNode.pole.lon;
      }
    }

    const { lat: faultLat, lon: faultLon } = midpoint(
      upstreamLat, upstreamLon,
      downstreamPole.lat, downstreamPole.lon
    );

    // Check if any edges in the affected subtree are inferred
    const hasInferred = affectedPoleIds.some(
      (id) => tree.nodes.get(id)?.inferred
    );
    const noDeviceCount = affectedPoleIds.filter(
      (id) => !tree.nodes.get(id)?.pole?.device_id
    ).length;
    const missingPct = affectedCount > 0 ? noDeviceCount / affectedCount : 0;

    const { confidence, topology_mode } = computeConfidence(affectedPoleIds, tree, stateMap);
    const confidence_reason = buildConfidenceReason(confidence, topology_mode, hasInferred, missingPct);

    faults.push({
      fault_type: 'span',
      dt_id: dtId,
      feeder_id: tree.dt.feeder_id,
      upstream_pole_id: node.parent || null,
      downstream_pole_id: poleId,
      fault_lat: faultLat,
      fault_lon: faultLon,
      pincode: downstreamPole.pincode || null,
      ward: downstreamPole.ward || null,
      affected_poles: affectedCount,
      estimated_households: estHouseholds,
      confidence,
      topology_mode,
      confidence_reason,
      scheduled_outage: outage || null,
      raw_dark_pole_ids: affectedPoleIds,
    });

    // Don't descend into this subtree (it's all one fault unit)
    // visited is already tracking this naturally — we just don't add children
  }

  return faults;
}

// ─── Feeder-level escalation ──────────────────────────────────────────────────

/**
 * Check if all DTs on a feeder have DT-level faults.
 * If yes, return a feeder fault descriptor; otherwise return null.
 */
async function checkFeederFault(feederId) {
  const dtIds = getDtIdsForFeeder(feederId);
  if (dtIds.length === 0) return null;

  // For each DT on the feeder, check if all device poles are dark
  const dtResults = await Promise.all(
    dtIds.map(async (dtId) => {
      const tree = getTree(dtId);
      if (!tree) return false;
      const stateMap = await loadPoleStates(dtId);
      const devicePoles = [...tree.nodes.values()].filter((n) => n.pole.device_id);
      if (devicePoles.length === 0) return true; // no devices = can't tell, assume OK
      const darkCount = devicePoles.filter((n) => {
        const s = stateMap.get(n.pole.pole_id);
        return s && s.energized === false;
      }).length;
      return darkCount === devicePoles.length;
    })
  );

  if (!dtResults.every(Boolean)) return null; // at least one DT is not fully dark

  // Check scheduled outage for feeder
  const outage = await getActiveOutage('feeder', feederId);

  // Compute feeder centroid
  const trees = dtIds.map((id) => getTree(id)).filter(Boolean);
  const avgLat = trees.reduce((s, t) => s + t.dt.lat, 0) / trees.length;
  const avgLon = trees.reduce((s, t) => s + t.dt.lon, 0) / trees.length;

  return {
    fault_type: 'feeder',
    feeder_id: feederId,
    dt_id: null,
    upstream_pole_id: null,
    downstream_pole_id: null,
    fault_lat: avgLat,
    fault_lon: avgLon,
    pincode: null,
    ward: null,
    affected_poles: dtIds.length,       // number of DTs
    estimated_households: trees.reduce(
      (s, t) => s + parseInt(t.dt.households_served || 0, 10),
      0
    ),
    confidence: 'MEDIUM',
    topology_mode: 'dt_level',
    confidence_reason: `All ${dtIds.length} DTs on feeder ${feederId} are dark`,
    scheduled_outage: outage || null,
    raw_dark_pole_ids: dtIds,
  };
}

// ─── Full scan ────────────────────────────────────────────────────────────────

/**
 * Localise faults across all DTs that have at least one dark pole.
 * Returns an array of fault descriptors (span + DT + feeder).
 *
 * Called by the localization trigger after debounce.
 */
async function runLocalization(dtIds) {
  const allFaults = [];
  const dtFaultFeeders = new Set(); // feeders where every DT is dark

  for (const dtId of dtIds) {
    const faults = await localizeDT(dtId);
    allFaults.push(...faults);

    // Track feeder for escalation check
    const tree = getTree(dtId);
    if (tree && faults.length === 1 && faults[0].fault_type === 'dt') {
      dtFaultFeeders.add(tree.dt.feeder_id);
    }
  }

  // Check feeder escalation for any feeder where we saw DT-level faults
  for (const feederId of dtFaultFeeders) {
    const feederFault = await checkFeederFault(feederId);
    if (feederFault) {
      // Replace individual DT faults with one feeder fault
      // (remove DT faults that are part of this feeder fault)
      const dtIds_in_feeder = getDtIdsForFeeder(feederId);
      const dtFaultsDrainedOut = allFaults.filter(
        (f) => !(f.fault_type === 'dt' && dtIds_in_feeder.includes(f.dt_id))
      );
      dtFaultsDrainedOut.push(feederFault);
      return dtFaultsDrainedOut;
    }
  }

  return allFaults;
}

module.exports = { localizeDT, runLocalization, checkFeederFault, loadPoleStates };
