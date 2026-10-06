const express = require('express');
require('dotenv').config();
// Cloudflare bindings are available through cloudflare:workers on Workers.
// Node local development continues to use .env.
let workerEnv = null;
function setWorkerEnv(env) { workerEnv = env; }
const config = key => workerEnv?.[key] || process.env[key];

const app = express();
const PORT = process.env.PORT || 3000;
const baseUrl = () => (config('RENTMAN_BASE_URL') || 'https://api.rentman.net').replace(/\/$/, '');
const token = () => config('RENTMAN_TOKEN');

app.use(express.json({ limit: '1mb' }));
// Static assets are served by Cloudflare Assets in production.
// Local Wrangler development serves the same public/ directory from wrangler.jsonc.

// Rentman is the source of truth. We cache relatively static inventory data longer
// than date-dependent availability data so the UI feels instant without hammering the API.
const cache = new Map();
const INVENTORY_CACHE_MS = 5 * 60_000;
const AVAILABILITY_CACHE_MS = 5 * 60_000;
const IMAGE_CACHE_MS = 10 * 60_000;

function cacheGet(key, maxAge) {
  const hit = cache.get(key);
  return hit && Date.now() - hit.at < maxAge ? hit.data : null;
}
function cacheSet(key, data) { cache.set(key, { at: Date.now(), data }); return data; }

const RENTMAN_REQUEST_TIMEOUT_MS = 4500;
const RENTMAN_MAX_RETRIES = 1;

function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

async function fetchRentman(url, { maxRetries = RENTMAN_MAX_RETRIES } = {}) {
  let attempt = 0;
  while (true) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), RENTMAN_REQUEST_TIMEOUT_MS);
    let r;
    let text = '';
    try {
      r = await fetch(url, {
        headers: { Authorization: `Bearer ${token()}`, Accept: 'application/json' },
        signal: controller.signal
      });
      text = await r.text();
    } catch (err) {
      if (err && err.name === 'AbortError') {
        const timeoutErr = new Error(`Rentman ne répond pas après ${Math.round(RENTMAN_REQUEST_TIMEOUT_MS / 1000)} s`);
        timeoutErr.status = 504;
        throw timeoutErr;
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }

    if (r.status === 429 && attempt < maxRetries) {
      const retryAfter = Number(r.headers.get('retry-after'));
      const backoff = Number.isFinite(retryAfter) && retryAfter > 0
        ? Math.min(1500, retryAfter * 1000)
        : 700;
      attempt += 1;
      await sleep(backoff);
      continue;
    }

    if (!r.ok) {
      const err = new Error(`Rentman ${r.status}: ${text.slice(0, 500)}`);
      err.status = r.status;
      throw err;
    }

    if (!text) return {};
    try {
      return JSON.parse(text);
    } catch (_) {
      const err = new Error(`Réponse Rentman invalide (${r.status}, ${r.headers.get('content-type') || 'type inconnu'})`);
      err.status = 502;
      throw err;
    }
  }
}

async function rentman(pathname, params = {}, { cacheMs = 0 } = {}) {
  if (!token()) throw new Error('RENTMAN_TOKEN manquant dans .env');
  const url = new URL(baseUrl() + pathname);
  Object.entries(params).forEach(([k, v]) => {
    if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, v);
  });
  const key = url.toString();
  if (cacheMs) {
    const cached = cacheGet(key, cacheMs);
    if (cached) return cached;
  }
  const data = await fetchRentman(url.toString());
  return cacheMs ? cacheSet(key, data) : data;
}

async function all(pathname, params = {}, options = {}) {
  const cacheMs = options.cacheMs || 0;
  const collectionKey = `collection:${pathname}?${new URLSearchParams(params).toString()}`;
  if (cacheMs) {
    const cached = cacheGet(collectionKey, cacheMs);
    if (cached) return cached;
  }

  // This Rentman tenant accepts `limit` but rejects `cursor_limit`.
  // Follow the API-provided next_page_url verbatim for subsequent pages.
  const first = await rentman(pathname, { ...params, limit: params.limit || 1500 }, { cacheMs });
  let data = Array.isArray(first.data) ? first.data : [];
  let next = first.next_page_url;
  let guard = 0;
  const paginationDeadline = Date.now() + 25_000;

  while (next && guard++ < 50) {
    if (Date.now() >= paginationDeadline) {
      const err = new Error('Rentman: lecture trop volumineuse, réessaie dans quelques secondes.');
      err.status = 504;
      throw err;
    }
    const pageUrl = new URL(next, baseUrl());
    if (pageUrl.origin !== new URL(baseUrl()).origin) throw Object.assign(new Error('URL de pagination Rentman invalide'), { status: 502 });
    const j = await fetchRentman(pageUrl.toString(), { maxRetries: 0 });
    data = data.concat(Array.isArray(j.data) ? j.data : []);
    next = j.next_page_url;
  }

  if (next) {
    const err = new Error(`Rentman pagination interrompue après ${guard} pages`);
    err.status = 504;
    throw err;
  }
  return cacheMs ? cacheSet(collectionKey, data) : data;
}

