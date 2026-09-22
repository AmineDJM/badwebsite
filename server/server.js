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
const QUEUE_FILE = path.join(DATA_FOLDER, 'queue.json');
const DISPATCH_INTERVAL_MS = 3000;
const MAX_ITEMS_PER_REQUEST = 200;

function intEnv(name, fallback, min) {
  const parsed = parseInt(process.env[name], 10);
  return Math.max(min, Number.isNaN(parsed) ? fallback : parsed);
}

const JOB_MAX_ATTEMPTS = intEnv('JOB_MAX_ATTEMPTS', 3, 1);
// Attempt n waits n × this before retrying: a block doesn't clear in seconds.
const RETRY_BASE_DELAY_MS = intEnv('JOB_RETRY_DELAY_MINUTES', 5, 0) * 60_000;
const BLOCK_PAUSE_THRESHOLD = intEnv('BLOCK_PAUSE_THRESHOLD', 3, 1);
const JOB_DELAY_MS = intEnv('JOB_DELAY_SECONDS', 30, 0) * 1000;
// Grace period on top of a job's own max_time before we declare it a zombie.
const ZOMBIE_SLACK_MS = intEnv('ZOMBIE_SLACK_MINUTES', 5, 0) * 60_000;

const PROXY_URL_RE = /^(https?|socks5h?):\/\/(?:[^:@/]+:[^@/]+@)?[^\s:@/]+:\d{1,5}\/?$/i;

// Validates "protocol://[user:pass@]host:port" without ever logging the
// credentials themselves (only the redacted host:port survives in logs).
function validateProxies(list, sourceLabel) {
  const valid = [];
  const invalid = [];
  for (const raw of list) {
    const p = String(raw).trim();
    if (!p) continue;
    if (PROXY_URL_RE.test(p)) {
      valid.push(p);
    } else {
      const redacted = p.replace(/:\/\/[^@]+@/, '://***@');
      invalid.push(redacted);
    }
  }
  if (invalid.length > 0) {
    console.warn(
      `[proxies] ${sourceLabel}: ignoring ${invalid.length} malformed proxy URL(s) (expected ` +
        `protocol://[user:pass@]host:port with http/https/socks5/socks5h): ${invalid.join(', ')}`
    );
  }
  return { valid, invalid };
}

const DEFAULT_PROXIES = validateProxies(
  (process.env.DEFAULT_PROXIES || '').split(/[\n,]/),
  'DEFAULT_PROXIES'
).valid;

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
let breaker = { consecutiveFailures: 0, paused: false, pausedAt: null, pauseReason: null };
let lastFinishedAt = null;
let dispatching = false;

function loadQueue() {
  try {
    const parsed = JSON.parse(fs.readFileSync(QUEUE_FILE, 'utf8'));
    // v1 persisted a bare array; v2 wraps it with the breaker state.
    if (Array.isArray(parsed)) {
      queue = parsed;
    } else {
      queue = parsed.queue || [];
      breaker = { ...breaker, ...(parsed.breaker || {}) };
    }
    console.log(`[queue] loaded ${queue.length} item(s) from ${QUEUE_FILE}`);
    if (breaker.paused) {
      console.warn(`[queue] queue is PAUSED (${breaker.pauseReason}) — resume it from the UI`);
    }
  } catch {
    queue = [];
  }
}

function persistQueue() {
  try {
    fs.mkdirSync(DATA_FOLDER, { recursive: true });
    fs.writeFileSync(QUEUE_FILE, JSON.stringify({ version: 2, queue, breaker }, null, 2));
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
      engineStatus: item.engineStatus || null,
      engineJobId: item.engineJobId,
      resultCount: typeof item.resultCount === 'number' ? item.resultCount : null,
      attempts: item.attempts || 0,
      maxAttempts: JOB_MAX_ATTEMPTS,
      nextAttemptAt: item.nextAttemptAt || null,
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

function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else field += c;
    } else if (c === '"') inQuotes = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
    else if (c !== '\r') field += c;
  }
  if (field.length > 0 || row.length > 0) { row.push(field); rows.push(row); }
  return rows;
}

