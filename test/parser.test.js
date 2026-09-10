/* Test dei parser di app.js sui file HTML/MD reali salvati in %TMP%
   (scaricati da r.jina.ai e dal sito durante la fase di analisi).
   Eseguito con Node: duplica le funzioni di parsing per verificarle
   sui dati veri. */

'use strict';
const fs = require('fs');
const path = require('path');

const read = (p) => fs.readFileSync(
  p.startsWith('/tmp/') ? path.join(process.env.TMP || '/tmp', p.slice(4)) : p, 'utf8');

function stripTags(html) {
  return html.replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ').trim();
}

function makeAtto(o) {
  return {
    id: o.id, numero: o.numero || '', categoria: o.categoria || '',
    oggetto: o.oggetto || '(senza oggetto)', dal: o.dal || '', al: o.al || '',
    allegati: o.allegati || ''
  };
}

/* --- Parser lista HTML (identico ad app.js) --- */
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
      id: m[1], numero: num.trim(), categoria: cat, oggetto: ogg,
      dal: dates ? dates[1] : '', al: dates && dates[2] ? dates[2] : '',
      allegati: (row.match(/class="badge">(\d+)</) || [])[1] || ''
    }));
  }
  return out;
}

/* --- Parser lista Markdown (identico ad app.js) --- */
function splitMdRow(line) {
  const cells = []; let cur = '', depth = 0;
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
  return s.replace(/\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/\*\*/g, '').trim();
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
    if (c.length && c[0] === '') c = c.slice(1);
    if (c.length && c[c.length - 1] === '') c = c.slice(0, -1);
    if (c.length < 5) continue;
    const num = mdInline(c[0]), cat = mdInline(c[1]), ogg = mdInline(c[2]);
    const date = mdInline(c[3]).split(/\s+/);
    const dm = c[4].match(/display\/(\d+)/);
    const id = dm ? dm[1] : null;
    if (!id) continue;
    const badge = c[4].match(/\[(\d+)\]\(/);
    out.push(makeAtto({ id, numero: num, categoria: cat, oggetto: ogg,
      dal: date[0] || '', al: date[1] || '', allegati: badge ? badge[1] : '' }));
  }
  return out;
}

/* --- Parser dettaglio HTML (identico ad app.js, atob via Buffer in Node) --- */
function atobDecode(b64) { return Buffer.from(b64, 'base64').toString('utf8'); }

function parseRigaDettaglio(html) {
  const d = {};
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
  d.allegati = [];
  const are = /<tr data-chiave-allegato[^>]*>([\s\S]*?)<\/tr>/g;
  let am;
  while ((am = are.exec(html)) !== null) {
    const row = am[1];
    const mime = (row.match(/data-mimetype="([^"]*)"/) || [])[1] || '';
    const urls = [];
    const bre = /atob\('([^']+)'\)/g;
    let bm;
    while ((bm = bre.exec(row)) !== null) {
      try { urls.push(atobDecode(bm[1])); } catch {}
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
      url, urlFirmato, soloFirmato,
      firmato: /pkcs7/i.test(mime) || soloFirmato
    });
  }
  return d;
}

/* ================= TEST ================= */
let fail = 0;
const ok = (cond, msg) => { console.log((cond ? '  PASS ' : '  FAIL ') + msg); if (!cond) fail++; };

console.log('--- parseListaHtml su lista corrente (igrid 32156, via proxy) ---');
{
  const atti = parseListaHtml(read('/tmp/jlista.html'));
  ok(atti.length >= 15, 'atti estratti: ' + atti.length + ' (attese ~20)');
  const a = atti[0];
  ok(/^\d{4}\/\d+$/.test(a.numero), 'numero formato registro: ' + a.numero);
  ok(a.categoria.length > 3, 'categoria: ' + a.categoria);
  ok(a.oggetto.length > 20, 'oggetto: ' + a.oggetto.slice(0, 60) + '…');
  ok(/^\d{2}\/\d{2}\/\d{4}$/.test(a.dal), 'data inizio: ' + a.dal);
  ok(/^\d{2}\/\d{2}\/\d{4}$/.test(a.al), 'data fine: ' + a.al);
  ok(/^\d+$/.test(a.id), 'id atto: ' + a.id);
}

console.log('--- parseListaHtml su lista diretta (senza proxy) ---');
{
  const atti = parseListaHtml(read('/tmp/lista.html'));
  ok(atti.length >= 15, 'atti estratti: ' + atti.length);
}

