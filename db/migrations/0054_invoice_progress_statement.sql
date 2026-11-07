-- An issued invoice can bill an approved progress statement (SAL): one invoice per statement.
-- Only draft statements can be deleted, so a billed statement stays; the check is deferred
-- when a whole company is deleted, as in 0038 and 0045.
-- The column sits on a table already under RLS: no new policy or privilege is needed.

alter table public.progress_statements
  add constraint progress_statements_company_id_key unique (company_id, id);

alter table public.invoices
  add column progress_statement_id uuid,
  add constraint invoices_progress_statement_fkey foreign key (company_id, progress_statement_id)
    references public.progress_statements (company_id, id) deferrable initially immediate,
  add constraint invoices_progress_statement_issued_check
    check (progress_statement_id is null or direction = 'issued');

create unique index invoices_progress_statement_idx on public.invoices (progress_statement_id)
  where progress_statement_id is not null;

create function app.defer_invoice_statement_check() returns trigger
  language plpgsql
  set search_path = pg_catalog, public
as $$
begin
  set constraints public.invoices_progress_statement_fkey deferred;
  return old;
end
$$;

create trigger companies_defer_invoice_statement_check before delete on public.companies
  for each row execute function app.defer_invoice_statement_check();