// The engine extracts fields by indexing fixed positions into an undocumented
// Google JSON array, and returns the zero value on any mismatch — so if Google
// reshuffles that structure, rows keep being written with empty columns and
// nothing errors. A business without a name doesn't exist, so a high blank-title
// ratio is our canary for "Google changed the page".
function analyzeSample(text, truncated) {
  const rows = parseCsv(text);
  if (rows.length < 2) return null;
  const titleIdx = rows[0].indexOf('title');
  if (titleIdx === -1) return null;
  let data = rows.slice(1);
  if (truncated && data.length > 0) data = data.slice(0, -1); // last row may be cut mid-stream
  if (data.length === 0) return null;
  const blank = data.filter((r) => !(r[titleIdx] || '').trim()).length;
  return { blankTitleRatio: blank / data.length, sampleSize: data.length };
}

// The engine reports a job as "ok" even when it scraped nothing at all, so a
// block/consent wall looks identical to a successful run from its API. The
// only trustworthy signal is the result file itself.
// Quote-aware because address/about/hours fields legitimately contain newlines.
const SAMPLE_LIMIT_BYTES = 256 * 1024;

function engineAnalyzeResults(id) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { hostname: SCRAPER_HOST, port: SCRAPER_PORT, path: `/api/v1/jobs/${id}/download`, method: 'GET' },
      (res) => {
        if (res.statusCode !== 200) {
          res.resume();
          resolve({ rows: 0, quality: null }); // no result file at all
          return;
        }
        let rows = 0;
        let inQuotes = false;
        let sawContent = false;
        let endedWithNewline = true;
        const sample = [];
        let sampleBytes = 0;

        res.on('data', (chunk) => {
          if (chunk.length > 0) sawContent = true;
          if (sampleBytes < SAMPLE_LIMIT_BYTES) {
            sample.push(chunk);
            sampleBytes += chunk.length;
          }
          for (let i = 0; i < chunk.length; i++) {
            const b = chunk[i];
            // Toggling on every quote also handles "" escapes: it flips twice.
            if (b === 0x22) inQuotes = !inQuotes;
            else if (b === 0x0a && !inQuotes) rows++;
          }
          endedWithNewline = chunk[chunk.length - 1] === 0x0a;
        });
        res.on('end', () => {
          if (sawContent && !endedWithNewline) rows++;
          const total = Math.max(0, rows - 1); // minus the header row
          let quality = null;
          if (total > 0) {
            try {
              quality = analyzeSample(Buffer.concat(sample).toString('utf8'), sampleBytes >= SAMPLE_LIMIT_BYTES);
            } catch {
              quality = null;
            }
          }
          resolve({ rows: total, quality });
        });
        res.on('error', reject);
      }
    );
    req.on('error', reject);
    req.end();
  });
}

function registerSuccess() {
  breaker.consecutiveFailures = 0;
}

function forcePause(reason) {
  if (breaker.paused) return;
  breaker.paused = true;
  breaker.pausedAt = new Date().toISOString();
  breaker.pauseReason = reason;
  console.error(`[breaker] QUEUE PAUSED: ${reason}`);
}

function registerFailure(label) {
  breaker.consecutiveFailures += 1;
  console.warn(`[breaker] failure ${breaker.consecutiveFailures}/${BLOCK_PAUSE_THRESHOLD} (${label})`);
  if (breaker.consecutiveFailures >= BLOCK_PAUSE_THRESHOLD) {
    forcePause(
      `${breaker.consecutiveFailures} jobs consécutifs sans résultat exploitable — ` +
        `blocage Google probable (proxy épuisé/absent). File mise en pause pour ne pas ` +
        `brûler le reste de vos recherches pour rien.`
    );
  }
}

