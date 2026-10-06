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
    'quantity_in_cases','stock_management','is_physical','rental_sales'
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

// Creates a native Rentman Project Request, then attaches each requested equipment line.
// This is the supported Rentman workflow for incoming requests from a website/CRM.
app.post('/api/reservations', async (req, res) => {
  try {
    const b = req.body || {};
    if (!['student','teacher'].includes(b.role)) return res.status(400).json({ error: 'Profil invalide' });
    if (!b.person?.firstName || !b.person?.lastName) return res.status(400).json({ error: 'Sélectionne ton identité dans la liste.' });
    if (!safeEmail(b.email || b.person.email)) return res.status(400).json({ error: 'Une adresse e-mail valide est obligatoire pour suivre la demande.' });
    if (!b.from || !b.to || b.to < b.from) return res.status(400).json({ error: 'Dates invalides' });
    if (!String(b.reason || '').trim()) return res.status(400).json({ error: "Le motif d'utilisation est obligatoire." });
    if (b.role === 'teacher' && (!String(b.track || '').trim() || !String(b.course || '').trim())) return res.status(400).json({ error: 'Filière et nom du cours obligatoires pour un intervenant.' });
    const lines = Array.isArray(b.items) ? b.items.filter(x => Number(x.quantity) > 0 && Number(x.id)) : [];
    if (!lines.length) return res.status(400).json({ error: 'La demande ne contient aucun matériel.' });

    const email = String(b.email || b.person.email).trim();
    const roleLabel = b.role === 'teacher' ? 'Intervenant' : 'Étudiant';
    const meta = [
      `DEMANDE WEB 3iS LYON`,
      `Profil : ${roleLabel}`,
      b.track ? `Filière : ${b.track}` : '',
      b.year ? `Année : ${b.year}` : '',
      b.person?.source === 'manual' ? `Identité : saisie manuelle` : '',
      b.course ? `Cours : ${b.course}` : '',
      `Motif : ${String(b.reason).trim()}`,
      b.personalUse ? `Utilisation personnelle : OUI — chèque de caution obligatoire` : `Utilisation personnelle : NON`,
      '',
      `[RÉSERVANT ${new Date().toLocaleString('fr-FR')}] Demande envoyée depuis le catalogue.`
    ].filter(Boolean).join('\n');

    const created = await writeRentman('/projectrequests', 'POST', {
      name: `[WEB] ${roleLabel} — ${b.course || b.reason}`.slice(0, 180),
      contact_person_first_name: b.person.firstName,
      contact_person_lastname: b.person.lastName,
      contact_person_email: email,
      ...(b.person?.source === 'contactperson' && b.person?.rentmanRef ? { linked_contact_person: b.person.rentmanRef } : {}),
      planperiod_start: dateTimeStart(b.from),
      planperiod_end: dateTimeEnd(b.to),
      usageperiod_start: dateTimeStart(b.from),
      usageperiod_end: dateTimeEnd(b.to),
      language: 'fr',
      is_paid: false,
      remark: meta
    });
    const pr = projectRequestData(created);
    if (!pr.id) throw new Error("Rentman n'a pas renvoyé l'identifiant de la demande.");

    // Keep write concurrency deliberately low to avoid Rentman's rate limiter.
    for (let i = 0; i < lines.length; i++) {
      const x = lines[i];
      await writeRentman(`/projectrequests/${pr.id}/projectrequestequipment`, 'POST', {
        quantity: Number(x.quantity), quantity_total: Number(x.quantity), is_comment: false, is_kit: false,
        linked_equipment: `/equipment/${Number(x.id)}`, name: String(x.name || `Équipement ${x.id}`),
        external_remark: String(x.note || ''), discount: 0, unit_price: 0, factor: '1', order: String(i + 1)
      });
      if (i < lines.length - 1) await sleep(180);
    }
    res.json({ ok: true, reservation: { id: pr.id, email, status: 'Demande envoyée à Rentman' } });
  } catch (e) { res.status(e.status || 502).json({ error: e.message, retryable: e.status === 429 || e.status === 504 }); }
});

app.post('/api/reservations/:id/view', async (req, res) => {
  try {
    const id = Number(req.params.id); const email = lower(req.body?.email);
    if (!id || !safeEmail(email)) return res.status(400).json({ error: 'Référence ou e-mail invalide.' });
    const got = await rentman(`/projectrequests/${id}`);
    const pr = projectRequestData(got);
    if (lower(pr.contact_person_email) !== email) return res.status(403).json({ error: 'Réservation introuvable avec cet e-mail.' });
    let equipment = [];
    try { equipment = await all(`/projectrequests/${id}/projectrequestequipment`, {}, { cacheMs: 5000 }); } catch (_) {}
    res.json({ reservation: publicRequest(pr), equipment: equipment.map(x => ({ id:x.id, name:x.name, quantity:x.quantity_total ?? x.quantity ?? 1 })) });
  } catch (e) { res.status(e.status || 502).json({ error: e.message }); }
});

app.post('/api/reservations/:id/message', async (req, res) => {
  try {
    const id = Number(req.params.id); const email = lower(req.body?.email); const message = String(req.body?.message || '').trim();
    if (!id || !safeEmail(email) || !message) return res.status(400).json({ error: 'Message invalide.' });
    if (message.length > 1000) return res.status(400).json({ error: 'Message trop long (1000 caractères maximum).' });
    const got = await rentman(`/projectrequests/${id}`); const pr = projectRequestData(got);
    if (lower(pr.contact_person_email) !== email) return res.status(403).json({ error: 'Accès refusé.' });
    const remark = `${pr.remark || ''}\n\n[RÉSERVANT ${new Date().toLocaleString('fr-FR')}] ${message}`.trim();
    await writeRentman(`/projectrequests/${id}`, 'PUT', { planperiod_start: pr.planperiod_start, planperiod_end: pr.planperiod_end, remark });
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
