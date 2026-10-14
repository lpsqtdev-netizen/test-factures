'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'petale-test-'));
process.env.PETAL_STORE_PATH = path.join(tempDir, 'store.json');
process.env.PETAL_ADMIN_EMAIL = 'admin@petale.test';
process.env.PETAL_ADMIN_PASSWORD = 'Test-Admin-Password-2026!';
const { createServer } = require('../server');

let server;
let baseUrl;
let sessionCookie;
before(async () => {
  server = createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  baseUrl = 'http://127.0.0.1:' + server.address().port;
  const login = await fetch(baseUrl + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: process.env.PETAL_ADMIN_EMAIL, password: process.env.PETAL_ADMIN_PASSWORD }) });
  assert.equal(login.status, 200);
  sessionCookie = login.headers.get('set-cookie').split(';')[0];
});
after(async () => {
  await new Promise((resolve, reject) => server.close(err => err ? reject(err) : resolve()));
  fs.rmSync(tempDir, { recursive: true, force: true });
});

async function request(pathname, options = {}) {
  const response = await fetch(baseUrl + pathname, {
    ...options,
    headers: { ...(options.body ? { 'Content-Type': 'application/json' } : {}), ...(sessionCookie && options.auth !== false ? { Cookie: sessionCookie } : {}), ...(options.headers || {}) }
  });
  const body = await response.json();
  return { status: response.status, body };
}

test('health endpoint describes the API and storage mode', async () => {
  const response = await request('/api/health');
  assert.equal(response.status, 200);
  assert.equal(response.body.ok, true);
  assert.equal(response.body.storage, 'json-file');
});

test('protects API data with login sessions and rejects invalid credentials', async () => {
  const unauthenticated = await request('/api/orders', { auth: false });
  assert.equal(unauthenticated.status, 401);
  const badLogin = await request('/api/auth/login', {
    auth: false,
    method: 'POST',
    body: JSON.stringify({ email: process.env.PETAL_ADMIN_EMAIL, password: 'incorrect password' })
  });
  assert.equal(badLogin.status, 401);
  const me = await request('/api/auth/me');
  assert.equal(me.status, 200);
  assert.equal(me.body.user.role, 'admin');
});

test('rejects cross-origin mutations and supports logout', async () => {
  const crossOrigin = await request('/api/orders', {
    method: 'POST',
    headers: { Origin: 'https://attacker.invalid' },
    body: JSON.stringify({ name: 'Zoé Martin', address: '3 rue des Fleurs, Bordeaux', slot: '15h – 17h', price: 25 })
  });
  assert.equal(crossOrigin.status, 403);

  const login = await fetch(baseUrl + '/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: process.env.PETAL_ADMIN_EMAIL, password: process.env.PETAL_ADMIN_PASSWORD })
  });
  const cookie = login.headers.get('set-cookie').split(';')[0];
  const logout = await fetch(baseUrl + '/api/auth/logout', { method: 'POST', headers: { Cookie: cookie } });
  assert.equal(logout.status, 200);
  const me = await fetch(baseUrl + '/api/auth/me', { headers: { Cookie: cookie } });
  assert.equal((await me.json()).user, null);
});

test('orders endpoint returns seeded orders and couriers', async () => {
  const orders = await request('/api/orders');
  const couriers = await request('/api/couriers');
  assert.equal(orders.status, 200);
  assert.ok(orders.body.orders.some(order => order.id === 'PET-0247'));
  assert.equal(couriers.status, 200);
  assert.ok(couriers.body.couriers.length >= 1);
});

