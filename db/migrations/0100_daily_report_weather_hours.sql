-- Hours lost to bad weather in the hours of people in a daily report: the part of the normal day
-- the employee did not work because of rain, snow or frost. The payroll consultant asks for them
-- every month for the wage integration for bad weather (cassa integrazione per intemperie). They
-- are not worked hours: hours stays what was worked, costs do not change.

alter table public.daily_report_labor
  add column weather_hours numeric(4, 2) not null default 0,
  add constraint daily_report_labor_weather_hours_check
    check (weather_hours >= 0 and hours + weather_hours <= 24);

grant update (weather_hours) on public.daily_report_labor to gestionale_app;

-- The change log of the rows of the report notes the lost hours too.
drop trigger daily_report_labor_audit on public.daily_report_labor;
create trigger daily_report_labor_audit
  after insert or update of hours, overtime_hours, travel, weather_hours, description, position
    or delete
  on public.daily_report_labor
  for each row
  execute function app.audit_child_row('daily_report', 'daily_reports', 'report_id', 'labor');
