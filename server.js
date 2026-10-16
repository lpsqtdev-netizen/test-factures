'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const DATABASE_PATH = process.env.PETAL_DATABASE_PATH || '';
let database = null;
const storeRevisions = new WeakMap();

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
  settingsByUser: {},
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
function normalizeStore(parsed) {
  if (parsed && Array.isArray(parsed.orders) && Array.isArray(parsed.couriers)) {
    if (!Array.isArray(parsed.audit)) parsed.audit = [];
    if (!Array.isArray(parsed.users)) parsed.users = [];
    if (!parsed.settingsByUser || typeof parsed.settingsByUser !== 'object' || Array.isArray(parsed.settingsByUser)) parsed.settingsByUser = {};
    return parsed;
  }
  return null;
}

function getDatabase() {
  if (!DATABASE_PATH) return null;
  if (!database) {
    fs.mkdirSync(path.dirname(path.resolve(DATABASE_PATH)), { recursive: true, mode: 0o700 });
    const Database = require('better-sqlite3');
    database = new Database(DATABASE_PATH);
    fs.chmodSync(DATABASE_PATH, 0o600);
    database.pragma('journal_mode = WAL');
    database.pragma('busy_timeout = 5000');
    database.pragma('foreign_keys = ON');
    database.exec(`
      CREATE TABLE IF NOT EXISTS app_state (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        payload TEXT NOT NULL,
        source_sha256 TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        revision INTEGER NOT NULL DEFAULT 1
      );
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        applied_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS orders (
        id TEXT PRIMARY KEY,
        position INTEGER NOT NULL,
        status TEXT NOT NULL,
        created_by TEXT NOT NULL DEFAULT '',
        courier_account_id TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL DEFAULT '',
        payload TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_orders_status_position ON orders(status, position);
      CREATE INDEX IF NOT EXISTS idx_orders_created_by ON orders(created_by);
      CREATE INDEX IF NOT EXISTS idx_orders_courier_account_id ON orders(courier_account_id);
      CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY,
        position INTEGER NOT NULL,
        email TEXT NOT NULL,
        role TEXT NOT NULL,
        payload TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);
      CREATE TABLE IF NOT EXISTS couriers (
        id TEXT PRIMARY KEY,
        position INTEGER NOT NULL,
        payload TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS business_settings (
        user_id TEXT PRIMARY KEY,
        payload TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS audit_events (
        id TEXT PRIMARY KEY,
        position INTEGER NOT NULL,
        at TEXT NOT NULL DEFAULT '',
        action TEXT NOT NULL DEFAULT '',
        entity_id TEXT NOT NULL DEFAULT '',
        payload TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_audit_events_at ON audit_events(at);
      CREATE INDEX IF NOT EXISTS idx_audit_events_action ON audit_events(action);
    `);
    const stateColumns = database.pragma('table_info(app_state)');
    if (!stateColumns.some(column => column.name === 'revision')) {
      database.exec('ALTER TABLE app_state ADD COLUMN revision INTEGER NOT NULL DEFAULT 1');
    }
    database.prepare('INSERT OR IGNORE INTO schema_migrations (version, name, applied_at) VALUES (3, ?, ?)')
      .run('optimistic-store-revision', new Date().toISOString());
  }
  return database;
}

function writeRelationalStore(db, store) {
  db.exec('DELETE FROM orders; DELETE FROM users; DELETE FROM couriers; DELETE FROM business_settings; DELETE FROM audit_events;');
  const insertOrder = db.prepare('INSERT INTO orders (id, position, status, created_by, courier_account_id, created_at, payload) VALUES (?, ?, ?, ?, ?, ?, ?)');
  store.orders.forEach((item, position) => insertOrder.run(
    String(item.id), position, String(item.status || ''), String(item.createdBy || ''),
    String(item.courierAccountId || ''), String(item.createdAt || ''), JSON.stringify(item)
  ));
  const insertUser = db.prepare('INSERT INTO users (id, position, email, role, payload) VALUES (?, ?, ?, ?, ?)');
  store.users.forEach((item, position) => insertUser.run(
    String(item.id), position, String(item.email || '').toLowerCase(), String(item.role || ''), JSON.stringify(item)
  ));
  const insertCourier = db.prepare('INSERT INTO couriers (id, position, payload) VALUES (?, ?, ?)');
  store.couriers.forEach((item, position) => insertCourier.run(String(item.id), position, JSON.stringify(item)));
  const insertSetting = db.prepare('INSERT INTO business_settings (user_id, payload) VALUES (?, ?)');
  Object.entries(store.settingsByUser).forEach(([userId, settings]) => insertSetting.run(userId, JSON.stringify(settings)));
  const insertAudit = db.prepare('INSERT INTO audit_events (id, position, at, action, entity_id, payload) VALUES (?, ?, ?, ?, ?, ?)');
  store.audit.forEach((item, position) => insertAudit.run(
    String(item.id), position, String(item.at || ''), String(item.action || ''),
    String(item.entityId || ''), JSON.stringify(item)
  ));
  db.prepare('INSERT OR IGNORE INTO schema_migrations (version, name, applied_at) VALUES (2, ?, ?)')
    .run('normalized-business-tables', new Date().toISOString());
}

