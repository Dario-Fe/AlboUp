/* ============================================================
   AlboUp — app.js
   Lettura semplificata dell'Albo Pretorio del Comune di Verbania.

   Il sito istituzionale (Liferay + portlet jCityGov) non espone
   API pubbliche né header CORS, quindi le richieste passano dal
   proxy pubblico r.jina.ai, che inoltra al browser le pagine
   dell'albo. Gli endpoint usati sono i medesimi GET della pagina
   ufficiale:

   - atti correnti    /web/trasparenza/papca-ap/-/papca/igrid/32156
   - archivio         stesso portlet + action=eseguiPaginazione
                      &hidden_page_size=50&hidden_page_to=N
   - ricerca          action=eseguiOrdinamentoLista
                      &simpleSearchEnable=true&oggetto=<testo>
   - filtro categoria action=eseguiFiltro&categoriaId=<id>
   - dettaglio        /web/trasparenza/papca-ap/-/papca/display/<id>

   Gli atti più vecchi "scorrono all'ingiù": ogni pagina richiesta
   in archivio prende gli atti immediatamente precedenti a quelli
   già mostrati, senza limiti di sessione (verificato: la pagina
   istituzionale accetta questi parametri in GET senza cookie).
   ============================================================ */

'use strict';

/* ---------------- Costanti ---------------- */

const BASE = 'https://verbania.trasparenza-valutazione-merito.it';
const PUB  = BASE + '/web/trasparenza/papca-ap';
const P    = 'p_p_id=jcitygovalbopubblicazioni_WAR_jcitygovalbiportlet';
const PL   = 'p_p_lifecycle=1&p_p_state=pop_up&p_p_mode=view';
const K    = '_jcitygovalbopubblicazioni_WAR_jcitygovalbiportlet_';

const SEZIONI = {
  albo:      { igrid: '32156', label: 'In pubblicazione' },
  storico:   { igrid: '32268', label: 'Archivio' },
  matrimoni: { igrid: '32263', label: 'Matrimoni' }
};

const CATEGORIE = [
  { id: null,    label: 'Tutti' },
  { id: '35439', label: 'Determinazioni' },
  { id: '35441', label: 'Delibere' },
  { id: '35442', label: 'Decreti' },
  { id: '35443', label: 'Ordinanze' },
  { id: '35711', label: 'Atti vari' }
];

const PAGE_SIZE     = 50;   // atti per pagina di scorrimento archivio
const SEARCH_WINDOW = 100;  // risultati massimi della ricerca
const CACHE_TTL     = 15 * 60 * 1000;          // lista: 15 min
const DETAIL_TTL    = 24 * 60 * 60 * 1000;     // dettaglio: 24 h
const PROXY_TIMEOUT = 20000;

/* ---------------- Stato ---------------- */

const state = {
  tab: 'albo',
  atti: [],            // atti caricati nella lista corrente
  archivePage: 0,      // ultima pagina archivio richiesta (0 = nessuna)
  hasMore: false,
  categoria: null,
  search: '',
  showingSearch: false, // la lista sta mostrando risultati di ricerca
  detailCache: new Map()
};

/* ---------------- Utilità ---------------- */

const $  = (sel) => document.querySelector(sel);
const el = (tag, cls, html) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (html !== undefined) n.innerHTML = html;
  return n;
};

function debounce(fn, ms) {
  let t;
  return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
}

function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function toast(msg, ms = 2600) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.remove('hidden');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => t.classList.add('hidden'), ms);
}

/* Icona dell'app (identica a icon.svg), usata per splash e caricamenti */
const ICON_SVG = '<svg viewBox="0 0 64 64" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">' +
  '<rect width="64" height="64" rx="14" fill="#0b4fd8"/>' +
  '<path d="M12 25 32 13l20 12" stroke="#fff" stroke-width="3.5" stroke-linecap="round" stroke-linejoin="round"/>' +
  '<line x1="13" y1="31" x2="51" y2="31" stroke="#fff" stroke-width="3.5" stroke-linecap="round"/>' +
  '<line x1="20" y1="37" x2="20" y2="47" stroke="#fff" stroke-width="3.5" stroke-linecap="round"/>' +
  '<line x1="28" y1="37" x2="28" y2="47" stroke="#fff" stroke-width="3.5" stroke-linecap="round"/>' +
  '<line x1="36" y1="37" x2="36" y2="47" stroke="#fff" stroke-width="3.5" stroke-linecap="round"/>' +
  '<line x1="44" y1="37" x2="44" y2="47" stroke="#fff" stroke-width="3.5" stroke-linecap="round"/>' +
  '<line x1="15" y1="52" x2="49" y2="52" stroke="#93c5fd" stroke-width="3.5" stroke-linecap="round"/>' +
  '</svg>';

