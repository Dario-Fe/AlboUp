# AlboUp 🏛️

**Gli atti del Comune, facilmente accessibili.**

Web app (HTML + CSS + JavaScript puri, zero dipendenze) per leggere in modo
semplice e moderno l'**Albo Pretorio del Comune di Verbania**, i cui dati
istituzionali sono nascosti in sottopagine e tabelle complesse.
Disponibile su: [alboupob.netlify.app](https://alboup.netlify.app/)

**Ispirazione**: [job-up.netlify.app](https://job-up.netlify.app/)

## Come funziona

- **Lista immediata**: ogni atto mostra subito il concetto fondamentale
  (tipo, oggetto sintetico, numero, data, allegati, flag "nuovo").
- Parte della suite *Up (BenzUp, JobUp, AlboUp).
- **Scheda dettaglio**: un tap/click apre la scheda completa
  (numero atto e di registro, proponente, dirigente, esecutività,
  classifica, periodo di pubblicazione, allegati scaricabili) con il link
  alla **pagina ufficiale** dell'atto sul sito del Comune.
- **Tre sezioni**: In pubblicazione · Archivio · Matrimoni.
- **Ricerca** nell'intero archivio per oggetto (es. "biblioteca", "lavori
  pubblici", un CIG).
- **Filtri rapidi** per tipo atto: Determinazioni, Delibere, Decreti,
  Ordinanze, Atti vari.
- **Scorrimento all'ingiù**: il pulsante "Carica altri atti" aggiunge gli
  atti progressivamente più vecchi (pagine da 50), facendo posto ai nuovi.
- **Tema chiaro/scuro**, cache locale per apertura istantanea e link
  diretto a ogni atto (`#atto-<id>`, condivisibile).
- **Installabile come app** (PWA): manifest + icona, splash animato con
  l'icona durante l'avvio e la pagina **Info utili** con le istruzioni
  (`infoutili.html`, collegata nell'header sotto "Sito ufficiale").

## Origine dei dati

Il portale istituzionale (Liferay + portlet jCityGov) non espone API né
header CORS. L'app chiama gli stessi endpoint **GET** della pagina
ufficiale tramite il proxy pubblico `r.jina.ai` (con fallback
`X-Return-Format: html` e parser Markdown di riserva):

| Funzione | Endpoint |
|---|---|
| Atti in pubblicazione | `/web/trasparenza/papca-ap/-/papca/igrid/32156` |
| Storico atti | `…action=eseguiPaginazione&hidden_page_size=50&hidden_page_to=N` |
| Pubblicazioni di matrimonio | `/web/trasparenza/papca-ap/-/papca/igrid/32263` |
| Ricerca per oggetto | `…action=eseguiOrdinamentoLista&simpleSearchEnable=true&mostraSoloLista=true&oggetto=<q>` |
| Filtro per categoria | `…action=eseguiFiltro&categoriaId=<id>` |
| Dettaglio atto | `/web/trasparenza/papca-ap/-/papca/display/<id>` |

Tutti gli endpoint sono stati verificati senza sessione/cookie e i parser
sono coperti da test sui dati reali (vedi sotto).

## Uso

- `index.html` — webapp
- `infoutili.html` — pagina "Info utili" (come funziona, installazione,
  trasparenza)
- `manifest.json`, `icon.svg`, `icon-maskable.svg` — PWA (nome, icone,
  tema, avvio standalone)

Aprire `index.html` — non serve build né server. Per l'esperienza completa
(tema, cache, cronologia, installazione come app) serve servire i file via
HTTP, ad esempio:

```bash
npx serve .          # oppure: python -m http.server 8080
```

## Deploy

È statico: funziona su **Netlify** (drag & drop della cartella o link al
repo), GitHub Pages, Cloudflare Pages, ecc.

## Test

I test usano Node ed estraggono le funzioni reali da `app.js`:

```bash
node test/parser.test.js   # parser su dati reali salvati (offline)
node test/e2e.test.js      # flusso completo via r.jina.ai (online)
```

## Limiti e note

- App **non ufficiale**: per gli atti fa fede esclusivamente la
  pubblicazione sul sito istituzionale (link presente in ogni scheda).
- `r.jina.ai` è un servizio pubblico con limiti di velocità: la cache
  locale riduce le chiamate; se il proxy è occupato l'app mostra
  l'errore con il link al sito ufficiale.
- **Allegati firmati**: quando un atto è pubblicato in doppia versione,
  l'app propone come pulsante principale il **PDF normale**
  (`downloadSigned=false`, apribile da qualsiasi dispositivo) e come
  link secondario la **versione firmata digitalmente** (`.p7m`,
  pkcs7), che richiede un apposito lettore. Se esiste solo la versione
  firmata, viene mostrata quella con un'avvertenza.
- La ricerca istituzionale copre i contenuti pubblicati; i PDF degli
  allegati restano sul sito ufficiale (l'app fornisce i link diretti).
- **Date degli atti**: la lista usa il **periodo di pubblicazione**
  (colonna ufficiale della tabella), non le date citate nel testo
  dell'oggetto — che possono riferirsi ad atti precedenti (es.
  "REVOCA ORDINANZA … N. 166 DEL 05/03/2026").
- Gli ID di sezione/categoria (igrid, categoriaId) sono configurati in
  testa a `app.js` e aggiornabili se il Comune li modifica.
