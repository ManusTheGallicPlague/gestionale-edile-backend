-- Day of the local patron saint (MM-DD), a holiday where the company works: the working days
-- of the absences leave it out like the national holidays. Optional. The table keeps its
-- RLS policies and privileges.

alter table public.company_profiles
  add column patron_saint_day text
    check (patron_saint_day is null
      or (patron_saint_day ~ '^\d{2}-\d{2}$'
        and to_char(to_date('2001-' || patron_saint_day, 'YYYY-MM-DD'), 'MM-DD') = patron_saint_day));
