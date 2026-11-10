-- Refunds on credit notes (rimborsi). A credit note written on an invoice already paid does not
-- lower what is left to pay (nothing is left): the money goes back, and the refunds are
-- registered as payments on the note itself, counted with the minus sign. The flag is set when
-- the note is written and never changes. An invoice with refund notes stays paid.
-- The column sits on a table already under RLS: no new policy or privilege is needed.

alter table public.invoices
  add column refund boolean not null default false,
  add constraint invoices_refund_check check (not refund or document_type = 'credit_note');
