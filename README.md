# Gestionale edile — backend

API del gestionale per imprese edili. Il frontend è in [Affarin-pompe/gestionale-edile](https://github.com/Affarin-pompe/gestionale-edile) e parla con questo backend solo attraverso il contratto OpenAPI.

## Stato

Il [piano](docs/piano.md) è tutto spuntato, compresa la prova dell'immagine Docker (6 novembre 2026). Il dettaglio di ogni compito, con le decisioni prese, è lì.

| Area | Stato |
|---|---|
| Accesso: CSRF, login, logout, sessioni, limite ai tentativi | Fatto |
| `GET /api/me`: aziende, ruolo e permessi | Fatto |
| Isolamento tra aziende (Row Level Security) | Fatto, con test avversario |
| Clienti e fornitori, con documenti di regolarità (DURC, visura, assicurazione) e scadenze | Fatto |
| Scadenziario: intervalli, filtri, ricorrenze, riepilogo, calendario iCalendar | Fatto |
| Computo metrico: capitoli, voci, misure, totali, riordino, copia, PDF e CSV | Fatto |
| Preventivi: numerazione senza buchi, righe, IVA e nature, revisioni, esito, PDF | Fatto |
| Cantieri, squadra, cronoprogramma, documenti e foto, cartello di cantiere | Fatto |
| Dipendenti e mezzi: anagrafica, documenti, assenze e ferie, manutenzioni e rifornimenti | Fatto |
| Rapportini, giornale dei lavori, ore per cantiere e fogli ore | Fatto |
| Costi e margine del cantiere, SAL con ritenuta di garanzia | Fatto |
| Prezzari, acquisti, magazzino | Fatto |
| Fatture (registro, senza SDI), incassi e pagamenti, estratti conto, previsione di cassa | Fatto |
| Dashboard, ricerca rapida, importazione ed esportazione CSV, registro delle modifiche | Fatto |
| Impostazioni azienda, utenti e ruoli, inviti, profilo, password dimenticata, cambio email | Fatto |
| Invio delle email con Brevo (senza chiave restano nel log) | Fatto; configurazione in [docs/rilascio.md](docs/rilascio.md) |
| Controllo di salute (`/api/health`), immagine Docker | Fatto e provato; rilascio in [docs/rilascio.md](docs/rilascio.md) |

## Stack

- **Node 22 o più recente, TypeScript, Fastify 5.**
- **Postgres 17** con Row Level Security su ogni tabella delle aziende.
- **SQL scritto a mano**, con `pg`, senza ORM. Le policy e i privilegi sono la parte che conta e si leggono meglio così.
- **Sessioni nostre:** argon2id per le password, token opaco nel cookie e solo la sua impronta nel database.

## Contratto

`contract/openapi.yaml` è la PR #7 del frontend **più le modifiche proposte nel commento del 4 novembre**:
- risposta `403` con `code: csrf_invalid`;
- slug riservati, da 3 a 50 caratteri;
- `ETag`, `If-Match`, `412` e `428` sulla modifica;
- tipo `public_body`, campo `country`, regole sui documenti obbligatori;
- `code` facoltativo negli errori;
- `422` sui parametri sbagliati dell'elenco.

Quando la PR #7 viene aggiornata, questo file si sostituisce con quello concordato. **I test controllano ogni risposta contro il contratto:** se il backend se ne allontana, falliscono.

## Come è fatto

```
db/migrations/      schema, Row Level Security, privilegi. SQL a mano, applicato in ordine
scripts/migrate.ts  crea i ruoli e applica le migrazioni
scripts/seed-dev.ts dati di sviluppo, gli stessi dei mock del frontend
src/app.ts          server: sessione, errori, rotte
src/config.ts       configurazione dalle variabili d'ambiente
src/db.ts           i due pool e withIdentity()
src/auth/           password, sessioni, CSRF, limite ai tentativi
src/http/           errori nel formato del contratto, contesto della richiesta, file
src/mail/           invio delle email: Brevo, oppure il log in sviluppo
src/money.ts        importi: stringhe nel contratto, centesimi nel database
src/pdf/            PDF (preventivi, computi, SAL, rapportini, ordini, estratti conto)
src/routes/         un file di rotte per area; la validazione sta nella cartella dell'area
                    (src/clients/, src/suppliers/, src/deadlines/, src/estimates/, src/quotes/…)
test/               test di integrazione su un database usa e getta
```

**Isolamento tra aziende.** Ogni query delle aziende gira in una transazione che dichiara utente e azienda (`withIdentity`, `set_config(..., true)`). Le policy mostrano i clienti solo se l'utente fa parte dell'azienda dichiarata. Senza dichiarazione non si vede niente: un errore nel codice dà zero righe, mai le righe di un altro.

**Tre ruoli di database:**

| Ruolo | Può |
|---|---|
| `gestionale_owner` | Tutto: solo migrazioni e dati di sviluppo |
| `gestionale_app` | Dati delle aziende, soggetto alla RLS. Non vede password né sessioni |
| `gestionale_auth` | Solo utenti, sessioni e tentativi di accesso. Non vede i dati delle aziende |

**CSRF.** Si usa il "double submit" firmato: il token è `nonce.HMAC(segreto, sessione|nonce)`. Prima dell'accesso è legato a un cookie HttpOnly di pre-sessione, dopo alla sessione. Un token di un'altra sessione non vale, anche se header e cookie coincidono.

**Sessioni.** Durano 14 giorni di inattività. A ogni accesso se ne apre una nuova e quella precedente del browser si chiude.

**Limite ai tentativi.** Dopo 5 errori in 15 minuti su un'email, o 30 da un indirizzo, la risposta è `429` con `Retry-After`. Il conteggio sta nel database, quindi vale anche dopo un riavvio.

## Sviluppo

Servono Node 22 o più recente e Docker.

```bash
cp .env.example .env     # sostituisci ogni CHANGE_ME con valori casuali
npm ci
npm run db:up            # Postgres su 127.0.0.1:5434
npm run db:migrate
npm run db:seed          # aziende e utenti dei mock del frontend, password cantiere-demo
npm run dev              # API su http://127.0.0.1:3100
```

Controlli, gli stessi della CI:

```bash
npm run lint
npm run format:check
npm run typecheck
npm test                 # crea e migra il database gestionale_test, non tocca quello di sviluppo
                         # TEST_DB=gestionale_test_b npm test per lanciarne due insieme sullo stesso Postgres
npm run build
```

Per provare il frontend contro questo backend, il server di sviluppo di Vite deve inoltrare `/api` a `http://127.0.0.1:3100`: frontend e API devono stare sullo stesso dominio, come chiede la sessione a cookie.

## Regole

- Ogni cambio di API passa prima dal contratto.
- Ogni tabella con dati di un'azienda ha `company_id`, la RLS attiva e un caso in `test/rls.test.ts`.
- Mai query sui dati delle aziende fuori da `withIdentity()`.
- Le migrazioni non si modificano dopo essere state applicate: se ne aggiunge una nuova.
- Dipendenze a versione esatta, uscite da almeno 7 giorni.
- Ogni bug corretto lascia un test che fallirebbe senza la correzione.
