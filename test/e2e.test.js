/* Test end-to-end: replica il flusso completo dell'app
   (URL builder -> r.jina.ai -> parser) con fetch reale. */

'use strict';
const fs = require('fs');
const path = require('path');

/* --- estrae dal sorgente di app.js le funzioni pure (parser + URL builder)
       così il test usa ESATTAMENTE il codice dell'app, senza duplicazione --- */
const src = fs.readFileSync(path.join(__dirname, '..', 'app.js'), 'utf8');

function grab(re) {
  const m = src.match(re);
  if (!m) throw new Error('funzione non trovata in app.js: ' + re);
  return m[0];
}

const code = [
  grab(/const BASE = .*?;/),
  grab(/const PUB  = .*?;/),
  grab(/const P    = .*?;/),
  grab(/const PL   = .*?;/),
  grab(/const K    = .*?;/),
  grab(/const SEZIONI = \{[\s\S]*?\};/),
  grab(/const PAGE_SIZE\s*= \d+;/),
  grab(/function listaUrl[\s\S]*?\n\}/),
  grab(/function paginaUrl[\s\S]*?\n\}/),
  grab(/function ricercaUrl[\s\S]*?\n\}/),
  grab(/function filtroUrl[\s\S]*?\n\}/),
  grab(/function dettaglioUrl[\s\S]*?\n\}/),
  grab(/function stripTags[\s\S]*?\n\}/),
  grab(/function makeAtto[\s\S]*?\n\}/),
  grab(/function parseListaHtml[\s\S]*?\n\}/),
  grab(/function splitMdRow[\s\S]*?\n\}/),
  grab(/function mdInline[\s\S]*?\n\}/),
  grab(/function parseListaMd[\s\S]*?\n\}/),
  grab(/function parseRigaDettaglio[\s\S]*?\n\}/),
  grab(/function catLabel[\s\S]*?\n\}/)
].join('\n');

const fn = new Function(code + '\nreturn { listaUrl, paginaUrl, ricercaUrl, filtroUrl, dettaglioUrl, parseListaHtml, parseListaMd, parseRigaDettaglio, catLabel };')();
const { listaUrl, paginaUrl, ricercaUrl, dettaglioUrl, parseListaHtml, parseListaMd, parseRigaDettaglio, catLabel } = fn;

/* --- fetch identico a fetchViaProxy di app.js --- */
async function fetchViaProxy(url, { asHtml = false, timeout = 25000 } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeout);
  try {
    const headers = asHtml ? { 'x-return-format': 'html' } : undefined;
    const res = await fetch('https://r.jina.ai/' + encodeURIComponent(url), {
      signal: ctrl.signal, headers
    });
    if (!res.ok) throw new Error('Proxy HTTP ' + res.status);
    return await res.text();
  } finally {
    clearTimeout(timer);
  }
}

let fail = 0;
const ok = (cond, msg) => { console.log((cond ? '  PASS ' : '  FAIL ') + msg); if (!cond) fail++; };

(async () => {
  console.log('--- E2E: lista atti in pubblicazione (HTML via proxy) ---');
  let atti = [];
  try {
    const html = await fetchViaProxy(listaUrl('albo'), { asHtml: true });
    atti = parseListaHtml(html);
  } catch (e) { console.log('  (HTML fallito: ' + e.message + ', provo MD)'); }
  if (!atti.length) {
    const md = await fetchViaProxy(listaUrl('albo'));
    atti = parseListaMd(md) || [];
  }
  ok(atti.length >= 10, 'atti correnti caricati: ' + atti.length);
  if (atti.length) {
    ok(!!atti[0].oggetto, 'primo atto: [' + catLabel(atti[0].categoria) + '] ' + atti[0].oggetto.slice(0, 55) + '…');
  }

  console.log('--- E2E: archivio pagina 2 (scorrimento all\'ingiù) ---');
  let vecchi = [];
  try {
    const html = await fetchViaProxy(paginaUrl(2), { asHtml: true });
    vecchi = parseListaHtml(html);
  } catch (e) { console.log('  (HTML fallito: ' + e.message + ')'); }
  ok(vecchi.length >= 30, 'atti più vecchi caricati: ' + vecchi.length);
  if (atti.length && vecchi.length) {
    ok(vecchi[0].id !== atti[0].id, 'pagina 2 contiene atti diversi (dedup ok)');
  }

  console.log('--- E2E: ricerca «biblioteca» ---');
  let risultati = [];
  try {
    const html = await fetchViaProxy(ricercaUrl('biblioteca'), { asHtml: true });
    risultati = parseListaHtml(html);
  } catch (e) { console.log('  (HTML fallito: ' + e.message + ', provo MD)'); }
  if (!risultati.length) {
    const md = await fetchViaProxy(ricercaUrl('biblioteca'));
    risultati = parseListaMd(md) || [];
  }
  ok(risultati.length >= 5, 'risultati ricerca: ' + risultati.length);
  if (risultati.length) {
    ok(/biblioteca/i.test(risultati[0].oggetto), 'primo risultato pertinente: ' + risultati[0].oggetto.slice(0, 55) + '…');
  }

  console.log('--- E2E: dettaglio atto ' + (atti[0] ? atti[0].id : '1947645') + ' ---');
  const id = atti.length ? atti[0].id : '1947645';
  try {
    const html = await fetchViaProxy(dettaglioUrl(id), { asHtml: true });
    const d = parseRigaDettaglio(html);
    ok(!!d.oggetto && d.oggetto.length > 10, 'oggetto dettaglio: ' + (d.oggetto || '').slice(0, 55) + '…');
    ok(!!d['Proponente'] || !!d['Numero atto'] || !!d['Anno atto'], 'campi chiave presenti (Proponente/Numero/Anno)');
    const all = d.allegati || [];
    console.log('  allegati: ' + all.length);
    for (const a of all) {
      ok(!!a.url, 'allegato «' + a.titolo.slice(0, 40) + '»: url presente');
      if (a.url) {
        ok(!/downloadSigned=true/.test(a.url) || a.soloFirmato,
          '  url principale = PDF non firmato' + (a.soloFirmato ? ' (unica versione disponibile)' : ''));
        ok(!a.urlFirmato || /downloadSigned=true/.test(a.urlFirmato),
          '  versione firmata offerta come link secondario');
      }
    }
    // caso specifico segnalato dall'utente: atto 1947645 (delibera con .p7m + pdf)
    if (String(id) !== '1947645') {
      const html2 = await fetchViaProxy(dettaglioUrl('1947645'), { asHtml: true });
      const d2 = parseRigaDettaglio(html2);
      const a1 = (d2.allegati || [])[0];
      ok(!!a1 && !!a1.url && /downloadSigned=false/.test(a1.url),
        'atto 1947645: allegato principale è il PDF non firmato');
      ok(!!a1 && !!a1.urlFirmato, 'atto 1947645: versione firmata presente come alternativa');
    }
  } catch (e) {
    ok(false, 'dettaglio: ' + e.message);
  }

  console.log(fail ? ('\n' + fail + ' TEST E2E FALLITI') : '\nTUTTI I TEST E2E PASSANO');
  process.exit(fail ? 1 : 0);
})();