/* Rimuove la schermata iniziale (splash) alla prima resa della lista */
function hideSplash() {
  const s = document.getElementById('splash');
  if (!s || s.classList.contains('splash-out')) return;
  s.classList.add('splash-out');
  setTimeout(() => s.remove(), 350);
}

/* Stato di caricamento: icona animata + scheletro delle card (stile JobUp) */
function showLoading(box, msg) {
  let skels = '';
  for (let i = 0; i < 3; i++) {
    skels += '<div class="skel-card" aria-hidden="true">' +
      '<div class="skel-row"><span class="skel skel-badge"></span><span class="skel skel-date"></span></div>' +
      '<span class="skel skel-line"></span>' +
      '<span class="skel skel-line skel-short"></span>' +
      '</div>';
  }
  box.innerHTML =
    '<div class="loading-block" role="status" aria-live="polite">' +
      '<div class="loading-icon">' + ICON_SVG + '</div>' +
      '<p>' + escapeHtml(msg || 'Caricamento…') + '</p>' +
      '<div class="skeletons">' + skels + '</div>' +
    '</div>';
}

/* ---------------- Data layer ---------------- */

async function fetchViaProxy(url, { asHtml = false, timeout = PROXY_TIMEOUT } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeout);
  try {
    const headers = asHtml ? { 'x-return-format': 'html' } : undefined;
    const res = await fetch('https://r.jina.ai/' + encodeURIComponent(url), {
      signal: ctrl.signal,
      headers
    });
    if (!res.ok) throw new Error('Proxy HTTP ' + res.status);
    return await res.text();
  } finally {
    clearTimeout(timer);
  }
}

/* Cache lista in localStorage per apertura istantanea e offline */
function cacheKey(kind, tab) { return 'alboVrb:' + kind + ':' + tab; }

function readListCache(tab) {
  try {
    const raw = localStorage.getItem(cacheKey('list', tab));
    if (!raw) return null;
    const obj = JSON.parse(raw);
    if (Date.now() - obj.t > CACHE_TTL) return null;
    return obj;
  } catch { return null; }
}

function writeListCache(tab, atti, hasMore) {
  try {
    localStorage.setItem(cacheKey('list', tab),
      JSON.stringify({ t: Date.now(), atti, hasMore }));
  } catch { /* quota piena: ignoriamo */ }
}

function readDetailCache(id) {
  try {
    // v2: formato allegati con url/pdf non firmato (invalida cache vecchia)
    const raw = localStorage.getItem('alboVrb:det:v2:' + id);
    if (!raw) return null;
    const obj = JSON.parse(raw);
    if (Date.now() - obj.t > DETAIL_TTL) return null;
    return obj.d;
  } catch { return null; }
}

function writeDetailCache(id, d) {
  try {
    localStorage.setItem('alboVrb:det:v2:' + id, JSON.stringify({ t: Date.now(), d }));
  } catch { /* ignora */ }
}

/* ---------------- URL builder ---------------- */

function listaUrl(tab) {
  return PUB + '/-/papca/igrid/' + SEZIONI[tab].igrid;
}

function paginaUrl(n) { // n >= 1, archivio completo in ordine di registrazione
  return PUB + '?' + P + '&' + PL + '&' + K + 'action=eseguiPaginazione' +
    '&hidden_page_size=' + PAGE_SIZE + '&hidden_page_to=' + n;
}

function ricercaUrl(q) {
  return PUB + '?' + P + '&' + PL + '&' + K + 'action=eseguiOrdinamentoLista' +
    '&' + K + 'simpleSearchEnable=true' +
    '&' + K + 'mostraSoloLista=true' +
    '&' + K + 'oggetto=' + encodeURIComponent(q) +
    '&hidden_page_size=100&hidden_page_to=1';
}

function filtroUrl(catId, page) {
  return PUB + '?' + P + '&' + PL + '&' + K + 'action=eseguiFiltro' +
    '&' + K + 'categoriaId=' + catId +
    '&hidden_page_size=' + PAGE_SIZE + '&hidden_page_to=' + (page || 1);
}

function dettaglioUrl(id) {
  return PUB + '/-/papca/display/' + id;
}

/* ---------------- Parser HTML (raw mode) ---------------- */

function stripTags(html) {
  return html.replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ').trim();
}