function refId(value) {
  if (!value) return null;
  if (typeof value === 'number') return value;
  const m = String(value).match(/(\d+)(?:\D*)$/);
  return m ? Number(m[1]) : null;
}
function str(v) { return v == null ? '' : String(v); }
function number(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}
function pick(obj, keys, fallback = '') {
  for (const k of keys) {
    if (obj && obj[k] !== undefined && obj[k] !== null && obj[k] !== '') return obj[k];
  }
  return fallback;
}
function lower(v) { return str(v).trim().toLocaleLowerCase('fr-FR'); }
function pathName(v) {
  if (!v) return '';
  if (typeof v === 'object') return pick(v, ['name', 'displayname', 'display_name'], '');
  return str(v).split('/').filter(Boolean).pop() || str(v);
}

function categoryFromName(name) {
  const n = lower(name);
  if (!n) return 'Autre / Divers';
  if (/son|audio|micro|microphone|enceinte|console|mix|speaker|casque|hf|radio|dante|zoom|shure|sennheiser/.test(n)) return 'Son';
  if (/lumi|light|projecteur|led|tungst|hmi|arri|aputure|nanlite|spot|dimmer|lyre|mandarine/.test(n)) return 'Lumière';
  if (/vid|cam|camera|caméra|optique|objectif|sony|blackmagic|canon|panasonic|monitor|moniteur|enregistreur|atomos|teradek/.test(n)) return 'Vidéo';
  if (/struct|pied|trépied|trepied|grill|pont|poutre|barre|échafaud|chariot|rig|structure/.test(n)) return 'Structure';
  return 'Autre / Divers';
}

function categoryForEquipment(e, folderName = '') {
  const custom = e.custom || {};
  const explicit = pick(e, ['category_name', 'type_name', 'category'], '') ||
    pick(custom, ['category', 'categorie', 'Catégorie', 'Category', 'custom_category'], '');
  const explicitName = pathName(explicit);
  const source = explicitName || folderName || pick(e, ['type', 'equipment_group'], '');
  const mapped = categoryFromName(source);
  // Preserve the requested UI taxonomy even when Rentman uses its own folder names.
  return mapped;
}

function normalizeEquipment(e, folderMap = new Map()) {
  const custom = e.custom || {};
  const folderRef = e.folder || e.folder_id || e.folder_path || '';
  const folderName = folderMap.get(str(folderRef)) || pathName(folderRef);

  // Rentman's current API uses current_quantity / in_quantity for inventory.
  // Keep legacy aliases as fallbacks for older payloads.
  // `current_quantity` is the Rentman equipment quantity used for stock.
  // Do NOT silently turn a missing stock field into a fake 0: the collection
  // endpoint can omit generated quantity fields unless they are explicitly
  // requested with `fields`.
  const stockCandidates = [
    ['current_quantity', e.current_quantity],
    ['current', e.current],
    ['currentquantity', e.currentquantity],
    ['current_quantity_excl_cases', e.current_quantity_excl_cases],
    ['stock', e.stock],
    ['stock_level', e.stock_level],
    ['quantity', e.quantity]
  ];
  const stockEntry = stockCandidates.find(([, value]) => value !== undefined && value !== null && value !== '');
  const stock = stockEntry ? Math.max(0, number(stockEntry[1], 0)) : null;
  const location = pathName(pick(e, ['location_in_warehouse', 'asset_location', 'stock_location'], ''));
  const imageRef = pick(e, ['image', 'image_url', 'picture', 'picture_url', 'thumbnail', 'photo'], '');

  return {
    id: e.id,
    name: pick(e, ['name', 'displayname'], `Équipement ${e.id}`),
    description: pick(e, ['description', 'details', 'remark', 'external_remark', 'internal_remark'], ''),
    category: categoryForEquipment(e, folderName),
    image: typeof imageRef === 'string' && /^https?:\/\//i.test(imageRef) ? imageRef : '',
    imageRef: str(imageRef),
    stock,
    stockKnown: stock !== null,
    stockSource: stockEntry ? stockEntry[0] : null,
    currentStock: stock,
    incomingStock: Math.max(0, number(pick(e, ['in_quantity'], 0))),
    location,
    folder: folderName,
    rentalPrice: Math.max(0, number(pick(e, ['price'], 0))),
    archived: Boolean(e.archive || e.archived || e.in_archive),
    // Never expose Rentman's complete equipment record to public browsers.
  };
}

