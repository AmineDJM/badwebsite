'use strict';

// Management UI server: serves the static frontend (../public) and reverse
// proxies /api/* to the gosom/google-maps-scraper engine, which runs
// internally on 127.0.0.1 and is never exposed directly.
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

function safeEqual(a, b) {
  const bufA = Buffer.from(String(a));
  const bufB = Buffer.from(String(b));
  if (bufA.length !== bufB.length) {
    // still run timingSafeEqual against equal-length buffers to avoid a
    // length-based timing signal short-circuiting earlier than the compare.
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

  if (pathname.startsWith('/api/')) {
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
  console.log(`[server] proxying /api/* to http://${SCRAPER_HOST}:${SCRAPER_PORT}`);
});