test('creates a validated order and persists it between requests', async () => {
  const created = await request('/api/orders', {
    method: 'POST',
    body: JSON.stringify({ name: 'Zoé Martin', address: '3 rue des Fleurs, Bordeaux', slot: '15h – 17h', price: 37.5, bouquet: 'Bouquet de saison' })
  });
  assert.equal(created.status, 201);
  assert.match(created.body.order.id, /^PET-\d{4}$/);
  assert.equal(created.body.order.status, 'À préparer');
  const listed = await request('/api/orders');
  assert.ok(listed.body.orders.some(order => order.id === created.body.order.id && order.price === 37.5));
  const audit = await request('/api/audit');
  assert.equal(audit.status, 200);
  assert.ok(audit.body.events.some(event => event.action === 'order.created' && event.entityId === created.body.order.id && event.actor === process.env.PETAL_ADMIN_EMAIL));
});

test('serializes concurrent order creation without duplicate IDs or lost orders', async () => {
  const requests = Array.from({ length: 12 }, (_, index) => request('/api/orders', {
    method: 'POST',
    body: JSON.stringify({
      name: 'Client concurrent ' + index,
      address: (index + 1) + ' rue des Fleurs, Bordeaux',
      slot: '15h – 17h',
      price: 20 + index,
      bouquet: 'Bouquet de saison'
    })
  }));
  const responses = await Promise.all(requests);
  assert.ok(responses.every(response => response.status === 201));
  const ids = responses.map(response => response.body.order.id);
  assert.equal(new Set(ids).size, 12);
  const listed = await request('/api/orders');
  assert.ok(ids.every(id => listed.body.orders.some(order => order.id === id)));
});

test('rejects JSON primitives and oversized request bodies', async () => {
  const primitive = await request('/api/orders', {
    method: 'POST',
    body: 'null'
  });
  assert.equal(primitive.status, 400);
  assert.match(primitive.body.error, /doit être un objet/);

  const oversized = await request('/api/orders', {
    method: 'POST',
    body: 'x'.repeat(33 * 1024)
  });
  assert.equal(oversized.status, 413);
  assert.match(oversized.body.error, /trop volumineux/);
});

test('rejects invalid order input', async () => {
  const response = await request('/api/orders', {
    method: 'POST',
    body: JSON.stringify({ name: '', address: 'x', slot: 'sometime', price: -3 })
  });
  assert.equal(response.status, 422);
  assert.equal(typeof response.body.error, 'string');
});

test('assigns an order and marks it delivered', async () => {
  const assigned = await request('/api/orders/PET-0247/assign', {
    method: 'PATCH',
    body: JSON.stringify({ courier: 'Livreur test' })
  });
  assert.equal(assigned.status, 200);
  assert.equal(assigned.body.order.status, 'En livraison');
  assert.equal(assigned.body.order.courier, 'Livreur test');
  const delivered = await request('/api/orders/PET-0247/status', {
    method: 'PATCH',
    body: JSON.stringify({ status: 'Livrée' })
  });
  assert.equal(delivered.status, 200);
  assert.equal(delivered.body.order.status, 'Livrée');
  assert.match(delivered.body.order.deliveredAt, /^\d{4}-\d{2}-\d{2}T/);
  assert.equal(delivered.body.order.deliveredBy, process.env.PETAL_ADMIN_EMAIL);
});

test('rejects unknown orders and invalid status transitions', async () => {
  const missing = await request('/api/orders/PET-9999/status', {
    method: 'PATCH',
    body: JSON.stringify({ status: 'Livrée' })
  });
  assert.equal(missing.status, 404);
  const invalid = await request('/api/orders/PET-0248/status', {
    method: 'PATCH',
    body: JSON.stringify({ status: 'Supprimée' })
  });
  assert.equal(invalid.status, 422);
});

test('prevents a delivery from moving backwards in its lifecycle', async () => {
  const response = await request('/api/orders/PET-0248/status', {
    method: 'PATCH',
    body: JSON.stringify({ status: 'À préparer' })
  });
  assert.equal(response.status, 409);
  assert.match(response.body.error, /Transition de statut impossible/);
});

