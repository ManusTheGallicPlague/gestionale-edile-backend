-- A whole day lost to bad weather: the employee came (or was called) and did not work at all,
-- so the row of the report has no worked hours and only hours lost to bad weather. A row still
-- has to say something: worked hours or lost hours, never both at zero.

alter table public.daily_report_labor
  drop constraint daily_report_labor_hours_check,
  add constraint daily_report_labor_hours_check
    check (hours >= 0 and hours <= 24 and (hours > 0 or weather_hours > 0));
