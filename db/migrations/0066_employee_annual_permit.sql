-- Hours of leave (permessi, ROL and former holidays) an employee is entitled to in a year,
-- for the remaining leave of the yearly absence totals. Optional, whole hours. The table
-- keeps its RLS policies and privileges; the audit trigger records the column by name.

alter table public.employees
  add column annual_permit_hours smallint
    check (annual_permit_hours is null or annual_permit_hours between 0 and 2000);
