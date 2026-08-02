'use strict';

require('dotenv').config();

const express = require('express');
const cors = require('cors');
const morgan = require('morgan');
const http = require('http');
const { Server: SocketIO } = require('socket.io');

const { waitForDB } = require('./db/pool');
const { runMigrations } = require('./db/migrate');
const { runSeed } = require('./seed/index');
const { startWatchdog } = require('./services/heartbeatWatchdog');

// ─── Routes (stub — expanded in each Phase) ──────────────────────────────────
const healthRouter = require('./routes/health');

// ─── App setup ───────────────────────────────────────────────────────────────

const app = express();
const httpServer = http.createServer(app);

// Socket.io for real-time operator console updates
const io = new SocketIO(httpServer, {
  cors: { origin: '*', methods: ['GET', 'POST'] },
  path: '/socket.io',
});

// Attach io to app so route handlers can emit events
app.set('io', io);

// ─── Middleware ───────────────────────────────────────────────────────────────

app.use(cors());
app.use(express.json({ limit: '1mb' }));
app.use(morgan(process.env.NODE_ENV === 'production' ? 'combined' : 'dev'));

// ─── Routes ───────────────────────────────────────────────────────────────────

app.use('/api/health', healthRouter);
app.use('/api/ingest', require('./routes/ingest'));

// Phase 4 — tickets
// app.use('/api/tickets', require('./routes/tickets'));

// Phase 5 — topology + scheduled outages
// app.use('/api/topology', require('./routes/topology'));
// app.use('/api/scheduled-outages', require('./routes/scheduledOutages'));

// Phase 6 — simulator
// app.use('/api/simulator', require('./routes/simulator'));

// 404 catch-all
app.use((_req, res) => res.status(404).json({ error: 'Not found' }));

// ─── Socket.io connection handler ────────────────────────────────────────────

io.on('connection', (socket) => {
  console.log(`[WS] Client connected: ${socket.id}`);
  socket.on('disconnect', () => {
    console.log(`[WS] Client disconnected: ${socket.id}`);
  });
});

// ─── Startup sequence ─────────────────────────────────────────────────────────

async function start() {
  const PORT = parseInt(process.env.PORT || '3000', 10);

  try {
    // 1. Wait for PostgreSQL to be ready (handles Docker startup race)
    console.log('[Server] Waiting for database...');
    await waitForDB();

    // 2. Run migrations (idempotent — safe to run every boot)
    console.log('[Server] Running migrations...');
    await runMigrations();

    // 3. Seed with synthetic network if database is empty
    console.log('[Server] Checking seed data...');
    await runSeed();

    // 4. Start heartbeat watchdog for silent fw 1.2 devices
    startWatchdog(io);

    // 5. Start HTTP + WebSocket server
    httpServer.listen(PORT, '0.0.0.0', () => {
      console.log(`[Server] ✓ Listening on port ${PORT}`);
      console.log(`[Server] Health: http://localhost:${PORT}/api/health`);
    });
  } catch (err) {
    console.error('[Server] Fatal startup error:', err);
    process.exit(1);
  }
}

start();

// Export io so other modules can emit events
module.exports = { io };
