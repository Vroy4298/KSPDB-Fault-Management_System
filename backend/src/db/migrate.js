'use strict';

const fs = require('fs');
const path = require('path');
const { pool } = require('./pool');

/**
 * Runs all SQL migration files in /migrations in filename order.
 * Each file uses CREATE TABLE IF NOT EXISTS — fully idempotent.
 */
async function runMigrations() {
  const migrationsDir = path.join(__dirname, 'migrations');
  const files = fs.readdirSync(migrationsDir).filter((f) => f.endsWith('.sql')).sort();

  console.log(`[Migrate] Running ${files.length} migration file(s)...`);

  for (const file of files) {
    const sql = fs.readFileSync(path.join(migrationsDir, file), 'utf8');
    await pool.query(sql);
    console.log(`[Migrate] ✓ ${file}`);
  }

  console.log('[Migrate] All migrations complete');
}

module.exports = { runMigrations };
