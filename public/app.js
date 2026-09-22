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
modeSingleBtn.addEventListener('click', () => { setMode('single'); renderEstimate(); });
modeBatchBtn.addEventListener('click', () => { setMode('batch'); renderEstimate(); });

// ---------- city picker (fills lat/lon, which the economical mode requires) ----------

// Static table: no geocoding API to pay for or depend on.
const CITIES = [
  ['Paris', '48.8566', '2.3522'], ['Marseille', '43.2965', '5.3698'],
  ['Lyon', '45.7640', '4.8357'], ['Toulouse', '43.6047', '1.4442'],
  ['Nice', '43.7102', '7.2620'], ['Nantes', '47.2184', '-1.5536'],
  ['Montpellier', '43.6108', '3.8767'], ['Strasbourg', '48.5734', '7.7521'],
  ['Bordeaux', '44.8378', '-0.5792'], ['Lille', '50.6292', '3.0573'],
  ['Rennes', '48.1173', '-1.6778'], ['Reims', '49.2583', '4.0317'],
  ['Toulon', '43.1242', '5.9280'], ['Saint-Étienne', '45.4397', '4.3872'],
  ['Le Havre', '49.4944', '0.1079'], ['Grenoble', '45.1885', '5.7245'],
  ['Dijon', '47.3220', '5.0415'], ['Angers', '47.4784', '-0.5632'],
  ['Nîmes', '43.8367', '4.3601'], ['Clermont-Ferrand', '45.7772', '3.0870'],
  ['Aix-en-Provence', '43.5297', '5.4474'], ['Tours', '47.3941', '0.6848'],
  ['Brest', '48.3904', '-4.4861'], ['Limoges', '45.8336', '1.2611'],
  ['Amiens', '49.8941', '2.2958'], ['Perpignan', '42.6887', '2.8948'],
  ['Metz', '49.1193', '6.1757'], ['Besançon', '47.2378', '6.0241'],
  ['Caen', '49.1829', '-0.3707'], ['Orléans', '47.9029', '1.9093'],
  ['Rouen', '49.4432', '1.0999'], ['Nancy', '48.6921', '6.1844'],
  ['Bruxelles', '50.8503', '4.3517'], ['Genève', '46.2044', '6.1432'],
];

const citySelect = document.getElementById('city');
const latInput = document.getElementById('lat');
const lonInput = document.getElementById('lon');

for (const [name, lat, lon] of CITIES) {
  const opt = document.createElement('option');
  opt.value = `${lat},${lon}`;
  opt.textContent = name;
  citySelect.appendChild(opt);
}

citySelect.addEventListener('change', () => {
  if (!citySelect.value) return;
  const [lat, lon] = citySelect.value.split(',');
  latInput.value = lat;
  lonInput.value = lon;
});

// Typing coordinates by hand should not keep showing a city that no longer matches.
for (const input of [latInput, lonInput]) {
  input.addEventListener('input', () => {
    if (citySelect.value && citySelect.value !== `${latInput.value},${lonInput.value}`) {
      citySelect.value = '';
    }
  });
}

// ---------- geographic grid ----------

const coverageSelect = document.getElementById('coverage');
const spacingInput = document.getElementById('spacing');
const estimateBox = document.getElementById('estimate');

function plannedJobCount() {
  const lines = keywordsInput.value.split('\n').map((l) => l.trim()).filter(Boolean).length;
  const tuning = { rapide: 5, normale: 21, maximale: 85 }[coverageSelect.value] || 21;
  const searches = mode === 'single' ? 1 : Math.max(lines, 1);
  return { maxJobs: searches * tuning, searches, lines };
}

function renderEstimate() {
  const { maxJobs, lines } = plannedJobCount();
  if (!lines) {
    estimateBox.textContent = '';
    return;
  }
  if (!latInput.value || !lonInput.value) {
    estimateBox.textContent = "Choisissez une zone de recherche pour activer l'exploration adaptative.";
    return;
  }
  const minutes = Math.round((maxJobs * 2.5) / 5) * 5;
  const duration = minutes >= 60 ? `~${(minutes / 60).toFixed(1)} h` : `~${minutes} min`;
  estimateBox.textContent =
    `Jusqu'à ${maxJobs} recherche${maxJobs > 1 ? 's' : ''} (${duration} au maximum) — ` +
    `le scraper s'arrêtera avant si la zone est couverte.`;
}

