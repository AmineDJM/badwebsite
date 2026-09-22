'use strict';

// Management UI server: serves the static frontend (../public), reverse
// proxies /api/v1/* to the gosom/google-maps-scraper engine (internal only,
// 127.0.0.1), and runs our own strict FIFO dispatcher under /api/queue.
//
// Why a dispatcher: the upstream engine only ever runs one job at a time,
// but it picks the next *pending* job with `ORDER BY created_at DESC`
// (web/sqlite/sqlite.go) — i.e. last-in-first-out, not the order you'd
// expect from a "queue". If we created several jobs at once, they'd run in
// REVERSE order. Instead we keep at most one job "pending" in the engine at
// any time: we hold everything else in our own ordered list and hand jobs
// to the engine one by one, in the exact order they were submitted, only
// once the previous one has finished. That sidesteps the engine's
// ordering entirely (with ≤1 pending job, DESC vs ASC makes no difference)
// and gives the UI real queue positions.
//
// Zero npm dependencies on purpose: keeps the Docker build fast and avoids
// a class of supply-chain / install failures for something this small.

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = process.env.PORT || 3000;
const SCRAPER_HOST = '127.0.0.1';
const SCRAPER_PORT = process.env.SCRAPER_INTERNAL_PORT || '8081';
const ADMIN_USERNAME = process.env.ADMIN_USERNAME || '';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '';
const DATA_FOLDER = process.env.DATA_FOLDER || '/data';
const DEFAULT_PROXIES = (process.env.DEFAULT_PROXIES || '')
  .split(/[\n,]/)
  .map((p) => p.trim())
  .filter(Boolean);
const QUEUE_FILE = path.join(DATA_FOLDER, 'queue.json');
const DISPATCH_INTERVAL_MS = 3000;
const MAX_ITEMS_PER_REQUEST = 200;

const PUBLIC_DIR = path.join(__dirname, '..', 'public');

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.png': 'image/png',
};

if (!ADMIN_USERNAME || !ADMIN_PASSWORD) {
  console.warn(
    '[server] WARNING: ADMIN_USERNAME / ADMIN_PASSWORD are not both set — ' +
      'the management UI is running WITHOUT authentication. Set both env vars ' +
      'to protect this deployment.'
  );
}
if (DEFAULT_PROXIES.length > 0) {
  console.log(`[server] ${DEFAULT_PROXIES.length} default proxy(ies) configured via DEFAULT_PROXIES`);
}

// ---------------------------------------------------------------------------
// auth
// ---------------------------------------------------------------------------

function safeEqual(a, b) {
  const bufA = Buffer.from(String(a));
  const bufB = Buffer.from(String(b));
  if (bufA.length !== bufB.length) {
    crypto.timingSafeEqual(bufA, Buffer.alloc(bufA.length));
    return false;
  }
  return crypto.timingSafeEqual(bufA, bufB);
}

function isAuthorized(req) {
  if (!ADMIN_USERNAME || !ADMIN_PASSWORD) return true;

  const header = req.headers['authorization'] || '';
  const [scheme, encoded] = header.split(' ');
  if (scheme !== 'Basic' || !encoded) return false;

  let decoded;
  try {
    decoded = Buffer.from(encoded, 'base64').toString('utf8');
  } catch {
    return false;
  }
  const sep = decoded.indexOf(':');
  if (sep === -1) return false;

  const user = decoded.slice(0, sep);
  const pass = decoded.slice(sep + 1);
  return safeEqual(user, ADMIN_USERNAME) && safeEqual(pass, ADMIN_PASSWORD);
}

function requireAuth(res) {
  res.writeHead(401, {
    'WWW-Authenticate': 'Basic realm="Scraper Manager"',
    'Content-Type': 'text/plain; charset=utf-8',
  });
  res.end('Authentication required');
}

// ---------------------------------------------------------------------------
// tiny internal HTTP client for talking to the engine ourselves
// (used by the dispatcher — distinct from the generic pass-through proxy)
// ---------------------------------------------------------------------------

