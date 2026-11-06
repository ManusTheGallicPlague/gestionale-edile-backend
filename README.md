# Gestionale edile — backend

API del gestionale per imprese edili. Il frontend è in [Affarin-pompe/gestionale-edile](https://github.com/Affarin-pompe/gestionale-edile) e parla con questo backend solo attraverso il contratto OpenAPI.

## Stato

Fatto il primo pezzo del contratto: accesso, `/api/me` e clienti.

| Area | Stato |
|---|---|
| Accesso: CSRF, login, logout, sessioni, limite ai tentativi | Fatto |
| `GET /api/me`: aziende, ruolo e permessi | Fatto |
| Clienti: elenco, scheda, creazione, modifica, archiviazione, eliminazione | Fatto |
| Isolamento tra aziende (Row Level Security) | Fatto, con test avversario |
| Fornitori e subappaltatori: elenco, scheda, creazione, modifica, archiviazione, eliminazione | Fatto |
| Documenti di regolarità dei fornitori (DURC, visura, assicurazione) con scadenza e stato | Fatto |
| Scadenze: elenco per intervallo di date, filtri, creazione, modifica, fatta/riaperta, eliminazione | Fatto |
| Ricorrenze mensili, trimestrali e annuali delle scadenze | Fatto |
| Riepilogo delle scadenze per la dashboard | Fatto |
| Documenti dei fornitori nello scadenziario | Fatto |
| Computo metrico: testata (titolo, cliente, indirizzo, stato) | Fatto |
| Computo metrico: capitoli annidati e voci (codice, descrizione, unità, prezzo) | Fatto |
| Computo metrico: righe di misura con quantità calcolata (anche detrazioni) | Fatto |
| Computo metrico: totali per voce, capitolo e computo, calcolati dal backend | Fatto |
| Computo metrico: riordino e spostamento in blocco con versione dell'albero | Fatto |
| Computo metrico: duplicazione | Fatto |
| Preventivi | Da fare, dopo il contratto |
| Pubblicazione | Da decidere |

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
src/db.ts           i due pool e withIdentity()
src/auth/           password, sessioni, CSRF, limite ai tentativi
src/clients/        validazione dei clienti, partita IVA e codice fiscale
src/suppliers/      validazione dei fornitori
src/deadlines/      validazione delle scadenze
src/money.ts        importi: stringhe nel contratto, centesimi nel database
src/routes/         auth, me, clients, suppliers, supplier-documents, deadlines, estimates,
                    estimate-structure
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
