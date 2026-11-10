-- Two more recurrences for the deadlines: every six months (fire extinguisher checks) and
-- every two years (vehicle inspection after the first one). Only the check changes: the
-- column sits on a table already under RLS, no new policy or privilege is needed.

alter table public.deadlines
  drop constraint deadlines_recurrence_check,
  add constraint deadlines_recurrence_check
    check (recurrence in ('monthly', 'quarterly', 'semiannual', 'yearly', 'biennial'));