function engineRequest(method, urlPath, bodyObj) {
  return new Promise((resolve, reject) => {
    const bodyStr = bodyObj !== undefined ? JSON.stringify(bodyObj) : null;
    const headers = { 'Content-Type': 'application/json' };
    if (bodyStr) headers['Content-Length'] = Buffer.byteLength(bodyStr);

    const req = http.request(
      { hostname: SCRAPER_HOST, port: SCRAPER_PORT, path: urlPath, method, headers },
      (res) => {
        let raw = '';
        res.on('data', (c) => (raw += c));
        res.on('end', () => {
          let parsed = null;
          try {
            parsed = raw ? JSON.parse(raw) : null;
          } catch {
            // non-JSON response, leave parsed as null
          }
          resolve({ statusCode: res.statusCode, body: parsed, raw });
        });
      }
    );
    req.on('error', reject);
    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}

async function engineCreateJob(payload) {
  const { statusCode, body } = await engineRequest('POST', '/api/v1/jobs', payload);
  if (statusCode !== 201 || !body || !body.id) {
    throw new Error((body && body.message) || `engine returned HTTP ${statusCode}`);
  }
  return body.id;
}

async function engineGetJob(id) {
  const { statusCode, body } = await engineRequest('GET', `/api/v1/jobs/${id}`);
  if (statusCode === 404) return null;
  if (statusCode !== 200) throw new Error((body && body.message) || `engine returned HTTP ${statusCode}`);
  return body;
}

async function engineDeleteJob(id) {
  await engineRequest('DELETE', `/api/v1/jobs/${id}`);
}

// ---------------------------------------------------------------------------
// FIFO queue + dispatcher
// ---------------------------------------------------------------------------

let queue = [];
let dispatching = false;

function loadQueue() {
  try {
    const raw = fs.readFileSync(QUEUE_FILE, 'utf8');
    queue = JSON.parse(raw);
    console.log(`[queue] loaded ${queue.length} item(s) from ${QUEUE_FILE}`);
  } catch {
    queue = [];
  }
}

function persistQueue() {
  try {
    fs.mkdirSync(DATA_FOLDER, { recursive: true });
    fs.writeFileSync(QUEUE_FILE, JSON.stringify(queue, null, 2));
  } catch (err) {
    console.error('[queue] failed to persist queue.json:', err.message);
  }
}

function publicQueueView() {
  let position = 0;
  return queue.map((item) => {
    const out = {
      id: item.id,
      name: item.name,
      keywords: item.payload.keywords,
      status: item.status,
      engineJobId: item.engineJobId,
      error: item.error,
      createdAt: item.createdAt,
    };
    if (item.status === 'queued') {
      position += 1;
      out.queuePosition = position;
    }
    return out;
  });
}

async function dispatchTick() {
  if (dispatching) return;
  dispatching = true;
  try {
    const current = queue.find((q) => q.status === 'submitted');
    if (current) {
      let job;
      try {
        job = await engineGetJob(current.engineJobId);
      } catch (err) {
        console.error('[queue] error polling engine job', current.engineJobId, err.message);
        return;
      }
      if (!job) {
        current.status = 'failed';
        current.error = 'le job a disparu côté moteur (supprimé ?)';
        persistQueue();
      } else if (job.Status === 'ok' || job.Status === 'failed') {
        current.status = job.Status;
        persistQueue();
      }
      // else still pending/working in the engine: wait for the next tick.
      return;
    }

    const next = queue.find((q) => q.status === 'queued');
    if (!next) return;

    const payload = { ...next.payload };
    if ((!payload.proxies || payload.proxies.length === 0) && DEFAULT_PROXIES.length > 0) {
      payload.proxies = DEFAULT_PROXIES;
    }

    try {
      const id = await engineCreateJob(payload);
      next.status = 'submitted';
      next.engineJobId = id;
      console.log(`[queue] dispatched "${next.name}" -> engine job ${id}`);
    } catch (err) {
      next.status = 'failed';
      next.error = err.message;
      console.error(`[queue] failed to dispatch "${next.name}":`, err.message);
    }
    persistQueue();
  } finally {
    dispatching = false;
  }
}

loadQueue();
setInterval(dispatchTick, DISPATCH_INTERVAL_MS);
dispatchTick();

// ---------------------------------------------------------------------------
// request body helper
// ---------------------------------------------------------------------------

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', (c) => {
      raw += c;
      if (raw.length > 5 * 1024 * 1024) {
        reject(new Error('request body too large'));
        req.destroy();
      }
    });
    req.on('end', () => {
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch (err) {
        reject(new Error('invalid JSON body'));
      }
    });
    req.on('error', reject);
  });
}

function sendJSON(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(obj));
}

// ---------------------------------------------------------------------------
// /api/queue handlers
// ---------------------------------------------------------------------------

async function handleQueueList(req, res) {
  sendJSON(res, 200, publicQueueView());
}

