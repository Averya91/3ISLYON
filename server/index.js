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
const staleCache = new Map();
const inflightRentman = new Map();
const INVENTORY_CACHE_MS = 10 * 60_000;
const AVAILABILITY_CACHE_MS = 10 * 60_000;
const IMAGE_CACHE_MS = 30 * 60_000;
const RENTMAN_STALE_MS = 60 * 60_000;

function cacheGet(key, maxAge) {
  const hit = cache.get(key);
  return hit && Date.now() - hit.at < maxAge ? hit.data : null;
}
function cacheSet(key, data) { const hit={ at:Date.now(), data }; cache.set(key,hit); staleCache.set(key,hit); return data; }
function cacheStale(key, maxAge = RENTMAN_STALE_MS) {
  const hit = cache.get(key) || staleCache.get(key);
  return hit && Date.now() - hit.at < maxAge ? hit.data : null;
}

const RENTMAN_REQUEST_TIMEOUT_MS = 4500;
const RENTMAN_MAX_RETRIES = 2;

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
        ? Math.min(5000, retryAfter * 1000)
        : Math.min(3200, 800 * Math.pow(2, attempt));
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
  if (inflightRentman.has(key)) return inflightRentman.get(key);
  const task = (async () => {
    try {
      const data = await fetchRentman(url.toString());
      return cacheMs ? cacheSet(key, data) : data;
    } catch (err) {
      if (err?.status === 429 && cacheMs) {
        const stale = cacheStale(key);
        if (stale) return stale;
        const friendly = new Error('Rentman est momentanément très sollicité. Les données vont se recharger automatiquement dans quelques secondes.');
        friendly.status = 503;
        throw friendly;
      }
      throw err;
    } finally {
      inflightRentman.delete(key);
    }
  })();
  inflightRentman.set(key, task);
  return task;
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
    const j = await fetchRentman(pageUrl.toString(), { maxRetries: 2 });
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

    const requestedOffset = Math.max(0, Number.parseInt(req.query.groupOffset || '0', 10) || 0);
    const cacheKey = `availability:${req.query.from}:${req.query.to}:${requestedOffset}`;
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
        fields: 'id,project,planperiod_start,planperiod_end,usageperiod_start,usageperiod_end'
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
          project: line.project || group.project,
          planperiod_start: line.planperiod_start || group.planperiod_start,
          planperiod_end: line.planperiod_end || group.planperiod_end,
          usageperiod_start: line.usageperiod_start || group.usageperiod_start,
          usageperiod_end: line.usageperiod_end || group.usageperiod_end
        }));
      }));
      planned.push(...rows.flat());
    }

    const projectIds = [...new Set(planned.map(p => refId(p.project)).filter(Boolean))];
    const projectMeta = new Map();
    await Promise.all(projectIds.slice(0, 20).map(async projectId => {
      try {
        const raw = await rentman(`/projects/${projectId}`, {}, { cacheMs: AVAILABILITY_CACHE_MS });
        const p = raw.data || raw;
        const customerRef = p.customer || p.contact || p.client || p.contactperson || p.contact_person;
        let customer = pick(p, ['customer_name','contact_name','client_name','account_name'], '');
        if (!customer && customerRef) {
          const cid = refId(customerRef);
          if (cid) {
            try {
              const cr = await rentman(`/contacts/${cid}`, {}, { cacheMs: INVENTORY_CACHE_MS });
              const c = cr.data || cr;
              customer = pick(c, ['displayname','name','company_name'], '') || [pick(c,['first_name','firstname'],''),pick(c,['last_name','lastname'],'')].filter(Boolean).join(' ');
            } catch (_) {}
          }
        }
        projectMeta.set(projectId, {
          projectId,
          projectName: pick(p, ['name','project_name','displayname'], `Commande #${projectId}`),
          customer: customer || 'Client Rentman'
        });
      } catch (_) {
        projectMeta.set(projectId, { projectId, projectName: `Commande #${projectId}`, customer: 'Client Rentman' });
      }
    }));

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
        const projectId = refId(p.project);
        const meta = projectMeta.get(projectId) || {};
        reservationMap.set(reservationKey, {
          id: reservationKey,
          projectId: projectId || null,
          projectName: meta.projectName || (projectId ? `Commande #${projectId}` : `Réservation #${reservationKey}`),
          customer: meta.customer || 'Client Rentman',
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
function bytesToHex(bytes){return [...new Uint8Array(bytes)].map(b=>b.toString(16).padStart(2,'0')).join('')}
function randomToken(bytes=32){const a=new Uint8Array(bytes);crypto.getRandomValues(a);return bytesToHex(a)}
async function sha256(v){return bytesToHex(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(String(v))))}
async function passwordHash(password,salt){
  const key=await crypto.subtle.importKey('raw',new TextEncoder().encode(String(password)),'PBKDF2',false,['deriveBits']);
  return bytesToHex(await crypto.subtle.deriveBits({name:'PBKDF2',salt:new TextEncoder().encode(salt),iterations:160000,hash:'SHA-256'},key,256));
}
function base32Decode(s){const alphabet='ABCDEFGHIJKLMNOPQRSTUVWXYZ234567',clean=String(s).replace(/=|\s/g,'').toUpperCase();let bits='',out=[];for(const c of clean){const v=alphabet.indexOf(c);if(v<0)continue;bits+=v.toString(2).padStart(5,'0')}for(let i=0;i+8<=bits.length;i+=8)out.push(parseInt(bits.slice(i,i+8),2));return new Uint8Array(out)}
function base32Random(){const alphabet='ABCDEFGHIJKLMNOPQRSTUVWXYZ234567',a=new Uint8Array(20);crypto.getRandomValues(a);let bits=[...a].map(x=>x.toString(2).padStart(8,'0')).join(''),out='';for(let i=0;i<bits.length;i+=5)out+=alphabet[parseInt(bits.slice(i,i+5).padEnd(5,'0'),2)];return out}
async function totp(secret,offset=0){const counter=Math.floor(Date.now()/30000)+offset,b=new ArrayBuffer(8),v=new DataView(b);v.setUint32(4,counter);const key=await crypto.subtle.importKey('raw',base32Decode(secret),{name:'HMAC',hash:'SHA-1'},false,['sign']);const sig=new Uint8Array(await crypto.subtle.sign('HMAC',key,b)),o=sig[sig.length-1]&15,n=((sig[o]&127)<<24|(sig[o+1]&255)<<16|(sig[o+2]&255)<<8|(sig[o+3]&255))%1000000;return String(n).padStart(6,'0')}
async function verifyTotp(secret,code){for(let o=-1;o<=1;o++)if(await totp(secret,o)===String(code||'').trim())return true;return false}
async function sessionUser(req){
  const raw=String(req.get('authorization')||'').replace(/^Bearer\s+/i,'').trim();if(!raw)return null;
  const row=await requireRequestsDb().prepare(`SELECT u.* FROM magasin_sessions s JOIN magasin_users u ON u.id=s.user_id WHERE s.token_hash=? AND s.expires_at>? AND u.active=1`).bind(await sha256(raw),new Date().toISOString()).first();
  return row||null;
}
async function requireMagasin(req,res,next){
  try{const user=await sessionUser(req);if(user){req.magasinUser=user;return next()}if(magasinAuthorized(req))return next();return res.status(401).json({error:'Connexion magasin requise.'})}catch(e){res.status(500).json({error:e.message})}
}
function requireAdmin(req,res,next){if(req.magasinUser?.role==='admin')return next();return res.status(403).json({error:'Compte responsable magasin requis.'})}
function magasinActor(req) {
  if(req.magasinUser)return [req.magasinUser.first_name,req.magasinUser.last_name].filter(Boolean).join(' ');
  return String(req.get('x-magasin-actor') || 'Magasin').trim().slice(0, 80) || 'Magasin';
}

app.get('/api/magasin/auth/bootstrap-status',async(req,res)=>{try{const row=await requireRequestsDb().prepare("SELECT COUNT(*) AS n FROM magasin_users WHERE role='admin'").first();res.json({needsBootstrap:Number(row?.n||0)===0})}catch(e){res.status(500).json({error:e.message})}});
app.post('/api/magasin/auth/bootstrap',async(req,res)=>{try{
  const db=requireRequestsDb(),count=await db.prepare("SELECT COUNT(*) AS n FROM magasin_users WHERE role='admin'").first();if(Number(count?.n||0)>0)return res.status(409).json({error:'Le compte responsable existe déjà.'});
  if(!magasinAuthorized(req))return res.status(403).json({error:"Le secret d'installation magasin est requis."});
  const b=req.body||{},email=lower(b.email);if(!email.endsWith('@3is.fr')||!safeEmail(email))return res.status(400).json({error:'Adresse @3is.fr obligatoire.'});if(String(b.password||'').length<12)return res.status(400).json({error:'Mot de passe : 12 caractères minimum.'});
  if(!['A1','A2','A3'].includes(b.schoolYear))return res.status(400).json({error:'Année scolaire invalide.'});
  const salt=randomToken(16),hash=await passwordHash(b.password,salt),now=new Date().toISOString();
  await db.prepare(`INSERT INTO magasin_users(role,first_name,last_name,birth_date,track,school_year,email,phone,photo_base64,password_hash,password_salt,created_at,updated_at) VALUES('admin',?,?,?,?,?,?,?,?,?,?,?,?)`).bind(String(b.firstName||'').trim(),String(b.lastName||'').trim(),String(b.birthDate||''),String(b.track||''),b.schoolYear,email,String(b.phone||''),String(b.photo||''),hash,salt,now,now).run();
  res.json({ok:true});
}catch(e){res.status(500).json({error:e.message})}});
app.post('/api/magasin/auth/login',async(req,res)=>{try{
  const db=requireRequestsDb(),email=lower(req.body?.email),row=await db.prepare('SELECT * FROM magasin_users WHERE email=? AND active=1').bind(email).first();if(!row)return res.status(401).json({error:'Identifiants invalides.'});
  const hash=await passwordHash(req.body?.password||'',row.password_salt);if(hash!==row.password_hash)return res.status(401).json({error:'Identifiants invalides.'});
  if(row.totp_enabled&&!await verifyTotp(row.totp_secret,req.body?.code))return res.status(401).json({error:'Code A2F requis ou invalide.',needs2fa:true});
  const token=randomToken(32),now=new Date(),exp=new Date(now.getTime()+12*3600000);await db.prepare('INSERT INTO magasin_sessions(token_hash,user_id,expires_at,created_at) VALUES(?,?,?,?)').bind(await sha256(token),row.id,exp.toISOString(),now.toISOString()).run();
  res.json({ok:true,token,user:{id:row.id,role:row.role,firstName:row.first_name,lastName:row.last_name,email:row.email,totpEnabled:Boolean(row.totp_enabled)}});
}catch(e){res.status(500).json({error:e.message})}});
app.post('/api/magasin/auth/logout',requireMagasin,async(req,res)=>{try{const raw=String(req.get('authorization')||'').replace(/^Bearer\s+/i,'').trim();if(raw)await requireRequestsDb().prepare('DELETE FROM magasin_sessions WHERE token_hash=?').bind(await sha256(raw)).run();res.json({ok:true})}catch(e){res.status(500).json({error:e.message})}});
app.get('/api/magasin/me',requireMagasin,(req,res)=>{const u=req.magasinUser;if(!u)return res.json({legacy:true,role:'admin'});res.json({id:u.id,role:u.role,firstName:u.first_name,lastName:u.last_name,email:u.email,photo:u.photo_base64,totpEnabled:Boolean(u.totp_enabled)})});
app.post('/api/magasin/me/2fa/setup',requireMagasin,async(req,res)=>{try{if(!req.magasinUser)return res.status(400).json({error:'Compte utilisateur requis.'});const secret=base32Random();await requireRequestsDb().prepare('UPDATE magasin_users SET totp_secret=?,totp_enabled=0,updated_at=? WHERE id=?').bind(secret,new Date().toISOString(),req.magasinUser.id).run();res.json({secret,uri:`otpauth://totp/3iS%20Lyon:${encodeURIComponent(req.magasinUser.email)}?secret=${secret}&issuer=3iS%20Lyon`})}catch(e){res.status(500).json({error:e.message})}});
app.post('/api/magasin/me/2fa/enable',requireMagasin,async(req,res)=>{try{const row=await requireRequestsDb().prepare('SELECT * FROM magasin_users WHERE id=?').bind(req.magasinUser?.id).first();if(!row?.totp_secret||!await verifyTotp(row.totp_secret,req.body?.code))return res.status(400).json({error:'Code A2F invalide.'});await requireRequestsDb().prepare('UPDATE magasin_users SET totp_enabled=1,updated_at=? WHERE id=?').bind(new Date().toISOString(),row.id).run();res.json({ok:true})}catch(e){res.status(500).json({error:e.message})}});
app.get('/api/magasin/admin/users',requireMagasin,requireAdmin,async(req,res)=>{try{const x=await requireRequestsDb().prepare('SELECT id,role,first_name AS firstName,last_name AS lastName,birth_date AS birthDate,track,school_year AS schoolYear,email,phone,photo_base64 AS photo,totp_enabled AS totpEnabled,active,created_at AS createdAt FROM magasin_users ORDER BY last_name,first_name').all();res.json({items:x.results||[]})}catch(e){res.status(500).json({error:e.message})}});
app.post('/api/magasin/admin/users',requireMagasin,requireAdmin,async(req,res)=>{try{const b=req.body||{},email=lower(b.email);if(!email.endsWith('@3is.fr')||!safeEmail(email))return res.status(400).json({error:'Adresse scolaire @3is.fr obligatoire.'});if(String(b.password||'').length<12)return res.status(400).json({error:'Mot de passe temporaire : 12 caractères minimum.'});if(!['A1','A2','A3'].includes(b.schoolYear))return res.status(400).json({error:'Année invalide.'});const salt=randomToken(16),hash=await passwordHash(b.password,salt),now=new Date().toISOString();const x=await requireRequestsDb().prepare(`INSERT INTO magasin_users(role,first_name,last_name,birth_date,track,school_year,email,phone,photo_base64,password_hash,password_salt,created_at,updated_at) VALUES('staff',?,?,?,?,?,?,?,?,?,?,?,?)`).bind(String(b.firstName||'').trim(),String(b.lastName||'').trim(),String(b.birthDate||''),String(b.track||''),b.schoolYear,email,String(b.phone||''),String(b.photo||''),hash,salt,now,now).run();res.json({ok:true,id:x.meta?.last_row_id})}catch(e){res.status(409).json({error:e.message})}});
app.put('/api/magasin/admin/users/:id',requireMagasin,requireAdmin,async(req,res)=>{try{const id=Number(req.params.id),b=req.body||{},email=lower(b.email);if(!email.endsWith('@3is.fr'))return res.status(400).json({error:'Adresse @3is.fr obligatoire.'});await requireRequestsDb().prepare('UPDATE magasin_users SET first_name=?,last_name=?,birth_date=?,track=?,school_year=?,email=?,phone=?,photo_base64=?,active=?,updated_at=? WHERE id=?').bind(b.firstName,b.lastName,b.birthDate,b.track,b.schoolYear,email,b.phone,b.photo||'',b.active===false?0:1,new Date().toISOString(),id).run();res.json({ok:true})}catch(e){res.status(409).json({error:e.message})}});
app.delete('/api/magasin/admin/users/:id',requireMagasin,requireAdmin,async(req,res)=>{try{const id=Number(req.params.id);if(id===req.magasinUser.id)return res.status(400).json({error:'Impossible de supprimer ton propre compte.'});const db=requireRequestsDb();await db.batch([db.prepare('DELETE FROM magasin_sessions WHERE user_id=?').bind(id),db.prepare("DELETE FROM magasin_users WHERE id=? AND role='staff'").bind(id)]);res.json({ok:true})}catch(e){res.status(500).json({error:e.message})}});
function reservationFromRow(row, messages = []) {
  return {
    id: row.id, name: row.name, role: row.role, status: row.status,
    archived: Boolean(row.archived), fulfillmentStatus: row.fulfillment_status || (row.status === 'accepted' ? 'accepted' : ''),
    from: row.date_from, to: row.date_to, reason: row.reason,
    track: row.track || '', year: row.year || '', course: row.course || '',
    personalUse: Boolean(row.personal_use),
    person: [row.first_name, row.last_name].filter(Boolean).join(' '),
    firstName: row.first_name, lastName: row.last_name, email: row.email,
    createdAt: row.created_at, updatedAt: row.updated_at,
    accountManager: row.account_manager || '',
    rentmanProjectId: row.rentman_project_id || null, pickupToken: row.pickup_token || '',
    messages
  };
}
async function loadLocalReservation(id) {
  const db = requireRequestsDb();
  const row = await db.prepare('SELECT * FROM reservations WHERE id = ?').bind(id).first();
  if (!row) return null;
  const equipmentRows = await db.prepare('SELECT equipment_id AS equipmentId, name, quantity FROM reservation_items WHERE reservation_id = ? ORDER BY id').bind(id).all();
  const messages = await db.prepare('SELECT id, author, message, created_at AS createdAt FROM reservation_messages WHERE reservation_id = ? ORDER BY id').bind(id).all();
  const attachments = await db.prepare('SELECT id, name, mime_type AS type, size, author, created_at AS createdAt FROM reservation_attachments WHERE reservation_id = ? ORDER BY id').bind(id).all();
  const activity = await db.prepare('SELECT id, actor, action, details, created_at AS createdAt FROM reservation_activity WHERE reservation_id = ? ORDER BY id DESC LIMIT 100').bind(id).all();
  const incidents = await db.prepare('SELECT * FROM reservation_incidents WHERE reservation_id=? ORDER BY id DESC').bind(id).all();
  const unitEvents = await db.prepare('SELECT e.*,u.label,u.barcode,u.serial_number AS serialNumber FROM reservation_unit_events e LEFT JOIN equipment_units u ON u.id=e.unit_id WHERE e.reservation_id=? ORDER BY e.id DESC').bind(id).all();
  const documents = await db.prepare('SELECT id,type,total,created_at AS createdAt FROM reservation_documents WHERE reservation_id=? ORDER BY id DESC').bind(id).all();
  let priceMap = new Map();
  try { priceMap = new Map((await getEquipment()).map(x => [Number(x.id), Number(x.rentalPrice) || 0])); } catch (_) {}
  const equipment = (equipmentRows.results || []).map(x => ({ ...x, unitPrice: priceMap.get(Number(x.equipmentId)) || 0 }));
  return { reservation: reservationFromRow(row, messages.results || []), equipment, attachments: attachments.results || [], activity: activity.results || [], incidents:incidents.results||[], unitEvents:unitEvents.results||[], documents:documents.results||[] };
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


async function logActivity(id, actor, action, details = '') {
  try {
    const db = requireRequestsDb(), now = new Date().toISOString();
    await db.prepare('INSERT INTO reservation_activity (reservation_id, actor, action, details, created_at) VALUES (?, ?, ?, ?, ?)').bind(id, actor, action, details, now).run();
    if (actor && actor !== 'Magasin' && actor !== 'Réservant') {
      await db.prepare('UPDATE reservations SET account_manager = ?, updated_at = ? WHERE id = ?').bind(actor, now, id).run();
    }
  } catch (_) {}
}
function mailHtml(title, body) { return `<div style="font-family:Arial,sans-serif;max-width:620px;margin:auto"><h2 style="color:#ea3e43">${title}</h2><div style="line-height:1.6;color:#222">${body}</div><p style="color:#777;font-size:12px">3iS Lyon · Magasin audiovisuel</p></div>`; }
async function sendReservationEmail(row, subject, html) {
  const apiKey = config('RESEND_API_KEY'), from = config('MAIL_FROM');
  if (!apiKey || !from || !row?.email) return { sent:false, reason:'not_configured' };
  try {
    const r = await fetch('https://api.resend.com/emails', { method:'POST', headers:{ Authorization:`Bearer ${apiKey}`, 'Content-Type':'application/json' }, body:JSON.stringify({ from, to:[row.email], subject, html }) });
    if (!r.ok) throw new Error((await r.text()).slice(0,300));
    return { sent:true };
  } catch (e) { return { sent:false, reason:e.message }; }
}
async function checkReservationStock(id) {
  const data = await loadLocalReservation(id);
  if (!data) return null;
  const from = new Date(`${data.reservation.from}T00:00:00`), to = new Date(`${data.reservation.to}T23:59:59.999`);
  const equipment = await getEquipment(), byId = new Map(equipment.map(x=>[Number(x.id),x]));
  const groups = await all('/projectequipmentgroup',{sort:'+id',fields:'id,planperiod_start,planperiod_end,usageperiod_start,usageperiod_end'},{cacheMs:AVAILABILITY_CACHE_MS});
  const relevant = groups.filter(g=>{const a=new Date(g.planperiod_start||g.usageperiod_start||''),b=new Date(g.planperiod_end||g.usageperiod_end||'');return !Number.isNaN(a.valueOf())&&!Number.isNaN(b.valueOf())&&overlap(a,b,from,to)});
  const selected = relevant.slice(0,20), deductions = new Map();
  const rows = await Promise.all(selected.map(async g => {
    try { return await all(`/projectequipmentgroup/${g.id}/projectequipment`,{sort:'+id',fields:'id,equipment,linked_equipment,quantity,is_option,warehouse_reservations'},{cacheMs:AVAILABILITY_CACHE_MS}); } catch (_) { return []; }
  }));
  for (const p of rows.flat()) { if(p.is_option===true)continue;const eid=refId(p.equipment||p.linked_equipment),q=Math.max(0,number(p.warehouse_reservations,0));if(eid&&q)deductions.set(eid,(deductions.get(eid)||0)+q); }
  const items = data.equipment.map(line=>{const e=byId.get(Number(line.equipmentId)),available=e?.stockKnown?Math.max(0,e.currentStock-(deductions.get(Number(line.equipmentId))||0)):null;return {equipmentId:line.equipmentId,name:line.name,requested:Number(line.quantity),available,ok:available===null||available>=Number(line.quantity)}});
  return { ok:items.every(x=>x.ok), complete:relevant.length<=20, items };
}

async function ensurePickupToken(id){const db=requireRequestsDb(),row=await db.prepare('SELECT pickup_token FROM reservations WHERE id=?').bind(id).first();if(row?.pickup_token)return row.pickup_token;const token=randomToken(16);await db.prepare('UPDATE reservations SET pickup_token=? WHERE id=?').bind(token,id).run();return token}
async function syncReservationToRentman(id){
  const db=requireRequestsDb(),row=await db.prepare('SELECT * FROM reservations WHERE id=?').bind(id).first();if(!row)throw Object.assign(new Error('Demande introuvable.'),{status:404});if(row.rentman_project_id)return {id:row.rentman_project_id,existing:true};
  const created=projectRequestData(await writeRentman('/projects','POST',{name:row.name,reference:`WEB-LYON-${id}`}));const pid=Number(created.id);if(!pid)throw new Error("Rentman n'a pas retourné l'identifiant du projet.");
  await db.prepare('UPDATE reservations SET rentman_project_id=?,updated_at=? WHERE id=?').bind(pid,new Date().toISOString(),id).run();return {id:pid,existing:false};
}
app.post('/api/magasin/requests/:id/rentman-sync',requireMagasin,async(req,res)=>{try{const id=Number(req.params.id),x=await syncReservationToRentman(id);await logActivity(id,magasinActor(req),'Synchronisation Rentman',`Projet #${x.id}`);res.json({ok:true,projectId:x.id})}catch(e){res.status(e.status||502).json({error:e.message})}});
app.get('/api/magasin/pickup/:token',requireMagasin,async(req,res)=>{try{const row=await requireRequestsDb().prepare('SELECT id FROM reservations WHERE pickup_token=?').bind(String(req.params.token)).first();if(!row)return res.status(404).json({error:'QR de réservation invalide.'});res.json({id:row.id})}catch(e){res.status(500).json({error:e.message})}});
app.get('/api/magasin/clients',requireMagasin,async(req,res)=>{try{const email=lower(req.query.email);if(!safeEmail(email))return res.status(400).json({error:'E-mail invalide.'});const rows=await requireRequestsDb().prepare('SELECT * FROM reservations WHERE lower(email)=? ORDER BY id DESC').bind(email).all();res.json({items:(rows.results||[]).map(x=>reservationFromRow(x))})}catch(e){res.status(500).json({error:e.message})}});
app.get('/api/magasin/equipment/:id/alternatives',requireMagasin,async(req,res)=>{try{const id=Number(req.params.id),links=await requireRequestsDb().prepare('SELECT alternative_equipment_id AS id FROM equipment_alternatives WHERE equipment_id=?').bind(id).all(),equipment=await getEquipment(),by=new Map(equipment.map(x=>[Number(x.id),x]));res.json({items:(links.results||[]).map(x=>by.get(Number(x.id))).filter(Boolean)})}catch(e){res.status(500).json({error:e.message})}});
app.post('/api/magasin/equipment/:id/alternatives',requireMagasin,async(req,res)=>{try{const id=Number(req.params.id),alt=Number(req.body?.alternativeId);if(!id||!alt||id===alt)return res.status(400).json({error:'Alternative invalide.'});await requireRequestsDb().prepare('INSERT OR IGNORE INTO equipment_alternatives(equipment_id,alternative_equipment_id,created_by,created_at) VALUES(?,?,?,?)').bind(id,alt,req.magasinUser?.id||null,new Date().toISOString()).run();res.json({ok:true})}catch(e){res.status(500).json({error:e.message})}});
app.get('/api/magasin/equipment/:id/units',requireMagasin,async(req,res)=>{try{const x=await requireRequestsDb().prepare('SELECT * FROM equipment_units WHERE equipment_id=? ORDER BY label').bind(Number(req.params.id)).all();res.json({items:x.results||[]})}catch(e){res.status(500).json({error:e.message})}});
app.post('/api/magasin/equipment/:id/units',requireMagasin,async(req,res)=>{try{const id=Number(req.params.id),b=req.body||{},now=new Date().toISOString();if(!String(b.barcode||'').trim())return res.status(400).json({error:'Code-barres/QR obligatoire.'});const x=await requireRequestsDb().prepare('INSERT INTO equipment_units(equipment_id,label,barcode,serial_number,notes,created_at,updated_at) VALUES(?,?,?,?,?,?,?)').bind(id,String(b.label||'Unité'),String(b.barcode).trim(),String(b.serialNumber||''),String(b.notes||''),now,now).run();res.json({ok:true,id:x.meta?.last_row_id})}catch(e){res.status(409).json({error:e.message})}});
app.post('/api/magasin/requests/:id/scan',requireMagasin,async(req,res)=>{try{const id=Number(req.params.id),b=req.body||{},phase=String(b.phase||'prepare');if(!['prepare','checkout','return'].includes(phase))return res.status(400).json({error:'Phase invalide.'});const db=requireRequestsDb(),unit=await db.prepare('SELECT * FROM equipment_units WHERE barcode=?').bind(String(b.barcode||'').trim()).first();if(!unit)return res.status(404).json({error:'Unité inconnue. Ajoute-la d’abord au parc.'});const line=await db.prepare('SELECT * FROM reservation_items WHERE reservation_id=? AND equipment_id=?').bind(id,unit.equipment_id).first();if(!line)return res.status(409).json({error:"Cette unité ne correspond pas au matériel de la réservation."});const condition=['ok','damaged','missing','not_returned'].includes(b.condition)?b.condition:'ok',actor=magasinActor(req),now=new Date().toISOString();await db.prepare('INSERT INTO reservation_unit_events(reservation_id,unit_id,phase,condition_status,comment,photo_base64,actor,created_at) VALUES(?,?,?,?,?,?,?,?)').bind(id,unit.id,phase,condition,String(b.comment||''),String(b.photo||''),actor,now).run();const unitStatus=phase==='return'?(condition==='ok'?'available':condition==='missing'||condition==='not_returned'?'missing':'maintenance'):phase==='checkout'?'out':'prepared';await db.prepare('UPDATE equipment_units SET status=?,updated_at=? WHERE id=?').bind(unitStatus,now,unit.id).run();if(condition!=='ok')await db.prepare('INSERT INTO reservation_incidents(reservation_id,equipment_id,unit_id,type,comment,photo_base64,actor,created_at) VALUES(?,?,?,?,?,?,?,?)').bind(id,unit.equipment_id,unit.id,condition,String(b.comment||''),String(b.photo||''),actor,now).run();await logActivity(id,actor,`Scan ${phase}`,`${unit.label} · ${unit.barcode} · ${condition}`);res.json({ok:true,unit:{id:unit.id,label:unit.label,barcode:unit.barcode,status:unitStatus}})}catch(e){res.status(e.status||500).json({error:e.message})}});
app.post('/api/magasin/requests/:id/incidents',requireMagasin,async(req,res)=>{try{const id=Number(req.params.id),b=req.body||{},actor=magasinActor(req);await requireRequestsDb().prepare('INSERT INTO reservation_incidents(reservation_id,equipment_id,unit_id,type,comment,photo_base64,actor,created_at) VALUES(?,?,?,?,?,?,?,?)').bind(id,b.equipmentId||null,b.unitId||null,String(b.type||'damaged'),String(b.comment||''),String(b.photo||''),actor,new Date().toISOString()).run();await logActivity(id,actor,'Incident matériel',String(b.comment||b.type||''));res.json({ok:true})}catch(e){res.status(500).json({error:e.message})}});
app.get('/api/magasin/reminders',requireMagasin,async(req,res)=>{try{const today=new Date().toISOString().slice(0,10),rows=await requireRequestsDb().prepare("SELECT * FROM reservations WHERE status='accepted' AND archived=0 AND fulfillment_status NOT IN ('returned','closed') AND date_to<=? ORDER BY date_to").bind(today).all();res.json({items:(rows.results||[]).map(x=>reservationFromRow(x))})}catch(e){res.status(500).json({error:e.message})}});
app.post('/api/magasin/requests/:id/remind',requireMagasin,async(req,res)=>{try{const id=Number(req.params.id),db=requireRequestsDb(),row=await db.prepare('SELECT * FROM reservations WHERE id=?').bind(id).first();if(!row)return res.status(404).json({error:'Demande introuvable.'});const result=await sendReservationEmail(row,`Rappel retour matériel — demande #${id}`,mailHtml('Rappel de retour',`<p>Bonjour ${row.first_name},</p><p>Le matériel de la demande #${id} est attendu au magasin 3iS Lyon au plus tard le ${row.date_to}.</p>`));await db.prepare('UPDATE reservations SET last_reminder_at=? WHERE id=?').bind(new Date().toISOString(),id).run();await logActivity(id,magasinActor(req),'Rappel de retour envoyé');res.json({ok:true,...result})}catch(e){res.status(500).json({error:e.message})}});
app.get('/api/magasin/dashboard', requireMagasin, async (req,res)=>{
  try {
    const db=requireRequestsDb(), rows=await db.prepare('SELECT * FROM reservations ORDER BY id DESC LIMIT 500').all(), items=(rows.results||[]).map(row=>reservationFromRow(row));
    const today=new Date().toISOString().slice(0,10), active=items.filter(x=>!x.archived);
    const stats={pending:active.filter(x=>x.status==='pending').length,preparing:active.filter(x=>x.fulfillmentStatus==='preparing').length,ready:active.filter(x=>x.fulfillmentStatus==='ready').length,pickupsToday:active.filter(x=>x.status==='accepted'&&x.from===today).length,returnsToday:active.filter(x=>x.status==='accepted'&&x.to===today).length,overdue:active.filter(x=>x.status==='accepted'&&x.to<today&&!['returned','closed'].includes(x.fulfillmentStatus)).length};
    res.json({stats,items});
  } catch(e){res.status(e.status||502).json({error:e.message})}
});
app.get('/api/magasin/requests/:id/stock-check', requireMagasin, async(req,res)=>{try{const x=await checkReservationStock(Number(req.params.id));if(!x)return res.status(404).json({error:'Demande introuvable.'});res.json(x)}catch(e){res.status(e.status||502).json({error:e.message})}});
app.post('/api/magasin/requests/:id/archive', requireMagasin, async(req,res)=>{try{const id=Number(req.params.id),archived=req.body?.archived?1:0,db=requireRequestsDb(),now=new Date().toISOString();const r=await db.prepare('UPDATE reservations SET archived=?, updated_at=? WHERE id=?').bind(archived,now,id).run();if(!r.meta?.changes)return res.status(404).json({error:'Demande introuvable.'});await logActivity(id,magasinActor(req),archived?'Demande archivée':'Demande désarchivée');res.json({ok:true,archived:Boolean(archived)})}catch(e){res.status(e.status||502).json({error:e.message})}});
app.post('/api/magasin/requests/:id/workflow', requireMagasin, async(req,res)=>{try{const id=Number(req.params.id),status=String(req.body?.status||'');if(!['preparing','ready','collected','returned','closed'].includes(status))return res.status(400).json({error:'Étape invalide.'});const db=requireRequestsDb(),now=new Date().toISOString(),row=await db.prepare('SELECT * FROM reservations WHERE id=?').bind(id).first();if(!row)return res.status(404).json({error:'Demande introuvable.'});if(row.status!=='accepted')return res.status(409).json({error:"La demande doit d'abord être acceptée."});await db.prepare('UPDATE reservations SET fulfillment_status=?, updated_at=? WHERE id=?').bind(status,now,id).run();const names={preparing:'à préparer',ready:'prête au retrait',collected:'retirée',returned:'retournée',closed:'clôturée'};await db.prepare('INSERT INTO reservation_messages (reservation_id,author,message,created_at) VALUES (?,?,?,?)').bind(id,'staff',`Demande ${names[status]}.`,now).run();await logActivity(id,magasinActor(req),`Étape : ${names[status]}`);if(status==='ready')await sendReservationEmail(row,'Votre matériel 3iS Lyon est prêt',mailHtml('Matériel prêt',`<p>Bonjour ${row.first_name},</p><p>Votre demande #${id} est prête au retrait au magasin.</p>`));res.json({ok:true,status})}catch(e){res.status(e.status||502).json({error:e.message})}});
app.put('/api/magasin/requests/:id/items', requireMagasin, async(req,res)=>{try{const id=Number(req.params.id),items=Array.isArray(req.body?.items)?req.body.items:[];if(!items.length)return res.status(400).json({error:'Aucun matériel.'});const db=requireRequestsDb(),existing=await db.prepare('SELECT equipment_id AS equipmentId,name FROM reservation_items WHERE reservation_id=?').bind(id).all(),names=new Map((existing.results||[]).map(x=>[Number(x.equipmentId),x.name]));await db.prepare('DELETE FROM reservation_items WHERE reservation_id=?').bind(id).run();await db.batch(items.map(x=>db.prepare('INSERT INTO reservation_items (reservation_id,equipment_id,name,quantity) VALUES (?,?,?,?)').bind(id,Number(x.equipmentId),names.get(Number(x.equipmentId))||`Équipement ${x.equipmentId}`,Math.max(1,Number(x.quantity)||1))));await logActivity(id,magasinActor(req),'Matériel de la demande modifié',items.map(x=>`#${x.equipmentId} ×${x.quantity}`).join(', '));res.json({ok:true})}catch(e){res.status(e.status||502).json({error:e.message})}});
app.post('/api/magasin/requests/:id/attachments', requireMagasin, async(req,res)=>{try{const id=Number(req.params.id),name=String(req.body?.name||'fichier').slice(0,180),type=String(req.body?.type||'application/octet-stream').slice(0,100),data=String(req.body?.data||'');if(!data||data.length>850000)return res.status(400).json({error:'Fichier invalide ou trop volumineux (600 Ko max).'});const size=Math.floor(data.length*0.75),db=requireRequestsDb();await db.prepare('INSERT INTO reservation_attachments (reservation_id,author,name,mime_type,size,data_base64,created_at) VALUES (?,?,?,?,?,?,?)').bind(id,'staff',name,type,size,data,new Date().toISOString()).run();await logActivity(id,magasinActor(req),'Pièce jointe ajoutée',name);res.json({ok:true})}catch(e){res.status(e.status||502).json({error:e.message})}});
app.get('/api/magasin/attachments/:id', requireMagasin, async(req,res)=>{try{const row=await requireRequestsDb().prepare('SELECT * FROM reservation_attachments WHERE id=?').bind(Number(req.params.id)).first();if(!row)return res.status(404).end();const bytes=Uint8Array.from(atob(row.data_base64),c=>c.charCodeAt(0));res.set('Content-Type',row.mime_type||'application/octet-stream');res.set('Content-Disposition',`attachment; filename="${String(row.name).replace(/"/g,'')}"`);res.send(bytes)}catch(e){res.status(500).json({error:e.message})}});
app.post('/api/reservations/:id/attachments', async(req,res)=>{try{const id=Number(req.params.id),email=lower(req.body?.email),name=String(req.body?.name||'fichier').slice(0,180),type=String(req.body?.type||'application/octet-stream').slice(0,100),data=String(req.body?.data||'');const found=await loadLocalReservation(id);if(!found||lower(found.reservation.email)!==email)return res.status(403).json({error:'Accès refusé.'});if(!data||data.length>850000)return res.status(400).json({error:'Fichier invalide ou trop volumineux (600 Ko max).'});await requireRequestsDb().prepare('INSERT INTO reservation_attachments (reservation_id,author,name,mime_type,size,data_base64,created_at) VALUES (?,?,?,?,?,?,?)').bind(id,'user',name,type,Math.floor(data.length*.75),data,new Date().toISOString()).run();await logActivity(id,'Réservant','Pièce jointe ajoutée',name);res.json({ok:true})}catch(e){res.status(e.status||502).json({error:e.message})}});
app.post('/api/reservations/:id/attachments/:attachmentId/view', async(req,res)=>{try{const id=Number(req.params.id),aid=Number(req.params.attachmentId),email=lower(req.body?.email),found=await loadLocalReservation(id);if(!found||lower(found.reservation.email)!==email)return res.status(403).json({error:'Accès refusé.'});const row=await requireRequestsDb().prepare('SELECT * FROM reservation_attachments WHERE id=? AND reservation_id=?').bind(aid,id).first();if(!row)return res.status(404).end();const bytes=Uint8Array.from(atob(row.data_base64),c=>c.charCodeAt(0));res.set('Content-Type',row.mime_type||'application/octet-stream');res.set('Content-Disposition',`attachment; filename="${String(row.name).replace(/"/g,'')}"`);res.send(bytes)}catch(e){res.status(500).json({error:e.message})}});
app.post('/api/magasin/requests/:id/document', requireMagasin, async(req,res)=>{try{const id=Number(req.params.id),type=String(req.body?.type||'');if(!['devis','facture'].includes(type))return res.status(400).json({error:'Document invalide.'});const total=Math.max(0,Number(req.body?.total)||0);await requireRequestsDb().prepare('INSERT INTO reservation_documents (reservation_id,type,total,created_at) VALUES (?,?,?,?)').bind(id,type,total,new Date().toISOString()).run();await logActivity(id,magasinActor(req),type==='devis'?'Devis généré':'Facture générée',`Total : ${total.toFixed(2)} €`);res.json({ok:true})}catch(e){res.status(e.status||502).json({error:e.message})}});

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
    if (status === 'accepted') { const stock = await checkReservationStock(id); if (stock && !stock.ok) return res.status(409).json({ error: 'Stock insuffisant pour accepter cette demande.', stock }); }
    const db = requireRequestsDb(), now = new Date().toISOString();
    const result = await db.prepare('UPDATE reservations SET status = ?, updated_at = ? WHERE id = ?').bind(status, now, id).run();
    if (!result.meta?.changes) return res.status(404).json({ error: 'Demande introuvable.' });
    const labels = { pending:'remise en attente', accepted:'acceptée par le magasin', refused:'refusée par le magasin' };
    await db.prepare('INSERT INTO reservation_messages (reservation_id, author, message, created_at) VALUES (?, ?, ?, ?)')
      .bind(id, 'staff', `Demande ${labels[status]}.`, now).run();
    if (status === 'accepted') {
      await db.prepare("UPDATE reservations SET fulfillment_status='accepted' WHERE id=?").bind(id).run();
      await ensurePickupToken(id);
      try { const sync=await syncReservationToRentman(id); await logActivity(id,magasinActor(req),'Projet Rentman créé',`#${sync.id}`); } catch(syncErr) { await logActivity(id,magasinActor(req),'Synchronisation Rentman à reprendre',String(syncErr.message||syncErr)); }
    }
    const row = await db.prepare('SELECT * FROM reservations WHERE id=?').bind(id).first();
    await logActivity(id, magasinActor(req), `Demande ${labels[status]}`);
    await sendReservationEmail(row, `Demande matériel #${id} — ${status === 'accepted' ? 'acceptée' : status === 'refused' ? 'refusée' : 'mise à jour'}`, mailHtml('Mise à jour de votre demande', `<p>Bonjour ${row?.first_name || ''},</p><p>Votre demande #${id} a été ${labels[status]}.</p>`));
    res.json({ ok: true, status });
  } catch (e) { res.status(e.status || 502).json({ error: e.message }); }
});
app.delete('/api/magasin/requests/:id', requireMagasin, async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!id) return res.status(400).json({ error: 'Demande invalide.' });
    const db = requireRequestsDb();
    const exists = await db.prepare('SELECT id FROM reservations WHERE id = ?').bind(id).first();
    if (!exists) return res.status(404).json({ error: 'Demande introuvable.' });

    // Delete children explicitly: this remains reliable even if D1 foreign_keys
    // is not enabled for the current connection.
    await db.batch([
      db.prepare('DELETE FROM reservation_messages WHERE reservation_id = ?').bind(id),
      db.prepare('DELETE FROM reservation_items WHERE reservation_id = ?').bind(id),
      db.prepare('DELETE FROM reservation_attachments WHERE reservation_id = ?').bind(id),
      db.prepare('DELETE FROM reservation_activity WHERE reservation_id = ?').bind(id),
      db.prepare('DELETE FROM reservation_documents WHERE reservation_id = ?').bind(id),
      db.prepare('DELETE FROM reservations WHERE id = ?').bind(id)
    ]);
    setTyping(id, 'staff', false);
    setTyping(id, 'user', false);
    res.json({ ok: true, id });
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
    const row = await db.prepare('SELECT * FROM reservations WHERE id=?').bind(id).first();
    await logActivity(id, magasinActor(req), 'Message envoyé', message.slice(0,120));
    await sendReservationEmail(row, `Nouveau message du magasin — demande #${id}`, mailHtml('Nouveau message du magasin', `<p>${message.replace(/[&<>]/g,'')}</p><p>Consultez votre demande sur le catalogue 3iS Lyon pour répondre.</p>`));
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
