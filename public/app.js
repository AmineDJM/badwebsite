'use strict';

const API_BASE = '/api/v1/jobs';
const QUEUE_BASE = '/api/queue';
const POLL_MS = 4000;
const PREVIEW_ROWS = 50;
const HIGHLIGHT_COLS = new Set(['website', 'emails', 'phone']);

let mode = 'single'; // 'single' | 'batch'

// ---------- mode toggle ----------

const modeSingleBtn = document.getElementById('mode-single');
const modeBatchBtn = document.getElementById('mode-batch');
const keywordsLabel = document.getElementById('keywords-label');
const keywordsHint = document.getElementById('keywords-hint');
const keywordsInput = document.getElementById('keywords');

function setMode(next) {
  mode = next;
  modeSingleBtn.classList.toggle('active', mode === 'single');
  modeBatchBtn.classList.toggle('active', mode === 'batch');
  if (mode === 'single') {
    keywordsLabel.textContent = 'Recherches (une par ligne)';
    keywordsHint.innerHTML = 'Chaque ligne est une requête Google Maps dans <strong>ce même job</strong>.';
    keywordsInput.placeholder = 'restaurants paris\ncoiffeurs lyon\nplombiers marseille';
  } else {
    keywordsLabel.textContent = 'Recherches (une par ligne = un scraper)';
    keywordsHint.innerHTML = 'Chaque ligne devient <strong>son propre job</strong>, mis en file d\'attente et lancé automatiquement, <strong>dans l\'ordre indiqué</strong>, un seul à la fois.';
    keywordsInput.placeholder = 'restaurants paris\ncoiffeurs lyon\nplombiers marseille';
  }
}
modeSingleBtn.addEventListener('click', () => setMode('single'));
modeBatchBtn.addEventListener('click', () => setMode('batch'));

// ---------- form submit ----------

const form = document.getElementById('job-form');
const submitBtn = document.getElementById('submit-btn');
const statusLog = document.getElementById('status-log');

function logLine(text, cls) {
  const div = document.createElement('div');
  if (cls) div.className = cls;
  div.textContent = text;
  statusLog.prepend(div);
}

function buildBaseJobData() {
  const depth = parseInt(document.getElementById('depth').value, 10) || 10;
  const zoom = parseInt(document.getElementById('zoom').value, 10) || 15;
  const radius = parseInt(document.getElementById('radius').value, 10) || 10000;
  const maxtimeMin = parseFloat(document.getElementById('maxtime').value) || 20;
  const lat = document.getElementById('lat').value.trim();
  const lon = document.getElementById('lon').value.trim();
  const fastMode = document.getElementById('fast_mode').checked;
  const proxies = document
    .getElementById('proxies')
    .value.split('\n')
    .map((p) => p.trim())
    .filter(Boolean);

  return {
    lang: document.getElementById('lang').value,
    zoom,
    lat,
    lon,
    fast_mode: fastMode,
    radius,
    depth,
    email: document.getElementById('email').checked,
    extra_reviews: document.getElementById('extra_reviews').checked,
    max_time: Math.max(1, Math.round(maxtimeMin * 60)),
    proxies,
  };
}

async function submitQueueItems(items) {
  const res = await fetch(QUEUE_BASE, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ items }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(body.message || `HTTP ${res.status}`);
  }
  return body; // { created: [{id, name}, ...] }
}

form.addEventListener('submit', async (ev) => {
  ev.preventDefault();

  const name = document.getElementById('name').value.trim();
  const lines = keywordsInput.value
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);

  if (!name) return logLine('✗ nom du job manquant', 'err');
  if (lines.length === 0) return logLine('✗ aucune recherche saisie', 'err');

  const base = buildBaseJobData();
  if (base.fast_mode && (!base.lat || !base.lon)) {
    return logLine('✗ le mode rapide nécessite une latitude et une longitude', 'err');
  }
  if (!base.lang || base.lang.length !== 2) {
    return logLine('✗ code langue invalide (2 lettres attendues)', 'err');
  }

  submitBtn.disabled = true;
  statusLog.innerHTML = '';

  try {
    let items;
    if (mode === 'single') {
      items = [{ name, keywords: lines, ...base }];
      logLine(`→ mise en file d'attente du job "${name}" (${lines.length} recherche${lines.length > 1 ? 's' : ''})…`);
    } else {
      items = lines.map((line) => ({ name: `${name} — ${line}`, keywords: [line], ...base }));
      logLine(`→ mise en file d'attente de ${lines.length} jobs, dans cet ordre…`);
    }

    const result = await submitQueueItems(items);
    (result.created || []).forEach((c, i) => logLine(`✓ (${i + 1}/${items.length}) en file: ${c.name}`, 'ok'));
    if (result.warning) logLine(`⚠ ${result.warning}`, 'err');
    logLine("terminé — les jobs s'exécuteront automatiquement un par un, dans l'ordre.", 'ok');

    refresh();
  } catch (err) {
    logLine(`✗ ${err.message}`, 'err');
  } finally {
    submitBtn.disabled = false;
  }
});

