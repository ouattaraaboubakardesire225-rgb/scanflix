// ScanFlix : les fonctions du serveur (comptes, identification, paiement)
const crypto = require('crypto');
const L = require('./_lib');

const fail = (res, e) => L.json(res, 500, { error: 'Erreur serveur : ' + e.message });

// Inscription / connexion
async function auth(req, res) {
  try {
    if (req.method !== 'POST') return L.json(res, 405, { error: 'POST seulement' });
    const body = await L.readJson(req);
    const email = String(body.email || '').trim().toLowerCase();
    const password = String(body.password || '');
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return L.json(res, 400, { error: 'Adresse e-mail invalide.' });
    }
    if (password.length < 6) {
      return L.json(res, 400, { error: 'Mot de passe : 6 caractères minimum.' });
    }
    if (body.action === 'signup') {
      if (await L.getUser(email)) {
        return L.json(res, 409, { error: 'Ce compte existe déjà. Connecte-toi.' });
      }
      const salt = crypto.randomBytes(16).toString('hex');
      const u = {
        email, salt,
        hash: L.hashPassword(password, salt),
        created: Date.now(),
        trialEnd: Date.now() + L.TRIAL_MS,
        paidUntil: 0,
      };
      await L.saveUser(u);
      return L.json(res, 200, { token: L.newSession(email), me: L.publicMe(u) });
    }
    if (body.action === 'login') {
      const u = await L.getUser(email);
      const ok = u && crypto.timingSafeEqual(
        Buffer.from(L.hashPassword(password, u.salt), 'hex'),
        Buffer.from(u.hash, 'hex')
      );
      if (!ok) return L.json(res, 401, { error: 'E-mail ou mot de passe incorrect.' });
      return L.json(res, 200, { token: L.newSession(email), me: L.publicMe(u) });
    }
    return L.json(res, 400, { error: 'Action inconnue.' });
  } catch (e) { return fail(res, e); }
}

// État du compte
async function me(req, res) {
  try {
    const u = await L.authUser(req);
    if (!u) return L.json(res, 401, { error: 'Session expirée.' });
    return L.json(res, 200, { me: L.publicMe(u) });
  } catch (e) { return fail(res, e); }
}

// Identification du film
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-2.5-flash';

async function askGemini(imageB64) {
  const key = process.env.GEMINI_API_KEY;
  if (!key) throw new Error('GEMINI_API_KEY manquante');
  const prompt =
    "Tu identifies des films et séries à partir d'une capture d'écran. " +
    'Réponds uniquement en JSON : {"title": titre original, "english_title": titre anglais international ou null, ' +
    '"alt_titles": [autres titres connus : français, caractères originaux (chinois, coréen, etc.)], ' +
    '"year": année ou null, "type": "movie" ou "tv", "confidence": nombre entre 0 et 1}. ' +
    "Si tu hésites, donne ta meilleure hypothèse avec une confiance faible. " +
    "Si l'image n'est clairement pas une scène de film ou de série, mets title à null.";
  const models = [GEMINI_MODEL, 'gemini-flash-lite-latest']
    .filter((m, i, a) => m && a.indexOf(m) === i);
  const body = JSON.stringify({
    contents: [{ parts: [{ text: prompt }, { inline_data: { mime_type: 'image/jpeg', data: imageB64 } }] }],
    generationConfig: { responseMimeType: 'application/json', temperature: 0.2 },
  });
  let j = null; let lastErr = 'Erreur Gemini'; let limited = false;
  for (let attempt = 0; attempt < 1 && !j; attempt++) {
    for (const m of models) {
      let r;
      try {
        r = await fetch(
          `https://generativelanguage.googleapis.com/v1beta/models/${m}:generateContent?key=${key}`,
          { method: 'POST', headers: { 'Content-Type': 'application/json' }, body, signal: AbortSignal.timeout(6000) }
        );
      } catch (e) { limited = true; lastErr = 'Gemini trop lent'; continue; }
      const jj = await r.json().catch(() => ({}));
      if (r.ok) { j = jj; break; }
      lastErr = (jj.error && jj.error.message) || 'Erreur Gemini';
      if (r.status === 429 || r.status === 503) { limited = true; continue; }
      if (r.status === 404) continue;
      throw new Error(lastErr);
    }
      }
  if (!j) {
    throw new Error(limited
      ? "Trop de demandes en même temps. Patiente environ 1 minute puis réessaie."
      : lastErr);
  }
  const text = j.candidates && j.candidates[0] && j.candidates[0].content.parts.map((p) => p.text || '').join('');
  return JSON.parse(text || '{}');
}