function scheduleRetryOrFail(item, reason) {
  registerFailure(reason);

  if ((item.attempts || 0) < JOB_MAX_ATTEMPTS) {
    // The attempt produced nothing useful; drop its engine job so the Jobs
    // list doesn't fill up with empty CSVs.
    if (item.engineJobId) {
      engineDeleteJob(item.engineJobId).catch(() => {});
    }
    const delayMs = item.attempts * RETRY_BASE_DELAY_MS;
    item.status = 'queued';
    item.engineJobId = null;
    item.engineStatus = null;
    item.nextAttemptAt = new Date(Date.now() + delayMs).toISOString();
    item.error = `${reason} — nouvelle tentative (${item.attempts + 1}/${JOB_MAX_ATTEMPTS}) dans ${Math.round(delayMs / 60000)} min`;
    console.warn(`[queue] "${item.name}": ${item.error}`);
  } else {
    // Keep the last engine job around so its (possibly partial) CSV stays
    // downloadable for inspection.
    item.status = 'failed';
    item.nextAttemptAt = null;
    item.error = `${reason} — abandon après ${item.attempts} tentative(s)`;
    console.error(`[queue] "${item.name}": ${item.error}`);
  }
}

// The engine leaves a job stuck in "working" forever on several error paths
// (seed-job creation failure, or a scrapemate start failure — it updates the
// record without ever changing the status). Since we dispatch strictly one job
// at a time, a single zombie would deadlock the whole queue, so we time it out
// ourselves.
function isZombie(item) {
  if (!item.submittedAt) return false;
  const maxTimeMs = (item.payload.max_time || 1200) * 1000;
  return Date.now() - Date.parse(item.submittedAt) > maxTimeMs + ZOMBIE_SLACK_MS;
}

async function resolveCurrent(item) {
  let job;
  try {
    job = await engineGetJob(item.engineJobId);
  } catch (err) {
    console.error('[queue] error polling engine job', item.engineJobId, err.message);
    return; // transient; try again next tick
  }

  if (!job) {
    item.status = 'failed';
    item.error = 'le job a disparu côté moteur (supprimé ?)';
    lastFinishedAt = Date.now();
    persistQueue();
    return;
  }

  item.engineStatus = job.Status;
  if (job.Status !== 'ok' && job.Status !== 'failed') {
    if (isZombie(item)) {
      lastFinishedAt = Date.now();
      scheduleRetryOrFail(item, 'le moteur ne répond plus sur ce job (dépassement du temps imparti)');
      persistQueue();
      return;
    }
    persistQueue();
    return; // still pending/working
  }

  let count = null;
  let quality = null;
  try {
    ({ rows: count, quality } = await engineAnalyzeResults(item.engineJobId));
  } catch (err) {
    console.error('[queue] could not read results for', item.engineJobId, err.message);
  }
  item.resultCount = count;
  lastFinishedAt = Date.now();

  const engineFailed = job.Status === 'failed';
  const emptyResult = count === 0; // null = couldn't verify, give it the benefit of the doubt
  const layoutBroken = quality && quality.sampleSize >= 5 && quality.blankTitleRatio > 0.5;

  if (layoutBroken) {
    // Retrying cannot fix an extraction mismatch, so fail fast and stop the
    // queue rather than filling CSVs with blank rows.
    item.status = 'failed';
    item.nextAttemptAt = null;
    item.error = `données illisibles : ${Math.round(quality.blankTitleRatio * 100)}% des lignes sans nom d'établissement`;
    forcePause(
      `Les résultats reviennent vides de leur contenu (${Math.round(quality.blankTitleRatio * 100)}% des lignes sans nom). ` +
        `Google a probablement modifié la structure de ses pages : le moteur de scraping doit être mis à jour ` +
        `(nouvelle version de gosom/google-maps-scraper). File mise en pause.`
    );
  } else if (!engineFailed && !emptyResult) {
    item.status = 'ok';
    item.error = null;
    item.nextAttemptAt = null;
    registerSuccess();
    console.log(`[queue] "${item.name}" finished with ${count === null ? '?' : count} result(s)`);
  } else {
    scheduleRetryOrFail(
      item,
      engineFailed ? 'le moteur a signalé un échec' : 'aucun résultat (blocage ou requête sans réponse)'
    );
  }
  persistQueue();
}