// ---------- jobs list (queue items + any job created outside the queue) ----------

const jobsContainer = document.getElementById('jobs-container');
const alertContainer = document.getElementById('alert-container');

function escapeHtml(str) {
  return String(str ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

function fmtDate(iso) {
  try {
    return new Date(iso).toLocaleString('fr-FR');
  } catch {
    return iso;
  }
}

function minutesUntil(iso) {
  const ms = Date.parse(iso) - Date.now();
  return ms <= 0 ? 0 : Math.ceil(ms / 60000);
}

// Maps a queue item onto a badge. The engine reports "ok" even when it
// scraped nothing, so the server re-checks the result file — that's why a
// job can be retried despite the engine calling it a success.
function queueItemStatus(item) {
  if (item.status === 'queued') {
    if (item.nextAttemptAt && minutesUntil(item.nextAttemptAt) > 0) {
      return { cls: 'retry', label: `reprise dans ${minutesUntil(item.nextAttemptAt)} min` };
    }
    return { cls: 'pending', label: `en attente${item.queuePosition ? ` · ${item.queuePosition}` : ''}` };
  }
  if (item.status === 'submitted') {
    return { cls: 'working', label: item.engineStatus === 'working' ? 'en cours' : 'démarrage' };
  }
  if (item.status === 'ok') return { cls: 'ok', label: 'terminé' };
  return { cls: 'failed', label: 'échoué' };
}

function rowHtml({ name, badge, results, attempts, keywords, date, actions, note }) {
  const kwPreview = keywords.slice(0, 2).join(', ') + (keywords.length > 2 ? ` +${keywords.length - 2}` : '');
  return `<tr>
    <td>
      ${escapeHtml(name)}
      ${note ? `<div class="row-note">${escapeHtml(note)}</div>` : ''}
    </td>
    <td><span class="badge ${badge.cls}">${escapeHtml(badge.label)}</span>${attempts ? `<span class="attempts">${escapeHtml(attempts)}</span>` : ''}</td>
    <td>${results}</td>
    <td title="${escapeHtml(keywords.join(', '))}">${escapeHtml(kwPreview) || '—'}</td>
    <td>${fmtDate(date)}</td>
    <td class="actions">${actions}</td>
  </tr>`;
}

function renderAlert(breaker) {
  if (!breaker || !breaker.paused) {
    alertContainer.innerHTML = '';
    return;
  }
  alertContainer.innerHTML = `<div class="alert">
    <div>
      <strong>File en pause — blocage probable</strong>
      <div>${escapeHtml(breaker.reason || '')}</div>
      <div class="alert-hint">Vérifiez/ajoutez un proxy (voir README), puis reprenez la file.</div>
    </div>
    <button id="resume-btn">Reprendre la file</button>
  </div>`;
}

function renderAll(queueItems, engineJobs) {
  const tracked = new Set(queueItems.map((it) => it.engineJobId).filter(Boolean));
  const rows = [];

  for (const item of queueItems) {
    const badge = queueItemStatus(item);
    const actions = [];
    const hasData = item.engineJobId && item.resultCount !== 0;
    if (item.engineJobId && (item.status === 'ok' || item.status === 'failed') && hasData) {
      actions.push(`<button data-action="preview" data-src="queue" data-engine-id="${item.engineJobId}" data-name="${escapeHtml(item.name)}">Aperçu</button>`);
      actions.push(`<a href="${API_BASE}/${item.engineJobId}/download" download>Télécharger</a>`);
    }
    actions.push(`<button class="danger" data-action="delete" data-src="queue" data-id="${item.id}" data-name="${escapeHtml(item.name)}">Supprimer</button>`);

    rows.push({
      sortKey: item.createdAt,
      html: rowHtml({
        name: item.name,
        badge,
        results: item.resultCount === null || item.resultCount === undefined ? '—' : `<strong>${item.resultCount}</strong>`,
        attempts: item.attempts > 1 ? `essai ${item.attempts}/${item.maxAttempts}` : '',
        keywords: item.keywords || [],
        date: item.createdAt,
        actions: actions.join(''),
        note: item.error || '',
      }),
    });
  }

  for (const job of engineJobs) {
    if (tracked.has(job.ID)) continue; // already shown as a queue item
    const actions = [];
    if (job.Status === 'ok') {
      actions.push(`<button data-action="preview" data-src="engine" data-engine-id="${job.ID}" data-name="${escapeHtml(job.Name)}">Aperçu</button>`);
      actions.push(`<a href="${API_BASE}/${job.ID}/download" download>Télécharger</a>`);
    }
    actions.push(`<button class="danger" data-action="delete" data-src="engine" data-id="${job.ID}" data-name="${escapeHtml(job.Name)}">Supprimer</button>`);

    rows.push({
      sortKey: job.Date,
      html: rowHtml({
        name: job.Name,
        badge: { cls: job.Status === 'ok' ? 'ok' : job.Status === 'failed' ? 'failed' : 'working', label: job.Status },
        results: '—',
        attempts: '',
        keywords: (job.Data && job.Data.keywords) || [],
        date: job.Date,
        actions: actions.join(''),
        note: 'créé hors file',
      }),
    });
  }

  if (rows.length === 0) {
    jobsContainer.innerHTML = '<div class="empty">Aucun job pour le moment — lancez-en un à gauche.</div>';
    return;
  }

  rows.sort((a, b) => new Date(b.sortKey) - new Date(a.sortKey));

  jobsContainer.innerHTML = `
    <table class="jobs">
      <thead>
        <tr><th>Nom</th><th>Statut</th><th>Résultats</th><th>Recherches</th><th>Créé</th><th>Actions</th></tr>
      </thead>
      <tbody>${rows.map((r) => r.html).join('')}</tbody>
    </table>`;
}

const proxyState = document.getElementById('proxy-state');
const proxyBar = document.getElementById('proxy-bar');
const proxyTestBtn = document.getElementById('proxy-test-btn');

// A test result is more informative than the generic state, so the 4s poll
// leaves it on screen for a while instead of immediately overwriting it.
let proxyResultHoldUntil = 0;

function renderProxyState(config) {
  if (!config || Date.now() < proxyResultHoldUntil) return;
  const n = config.proxiesConfigured;

  if (n === 0) {
    proxyBar.className = 'proxy-bar warn';
    proxyState.innerHTML =
      "<strong>Aucun proxy configuré</strong> — Google servira des pages vides. Ajoutez <code>DEFAULT_PROXIES</code> dans Render.";
    return;
  }

  const bits = [`${n} proxy${n > 1 ? 'ies' : ''} configuré${n > 1 ? 's' : ''}`];
  if (config.sessionRotation) bits.push('rotation par job active');
  if (config.proxyListError) bits.push(`⚠ ${config.proxyListError}`);
  if (config.bothProxySourcesSet) {
    proxyBar.className = 'proxy-bar warn';
    bits.push('⚠ DEFAULT_PROXIES et PROXY_LIST_URL sont tous les deux actifs — vos jobs alterneront entre les deux');
  } else {
    proxyBar.className = 'proxy-bar ok';
  }
  proxyState.textContent = 'Proxy : ' + bits.join(' · ');
}

proxyTestBtn.addEventListener('click', async () => {
  proxyTestBtn.disabled = true;
  proxyResultHoldUntil = Date.now() + 60_000;
  proxyState.textContent = 'Test en cours… (jusqu’à 20 s)';
  try {
    const res = await fetch('/api/proxy/test', { method: 'POST' });
    const data = await res.json();
    proxyBar.className = 'proxy-bar ' + (data.ok ? 'ok' : 'warn');
    proxyState.textContent = (data.ok ? '✓ ' : '✗ ') + data.message;
  } catch (err) {
    proxyBar.className = 'proxy-bar warn';
    proxyState.textContent = `✗ test impossible : ${err.message}`;
  } finally {
    proxyTestBtn.disabled = false;
  }
});

async function refresh() {
  let queueItems = [];
  let engineJobs = [];

  try {
    const res = await fetch(QUEUE_BASE);
    if (res.status === 401) return; // browser will show the basic-auth prompt
    const data = await res.json();
    queueItems = data.items || [];
    renderAlert(data.breaker);
    renderProxyState(data.config);
  } catch (err) {
    jobsContainer.innerHTML = `<div class="empty">Impossible de contacter le serveur (${escapeHtml(err.message)})</div>`;
    return;
  }

  try {
    const res = await fetch(API_BASE);
    if (res.ok) {
      const jobs = await res.json();
      engineJobs = Array.isArray(jobs) ? jobs : [];
    }
  } catch {
    // the engine list is only used for jobs created outside the queue
  }

  renderAll(queueItems, engineJobs);
}

jobsContainer.addEventListener('click', async (ev) => {
  const btn = ev.target.closest('button[data-action]');
  if (!btn) return;
  const { action, src, id, name } = btn.dataset;

  if (action === 'delete') {
    if (!confirm(`Supprimer le job "${name}" et ses résultats ?`)) return;
    const url = src === 'queue' ? `${QUEUE_BASE}/${id}` : `${API_BASE}/${id}`;
    await fetch(url, { method: 'DELETE' });
    refresh();
  } else if (action === 'preview') {
    openPreview(btn.dataset.engineId, name);
  }
});

alertContainer.addEventListener('click', async (ev) => {
  if (!ev.target.closest('#resume-btn')) return;
  await fetch(`${QUEUE_BASE}/resume`, { method: 'POST' });
  refresh();
});

// ---------- CSV preview modal ----------

const modalBackdrop = document.getElementById('modal-backdrop');
const modalTitle = document.getElementById('modal-title');
const modalBody = document.getElementById('modal-body');
document.getElementById('modal-close').addEventListener('click', closePreview);
modalBackdrop.addEventListener('click', (ev) => {
  if (ev.target === modalBackdrop) closePreview();
});

function closePreview() {
  modalBackdrop.classList.remove('open');
  modalBody.innerHTML = '';
}

function parseCSV(text) {
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
      } else {
        field += c;
      }
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ',') {
      row.push(field);
      field = '';
    } else if (c === '\r') {
      // skip
    } else if (c === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else {
      field += c;
    }
  }
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => r.length > 1 || (r.length === 1 && r[0] !== ''));
}

