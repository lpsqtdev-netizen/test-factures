'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'petale-test-'));
process.env.PETAL_STORE_PATH = path.join(tempDir, 'store.json');
const { createServer } = require('../server');

let server;
let baseUrl;
before(async () => {
  server = createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  baseUrl = 'http://127.0.0.1:' + server.address().port;
});
after(async () => {
  await new Promise((resolve, reject) => server.close(err => err ? reject(err) : resolve()));
  fs.rmSync(tempDir, { recursive: true, force: true });
});

async function request(pathname, options = {}) {
  const response = await fetch(baseUrl + pathname, {
    ...options,
    headers: { ...(options.body ? { 'Content-Type': 'application/json' } : {}), ...(options.headers || {}) }
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

test('serves the frontend from the same origin', async () => {
  const response = await fetch(baseUrl + '/');
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type'), /text\/html/);
  assert.match(await response.text(), /Pétale/);
});
