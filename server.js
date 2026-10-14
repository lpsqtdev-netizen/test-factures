'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const ROOT = __dirname;
const PORT = Number(process.env.PORT || 3000);
const STORE_PATH = process.env.PETAL_STORE_PATH || path.join(ROOT, 'data', 'store.json');
const MAX_BODY_BYTES = 32 * 1024;

const seed = {
  orders: [
    { id: 'PET-0248', name: 'Élodie Bernard', address: '12 rue Fondaudège, Bordeaux', slot: '11h – 13h', price: 68, status: 'En livraison', art: '💐', bouquet: 'Bouquet de saison', courier: 'Lucas Moreau', createdAt: '2026-10-14T08:15:00.000Z' },
    { id: 'PET-0247', name: 'Thomas Petit', address: '5 place des Quinconces, Bordeaux', slot: '12h – 14h', price: 42, status: 'À préparer', art: '🌷', bouquet: 'Composition florale', courier: '', createdAt: '2026-10-14T08:40:00.000Z' },
    { id: 'PET-0246', name: 'Sarah Dubois', address: '28 rue Notre-Dame, Bordeaux', slot: '10h – 12h', price: 95, status: 'En livraison', art: '🌹', bouquet: 'Bouquet de roses', courier: 'Lucas Moreau', createdAt: '2026-10-14T07:50:00.000Z' },
    { id: 'PET-0245', name: 'Marc Lefèvre', address: '7 cours de Verdun, Bordeaux', slot: '09h – 11h', price: 56, status: 'Livrée', art: '🌻', bouquet: 'Bouquet de saison', courier: 'Inès Robert', createdAt: '2026-10-14T07:10:00.000Z' }
  ],
  couriers: [
    { id: 'courier-lucas', name: 'Lucas Moreau', vehicle: 'Vélo cargo électrique', area: 'Bordeaux centre · Chartrons', status: 'En livraison', jobs: 8, emoji: '🛵' },
    { id: 'courier-ines', name: 'Inès Robert', vehicle: 'Vélo électrique', area: 'Jardin Public · Saint-Seurin', status: 'Disponible', jobs: 6, emoji: '🚲' },
    { id: 'courier-mehdi', name: 'Mehdi Benali', vehicle: 'Scooter électrique', area: 'Bordeaux rive droite', status: 'Disponible', jobs: 5, emoji: '🛵' },
    { id: 'courier-julie', name: 'Julie Garnier', vehicle: 'Vélo cargo', area: 'Caudéran · Mérignac', status: 'Disponible', jobs: 3, emoji: '🚲' },
    { id: 'courier-hugo', name: 'Hugo Petit', vehicle: 'Voiture électrique', area: 'Bordeaux métropole', status: 'Hors ligne', jobs: 2, emoji: '🚗' }
  ]
};
const ORDER_STATUSES = new Set(['À préparer', 'En livraison', 'Livrée']);
const SLOT_OPTIONS = new Set(['11h – 13h', '12h – 14h', '10h – 12h', '09h – 11h', '13h – 15h', '15h – 17h', '17h – 19h', 'Dès que possible']);

