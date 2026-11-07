-- Retention (ritenuta di garanzia) of a progress statement: the share of the amount of this
-- statement that the client keeps until the end of the works. Zero for the statements
-- written before this migration.

alter table public.progress_statements
  add column retention_percent numeric(5,2) not null default 0
    check (retention_percent between 0 and 100);