async function openPreview(id, name) {
  modalTitle.textContent = `Aperçu — ${name}`;
  modalBody.innerHTML = '<div class="empty">Chargement du CSV…</div>';
  modalBackdrop.classList.add('open');

  try {
    const res = await fetch(`${API_BASE}/${id}/download`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const text = await res.text();
    const rows = parseCSV(text);

    if (rows.length === 0) {
      modalBody.innerHTML = '<div class="empty">Fichier vide.</div>';
      return;
    }

    const header = rows[0];
    const dataRows = rows.slice(1, 1 + PREVIEW_ROWS);
    const highlightIdx = header.map((h) => HIGHLIGHT_COLS.has(h.trim().toLowerCase()));

    const theadHtml = `<tr>${header.map((h) => `<th>${escapeHtml(h)}</th>`).join('')}</tr>`;
    const tbodyHtml = dataRows
      .map(
        (r) =>
          `<tr>${r
            .map((cell, i) => `<td class="${highlightIdx[i] ? 'hl' : ''}" title="${escapeHtml(cell)}">${escapeHtml(cell)}</td>`)
            .join('')}</tr>`
      )
      .join('');

    const note =
      rows.length - 1 > PREVIEW_ROWS
        ? `<p class="hint">Aperçu limité aux ${PREVIEW_ROWS} premières lignes sur ${rows.length - 1}. <a href="${API_BASE}/${id}/download" download>Télécharger le CSV complet</a>.</p>`
        : `<p class="hint">${rows.length - 1} résultat(s). <a href="${API_BASE}/${id}/download" download>Télécharger le CSV</a>.</p>`;

    modalBody.innerHTML = `${note}<table class="preview"><thead>${theadHtml}</thead><tbody>${tbodyHtml}</tbody></table>`;
  } catch (err) {
    modalBody.innerHTML = `<div class="empty">Erreur de chargement (${escapeHtml(err.message)})</div>`;
  }
}

// ---------- boot ----------

setMode('single');
refresh();
setInterval(refresh, POLL_MS);
