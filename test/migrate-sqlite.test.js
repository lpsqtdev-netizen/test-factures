'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const Database = require('better-sqlite3');

const root = path.join(__dirname, '..');
const script = path.join(root, 'scripts', 'migrate-store-to-sqlite.js');

test('migrates a JSON snapshot transactionally and keeps the source intact', async () => {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'petale-sqlite-migrate-'));
  try {
    const source = path.join(dir, 'store.json');
    const target = path.join(dir, 'store.sqlite');
    const snapshot = {
      orders: [{ id: 'PET-9001', status: 'À préparer' }],
      couriers: [{ id: 'courier-a' }],
      users: [{ id: 'user-a', role: 'fleuriste' }],
      audit: [{ id: 'event-a' }],
      settingsByUser: { 'user-a': { shopName: 'Fleurs Alpha' } }
    };
    const original = JSON.stringify(snapshot);
    await fs.promises.writeFile(source, original, { mode: 0o600 });
    const migrated = spawnSync(process.execPath, [script, source, target], { encoding: 'utf8' });
    assert.equal(migrated.status, 0, migrated.stderr);
    assert.match(migrated.stdout, /Migration SQLite terminée/);
    assert.equal(await fs.promises.readFile(source, 'utf8'), original);

    const db = new Database(target, { readonly: true });
    try {
      const state = db.prepare('SELECT payload, source_sha256 FROM app_state WHERE id = 1').get();
      const restored = JSON.parse(state.payload);
      assert.equal(restored.orders[0].id, 'PET-9001');
      assert.equal(restored.users[0].id, 'user-a');
      assert.equal(restored.audit[0].id, 'event-a');
      assert.equal(restored.settingsByUser['user-a'].shopName, 'Fleurs Alpha');
      assert.equal(db.prepare('SELECT COUNT(*) AS count FROM schema_migrations').get().count, 1);
      assert.match(state.source_sha256, /^[a-f0-9]{64}$/);
    } finally {
      db.close();
    }
    if (process.platform !== 'win32') assert.equal((await fs.promises.stat(target)).mode & 0o077, 0);
  } finally {
    await fs.promises.rm(dir, { recursive: true, force: true });
  }
});

test('migration is idempotent and refuses to overwrite a different database state', async () => {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'petale-sqlite-idempotent-'));
  try {
    const source = path.join(dir, 'store.json');
    const target = path.join(dir, 'store.sqlite');
    await fs.promises.writeFile(source, JSON.stringify({ orders: [], couriers: [] }));
    const first = spawnSync(process.execPath, [script, source, target], { encoding: 'utf8' });
    assert.equal(first.status, 0, first.stderr);
    const second = spawnSync(process.execPath, [script, source, target], { encoding: 'utf8' });
    assert.equal(second.status, 0, second.stderr);
    assert.match(second.stdout, /déjà effectuée/);

    await fs.promises.writeFile(source, JSON.stringify({ orders: [{ id: 'PET-NEW' }], couriers: [] }));
    const third = spawnSync(process.execPath, [script, source, target], { encoding: 'utf8' });
    assert.notEqual(third.status, 0);
    assert.match(third.stderr, /aucune donnée n’a été écrasée/);
  } finally {
    await fs.promises.rm(dir, { recursive: true, force: true });
  }
});

test('rejects malformed JSON without creating a destination database', async () => {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'petale-sqlite-invalid-'));
  try {
    const source = path.join(dir, 'broken.json');
    const target = path.join(dir, 'store.sqlite');
    await fs.promises.writeFile(source, JSON.stringify({ orders: 'invalid', couriers: [] }));
    const result = spawnSync(process.execPath, [script, source, target], { encoding: 'utf8' });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Migration annulée/);
    assert.equal(fs.existsSync(target), false);
  } finally {
    await fs.promises.rm(dir, { recursive: true, force: true });
  }
});
