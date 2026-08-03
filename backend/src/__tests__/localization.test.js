'use strict';

/**
 * Unit tests for the BFS localization algorithm.
 *
 * These tests use mock topology trees and pole states — no database required.
 * They verify the correctness of the BFS against known scenarios from the spec.
 */

// ── Mock topology ─────────────────────────────────────────────────────────────

/**
 * Build a minimal in-memory DT tree for testing.
 *
 * Schema mirrors what topology.js builds:
 * tree.nodes: Map<pole_id, { pole, parent, children, inferred }>
 * tree.roots: string[]
 * tree.dt: { dt_id, feeder_id, lat, lon, households_served }
 */
function buildMockTree(poles, edges) {
  const nodes = new Map();
  const dt = {
    dt_id: 'D-TEST',
    feeder_id: 'F-01',
    lat: 12.97,
    lon: 77.59,
    households_served: 200,
  };

  // Init all nodes
  for (const pole of poles) {
    nodes.set(pole.pole_id, { pole, parent: null, children: [], inferred: false });
  }

  // Wire edges
  const roots = [];
  for (const edge of edges) {
    const node = nodes.get(edge.child);
    if (!node) continue;
    node.parent = edge.parent || null;
    node.inferred = edge.inferred || false;
    if (edge.parent) {
      const parentNode = nodes.get(edge.parent);
      if (parentNode) parentNode.children.push(edge.child);
    } else {
      roots.push(edge.child);
    }
  }

  return { dt, nodes, roots };
}

/** Simulated pole state map: Map<pole_id, {energized, device_id}> */
function buildStateMap(states) {
  return new Map(Object.entries(states));
}

// ── Inline BFS (copy of algorithm logic for pure unit testing) ────────────────
// This mirrors the algorithm in localization.js without the DB layer.

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

