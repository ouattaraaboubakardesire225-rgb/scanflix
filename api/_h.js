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
      const nm = String(body.name || '').trim().slice(0, 40);
      const dev = String(body.device || '').replace(/[^a-zA-Z0-9]/g, '').slice(0, 40);
      let trialEnd = Date.now() + L.TRIAL_MS;
      let trialUsed = false;
      if (dev.length >= 12 && !L.isAdmin(email)) {
        const k = 'trialdev:' + dev;
        if (await L.db('GET', k)) { trialEnd = Date.now(); trialUsed = true; }
        else await L.db('SET', k, '1');
      }
      const u = {
        email, salt, name: nm,
        hash: L.hashPassword(password, salt),
        created: Date.now(),
        trialEnd,
        paidUntil: 0,
      };
      await L.saveUser(u);
      return L.json(res, 200, { token: L.newSession(email), me: L.publicMe(u), trialUsed });
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

async function askGemini(images, hint, clip) {
  if (!Array.isArray(images)) images = [images];
  const key = process.env.GEMINI_API_KEY;
  if (!key) throw new Error('GEMINI_API_KEY manquante');
  const prompt =
    "Tu es un expert en cinéma, séries et animes. Tu identifies l'œuvre à partir d'une capture d'écran. " +
    "Procède avec méthode : d'abord examine TOUS les détails, même les plus petits (texte à l'écran, sous-titres, logos de chaîne ou de plateforme, filigranes et noms de comptes dans les coins, costumes, armes, véhicules, décor, époque, langue des textes, style et qualité de l'image, personnages dessinés). " +
    "Note les indices (clues), ensuite seulement donne le titre. Ne devine jamais l'identité d'une personne réelle d'après son visage : appuie-toi sur le texte et le contexte. " +
    'Réponds uniquement en JSON, avec les champs dans cet ordre : ' +
    '{"clues": [3 à 6 indices courts : acteurs reconnus, texte ou sous-titres lus, décor, époque, uniforme, langue, logo], ' +
    '"medium": "live_action" (vraies personnes filmées) ou "animation" (dessin animé, anime, 3D), ' +
    '"title": titre original, "english_title": titre anglais international ou null, ' +
    '"alt_titles": [autres titres connus : français, caractères originaux], ' +
    '"year": année ou null, "type": "movie" ou "tv", "confidence": nombre entre 0 et 1}. ' +
    "Règles : le champ medium doit correspondre à l'image (ne propose JAMAIS un anime pour une image avec de vraies personnes, ni l'inverse). " +
    "confidence doit être honnête : 0.8 ou plus seulement si tu reconnais clairement (acteur connu, titre affiché, scène célèbre) ; " +
    "entre 0.3 et 0.6 si tu hésites ; moins de 0.3 si tu devines. " +
    (clip ? "Tu reçois un VRAI EXTRAIT VIDÉO avec son. Regarde le mouvement, lis les sous-titres et textes, ÉCOUTE les dialogues (langue, accent, phrases célèbres), la musique et les bruitages, et croise tous ces indices. " : '') +
    (!clip && images.length > 1 ? "Les " + images.length + " images sont des extraits successifs d'une même vidéo : croise les indices de toutes les images (visages, décors, texte, sous-titres, logos). " : '') +
    "Si tu hésites, donne quand même ta meilleure hypothèse mais avec une confiance basse. " +
    "Mets title à null seulement si l'image est vide, noire ou illisible." +
    (hint ? " Indice donné par l'utilisateur (à utiliser en priorité) : « " + String(hint).slice(0, 200) + " »." : '');
  const models = [GEMINI_MODEL, 'gemini-flash-lite-latest']
    .filter((m, i, a) => m && a.indexOf(m) === i);
  const body = JSON.stringify({
    contents: [{ parts: [{ text: prompt }].concat(clip
      ? [{ inline_data: { mime_type: clip.mime, data: clip.data } }]
      : images.map((im) => ({ inline_data: { mime_type: 'image/jpeg', data: im } }))) }],
    generationConfig: { responseMimeType: 'application/json', temperature: 0 },
  });
  let j = null; let lastErr = 'Erreur Gemini'; let limited = false;
  const t0 = Date.now();
  for (let attempt = 0; attempt < 1 && !j; attempt++) {
    for (const [mi, m] of models.entries()) {
      // Vercel coupe à 30 s : on garde une marge. Vidéo = plus de temps pour le 1er modèle.
      const left = 26000 - (Date.now() - t0);
      if (left < 3000) { limited = true; lastErr = 'Gemini trop lent'; break; }
      const cap = mi === 0 ? (clip ? 18000 : 12000) : 8000;
      let r;
      try {
        r = await fetch(
          `https://generativelanguage.googleapis.com/v1beta/models/${m}:generateContent?key=${key}`,
          { method: 'POST', headers: { 'Content-Type': 'application/json' }, body, signal: AbortSignal.timeout(Math.min(cap, left)) }
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

const bits = (n) => { let k = 0; while (n) { k += n & 1; n >>= 1; } return k; };
function hamming(a, b) { let d = 0; for (let i = 0; i < 16; i++) d += bits(parseInt(a[i], 16) ^ parseInt(b[i], 16)); return d; }
async function getLearned() {
  try { const v = await L.db('GET', 'corr:all'); return v ? JSON.parse(v) : []; } catch (e) { return []; }
}
// Enregistre une correction faite par un utilisateur
async function learn(req, res) {
  try {
    if (req.method !== 'POST') return L.json(res, 405, { error: 'POST seulement' });
    const u = await L.authUser(req);
    if (!u) return L.json(res, 401, { error: 'Session expirée.' });
    const b = await L.readJson(req);
    const ph = String(b.ph || '');
    const id = String(b.id || '').replace(/\D/g, '');
    const type = b.type === 'tv' ? 'tv' : 'movie';
    if (!/^[0-9a-f]{16}$/.test(ph) || !id) return L.json(res, 400, { error: 'Données invalides.' });
    const list = (await getLearned()).filter((e) => hamming(ph, e.ph) > 5);
    list.push({ ph, type, id });
    await L.db('SET', 'corr:all', JSON.stringify(list.slice(-1500)));
    return L.json(res, 200, { ok: true });
  } catch (e) { return fail(res, e); }
}

async function identify(req, res) {
  try {
    if (req.method !== 'POST') return L.json(res, 405, { error: 'POST seulement' });
    const u = await L.authUser(req);
    if (!u) return L.json(res, 401, { error: 'Connecte-toi pour continuer.' });
    if (!L.access(u).allowed) return L.json(res, 402, { code: 'PAYWALL', error: 'Abonnement requis.' });
    const bd = await L.readJson(req);
    const { hint, ph } = bd;
    const list = (Array.isArray(bd.images) ? bd.images : [bd.image]).filter((x) => typeof x === 'string' && x.length > 0).slice(0, 8);
    const image = list[0];
    if (!image) return L.json(res, 400, { error: 'Image manquante.' });
    if (!L.isAdmin(u.email)) {
      const day = new Date().toISOString().slice(0, 10);
      const ck = 'scans:' + u.email + ':' + day;
      const n = Number(await L.db('INCR', ck));
      if (n === 1) await L.db('EXPIRE', ck, 90000);
      const max = Number(process.env.SCAN_LIMIT) || 40;
      if (n > max) return L.json(res, 429, { error: 'Limite de ' + max + ' scans par jour atteinte. Reviens demain.' });
    }
    // Mémoire des corrections : une image très proche d'une image déjà corrigée donne directement le bon film.
    if (!hint && typeof ph === 'string' && /^[0-9a-f]{16}$/.test(ph)) {
      const learned = await getLearned();
      let best = null;
      for (const e of learned) { const d = hamming(ph, e.ph); if (d <= 5 && (!best || d < best.d)) best = { d, e }; }
      if (best) {
        const f = await filmDetails(best.e.type, best.e.id);
        f.confidence = 0.95; f.alts = [];
        return L.json(res, 200, f);
      }
    }
    let clip = null;
    if (typeof bd.clip === 'string' && bd.clip.length > 100 && bd.clip.length < 3600000 && /^video\/(webm|mp4)$/.test(String(bd.clipMime || ''))) {
      clip = { data: bd.clip, mime: String(bd.clipMime) };
    }
    let guess;
    if (clip) {
      try { guess = await askGemini(list, hint, clip); }
      catch (e) {
        if (/Trop de demandes/.test(e.message)) throw e;
        guess = await askGemini(list, hint); // la vidéo n'a pas été acceptée : on retombe sur les images
      }
    } else guess = await askGemini(list, hint);
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
    // L'IA dit si l'image est filmée (live_action) ou dessinée (animation) : on écarte les résultats du mauvais genre.
    const ANIM = 16;
    const medium = guess.medium === 'animation' ? 'animation' : guess.medium === 'live_action' ? 'live_action' : '';
    const byMedium = (list) => {
      if (!medium) return list;
      const good = list.filter((r) => ((r.genre_ids || []).includes(ANIM)) === (medium === 'animation'));
      return good.length ? good : list;
    };
    const outs = (await Promise.all(jobs.map((jb) =>
      tmdb('/search/' + jb.ty, jb.params).catch(() => ({ results: [] }))))).map((o) => ({ results: byMedium(o.results || []) }));
    for (let i = 0; i < outs.length; i++) {
      if (outs[i].results && outs[i].results.length) { hit = outs[i].results[0]; type = jobs[i].ty; break; }
    }
    if (!hit) return L.json(res, 404, { error: 'Film introuvable : « ' + guess.title + ' ». Essaie une autre capture, avec un visage ou un décor bien visible.' });
    const alts = [];
    const seen = new Set([type + ':' + hit.id]);
    outs.forEach((o, i) => {
      (o.results || []).slice(0, 3).forEach((r) => {
        if (medium && ((r.genre_ids || []).includes(ANIM)) !== (medium === 'animation')) return;
        const k = jobs[i].ty + ':' + r.id;
        if (seen.has(k) || alts.length >= 4) return;
        seen.add(k);
        alts.push({
          id: r.id, type: jobs[i].ty, title: r.title || r.name,
          year: String(r.release_date || r.first_air_date || '').slice(0, 4),
          poster: r.poster_path ? 'https://image.tmdb.org/t/p/w185' + r.poster_path : null,
        });
      });
    });
    const film = await filmDetails(type, hit.id);
    film.confidence = guess.confidence || null;
    film.clues = Array.isArray(guess.clues) ? guess.clues.filter((c) => typeof c === 'string').map((c) => c.slice(0, 90)).slice(0, 6) : [];
    film.alts = alts;
    return L.json(res, 200, film);
  } catch (e) { return fail(res, e); }
}

function watchInfo(d) {
  const r = (d['watch/providers'] && d['watch/providers'].results) || {};
  for (const reg of ['CI', 'SN', 'FR', 'US']) {
    const x = r[reg];
    const names = x ? [].concat(x.flatrate || [], x.free || []).map((p) => p.provider_name) : [];
    if (names.length) return { region: reg, names: [...new Set(names)].slice(0, 6) };
  }
  return null;
}

async function filmDetails(type, id) {
  const d = await tmdb('/' + type + '/' + id, {
    language: 'fr-FR', append_to_response: 'videos,watch/providers,similar', include_video_language: 'fr,en,null',
  });
  const vids = (d.videos && d.videos.results) || [];
  const trailer =
    vids.find((v) => v.site === 'YouTube' && v.type === 'Trailer' && v.official) ||
    vids.find((v) => v.site === 'YouTube' && v.type === 'Trailer') ||
    vids.find((v) => v.site === 'YouTube');
  const date = d.release_date || d.first_air_date || '';
  const img = (p, s) => (p ? 'https://image.tmdb.org/t/p/' + s + p : null);
  return {
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
    watch: watchInfo(d),
    similar: ((d.similar && d.similar.results) || []).filter((x) => x.poster_path).slice(0, 8).map((x) => ({
      id: x.id, type, title: x.title || x.name,
      year: String(x.release_date || x.first_air_date || '').slice(0, 4),
      poster: 'https://image.tmdb.org/t/p/w185' + x.poster_path,
    })),
    confidence: null,
  };
}

// Détails d'un film choisi dans « Ce n'est pas le bon film ? »
async function film(req, res) {
  try {
    const u = await L.authUser(req);
    if (!u) return L.json(res, 401, { error: 'Connecte-toi pour continuer.' });
    if (!L.access(u).allowed) return L.json(res, 402, { code: 'PAYWALL', error: 'Abonnement requis.' });
    const url = new URL(req.url, 'http://x');
    const q = String(url.searchParams.get('q') || '').trim().slice(0, 100);
    if (q) {
      const r = await tmdb('/search/multi', { query: q, language: 'fr-FR' });
      const results = (r.results || []).filter((x) => x.media_type === 'movie' || x.media_type === 'tv').slice(0, 8).map((x) => ({
        id: x.id, type: x.media_type, title: x.title || x.name,
        year: String(x.release_date || x.first_air_date || '').slice(0, 4),
        poster: x.poster_path ? 'https://image.tmdb.org/t/p/w185' + x.poster_path : null,
      }));
      return L.json(res, 200, { results });
    }
    const type = url.searchParams.get('type') === 'tv' ? 'tv' : 'movie';
    const id = String(url.searchParams.get('id') || '').replace(/\D/g, '');
    if (!id) return L.json(res, 400, { error: 'Film manquant.' });
    return L.json(res, 200, await filmDetails(type, id));
  } catch (e) { return fail(res, e); }
}

// Profil : nom, téléphone, mot de passe, suppression du compte
async function profile(req, res) {
  try {
    if (req.method !== 'POST') return L.json(res, 405, { error: 'POST seulement' });
    const u = await L.authUser(req);
    if (!u) return L.json(res, 401, { error: 'Session expirée.' });
    const b = await L.readJson(req);
    const checkPw = (pw) => {
      try {
        return crypto.timingSafeEqual(
          Buffer.from(L.hashPassword(String(pw || ''), u.salt), 'hex'), Buffer.from(u.hash, 'hex'));
      } catch (e) { return false; }
    };
    if (b.action === 'update') {
      const name = String(b.name || '').trim();
      const phone = String(b.phone || '').trim();
      if (name.length > 40) return L.json(res, 400, { error: 'Nom trop long (40 caractères maximum).' });
      if (phone && !/^\+?[0-9 .\-]{8,18}$/.test(phone)) {
        return L.json(res, 400, { error: 'Numéro invalide. Exemple : +225 07 00 00 00 00' });
      }
      u.name = name; u.phone = phone;
      await L.saveUser(u);
      return L.json(res, 200, { me: L.publicMe(u) });
    }
    if (b.action === 'password') {
      if (!checkPw(b.current)) return L.json(res, 401, { error: 'Mot de passe actuel incorrect.' });
      const next = String(b.next || '');
      if (next.length < 6) return L.json(res, 400, { error: 'Nouveau mot de passe : 6 caractères minimum.' });
      u.salt = crypto.randomBytes(16).toString('hex');
      u.hash = L.hashPassword(next, u.salt);
      await L.saveUser(u);
      return L.json(res, 200, { ok: true });
    }
    if (b.action === 'delete') {
      if (L.isAdmin(u.email)) return L.json(res, 403, { error: 'Le compte propriétaire ne peut pas être supprimé ici.' });
      if (!checkPw(b.password)) return L.json(res, 401, { error: 'Mot de passe incorrect.' });
      await L.db('DEL', 'user:' + u.email);
      return L.json(res, 200, { ok: true });
    }
    return L.json(res, 400, { error: 'Action inconnue.' });
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

module.exports = { auth, me, identify, film, learn, profile, pay, verify: verifyPay, 'paydunya-ipn': ipn };
