'use strict';

const { z } = require('zod');

/**
 * Zod schema for a single telemetry payload.
 * Based on the exact payload contract in 02-data-and-systems.md §2.
 *
 * Design choices:
 * - `ts` is optional because fw 1.2.x may omit it.
 * - `seq` is optional for the same reason; dedup is skipped when absent.
 * - `energized` defaults by event type when absent (legacy firmware).
 * - Extra fields are stripped (strict mode) to prevent injection.
 */
const telemetrySchema = z.object({
  device_id: z.string().min(1).max(60),
  pole_id:   z.string().min(1).max(20),
  event:     z.enum(['heartbeat', 'power_lost', 'power_restored', 'boot']),
  energized: z.boolean().optional(),
  ts:        z.string().datetime({ offset: true }).optional(),
  seq:       z.number().int().min(0).optional(),
  battery_mv: z.number().int().min(0).max(5000).optional(),
  rssi:      z.number().int().min(-150).max(0).optional(),
  fw:        z.string().max(20).optional(),
}).strip(); // discard unknown fields

/**
 * Derive energized state from event when the field is missing.
 * power_lost → false; everything else → true.
 */
function resolveEnergized(payload) {
  if (payload.energized !== undefined) return payload.energized;
  return payload.event !== 'power_lost';
}

/**
 * Batch schema: array of telemetry payloads.
 * Used by the simulator and load tests.
 */
const batchSchema = z.array(telemetrySchema).min(1).max(5000);

module.exports = { telemetrySchema, batchSchema, resolveEnergized };