function bfsScan(tree, stateMap) {
  const faults = [];
  const sensorFailures = [];
  const visited = new Set();
  const queue = [...tree.roots];

  const devicePoles = [...tree.nodes.entries()].filter(([, n]) => n.pole.device_id);
  const darkDevicePoles = devicePoles.filter(([id]) => {
    const s = stateMap.get(id);
    return s && s.energized === false;
  });

  // DT-level fault check
  if (devicePoles.length > 0 && darkDevicePoles.length === devicePoles.length) {
    return { faultType: 'dt', faults: [], sensorFailures: [] };
  }

  while (queue.length > 0) {
    const poleId = queue.shift();
    if (visited.has(poleId)) continue;
    visited.add(poleId);

    const node = tree.nodes.get(poleId);
    if (!node) continue;

    const state = stateMap.get(poleId);

    if (!state || state.energized === true) {
      queue.push(...node.children);
      continue;
    }

    // Dark pole — check for sensor failure
    const liveChildExists = node.children.some((cId) => {
      const cs = stateMap.get(cId);
      return cs && cs.energized === true;
    });

    if (liveChildExists) {
      sensorFailures.push(poleId);
      queue.push(...node.children);
      continue;
    }

    // Real fault
    const affected = collectSubtree(tree, poleId);
    faults.push({
      upstream_pole_id: node.parent,
      downstream_pole_id: poleId,
      affected: affected,
    });
  }

  return { faultType: 'span', faults, sensorFailures };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('Localization BFS — core algorithm', () => {
  // Scenario 1: Simple span fault — one dark branch
  test('detects a single span fault with correct boundary poles', () => {
    const poles = [
      { pole_id: 'P-01', device_id: 'DEV-01', lat: 12.97, lon: 77.59 },
      { pole_id: 'P-02', device_id: 'DEV-02', lat: 12.971, lon: 77.59 },
      { pole_id: 'P-03', device_id: 'DEV-03', lat: 12.972, lon: 77.59 },
      { pole_id: 'P-04', device_id: 'DEV-04', lat: 12.973, lon: 77.59 },
    ];
    const edges = [
      { child: 'P-01', parent: null },
      { child: 'P-02', parent: 'P-01' },
      { child: 'P-03', parent: 'P-02' },
      { child: 'P-04', parent: 'P-03' },
    ];
    const tree = buildMockTree(poles, edges);
    // P-01 and P-02 are live; P-03 and P-04 are dark
    const stateMap = buildStateMap({
      'P-01': { energized: true, device_id: 'DEV-01' },
      'P-02': { energized: true, device_id: 'DEV-02' },
      'P-03': { energized: false, device_id: 'DEV-03' },
      'P-04': { energized: false, device_id: 'DEV-04' },
    });

    const { faultType, faults } = bfsScan(tree, stateMap);

    expect(faultType).toBe('span');
    expect(faults).toHaveLength(1);
    expect(faults[0].upstream_pole_id).toBe('P-02');
    expect(faults[0].downstream_pole_id).toBe('P-03');
    expect(faults[0].affected).toEqual(expect.arrayContaining(['P-03', 'P-04']));
    expect(faults[0].affected).toHaveLength(2);
  });

  // Scenario 2: Sensor failure discrimination
  test('identifies sensor failure when dark pole has live children', () => {
    const poles = [
      { pole_id: 'P-01', device_id: 'DEV-01', lat: 12.97, lon: 77.59 },
      { pole_id: 'P-02', device_id: 'DEV-02', lat: 12.971, lon: 77.59 }, // ← dead modem
      { pole_id: 'P-03', device_id: 'DEV-03', lat: 12.972, lon: 77.59 }, // ← live child
    ];
    const edges = [
      { child: 'P-01', parent: null },
      { child: 'P-02', parent: 'P-01' },
      { child: 'P-03', parent: 'P-02' },
    ];
    const tree = buildMockTree(poles, edges);
    const stateMap = buildStateMap({
      'P-01': { energized: true,  device_id: 'DEV-01' },
      'P-02': { energized: false, device_id: 'DEV-02' }, // dark but power flows through
      'P-03': { energized: true,  device_id: 'DEV-03' }, // live child proves P-02 isn't a real fault
    });

    const { faults, sensorFailures } = bfsScan(tree, stateMap);

    expect(faults).toHaveLength(0);       // no real fault
    expect(sensorFailures).toContain('P-02'); // identified as sensor failure
  });

  // Scenario 3: Multi-fault on same DT (two independent dark branches)
  test('detects multiple independent span faults on the same DT', () => {
    //   DT
    //   └── P-01 (live)
    //       ├── P-02 (dark) → P-03 (dark)   FAULT 1
    //       └── P-04 (live)
    //           └── P-05 (dark)             FAULT 2
    const poles = [
      { pole_id: 'P-01', device_id: 'D1', lat: 12.97, lon: 77.59 },
      { pole_id: 'P-02', device_id: 'D2', lat: 12.971, lon: 77.59 },
      { pole_id: 'P-03', device_id: 'D3', lat: 12.972, lon: 77.59 },
      { pole_id: 'P-04', device_id: 'D4', lat: 12.97, lon: 77.591 },
      { pole_id: 'P-05', device_id: 'D5', lat: 12.971, lon: 77.591 },
    ];
    const edges = [
      { child: 'P-01', parent: null },
      { child: 'P-02', parent: 'P-01' },
      { child: 'P-03', parent: 'P-02' },
      { child: 'P-04', parent: 'P-01' },
      { child: 'P-05', parent: 'P-04' },
    ];
    const tree = buildMockTree(poles, edges);
    const stateMap = buildStateMap({
      'P-01': { energized: true,  device_id: 'D1' },
      'P-02': { energized: false, device_id: 'D2' },
      'P-03': { energized: false, device_id: 'D3' },
      'P-04': { energized: true,  device_id: 'D4' },
      'P-05': { energized: false, device_id: 'D5' },
    });

    const { faultType, faults } = bfsScan(tree, stateMap);

    expect(faultType).toBe('span');
    expect(faults).toHaveLength(2);

    const downstreamIds = faults.map((f) => f.downstream_pole_id).sort();
    expect(downstreamIds).toEqual(['P-02', 'P-05']);
  });

  // Scenario 4: DT-level fault — all poles dark
  test('escalates to DT fault when all device-equipped poles are dark', () => {
    const poles = [
      { pole_id: 'P-01', device_id: 'D1', lat: 12.97, lon: 77.59 },
      { pole_id: 'P-02', device_id: 'D2', lat: 12.971, lon: 77.59 },
    ];
    const edges = [
      { child: 'P-01', parent: null },
      { child: 'P-02', parent: 'P-01' },
    ];
    const tree = buildMockTree(poles, edges);
    const stateMap = buildStateMap({
      'P-01': { energized: false, device_id: 'D1' },
      'P-02': { energized: false, device_id: 'D2' },
    });

    const { faultType } = bfsScan(tree, stateMap);
    expect(faultType).toBe('dt');
  });

  // Scenario 5: Missing device poles don't break traversal
  test('traverses correctly when some poles have no device (unknown state)', () => {
    const poles = [
      { pole_id: 'P-01', device_id: 'D1',  lat: 12.97, lon: 77.59 },
      { pole_id: 'P-02', device_id: null,   lat: 12.971, lon: 77.59 }, // no device
      { pole_id: 'P-03', device_id: 'D3',  lat: 12.972, lon: 77.59 },
    ];
    const edges = [
      { child: 'P-01', parent: null },
      { child: 'P-02', parent: 'P-01' },
      { child: 'P-03', parent: 'P-02' },
    ];
    const tree = buildMockTree(poles, edges);
    const stateMap = buildStateMap({
      'P-01': { energized: true,  device_id: 'D1' },
      // P-02 has no state (no device)
      'P-03': { energized: false, device_id: 'D3' },
    });

    const { faults } = bfsScan(tree, stateMap);
    // Should still find the dark P-03
    expect(faults).toHaveLength(1);
    expect(faults[0].downstream_pole_id).toBe('P-03');
  });

  // Scenario 6: Reject resolution while pole still dark
  test('resolveEnergized returns false for power_lost event with missing energized field', () => {
    const { resolveEnergized } = require('../validation/telemetrySchema');
    expect(resolveEnergized({ event: 'power_lost' })).toBe(false);
    expect(resolveEnergized({ event: 'heartbeat' })).toBe(true);
    expect(resolveEnergized({ event: 'power_restored' })).toBe(true);
    expect(resolveEnergized({ event: 'boot' })).toBe(true);
    // Explicit false overrides even on heartbeat (malformed but handled)
    expect(resolveEnergized({ event: 'heartbeat', energized: false })).toBe(false);
  });
});
