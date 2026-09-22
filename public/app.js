'use strict';

const API_BASE = '/api/v1/jobs';
const QUEUE_BASE = '/api/queue';
const POLL_MS = 4000;
const PREVIEW_ROWS = 50;
const HIGHLIGHT_COLS = new Set(['website', 'emails', 'phone']);

let mode = 'single'; // 'single' | 'batch'
let jobsCache = [];
let pollTimer = null;

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

    fetchQueue();
    fetchJobs();
  } catch (err) {
    logLine(`✗ ${err.message}`, 'err');
  } finally {
    submitBtn.disabled = false;
  }
});

// ---------- jobs list ----------

const jobsContainer = document.getElementById('jobs-container');

function statusLabel(status) {
  const map = { pending: 'en attente', working: 'en cours', ok: 'terminé', failed: 'échoué' };
  return map[status] || status;
}

function fmtDate(iso) {
  try {
    return new Date(iso).toLocaleString('fr-FR');
  } catch {
    return iso;
  }
}

function renderJobs(jobs) {
  if (!jobs || jobs.length === 0) {
    jobsContainer.innerHTML = '<div class="empty">Aucun job pour le moment — lancez-en un à gauche.</div>';
    return;
  }

  const sorted = [...jobs].sort((a, b) => new Date(b.Date) - new Date(a.Date));

  const rows = sorted
    .map((job) => {
      const kws = job.Data && job.Data.keywords ? job.Data.keywords : [];
      const kwPreview = kws.slice(0, 2).join(', ') + (kws.length > 2 ? ` +${kws.length - 2}` : '');
      const status = job.Status;
      const actions = [];

      if (status === 'ok') {
        actions.push(`<button data-action="preview" data-id="${job.ID}" data-name="${escapeHtml(job.Name)}">Aperçu</button>`);
        actions.push(`<a href="${API_BASE}/${job.ID}/download" download>Télécharger</a>`);
      }
      actions.push(`<button class="danger" data-action="delete" data-id="${job.ID}" data-name="${escapeHtml(job.Name)}">Supprimer</button>`);

      return `<tr>
        <td>${escapeHtml(job.Name)}</td>
        <td><span class="badge ${status}">${statusLabel(status)}</span></td>
        <td title="${escapeHtml(kws.join(', '))}">${escapeHtml(kwPreview) || '—'}</td>
        <td>${fmtDate(job.Date)}</td>
        <td class="actions">${actions.join('')}</td>
      </tr>`;
    })
    .join('');

  jobsContainer.innerHTML = `
    <table class="jobs">
      <thead>
        <tr><th>Nom</th><th>Statut</th><th>Recherches</th><th>Créé</th><th>Actions</th></tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>`;
}

function escapeHtml(str) {
  return String(str ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

async function fetchJobs() {
  try {
    const res = await fetch(API_BASE);
    if (res.status === 401) return; // browser will show the basic-auth prompt
    const jobs = await res.json();
    jobsCache = Array.isArray(jobs) ? jobs : [];
    renderJobs(jobsCache);
  } catch (err) {
    jobsContainer.innerHTML = `<div class="empty">Impossible de contacter le serveur (${escapeHtml(err.message)})</div>`;
  }
}

jobsContainer.addEventListener('click', async (ev) => {
  const btn = ev.target.closest('button[data-action]');
  if (!btn) return;
  const { action, id, name } = btn.dataset;

  if (action === 'delete') {
    if (!confirm(`Supprimer le job "${name}" et ses résultats ?`)) return;
    await fetch(`${API_BASE}/${id}`, { method: 'DELETE' });
    fetchJobs();
  } else if (action === 'preview') {
    openPreview(id, name);
  }
});

// ---------- waiting queue (not yet submitted to the engine) ----------

const queuePanel = document.getElementById('queue-panel');
const queueContainer = document.getElementById('queue-container');

function renderQueue(items) {
  const waiting = (items || []).filter((it) => it.status === 'queued');

  if (waiting.length === 0) {
    queuePanel.style.display = 'none';
    return;
  }
  queuePanel.style.display = '';

  const rows = waiting
    .map(
      (it) => `<div class="queue-row">
        <span class="pos">${it.queuePosition}</span>
        <span class="name">${escapeHtml(it.name)}</span>
        <span class="kw">${escapeHtml((it.keywords || []).join(', '))}</span>
        <button data-queue-action="cancel" data-id="${it.id}">Retirer</button>
      </div>`
    )
    .join('');

  queueContainer.innerHTML = `<div class="queue-list">${rows}</div>`;
}

async function fetchQueue() {
  try {
    const res = await fetch(QUEUE_BASE);
    if (res.status === 401) return;
    const items = await res.json();
    renderQueue(Array.isArray(items) ? items : []);
  } catch {
    // silently ignore — the main jobs panel already surfaces connectivity errors
  }
}

queueContainer.addEventListener('click', async (ev) => {
  const btn = ev.target.closest('button[data-queue-action="cancel"]');
  if (!btn) return;
  await fetch(`${QUEUE_BASE}/${btn.dataset.id}`, { method: 'DELETE' });
  fetchQueue();
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
fetchJobs();
fetchQueue();
pollTimer = setInterval(() => {
  fetchJobs();
  fetchQueue();
}, POLL_MS);
