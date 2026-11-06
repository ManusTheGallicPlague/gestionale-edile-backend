# Istruzioni per chi lavora su questo repository

Backend del gestionale edile. Il piano è in `docs/piano.md`, le regole del progetto nel README («Regole»). Si scrive in italiano: commit, documentazione, messaggi di errore dell'API. I nomi nel codice e nel contratto sono in inglese, come quelli esistenti.

## Regole che non si toccano

- **Il contratto viene prima.** Ogni operazione nuova si aggiunge prima a `contract/openapi.yaml`, con lo stesso stile di quelle esistenti (errori, paginazione, `ETag`/`If-Match`, `code` negli errori). I test controllano ogni risposta contro il contratto con `Browser.call` / `expectContract`.
- **Isolamento tra aziende.** Ogni tabella con dati di un'azienda ha `company_id`, la RLS attiva, i privilegi giusti per `gestionale_app` e un caso avversario in `test/rls.test.ts`. Mai query sui dati delle aziende fuori da `withIdentity()`.
- **Permessi.** Ogni modulo aggiunge i suoi permessi in `src/permissions.ts`, nel contratto (`components.schemas.Permission`) e nei ruoli di `scripts/seed-dev.ts`.
- **Migrazioni solo in aggiunta.** Mai modificare una migrazione già in main: se ne crea una nuova con il numero successivo.
- **Soldi e quantità.** Importi in centesimi interi, quantità `numeric`. Mai `float` per i soldi.
- **Dipendenze** a versione esatta, uscite da almeno 7 giorni. Poche: prima si guarda se basta quello che c'è.
- **Niente segreti** nel repository. Niente nomi di altri prodotti o clienti: il contratto finisce in un repository pubblico.
- **Ogni bug corretto lascia un test** che fallirebbe senza la correzione.
- Non si scrive mai nel repository del frontend: si legge soltanto.

## Controlli

Prima di ogni push devono passare tutti, gli stessi della CI:

```bash
npm run lint && npm run format:check && npm run typecheck && npm test && npm run build
```

I test vogliono Postgres. In un ambiente senza Docker si usa `scripts/cloud-db.sh`, che installa e avvia Postgres e scrive il `.env`.