function parseListaHtml(html) {
  const out = [];
  const re = /<tr class="master-detail-list-line[^"]*"[^>]*data-id="(\d+)"[^>]*>([\s\S]*?)<\/tr>/g;
  let m;
  while ((m = re.exec(html)) !== null) {
    const row = m[2];
    const num   = (row.match(/class="annonumeroregistrazione number">([^<]*)</) || [])[1] || '';
    const cat   = stripTags((row.match(/class="categoria[^>]*>([\s\S]*?)<\/td>/) || [])[1] || '');
    const ogg   = stripTags((row.match(/class="oggetto text">([\s\S]*?)<\/td>/) || [])[1] || '');
    // date: SOLO dalla cella "periodo-pubblicazione" — mai dall'oggetto, che
    // può contenere altre date (es. "REVOCA ORDINANZA ... DEL 05/03/2026",
    // atto 1947730) che venivano prese per errore come data di pubblicazione
    const dcell = (row.match(/<td[^>]*class="periodo-pubblicazione[^"]*"[^>]*>([\s\S]*?)<\/td>/) || [])[1] || '';
    let dates = dcell.match(/(\d{2}\/\d{2}\/\d{4})\s*(?:<br\s*\/?>)?\s*(\d{2}\/\d{2}\/\d{4})?/);
    if (!dates) {
      // fallback (formati imprevisti): scansione di tutta la riga
      dates = row.match(/(\d{2}\/\d{2}\/\d{4})\s*(?:<br\s*\/?>)?\s*(\d{2}\/\d{2}\/\d{4})?/);
    }
    out.push(makeAtto({
      id: m[1], numero: num.trim(), categoria: cat,
      oggetto: ogg,
      dal: dates ? dates[1] : '', al: dates && dates[2] ? dates[2] : '',
      allegati: (row.match(/class="badge">(\d+)</) || [])[1] || ''
    }));
  }
  return out;
}

function parseRigaDettaglio(html) {
  const d = {};
  // righe di dettaglio: <tr class="ap-..."> con label e valore nelle prime due celle
  // (le label possono essere dentro <span>, quindi si usa stripTags su tutta la cella)
  const rows = /<tr[^>]*class="ap-[^"]*"[^>]*>([\s\S]*?)<\/tr>/g;
  let rm, pairs = 0;
  while ((rm = rows.exec(html)) !== null) {
    const tds = rm[1].match(/<td[\s\S]*?<\/td>/g) || [];
    if (tds.length >= 2) {
      const k = stripTags(tds[0]);
      const v = stripTags(tds[1]);
      if (k && k.length <= 40 && v && !(k in d)) { d[k] = v; pairs++; }
    }
  }
  if (!pairs) {
    // fallback: coppie consecutive di celle nella pagina
    const cell = /<td[^>]*>([\s\S]*?)<\/td>\s*<td[^>]*>([\s\S]*?)<\/td>/g;
    let cm;
    while ((cm = cell.exec(html)) !== null) {
      const k = stripTags(cm[1]);
      const v = stripTags(cm[2]);
      if (k && k.length <= 40 && v && !(k in d)) d[k] = v;
    }
  }
  d.oggetto = d['Oggetto'] ||
    stripTags((html.match(/class="oggetto text">([\s\S]*?)<\/td>/) || [])[1] || '');
  // allegati: righe con data-chiave-allegato
  d.allegati = [];
  const are = /<tr data-chiave-allegato[^>]*>([\s\S]*?)<\/tr>/g;
  let am;
  while ((am = are.exec(html)) !== null) {
    const row = am[1];
    const mime = (row.match(/data-mimetype="([^"]*)"/) || [])[1] || '';
    // ogni allegato può avere due url: versione firmata (downloadSigned=true,
    // file .p7m pkcs7 non apribile) e versione normale (downloadSigned=false,
    // pdf). Preferiamo sempre il pdf normale.
    const urls = [];
    const bre = /atob\('([^']+)'\)/g;
    let bm;
    while ((bm = bre.exec(row)) !== null) {
      try { urls.push(atob(bm[1])); } catch { /* base64 corrotto: ignora */ }
    }
    let url = '', urlFirmato = '';
    for (const u of urls) {
      if (/downloadSigned=false/.test(u)) url = u;
      else if (/downloadSigned=true/.test(u)) urlFirmato = u;
    }
    let soloFirmato = false;
    if (!url && urlFirmato) { url = urlFirmato; urlFirmato = ''; soloFirmato = true; }
    else if (!url && urls.length) { url = urls[0]; }
    d.allegati.push({
      titolo: stripTags((row.match(/<td[^>]*>([^<]*)<\/td>/) || [])[1] || 'Allegato'),
      tipo:   stripTags((row.match(/<\/td>\s*<td[^>]*>([^<]*)<\/td>/) || [])[1] || ''),
      url,
      urlFirmato,
      soloFirmato,
      firmato: /pkcs7/i.test(mime) || soloFirmato
    });
  }
  return d;
}

/* ---------------- Parser Markdown (fallback) ---------------- */

function splitMdRow(line) {
  // divide una riga "| a | b | c |" rispettando i link [x](y)
  const cells = [];
  let cur = '', depth = 0;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '[') depth++;
    if (c === ']') depth = Math.max(0, depth - 1);
    if (c === '|' && depth === 0) { cells.push(cur); cur = ''; continue; }
    cur += c;
  }
  cells.push(cur);
  return cells.map(s => s.trim());
}

