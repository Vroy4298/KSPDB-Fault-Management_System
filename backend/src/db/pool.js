'use strict';

const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 20,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 10000,
});

pool.on('error', (err) => {
  console.error('[DB] Unexpected pool error:', err.message);
});

/**
 * Wait for the database to accept connections.
 * Retries with exponential backoff up to maxRetries times.
 */
async function waitForDB(maxRetries = 20, delayMs = 2000) {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const client = await pool.connect();
      await client.query('SELECT 1');
      client.release();
      console.log('[DB] Connected successfully');
      return;
    } catch (err) {
      console.log(`[DB] Waiting for database... attempt ${attempt}/${maxRetries} (${err.message})`);
      if (attempt === maxRetries) throw new Error('[DB] Could not connect to database after max retries');
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
}

module.exports = { pool, waitForDB };
