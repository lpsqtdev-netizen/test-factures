'use strict';

const fs = require('node:fs');
const path = require('node:path');

async function main() {
  const backupArg = process.argv[2];
  const targetArg = process.argv[3] || process.env.PETAL_STORE_PATH || path.join(__dirname, '..', 'data', 'store.json');
  if (!backupArg) {
    throw new Error('Usage: node scripts/restore-store.js <backup.json> [store.json]');
  }

  const backupPath = path.resolve(backupArg);
  const targetPath = path.resolve(targetArg);
  if (backupPath === targetPath) {
    throw new Error('Le fichier de sauvegarde et le fichier cible doivent être différents.');
  }

  let snapshot;
  try {
    snapshot = JSON.parse(await fs.promises.readFile(backupPath, 'utf8'));
  } catch (err) {
    throw new Error('Impossible de lire la sauvegarde JSON : ' + err.message);
  }
  if (!snapshot || !Array.isArray(snapshot.orders) || !Array.isArray(snapshot.couriers)) {
    throw new Error('Structure de sauvegarde invalide : les listes orders et couriers sont requises.');
  }
  if (!Array.isArray(snapshot.audit)) snapshot.audit = [];
  if (!Array.isArray(snapshot.users)) snapshot.users = [];

  // Set the destination before loading the store module so its atomic writer
  // creates a backup of the current target before restoring this snapshot.
  process.env.PETAL_STORE_PATH = targetPath;
  const { saveStore } = require('../server');
  await saveStore(snapshot);
  process.stdout.write('Restauration terminée : ' + targetPath + '\n');
}

main().catch(err => {
  process.stderr.write('Échec de restauration : ' + err.message + '\n');
  process.exitCode = 1;
});
