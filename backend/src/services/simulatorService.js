'use strict';

/**
 * simulatorService.js — Realistic Fault Injection Engine
 *
 * Injects synthetic faults into the live system, with the same real-world
 * noise the spec describes:
 *
 *  - 30% of affected poles send explicit `power_lost` (normal firmware)
 *  - 70% go silent — fw 1.2.x behaviour; we mark them directly as
 *    `watchdog_timeout` so the localization engine sees them immediately
 *    (in production the watchdog does this after 20 min; simulator skips wait)
 *  - 15% of explicit senders also send a duplicate (at-least-once delivery)
 *  - Out-of-order message: 5% chance of one stale `power_lost` with an old seq
 *
 * Repair restores all affected poles via `power_restored` telemetry and
 * triggers auto-verify on any open tickets.
 */

const { pool } = require('../db/pool');
const {
  getTree,
  getDtIdForPole,
  getAllDtIds,
  getDtIdsForFeeder,
  collectSubtree,
} = require('./topology');
const { processEvent } = require('./ingestService');
const { triggerNow } = require('./localizationTrigger');

// ─── Helpers ──────────────────────────────────────────────────────────────────

function randInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

/**
 * Walk the tree and find a pole whose subtree has between minSize and maxSize
 * device-equipped poles. Returns { poleId, dtId, subtreeSize }.
 */
function pickFaultPoint(tree, minSize, maxSize) {
  const candidates = [];

  for (const [poleId, node] of tree.nodes) {
    if (!node.pole.device_id) continue; // no device → skip as fault origin

    const subtree = collectSubtree(tree, poleId);
    const deviceCount = subtree.filter((id) => tree.nodes.get(id)?.pole.device_id).length;

    if (deviceCount >= minSize && deviceCount <= maxSize) {
      candidates.push({ poleId, subtreeSize: deviceCount, subtree });
    }
  }

  if (!candidates.length) return null;
  return candidates[Math.floor(Math.random() * candidates.length)];
}

// ─── Core injection ───────────────────────────────────────────────────────────

/**
 * Inject dark-state for a set of poles.
 * Returns injection summary stats.
 *
 * @param {string[]} affectedPoleIds  Poles to mark as dark
 * @param {object}   tree             DT tree
 * @param {object}   options
 * @param {number}   options.silentPct  0–1, default 0.70
 */
async function injectDarkSignals(affectedPoleIds, tree, options = {}) {
  const silentPct = options.silentPct ?? 0.70;
  const dupPct = options.dupPct ?? 0.15;
  const oooPct = options.oooPct ?? 0.05;

  let explicit = 0, silent = 0, dupes = 0, ooo = 0;

  // Build the batch of "speaking" poles (those that send explicit power_lost)
  const silentPoles = [];
  const speakingPoles = [];

  for (const poleId of affectedPoleIds) {
    const node = tree.nodes.get(poleId);
    const deviceId = node?.pole?.device_id;
    if (!deviceId) continue; // no device, no signal at all

    const isFw12 = node.pole.fw_version?.startsWith('1.2');
    const goSilent = isFw12 || Math.random() < silentPct;

    if (goSilent) {
      silentPoles.push(poleId);
    } else {
      speakingPoles.push({ poleId, deviceId, fw: node.pole.fw_version });
    }
  }

  // 1. Mark silent poles directly (watchdog simulation)
  if (silentPoles.length > 0) {
    const placeholders = silentPoles.map((_, i) => `$${i + 1}`).join(', ');
    await pool.query(
      `UPDATE pole_state
       SET energized=false, last_event='watchdog_timeout', updated_at=NOW()
       WHERE pole_id IN (${placeholders})`,
      silentPoles
    );
    silent = silentPoles.length;
  }

  // 2. Send explicit power_lost for speaking poles
  for (const { poleId, deviceId, fw } of speakingPoles) {
    const seq = randInt(10000, 99999);

    await processEvent({
      device_id: deviceId,
      pole_id: poleId,
      event: 'power_lost',
      energized: false,
      ts: new Date().toISOString(),
      seq,
      fw: fw ?? '1.4.2',
    });
    explicit++;

    // Duplicate (at-least-once delivery noise)
    if (Math.random() < dupPct) {
      await processEvent({
        device_id: deviceId,
        pole_id: poleId,
        event: 'power_lost',
        energized: false,
        ts: new Date().toISOString(),
        seq, // same seq → will be deduped correctly
        fw: fw ?? '1.4.2',
      });
      dupes++;
    }

    // Out-of-order stale message noise (very low seq → will be rejected by OOO guard)
    if (Math.random() < oooPct) {
      await processEvent({
        device_id: deviceId,
        pole_id: poleId,
        event: 'power_lost',
        energized: false,
        ts: new Date(Date.now() - 6 * 3600 * 1000).toISOString(), // 6 hours ago
        seq: randInt(1, 100), // stale low seq → OOO guard discards state update
        fw: fw ?? '1.4.2',
      });
      ooo++;
    }
  }

  return { explicit, silent, dupes, ooo };
}

