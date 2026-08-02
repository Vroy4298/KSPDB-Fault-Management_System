'use strict';

/**
 * generateNetwork.js
 *
 * Produces a synthetic but physically plausible distribution network
 * for Bangalore (SD-07 subdivision area) matching the schemas and
 * proportions in 02-data-and-systems.md:
 *
 *  - 4 substations, 12 feeders, 70 DTs, ~4,000 poles
 *  - ~40% of DTs have known topology (parent_pole_id set)
 *  - ~60% of DTs have unknown topology → MST inferred from GPS
 *  - ~9% of poles have no device
 *  - ~8% of devices run firmware 1.2.x (silent on power loss)
 *  - ~3% of poles have a missing pincode
 *  - Radial lines with 0-3 branch spurs per DT
 *
 * The MST inference uses Prim's algorithm rooted at the DT location.
 * This is the same algorithm the localization engine uses at runtime
 * for DTs whose topology is unknown.
 */

// ─── Bangalore area constants ────────────────────────────────────────────────

const CITY_CENTER = { lat: 12.9716, lon: 77.5946 };

// Approximate degree-per-metre for this latitude
const LAT_PER_M = 1 / 111000;
const LON_PER_M = 1 / (111000 * Math.cos((CITY_CENTER.lat * Math.PI) / 180));

// ─── Ward / pincode table ────────────────────────────────────────────────────

const WARDS = [
  { ward: 'W-001', pincode: '560001' },
  { ward: 'W-002', pincode: '560002' },
  { ward: 'W-003', pincode: '560003' },
  { ward: 'W-010', pincode: '560010' },
  { ward: 'W-011', pincode: '560011' },
  { ward: 'W-018', pincode: '560018' },
  { ward: 'W-027', pincode: '560027' },
  { ward: 'W-028', pincode: '560028' },
  { ward: 'W-034', pincode: '560034' },
  { ward: 'W-038', pincode: '560038' },
  { ward: 'W-051', pincode: '560051' },
  { ward: 'W-070', pincode: '560070' },
  { ward: 'W-076', pincode: '560076' },
  { ward: 'W-078', pincode: '560078' },
  { ward: 'W-084', pincode: '560084' },
  { ward: 'W-085', pincode: '560085' },
  { ward: 'W-086', pincode: '560086' },
  { ward: 'W-094', pincode: '560094' },
  { ward: 'W-095', pincode: '560095' },
  { ward: 'W-096', pincode: '560096' },
];

// ─── Utility functions ────────────────────────────────────────────────────────

/**
 * Returns the position (lat, lon) that is `distanceM` metres away from
 * (baseLat, baseLon) in the direction `angleDeg` (0 = north, 90 = east).
 */
function moveMetres(baseLat, baseLon, angleDeg, distanceM) {
  const rad = (angleDeg * Math.PI) / 180;
  return {
    lat: baseLat + distanceM * Math.cos(rad) * LAT_PER_M,
    lon: baseLon + distanceM * Math.sin(rad) * LON_PER_M,
  };
}

/**
 * Haversine distance in metres between two GPS points.
 */