console.log('--- parseListaHtml su archivio pagina 2 (50 atti) ---');
{
  const atti = parseListaHtml(read('/tmp/post1.html'));
  ok(atti.length >= 40, 'atti estratti: ' + atti.length + ' (attesi 50)');
  ok(/^\d{4}\/\d+$/.test(atti[0].numero), 'primo numero: ' + atti[0].numero);
}

console.log('--- REGRESSIONE atto 1947730: data dall\'oggetto non deve essere presa ---');
{
  const atti = parseListaHtml(read('/tmp/lista2.html'));
  const a = atti.find(x => x.id === '1947730');
  ok(!!a, 'atto 1947730 presente nella lista');
  if (a) {
    ok(/REVOCA ORDINANZA/i.test(a.oggetto), 'oggetto: ' + a.oggetto.slice(0, 60) + '…');
    ok(a.dal === '10/09/2026', 'data inizio = 10/09/2026 (non 05/03/2026 dall\'oggetto): ' + a.dal);
    ok(a.al === '25/09/2026', 'data fine = 25/09/2026: ' + a.al);
  }
}

console.log('--- parseListaMd su lista markdown (r.jina.ai default) ---');
{
  const atti = parseListaMd(read('/tmp/j.txt'));
  ok(!!atti && atti.length >= 15, 'atti estratti dal MD: ' + (atti ? atti.length : 0));
  if (atti && atti.length) {
    const a = atti[0];
    ok(/^\d{4}\/\d+$/.test(a.numero), 'numero: ' + a.numero);
    ok(/^\d+$/.test(a.id), 'id: ' + a.id);
    ok(a.oggetto.length > 20, 'oggetto: ' + a.oggetto.slice(0, 60) + '…');
    ok(/^\d{2}\/\d{2}\/\d{4}$/.test(a.dal), 'data: ' + a.dal);
    ok(a.categoria.length > 3, 'categoria: ' + a.categoria);
  }
}

console.log('--- parseRigaDettaglio su dettaglio HTML (via proxy) ---');
{
  const d = parseRigaDettaglio(read('/tmp/jh.txt'));
  ok(d.oggetto && d.oggetto.length > 20, 'oggetto: ' + (d.oggetto || '').slice(0, 60) + '…');
  ok(d['Anno atto'] === '2026', 'Anno atto: ' + d['Anno atto']);
  ok(d['Numero atto'] === '1625', 'Numero atto: ' + d['Numero atto']);
  ok(d['Proponente'] === 'Lavori pubblici', 'Proponente: ' + d['Proponente']);
  ok(!!d['Dirigente/Firmatario'], 'Dirigente: ' + d['Dirigente/Firmatario']);
  ok(!!d['Data esecutività'], 'Data esecutività: ' + d['Data esecutività']);
  ok(!!d['Classifica'], 'Classifica: ' + d['Classifica']);
  ok(Array.isArray(d.allegati) && d.allegati.length === 1, 'allegati: ' + d.allegati.length);
  ok(d.allegati[0].url.startsWith('https://verbania.trasparenza'), 'url allegato valido');
  ok(!/downloadSigned=true/.test(d.allegati[0].url) || d.allegati[0].soloFirmato, 'url principale non è la versione firmata (salvo unica versione)');
  ok(d.allegati[0].titolo.length > 3, 'titolo allegato: ' + d.allegati[0].titolo);
}

console.log('--- parseRigaDettaglio: atto 1947645 (firmato + non firmato) ---');
{
  const d = parseRigaDettaglio(read('/tmp/det2.html'));
  ok(d.allegati.length === 2, 'allegati: ' + d.allegati.length);
  const a1 = d.allegati[0];
  ok(/downloadSigned=false/.test(a1.url), 'allegato 1: url principale = PDF non firmato');
  ok(/downloadSigned=true/.test(a1.urlFirmato), 'allegato 1: versione firmata come secondaria');
  ok(a1.firmato === true || a1.soloFirmato === false, 'flag firmato coerente');
  const a2 = d.allegati[1];
  ok(/downloadSigned=false/.test(a2.url), 'allegato 2: url principale = PDF non firmato');
}

console.log(fail ? ('\n' + fail + ' TEST FALLITI') : '\nTUTTI I TEST PASSANO');
process.exit(fail ? 1 : 0);
