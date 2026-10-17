'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'petale-sqlite-test-'));
process.env.PETAL_STORE_PATH = path.join(tempDir, 'store.json');
process.env.PETAL_DATABASE_PATH = path.join(tempDir, 'store.sqlite');
process.env.PETAL_ADMIN_EMAIL = 'admin@petale-sqlite.test';
process.env.PETAL_ADMIN_PASSWORD = 'Test-Admin-SQLite-Password-2026!';

const { createServer, closeStore } = require('../server');
let server;
let baseUrl;
let cookie;

async function startServer() {
  server = createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  baseUrl = 'http://127.0.0.1:' + server.address().port;
}

async function login() {
  const response = await fetch(baseUrl + '/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      email: process.env.PETAL_ADMIN_EMAIL,
      password: process.env.PETAL_ADMIN_PASSWORD
    })
  });
  assert.equal(response.status, 200);
  cookie = response.headers.get('set-cookie').split(';')[0];
}

async function stopServer() {
  if (server?.listening) {
    await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
  closeStore();
}

async function request(pathname, options = {}) {
  const response = await fetch(baseUrl + pathname, {
    ...options,
    headers: {
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
      ...(cookie ? { Cookie: cookie } : {}),
      ...(options.headers || {})
    }
  });
  return { status: response.status, body: await response.json() };
}

before(async () => {
  await startServer();
  await login();
});

after(async () => {
  await stopServer();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

test('SQLite mode imports initial state, persists API mutations, and restores state after restart', async () => {
  const health = await request('/api/health');
  assert.equal(health.status, 200);
  assert.equal(health.body.storage, 'sqlite');

  const initial = await request('/api/orders');
  assert.equal(initial.status, 200);
  assert.ok(initial.body.orders.some(order => order.id === 'PET-0247'));

  const created = await request('/api/orders', {
    method: 'POST',
    body: JSON.stringify({
      name: 'Client SQLite',
      address: '17 rue des Fleurs, Bordeaux',
      slot: '15h – 17h',
      price: 48.25,
      bouquet: 'Bouquet SQLite'
    })
  });
  assert.equal(created.status, 201);
  const orderId = created.body.order.id;

  const Database = require('better-sqlite3');
  const db = new Database(process.env.PETAL_DATABASE_PATH, { readonly: true });
  try {
    const state = db.prepare('SELECT revision FROM app_state WHERE id = 1').get();
    assert.ok(state.revision >= 2);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM orders WHERE id = ?').get(orderId).count, 1);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM schema_migrations WHERE version = 2').get().count, 1);
  } finally {
    db.close();
  }

  const backupDir = process.env.PETAL_DATABASE_PATH + '.backups';
  const backups = (await fs.promises.readdir(backupDir)).filter(name => name.startsWith('store-') && name.endsWith('.sqlite'));
  assert.ok(backups.length >= 1, 'a private SQLite backup should be created before mutation');
  assert.ok(backups.length <= 7, 'SQLite backup retention should be bounded to seven files');
  if (process.platform !== 'win32') {
    const backupStat = await fs.promises.stat(path.join(backupDir, backups[0]));
    assert.equal(backupStat.mode & 0o077, 0);
  }

  await stopServer();
  await startServer();
  await login();
  const afterRestart = await request('/api/orders');
  assert.ok(afterRestart.body.orders.some(order => order.id === orderId));
});
