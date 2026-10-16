'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Database = require('better-sqlite3');

test('SQLite mode imports legacy JSON, persists changes transactionally and reports its backend', async () => {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'petale-sqlite-store-'));
  const source = path.join(dir, 'store.json');
  const databasePath = path.join(dir, 'store.sqlite');
  const original = {
    orders: [{ id: 'PET-7001', status: 'À préparer', name: 'Client migration' }],
    couriers: [{ id: 'courier-demo', name: 'Livreur démo' }],
    users: [{ id: 'florist-a', email: 'a@petale.test', role: 'fleuriste' }],
    audit: [{ id: 'event-migration', action: 'migration.test' }],
    settingsByUser: { 'florist-a': { shopName: 'Fleurs de test' } }
  };
  await fs.promises.writeFile(source, JSON.stringify(original), { mode: 0o600 });
  process.env.PETAL_STORE_PATH = source;
  process.env.PETAL_DATABASE_PATH = databasePath;
  let serverModule;
  let server;
  try {
    serverModule = require('../server');
    const imported = await serverModule.loadStore();
    assert.equal(imported.orders[0].id, 'PET-7001');
    assert.equal(imported.users[0].email, 'a@petale.test');
    assert.equal(imported.settingsByUser['florist-a'].shopName, 'Fleurs de test');
    assert.equal(await fs.promises.readFile(source, 'utf8'), JSON.stringify(original));

    imported.orders.unshift({ id: 'PET-7002', status: 'À préparer' });
    await serverModule.saveStore(imported);
    const backupDir = databasePath + '.backups';
    const backups = (await fs.promises.readdir(backupDir)).filter(name => name.endsWith('.sqlite'));
    assert.equal(backups.length, 1);
    if (process.platform !== 'win32') assert.equal((await fs.promises.stat(path.join(backupDir, backups[0]))).mode & 0o077, 0);

    for (let index = 0; index < 10; index += 1) {
      imported.orders[0].backupTestMarker = 'revision-' + index;
      await serverModule.saveStore(imported);
    }
    const rotated = (await fs.promises.readdir(backupDir)).filter(name => name.endsWith('.sqlite'));
    assert.equal(rotated.length, 7, 'SQLite backup rotation should retain only seven snapshots');
    const backupDb = new Database(path.join(backupDir, rotated[0]), { readonly: true });
    try {
      const backupState = JSON.parse(backupDb.prepare('SELECT payload FROM app_state WHERE id = 1').get().payload);
      assert.ok(backupState.orders.length > 0);
    } finally {
      backupDb.close();
    }
    serverModule.closeStore();

    const reopened = await serverModule.loadStore();
    assert.ok(reopened.orders.some(order => order.id === 'PET-7002'));
    assert.equal(reopened.audit[0].id, 'event-migration');
    assert.equal(reopened.users[0].email, 'a@petale.test');
    assert.equal(reopened.settingsByUser['florist-a'].shopName, 'Fleurs de test');

    const normalizedDb = new Database(databasePath, { readonly: true });
    try {
      assert.equal(normalizedDb.prepare('SELECT COUNT(*) AS count FROM orders').get().count, 2);
      assert.equal(normalizedDb.prepare('SELECT COUNT(*) AS count FROM users').get().count, 1);
      assert.equal(normalizedDb.prepare('SELECT COUNT(*) AS count FROM couriers').get().count, 1);
      assert.equal(normalizedDb.prepare('SELECT COUNT(*) AS count FROM business_settings').get().count, 1);
      assert.equal(normalizedDb.prepare('SELECT COUNT(*) AS count FROM audit_events').get().count, 1);
      assert.ok(normalizedDb.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_orders_status_position'").get());
      assert.ok(normalizedDb.prepare('SELECT version FROM schema_migrations WHERE version = 2').get());
    } finally {
      normalizedDb.close();
    }

    server = serverModule.createServer();
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const response = await fetch('http://127.0.0.1:' + server.address().port + '/api/health');
    assert.equal(response.status, 200);
    assert.equal((await response.json()).storage, 'sqlite');
  } finally {
    if (server?.listening) await new Promise(resolve => server.close(resolve));
    serverModule?.closeStore();
    delete process.env.PETAL_DATABASE_PATH;
    delete process.env.PETAL_STORE_PATH;
    await fs.promises.rm(dir, { recursive: true, force: true });
  }
});
