# Rilascio

Come si mette in produzione il backend. Il frontend è fatto di file statici e va servito **sullo stesso dominio** delle API (la sessione è un cookie `SameSite=Lax`): un proxy inverso manda `/api/*` a questo servizio e il resto ai file del frontend.

## Cosa serve

- Postgres 17 (o 16), con un database vuoto e un ruolo proprietario (`gestionale_owner`) che possa creare ruoli (`CREATEROLE`): le migrazioni creano da sole `gestionale_app` e `gestionale_auth` con le password dell'ambiente.
- L'immagine Docker di questo repository, oppure Node 22 o più recente.
- Un proxy inverso con HTTPS davanti all'API.

## Immagine

```bash
docker build -t gestionale-edile-backend .
```

L'immagine contiene l'API compilata, le sole dipendenze di produzione e le migrazioni. Gira come utente `node`, ascolta sulla porta 3100 e ha un `HEALTHCHECK` su `/api/health`.

## Variabili d'ambiente

Nessun segreto sta nel repository o nell'immagine: si passano all'avvio.

| Variabile | Chi la usa | Valore in produzione |
|---|---|---|
| `DATABASE_URL_APP` | API | `postgres://gestionale_app:<password>@<host>:5432/<db>` |
| `DATABASE_URL_AUTH` | API | `postgres://gestionale_auth:<password>@<host>:5432/<db>` |
| `CSRF_SECRET` | API | almeno 32 caratteri casuali (`openssl rand -base64 48`) |
| `COOKIE_SECURE` | API | `true` (i cookie viaggiano solo su HTTPS) |
| `TRUST_PROXY` | API | `true` se il proxy inverso imposta `X-Forwarded-For`, che serve ai limiti dei tentativi di accesso per indirizzo |
| `APP_URL` | API | indirizzo pubblico del frontend, senza `/` finale: è la base dei link nelle email |
| `HOST`, `PORT` | API | nell'immagine `0.0.0.0` e `3100` |
| `LOG_LEVEL` | API | `info` |
| `DATABASE_URL_OWNER` | migrazioni | `postgres://gestionale_owner:<password>@<host>:5432/<db>` |
| `DB_APP_PASSWORD`, `DB_AUTH_PASSWORD` | migrazioni | le password che le migrazioni danno a `gestionale_app` e `gestionale_auth`: le stesse degli URL sopra |

`DATABASE_URL_OWNER` serve solo alle migrazioni: l'API non deve averla.

## Migrazioni

A ogni rilascio, **prima** di avviare la nuova versione dell'API, con la stessa immagine:

```bash
docker run --rm \
  -e DATABASE_URL_OWNER -e DB_APP_PASSWORD -e DB_AUTH_PASSWORD \
  gestionale-edile-backend node dist/scripts/migrate.js
```

Senza Docker: `npm ci && npm run build && node --env-file=.env dist/scripts/migrate.js`.

Ogni migrazione si applica una volta sola e in una transazione; rilanciarle non fa nulla (`already up to date`). Le migrazioni si aggiungono soltanto, quindi la versione precedente dell'API continua a funzionare sul database migrato finché non viene sostituita. I dati di sviluppo (`db:seed`) **non** vanno mai caricati in produzione.

## Avvio

```bash
docker run -d --name gestionale-api -p 127.0.0.1:3100:3100 \
  -e DATABASE_URL_APP -e DATABASE_URL_AUTH -e CSRF_SECRET \
  -e COOKIE_SECURE=true -e TRUST_PROXY=true -e APP_URL \
  gestionale-edile-backend
```

Senza Docker: `npm ci && npm run build && npm start` (legge `.env` se c'è). L'API si ferma in modo ordinato con `SIGTERM`.

## Controllo di salute

`GET /api/health`, senza sessione: `200 {"status":"ok"}` se l'API raggiunge il database con entrambi i ruoli, `503` con `code: database_unavailable` se non risponde entro 2 secondi. È quello che usano l'`HEALTHCHECK` dell'immagine, il bilanciatore e i controlli di disponibilità.

## Email

Per ora le email (password dimenticata, inviti) sono scritte nel log dell'API (`LogMailer`): finché non si sceglie un fornitore SMTP, i link vanno presi da lì. Un fornitore vero si aggiunge come nuova implementazione di `Mailer` in `src/mail/mailer.ts`.
