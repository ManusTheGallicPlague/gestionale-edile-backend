-- The estimate of a site (computo del cantiere): an estimate may belong to one site of the
-- same company. A site with estimates cannot be deleted (it can be closed).

alter table public.estimates add column site_id uuid;
alter table public.estimates add constraint estimates_site_fkey
  foreign key (company_id, site_id) references public.sites (company_id, id) on delete restrict;
create index estimates_site_idx on public.estimates (site_id) where site_id is not null;
