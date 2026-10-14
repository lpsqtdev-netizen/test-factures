'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const Database = require('better-sqlite3');

function normalizeSnapshot(snapshot) {
  if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot) ||
      !Array.isArray(snapshot.orders) || !Array.isArray(snapshot.couriers)) {
    throw new Error('Structure JSON invalide : les listes orders et couriers sont requises.');
  }
  return {
    ...snapshot,
    audit: Array.isArray(snapshot.audit) ? snapshot.audit : [],
    users: Array.isArray(snapshot.users) ? snapshot.users : [],
    settingsByUser: snapshot.settingsByUser && typeof snapshot.settingsByUser === 'object' &&
      !Array.isArray(snapshot.settingsByUser) ? snapshot.settingsByUser : {}
  };
}

function migrate(sourceArg, targetArg) {
  if (!sourceArg || !targetArg) {
    throw new Error('Usage : node scripts/migrate-store-to-sqlite.js <store.json> <store.sqlite>');
  }
  const source = path.resolve(sourceArg);
  const target = path.resolve(targetArg);
  if (source === target) throw new Error('Les chemins source et destination doivent être différents.');
  const sourceBytes = fs.readFileSync(source);
  let snapshot;
  try {
    snapshot = normalizeSnapshot(JSON.parse(sourceBytes.toString('utf8')));
  } catch (err) {
    throw new Error('Migration annulée : ' + err.message);
  }
  const sourceHash = crypto.createHash('sha256').update(sourceBytes).digest('hex');
  fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
  const db = new Database(target);
  try {
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    db.exec(`
      CREATE TABLE IF NOT EXISTS app_state (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        payload TEXT NOT NULL,
        source_sha256 TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        applied_at TEXT NOT NULL
      );
    `);
    const existing = db.prepare('SELECT source_sha256 FROM app_state WHERE id = 1').get();
    if (existing) {
      if (existing.source_sha256 === sourceHash) {
        process.stdout.write('Migration déjà effectuée : aucune modification.\n');
        return { migrated: false, sourceHash };
      }
      throw new Error('La base cible contient déjà un état différent. Aucune donnée n’a été écrasée.');
    }
    const now = new Date().toISOString();
    const write = db.transaction(() => {
      db.prepare('INSERT INTO app_state (id, payload, source_sha256, updated_at) VALUES (1, ?, ?, ?)')
        .run(JSON.stringify(snapshot), sourceHash, now);
      db.prepare('INSERT INTO schema_migrations (version, name, applied_at) VALUES (1, ?, ?)')
        .run('initial-json-snapshot', now);
    });
    write();
    fs.chmodSync(target, 0o600);
    process.stdout.write('Migration SQLite terminée. Le fichier JSON source a été conservé.\n');
    return { migrated: true, sourceHash };
  } finally {
    db.close();
  }
}

if (require.main === module) {
  try {
    migrate(process.argv[2], process.argv[3]);
  } catch (err) {
    process.stderr.write('Échec de migration : ' + err.message + '\n');
    process.exitCode = 1;
  }
}

module.exports = { migrate, normalizeSnapshot };
