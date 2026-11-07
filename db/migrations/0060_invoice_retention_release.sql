-- Issued invoice releasing the retention withheld on the SALs of a site, at the end of the
-- works. Only issued, with a site and without a SAL link. The table keeps its RLS policies
-- and privileges.

alter table public.invoices
  add column retention_release boolean not null default false,
  add constraint invoices_retention_release_check check (
    not retention_release
    or (direction = 'issued' and site_id is not null and progress_statement_id is null));