function distMetres(lat1, lon1, lat2, lon2) {
  const R = 6_371_000;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLon = ((lon2 - lon1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) *
      Math.cos((lat2 * Math.PI) / 180) *
      Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function rand(min, max) {
  return min + Math.random() * (max - min);
}

function randInt(min, max) {
  return Math.floor(rand(min, max + 1));
}

/** Deterministic ward assignment from coordinates */
function wardFor(lat, lon) {
  const latBucket = Math.floor((lat - 12.955) / 0.005);
  const lonBucket = Math.floor((lon - 77.575) / 0.005);
  const idx = Math.abs(latBucket * 8 + lonBucket) % WARDS.length;
  return WARDS[idx];
}

// ─── Prim's MST — infers topology when parent_pole_id is missing ──────────────

/**
 * Builds a minimum spanning tree rooted at the DT location using
 * Prim's algorithm with Euclidean (Haversine) distances.
 *
 * This is the geometric inference strategy: poles strung along a wire
 * are physically close together, so the MST recovers the line order
 * in the common case. It fails when:
 *   - Two parallel lines are close together (MST may jump between them)
 *   - Branch spur attachment point is ambiguous
 *
 * Both failure modes are documented in ARCHITECTURE.md.
 * The result is stored with inferred=true; confidence is set to MEDIUM.
 *
 * @param {number} dtLat
 * @param {number} dtLon
 * @param {Array<{pole_id, lat, lon}>} poles
 * @returns {Array<{child_pole_id, parent_pole_id, edge_length_m}>}
 */
function primMST(dtLat, dtLon, poles) {
  if (poles.length === 0) return [];

  // visited: Map<id, {lat, lon}>  — includes virtual 'DT' root
  const visited = new Map([['DT', { lat: dtLat, lon: dtLon }]]);
  const unvisited = [...poles];
  const edges = [];

  while (unvisited.length > 0) {
    let minDist = Infinity;
    let bestPole = null;
    let bestParentId = null;

    for (const pole of unvisited) {
      for (const [parentId, parentNode] of visited) {
        const d = distMetres(parentNode.lat, parentNode.lon, pole.lat, pole.lon);
        if (d < minDist) {
          minDist = d;
          bestPole = pole;
          bestParentId = parentId;
        }
      }
    }

    if (!bestPole) break;

    edges.push({
      child_pole_id: bestPole.pole_id,
      // parent is DT virtual root → store as NULL (means "DT is parent")
      parent_pole_id: bestParentId === 'DT' ? null : bestParentId,
      edge_length_m: minDist,
    });

    visited.set(bestPole.pole_id, { lat: bestPole.lat, lon: bestPole.lon });
    unvisited.splice(unvisited.indexOf(bestPole), 1);
  }

  return edges;
}

// ─── Network generator ────────────────────────────────────────────────────────

function generateNetwork() {
  const feeders = [];
  const dts = [];
  const poles = [];
  const topologyEdges = [];
  const poleStates = [];

  let dtCounter = 1;
  let poleCounter = 1;

  // 4 substation anchor points spread across the city grid
  const substationAnchors = [
    { subId: 'SS-01', lat: 12.990, lon: 77.578 },
    { subId: 'SS-02', lat: 12.990, lon: 77.612 },
    { subId: 'SS-03', lat: 12.955, lon: 77.578 },
    { subId: 'SS-04', lat: 12.955, lon: 77.612 },
  ];

  // 12 feeders: 3 per substation, each pointing in a different direction
  const feederDirections = [30, 120, 210]; // degrees (N-ish, E-ish, SW-ish)
  const dtsPerFeeder = [6, 6, 6, 6, 5, 6, 5, 6, 6, 6, 6, 6]; // sums to 70

  substationAnchors.forEach(({ subId, lat: ssLat, lon: ssLon }, ssIdx) => {
    feederDirections.forEach((feederAngle, fIdx) => {
      const feederId = `F-${String(ssIdx * 3 + fIdx + 1).padStart(2, '0')}`;
      feeders.push({ feeder_id: feederId, substation_id: subId, name: `${subId} Feeder ${fIdx + 1}` });

      const feederIndex = ssIdx * 3 + fIdx;
      const numDTs = dtsPerFeeder[feederIndex];

      // Determine topology availability for each DT in this feeder
      // We want ~40% known across the whole network
      // Use a counter-based approach: every 3rd DT has known topology  
      for (let d = 0; d < numDTs; d++) {
        const dtId = `D-${String(dtCounter).padStart(4, '0')}`;
        // 40% of DTs have known topology (seq_on_line + parent_pole_id recorded)
        const hasKnownTopology = dtCounter % 5 <= 1; // positions 1,0 = 2/5 = 40%

        // DT position: spaced along the feeder with slight angle variation
        const dtDist = (d + 1) * 350 + rand(-80, 80);
        const dtAngleVariation = rand(-25, 25);
        const { lat: dtLat, lon: dtLon } = moveMetres(
          ssLat, ssLon,
          feederAngle + dtAngleVariation,
          dtDist
        );

        dts.push({
          dt_id: dtId,
          feeder_id: feederId,
          lat: dtLat,
          lon: dtLon,
          capacity_kva: [100, 160, 200, 250, 315, 400][randInt(0, 5)],
          households_served: randInt(50, 420),
        });

        // ── Generate poles for this DT ──────────────────────────────────
        const dtPoles = []; // poles belonging to this DT (for MST later)

        // Main line direction: roughly perpendicular to feeder direction
        const mainAngle = feederAngle + 90 + rand(-30, 30);
        const mainLineLength = randInt(18, 55);
        const numBranches = randInt(0, 3);

        // Helper to add a pole to all collections
        const addPole = (lat, lon, parentId, seqNum) => {
          const poleId = `P-${String(poleCounter).padStart(6, '0')}`;
          const hasDevice = Math.random() > 0.09;       // 91% have devices
          const isFw12 = hasDevice && Math.random() < 0.08;  // 8% of devices are fw 1.2.x
          const ward = wardFor(lat, lon);
          const missingPincode = Math.random() < 0.03; // 3% missing pincode

          const deviceId = hasDevice
            ? `KSPDB-SD07-${dtId}-${String(poleCounter).padStart(4, '0')}`
            : null;

          const pole = {
            pole_id: poleId,
            lat,
            lon,
            feeder_id: feederId,
            dt_id: dtId,
            seq_on_line: hasKnownTopology ? seqNum : null,
            parent_pole_id: hasKnownTopology ? (parentId || null) : null,
            pole_type: Math.random() > 0.3 ? 'LT-9m-PCC' : 'LT-8m-Steel',
            ward: ward.ward,
            pincode: missingPincode ? null : ward.pincode,
            device_id: deviceId,
            fw_version: !hasDevice ? null : isFw12 ? '1.2.1' : '1.4.2',
          };

          poles.push(pole);
          dtPoles.push(pole);

          // Known topology: build edge directly from parent_pole_id
          if (hasKnownTopology) {
            topologyEdges.push({
              child_pole_id: poleId,
              parent_pole_id: parentId || null, // null = DT is parent
              dt_id: dtId,
              inferred: false,
              edge_length_m: parentId
                ? distMetres(lat, lon, /* need parent lat/lon — computed below */ 0, 0)
                : 0,
            });
          }

          // Initial pole_state: all poles start energized
          if (hasDevice) {
            poleStates.push({
              pole_id: poleId,
              energized: true,
              last_seen: new Date().toISOString(),
              last_event: 'heartbeat',
              last_seq: randInt(100, 9999),
              device_id: deviceId,
              battery_mv: randInt(3600, 4000),
              rssi: randInt(-100, -65),
              fw: pole.fw_version,
            });
          }

          poleCounter++;
          return pole;
        };

        // ── Main line ────────────────────────────────────────────────
        let lastLat = dtLat;
        let lastLon = dtLon;
        let lastPoleId = null;
        let seq = 1;

        // Track main line poles for branch attachment
        const mainLinePoles = [];

        for (let p = 0; p < mainLineLength; p++) {
          const spacing = rand(30, 50);
          const jitter = rand(-10, 10);
          const { lat, lon } = moveMetres(lastLat, lastLon, mainAngle + jitter, spacing);
          const pole = addPole(lat, lon, lastPoleId, seq);

          // Fix edge_length_m for known topology (we had 0 above — fix it)
          if (hasKnownTopology && topologyEdges.length > 0) {
            const edge = topologyEdges[topologyEdges.length - 1];
            edge.edge_length_m = distMetres(lat, lon, lastLat, lastLon);
          }

          mainLinePoles.push(pole);
          lastLat = lat;
          lastLon = lon;
          lastPoleId = pole.pole_id;
          seq++;
        }

        // ── Branch spurs ─────────────────────────────────────────────
        for (let b = 0; b < numBranches; b++) {
          const branchLength = randInt(4, 18);
          // Branch starts from a random point on the main line (not the last pole)
          const startIdx = randInt(0, Math.max(0, mainLinePoles.length - 3));
          const branchParent = mainLinePoles[startIdx];

          let bLat = branchParent.lat;
          let bLon = branchParent.lon;
          let bParentId = branchParent.pole_id;
          // Branches go off at roughly 60-120° from the main line
          const branchAngle = mainAngle + (Math.random() > 0.5 ? 1 : -1) * rand(60, 120);

          for (let p = 0; p < branchLength; p++) {
            const spacing = rand(30, 50);
            const jitter = rand(-10, 10);
            const { lat, lon } = moveMetres(bLat, bLon, branchAngle + jitter, spacing);
            const pole = addPole(lat, lon, bParentId, seq);

            if (hasKnownTopology && topologyEdges.length > 0) {
              const edge = topologyEdges[topologyEdges.length - 1];
              edge.edge_length_m = distMetres(lat, lon, bLat, bLon);
            }

            bLat = lat;
            bLon = lon;
            bParentId = pole.pole_id;
            seq++;
          }
        }

        // ── Unknown topology: run MST inference ──────────────────────
        if (!hasKnownTopology && dtPoles.length > 0) {
          const inferredEdges = primMST(dtLat, dtLon, dtPoles);
          inferredEdges.forEach((e) =>
            topologyEdges.push({ ...e, dt_id: dtId, inferred: true })
          );
        }

        dtCounter++;
      }
    });
  });

  // ── Seed some scheduled outages for demo purposes ─────────────────────────
  const now = new Date();
  const in2Hours = new Date(now.getTime() + 2 * 60 * 60 * 1000);
  const in4Hours = new Date(now.getTime() + 4 * 60 * 60 * 1000);

  const scheduledOutages = [
    {
      id: 'SO-DEMO-001',
      scope: 'feeder',
      target_id: 'F-12',
      start_time: in2Hours.toISOString(),
      end_time: in4Hours.toISOString(),
      reason: 'Planned maintenance — jumper replacement',
    },
    {
      id: 'SO-DEMO-002',
      scope: 'dt',
      target_id: 'D-0003',
      start_time: in2Hours.toISOString(),
      end_time: new Date(now.getTime() + 3 * 60 * 60 * 1000).toISOString(),
      reason: 'Load shedding — residential rotation',
    },
  ];

  console.log(`[Seed] Network summary:`);
  console.log(`  Feeders:          ${feeders.length}`);
  console.log(`  DTs:              ${dts.length} (${dts.length - Math.round(dts.length * 0.4)} unknown topology)`);
  console.log(`  Poles:            ${poles.length}`);
  console.log(`  Topology edges:   ${topologyEdges.length}`);
  console.log(`  Pole states:      ${poleStates.length}`);
  console.log(`  With devices:     ${poleStates.length} (~${Math.round((poleStates.length / poles.length) * 100)}%)`);

  return { feeders, dts, poles, topologyEdges, poleStates, scheduledOutages };
}

module.exports = { generateNetwork, primMST, distMetres };
