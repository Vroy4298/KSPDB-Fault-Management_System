'use strict';

const { Router } = require('express');
const { getTickets, getTicketById, updateTicketStatus } = require('../services/ticketService');

const router = Router();

/**
 * GET /api/tickets
 * Returns all tickets, newest first. Optional ?status= filter.
 */
router.get('/', async (req, res) => {
  try {
    const { status, limit = 50, offset = 0 } = req.query;
    const tickets = await getTickets({ status, limit: parseInt(limit), offset: parseInt(offset) });
    res.json({ tickets, count: tickets.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/tickets/:id
 * Returns a single ticket with affected pole IDs.
 */
router.get('/:id', async (req, res) => {
  try {
    const ticket = await getTicketById(req.params.id);
    if (!ticket) return res.status(404).json({ error: 'Ticket not found' });
    res.json(ticket);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * PATCH /api/tickets/:id
 * Transition ticket status. Body: { status: 'acknowledged' | 'crew_assigned' | ... }
 */
router.patch('/:id', async (req, res) => {
  try {
    const { status } = req.body;
    if (!status) return res.status(400).json({ error: 'Body must include { status }' });

    const io = req.app.get('io');
    const result = await updateTicketStatus(req.params.id, status, io);

    if (!result.ok) {
      return res.status(409).json({ error: result.reason });
    }
    res.json({ ok: true, id: req.params.id, status });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