// ─── Fault scenarios ──────────────────────────────────────────────────────────

/**
 * Inject a SPAN fault: find a fault point within the DT whose subtree has
 * between minAffected and maxAffected device-equipped poles.
 */
async function injectSpanFault(dtId, { minAffected = 5, maxAffected = 50, noise = true } = {}) {
  const tree = getTree(dtId);
  if (!tree) throw new Error(`DT ${dtId} not found in topology cache`);

  const pick = pickFaultPoint(tree, minAffected, maxAffected);
  if (!pick) {
    throw new Error(`No suitable fault point found in ${dtId} for size ${minAffected}–${maxAffected}`);
  }

  const stats = await injectDarkSignals(pick.subtree, tree, {
    silentPct: noise ? 0.70 : 0.0,
    dupPct:    noise ? 0.15 : 0.0,
    oooPct:    noise ? 0.05 : 0.0,
  });

  // Run localization immediately (don't wait for debounce)
  await triggerNow(dtId);

  return {
    scenario: 'span_fault',
    dt_id: dtId,
    downstream_pole_id: pick.poleId,
    total_affected: pick.subtree.length,
    device_affected: pick.subtreeSize,
    ...stats,
  };
}

/**
 * Inject a DT fault: all poles under the DT go dark.
 */
async function injectDTFault(dtId, { noise = true } = {}) {
  const tree = getTree(dtId);
  if (!tree) throw new Error(`DT ${dtId} not found`);

  const allPoles = [...tree.nodes.keys()];
  const stats = await injectDarkSignals(allPoles, tree, {
    silentPct: noise ? 0.70 : 0.0,
    dupPct:    noise ? 0.15 : 0.0,
    oooPct:    noise ? 0.05 : 0.0,
  });

  await triggerNow(dtId);

  return {
    scenario: 'dt_fault',
    dt_id: dtId,
    total_affected: allPoles.length,
    ...stats,
  };
}

/**
 * Inject a FEEDER fault: all DTs on the feeder go dark.
 */
async function injectFeederFault(feederId, { noise = true } = {}) {
  const dtIds = getDtIdsForFeeder(feederId);
  if (!dtIds.length) throw new Error(`Feeder ${feederId} not found`);

  let totalAffected = 0;
  let totalExplicit = 0, totalSilent = 0;

  for (const dtId of dtIds) {
    const tree = getTree(dtId);
    if (!tree) continue;
    const allPoles = [...tree.nodes.keys()];
    const stats = await injectDarkSignals(allPoles, tree, {
      silentPct: noise ? 0.70 : 0.0,
    });
    totalAffected += allPoles.length;
    totalExplicit += stats.explicit;
    totalSilent   += stats.silent;
  }

  // Trigger all DTs on the feeder
  await Promise.all(dtIds.map((id) => triggerNow(id)));

  return {
    scenario: 'feeder_fault',
    feeder_id: feederId,
    dt_count: dtIds.length,
    total_affected: totalAffected,
    explicit: totalExplicit,
    silent: totalSilent,
  };
}

/**
 * Inject a SENSOR FAILURE:
 *   One pole (non-leaf) goes dark, but its children remain live.
 *   The BFS should detect this as a sensor failure and NOT create a ticket.
 */