async function getFolderMap() {
  try {
    const folders = await all('/folders', {}, { cacheMs: INVENTORY_CACHE_MS });
    const map = new Map();
    for (const f of folders) {
      if (f.id != null) map.set(`/folders/${f.id}`, pick(f, ['name', 'displayname'], `Dossier ${f.id}`));
      if (f.id != null) map.set(String(f.id), pick(f, ['name', 'displayname'], `Dossier ${f.id}`));
    }
    return map;
  } catch (_) {
    return new Map();
  }
}

async function getEquipment() {
  // Rentman may omit generated stock fields from a collection response unless
  // they are explicitly selected. Request the real inventory fields instead
  // of relying on a default payload and accidentally displaying 0 everywhere.
  const fields = [
    'id','name','displayname','description','external_remark','internal_remark',
    'folder','image','in_archive','location_in_warehouse','type',
    'current','current_quantity','current_quantity_excl_cases','in_quantity',
    'quantity_in_cases','stock_management','is_physical','rental_sales','price','factor_group'
  ].join(',');
  const [raw, folderMap] = await Promise.all([
    all('/equipment', { sort: '+id', fields }, { cacheMs: INVENTORY_CACHE_MS }),
    getFolderMap()
  ]);
  return raw.map(e => normalizeEquipment(e, folderMap)).filter(x => !x.archived);
}

function overlap(a, b, from, to) {
  return a < to && b > from;
}

app.get(['/api/health', '/health'], (req, res) => res.json({ ok: true, rentmanConfigured: Boolean(token()) }));

