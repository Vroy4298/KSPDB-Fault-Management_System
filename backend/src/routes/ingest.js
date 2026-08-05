'use strict';

const { Router } = require('express');
const { telemetrySchema, batchSchema } = require('../validation/telemetrySchema');
const { processEvent, processBatch } = require('../services/ingestService');

const router = Router();

/**
 * POST /api/ingest/telemetry
 * Single telemetry event ingest endpoint.
 *
 * Request body: single JSON telemetry payload
 * Response: 200 OK with processing status
 */
router.post('/telemetry', async (req, res) => {
  try {
    const parseResult = telemetrySchema.safeParse(req.body);
    if (!parseResult.success) {
      return res.status(400).json({
        error: 'Invalid telemetry payload',
        details: parseResult.error.flatten(),
      });
    }

    const payload = parseResult.data;
    const result = await processEvent(payload);

    const io = req.app.get('io');
    if (io) {
      io.emit('telemetry:event', {
        pole_id: payload.pole_id,
        device_id: payload.device_id,
        event: payload.event,
        energized: result.energized,
        status: result.status,
        received_at: new Date().toISOString(),
      });
    }

    return res.status(200).json({
      status: result.status,
      pole_id: payload.pole_id,
      energized: result.energized,
    });
  } catch (err) {
    console.error('[Ingest API] Error processing single telemetry:', err.message);
    return res.status(500).json({ error: 'Internal server error', message: err.message });
  }
});

/**
 * POST /api/ingest/telemetry/batch
 * Batch telemetry event ingest endpoint.
 * Useful for simulator high-throughput bursts.
 *
 * Request body: Array of telemetry payloads (1 to 5000 items)
 * Response: 200 OK with summary statistics
 */
router.post('/telemetry/batch', async (req, res) => {
  try {
    const parseResult = batchSchema.safeParse(req.body);
    if (!parseResult.success) {
      return res.status(400).json({
        error: 'Invalid batch telemetry payload',
        details: parseResult.error.flatten(),
      });
    }

    const payloads = parseResult.data;
    const summary = await processBatch(payloads);

    const io = req.app.get('io');
    if (io) {
      io.emit('telemetry:batch', {
        count: payloads.length,
        processed: summary.processed,
        duplicates: summary.duplicates,
        received_at: new Date().toISOString(),
      });
    }

    return res.status(200).json({
      status: 'ok',
      count: payloads.length,
      processed: summary.processed,
      duplicates: summary.duplicates,
    });
  } catch (err) {
    console.error('[Ingest API] Error processing batch telemetry:', err.message);
    return res.status(500).json({ error: 'Internal server error', message: err.message });
  }
});

module.exports = router;
