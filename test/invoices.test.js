'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'petale-invoice-test-'));
process.env.PETAL_STORE_PATH = path.join(tempDir, 'store.json');
delete process.env.PETAL_DATABASE_PATH;
process.env.PETAL_ADMIN_EMAIL = 'admin@petale-invoice.test';
process.env.PETAL_ADMIN_PASSWORD = 'Test-Admin-Invoice-Password-2026!';
const { createServer } = require('../server');
let server;
let baseUrl;
let adminCookie;
let floristCookie;
let floristId;

async function login(email, password) {
  const response = await fetch(baseUrl + '/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password })
  });
  assert.equal(response.status, 200);
  return response.headers.get('set-cookie').split(';')[0];
}
async function request(pathname, options = {}, cookie = floristCookie) {
  const response = await fetch(baseUrl + pathname, {
    ...options,
    headers: {
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
      ...(cookie ? { Cookie: cookie } : {}),
      ...(options.headers || {})
    }
  });
  const contentType = response.headers.get('content-type') || '';
  return {
    status: response.status,
    headers: response.headers,
    body: contentType.includes('application/json') ? await response.json() : Buffer.from(await response.arrayBuffer())
  };
}
const draftPayload = {
  buyerName: 'Client Facture',
  buyerAddress: '12 rue des Fleurs, Bordeaux',
  buyerEmail: 'client@example.test',
  items: [{ description: 'Bouquet de saison', quantity: 2, unitPrice: 10, vatRate: 20 }]
};

before(async () => {
  server = createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  baseUrl = 'http://127.0.0.1:' + server.address().port;
  adminCookie = await login(process.env.PETAL_ADMIN_EMAIL, process.env.PETAL_ADMIN_PASSWORD);
  const created = await request('/api/users', {
    method: 'POST',
    body: JSON.stringify({
      name: 'Fleuriste Test',
      email: 'fleuriste.invoice@petale.test',
      role: 'fleuriste',
      password: 'Fleuriste-Strong-Password-2026!'
    })
  }, adminCookie);
  assert.equal(created.status, 201);
  floristId = created.body.user.id;
  floristCookie = await login('fleuriste.invoice@petale.test', 'Fleuriste-Strong-Password-2026!');
});

after(async () => {
  await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  fs.rmSync(tempDir, { recursive: true, force: true });
});

test('invoice drafts validate line items and calculate amounts in cents', async () => {
  const invalid = await request('/api/invoices', {
    method: 'POST',
    body: JSON.stringify({ ...draftPayload, items: [{ description: 'Bouquet', quantity: 1, unitPrice: 20, vatRate: 17 }] })
  });
  assert.equal(invalid.status, 422);

  const created = await request('/api/invoices', { method: 'POST', body: JSON.stringify(draftPayload) });
  assert.equal(created.status, 201);
  assert.equal(created.body.invoice.status, 'draft');
  assert.equal(created.body.invoice.invoiceNumber, '');
  assert.equal(created.body.invoice.subtotalCents, 2000);
  assert.equal(created.body.invoice.taxCents, 400);
  assert.equal(created.body.invoice.totalCents, 2400);
});

test('invoice issue requires seller legal details and freezes a numbered seller snapshot', async () => {
  const draft = await request('/api/invoices', { method: 'POST', body: JSON.stringify(draftPayload) });
  assert.equal(draft.status, 201);
  const notReady = await request('/api/invoices/' + draft.body.invoice.id + '/issue', { method: 'POST', body: '{}' });
  assert.equal(notReady.status, 422);
  assert.match(notReady.body.error, /SIRET/);

  const settings = await request('/api/settings', {
    method: 'POST',
    body: JSON.stringify({
      shopName: 'Maison des Fleurs',
      ownerName: 'Camille Fleuriste',
      email: 'contact@maisondesfleurs.test',
      phone: '0556000000',
      pickupAddress: '8 cours Victor Hugo, Bordeaux',
      siret: '12345678901234',
      vatNumber: 'FR12345678901'
    })
  });
  assert.equal(settings.status, 200);

  const issued = await request('/api/invoices/' + draft.body.invoice.id + '/issue', { method: 'POST', body: '{}' });
  assert.equal(issued.status, 200);
  assert.match(issued.body.invoice.invoiceNumber, /^FAC-\d{4}-0001$/);
  assert.equal(issued.body.invoice.status, 'issued');
  assert.equal(issued.body.invoice.seller.siret, '12345678901234');
  assert.equal(issued.body.invoice.totalCents, 2400);

  const secondDraft = await request('/api/invoices', { method: 'POST', body: JSON.stringify(draftPayload) });
  assert.equal(secondDraft.status, 201);
  const secondIssued = await request('/api/invoices/' + secondDraft.body.invoice.id + '/issue', { method: 'POST', body: '{}' });
  assert.equal(secondIssued.status, 200);
  assert.match(secondIssued.body.invoice.invoiceNumber, /^FAC-[0-9]{4}-0002$/);

  const repeated = await request('/api/invoices/' + draft.body.invoice.id + '/issue', { method: 'POST', body: '{}' });
  assert.equal(repeated.status, 409);

  const pdf = await request('/api/invoices/' + draft.body.invoice.id + '.pdf');
  assert.equal(pdf.status, 200);
  assert.match(pdf.headers.get('content-type'), /application\/pdf/);
  assert.equal(pdf.body.subarray(0, 8).toString('ascii'), '%PDF-1.4');
  assert.ok(pdf.body.toString('ascii').includes('FACTURE FAC-'));

  const listed = await request('/api/invoices');
  assert.equal(listed.status, 200);
  assert.ok(listed.body.invoices.some(invoice => invoice.id === draft.body.invoice.id && invoice.pdfAvailable));
});

test('invoice register does not expose one florist invoices to another florist', async () => {
  const second = await request('/api/users', {
    method: 'POST',
    body: JSON.stringify({
      name: 'Autre Fleuriste',
      email: 'autre.invoice@petale.test',
      role: 'fleuriste',
      password: 'Autre-Fleuriste-Password-2026!'
    })
  }, adminCookie);
  assert.equal(second.status, 201);
  const secondCookie = await login('autre.invoice@petale.test', 'Autre-Fleuriste-Password-2026!');
  const list = await request('/api/invoices', {}, secondCookie);
  assert.equal(list.status, 200);
  assert.deepEqual(list.body.invoices, []);
  const forbidden = await request('/api/invoices/not-a-real-id.pdf', {}, secondCookie);
  assert.equal(forbidden.status, 404);
});