function mdInline(s) {
  return s.replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
          .replace(/\*\*/g, '').trim();
}

function parseListaMd(md) {
  const lines = md.split('\n');
  const start = lines.findIndex(l => l.startsWith('|') && /Anno e Numero Registro/i.test(l));
  if (start === -1) return null;
  const out = [];
  for (let i = start + 2; i < lines.length; i++) {
    const l = lines[i];
    if (!l.startsWith('|') || l.startsWith('| ---')) { if (out.length) break; else continue; }
    let c = splitMdRow(l);
    // il separatore iniziale/finale produce celle vuote: rimuovile
    if (c.length && c[0] === '') c = c.slice(1);
    if (c.length && c[c.length - 1] === '') c = c.slice(0, -1);
    if (c.length < 5) continue;
    const num  = mdInline(c[0]);
    const cat  = mdInline(c[1]);
    const ogg  = mdInline(c[2]);
    const date = mdInline(c[3]).split(/\s+/);
    const dm = c[4].match(/display\/(\d+)/);
    const id = dm ? dm[1] : null;
    if (!id) continue;
    const badge = c[4].match(/\[(\d+)\]\(/);
    out.push(makeAtto({
      id, numero: num, categoria: cat, oggetto: ogg,
      dal: date[0] || '', al: date[1] || '',
      allegati: badge ? badge[1] : ''
    }));
  }
  return out;
}

/* Etichette note della scheda atto, per il fallback Markdown */
const DETAIL_LABELS = [
  'Categoria', 'Sottocategoria', 'Anno atto', 'Numero atto', 'Data documento',
  'Data atto', 'Tipo registrazione', 'Data di registro', 'Anno di registro',
  'Numero di registro', 'Proponente', 'Oggetto', 'Dirigente/Firmatario',
  'Data esecutività', 'Classifica', 'Periodo Pubblicazione',
  'Data inizio pubblicazione', 'Data fine pubblicazione', 'Provenienza',
  'Stato', 'Numero allegati'
];

function parseRigaDettaglioMd(md) {
  const d = { allegati: [] };
  const lines = md.split('\n');
  for (const raw of lines) {
    const line = raw.trim();
    if (!line || line.startsWith('[') || line.startsWith('#') || line.startsWith('|') || line.startsWith('!')) continue;
    for (const label of DETAIL_LABELS) {
      if (line.startsWith(label + ' ') && !(label in d)) {
        d[label] = mdInline(line.slice(label.length + 1));
      }
    }
  }
  // gli allegati non sono estrabili dal markdown (url costruiti via JS):
  // la versione html tramite x-return-format resta la fonte primaria.
  return d;
}

/* ---------------- Modello comune ---------------- */

function catLabel(cat) {
  const c = (cat || '').toUpperCase();
  if (c.includes('DETERMINAZIONE')) return 'Determinazione';
  if (c.includes('DELIBERA'))       return 'Delibera';
  if (c.includes('DECRETO'))        return 'Decreto';
  if (c.includes('ORDINANZA'))      return 'Ordinanza';
  return cat || 'Atto';
}

function makeAtto(o) {
  return {
    id: o.id,
    numero: o.numero || '',
    categoria: o.categoria || '',
    oggetto: o.oggetto || '(senza oggetto)',
    dal: o.dal || '',
    al: o.al || '',
    allegati: o.allegati || ''
  };
}

function isFresh(atto) {
  if (!atto.dal) return false;
  const [g, m, a] = atto.dal.split('/').map(Number);
  return (Date.now() - new Date(a, m - 1, g).getTime()) < 3 * 86400000;
}

/* ---------------- Rendering lista ---------------- */

function statusMsg(html, isError) {
  const s = $('#statusLine');
  s.innerHTML = html || '';
  s.classList.toggle('error', !!isError);
}

function renderCards() {
  hideSplash();
  const box = $('#listView');
  box.innerHTML = '';
  if (!state.atti.length) return;

  for (const a of state.atti) {
    const card = el('button', 'card');
    card.type = 'button';
    card.setAttribute('aria-label', 'Apri scheda atto ' + a.numero);

    const top = el('div', 'card-top');
    top.innerHTML =
      '<span class="badge">' + escapeHtml(catLabel(a.categoria)) + '</span>' +
      '<span class="card-date">' + (a.dal ? '📅 ' + escapeHtml(a.dal) : '') + '</span>';

    const body = el('div', 'card-body');
    body.innerHTML = '<h3 class="card-title">' + escapeHtml(a.oggetto) + '</h3>';

    const foot = el('div', 'card-foot');
    let footHtml = a.numero ? '<span class="tag-num">' + escapeHtml(a.numero) + '</span>' : '';
    if (a.allegati && a.allegati !== '0') {
      footHtml += '<span class="attach">📎 ' + escapeHtml(a.allegati) + '</span>';
    }
    if (isFresh(a)) footHtml += '<span class="new-flag">● nuovo</span>';
    foot.innerHTML = footHtml || '<span class="muted">Tocca per i dettagli</span>';

    card.append(top, body, foot);
    card.addEventListener('click', () => openDetail(a.id));
    box.appendChild(card);
  }
}

function sortAtti(arr) {
  return arr.sort((x, y) => {
    const dx = x.dal.split('/').reverse().join('') + (x.numero.match(/\d+/g) || ['0']).pop().padStart(8, '0');
    const dy = y.dal.split('/').reverse().join('') + (y.numero.match(/\d+/g) || ['0']).pop().padStart(8, '0');
    return dy.localeCompare(dx);
  });
}

/* ---------------- Caricamento dati ---------------- */

async function loadTab({ silent = false } = {}) {
  const tab = state.tab;
  if (!silent) {
    showLoading($('#listView'), 'Caricamento ' + SEZIONI[tab].label.toLowerCase() + '…');
    statusMsg('');
  }

  const cached = readListCache(tab);
  if (cached && !state.search && !state.categoria) {
    state.atti = cached.atti;
    state.hasMore = cached.hasMore;
    // lo storico era stato caricato con pagina archivio 1 (50 atti)
    state.archivePage = tab === 'storico' ? 1 : 0;
    renderCards();
    applyClientFilters();
    statusMsg('');
    updateLastUpdate(cached.t);
    refreshInBackground(tab);
    return;
  }

  await loadFirstPage();
}

async function loadFirstPage() {
  const tab = state.tab;
  try {
    let atti, hasMore = false;

    if (state.search) {
      const html = await fetchViaProxy(ricercaUrl(state.search), { asHtml: true });
      atti = parseListaHtml(html);
      if (!atti.length) {
        const md = await fetchViaProxy(ricercaUrl(state.search));
        atti = parseListaMd(md) || [];
      }
      state.archivePage = 0;
      state.hasMore = false;
      state.showingSearch = true;
    } else if (state.categoria) {
      const url = filtroUrl(state.categoria, 1);
      const html = await fetchViaProxy(url, { asHtml: true });
      atti = parseListaHtml(html);
      if (!atti.length) {
        const md = await fetchViaProxy(url);
        atti = parseListaMd(md) || [];
      }
      state.archivePage = 1;
      state.hasMore = atti.length >= PAGE_SIZE - 2; // il filtro è già ordinato per data
    } else if (tab === 'storico' || tab === 'albo') {
      // albo: prima pagina = atti in pubblicazione; archivio: pagine da 50
      const url = tab === 'storico' ? paginaUrl(1) : listaUrl(tab);
      const html = await fetchViaProxy(url, { asHtml: true });
      atti = parseListaHtml(html);
      if (!atti.length) {
        const md = await fetchViaProxy(url);
        atti = parseListaMd(md) || [];
      }
      state.archivePage = tab === 'storico' ? 1 : 0;
      state.hasMore = true;
    } else {
      const url = listaUrl(tab);
      const html = await fetchViaProxy(url, { asHtml: true });
      atti = parseListaHtml(html);
      if (!atti.length) {
        const md = await fetchViaProxy(url);
        atti = parseListaMd(md) || [];
      }
      state.archivePage = 0;
      state.hasMore = true;
    }

    if (tab !== state.tab) return; // l'utente ha cambiato tab nel frattempo

    if (!atti.length) {
      state.atti = [];
      const box = $('#listView');
      if (tab === 'matrimoni' && !state.search && !state.categoria) {
        // sezione vuota lato Comune: messaggio dedicato invece di "nessun atto"
        box.innerHTML =
          '<div class="empty-box">' +
          '<span class="empty-ico" aria-hidden="true">💍</span>' +
          '<h3>Nessuna pubblicazione di matrimonio in questo periodo</h3>' +
          '<p>La sezione è attiva, ma il Comune non ha pubblicato avvisi di ' +
          'matrimonio ora. Le nuove pubblicazioni compariranno qui ' +
          'automaticamente appena inserite.</p>' +
          '<a class="btn-secondary" target="_blank" rel="noopener" href="' +
          listaUrl(tab) + '">Vai alla pagina ufficiale ↗</a>' +
          '</div>';
        statusMsg('');
        hideSplash();
      } else {
        renderCards();
        statusMsg('Nessun atto trovato' +
          (state.search ? ' per «' + escapeHtml(state.search) + '»' : '') + '.');
      }
      return;
    }

    state.atti = atti;
    state.showingSearch = !!state.search;
    renderCards();
    applyClientFilters();
    statusMsg('');

    if (!state.search && !state.categoria) {
      writeListCache(tab, state.atti, state.hasMore);
      updateLastUpdate(Date.now());
    }
  } catch (e) {
    console.error(e);
    if (tab === state.tab) {
      renderCards();
      statusMsg('⚠️ Impossibile contattare l\'albo. Controlla la connessione e riprova, ' +
        'oppure apri il <a href="' + listaUrl(tab) + '" target="_blank" rel="noopener">sito ufficiale</a>.', true);
    }
  }
}

/* Refresh silenzioso della cache */
let refreshing = false;
async function refreshInBackground(tab) {
  if (refreshing) return;
  refreshing = true;
  try {
    const url = tab === 'storico' ? paginaUrl(1) : listaUrl(tab);
    let atti = null;
    try {
      const html = await fetchViaProxy(url, { asHtml: true });
      atti = parseListaHtml(html);
    } catch { /* fallback sotto */ }
    if (!atti || !atti.length) {
      try {
        const md = await fetchViaProxy(url);
        atti = parseListaMd(md);
      } catch { /* offline */ }
    }
    if (atti && atti.length && tab === state.tab && !state.search && !state.categoria) {
      state.atti = atti;
      renderCards();
      applyClientFilters();
      writeListCache(tab, atti, state.hasMore);
      updateLastUpdate(Date.now());
    }
  } finally {
    refreshing = false;
  }
}

/* Scorrimento all'ingiù: pagina successiva (archivio o categoria) */
async function loadOlderPage() {
  const canScroll = state.hasMore && !state.search &&
    (state.tab === 'storico' || state.tab === 'albo');
  if (!canScroll) return;
  const btn = $('#loadMore');
  btn.disabled = true;
  statusMsg('<span class="spinner"></span>Carico atti più vecchi…');
  try {
    const next = state.archivePage + 1;
    const url = state.categoria
      ? filtroUrl(state.categoria, next)
      : paginaUrl(next);
    const html = await fetchViaProxy(url, { asHtml: true });
    let atti = parseListaHtml(html);
    if (!atti.length) {
      const md = await fetchViaProxy(url);
      atti = parseListaMd(md) || [];
    }
    if (state.tab !== 'albo' && state.tab !== 'storico') return;

    const rawCount = atti.length;

    // dedup per id
    const seen = new Set(state.atti.map(a => a.id));
    const fresh = atti.filter(a => !seen.has(a.id));
    if (state.tab === 'albo' && !state.categoria) {
      // nell'albo la prima pagina sono gli atti correnti (per data inizio pubbl.);
      // le pagine archivio arrivano per registrazione: ordina il tutto
      state.atti = sortAtti(state.atti.concat(fresh));
    } else {
      state.atti = state.atti.concat(fresh);
    }
    state.archivePage = next;
    // hasMore si basa sul numero grezzo di righe restituite, non su quelle
    // rimaste dopo la dedup (nell'albo la prima pagina archivio contiene
    // gli atti correnti già mostrati)
    state.hasMore = rawCount >= PAGE_SIZE - 2;
    renderCards();
    applyClientFilters();
    statusMsg('');
  } catch (e) {
    console.error(e);
    statusMsg('⚠️ Errore nel caricamento degli atti precedenti. Riprova.', true);
  } finally {
    btn.disabled = false;
    updateLoadMoreUI();
  }
}

/* ---------------- Filtri lato client (categoria rapida) ---------------- */

function applyClientFilters() {
  // Le chip filtrano localmente ciò che è già caricato: immediato su atti correnti,
  // mentre l'archivio usa il filtro server-side quando si sceglie una categoria.
  updateLoadMoreUI();
}

function updateLoadMoreUI() {
  const canMore = state.hasMore && !state.search &&
    (state.tab === 'storico' || state.tab === 'albo');
  $('#loadMore').classList.toggle('hidden', !canMore);
  $('#loadMoreNote').classList.toggle('hidden', !state.search);
  $('#loadMoreNote').textContent = state.search
    ? 'Ricerca sui contenuti pubblicati · risultati più recenti per prime'
    : '';
}

/* ---------------- Dettaglio ---------------- */

async function openDetail(id) {
  const ov = $('#detailOverlay');
  ov.classList.remove('hidden');
  document.body.style.overflow = 'hidden';
  history.pushState({ detail: id }, '', '#atto-' + id);

  const card = $('#detailCard');
  card.innerHTML = '<div class="loading-block"><div class="loading-icon">' + ICON_SVG +
    '</div><p>Carico la scheda…</p></div>';

  const cached = readDetailCache(id);
  if (cached) { renderDetail(id, cached); return; }

  try {
    const url = dettaglioUrl(id);
    let d = null;
    try {
      const html = await fetchViaProxy(url, { asHtml: true });
      d = parseRigaDettaglio(html);
      if (!d.oggetto && !Object.keys(d).length) d = null;
    } catch { /* fallback */ }
    if (!d) {
      const md = await fetchViaProxy(url);
      d = parseRigaDettaglioMd(md);
    }
    d.id = id;
    d.url = url;
    writeDetailCache(id, d);
    renderDetail(id, d);
  } catch (e) {
    console.error(e);
    hideSplash();
    card.innerHTML =
      '<p class="statusline error">⚠️ Impossibile caricare la scheda.</p>' +
      '<div class="d-actions"><a class="btn-primary" target="_blank" rel="noopener" href="' +
      dettaglioUrl(id) + '">Apri la pagina ufficiale ↗</a></div>';
  }
}

function renderDetail(id, d) {
  hideSplash();
  const card = $('#detailCard');
  const cat = catLabel(d.categoria || d.Categoria || '');
  const oggetto = d.oggetto || d.Oggetto || '(senza oggetto)';

  const rows = [];
  const add = (k, v) => { if (v) rows.push([k, v]); };

  add('Numero atto', [d['Anno atto'], d['Numero atto']].filter(Boolean).join('/') || d.numero);
  add('Numero di registro', [d['Anno di registro'], d['Numero di registro']].filter(Boolean).join('/'));
  add('Data documento', d['Data documento'] || d['Data atto']);
  add('Proponente', d['Proponente']);
  add('Dirigente / Firmatario', d['Dirigente/Firmatario']);
  add('Data esecutività', d['Data esecutività']);
  add('Classifica', d['Classifica']);
  add('Tipo registrazione', d['Tipo registrazione']);
  add('Periodo di pubblicazione', d['Periodo Pubblicazione'] ||
      ((d.dal || d['Data inizio pubblicazione']) ?
        (d.dal || d['Data inizio pubblicazione']) + (d.al ? ' → ' + d.al : '') : ''));

  let attHtml = '';
  if (d.allegati && d.allegati.length) {
    attHtml = '<h3 class="d-att-title">Allegati</h3><ul class="d-att-list">' +
      d.allegati.map(a => {
        const nome = a.soloFirmato
          ? escapeHtml(a.titolo) + ' <span class="muted">(solo versione firmata .p7m)</span>'
          : escapeHtml(a.titolo);
        const main = a.url
          ? ' <a class="btn-secondary att-btn" target="_blank" rel="noopener" href="' +
            escapeHtml(a.url) + '">Apri PDF ↓</a>' : '';
        const signed = a.urlFirmato
          ? ' <a class="att-signed" target="_blank" rel="noopener" href="' +
            escapeHtml(a.urlFirmato) + '" title="File con firma digitale (.p7m), richiede un lettore adeguato">Versione firmata (.p7m)</a>' : '';
        return '<li><span class="att-name">' + nome +
          (a.tipo ? ' <span class="muted">— ' + escapeHtml(a.tipo) + '</span>' : '') +
          '</span><span class="att-links">' + main + signed + '</span></li>';
      }).join('') + '</ul>';
  }

  card.innerHTML =
    '<div class="d-head">' +
      '<span class="d-cat">' + escapeHtml(cat) + '</span>' +
      '<h2 class="d-title" id="detailTitle">' + escapeHtml(oggetto) + '</h2>' +
      '<p class="d-num">' + escapeHtml(d.numero || ([d['Anno atto'], d['Numero atto']].filter(Boolean).join('/')) || '') + '</p>' +
    '</div>' +
    '<dl class="d-rows">' +
      rows.map(([k, v]) =>
        '<div class="d-row"><dt>' + escapeHtml(k) + '</dt><dd>' + escapeHtml(v) + '</dd></div>').join('') +
    '</dl>' +
    attHtml +
    '<div class="d-actions">' +
      '<a class="btn-primary" target="_blank" rel="noopener" href="' + escapeHtml(d.url || dettaglioUrl(id)) + '">📄 Pagina ufficiale dell\'atto ↗</a>' +
    '</div>' +
    '<p class="d-note">Tutti i dati sono riportati dall\'Albo Pretorio ufficiale del Comune di Verbania. ' +
    'Per gli atti fa fede esclusivamente la pubblicazione sul sito istituzionale.</p>';
}

function closeDetail() {
  $('#detailOverlay').classList.add('hidden');
  document.body.style.overflow = '';
  if (location.hash.startsWith('#atto-')) {
    history.pushState({}, '', location.pathname + location.search);
  }
}

/* ---------------- Tab / ricerca / chips ---------------- */

function switchTab(tab) {
  if (!SEZIONI[tab]) return;
  state.tab = tab;
  state.atti = [];
  state.search = '';
  state.showingSearch = false;
  state.categoria = null;
  state.archivePage = 0;
  state.hasMore = false;
  $('#searchInput').value = '';
  $('#searchClear').classList.add('hidden');

  document.querySelectorAll('.tab').forEach(t => {
    const on = t.dataset.tab === tab;
    t.classList.toggle('active', on);
    t.setAttribute('aria-selected', on);
  });
  renderChips();
  loadTab();
}

function renderChips() {
  const box = $('#catChips');
  box.innerHTML = '';
  // Le chip per categoria hanno senso nelle sezioni albo/storico
  for (const c of CATEGORIE) {
    const chip = el('button', 'chip' + (state.categoria === c.id ? ' active' : ''));
    chip.type = 'button';
    chip.textContent = c.label;
    chip.addEventListener('click', () => {
      state.categoria = c.id;
      state.search = '';
      $('#searchInput').value = '';
      $('#searchClear').classList.add('hidden');
      renderChips();
      loadFirstPage();
    });
    box.appendChild(chip);
  }
}

const doSearch = debounce(() => {
  const q = $('#searchInput').value.trim();
  state.search = q.length >= 2 ? q : '';
  $('#searchClear').classList.toggle('hidden', !$('#searchInput').value);
  if (state.categoria) { state.categoria = null; renderChips(); }
  if (state.search) {
    loadFirstPage();
  } else if (state.showingSearch) {
    // la ricerca è stata azzerata: torna alla lista della sezione
    loadTab();
  } else if (!$('#listView').children.length) {
    loadFirstPage();
  } else {
    renderCards();
    applyClientFilters();
    statusMsg('');
  }
}, 550);

/* ---------------- Tema ---------------- */

function applyTheme(t) {
  document.documentElement.dataset.theme = t;
  localStorage.setItem('alboVrb:theme', t);
  updateThemeToggleLabel(t);
}

/* etichetta del pulsante tema: descrive l'azione, non lo stato */
function updateThemeToggleLabel(t) {
  const btn = $('#themeToggle');
  if (!btn) return;
  const next = t === 'dark' ? 'chiaro' : 'scuro';
  const label = 'Cambia tema: passa al tema ' + next;
  btn.title = label;
  btn.setAttribute('aria-label', label);
}

/* ---------------- Ultimo aggiornamento ---------------- */

function updateLastUpdate(ts) {
  try {
    const d = new Date(ts);
    $('#lastUpdate').textContent = 'Dati aggiornati il ' +
      d.toLocaleDateString('it-IT') + ' alle ' + d.toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit' });
  } catch { /* noop */ }
}

/* ---------------- Eventi ---------------- */

function bindEvents() {
  document.querySelectorAll('.tab').forEach(t =>
    t.addEventListener('click', () => switchTab(t.dataset.tab)));

  $('#searchInput').addEventListener('input', doSearch);
  $('#searchClear').addEventListener('click', () => {
    $('#searchInput').value = '';
    state.search = '';
    $('#searchClear').classList.add('hidden');
    if (state.showingSearch) {
      loadTab(); // torna alla lista della sezione
    } else {
      renderCards();
      applyClientFilters();
      statusMsg('');
    }
  });

  $('#loadMore').addEventListener('click', loadOlderPage);
  $('#detailBack').addEventListener('click', closeDetail);
  $('#detailOverlay').addEventListener('click', e => {
    if (e.target.id === 'detailOverlay') closeDetail();
  });
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && !$('#detailOverlay').classList.contains('hidden')) closeDetail();
  });

  $('#toTop').addEventListener('click', () => window.scrollTo({ top: 0, behavior: 'smooth' }));
  window.addEventListener('scroll', () => {
    $('#toTop').classList.toggle('hidden', window.scrollY < 600);
  }, { passive: true });

  $('#detailCopy').addEventListener('click', async () => {
    const link = location.origin + location.pathname + location.hash;
    try { await navigator.clipboard.writeText(link); toast('🔗 Link copiato'); }
    catch { toast('Copia non disponibile su questo browser'); }
  });

  $('#themeToggle').addEventListener('click', () => {
    applyTheme(document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark');
    toast(document.documentElement.dataset.theme === 'dark' ? '🌙 Tema scuro' : '☀️ Tema chiaro');
  });

  window.addEventListener('popstate', () => {
    const m = location.hash.match(/^#atto-(\d+)$/);
    if (m) openDetail(m[1]);
    else if (!$('#detailOverlay').classList.contains('hidden')) {
      $('#detailOverlay').classList.add('hidden');
      document.body.style.overflow = '';
    }
  });
}

/* ---------------- Avvio ---------------- */

function init() {
  // tema scuro di default; la scelta manuale dell'utente resta salvata
  applyTheme(localStorage.getItem('alboVrb:theme') || 'dark');
  bindEvents();
  renderChips();

  const m = location.hash.match(/^#atto-(\d+)$/);
  if (m) { openDetail(m[1]); }
  loadTab();
  // sicurezza: se qualcosa va storto, la splash si chiude comunque
  setTimeout(hideSplash, 5000);
}

init();