async function injectSensorFailure(dtId) {
  const tree = getTree(dtId);
  if (!tree) throw new Error(`DT ${dtId} not found`);

  // Find a pole that has at least one device-equipped child
  let targetPoleId = null;
  for (const [poleId, node] of tree.nodes) {
    if (!node.pole.device_id) continue;
    const deviceChildren = node.children.filter(
      (cId) => tree.nodes.get(cId)?.pole.device_id
    );
    if (deviceChildren.length > 0) {
      targetPoleId = poleId;
      break;
    }
  }

  if (!targetPoleId) throw new Error(`No suitable non-leaf pole found in ${dtId}`);

  // Mark only the target pole as dark (NOT its children)
  await pool.query(
    `UPDATE pole_state
     SET energized=false, last_event='watchdog_timeout', updated_at=NOW()
     WHERE pole_id = $1`,
    [targetPoleId]
  );

  // Run localization — should find sensor failure, no ticket
  await triggerNow(dtId);

  return {
    scenario: 'sensor_failure',
    dt_id: dtId,
    target_pole_id: targetPoleId,
    expected_outcome: 'NO ticket (sensor failure detected by BFS — live child exists)',
  };
}

// ─── Repair ───────────────────────────────────────────────────────────────────

/**
 * Repair a fault: send power_restored for all affected poles.
 * Triggers auto-verify on any open tickets.
 *
 * @param {string}   dtId   DT to restore
 * @param {string[]} [poleIds]  Specific poles to restore (default: all dark poles in DT)
 */
async function repairFault(dtId, poleIds = null) {
  const tree = getTree(dtId);
  if (!tree) throw new Error(`DT ${dtId} not found`);

  let targetPoles = poleIds;

  if (!targetPoles) {
    // Restore all currently dark poles in this DT
    const { rows } = await pool.query(
      `SELECT ps.pole_id FROM pole_state ps
       JOIN poles p ON p.pole_id = ps.pole_id
       WHERE p.dt_id = $1 AND ps.energized = false`,
      [dtId]
    );
    targetPoles = rows.map((r) => r.pole_id);
  }

  let restored = 0;
  for (const poleId of targetPoles) {
    const node = tree.nodes.get(poleId);
    if (!node?.pole.device_id) {
      // No device: directly update pole_state
      await pool.query(
        `UPDATE pole_state SET energized=true, last_event='power_restored', updated_at=NOW()
         WHERE pole_id = $1`,
        [poleId]
      );
    } else {
      await processEvent({
        device_id: node.pole.device_id,
        pole_id: poleId,
        event: 'power_restored',
        energized: true,
        ts: new Date().toISOString(),
        seq: randInt(100000, 999999), // high seq → passes OOO guard
        fw: node.pole.fw_version ?? '1.4.2',
      });
    }
    restored++;
  }

  return { dt_id: dtId, restored };
}

// ─── Pre-built scenarios list ─────────────────────────────────────────────────

/**
 * Returns metadata about all available demo scenarios.
 * Each scenario can be triggered via POST /api/simulator/fault.
 */
function getScenarios() {
  return [
    {
      id: 'span_small',
      name: 'Small Span Fault (5–15 poles)',
      description:
        'Breaks a wire affecting 5–15 downstream poles. 70% of devices go silent (fw 1.2.x). 30% send explicit power_lost with 15% duplicates.',
      fault_type: 'span',
      expected_ticket: 'span fault, confidence HIGH or MEDIUM',
      body: { type: 'span', min_affected: 5, max_affected: 15 },
    },
    {
      id: 'span_large',
      name: 'Large Span Fault (30–60 poles)',
      description:
        'Major line break affecting 30–60 downstream poles. Good demo of multi-household impact and household estimate.',
      fault_type: 'span',
      expected_ticket: 'span fault, HIGH or MEDIUM confidence, 200–500 households',
      body: { type: 'span', min_affected: 30, max_affected: 60 },
    },
    {
      id: 'dt_blackout',
      name: 'DT Blackout (all poles under one DT dark)',
      description:
        'The distribution transformer itself fails. All device-equipped poles under the DT go dark. Localization escalates to fault_type=dt.',
      fault_type: 'dt',
      expected_ticket: 'dt fault, confidence LOW (no span can be pinned)',
      body: { type: 'dt' },
    },
    {
      id: 'feeder_trip',
      name: 'Feeder Trip (entire feeder dark)',
      description:
        'The feeder cable trips, taking all DTs and their poles offline. Localization escalates to fault_type=feeder.',
      fault_type: 'feeder',
      expected_ticket: 'feeder fault, confidence MEDIUM',
      body: { type: 'feeder' },
    },
    {
      id: 'sensor_failure',
      name: 'Sensor Failure (no ticket expected)',
      description:
        'One non-leaf pole goes dark but its children remain live. BFS detects live child → sensor/modem failure → NO ticket raised.',
      fault_type: 'none',
      expected_ticket: 'NO ticket (sensor failure correctly identified)',
      body: { type: 'sensor_failure' },
    },
    {
      id: 'multi_fault',
      name: 'Multi-Fault (two independent breaks on same DT)',
      description:
        'Two separate branches of the same DT break simultaneously. BFS finds both, creates two separate span tickets.',
      fault_type: 'span x2',
      expected_ticket: 'two span tickets with different upstream/downstream poles',
      body: { type: 'multi_fault' },
    },
    {
      id: 'clean_span',
      name: 'Clean Span Fault (no noise)',
      description:
        'All poles send explicit power_lost — no fw 1.2.x silence, no duplicates. Tests basic detection path.',
      fault_type: 'span',
      expected_ticket: 'span fault, confidence HIGH',
      body: { type: 'span', noise: false, min_affected: 10, max_affected: 30 },
    },
  ];
}