async function handleQueueCreate(req, res) {
  let body;
  try {
    body = await readJsonBody(req);
  } catch (err) {
    return sendJSON(res, 400, { message: err.message });
  }

  const items = Array.isArray(body.items) ? body.items : [];
  if (items.length === 0) {
    return sendJSON(res, 422, { message: 'items manquants' });
  }
  if (items.length > MAX_ITEMS_PER_REQUEST) {
    return sendJSON(res, 422, { message: `trop d'items (max ${MAX_ITEMS_PER_REQUEST})` });
  }

  const created = [];
  for (const raw of items) {
    const name = String(raw.name || '').trim();
    const keywords = Array.isArray(raw.keywords) ? raw.keywords.map((k) => String(k).trim()).filter(Boolean) : [];
    if (!name || keywords.length === 0) {
      return sendJSON(res, 422, { message: 'chaque item nécessite un nom et au moins un mot-clé' });
    }

    const payload = {
      name,
      keywords,
      lang: String(raw.lang || 'en').slice(0, 2),
      zoom: Number.isFinite(raw.zoom) ? raw.zoom : 15,
      lat: String(raw.lat || ''),
      lon: String(raw.lon || ''),
      fast_mode: !!raw.fast_mode,
      radius: Number.isFinite(raw.radius) ? raw.radius : 10000,
      depth: Number.isFinite(raw.depth) ? raw.depth : 10,
      email: !!raw.email,
      extra_reviews: !!raw.extra_reviews,
      max_time: Number.isFinite(raw.max_time) ? raw.max_time : 1200,
      proxies: Array.isArray(raw.proxies) ? raw.proxies.map((p) => String(p).trim()).filter(Boolean) : [],
    };

    const item = {
      id: crypto.randomUUID(),
      name,
      payload,
      status: 'queued',
      engineJobId: null,
      error: null,
      createdAt: new Date().toISOString(),
    };
    queue.push(item);
    created.push({ id: item.id, name: item.name });
  }

  persistQueue();
  sendJSON(res, 201, { created });
  dispatchTick();
}

async function handleQueueDelete(req, res, id) {
  const idx = queue.findIndex((q) => q.id === id);
  if (idx === -1) return sendJSON(res, 404, { message: 'introuvable' });

  const item = queue[idx];
  if (item.status === 'submitted' && item.engineJobId) {
    try {
      await engineDeleteJob(item.engineJobId);
    } catch (err) {
      console.error('[queue] failed to delete engine job on cancel:', err.message);
    }
  }
  queue.splice(idx, 1);
  persistQueue();
  sendJSON(res, 200, { ok: true });
}

// ---------------------------------------------------------------------------
// generic pass-through proxy for /api/v1/* (engine's own REST API)
// ---------------------------------------------------------------------------

function proxyToScraper(req, res) {
  const options = {
    hostname: SCRAPER_HOST,
    port: SCRAPER_PORT,
    path: req.url,
    method: req.method,
    headers: { ...req.headers, host: `${SCRAPER_HOST}:${SCRAPER_PORT}` },
  };

  const proxyReq = http.request(options, (proxyRes) => {
    res.writeHead(proxyRes.statusCode || 502, proxyRes.headers);
    proxyRes.pipe(res);
  });

  proxyReq.on('error', (err) => {
    console.error('[proxy] scraper engine unreachable:', err.message);
    if (!res.headersSent) {
      res.writeHead(502, { 'Content-Type': 'application/json' });
    }
    res.end(JSON.stringify({ code: 502, message: 'scraper engine unavailable: ' + err.message }));
  });

  req.pipe(proxyReq);
}

// ---------------------------------------------------------------------------
// static files
// ---------------------------------------------------------------------------

function serveStatic(req, res, pathname) {
  const relative = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  const filePath = path.normalize(path.join(PUBLIC_DIR, relative));

  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }

  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Not found');
      return;
    }
    const ext = path.extname(filePath);
    res.writeHead(200, { 'Content-Type': MIME_TYPES[ext] || 'application/octet-stream' });
    res.end(data);
  });
}

// ---------------------------------------------------------------------------
// router
// ---------------------------------------------------------------------------

const server = http.createServer((req, res) => {
  const pathname = (req.url || '/').split('?')[0];

  if (pathname === '/healthz') {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('ok');
    return;
  }

  if (!isAuthorized(req)) {
    requireAuth(res);
    return;
  }

  if (pathname === '/api/queue') {
    if (req.method === 'GET') return void handleQueueList(req, res);
    if (req.method === 'POST') return void handleQueueCreate(req, res);
    return sendJSON(res, 405, { message: 'method not allowed' });
  }

  const queueItemMatch = pathname.match(/^\/api\/queue\/([^/]+)$/);
  if (queueItemMatch) {
    if (req.method === 'DELETE') return void handleQueueDelete(req, res, queueItemMatch[1]);
    return sendJSON(res, 405, { message: 'method not allowed' });
  }

  if (pathname.startsWith('/api/v1/')) {
    proxyToScraper(req, res);
    return;
  }

  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { 'Content-Type': 'text/plain' });
    res.end('Method not allowed');
    return;
  }

  serveStatic(req, res, pathname);
});

server.listen(PORT, () => {
  console.log(`[server] management UI listening on :${PORT}`);
  console.log(`[server] proxying /api/v1/* to http://${SCRAPER_HOST}:${SCRAPER_PORT}`);
});
