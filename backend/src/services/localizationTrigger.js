'use strict';

/**
 * localizationTrigger.js — Debounced Localization Trigger
 *
 * Problem:
 *   When power cuts, dozens of poles send `power_lost` within seconds.
 *   Running localization on the first message would produce a ticket
 *   before all dark signals arrive — the affected count and boundary
 *   would be wrong.
 *
 * Solution: per-DT debounce.
 *   When a dark signal arrives for a pole in DT X, start a DEBOUNCE_MS
 *   timer for DT X. If more dark signals arrive before the timer fires,
 *   the timer resets. When the timer fires, run localization on DT X.
 *
 * This keeps localization latency to ~DEBOUNCE_MS (~20s) after the LAST
 * dark signal — well within the 120-second spec requirement.
 */

const { runLocalization } = require('./localization');
const { createTicket } = require('./ticketService');
const { getDtIdsForFeeder, getDtIdForPole } = require('./topology');

const DEBOUNCE_MS = parseInt(process.env.DEBOUNCE_MS || '20000', 10);

// debounceTimers: Map<dtId, NodeJS.Timeout>
const debounceTimers = new Map();

let _io = null; // Socket.io server reference
let _aiSummarize = null; // AI summary function (injected from aiService.js)

/** Inject dependencies at startup */
function init(io, aiSummarize = null) {
  _io = io;
  _aiSummarize = aiSummarize;
}

/**
 * Schedule (or re-schedule) localization for a DT.
 * Safe to call many times — debounce collapses rapid signals.
 *
 * @param {string} dtId
 */
function scheduleDTLocalization(dtId) {
  if (debounceTimers.has(dtId)) {
    clearTimeout(debounceTimers.get(dtId));
  }

  const timer = setTimeout(async () => {
    debounceTimers.delete(dtId);
    await runAndTicket([dtId]);
  }, DEBOUNCE_MS);

  debounceTimers.set(dtId, timer);
}

/**
 * Trigger localization immediately for a DT (no debounce).
 * Used by the simulator and test harness.
 */
async function triggerNow(dtId) {
  if (debounceTimers.has(dtId)) {
    clearTimeout(debounceTimers.get(dtId));
    debounceTimers.delete(dtId);
  }
  await runAndTicket([dtId]);
}

/**
 * Trigger localization for the DT containing a given pole.
 * Called by the ingest pipeline on `power_lost` or `watchdog_timeout`.
 *
 * @param {string} poleId
 */
function triggerForPole(poleId) {
  const dtId = getDtIdForPole(poleId);
  if (!dtId) return;
  scheduleDTLocalization(dtId);
}

/**
 * Run localization for a set of DTs and create tickets for found faults.
 */
async function runAndTicket(dtIds) {
  try {
    const faults = await runLocalization(dtIds);

    if (faults.length === 0) return;

    console.log(`[Trigger] Localization found ${faults.length} fault(s) across DTs: ${dtIds.join(', ')}`);

    for (const fault of faults) {
      const { ticket_id, created } = await createTicket(fault, _aiSummarize, _io);
      if (created) {
        console.log(`[Trigger] New ticket ${ticket_id} | type=${fault.fault_type} | conf=${fault.confidence}`);
      }
    }
  } catch (err) {
    console.error('[Trigger] Localization error:', err.message);
  }
}

module.exports = { init, triggerForPole, scheduleDTLocalization, triggerNow };