function readRelationalStore(db, store) {
  const migrated = db.prepare('SELECT version FROM schema_migrations WHERE version = 2').get();
  if (!migrated) {
    const migrate = db.transaction(() => writeRelationalStore(db, store));
    migrate();
    return store;
  }
  const readPayloads = table => db.prepare('SELECT payload FROM ' + table + ' ORDER BY position').all().map(row => JSON.parse(row.payload));
  store.orders = readPayloads('orders');
  store.users = readPayloads('users');
  store.couriers = readPayloads('couriers');
  store.audit = readPayloads('audit_events');
  store.settingsByUser = Object.fromEntries(db.prepare('SELECT user_id, payload FROM business_settings').all()
    .map(row => [row.user_id, JSON.parse(row.payload)]));
  return store;
}

async function loadJsonStore() {
  try {
    const parsed = normalizeStore(JSON.parse(await fs.promises.readFile(STORE_PATH, 'utf8')));
    if (parsed) return parsed;
  } catch (err) {
    if (err.code !== 'ENOENT' && !(err instanceof SyntaxError)) throw err;
  }
  return structuredClone(seed);
}

async function loadStore() {
  const db = getDatabase();
  if (!db) return loadJsonStore();
  const row = db.prepare('SELECT payload, revision FROM app_state WHERE id = 1').get();
  if (row) {
    const parsed = normalizeStore(JSON.parse(row.payload));
    if (!parsed) throw new Error('État SQLite invalide : commandes et livreurs doivent être des listes.');
    storeRevisions.set(parsed, row.revision);
    return readRelationalStore(db, parsed);
  }
  // First boot in SQLite mode imports an existing JSON store without deleting it.
  const initial = await loadJsonStore();
  const payload = JSON.stringify(initial);
  const now = new Date().toISOString();
  const insert = db.transaction(() => {
    db.prepare('INSERT INTO app_state (id, payload, source_sha256, updated_at) VALUES (1, ?, ?, ?)')
      .run(payload, crypto.createHash('sha256').update(payload).digest('hex'), now);
    db.prepare('INSERT OR IGNORE INTO schema_migrations (version, name, applied_at) VALUES (1, ?, ?)')
      .run('json-store-import', now);
    writeRelationalStore(db, initial);
  });
  insert();
  storeRevisions.set(initial, 1);
  return initial;
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

async function createDatabaseBackup(db) {
  const backupDir = DATABASE_PATH + '.backups';
  await fs.promises.mkdir(backupDir, { recursive: true, mode: 0o700 });
  const stamp = String(Date.now()).padStart(13, '0');
  const backupPath = path.join(backupDir, 'store-' + stamp + '-' + process.pid + '-' + crypto.randomBytes(4).toString('hex') + '.sqlite');
  await db.backup(backupPath);
  await fs.promises.chmod(backupPath, 0o600);
  const files = (await fs.promises.readdir(backupDir)).filter(name => /^store-.*\.sqlite$/.test(name)).sort().reverse();
  await Promise.all(files.slice(BACKUP_RETENTION).map(name => fs.promises.unlink(path.join(backupDir, name))));
  return backupPath;
}

async function saveStore(store) {
  const db = getDatabase();
  if (db) {
    const expectedRevision = storeRevisions.get(store);
    if (expectedRevision === undefined) {
      const err = new Error('État SQLite non chargé depuis la base. Rechargez les données avant de les modifier.');
      err.status = 409;
      throw err;
    }
    const current = db.prepare('SELECT revision FROM app_state WHERE id = 1').get();
    if (!current || current.revision !== expectedRevision) {
      const err = new Error('Les données ont été modifiées par une autre requête. Rechargez puis réessayez.');
      err.status = 409;
      throw err;
    }
    await createDatabaseBackup(db);
    const payload = JSON.stringify(store);
    const now = new Date().toISOString();
    const digest = crypto.createHash('sha256').update(payload).digest('hex');
    const write = db.transaction(() => {
      const result = db.prepare(`UPDATE app_state SET payload = ?, source_sha256 = ?, updated_at = ?, revision = revision + 1
        WHERE id = 1 AND revision = ?`).run(payload, digest, now, expectedRevision);
      if (result.changes !== 1) {
        const err = new Error('Les données ont été modifiées par une autre requête. Rechargez puis réessayez.');
        err.status = 409;
        throw err;
      }
      writeRelationalStore(db, store);
    });
    write();
    storeRevisions.set(store, expectedRevision + 1);
    return;
  }
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

function closeStore() {
  if (database) {
    database.close();
    database = null;
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
      res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
      res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
      res.setHeader('X-Permitted-Cross-Domain-Policies', 'none');
      res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com data:; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'");
      const url = new URL(req.url, 'http://localhost');
      if (url.pathname.startsWith('/api/') && !['GET', 'HEAD', 'OPTIONS'].includes(req.method) && req.headers.origin) {
        let origin;
        try {
          origin = new URL(req.headers.origin);
        } catch {
          return json(res, 403, { error: 'Origine de requête refusée.' });
        }
        if (!req.headers.host || origin.host !== req.headers.host) return json(res, 403, { error: 'Origine de requête refusée.' });
      }
      if (url.pathname.startsWith('/api/')) {
        if (req.method === 'OPTIONS') {
          res.writeHead(204, { 'Allow': 'GET, POST, PATCH, OPTIONS' });
          return res.end();
        }
        if (url.pathname === '/api/health' && req.method === 'GET') {
          return json(res, 200, { ok: true, service: 'petale-api', storage: DATABASE_PATH ? 'sqlite' : 'json-file', auth: 'required', adminConfigured: adminConfigured() });
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
        if (url.pathname === '/api/auth/password' && req.method === 'POST') {
          if (activeSession.user.role === 'admin') {
            return json(res, 403, { error: 'Le mot de passe administrateur se gère via la configuration de déploiement.' });
          }
          const body = await readBody(req);
          const currentPassword = typeof body.currentPassword === 'string' ? body.currentPassword : '';
          const newPassword = typeof body.newPassword === 'string' ? body.newPassword : '';
          if (newPassword.length < 12 || newPassword.length > 1024) {
            return json(res, 422, { error: 'Le nouveau mot de passe doit contenir entre 12 et 1024 caractères.' });
          }
          const account = store.users.find(user => user.id === activeSession.user.id);
          if (!account || !passwordMatches(currentPassword, account.passwordHash)) {
            return json(res, 401, { error: 'Mot de passe actuel incorrect.' });
          }
          if (passwordMatches(newPassword, account.passwordHash)) {
            return json(res, 422, { error: 'Choisissez un mot de passe différent de l’actuel.' });
          }
          account.passwordHash = passwordRecord(newPassword);
          account.passwordChangedAt = new Date().toISOString();
          store.audit.unshift({ id: crypto.randomUUID(), action: 'user.password_changed', entityId: account.id, actor: account.email, at: new Date().toISOString() });
          store.audit = store.audit.slice(0, 1000);
          await saveStore(store);
          for (const [sessionToken, sessionData] of sessions) {
            if (sessionData.user.id === account.id && sessionToken !== token) sessions.delete(sessionToken);
          }
          return json(res, 200, { ok: true, passwordChangedAt: account.passwordChangedAt });
        }
        if (url.pathname === '/api/settings' && req.method === 'GET') {
          if (!['admin', 'fleuriste'].includes(activeSession.user.role)) {
            return json(res, 403, { error: 'Les paramètres de boutique sont réservés aux comptes administrateur et fleuriste.' });
          }
          return json(res, 200, { settings: store.settingsByUser[activeSession.user.id] || null });
        }
        if (url.pathname === '/api/settings' && req.method === 'POST') {
          if (!['admin', 'fleuriste'].includes(activeSession.user.role)) {
            return json(res, 403, { error: 'Les paramètres de boutique sont réservés aux comptes administrateur et fleuriste.' });
          }
          const body = await readBody(req);
          const settings = {
            shopName: safeString(body.shopName, 100),
            ownerName: safeString(body.ownerName, 100),
            email: safeString(body.email, 254).toLowerCase(),
            phone: safeString(body.phone, 40),
            pickupAddress: safeString(body.pickupAddress, 240),
            siret: safeString(body.siret, 20).replace(/\s/g, ''),
            vatNumber: safeString(body.vatNumber, 30).toUpperCase()
          };
          if (settings.shopName.length < 2) return json(res, 422, { error: 'Le nom de la boutique doit contenir au moins 2 caractères.' });
          if (settings.ownerName.length < 2) return json(res, 422, { error: 'Le nom du responsable doit contenir au moins 2 caractères.' });
          if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(settings.email)) return json(res, 422, { error: 'Adresse e-mail professionnelle invalide.' });
          if (settings.siret && !/^\d{14}$/.test(settings.siret)) return json(res, 422, { error: 'Le SIRET doit contenir exactement 14 chiffres.' });
          settings.updatedAt = new Date().toISOString();
          settings.updatedBy = activeSession.user.email;
          store.settingsByUser[activeSession.user.id] = settings;
          store.audit.unshift({ id: crypto.randomUUID(), action: 'settings.updated', entityId: activeSession.user.id, actor: activeSession.user.email, at: settings.updatedAt });
          store.audit = store.audit.slice(0, 1000);
          await saveStore(store);
          return json(res, 200, { settings });
        }
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
            let registeredCourier = null;
            if (activeSession.user.role === 'livreur') {
              order.courierId = activeSession.user.id;
            } else {
              registeredCourier = store.users.find(user => user.role === 'livreur' && user.name.toLowerCase() === courier.toLowerCase());
              if (!registeredCourier) return json(res, 422, { error: 'Attribuez la commande à un compte livreur créé dans Pétale, pas à un livreur de démonstration.' });
              order.courierId = registeredCourier.id;
            }
            order.courier = registeredCourier?.name || courier;
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
module.exports = { createServer, validateNewOrder, loadStore, saveStore, closeStore };