// ─── Main dispatch ────────────────────────────────────────────────────────────

/**
 * Entry point called by the simulator route.
 * Dispatches to the right injection function based on `type`.
 */
async function runScenario(body) {
  const {
    type,
    dt_id,
    feeder_id,
    min_affected = 5,
    max_affected = 50,
    noise = true,
  } = body;

  // Pick a DT if not specified
  const allDtIds = getAllDtIds();
  const targetDtId = dt_id || allDtIds[randInt(0, allDtIds.length - 1)];

  switch (type) {
    case 'span':
      return injectSpanFault(targetDtId, { minAffected: min_affected, maxAffected: max_affected, noise });

    case 'dt':
      return injectDTFault(targetDtId, { noise });

    case 'feeder': {
      // Pick a feeder: use the DT's feeder or a random one
      const tree = getTree(targetDtId);
      const fId = feeder_id || tree?.dt?.feeder_id;
      return injectFeederFault(fId, { noise });
    }

    case 'sensor_failure':
      return injectSensorFailure(targetDtId);

    case 'multi_fault': {
      // Inject two separate span faults on the same DT
      const tree = getTree(targetDtId);
      if (!tree) throw new Error('DT not found');

      // Pick two non-overlapping fault points
      const fault1 = pickFaultPoint(tree, 5, 20);
      if (!fault1) throw new Error('Could not find first fault point');

      // Mark fault1 subtree as visited to find a non-overlapping fault2
      const fault1Set = new Set(fault1.subtree);
      let fault2 = null;
      for (const [poleId, node] of tree.nodes) {
        if (!node.pole.device_id) continue;
        if (fault1Set.has(poleId)) continue;
        if (!node.parent || fault1Set.has(node.parent)) continue; // different branch
        const sub = collectSubtree(tree, poleId);
        const devCount = sub.filter((id) => tree.nodes.get(id)?.pole.device_id).length;
        if (devCount >= 3 && devCount <= 15) {
          fault2 = { poleId, subtree: sub, subtreeSize: devCount };
          break;
        }
      }

      if (!fault2) {
        // Fallback: single fault
        return injectSpanFault(targetDtId, { minAffected: 5, maxAffected: 20, noise });
      }

      const stats1 = await injectDarkSignals(fault1.subtree, tree, {
        silentPct: noise ? 0.70 : 0,
        dupPct: noise ? 0.15 : 0,
      });
      const stats2 = await injectDarkSignals(fault2.subtree, tree, {
        silentPct: noise ? 0.70 : 0,
        dupPct: noise ? 0.15 : 0,
      });

      await triggerNow(targetDtId);

      return {
        scenario: 'multi_fault',
        dt_id: targetDtId,
        fault1: { downstream_pole_id: fault1.poleId, affected: fault1.subtree.length },
        fault2: { downstream_pole_id: fault2.poleId, affected: fault2.subtree.length },
        stats1,
        stats2,
      };
    }

    default:
      throw new Error(`Unknown scenario type: ${type}`);
  }
}

module.exports = {
  runScenario,
  repairFault,
  getScenarios,
  injectSpanFault,
  injectDTFault,
  injectFeederFault,
};