async function submitNext(item) {
  const payload = { ...item.payload };
  if ((!payload.proxies || payload.proxies.length === 0) && DEFAULT_PROXIES.length > 0) {
    payload.proxies = DEFAULT_PROXIES;
  }

  item.attempts = (item.attempts || 0) + 1;
  try {
    const id = await engineCreateJob(payload);
    item.status = 'submitted';
    item.engineJobId = id;
    item.engineStatus = 'pending';
    item.submittedAt = new Date().toISOString();
    item.nextAttemptAt = null;
    item.error = null;
    console.log(`[queue] dispatched "${item.name}" (attempt ${item.attempts}/${JOB_MAX_ATTEMPTS}) -> engine job ${id}`);
  } catch (err) {
    // The engine rejected the job outright (bad payload, engine down): that's
    // not a scraping block, so don't count it toward the circuit breaker.
    item.status = 'failed';
    item.error = `refusé par le moteur : ${err.message}`;
    console.error(`[queue] failed to dispatch "${item.name}":`, err.message);
  }
  persistQueue();
}

async function dispatchTick() {
  if (dispatching) return;
  dispatching = true;
  try {
    const current = queue.find((q) => q.status === 'submitted');
    if (current) {
      await resolveCurrent(current);
      return;
    }

    if (breaker.paused) return;

    // Breathing room between jobs: back-to-back hammering is what gets an IP
    // flagged in the first place.
    if (lastFinishedAt && Date.now() - lastFinishedAt < JOB_DELAY_MS) return;

    const now = Date.now();
    const next = queue.find(
      (q) => q.status === 'queued' && (!q.nextAttemptAt || Date.parse(q.nextAttemptAt) <= now)
    );
    if (!next) return;

    await submitNext(next);
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
  sendJSON(res, 200, {
    items: publicQueueView(),
    breaker: {
      paused: breaker.paused,
      pausedAt: breaker.pausedAt,
      reason: breaker.pauseReason,
      consecutiveFailures: breaker.consecutiveFailures,
      threshold: BLOCK_PAUSE_THRESHOLD,
    },
    config: {
      maxAttempts: JOB_MAX_ATTEMPTS,
      jobDelaySeconds: JOB_DELAY_MS / 1000,
      proxiesConfigured: DEFAULT_PROXIES.length,
    },
  });
}

async function handleQueueResume(req, res) {
  breaker.paused = false;
  breaker.pausedAt = null;
  breaker.pauseReason = null;
  breaker.consecutiveFailures = 0;
  persistQueue();
  console.log('[breaker] queue resumed manually');
  sendJSON(res, 200, { ok: true });
  dispatchTick();
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
  let droppedProxyCount = 0;
  for (const raw of items) {
    const name = String(raw.name || '').trim();
    const keywords = Array.isArray(raw.keywords) ? raw.keywords.map((k) => String(k).trim()).filter(Boolean) : [];
    if (!name || keywords.length === 0) {
      return sendJSON(res, 422, { message: 'chaque item nécessite un nom et au moins un mot-clé' });
    }

    const rawProxies = Array.isArray(raw.proxies) ? raw.proxies : [];
    const { valid: proxies, invalid: invalidProxies } = validateProxies(rawProxies, `job "${name}"`);
    droppedProxyCount += invalidProxies.length;

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
      proxies,
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
  sendJSON(res, 201, {
    created,
    ...(droppedProxyCount > 0
      ? { warning: `${droppedProxyCount} proxy URL(s) ignorée(s) car mal formée(s) (attendu: protocole://user:pass@host:port)` }
      : {}),
  });
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

  if (pathname === '/api/queue/resume') {
    if (req.method === 'POST') return void handleQueueResume(req, res);
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
