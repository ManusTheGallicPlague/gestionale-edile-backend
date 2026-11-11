-- Codes of a public works contract on the site: CIG (codice identificativo di gara, 10
-- characters) and CUP (codice unico di progetto, 15 characters), both optional and stored in
-- capitals without spaces. The table already has RLS and the grants for gestionale_app; the
-- new columns follow them.

alter table public.sites add column cig text;
alter table public.sites add column cup text;
alter table public.sites add constraint sites_cig_check check (cig ~ '^[A-Z0-9]{10}$');
alter table public.sites add constraint sites_cup_check check (cup ~ '^[A-Z0-9]{15}$');