app.get(['/api/equipment', '/equipment'], async (req, res) => {
  try {
    const items = await getEquipment();
    res.json({ items, updatedAt: new Date().toISOString() });
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

app.get(['/api/availability', '/availability'], async (req, res) => {
  try {
    const from = new Date(`${req.query.from}T00:00:00`);
    // The selected end date is inclusive for a user-facing rental period.
    const to = new Date(`${req.query.to}T23:59:59.999`);
    if (Number.isNaN(from.valueOf()) || Number.isNaN(to.valueOf()) || to < from) {
      return res.status(400).json({ error: 'Dates invalides' });
    }

    const cacheKey = `availability:${req.query.from}:${req.query.to}`;
    const cached = cacheGet(cacheKey, AVAILABILITY_CACHE_MS);
    if (cached) return res.json(cached);

    // Do NOT scan the global /projectequipment collection: on large Rentman
    // accounts that requires dozens of paginated requests and exceeds the
    // Cloudflare Worker subrequest budget.
    //
    // Rentman currently exposes the planning period on equipment groups as
    // well as individual equipment lines. First fetch the much smaller group
    // collection, keep only groups overlapping the requested dates, then fetch
    // equipment only for those groups through the documented child endpoint.
    const [equipment, groups] = await Promise.all([
      getEquipment(),
      all('/projectequipmentgroup', {
        sort: '+id',
        fields: 'id,planperiod_start,planperiod_end,usageperiod_start,usageperiod_end'
      }, { cacheMs: AVAILABILITY_CACHE_MS })
    ]);

    const relevantGroups = groups.filter(g => {
      const gs = new Date(g.planperiod_start || g.usageperiod_start || '');
      const ge = new Date(g.planperiod_end || g.usageperiod_end || '');
      return !Number.isNaN(gs.valueOf()) && !Number.isNaN(ge.valueOf()) && overlap(gs, ge, from, to);
    }).sort((a, b) => Number(a.id) - Number(b.id));

    // Cloudflare Workers Free allows only 50 external subrequests per invocation.
    // Process at most 18 relevant groups per browser request. The frontend follows
    // nextOffset and combines the deductions, so large periods remain exact while
    // every Worker invocation stays comfortably below Cloudflare's hard limit.
    const requestedOffset = Math.max(0, Number.parseInt(req.query.groupOffset || '0', 10) || 0);
    const groupsPerInvocation = 20;
    const selectedGroups = relevantGroups.slice(requestedOffset, requestedOffset + groupsPerInvocation);
    const nextOffset = requestedOffset + selectedGroups.length < relevantGroups.length
      ? requestedOffset + selectedGroups.length
      : null;

    const planned = [];
    const batchSize = 20;
    for (let i = 0; i < selectedGroups.length; i += batchSize) {
      const batch = selectedGroups.slice(i, i + batchSize);
      const rows = await Promise.all(batch.map(async group => {
        const lines = await all(`/projectequipmentgroup/${group.id}/projectequipment`, {
          sort: '+id',
          fields: 'id,equipment,linked_equipment,parent,quantity,quantity_total,is_option,planperiod_start,planperiod_end,usageperiod_start,usageperiod_end,warehouse_reservations,subrent_reservations'
        }, { cacheMs: AVAILABILITY_CACHE_MS });
        // During Rentman's transition, child lines may not yet carry their own
        // planning fields. Fall back to the group's period without changing the
        // stock calculation.
        return lines.map(line => ({
          ...line,
          parent: line.parent || group.id,
          planperiod_start: line.planperiod_start || group.planperiod_start,
          planperiod_end: line.planperiod_end || group.planperiod_end,
          usageperiod_start: line.usageperiod_start || group.usageperiod_start,
          usageperiod_end: line.usageperiod_end || group.usageperiod_end
        }));
      }));
      planned.push(...rows.flat());
    }

    const byId = new Map(equipment.map(e => [Number(e.id), e]));
    const deductions = new Map();
    const projectsById = new Map();
    const reservationDetailsById = new Map();

    for (const p of planned) {
      const eid = refId(p.equipment || p.linked_equipment);
      if (!eid || !byId.has(eid)) continue;

      const ps = new Date(p.planperiod_start || p.usageperiod_start || p.start || '');
      const pe = new Date(p.planperiod_end || p.usageperiod_end || p.end || '');
      if (Number.isNaN(ps.valueOf()) || Number.isNaN(pe.valueOf()) || !overlap(ps, pe, from, to)) continue;

      // IMPORTANT: quantity_total is the amount PLANNED on the project line.
      // It is not the number actually reserved from the school's warehouse.
      // For stock availability, Rentman exposes warehouse_reservations as the
      // generated quantity reserved from warehouse stock. Using quantity_total
      // here can massively over-count combinations/kit contents and unreserved
      // planning lines (e.g. 25, 35, 59).
      if (p.is_option === true) continue;
      const reservedQty = Math.max(0, number(p.warehouse_reservations, 0));
      if (!reservedQty) continue;

      deductions.set(eid, (deductions.get(eid) || 0) + reservedQty);

      // One user-facing "reservation" = one Rentman equipment group (parent)
      // for this material. If the same material occurs multiple times in the
      // same group, aggregate it instead of inflating the reservation count.
      const reservationKey = String(refId(p.parent) || p.id);
      if (!reservationDetailsById.has(eid)) reservationDetailsById.set(eid, new Map());
      const reservationMap = reservationDetailsById.get(eid);
      const existing = reservationMap.get(reservationKey);
      if (existing) {
        existing.quantity += reservedQty;
        if (ps < new Date(existing.from)) existing.from = ps.toISOString();
        if (pe > new Date(existing.to)) existing.to = pe.toISOString();
      } else {
        reservationMap.set(reservationKey, {
          id: reservationKey,
          quantity: reservedQty,
          from: ps.toISOString(),
          to: pe.toISOString()
        });
      }
    }

    const items = equipment.map(x => {
      const eid = Number(x.id);
      const reservedQty = deductions.get(eid) || 0;
      const reservationDetails = [...(reservationDetailsById.get(eid)?.values() || [])]
        .sort((a, b) => new Date(a.from) - new Date(b.from));
      // A missing stock value is a data/configuration error, not zero stock.
      // Keep it explicit so the UI never reports an equipment item as
      // unavailable just because Rentman omitted a field.
      const available = x.stockKnown ? Math.max(0, x.currentStock - reservedQty) : null;
      return {
        ...x,
        // Kept as a compatibility alias for the existing frontend.
        plannedQty: reservedQty,
        reservedQty,
        reserved: reservedQty,
        availableForPeriod: available,
        status: available === null ? 'unknown' : (available > 0 ? 'available' : 'unavailable'),
        reservationCount: reservationDetails.length,
        reservationDetails,
        projectCount: reservationDetails.length
      };
    });

    const payload = {
      from: req.query.from,
      to: req.query.to,
      items,
      stock: {
        source: 'Rentman /equipment.current_quantity',
        knownCount: items.filter(x => x.stockKnown).length,
        unknownCount: items.filter(x => !x.stockKnown).length
      },
      updatedAt: new Date().toISOString(),
      pagination: {
        groupOffset: requestedOffset,
        processedGroups: selectedGroups.length,
        totalGroups: relevantGroups.length,
        nextOffset
      }
    };
    cacheSet(cacheKey, payload);
    res.json(payload);
  } catch (e) {
    const status = e.status === 429 ? 429 : (e.status === 504 ? 504 : 502);
    res.status(status).json({ error: e.message, retryable: status === 429 || status === 504 });
  }
});



async function writeRentman(pathname, method, body) {
  if (!token()) throw new Error('RENTMAN_TOKEN manquant dans .env');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), RENTMAN_REQUEST_TIMEOUT_MS);
  try {
    const r = await fetch(baseUrl() + pathname, {
      method,
      headers: { Authorization: `Bearer ${token()}`, Accept: 'application/json', 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: controller.signal
    });
    const text = await r.text();
    let data = {};
    try { data = text ? JSON.parse(text) : {}; } catch (_) {}
    if (!r.ok) {
      const err = new Error(data?.error || data?.message || `Rentman ${r.status}: ${text.slice(0, 500)}`);
      err.status = r.status;
      throw err;
    }
    return data;
  } catch (err) {
    if (err?.name === 'AbortError') { const e = new Error('Rentman ne répond pas assez vite'); e.status = 504; throw e; }
    throw err;
  } finally { clearTimeout(timer); }
}

function projectRequestData(j) { return j?.data || j || {}; }
function safeEmail(v) { return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(v || '').trim()); }
function dateTimeStart(d) { return `${d}T08:00:00+02:00`; }
function dateTimeEnd(d) { return `${d}T18:00:00+02:00`; }
function publicRequest(pr) {
  return {
    id: pr.id,
    name: pr.name || '',
    from: pr.planperiod_start || pr.usageperiod_start || '',
    to: pr.planperiod_end || pr.usageperiod_end || '',
    remark: pr.remark || '',
    status: pr.status || pr.project_status || 'Demande envoyée',
    person: [pr.contact_person_first_name, pr.contact_person_lastname].filter(Boolean).join(' '),
    email: pr.contact_person_email || ''
  };
}

// Checkout lookup: Rentman people can exist as contact persons or private contacts.
function normalizePersonText(value) {
  return lower(value).normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}
function matchesPerson(person, query) {
  const words = normalizePersonText(query).split(/\s+/).filter(Boolean);
  // The checkout field is a name search: an email containing the typed first name must not create a false match.
  const haystack = normalizePersonText([person.firstName, person.lastName].filter(Boolean).join(' '));
  return words.every(word => haystack.includes(word));
}
app.get('/api/people', async (req, res) => {
  try {
    const q = String(req.query.q || '').trim();
    if (q.length < 2) return res.json({ items: [] });
    const results = await Promise.allSettled([
      all('/contactpersons', { sort: '+id', fields: 'id,firstname,first_name,lastname,last_name,email,custom,contact' }, { cacheMs: 300_000 }),
      all('/contacts', { sort: '+id', fields: 'id,type,firstname,surname,name,email_1,email_2' }, { cacheMs: 300_000 })
    ]);
    const people = [];
    if (results[0].status === 'fulfilled') for (const p of results[0].value) people.push({
      id: p.id, source: 'contactperson', rentmanRef: '/contactpersons/' + p.id,
      firstName: pick(p, ['firstname','first_name'], ''), lastName: pick(p, ['lastname','last_name'], ''),
      email: p.email || '', custom: p.custom || {}, contact: p.contact || ''
    });
    if (results[1].status === 'fulfilled') for (const p of results[1].value) {
      if (p.type && p.type !== 'private') continue;
      people.push({
        id: p.id, source: 'contact', rentmanRef: '/contacts/' + p.id,
        firstName: p.firstname || '', lastName: p.surname || '',
        email: p.email_1 || p.email_2 || '', custom: {}, contact: '/contacts/' + p.id
      });
    }
    const seen = new Set();
    const found = people.filter(p => matchesPerson(p, q)).filter(p => {
      const key = normalizePersonText([p.firstName,p.lastName,p.email].join('|'));
      if (seen.has(key)) return false;
      seen.add(key); return true;
    }).slice(0, 20);
    res.json({ items: found });
  } catch (e) { res.status(e.status || 502).json({ error: e.message }); }
});

// V16.5 — local request workflow for Lyon Standard.
// Pending requests live in Cloudflare D1, so the website no longer depends on
// Rentman's Project Requests feature (which is unavailable on the Lyon plan).
function requestsDb() { return workerEnv?.REQUESTS_DB || null; }
function requireRequestsDb() {
  const db = requestsDb();
  if (!db) { const e = new Error('Base des demandes non configurée.'); e.status = 503; throw e; }
  return db;
}
function magasinAuthorized(req) {
  const expected = String(config('RESERVATION_ACCESS_SECRET') || '');
  const supplied = String(req.get('x-magasin-secret') || '');
  return Boolean(expected) && supplied.length === expected.length && supplied === expected;
}
function requireMagasin(req, res, next) {
  if (!magasinAuthorized(req)) return res.status(401).json({ error: 'Accès magasin refusé.' });
  next();
}
function reservationFromRow(row, messages = []) {
  return {
    id: row.id, name: row.name, role: row.role, status: row.status,
    from: row.date_from, to: row.date_to, reason: row.reason,
    track: row.track || '', year: row.year || '', course: row.course || '',
    personalUse: Boolean(row.personal_use),
    person: [row.first_name, row.last_name].filter(Boolean).join(' '),
    firstName: row.first_name, lastName: row.last_name, email: row.email,
    createdAt: row.created_at, updatedAt: row.updated_at,
    messages
  };
}
async function loadLocalReservation(id) {
  const db = requireRequestsDb();
  const row = await db.prepare('SELECT * FROM reservations WHERE id = ?').bind(id).first();
  if (!row) return null;
  const equipment = await db.prepare('SELECT equipment_id AS equipmentId, name, quantity FROM reservation_items WHERE reservation_id = ? ORDER BY id').bind(id).all();
  const messages = await db.prepare('SELECT id, author, message, created_at AS createdAt FROM reservation_messages WHERE reservation_id = ? ORDER BY id').bind(id).all();
  return { reservation: reservationFromRow(row, messages.results || []), equipment: equipment.results || [] };
}

app.post('/api/reservations', async (req, res) => {
  try {
    const b = req.body || {};
    if (!['student','teacher'].includes(b.role)) return res.status(400).json({ error: 'Profil invalide' });
    if (!b.person?.firstName || !b.person?.lastName) return res.status(400).json({ error: 'Renseigne ton prénom et ton nom.' });
    const email = String(b.email || b.person.email || '').trim();
    if (!safeEmail(email)) return res.status(400).json({ error: 'Une adresse e-mail valide est obligatoire pour suivre la demande.' });
    if (!b.from || !b.to || b.to < b.from) return res.status(400).json({ error: 'Dates invalides' });
    if (!String(b.reason || '').trim()) return res.status(400).json({ error: "Le motif d'utilisation est obligatoire." });
    if (b.role === 'teacher' && (!String(b.track || '').trim() || !String(b.course || '').trim())) return res.status(400).json({ error: 'Filière et nom du cours obligatoires pour un intervenant.' });
    const lines = Array.isArray(b.items) ? b.items.filter(x => Number(x.quantity) > 0 && Number(x.id)) : [];
    if (!lines.length) return res.status(400).json({ error: 'La demande ne contient aucun matériel.' });

    const db = requireRequestsDb();
    const now = new Date().toISOString();
    const roleLabel = b.role === 'teacher' ? 'Intervenant' : 'Étudiant';
    const name = `[WEB] ${roleLabel} — ${String(b.course || b.reason).trim()}`.slice(0, 180);
    const inserted = await db.prepare(`INSERT INTO reservations
      (status, role, first_name, last_name, email, track, year, course, date_from, date_to, reason, personal_use, person_source, name, created_at, updated_at)
      VALUES ('pending', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .bind(b.role, String(b.person.firstName).trim(), String(b.person.lastName).trim(), email,
        String(b.track || '').trim(), String(b.year || '').trim(), String(b.course || '').trim(),
        b.from, b.to, String(b.reason).trim(), b.personalUse ? 1 : 0, String(b.person.source || 'manual'),
        name, now, now).run();
    const id = Number(inserted.meta?.last_row_id);
    if (!id) throw new Error("Impossible de créer la demande.");

    const statements = lines.map(x => db.prepare(
      'INSERT INTO reservation_items (reservation_id, equipment_id, name, quantity) VALUES (?, ?, ?, ?)'
    ).bind(id, Number(x.id), String(x.name || `Équipement ${x.id}`), Number(x.quantity)));
    statements.push(db.prepare(
      'INSERT INTO reservation_messages (reservation_id, author, message, created_at) VALUES (?, ?, ?, ?)'
    ).bind(id, 'user', 'Demande envoyée depuis le catalogue.', now));
    await db.batch(statements);

    res.json({ ok: true, reservation: { id, email, status: 'pending' } });
  } catch (e) { res.status(e.status || 502).json({ error: e.message }); }
});

app.post('/api/reservations/:id/view', async (req, res) => {
  try {
    const id = Number(req.params.id), email = lower(req.body?.email);
    if (!id || !safeEmail(email)) return res.status(400).json({ error: 'Référence ou e-mail invalide.' });
    const data = await loadLocalReservation(id);
    if (!data || lower(data.reservation.email) !== email) return res.status(404).json({ error: 'Réservation introuvable avec cet e-mail.' });
    res.json(data);
  } catch (e) { res.status(e.status || 502).json({ error: e.message }); }
});

app.post('/api/reservations/:id/message', async (req, res) => {
  try {
    const id = Number(req.params.id), email = lower(req.body?.email), message = String(req.body?.message || '').trim();
    if (!id || !safeEmail(email) || !message) return res.status(400).json({ error: 'Message invalide.' });
    if (message.length > 1000) return res.status(400).json({ error: 'Message trop long (1000 caractères maximum).' });
    const data = await loadLocalReservation(id);
    if (!data || lower(data.reservation.email) !== email) return res.status(403).json({ error: 'Accès refusé.' });
    await requireRequestsDb().prepare('INSERT INTO reservation_messages (reservation_id, author, message, created_at) VALUES (?, ?, ?, ?)')
      .bind(id, 'user', message, new Date().toISOString()).run();
    res.json({ ok: true });
  } catch (e) { res.status(e.status || 502).json({ error: e.message }); }
});

// Ephemeral typing indicators. These are intentionally short-lived and do not persist personal data.
const typingState = new Map();
function typingKey(id, side) { return `${id}:${side}`; }
function setTyping(id, side, active) {
  const key = typingKey(id, side);
  if (active) typingState.set(key, Date.now() + 4500);
  else typingState.delete(key);
}
function isTyping(id, side) {
  const key = typingKey(id, side), until = typingState.get(key) || 0;
  if (until <= Date.now()) { typingState.delete(key); return false; }
  return true;
}
app.post('/api/reservations/:id/typing', async (req, res) => {
  try {
    const id = Number(req.params.id), email = lower(req.body?.email), active = Boolean(req.body?.active);
    if (!id || !safeEmail(email)) return res.status(400).json({ error: 'Accès invalide.' });
    const data = await loadLocalReservation(id);
    if (!data || lower(data.reservation.email) !== email) return res.status(403).json({ error: 'Accès refusé.' });
    setTyping(id, 'user', active);
    res.json({ ok: true, otherTyping: isTyping(id, 'staff') });
  } catch (e) { res.status(e.status || 502).json({ error: e.message }); }
});
app.post('/api/reservations/:id/presence', async (req, res) => {
  try {
    const id = Number(req.params.id), email = lower(req.body?.email);
    if (!id || !safeEmail(email)) return res.status(400).json({ error: 'Accès invalide.' });
    const data = await loadLocalReservation(id);
    if (!data || lower(data.reservation.email) !== email) return res.status(403).json({ error: 'Accès refusé.' });
    res.json({ otherTyping: isTyping(id, 'staff') });
  } catch (e) { res.status(e.status || 502).json({ error: e.message }); }
});
app.post('/api/magasin/requests/:id/typing', requireMagasin, async (req, res) => {
  const id = Number(req.params.id);
  if (!id) return res.status(400).json({ error: 'Demande invalide.' });
  setTyping(id, 'staff', Boolean(req.body?.active));
  res.json({ ok: true, otherTyping: isTyping(id, 'user') });
});
app.get('/api/magasin/requests/:id/presence', requireMagasin, async (req, res) => {
  const id = Number(req.params.id);
  if (!id) return res.status(400).json({ error: 'Demande invalide.' });
  res.json({ otherTyping: isTyping(id, 'user') });
});

app.get('/api/magasin/requests', requireMagasin, async (req, res) => {
  try {
    const status = String(req.query.status || 'all');
    const db = requireRequestsDb();
    const q = status === 'all'
      ? db.prepare('SELECT * FROM reservations ORDER BY id DESC LIMIT 200')
      : db.prepare('SELECT * FROM reservations WHERE status = ? ORDER BY id DESC LIMIT 200').bind(status);
    const rows = await q.all();
    res.json({ items: (rows.results || []).map(row => reservationFromRow(row)) });
  } catch (e) { res.status(e.status || 502).json({ error: e.message }); }
});
app.get('/api/magasin/requests/:id', requireMagasin, async (req, res) => {
  try {
    const data = await loadLocalReservation(Number(req.params.id));
    if (!data) return res.status(404).json({ error: 'Demande introuvable.' });
    res.json(data);
  } catch (e) { res.status(e.status || 502).json({ error: e.message }); }
});
app.post('/api/magasin/requests/:id/status', requireMagasin, async (req, res) => {
  try {
    const id = Number(req.params.id), status = String(req.body?.status || '');
    if (!['pending','accepted','refused'].includes(status)) return res.status(400).json({ error: 'Statut invalide.' });
    const db = requireRequestsDb(), now = new Date().toISOString();
    const result = await db.prepare('UPDATE reservations SET status = ?, updated_at = ? WHERE id = ?').bind(status, now, id).run();
    if (!result.meta?.changes) return res.status(404).json({ error: 'Demande introuvable.' });
    const labels = { pending:'remise en attente', accepted:'acceptée par le magasin', refused:'refusée par le magasin' };
    await db.prepare('INSERT INTO reservation_messages (reservation_id, author, message, created_at) VALUES (?, ?, ?, ?)')
      .bind(id, 'staff', `Demande ${labels[status]}.`, now).run();
    res.json({ ok: true, status });
  } catch (e) { res.status(e.status || 502).json({ error: e.message }); }
});
app.post('/api/magasin/requests/:id/message', requireMagasin, async (req, res) => {
  try {
    const id = Number(req.params.id), message = String(req.body?.message || '').trim();
    if (!id || !message) return res.status(400).json({ error: 'Message invalide.' });
    if (message.length > 1000) return res.status(400).json({ error: 'Message trop long (1000 caractères maximum).' });
    const db = requireRequestsDb();
    const exists = await db.prepare('SELECT id FROM reservations WHERE id = ?').bind(id).first();
    if (!exists) return res.status(404).json({ error: 'Demande introuvable.' });
    await db.prepare('INSERT INTO reservation_messages (reservation_id, author, message, created_at) VALUES (?, ?, ?, ?)')
      .bind(id, 'staff', message, new Date().toISOString()).run();
    res.json({ ok: true });
  } catch (e) { res.status(e.status || 502).json({ error: e.message }); }
});

// Resolve Rentman's equipment image lazily. The browser only asks for images
// that are actually displayed, keeping the initial inventory request fast.
app.get(['/api/equipment/:id/image', '/equipment/:id/image'], async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return res.status(400).end();
    const key = `equipment-image:${id}`;
    const cached = cacheGet(key, IMAGE_CACHE_MS);
    if (cached) return res.redirect(cached);

    const item = await rentman(`/equipment/${id}`, {}, { cacheMs: INVENTORY_CACHE_MS });
    const image = pick(item.data || item, ['image', 'image_url', 'picture', 'picture_url', 'thumbnail', 'photo'], '');

    if (/^https?:\/\//i.test(str(image))) {
      cacheSet(key, str(image));
      return res.redirect(str(image));
    }

    const imageId = refId(image);
    if (!imageId) return res.status(404).end();

    const file = await rentman(`/files/${imageId}`, {}, { cacheMs: IMAGE_CACHE_MS });
    const fileData = file.data || file;
    const url = pick(fileData, ['url', 'download_url', 'public_url', 'file_url', 'href'], '');
    if (/^https?:\/\//i.test(str(url))) {
      cacheSet(key, str(url));
      return res.redirect(str(url));
    }

    return res.status(404).end();
  } catch (_) {
    return res.status(404).end();
  }
});

if (require.main === module) {
  app.listen(PORT, () => console.log(`3iS Store running on http://localhost:${PORT}`));
}

module.exports = app;
module.exports.setWorkerEnv = setWorkerEnv;
