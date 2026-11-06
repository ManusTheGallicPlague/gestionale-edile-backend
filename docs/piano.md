# Piano del backend

Obiettivo: un backend **completo e funzionante** per il gestionale edile, così che sul frontend ([Affarin-pompe/gestionale-edile](https://github.com/Affarin-pompe/gestionale-edile)) si debba solo costruire l'interfaccia.

I requisiti vengono da `docs/frontend.md` del frontend (percorsi, moduli, priorità). Le priorità chieste dal cliente (novembre 2026) sono: **clienti e fornitori, preventivi, computo metrico, scadenziario**.

Si lavora in ordine: si prende il primo compito non spuntato. Un compito si spunta solo quando contratto, migrazione, codice e test sono in main e tutti i controlli sono verdi.

## Compiti

### 1. Anagrafiche
- [x] Accesso, sessioni, CSRF, `/api/me`
- [x] Clienti: elenco, scheda, creazione, modifica
- [ ] Clienti: archiviazione (`archived_at`, filtro `filter[archived]`, niente cancellazione fisica se ha documenti collegati)
- [ ] Fornitori: come i clienti, più `categories` (es. materiali, noli, subappalto, servizi) e flag `subcontractor`. Permessi `suppliers.view/create/update`
- [ ] Fornitori: documenti di regolarità dei subappaltatori (DURC, visura, assicurazione) con data di scadenza, che alimentano lo scadenziario

### 2. Scadenziario
- [ ] Scadenze: titolo, data, tipo (`durc`, `insurance`, `tax`, `invoice_in`, `invoice_out`, `contract`, `vehicle`, `other`), importo facoltativo, collegamento facoltativo a cliente o fornitore, note, stato (`open`/`done`), `done_at`
- [ ] Elenco con intervallo di date (`filter[from]`, `filter[to]`) per il calendario, filtri per tipo, stato e soggetto; ordinamento per data
- [ ] Ricorrenze semplici (mensile, trimestrale, annuale): completare una scadenza ricorrente crea la successiva
- [ ] Riepilogo per la dashboard: scadute, in scadenza nei prossimi 7 e 30 giorni
- [ ] Le scadenze dei documenti dei fornitori compaiono nello scadenziario

### 3. Computo metrico estimativo
- [ ] Computo: titolo, cliente facoltativo, indirizzo del lavoro, stato, note
- [ ] Struttura ad albero: capitoli (anche annidati) → voci. Voce: codice (es. del prezzario regionale), descrizione, unità di misura, prezzo unitario, ordine
- [ ] Righe di misura per ogni voce: descrizione, parti uguali, lunghezza, larghezza, altezza/peso; quantità = prodotto dei valori presenti; quantità negative ammesse (detrazioni)
- [ ] Totali calcolati dal backend per voce, capitolo e computo. Importi in centesimi interi, quantità in `numeric` con 3 decimali: mai `float`
- [ ] Modifica dell'albero in blocco (riordino, spostamento) con controllo di versione (`If-Match`)
- [ ] Duplicazione di un computo

### 4. Preventivi
- [ ] Preventivo: cliente, numero progressivo per azienda e anno (`2026/001`, assegnato al primo invio, senza buchi), data, validità, stato (`draft`, `sent`, `accepted`, `rejected`, `expired`), oggetto, note e condizioni
- [ ] Righe: descrizione, unità, quantità, prezzo unitario, sconto percentuale, aliquota IVA; righe di solo testo e sezioni
- [ ] Totali: imponibile, IVA per aliquota, totale, calcolati dal backend in centesimi
- [ ] Creazione di un preventivo da un computo (le voci diventano righe)
- [ ] Cambi di stato con le regole (un preventivo inviato non si modifica più, si fa una revisione)
- [ ] Generazione del PDF del preventivo

### 5. Per usarlo davvero
- [ ] Impostazioni azienda: ragione sociale, partita IVA, indirizzo, logo, numerazioni
- [ ] Utenti e ruoli: inviti con link a scadenza (`/invito/:token`), assegnazione del ruolo, ruoli e permessi modificabili dal titolare, disattivazione
- [ ] Profilo: cambio nome e password (con verifica della password attuale; chiude le altre sessioni)
- [ ] Password dimenticata: token a scadenza breve; l'invio dell'email passa da un'interfaccia sostituibile (in sviluppo scrive nel log)
- [ ] Esportazione CSV degli elenchi
- [ ] Registro delle modifiche (chi ha cambiato cosa e quando) sulle entità principali
- [ ] Endpoint di salute (`/api/health`) e documentazione del rilascio (Docker, variabili, migrazioni)

### 6. Fase successiva (solo quando tutto il resto è fatto)
- [ ] Cantieri, rapportini, costi, dipendenti, mezzi, secondo `docs/frontend.md` del frontend

## Decisioni prese

Le scelte fatte senza poter chiedere vanno scritte qui, una riga ciascuna, così si possono rivedere.

- 06/11/2026: importi in centesimi interi (`bigint`), quantità `numeric(14,3)`.

## Registro dei giri

Una riga per giro, la più recente in alto: data e ora UTC, cosa è stato fatto, cosa resta a metà.

- 2026-11-06: primo pezzo (accesso, `/api/me`, clienti), 87 test.
