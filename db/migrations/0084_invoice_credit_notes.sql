-- Credit notes (note di credito, TD04) in the invoices register. A note is a row of the same
-- table with document_type 'credit_note' and positive amounts: the API counts it with the
-- minus sign wherever invoices are summed. It points to the invoice it credits, of the same
-- company (composite key); an invoice with notes cannot be deleted. The key is checked at the
-- end of the statement (no action, not restrict), so deleting a company, or all its invoices,
-- takes the notes and their invoices together. A note has no payment
-- due date and is never paid by itself: it lowers what is left to pay on its invoice.
-- The columns sit on a table already under RLS: no new policy or privilege is needed.

alter table public.invoices
  add column document_type text not null default 'invoice'
    check (document_type in ('invoice', 'credit_note')),
  add column credited_invoice_id uuid,
  add constraint invoices_credited_invoice_fkey foreign key (company_id, credited_invoice_id)
    references public.invoices (company_id, id),
  add constraint invoices_credit_note_check check (
    (document_type = 'credit_note') = (credited_invoice_id is not null)
    and (document_type = 'invoice' or (due_date is null and paid_on is null
      and progress_statement_id is null and withholding_cents = 0 and not split_payment
      and not retention_release))
  );

create index invoices_credited_invoice_idx on public.invoices (credited_invoice_id)
  where credited_invoice_id is not null;
