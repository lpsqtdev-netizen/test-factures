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

test('frontend exposes API-first startup and local demo fallback', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  assert.match(html, /async function connectApi\(\)/);
  assert.match(html, /\/api\/orders/);
  assert.match(html, /mode démo local/i);
  assert.match(html, /id="view-courier"/);
});