async function tmdb(path, params = {}) {
  const k = process.env.TMDB_API_KEY;
  if (!k) throw new Error('TMDB_API_KEY manquante');
  const q = new URLSearchParams(params);
  const headers = {};
  if (k.startsWith('eyJ')) headers.Authorization = 'Bearer ' + k;
  else q.set('api_key', k);
  const r = await fetch('https://api.themoviedb.org/3' + path + '?' + q.toString(), { headers });
  if (!r.ok) throw new Error('Erreur TMDB ' + r.status);
  return r.json();
}

async function identify(req, res) {
  try {
    if (req.method !== 'POST') return L.json(res, 405, { error: 'POST seulement' });
    const u = await L.authUser(req);
    if (!u) return L.json(res, 401, { error: 'Connecte-toi pour continuer.' });
    if (!L.access(u).allowed) return L.json(res, 402, { code: 'PAYWALL', error: 'Abonnement requis.' });
    const { image } = await L.readJson(req);
    if (!image || typeof image !== 'string') return L.json(res, 400, { error: 'Image manquante.' });
    const guess = await askGemini(image);
    if (!guess.title) {
      return L.json(res, 404, { error: "Je ne reconnais pas de film sur cette image. Essaie une capture plus nette." });
    }
    const pref = guess.type === 'tv' ? 'tv' : 'movie';
    const titles = [guess.title, guess.english_title].concat(Array.isArray(guess.alt_titles) ? guess.alt_titles : [])
      .filter((t) => t && typeof t === 'string');
    const uniq = [...new Set(titles)].slice(0, 5);
    let hit = null; let type = pref;
    const order = pref === 'tv' ? ['tv', 'movie'] : ['movie', 'tv'];
    const jobs = [];
    for (const t of uniq.slice(0, 3)) {
      for (const ty of order) {
        const params = { query: t, language: 'fr-FR' };
        if (guess.year) params[ty === 'tv' ? 'first_air_date_year' : 'year'] = String(guess.year);
        jobs.push({ ty, params });
        if (guess.year) jobs.push({ ty, params: { query: t, language: 'fr-FR' } });
      }
    }
    const outs = await Promise.all(jobs.map((jb) =>
      tmdb('/search/' + jb.ty, jb.params).catch(() => ({ results: [] }))));
    for (let i = 0; i < outs.length; i++) {
      if (outs[i].results && outs[i].results.length) { hit = outs[i].results[0]; type = jobs[i].ty; break; }
    }
    if (!hit) return L.json(res, 404, { error: 'Film introuvable : « ' + guess.title + ' ».' });
    const d = await tmdb('/' + type + '/' + hit.id, {
      language: 'fr-FR', append_to_response: 'videos', include_video_language: 'fr,en,null',
    });
    const vids = (d.videos && d.videos.results) || [];
    const trailer =
      vids.find((v) => v.site === 'YouTube' && v.type === 'Trailer' && v.official) ||
      vids.find((v) => v.site === 'YouTube' && v.type === 'Trailer') ||
      vids.find((v) => v.site === 'YouTube');
    const date = d.release_date || d.first_air_date || '';
    const img = (p, s) => (p ? 'https://image.tmdb.org/t/p/' + s + p : null);
    return L.json(res, 200, {
      id: d.id, type,
      title: d.title || d.name,
      originalTitle: d.original_title || d.original_name,
      year: date.slice(0, 4),
      overview: d.overview || '',
      genres: (d.genres || []).map((g) => g.name),
      runtime: d.runtime || (d.episode_run_time && d.episode_run_time[0]) || null,
      poster: img(d.poster_path, 'w500'),
      backdrop: img(d.backdrop_path, 'w780'),
      trailerKey: trailer ? trailer.key : null,
      confidence: guess.confidence || null,
    });
  } catch (e) { return fail(res, e); }
}

