'use strict';

const { telemetrySchema, resolveEnergized } = require('../validation/telemetrySchema');

describe('Telemetry Ingest - Schema & Validation', () => {
  test('validates standard heartbeat telemetry', () => {
    const raw = {
      device_id: 'KSPDB-SD07-D-0001-0001',
      pole_id: 'P-000001',
      event: 'heartbeat',
      energized: true,
      ts: '2026-08-02T12:00:00.000Z',
      seq: 101,
      battery_mv: 3850,
      rssi: -75,
      fw: '1.4.2',
    };

    const res = telemetrySchema.safeParse(raw);
    expect(res.success).toBe(true);
    expect(res.data.pole_id).toBe('P-000001');
  });

  test('validates legacy fw 1.2 payload (missing ts, seq, energized)', () => {
    const raw = {
      device_id: 'KSPDB-SD07-D-0001-0002',
      pole_id: 'P-000002',
      event: 'power_lost',
      fw: '1.2.1',
    };

    const res = telemetrySchema.safeParse(raw);
    expect(res.success).toBe(true);
    expect(res.data.energized).toBeUndefined();

    // Test resolveEnergized fallback
    expect(resolveEnergized(res.data)).toBe(false);
  });

  test('rejects invalid event type', () => {
    const raw = {
      device_id: 'DEV-1',
      pole_id: 'P-000001',
      event: 'explosion', // invalid
    };

    const res = telemetrySchema.safeParse(raw);
    expect(res.success).toBe(false);
  });

  test('strips unknown fields to prevent injection', () => {
    const raw = {
      device_id: 'KSPDB-SD07-D-0001-0001',
      pole_id: 'P-000001',
      event: 'heartbeat',
      malicious_field: "'; DROP TABLE poles; --",
    };

    const res = telemetrySchema.safeParse(raw);
    expect(res.success).toBe(true);
    expect(res.data.malicious_field).toBeUndefined();
  });
});
