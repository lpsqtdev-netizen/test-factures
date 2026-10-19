'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const root = path.join(__dirname, '..');

test('restores a valid backup atomically and preserves the current store first', async () => {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'petale-restore-test-'));
  try {
    const target = path.join(dir, 'store.json');
    const backup = path.join(dir, 'backup.json');
    await fs.promises.writeFile(target, JSON.stringify({ orders: [], couriers: [], audit: [], users: [], version: 'current' }));
    await fs.promises.writeFile(backup, JSON.stringify({ orders: [{ id: 'PET-9000' }], couriers: [], version: 'restored' }));

    const result = spawnSync(process.execPath, [path.join(root, 'scripts', 'restore-store.js'), backup, target], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    const restored = JSON.parse(await fs.promises.readFile(target, 'utf8'));
    assert.equal(restored.version, 'restored');
    assert.equal(restored.audit.length, 0);
    assert.equal(restored.users.length, 0);
    const backupDir = target + '.backups';
    const saved = (await fs.promises.readdir(backupDir)).filter(name => name.endsWith('.json'));
    assert.equal(saved.length, 1);
    assert.equal(JSON.parse(await fs.promises.readFile(path.join(backupDir, saved[0]), 'utf8')).version, 'current');
  } finally {
    await fs.promises.rm(dir, { recursive: true, force: true });
  }
});

test('rejects malformed restore snapshots without replacing the current store', async () => {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'petale-restore-invalid-'));
  try {
    const target = path.join(dir, 'store.json');
    const backup = path.join(dir, 'bad.json');
    const original = JSON.stringify({ orders: [], couriers: [], marker: 'unchanged' });
    await fs.promises.writeFile(target, original);
    await fs.promises.writeFile(backup, JSON.stringify({ orders: 'not-an-array', couriers: [] }));
    const result = spawnSync(process.execPath, [path.join(root, 'scripts', 'restore-store.js'), backup, target], { encoding: 'utf8' });
    assert.notEqual(result.status, 0);
    assert.equal(await fs.promises.readFile(target, 'utf8'), original);
  } finally {
    await fs.promises.rm(dir, { recursive: true, force: true });
  }
});