// Création de la facture PayDunya
async function pay(req, res) {
  try {
    if (req.method !== 'POST') return L.json(res, 405, { error: 'POST seulement' });
    const u = await L.authUser(req);
    if (!u) return L.json(res, 401, { error: 'Connecte-toi pour continuer.' });
    const origin = process.env.SITE_URL || 'https://' + req.headers.host;
    const r = await fetch(L.payBase() + '/checkout-invoice/create', {
      method: 'POST',
      headers: L.payHeaders(),
      body: JSON.stringify({
        invoice: { total_amount: L.PRICE, description: 'Abonnement ScanFlix - 30 jours' },
        store: { name: 'ScanFlix' },
        custom_data: { email: u.email },
        actions: {
          cancel_url: origin + '/?pay=cancel',
          return_url: origin + '/?pay=return',
          callback_url: origin + '/api/paydunya-ipn',
        },
      }),
    });
    const j = await r.json();
    if (j.response_code !== '00' || !j.token) {
      return L.json(res, 502, { error: 'PayDunya : ' + (j.response_text || 'erreur') });
    }
    await L.db('SET', 'invoice:' + j.token, u.email, 'EX', String(7 * 24 * 3600));
    return L.json(res, 200, { url: j.response_text, token: j.token });
  } catch (e) { return fail(res, e); }
}

// Vérification du paiement au retour de PayDunya
async function verifyPay(req, res) {
  try {
    const u = await L.authUser(req);
    if (!u) return L.json(res, 401, { error: 'Session expirée.' });
    const url = new URL(req.url, 'http://x');
    const token = (req.query && req.query.token) || url.searchParams.get('token');
    if (!token) return L.json(res, 400, { error: 'Jeton manquant.' });
    const owner = await L.db('GET', 'invoice:' + token);
    if (owner !== u.email) return L.json(res, 403, { error: 'Facture inconnue.' });
    const r = await L.activate(token);
    const fresh = await L.getUser(u.email);
    return L.json(res, 200, { ok: r.ok, status: r.status || 'completed', me: L.publicMe(fresh) });
  } catch (e) { return fail(res, e); }
}

// Notification automatique de PayDunya
function findToken(raw, body) {
  const params = new URLSearchParams(raw);
  for (const [k, v] of params) {
    if (/\[token\]$/.test(k) && v) return v;
  }
  const o = body && (body.data || body);
  if (o && o.invoice && o.invoice.token) return o.invoice.token;
  if (o && o.token) return o.token;
  return null;
}
async function ipn(req, res) {
  try {
    if (req.method !== 'POST') return L.json(res, 405, { error: 'POST seulement' });
    let raw = '';
    let body = {};
    if (req.body && typeof req.body === 'object') {
      body = req.body;
      raw = new URLSearchParams(
        Object.entries(body).filter(([, v]) => typeof v === 'string')
      ).toString();
    } else if (typeof req.body === 'string') {
      raw = req.body;
      try { body = JSON.parse(raw); } catch (e) { /* formulaire */ }
    } else {
      raw = await L.readRaw(req);
      try { body = JSON.parse(raw); } catch (e) { /* formulaire */ }
    }
    const token = findToken(raw, body);
    if (!token) return L.json(res, 400, { error: 'Jeton introuvable.' });
    const r = await L.activate(token);
    return L.json(res, 200, { received: true, ok: r.ok });
  } catch (e) { return fail(res, e); }
}

module.exports = { auth, me, identify, pay, verify: verifyPay, 'paydunya-ipn': ipn };
