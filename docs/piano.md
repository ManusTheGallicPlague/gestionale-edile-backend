# Piano del backend

Obiettivo: un backend **completo e funzionante** per il gestionale edile, così che sul frontend ([Affarin-pompe/gestionale-edile](https://github.com/Affarin-pompe/gestionale-edile)) si debba solo costruire l'interfaccia.

I requisiti vengono da `docs/frontend.md` del frontend (percorsi, moduli, priorità). Le priorità chieste dal cliente (novembre 2026) sono: **clienti e fornitori, preventivi, computo metrico, scadenziario**.

Si lavora in ordine: si prende il primo compito non spuntato. Un compito si spunta solo quando contratto, migrazione, codice e test sono in main e tutti i controlli sono verdi.

## Compiti

### 1. Anagrafiche
- [x] Accesso, sessioni, CSRF, `/api/me`
- [x] Clienti: elenco, scheda, creazione, modifica
- [x] Clienti: archiviazione (`archived_at`, filtro `filter[archived]`, niente cancellazione fisica se ha documenti collegati)
- [x] Fornitori: come i clienti, più `categories` (es. materiali, noli, subappalto, servizi) e flag `subcontractor`. Permessi `suppliers.view/create/update`
- [x] Fornitori: documenti di regolarità dei subappaltatori (DURC, visura, assicurazione) con data di scadenza, che alimentano lo scadenziario

### 2. Scadenziario
- [x] Scadenze: titolo, data, tipo (`durc`, `insurance`, `tax`, `invoice_in`, `invoice_out`, `contract`, `vehicle`, `other`), importo facoltativo, collegamento facoltativo a cliente o fornitore, note, stato (`open`/`done`), `done_at`
- [x] Elenco con intervallo di date (`filter[from]`, `filter[to]`) per il calendario, filtri per tipo, stato e soggetto; ordinamento per data
- [x] Ricorrenze semplici (mensile, trimestrale, annuale): completare una scadenza ricorrente crea la successiva
- [x] Riepilogo per la dashboard: scadute, in scadenza nei prossimi 7 e 30 giorni
- [x] Le scadenze dei documenti dei fornitori compaiono nello scadenziario

### 3. Computo metrico estimativo
- [x] Computo: titolo, cliente facoltativo, indirizzo del lavoro, stato, note
- [x] Struttura ad albero: capitoli (anche annidati) → voci. Voce: codice (es. del prezzario regionale), descrizione, unità di misura, prezzo unitario, ordine
- [x] Righe di misura per ogni voce: descrizione, parti uguali, lunghezza, larghezza, altezza/peso; quantità = prodotto dei valori presenti; quantità negative ammesse (detrazioni)
- [x] Totali calcolati dal backend per voce, capitolo e computo. Importi in centesimi interi, quantità in `numeric` con 3 decimali: mai `float`
- [x] Modifica dell'albero in blocco (riordino, spostamento) con controllo di versione (`If-Match`)
- [x] Duplicazione di un computo

### 4. Preventivi
- [x] Preventivo: cliente, numero progressivo per azienda e anno (`2026/001`, assegnato al primo invio, senza buchi), data, validità, stato (`draft`, `sent`, `accepted`, `rejected`, `expired`), oggetto, note e condizioni
- [x] Righe: descrizione, unità, quantità, prezzo unitario, sconto percentuale, aliquota IVA; righe di solo testo e sezioni
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
- 06/11/2026: archiviazione con `POST …/clients/{id}/archive` e `…/restore` (permesso `clients.update`, `If-Match`); archiviare due volte tiene la prima data.
- 06/11/2026: `filter[archived]` accetta solo `true`/`false`, predefinito `false`: l'elenco mostra i soli attivi o i soli archiviati, non entrambi.
- 06/11/2026: `DELETE …/clients/{id}` con permesso nuovo `clients.delete` (solo Titolare nei dati di sviluppo; Ufficio no) e `If-Match`; con documenti collegati risponde `409` `code: has_documents`.
- 06/11/2026: regola per le tabelle future: ogni riferimento a `clients` (e poi `suppliers`) va dichiarato `on delete restrict`, così è il database a impedire la cancellazione di un soggetto con documenti.
- 06/11/2026: un cliente archiviato resta modificabile con `PUT` e leggibile nella scheda.
- 06/11/2026: categorie dei fornitori fisse: `materials`, `rentals`, `subcontracting`, `services`, `other`; un fornitore ne ha zero o più (`text[]`), i doppioni si tolgono.
- 06/11/2026: fornitori senza `kind` e senza codice destinatario (le fatture le riceviamo noi); per quelli italiani serve partita IVA o codice fiscale. Archiviazione ed eliminazione come i clienti, con il permesso in più `suppliers.delete`.
- 06/11/2026: `filter[subcontractor]` e `filter[category]` (una categoria) nell'elenco dei fornitori.
- 06/11/2026: documenti di regolarità come sotto-risorsa `…/suppliers/{id}/documents`, senza paginazione; tipi `durc`, `chamber_extract`, `insurance`, `other` (con descrizione obbligatoria). Leggerli chiede `suppliers.view`, scriverli `suppliers.update`: nessun permesso nuovo.
- 06/11/2026: `status` del documento calcolato dal backend sulla data italiana (`Europe/Rome`): `expired`, `expiring` (entro 30 giorni, oggi compreso), `valid`, `no_expiry`.
- 06/11/2026: per ora niente file allegato ai documenti (PDF del DURC): si aggiungerà con gli allegati, quando servirà l'archivio file.
- 06/11/2026: le date senza ora escono dal database come testo `AAAA-MM-GG` (`::text`), mai come `Date` di JavaScript, per non spostarle col fuso.
- 06/11/2026: nel contratto gli importi sono stringhe `"1234.50"` (come chiede `docs/frontend.md` del frontend), nel database centesimi `bigint`; la conversione è in `src/money.ts`, sulle cifre. In ingresso solo il punto come separatore, niente segno: le scadenze hanno importi non negativi.
- 06/11/2026: le scadenze cambiano stato solo con `POST …/complete` e `…/reopen` (con `If-Match`), non con `PUT`: servirà alle ricorrenze. Permessi nuovi `deadlines.view/create/update/delete`; il Capo cantiere vede le scadenze.
- 06/11/2026: una scadenza punta al massimo a un cliente o a un fornitore, con chiave esterna composta `(company_id, id)` e `on delete restrict`; la risposta porta anche `client`/`supplier` con il nome, per l'elenco senza altre chiamate.
- 06/11/2026: ricorrenza come campo `recurrence` della scadenza (`monthly`, `quarterly`, `yearly` o null). La successiva nasce a `complete`, una volta sola (`next_deadline_id`); riaprire non la cancella. Data successiva = data + intervallo di Postgres: a fine mese si ferma all'ultimo giorno e la catena può scivolare (31/01 → 28/02 → 28/03), scelta semplice accettata.
- 06/11/2026: riepilogo `GET …/deadlines/summary` con conteggio e somma degli importi per scadute, prossimi 7 e prossimi 30 giorni (cumulativi, oggi compreso), solo scadenze aperte, data italiana. I documenti dei fornitori entreranno con il compito successivo.
- 06/11/2026: i documenti dei fornitori con scadenza diventano scadenze vere (`supplier_document_id`), tenute allineate dall'API a ogni salvataggio del documento: titolo «DURC – Fornitore», tipo `durc`/`insurance`/`other`; una nuova data di scadenza riapre la scadenza; senza scadenza o con il documento eliminato la scadenza sparisce. Così elenco, calendario e riepilogo li contano senza casi speciali.
- 06/11/2026: computo metrico: stati `draft` (bozza) e `final` (definitivo); indirizzo del lavoro in un solo campo di testo `site_address`; elenco ordinato per ultima modifica; permessi nuovi `estimates.view/create/update/delete`, il Capo cantiere vede i computi.
- 06/11/2026: elenco delle scadenze con `per_page` al massimo 100 come gli altri; il calendario mensile chiede `filter[from]`/`filter[to]` e, se servono, più pagine.
- 06/11/2026: albero del computo in due tabelle, `estimate_chapters` (con `parent_id`, al massimo 4 livelli) ed `estimate_items`; una voce sta sempre in un capitolo. `GET …/estimates/{id}/structure` restituisce due elenchi piatti ordinati per posizione, l'albero lo ricostruisce il frontend.
- 06/11/2026: capitoli e voci si creano in fondo al loro livello e hanno ognuno la sua versione (`ETag` e campo `version`, per l'`If-Match` dalle righe della tabella). Con `PUT` non si spostano: spostamento e riordino arrivano con la modifica in blocco. Eliminare un capitolo elimina sottocapitoli e voci.
- 06/11/2026: prezzo unitario come gli altri importi (stringa, centesimi, non negativo); le detrazioni passano dalle quantità negative delle misure. Scrivere nell'albero chiede `estimates.update` e aggiorna `updated_at` del computo; anche un computo `final` resta modificabile, per ora.
- 06/11/2026: righe di misura in `estimate_measurements`: fattori `equal_parts`, `length`, `width`, `height` (altezza o peso) `numeric(12,3)`, stringhe nel contratto; serve almeno un fattore; quantità `numeric(14,3)` calcolata dal database come colonna generata (prodotto dei fattori presenti, arrotondato a 3 decimali). Una quantità che non ci sta risponde 422 sul campo `quantity`. Le righe si creano con `item_id` nel corpo e non cambiano voce con `PUT`; arrivano anche in `…/structure`.
- 06/11/2026: totali del computo mai salvati: li calcola la vista `estimate_item_totals` (`security_invoker`, quindi sotto RLS). Quantità della voce = somma delle righe di misura; importo della voce = quantità × prezzo, arrotondato al centesimo (metà lontano da zero) voce per voce; capitoli (sottocapitoli compresi) e computo sommano gli importi arrotondati, in centesimi interi. Gli importi calcolati possono essere negativi (`SignedAmount`). Il totale compare in `…/structure`, in capitoli e voci, nella testata e nell'elenco dei computi.
- 06/11/2026: modifica in blocco con `PUT …/estimates/{id}/structure`: si mandano tutti i capitoli e tutte le voci con il nuovo genitore, l'ordine dell'elenco dà la posizione. Versione dell'albero separata da quella della testata (`structure_version`, ETag di `…/structure`), aumentata da ogni scrittura su capitoli, voci e misure. Spostare non cambia la versione del singolo capitolo o della voce. Il riordino delle righe di misura resta fuori, per ora.
- 06/11/2026: duplicazione con `POST …/estimates/{id}/duplicate` (permessi `estimates.view` ed `estimates.create`, nessuno nuovo): copia testata, capitoli, voci e misure con id nuovi in un solo statement; la copia nasce in bozza con «(copia)» in fondo al titolo (accorciato se serve a stare in 200 caratteri) e lo stesso cliente.
- 06/11/2026: preventivi: cliente obbligatorio (`on delete restrict`); validità come `validity_days` (predefinito 30), `valid_until` calcolata; data (`issue_date`) e numero arrivano con `POST …/quotes/{id}/send`, che usa la data italiana di oggi e il contatore `quote_counters` per azienda e anno, bloccato fino al commit: niente buchi né doppioni, anche con invii concorrenti. Numero `AAAA/NNN` (tre cifre, poi crescono).
- 06/11/2026: un preventivo non in bozza non si modifica né si elimina (409 `quote_not_draft`), così la numerazione resta senza buchi. Permessi nuovi `quotes.view/create/update/delete`; inviare chiede `quotes.update`. Il Capo cantiere non vede i preventivi (prezzi e margini restano all'ufficio). I contatori non si cancellano (manca il privilegio `delete`).
- 06/11/2026: righe del preventivo in `quote_lines` con `kind` `item`/`text`/`section`; solo le `item` hanno unità, quantità (`numeric(14,3)`, anche negativa), prezzo, sconto (`numeric(5,2)`, stringa da 0 a 100) e aliquota (intero tra 22, 10, 5, 4, 0; nature IVA e reverse charge rimandati). Imponibile di riga = quantità × prezzo × (1 − sconto), arrotondato al centesimo dal database. Righe senza paginazione, in fondo alla creazione; il riordino arriverà con un'operazione in blocco. Si scrivono solo in bozza (409 `quote_not_draft`), con `quotes.update`.

## Registro dei giri

Una riga per giro, la più recente in alto: data e ora UTC, cosa è stato fatto, cosa resta a metà.

- 2026-11-06 14:43 UTC: righe del preventivo (contratto, migrazione 0014, sezioni, testo e righe con prezzo, sconto e IVA, imponibile di riga, solo in bozza, dati di sviluppo, test e caso avversario). Niente a metà; prossimo: totali del preventivo (imponibile, IVA per aliquota, totale). 255 test.
- 2026-11-06 14:40 UTC: testata dei preventivi con numerazione al primo invio (contratto, migrazione 0013 con contatore per anno, `send`, permessi `quotes.*`, dati di sviluppo, test anche su invii concorrenti, caso avversario). Niente a metà; prossimo: righe del preventivo. 241 test.
- 2026-11-06 14:37 UTC: duplicazione di un computo (contratto `duplicateEstimate`, copia dell'albero, test). Il computo metrico (sezione 3) è completo. Niente a metà; prossimo: preventivi (testata e numerazione). 228 test.
- 2026-11-06 14:35 UTC: modifica dell'albero in blocco (contratto `arrangeEstimateStructure`, migrazione 0012 con `structure_version`, controlli su insiemi, cicli e profondità, test). Niente a metà; prossimo: duplicazione di un computo. 226 test.
- 2026-11-06 14:33 UTC: totali del computo per voce, capitolo e computo (contratto con `SignedAmount`, migrazione 0011 con vista sotto RLS, totale anche in testata ed elenco, test e caso avversario). Niente a metà; prossimo: modifica dell'albero in blocco. 218 test.
- 2026-11-06 14:29 UTC: righe di misura delle voci (contratto, migrazione 0010 con quantità calcolata dal database, CRUD con `If-Match`, misure in `…/structure`, dati di sviluppo, test e caso avversario). Niente a metà; prossimo: totali per voce, capitolo e computo. 215 test.
- 2026-11-06 14:22 UTC: struttura ad albero del computo (contratto, migrazione 0009 con capitoli annidati e voci, `…/structure`, CRUD di capitoli e voci con `If-Match`, dati di sviluppo, test e caso avversario). Niente a metà; prossimo: righe di misura. 202 test.
- 2026-11-06 13:46 UTC: testata del computo metrico (migrazione 0008, CRUD, permessi `estimates.*`, test e caso avversario). Niente a metà; prossimo: struttura ad albero (capitoli e voci). 188 test.
- 2026-11-06 13:43 UTC: documenti dei fornitori nello scadenziario (migrazione 0007). Lo scadenziario (sezione 2) è completo. Niente a metà; prossimo: computo metrico. 179 test.
- 2026-11-06 13:42 UTC: riepilogo delle scadenze per la dashboard. Niente a metà; prossimo: documenti dei fornitori nello scadenziario. 177 test.
- 2026-11-06 13:39 UTC: ricorrenze semplici delle scadenze (migrazione 0006, `recurrence`, `next_deadline_id`, test e caso avversario). Niente a metà; prossimo: riepilogo per la dashboard. 174 test.
- 2026-11-06 13:36 UTC: scadenze (contratto, migrazione 0005, importi in centesimi con `src/money.ts`, elenco per intervallo di date e filtri, complete/reopen, permessi `deadlines.*`, dati di sviluppo, test e caso avversario). Niente a metà; prossimo: ricorrenze. 168 test.
- 2026-11-06 13:32 UTC: documenti di regolarità dei fornitori (contratto, migrazione 0004 con chiave esterna composta, stato calcolato, test e caso avversario). Il collegamento allo scadenziario si fa con il compito «Le scadenze dei documenti dei fornitori compaiono nello scadenziario». Prossimo: scadenze. 130 test.
- 2026-11-06 13:29 UTC: fornitori (contratto, migrazione 0003, permessi `suppliers.*`, dati di sviluppo, test e caso avversario). Niente a metà; prossimo compito: documenti di regolarità dei subappaltatori. 119 test.
- 2026-11-06 13:21 UTC: archiviazione ed eliminazione dei clienti (contratto, migrazione 0002, permesso `clients.delete`, test). Niente a metà; prossimo compito: fornitori. 98 test.
- 2026-11-06: primo pezzo (accesso, `/api/me`, clienti), 87 test.