test('creates role accounts and limits courier access to available and assigned missions', async () => {
  const createdUser = await request('/api/users', {
    method: 'POST',
    body: JSON.stringify({
      name: 'Camille Livreur',
      email: 'camille.livreur@petale.test',
      role: 'livreur',
      password: 'Courier-Strong-Password-2026!'
    })
  });
  assert.equal(createdUser.status, 201);
  assert.equal(createdUser.body.user.role, 'livreur');
  assert.equal('passwordHash' in createdUser.body.user, false);

  const createdOrder = await request('/api/orders', {
    method: 'POST',
    body: JSON.stringify({
      name: 'Client du livreur',
      address: '9 rue des Fleurs, Bordeaux',
      slot: '15h – 17h',
      price: 31,
      phone: '0600000000',
      notes: 'Sonner à l’entrée'
    })
  });
  assert.equal(createdOrder.status, 201);

  const login = await fetch(baseUrl + '/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'camille.livreur@petale.test', password: 'Courier-Strong-Password-2026!' })
  });
  assert.equal(login.status, 200);
  const cookie = login.headers.get('set-cookie').split(';')[0];
  const ownOrders = await fetch(baseUrl + '/api/orders', { headers: { Cookie: cookie } });
  assert.deepEqual((await ownOrders.json()).orders, []);

  const available = await fetch(baseUrl + '/api/orders/available', { headers: { Cookie: cookie } });
  const availableOrders = (await available.json()).orders;
  assert.ok(availableOrders.some(order => order.id === createdOrder.body.order.id));
  assert.equal('phone' in availableOrders[0], false);
  assert.equal('notes' in availableOrders[0], false);

  const forbiddenCreate = await fetch(baseUrl + '/api/orders', {
    method: 'POST',
    headers: { Cookie: cookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'No permission', address: '1 rue Test, Bordeaux', slot: '15h – 17h', price: 20 })
  });
  assert.equal(forbiddenCreate.status, 403);

  const claim = await fetch(baseUrl + '/api/orders/' + createdOrder.body.order.id + '/assign', {
    method: 'PATCH',
    headers: { Cookie: cookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ courier: 'Camille Livreur' })
  });
  assert.equal(claim.status, 200);
  const afterClaim = await fetch(baseUrl + '/api/orders', { headers: { Cookie: cookie } });
  const visible = (await afterClaim.json()).orders;
  assert.equal(visible.length, 1);
  assert.equal(visible[0].id, createdOrder.body.order.id);

  const duplicateCourierName = await request('/api/users', {
    method: 'POST',
    body: JSON.stringify({ name: 'Camille Livreur', email: 'another@petale.test', role: 'livreur', password: 'Another-Strong-Password-2026!' })
  });
  assert.equal(duplicateCourierName.status, 409);

  const secondCourier = await request('/api/users', {
    method: 'POST',
    body: JSON.stringify({ name: 'Alex Autre', email: 'alex.autre@petale.test', role: 'livreur', password: 'Alex-Strong-Password-2026!' })
  });
  assert.equal(secondCourier.status, 201);
  const secondLogin = await fetch(baseUrl + '/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'alex.autre@petale.test', password: 'Alex-Strong-Password-2026!' })
  });
  const secondCookie = secondLogin.headers.get('set-cookie').split(';')[0];
  const forbiddenDelivery = await fetch(baseUrl + '/api/orders/' + createdOrder.body.order.id + '/status', {
    method: 'PATCH',
    headers: { Cookie: secondCookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ status: 'Livrée' })
  });
  assert.equal(forbiddenDelivery.status, 403);

  const forbiddenUsers = await fetch(baseUrl + '/api/users', { headers: { Cookie: cookie } });
  assert.equal(forbiddenUsers.status, 403);
  const forbiddenAudit = await fetch(baseUrl + '/api/audit', { headers: { Cookie: cookie } });
  assert.equal(forbiddenAudit.status, 403);
  const adminUsers = await request('/api/users');
  assert.ok(adminUsers.body.users.some(user => user.email === 'camille.livreur@petale.test'));
});


