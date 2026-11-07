-- A site can be created from an accepted quote (createSiteFromQuote) and keeps the link:
-- one site per quote at most. Only draft quotes can be deleted, so a quote with a site stays;
-- the check is deferred when a whole company is deleted, as in 0038 and 0045.
-- The column sits on a table already under RLS: no new policy or privilege is needed.

alter table public.sites
  add column quote_id uuid,
  add constraint sites_quote_fkey foreign key (company_id, quote_id)
    references public.quotes (company_id, id) deferrable initially immediate;

create unique index sites_quote_idx on public.sites (quote_id) where quote_id is not null;

create function app.defer_site_quote_check() returns trigger
  language plpgsql
  set search_path = pg_catalog, public
as $$
begin
  set constraints public.sites_quote_fkey deferred;
  return old;
end
$$;

create trigger companies_defer_site_quote_check before delete on public.companies
  for each row execute function app.defer_site_quote_check();
