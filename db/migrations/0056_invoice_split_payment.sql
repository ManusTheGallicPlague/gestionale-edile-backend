-- Split payment (scissione dei pagamenti, art. 17-ter DPR 633/72): on an invoice issued to a
-- public administration the VAT is paid by the customer straight to the treasury, so the
-- amount due leaves it out. Only issued invoices carry it.

alter table public.invoices
  add column split_payment boolean not null default false,
  add constraint invoices_split_payment_issued check (
    not split_payment or direction = 'issued');
