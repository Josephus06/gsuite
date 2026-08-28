// Points a one-off script at a database other than the one in server/.env.
//
// These scripts reach the database through ../db, which builds its pool from process.env at
// require time and never re-reads it. So the environment has to be settled BEFORE that module
// is required -- which is why this is a function called on the first line of a script rather
// than something it can do for itself:
//
//   require('./lib/env')();          // or require('./lib/env')() from db/, './lib/env' from db/lib
//   const pool = require('../db');
//
// The base server/.env always loads first and an --env=<name> overlays server/.env.<name> on
// top of it, so credentials that live only in the base file (the live-site login the importers
// use) survive while DB_* is redirected:
//
//   node src/db/some-script.js --env=railway
//
// Paths are resolved from this file rather than the working directory, so a script runs the
// same whether it was started from server/ or from the repo root.
const fs = require('fs');
const path = require('path');

const SERVER_DIR = path.join(__dirname, '..', '..', '..');

module.exports = function loadEnv(argv = process.argv) {
  require('dotenv').config({ path: path.join(SERVER_DIR, '.env') });

  const arg = argv.find((a) => a.startsWith('--env='));
  if (!arg) return null;

  const name = arg.slice('--env='.length).trim();
  if (!name) throw new Error('--env needs a name, e.g. --env=railway');
  const file = path.join(SERVER_DIR, `.env.${name}`);
  if (!fs.existsSync(file)) {
    throw new Error(`No such env file: ${file}. Expected server/.env.${name}`);
  }
  const loaded = require('dotenv').config({ path: file, override: true });
  if (loaded.error) throw new Error(`Cannot read ${file}: ${loaded.error.message}`);
  return name;
};
