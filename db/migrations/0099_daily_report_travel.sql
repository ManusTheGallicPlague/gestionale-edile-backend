-- Travel (trasferta) in the hours of people in a daily report: the employee worked away from the
-- usual area that day, which the payroll consultant pays as a travel allowance. A flag per day,
-- not an amount: the allowance depends on the national contract, not on the report.

alter table public.daily_report_labor
  add column travel boolean not null default false;

grant update (travel) on public.daily_report_labor to gestionale_app;

-- The change log of the rows of the report notes the flag too.
drop trigger daily_report_labor_audit on public.daily_report_labor;
create trigger daily_report_labor_audit
  after insert or update of hours, overtime_hours, travel, description, position or delete
  on public.daily_report_labor
  for each row
  execute function app.audit_child_row('daily_report', 'daily_reports', 'report_id', 'labor');
