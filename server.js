'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const ROOT = __dirname;
const PORT = Number(process.env.PORT || 3000);
const STORE_PATH = process.env.PETAL_STORE_PATH || path.join(ROOT, 'data', 'store.json');
const MAX_BODY_BYTES = 32 * 1024;
const SESSION_TTL_MS = 8 * 60 * 60 * 1000;
const sessions = new Map();
const loginAttempts = new Map();

const seed = {
  audit: [],
  users: [],
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
      if (!Array.isArray(parsed.audit)) parsed.audit = [];
      if (!Array.isArray(parsed.users)) parsed.users = [];
      return parsed;
    }
  } catch (err) {
    if (err.code !== 'ENOENT' && !(err instanceof SyntaxError)) throw err;
  }
  return structuredClone(seed);
}
const BACKUP_RETENTION = 7;
const BACKUP_DIR = STORE_PATH + '.backups';
let backupSequence = 0;

async function createStoreBackup() {
  let previous;
  try {
    previous = await fs.promises.readFile(STORE_PATH);
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
  await fs.promises.mkdir(BACKUP_DIR, { recursive: true, mode: 0o700 });
  const stamp = String(Date.now()).padStart(13, '0');
  const sequence = String(++backupSequence).padStart(6, '0');
  const backupPath = path.join(BACKUP_DIR, 'store-' + stamp + '-' + process.pid + '-' + sequence + '-' + crypto.randomBytes(3).toString('hex') + '.json');
  const tempPath = backupPath + '.tmp';
  try {
    await fs.promises.writeFile(tempPath, previous, { mode: 0o600, flag: 'wx' });
    await fs.promises.rename(tempPath, backupPath);
  } finally {
    await fs.promises.rm(tempPath, { force: true }).catch(() => {});
  }
  const files = (await fs.promises.readdir(BACKUP_DIR))
    .filter(name => /^store-.*\.json$/.test(name))
    .sort()
    .reverse();
  await Promise.all(files.slice(BACKUP_RETENTION).map(name => fs.promises.unlink(path.join(BACKUP_DIR, name))));
  return backupPath;
}

async function saveStore(store) {
  await fs.promises.mkdir(path.dirname(STORE_PATH), { recursive: true });
  const temp = STORE_PATH + '.' + process.pid + '.tmp';
  try {
    // Preserve the previous file before replacing it. Backups are local, private,
    // and bounded so frequent order updates cannot fill the disk indefinitely.
    await createStoreBackup();
    await fs.promises.writeFile(temp, JSON.stringify(store, null, 2) + '\n', { mode: 0o600 });
    await fs.promises.rename(temp, STORE_PATH);
  } finally {
    await fs.promises.rm(temp, { force: true }).catch(() => {});
  }
}
function parseCookies(header = '') {
  return Object.fromEntries(header.split(';').map(part => part.trim()).filter(Boolean).map(part => {
    const index = part.indexOf('=');
    if (index < 0) return [part, ''];
    const key = part.slice(0, index);
    try { return [key, decodeURIComponent(part.slice(index + 1))]; }
    catch { return [key, '']; }
  }));
}
function passwordMatches(password, expected) {
  const [salt, stored] = expected.split(':');
  const actual = crypto.scryptSync(password, salt, 64).toString('hex');
  const left = Buffer.from(actual, 'hex');
  const right = Buffer.from(stored, 'hex');
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}
function passwordRecord(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  return salt + ':' + crypto.scryptSync(password, salt, 64).toString('hex');
}
function adminConfigured() {
  return Boolean(process.env.PETAL_ADMIN_EMAIL && process.env.PETAL_ADMIN_EMAIL.trim() && process.env.PETAL_ADMIN_PASSWORD && process.env.PETAL_ADMIN_PASSWORD.length >= 12);
}
function sessionCookie(token, secure) {
  return 'petale_session=' + encodeURIComponent(token) + '; Path=/; HttpOnly; SameSite=Strict; Max-Age=' + Math.floor(SESSION_TTL_MS / 1000) + (secure ? '; Secure' : '');
}
function contentType(file) {
  return ({ '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml' })[path.extname(file)] || 'application/octet-stream';
}
function createServer() {
  // Hash the configured bootstrap password once per process/server, not on every login attempt.
  const adminPasswordRecord = process.env.PETAL_ADMIN_PASSWORD ? passwordRecord(process.env.PETAL_ADMIN_PASSWORD) : '';
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
      if (url.pathname.startsWith('/api/') && !['GET', 'HEAD', 'OPTIONS'].includes(req.method) && req.headers.origin) {
        const origin = new URL(req.headers.origin);
        if (origin.host !== req.headers.host) return json(res, 403, { error: 'Origine de requête refusée.' });
      }
      if (url.pathname.startsWith('/api/')) {
        if (req.method === 'OPTIONS') {
          res.writeHead(204, { 'Allow': 'GET, POST, PATCH, OPTIONS' });
          return res.end();
        }
        if (url.pathname === '/api/health' && req.method === 'GET') {
          return json(res, 200, { ok: true, service: 'petale-api', storage: 'json-file', auth: 'required', adminConfigured: adminConfigured() });
        }
        const secureCookie = process.env.NODE_ENV === 'production';
        if (url.pathname === '/api/auth/login' && req.method === 'POST') {
          if (!adminConfigured()) {
            return json(res, 503, { error: 'Authentification non configurée. Définissez PETAL_ADMIN_EMAIL et PETAL_ADMIN_PASSWORD.' });
          }
          const now = Date.now();
          const ip = req.socket.remoteAddress || 'unknown';
          let attempt = loginAttempts.get(ip);
          if (!attempt || attempt.resetAt <= now) attempt = { count: 0, resetAt: now + 15 * 60 * 1000 };
          if (attempt.count >= 10) {
            loginAttempts.set(ip, attempt);
            res.setHeader('Retry-After', String(Math.max(1, Math.ceil((attempt.resetAt - now) / 1000))));
            return json(res, 429, { error: 'Trop de tentatives. Réessayez plus tard.' });
          }
          const body = await readBody(req);
          const email = safeString(body.email, 254).toLowerCase();
          const password = typeof body.password === 'string' ? body.password : '';
          const configuredEmail = process.env.PETAL_ADMIN_EMAIL.toLowerCase();
          const store = await loadStore();
          const isAdmin = email === configuredEmail && password.length <= 1024 && adminPasswordRecord && passwordMatches(password, adminPasswordRecord);
          const account = store.users.find(user => user.email === email);
          const isAccountValid = password.length <= 1024 && account && passwordMatches(password, account.passwordHash);
          if (!isAdmin && !isAccountValid) {
            attempt.count += 1;
            loginAttempts.set(ip, attempt);
            return json(res, 401, { error: 'Identifiants incorrects.' });
          }
          loginAttempts.delete(ip);
          const user = isAdmin
            ? { id: 'admin', email: configuredEmail, name: 'Administrateur', role: 'admin' }
            : { id: account.id, email: account.email, name: account.name, role: account.role };
          const token = crypto.randomBytes(32).toString('base64url');
          sessions.set(token, { user, expiresAt: Date.now() + SESSION_TTL_MS });
          res.setHeader('Set-Cookie', sessionCookie(token, secureCookie));
          return json(res, 200, { user });
        }
        if (url.pathname === '/api/auth/logout' && req.method === 'POST') {
          const token = parseCookies(req.headers.cookie).petale_session;
          if (token) sessions.delete(token);
          res.setHeader('Set-Cookie', 'petale_session=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0' + (secureCookie ? '; Secure' : ''));
          return json(res, 200, { ok: true });
        }
        const token = parseCookies(req.headers.cookie).petale_session;
        const session = token ? sessions.get(token) : null;
        if (session && session.expiresAt <= Date.now()) sessions.delete(token);
        const activeSession = session && session.expiresAt > Date.now() ? session : null;
        if (url.pathname === '/api/auth/me' && req.method === 'GET') {
          return json(res, 200, { user: activeSession?.user || null });
        }
        if (!adminConfigured()) {
          return json(res, 503, { error: 'Authentification non configurée. Définissez PETAL_ADMIN_EMAIL et PETAL_ADMIN_PASSWORD.' });
        }
        if (!activeSession) return json(res, 401, { error: 'Connexion requise.' });
        const store = await loadStore();
        if (url.pathname === '/api/users' && req.method === 'GET') {
          if (activeSession.user.role !== 'admin') return json(res, 403, { error: 'Droits administrateur requis.' });
          return json(res, 200, { users: store.users.map(({ passwordHash, ...user }) => user) });
        }
        if (url.pathname === '/api/users' && req.method === 'POST') {
          if (activeSession.user.role !== 'admin') return json(res, 403, { error: 'Droits administrateur requis.' });
          const body = await readBody(req);
          const name = safeString(body.name, 100);
          const email = safeString(body.email, 254).toLowerCase();
          const password = typeof body.password === 'string' ? body.password : '';
          const role = safeString(body.role, 30);
          if (name.length < 2 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return json(res, 422, { error: 'Nom ou adresse e-mail invalide.' });
          if (!['fleuriste', 'livreur'].includes(role)) return json(res, 422, { error: 'Le rôle doit être fleuriste ou livreur.' });
          if (password.length < 12 || password.length > 1024) return json(res, 422, { error: 'Le mot de passe doit contenir entre 12 et 1024 caractères.' });
          if (email === process.env.PETAL_ADMIN_EMAIL.toLowerCase() || store.users.some(user => user.email === email)) return json(res, 409, { error: 'Un compte existe déjà pour cette adresse e-mail.' });
          if (role === 'livreur' && (store.couriers.some(courier => courier.name.toLowerCase() === name.toLowerCase()) || store.users.some(user => user.role === 'livreur' && user.name.toLowerCase() === name.toLowerCase()))) return json(res, 409, { error: 'Ce nom de livreur est déjà utilisé. Choisissez un nom distinct.' });
          const user = { id: crypto.randomUUID(), name, email, role, passwordHash: passwordRecord(password), createdAt: new Date().toISOString() };
          store.users.push(user);
          store.audit.unshift({ id: crypto.randomUUID(), action: 'user.created', entityId: user.id, actor: activeSession.user.email, at: new Date().toISOString(), role });
          store.audit = store.audit.slice(0, 1000);
          await saveStore(store);
          const { passwordHash, ...publicUser } = user;
          return json(res, 201, { user: publicUser });
        }
        if (url.pathname === '/api/orders/available' && req.method === 'GET') {
          if (activeSession.user.role !== 'livreur') return json(res, 403, { error: 'Cette route est réservée aux livreurs.' });
          const orders = store.orders.filter(order => order.status === 'À préparer' && !order.courier).map(({ id, name, address, slot, price, status, art, bouquet }) => ({ id, name, address, slot, price, status, art, bouquet }));
          return json(res, 200, { orders });
        }
        if (url.pathname === '/api/audit' && req.method === 'GET') {
          if (activeSession.user.role !== 'admin') return json(res, 403, { error: 'Droits administrateur requis.' });
          return json(res, 200, { events: store.audit.slice(0, 200) });
        }
        if (url.pathname === '/api/orders' && req.method === 'GET') {
          const orders = activeSession.user.role === 'livreur'
            ? store.orders.filter(order => order.courierId === activeSession.user.id)
            : activeSession.user.role === 'fleuriste'
              ? store.orders.filter(order => order.createdBy === activeSession.user.id)
              : store.orders;
          return json(res, 200, { orders });
        }
        if (url.pathname === '/api/couriers' && req.method === 'GET') {
          const registered = store.users.filter(user => user.role === 'livreur').map(user => ({
            id: user.id, name: user.name, vehicle: 'À préciser', area: 'Zone à configurer', status: 'Disponible', jobs: 0, emoji: '🚲'
          }));
          const knownNames = new Set(store.couriers.map(courier => courier.name.toLowerCase()));
          return json(res, 200, { couriers: [...store.couriers, ...registered.filter(courier => !knownNames.has(courier.name.toLowerCase()))] });
        }
        if (url.pathname === '/api/orders' && req.method === 'POST') {
          if (!['admin', 'fleuriste'].includes(activeSession.user.role)) return json(res, 403, { error: 'Droits fleuriste requis.' });
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
            createdBy: activeSession.user.id,
            createdAt: new Date().toISOString()
          };
          store.orders.unshift(item);
          store.audit.unshift({ id: crypto.randomUUID(), action: 'order.created', entityId: item.id, actor: activeSession.user.email, at: new Date().toISOString() });
          store.audit = store.audit.slice(0, 1000);
          await saveStore(store);
          return json(res, 201, { order: item });
        }
        const match = url.pathname.match(/^\/api\/orders\/([A-Za-z0-9-]+)\/(assign|status)$/);
        if (match && req.method === 'PATCH') {
          const id = match[1];
          const order = store.orders.find(item => item.id === id);
          if (!order) return json(res, 404, { error: 'Commande introuvable.' });
          if (activeSession.user.role === 'fleuriste' && order.createdBy !== activeSession.user.id) {
            return json(res, 403, { error: 'Un fleuriste ne peut gérer que ses propres commandes.' });
          }
          const body = await readBody(req);
          if (match[2] === 'assign') {
            const courier = safeString(body.courier, 100);
            if (activeSession.user.role === 'livreur') {
              if (courier !== activeSession.user.name) return json(res, 403, { error: 'Un livreur ne peut prendre que sa propre mission.' });
              if (order.status !== 'À préparer' || order.courier) return json(res, 409, { error: 'Cette mission n’est plus disponible.' });
            } else if (!['admin', 'fleuriste'].includes(activeSession.user.role)) {
              return json(res, 403, { error: 'Droits insuffisants pour attribuer une mission.' });
            }
            if (!courier) return json(res, 422, { error: 'Le nom du livreur est obligatoire.' });
            if (order.status === 'Livrée') return json(res, 409, { error: 'Cette commande est déjà livrée.' });
            order.courier = courier;
            if (activeSession.user.role === 'livreur') {
              order.courierId = activeSession.user.id;
            } else {
              const registeredCourier = store.users.find(user => user.role === 'livreur' && user.name.toLowerCase() === courier.toLowerCase());
              order.courierId = registeredCourier?.id || '';
            }
            order.status = 'En livraison';
          } else {
            const status = safeString(body.status, 40);
            if (activeSession.user.role === 'livreur' && (order.courierId !== activeSession.user.id || order.status !== 'En livraison' || status !== 'Livrée')) {
              return json(res, 403, { error: 'Un livreur ne peut confirmer que ses propres livraisons en cours.' });
            }
            if (!['admin', 'fleuriste', 'livreur'].includes(activeSession.user.role)) return json(res, 403, { error: 'Droits insuffisants pour modifier le statut.' });
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
            if (status === 'Livrée' && order.status !== 'Livrée') {
              order.deliveredAt = new Date().toISOString();
              order.deliveredBy = activeSession.user.email;
              order.deliveryNote = safeString(body.deliveryNote, 300);
            }
            order.status = status;
          }
          store.audit.unshift({ id: crypto.randomUUID(), action: match[2] === 'assign' ? 'order.assigned' : 'order.status_changed', entityId: order.id, actor: activeSession.user.email, at: new Date().toISOString(), status: order.status, courier: order.courier || '' });
          store.audit = store.audit.slice(0, 1000);
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
