-- Simple recurrences: completing a recurring deadline creates the next one, once.
-- next_deadline_id remembers it, so completing again after a reopen creates no duplicate.

alter table public.deadlines add constraint deadlines_company_id_id_key unique (company_id, id);

alter table public.deadlines
  add column recurrence text check (recurrence in ('monthly', 'quarterly', 'yearly')),
  add column next_deadline_id uuid,
  add constraint deadlines_next_fkey foreign key (company_id, next_deadline_id)
    references public.deadlines (company_id, id) on delete set null (next_deadline_id);
