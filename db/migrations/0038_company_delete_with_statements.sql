-- Deleting a whole company failed when it had progress statements with lines: the cascade
-- removed the estimate items before the statement lines, and the "no action" check of
-- progress_statement_lines_item_fkey (0036) fired in between. The two protecting foreign
-- keys become deferrable, still checked at once in normal use (the API keeps answering
-- 409 has_documents), and deleting a company defers them to the end of the transaction,
-- when the statements are gone as well.

alter table public.progress_statements
  alter constraint progress_statements_estimate_fkey deferrable initially immediate;
alter table public.progress_statement_lines
  alter constraint progress_statement_lines_item_fkey deferrable initially immediate;

create function app.defer_statement_checks() returns trigger
  language plpgsql
  set search_path = pg_catalog, public
as $$
begin
  set constraints public.progress_statements_estimate_fkey,
    public.progress_statement_lines_item_fkey deferred;
  return old;
end
$$;

create trigger companies_defer_statement_checks before delete on public.companies
  for each row execute function app.defer_statement_checks();
