-- Overtime in the hours of people in a daily report: the part of hours worked beyond the normal
-- day, for the payroll consultant. hours stays the total, so costs and totals do not change.

alter table public.daily_report_labor
  add column overtime_hours numeric(4, 2) not null default 0,
  add constraint daily_report_labor_overtime_check
    check (overtime_hours >= 0 and overtime_hours <= hours);

grant update (overtime_hours) on public.daily_report_labor to gestionale_app;
