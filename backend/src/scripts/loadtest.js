'use strict';

/**
 * loadtest.js — Throughput verification for the telemetry ingest pipeline
 *
 * Usage:
 *   node backend/src/scripts/loadtest.js [--url http://localhost:3000] [--count 5000] [--batch 500]
 *
 * Generates `count` synthetic telemetry events (unique device+pole+seq combos)
 * and sends them via POST /api/ingest/telemetry/batch in groups of `batch`.
 *
 * Reports:
 *   - Total messages sent
 *   - Total time
 *   - Messages/second (must be >= 500 to pass spec)
 *   - HTTP error count
 *   - Duplicate detection count
 */

const http = require('http');
const https = require('https');

// ─── CLI args ─────────────────────────────────────────────────────────────────
const args = process.argv.slice(2).reduce((acc, arg, i, arr) => {
  if (arg.startsWith('--')) acc[arg.slice(2)] = arr[i + 1];
  return acc;
}, {});

const BASE_URL  = args.url   || 'http://localhost:3000';
const COUNT     = parseInt(args.count || '5000', 10);
const BATCH     = parseInt(args.batch || '500', 10);

// ─── Message generator ────────────────────────────────────────────────────────

const EVENTS = ['power_lost', 'heartbeat', 'power_restored'];
const FWS    = ['1.4.2', '1.4.1', '1.2.3', '1.2.1'];

function generateBatch(startSeq, size) {
  const msgs = [];
  for (let i = 0; i < size; i++) {
    const seq   = startSeq + i;
    const poleN = String(1 + (seq % 3769)).padStart(6, '0');
    const event = EVENTS[seq % EVENTS.length];
    msgs.push({
      device_id:  `KSPDB-SD07-D-LT-${poleN}`,
      pole_id:    `P-${poleN}`,
      event,
      energized:  event !== 'power_lost',
      ts:         new Date().toISOString(),
      seq,
      battery_mv: 3700 + (seq % 200),
      rssi:       -(60 + (seq % 40)),
      fw:         FWS[seq % FWS.length],
    });
  }
  return msgs;
}

// ─── HTTP helpers ─────────────────────────────────────────────────────────────

function post(url, payload) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(payload);
    const parsed = new URL(url);
    const lib  = parsed.protocol === 'https:' ? https : http;

    const req = lib.request(
      {
        hostname: parsed.hostname,
        port:     parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
        path:     parsed.pathname,
        method:   'POST',
        headers:  {
          'Content-Type':   'application/json',
          'Content-Length': Buffer.byteLength(body),
        },
      },
      (res) => {
        let data = '';
        res.on('data', (chunk) => (data += chunk));
        res.on('end', () => {
          try {
            resolve({ status: res.statusCode, body: JSON.parse(data) });
          } catch {
            resolve({ status: res.statusCode, body: data });
          }
        });
      }
    );
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log('\n======================================');
  console.log(' KSPDB Telemetry Ingest — Load Test');
  console.log('======================================');
  console.log(`Target:  ${BASE_URL}`);
  console.log(`Messages: ${COUNT}`);
  console.log(`Batch size: ${BATCH}`);
  console.log('--------------------------------------\n');

  // Warm-up: one small batch to initialise connections
  await post(`${BASE_URL}/api/ingest/telemetry/batch`, generateBatch(0, 10));
  console.log('Warm-up complete.');

  let totalProcessed = 0;
  let totalDuplicates = 0;
  let totalErrors = 0;
  let seq = 1000000; // start high to avoid collisions with seed data

  const startMs = Date.now();

  for (let sent = 0; sent < COUNT; sent += BATCH) {
    const batchSize = Math.min(BATCH, COUNT - sent);
    const batch = generateBatch(seq, batchSize);
    seq += batchSize;

    try {
      const result = await post(`${BASE_URL}/api/ingest/telemetry/batch`, batch);
      if (result.status === 200) {
        totalProcessed  += result.body.processed  || 0;
        totalDuplicates += result.body.duplicates || 0;
      } else {
        totalErrors++;
        console.warn(`  HTTP ${result.status} on batch at seq=${seq}`);
      }
    } catch (err) {
      totalErrors++;
      console.warn(`  Network error: ${err.message}`);
    }

    // Progress update every 1000 messages
    if ((sent + batchSize) % 1000 === 0) {
      const elapsed = (Date.now() - startMs) / 1000;
      const rate    = Math.round((sent + batchSize) / elapsed);
      process.stdout.write(`\r  Progress: ${sent + batchSize}/${COUNT}  |  ${rate} msg/s   `);
    }
  }

  const elapsed   = (Date.now() - startMs) / 1000;
  const throughput = Math.round(COUNT / elapsed);

  console.log('\n\n======================================');
  console.log(' Results');
  console.log('======================================');
  console.log(`Total sent:       ${COUNT}`);
  console.log(`Total processed:  ${totalProcessed}`);
  console.log(`Duplicates:       ${totalDuplicates}`);
  console.log(`HTTP errors:      ${totalErrors}`);
  console.log(`Elapsed:          ${elapsed.toFixed(2)}s`);
  console.log(`Throughput:       ${throughput} msg/s`);
  console.log('--------------------------------------');

  const pass = throughput >= 500;
  console.log(`\nSpec requirement: >= 500 msg/s`);
  console.log(`Result: ${pass ? '✓ PASS' : '✗ FAIL'} (${throughput} msg/s)\n`);

  process.exit(pass ? 0 : 1);
}

main().catch((err) => {
  console.error('Load test failed:', err);
  process.exit(1);
});
