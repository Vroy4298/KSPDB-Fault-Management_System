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
const { buildTopologyCache } = require('./services/topology');
const { init: initTrigger } = require('./services/localizationTrigger');
const { summarizeFault } = require('./services/aiService');

const healthRouter = require('./routes/health');

const app = express();
const httpServer = http.createServer(app);

const io = new SocketIO(httpServer, {
  cors: { origin: '*', methods: ['GET', 'POST'] },
  path: '/socket.io',
});

app.set('io', io);

app.use(cors());
app.use(express.json({ limit: '1mb' }));
app.use(morgan(process.env.NODE_ENV === 'production' ? 'combined' : 'dev'));

app.use('/api/health',   healthRouter);
app.use('/api/ingest',   require('./routes/ingest'));
app.use('/api/tickets',  require('./routes/tickets'));
app.use('/api/topology', require('./routes/topology'));
app.use('/api/simulator', require('./routes/simulator'));

const path = require('path');
const fs = require('fs');
const frontendDist = path.join(__dirname, '../../frontend/dist');
if (fs.existsSync(frontendDist)) {
  app.use(express.static(frontendDist));
  app.get('*', (req, res, next) => {
    if (req.path.startsWith('/api') || req.path.startsWith('/socket.io')) return next();
    res.sendFile(path.join(frontendDist, 'index.html'));
  });
}

app.use((_req, res) => res.status(404).json({ error: 'Not found' }));

io.on('connection', (socket) => {
  console.log(`[WS] Client connected: ${socket.id}`);
  socket.on('disconnect', () => {
    console.log(`[WS] Client disconnected: ${socket.id}`);
  });
});

async function start() {
  const PORT = parseInt(process.env.PORT || '3000', 10);

  try {
    console.log('[Server] Waiting for database...');
    await waitForDB();

    console.log('[Server] Running migrations...');
    await runMigrations();

    console.log('[Server] Checking seed data...');
    await runSeed();

    await buildTopologyCache();
    initTrigger(io, summarizeFault);
    startWatchdog(io);

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

module.exports = { io };

