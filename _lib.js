// ScanFlix : fonctions communes du serveur
const crypto = require('crypto');

const DB_URL = process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL;
const DB_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN;
const SECRET = process.env.SESSION_SECRET || '';
const PRICE = Number(process.env.PRICE_FCFA || 1000);
const TRIAL_MS = 24 * 3600 * 1000;
const MONTH_MS = 30 * 24 * 3600 * 1000;

function json(res, code, obj) {
  res.statusCode = code;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(obj));
}

async function readRaw(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  return Buffer.concat(chunks).toString('utf8');
}

async function readJson(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  if (typeof req.body === 'string') {
    try { return JSON.parse(req.body); } catch (e) { return {}; }
  }
  try { return JSON.parse(await readRaw(req)); } catch (e) { return {}; }
}

async function db(...cmd) {
  if (!DB_URL || !DB_TOKEN) throw new Error('Base de données non configurée');
  const r = await fetch(DB_URL, {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + DB_TOKEN, 'Content-Type': 'application/json' },
    body: JSON.stringify(cmd),
  });
  const j = await r.json();
  if (j.error) throw new Error(j.error);
  return j.result;
}
async function getUser(email) {
  const v = await db('GET', 'user:' + email);
  return v ? JSON.parse(v) : null;
}
async function saveUser(u) {
  await db('SET', 'user:' + u.email, JSON.stringify(u));
}

function b64(s) { return Buffer.from(s).toString('base64url'); }
function sign(payload) {
  if (!SECRET) throw new Error('SESSION_SECRET manquant');
  const body = b64(JSON.stringify(payload));
  const mac = crypto.createHmac('sha256', SECRET).update(body).digest('base64url');
  return body + '.' + mac;
}
function verify(token) {
  if (!SECRET || !token || !token.includes('.')) return null;
  const [body, mac] = token.split('.');
  const good = crypto.createHmac('sha256', SECRET).update(body).digest('base64url');
  const a = Buffer.from(mac), b = Buffer.from(good);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const p = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    return p.exp > Date.now() ? p : null;
  } catch (e) { return null; }
}
function newSession(email) {
  return sign({ email, exp: Date.now() + 365 * 24 * 3600 * 1000 });
}
async function authUser(req) {
  const h = req.headers.authorization || '';
  const p = verify(h.startsWith('Bearer ') ? h.slice(7) : '');
  if (!p) return null;
  return getUser(p.email);
}

function hashPassword(password, salt) {
  return crypto.scryptSync(password, salt, 32).toString('hex');
}

function isAdmin(email) {
  const a = (process.env.ADMIN_EMAIL || '').trim().toLowerCase();
  return !!a && email === a;
}
function access(u) {
  const now = Date.now();
  if (isAdmin(u.email)) return { allowed: true, status: 'admin', until: null };
  if ((u.paidUntil || 0) > now) return { allowed: true, status: 'paid', until: u.paidUntil };
  if ((u.trialEnd || 0) > now) return { allowed: true, status: 'trial', until: u.trialEnd };
  return { allowed: false, status: 'expired', until: u.paidUntil || u.trialEnd || null };
}
function publicMe(u) {
  const a = access(u);
  return { email: u.email, status: a.status, allowed: a.allowed, until: a.until, price: PRICE };
}

function payBase() {
  return process.env.PAYDUNYA_MODE === 'test'
    ? 'https://app.paydunya.com/sandbox-api/v1'
    : 'https://app.paydunya.com/api/v1';
}
function payHeaders() {
  return {
    'Content-Type': 'application/json',
    'PAYDUNYA-MASTER-KEY': process.env.PAYDUNYA_MASTER_KEY || '',
    'PAYDUNYA-PRIVATE-KEY': process.env.PAYDUNYA_PRIVATE_KEY || '',
    'PAYDUNYA-TOKEN': process.env.PAYDUNYA_TOKEN || '',
  };
}

// Vérifie auprès de PayDunya que la facture est payée, puis ajoute 30 jours.
async function activate(token) {
  const email = await db('GET', 'invoice:' + token);
  if (!email) return { ok: false, status: 'unknown_invoice' };
  const r = await fetch(payBase() + '/checkout-invoice/confirm/' + encodeURIComponent(token), {
    headers: payHeaders(),
  });
  const j = await r.json();
  if (j.status !== 'completed') return { ok: false, status: j.status || 'pending' };
  const total = Number((j.invoice && j.invoice.total_amount) || 0);
  if (total < PRICE) return { ok: false, status: 'bad_amount' };
  const first = await db('SET', 'paid:' + token, '1', 'NX');
  if (first !== 'OK') return { ok: true, already: true };
  const u = await getUser(email);
  if (!u) return { ok: false, status: 'no_user' };
  u.paidUntil = Math.max(Date.now(), u.paidUntil || 0) + MONTH_MS;
  await saveUser(u);
  return { ok: true };
}

module.exports = {
  json, readJson, readRaw, db, getUser, saveUser, newSession, authUser,
  hashPassword, access, publicMe, isAdmin, payBase, payHeaders, activate,
  PRICE, TRIAL_MS,
};