for (const el of [coverageSelect, spacingInput, keywordsInput, citySelect]) {
  el.addEventListener('input', renderEstimate);
  el.addEventListener('change', renderEstimate);
}

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
    return logLine('✗ le mode économique a besoin d\'un point de départ : choisissez une zone de recherche', 'err');
  }
  // Without coordinates the engine builds an unanchored Google Maps URL, which
  // returns a scattered handful of results worldwide. Allowed, but never silent.
  if (!base.fast_mode && (!base.lat || !base.lon)) {
    logLine('⚠ aucune zone de recherche : Google renverra peu de résultats, dispersés géographiquement', 'err');
  }
  if (!base.lang || base.lang.length !== 2) {
    return logLine('✗ code langue invalide (2 lettres attendues)', 'err');
  }

  submitBtn.disabled = true;
  statusLog.innerHTML = '';

  try {
    const searches = mode === 'single'
      ? [{ keywords: lines }]
      : lines.map((l) => ({ keywords: [l] }));

    // With a zone, the server explores adaptively and decides how many
    // searches are actually worth running; without one it can only do the
    // single unanchored search the user asked for.
    if (base.lat && base.lon) {
      const res = await fetch('/api/campaign', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ label: name, searches, base, intensity: coverageSelect.value, spacingKm: parseFloat(spacingInput.value) || 8 }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.message || `HTTP ${res.status}`);
      (body.created || []).forEach((c) => logLine(`✓ exploration lancée : ${c.label} (jusqu'à ${c.maxJobs} recherches)`, 'ok'));
      logLine("le scraper découpe les zones denses et s'arrête quand la zone est couverte.", 'ok');
      refresh();
      return;
    }

    const items = searches.map((sr) => ({ ...base, name, keywords: sr.keywords }));
    logLine(`→ mise en file d'attente de ${items.length} job(s)…`);
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
    const live = typeof item.liveCount === 'number' && item.liveCount > 0 ? ` · ${item.liveCount} trouvées` : '';
    return { cls: 'working', label: (item.engineStatus === 'working' ? 'en cours' : 'démarrage') + live };
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
    const rejected = config.rejectedProxies || [];
    proxyState.innerHTML = rejected.length
      ? `<strong>Proxy refusé — format non reconnu</strong> : <code>${escapeHtml(rejected.join(', '))}</code>. ` +
        'Attendu : <code>http://user:motdepasse@hôte:port</code>. Cliquez sur « Tester le proxy » pour le détail.'
      : "<strong>Aucun proxy configuré</strong> — Google servira des pages vides. Ajoutez <code>DEFAULT_PROXIES</code> dans Render.";
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

const filterIds = ['f-website', 'f-phone', 'f-email', 'f-rating', 'f-reviews'];

function exportUrl() {
  const p = new URLSearchParams();
  const website = document.getElementById('f-website').value;
  if (website) p.set('website', website);
  if (document.getElementById('f-phone').checked) p.set('phone', 'yes');
  if (document.getElementById('f-email').checked) p.set('email', 'yes');
  const rating = document.getElementById('f-rating').value;
  if (rating) p.set('max_rating', rating);
  const reviews = document.getElementById('f-reviews').value;
  if (reviews) p.set('min_reviews', reviews);
  const qs = p.toString();
  return '/api/export/merged' + (qs ? '?' + qs : '');
}

for (const id of filterIds) {
  document.getElementById(id).addEventListener('change', () => {
    document.getElementById('export-btn').href = exportUrl();
  });
}

function renderCampaigns(list) {
  const box = document.getElementById('campaign-box');
  if (!list || list.length === 0) {
    box.innerHTML = '';
    return;
  }
  box.innerHTML = list
    .map((c) => {
      const state = c.stopped
        ? `<span class="c-done">terminée</span> — ${escapeHtml(c.stopReason || '')}`
        : `<span class="c-run">en cours</span> — ${c.jobsDone}/${c.jobsCreated} recherches`;
      return `<div class="campaign-row">
        <strong>${escapeHtml(c.label)}</strong>
        <span class="c-count">${c.totalUnique} fiches uniques</span>
        <span class="c-state">${state}</span>
      </div>`;
    })
    .join('');
}

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
    renderCampaigns(data.campaigns);
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
renderEstimate();
refresh();
setInterval(refresh, POLL_MS);