test('isolates florist orders and blocks cross-account order mutations', async () => {
  for (const account of [
    { name: 'Fleuriste Alpha', email: 'alpha@petale.test' },
    { name: 'Fleuriste Beta', email: 'beta@petale.test' }
  ]) {
    const created = await request('/api/users', {
      method: 'POST',
      body: JSON.stringify({ ...account, role: 'fleuriste', password: 'Florist-Strong-Password-2026!' })
    });
    assert.equal(created.status, 201);
  }

  async function login(email) {
    const response = await fetch(baseUrl + '/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password: 'Florist-Strong-Password-2026!' })
    });
    assert.equal(response.status, 200);
    return response.headers.get('set-cookie').split(';')[0];
  }

  const alphaCookie = await login('alpha@petale.test');
  const betaCookie = await login('beta@petale.test');
  const createdOrder = await fetch(baseUrl + '/api/orders', {
    method: 'POST',
    headers: { Cookie: alphaCookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'Client Alpha', address: '1 rue des Fleurs, Bordeaux', slot: '15h – 17h', price: 45 })
  });
  assert.equal(createdOrder.status, 201);
  const order = (await createdOrder.json()).order;
  assert.ok(order.createdBy);
  const betaOrdersResponse = await fetch(baseUrl + '/api/orders', { headers: { Cookie: betaCookie } });
  const betaOrders = (await betaOrdersResponse.json()).orders;
  assert.equal(betaOrders.some(item => item.id === order.id), false);

  const forbiddenMutation = await fetch(baseUrl + '/api/orders/' + order.id + '/status', {
    method: 'PATCH',
    headers: { Cookie: betaCookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ status: 'En livraison', courier: 'Livreur test' })
  });
  assert.equal(forbiddenMutation.status, 403);

  const alphaOrdersResponse = await fetch(baseUrl + '/api/orders', { headers: { Cookie: alphaCookie } });
  assert.ok((await alphaOrdersResponse.json()).orders.some(item => item.id === order.id));
});

test('throttles repeated invalid login attempts', async () => {
  let response;
  for (let index = 0; index < 11; index += 1) {
    response = await request('/api/auth/login', {
      auth: false,
      method: 'POST',
      body: JSON.stringify({ email: process.env.PETAL_ADMIN_EMAIL, password: 'wrong-password-' + index })
    });
  }
  assert.equal(response.status, 429);
  assert.match(response.body.error, /Trop de tentatives/);
});

test('serves the frontend from the same origin', async () => {
  const response = await fetch(baseUrl + '/');
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type'), /text\/html/);
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(response.headers.get('x-frame-options'), 'DENY');
  assert.equal(response.headers.get('referrer-policy'), 'strict-origin-when-cross-origin');
  assert.match(await response.text(), /Pétale/);
});


test('creates private rotating backups before replacing the JSON store', async () => {
  const original = await fs.promises.readFile(process.env.PETAL_STORE_PATH, 'utf8');
  const parsed = JSON.parse(original);
  await require('../server').saveStore(parsed);
  const changed = { ...parsed, backupTestMarker: 'new-version' };
  await require('../server').saveStore(changed);
  const backupDir = process.env.PETAL_STORE_PATH + '.backups';
  const backups = (await fs.promises.readdir(backupDir)).filter(name => /^store-.*\.json$/.test(name));
  assert.ok(backups.length >= 1);
  assert.ok(backups.length <= 7);
  const newestBackup = JSON.parse(await fs.promises.readFile(path.join(backupDir, backups.sort().at(-1)), 'utf8'));
  assert.equal(newestBackup.backupTestMarker, undefined);
  assert.equal(JSON.parse(await fs.promises.readFile(process.env.PETAL_STORE_PATH, 'utf8')).backupTestMarker, 'new-version');
  const stats = await fs.promises.stat(path.join(backupDir, backups[0]));
  if (process.platform !== 'win32') assert.equal(stats.mode & 0o077, 0);
});