function json(res, status, value) {
  const body = JSON.stringify(value);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff'
  });
  res.end(body);
}
function safeString(value, max) {
  return typeof value === 'string' ? value.trim().slice(0, max) : '';
}
function validateNewOrder(body) {
  const name = safeString(body.name, 100);
  const address = safeString(body.address, 240);
  const slot = safeString(body.slot, 40);
  const bouquet = safeString(body.bouquet, 100) || 'Bouquet de saison';
  const price = Number(body.price);
  const phone = safeString(body.phone, 40);
  const notes = safeString(body.notes, 500);
  const priority = safeString(body.priority, 30) || 'Standard';
  if (name.length < 2) return { error: 'Le nom du destinataire doit contenir au moins 2 caractères.' };
  if (address.length < 5) return { error: 'Veuillez saisir une adresse de livraison valide.' };
  if (!SLOT_OPTIONS.has(slot)) return { error: 'Créneau de livraison invalide.' };
  if (!Number.isFinite(price) || price < 0 || price > 100000) return { error: 'Le montant doit être compris entre 0 et 100000.' };
  return { value: { name, address, slot, price: Math.round(price * 100) / 100, phone, notes, priority, bouquet } };
}
async function readBody(req) {
  let data = '';
  for await (const chunk of req) {
    data += chunk;
    if (Buffer.byteLength(data) > MAX_BODY_BYTES) {
      const err = new Error('Corps de requête trop volumineux.');
      err.status = 413;
      throw err;
    }
  }
  if (!data) return {};
  let parsed;
  try {
    parsed = JSON.parse(data);
  } catch {
    const err = new Error('JSON invalide.');
    err.status = 400;
    throw err;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    const err = new Error('Le corps JSON doit être un objet.');
    err.status = 400;
    throw err;
  }
  return parsed;
}
async function loadStore() {
  try {
    const parsed = JSON.parse(await fs.promises.readFile(STORE_PATH, 'utf8'));
    if (parsed && Array.isArray(parsed.orders) && Array.isArray(parsed.couriers)) {
      return parsed;
    }
  } catch (err) {
    if (err.code !== 'ENOENT' && !(err instanceof SyntaxError)) throw err;
  }
  return structuredClone(seed);
}
async function saveStore(store) {
  await fs.promises.mkdir(path.dirname(STORE_PATH), { recursive: true });
  const temp = STORE_PATH + '.' + process.pid + '.tmp';
  await fs.promises.writeFile(temp, JSON.stringify(store, null, 2) + '\n', { mode: 0o600 });
  await fs.promises.rename(temp, STORE_PATH);
}
function contentType(file) {
  return ({ '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml' })[path.extname(file)] || 'application/octet-stream';
}
function createServer() {
  // Serialize write requests so concurrent creates/updates cannot overwrite one another.
  let mutationQueue = Promise.resolve();
  const server = http.createServer((req, res) => {
    const run = () => handleRequest(req, res);
    if (req.url?.startsWith('/api/') && !['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
      mutationQueue = mutationQueue.then(run, run);
    } else {
      void run();
    }
  });
  async function handleRequest(req, res) {
    try {
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader('X-Frame-Options', 'DENY');
      res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
      res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
      const url = new URL(req.url, 'http://localhost');
      if (url.pathname.startsWith('/api/')) {
        if (req.method === 'OPTIONS') {
          res.writeHead(204, { 'Allow': 'GET, POST, PATCH, OPTIONS' });
          return res.end();
        }
        const store = await loadStore();
        if (url.pathname === '/api/health' && req.method === 'GET') {
          return json(res, 200, { ok: true, service: 'petale-api', storage: 'json-file', auth: 'not-configured' });
        }
        if (url.pathname === '/api/orders' && req.method === 'GET') {
          return json(res, 200, { orders: store.orders });
        }
        if (url.pathname === '/api/couriers' && req.method === 'GET') {
          return json(res, 200, { couriers: store.couriers });
        }
        if (url.pathname === '/api/orders' && req.method === 'POST') {
          const body = await readBody(req);
          const checked = validateNewOrder(body);
          if (checked.error) return json(res, 422, { error: checked.error });
          const maxId = store.orders.reduce((max, order) => Math.max(max, Number(String(order.id).match(/(\d+)$/)?.[1] || 0)), 0);
          const item = {
            id: 'PET-' + String(maxId + 1).padStart(4, '0'),
            ...checked.value,
            status: 'À préparer',
            art: checked.value.bouquet.includes('Plante') ? '🪴' : checked.value.bouquet.includes('Composition') ? '🌷' : '💐',
            courier: '',
            createdAt: new Date().toISOString()
          };
          store.orders.unshift(item);
          await saveStore(store);
          return json(res, 201, { order: item });
        }
        const match = url.pathname.match(/^\/api\/orders\/([A-Za-z0-9-]+)\/(assign|status)$/);
        if (match && req.method === 'PATCH') {
          const id = match[1];
          const order = store.orders.find(item => item.id === id);
          if (!order) return json(res, 404, { error: 'Commande introuvable.' });
          const body = await readBody(req);
          if (match[2] === 'assign') {
            const courier = safeString(body.courier, 100);
            if (!courier) return json(res, 422, { error: 'Le nom du livreur est obligatoire.' });
            if (order.status === 'Livrée') return json(res, 409, { error: 'Cette commande est déjà livrée.' });
            order.courier = courier;
            order.status = 'En livraison';
          } else {
            const status = safeString(body.status, 40);
            if (!ORDER_STATUSES.has(status)) return json(res, 422, { error: 'Statut de commande invalide.' });
            if (status !== order.status) {
              const allowedNext = { 'À préparer': ['En livraison'], 'En livraison': ['Livrée'], 'Livrée': [] };
              if (!allowedNext[order.status]?.includes(status)) {
                return json(res, 409, { error: 'Transition de statut impossible : ' + order.status + ' → ' + status + '.' });
              }
            }
            if (status === 'En livraison' && !order.courier) {
              const courier = safeString(body.courier, 100);
              if (!courier) return json(res, 422, { error: 'Un livreur doit être renseigné avant le départ en livraison.' });
              order.courier = courier;
            }
            if (status === 'Livrée' && !order.courier) order.courier = 'Livreur non renseigné';
            order.status = status;
          }
          await saveStore(store);
          return json(res, 200, { order });
        }
        return json(res, 404, { error: 'Route API introuvable.' });
      }

      if (req.method !== 'GET' && req.method !== 'HEAD') {
        res.writeHead(405, { Allow: 'GET, HEAD' });
        return res.end('Method Not Allowed');
      }
      const pathname = decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname);
      const target = path.resolve(ROOT, '.' + pathname);
      if (!target.startsWith(ROOT + path.sep) || !fs.existsSync(target) || !fs.statSync(target).isFile()) {
        return json(res, 404, { error: 'Fichier introuvable.' });
      }
      res.writeHead(200, { 'Content-Type': contentType(target), 'X-Content-Type-Options': 'nosniff' });
      if (req.method === 'HEAD') return res.end();
      fs.createReadStream(target).pipe(res);
    } catch (err) {
      if (err.status) return json(res, err.status, { error: err.message });
      console.error(err);
      return json(res, 500, { error: 'Erreur interne du serveur.' });
    }
  }
  return server;
}

if (require.main === module) {
  createServer().listen(PORT, () => {
    console.log('Pétale listening on http://localhost:' + PORT);
    console.log('JSON data store: ' + STORE_PATH);
  });
}
module.exports = { createServer, validateNewOrder, loadStore, saveStore };
