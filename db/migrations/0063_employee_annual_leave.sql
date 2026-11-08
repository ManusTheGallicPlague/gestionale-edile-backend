-- Working days of vacation an employee is entitled to in a year, for the remaining vacation
-- of the yearly absence totals. Optional. The table keeps its RLS policies and privileges.

alter table public.employees
  add column annual_leave_days smallint
    check (annual_leave_days is null or annual_leave_days between 0 and 366);
