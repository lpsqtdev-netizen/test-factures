'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

test('inline frontend JavaScript parses without syntax errors', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  const scripts = [...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/gi)];
  assert.ok(scripts.length > 0, 'index.html should contain an inline script');
  for (const match of scripts) new vm.Script(match[1], { filename: 'index.html:inline-script' });
});

test('frontend escapes user-controlled text before inserting HTML', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  assert.match(html, /function escapeHtml\(value\)/);
  assert.match(html, /escapeHtml\(o\.name\)/);
  assert.match(html, /escapeHtml\(o\.address\)/);
});

test('frontend provides a login gate and logout control for authenticated API access', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  assert.match(html, /petaleAuthGate/);
  assert.match(html, /petaleLoginForm/);
  assert.match(html, /partnerPasswordForm/);
  assert.match(html, /partnerPasswordPanel/);
  assert.match(html, /\/api\/auth\/password/);
  assert.match(html, /\/api\/auth\/login/);
  assert.match(html, /\/api\/auth\/logout/);
  assert.match(html, /\/api\/auth\/me/);
});

test('frontend handles courier roles without storing live API customer data locally', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  assert.match(html, /\/api\/orders\/available/);
  assert.match(html, /currentUser\?\.role==='livreur'/);
  assert.match(html, /function persistDemoState\(\)\{if\(apiOnline\)return/);
  assert.match(html, /Vérification de votre session/);
});

test('admin interface includes partner account creation controls', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  assert.match(html, /function openUserModal\(\)/);
  assert.match(html, /\/api\/users/);
  assert.match(html, /petaleUserRole/);
  assert.match(html, /Livreur partenaire/);
});

test('frontend exposes API-first startup and local demo fallback', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  assert.match(html, /async function connectApi\(\)/);
  assert.match(html, /\/api\/orders/);
  assert.match(html, /\/api\/settings/);
  assert.match(html, /settingVatNumber/);
  assert.match(html, /mode démo local/i);
  assert.match(html, /id="view-courier"/);
});


test('dashboard KPIs and activity are derived from loaded orders', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  assert.match(html, /id="metricOrderValue"/);
  assert.match(html, /const orderValue=orders\.reduce/);
  assert.match(html, /function renderActivities\(\)\{const recent=orders\.slice\(\)/);
  assert.doesNotMatch(html, /Nouvelle commande reçue','Thomas Petit/);
});


test('frontend navigation is scoped to the authenticated account role', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  assert.match(html, /button\.hidden=user\.role==='livreur'\?button\.dataset\.view!=='courier':button\.dataset\.view==='courier'/);
  assert.match(html, /navigate\(user\.role==='livreur'\?'courier':'dashboard'\)/);
  assert.match(html, /button\.hidden=user\.role==='livreur'/);
});
