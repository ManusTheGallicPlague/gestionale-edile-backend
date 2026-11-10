-- The hourly cost of people and vehicles is fixed when a daily report is approved: raising the
-- hourly cost of an employee in January must not change the costs of the sites closed in
-- December. The cost is copied on approval and cleared when the report goes back to draft;
-- null means "not fixed" and the current hourly cost is used, as before (reports approved
-- before this migration, or approved while the hourly cost was missing).
-- The copy is made by a trigger on the status, so no path of the API can approve without it,
-- and gestionale_app cannot write the column.

alter table public.daily_report_labor
  add column hourly_cost_cents bigint check (hourly_cost_cents >= 0);
alter table public.daily_report_vehicles
  add column hourly_cost_cents bigint check (hourly_cost_cents >= 0);

create function app.fix_daily_report_hourly_costs() returns trigger
language plpgsql security definer
set search_path = pg_catalog, public
as $$
begin
  if new.status = 'approved' then
    update public.daily_report_labor l
    set hourly_cost_cents = e.hourly_cost_cents
    from public.employees e
    where l.report_id = new.id and e.id = l.employee_id
      and l.hourly_cost_cents is distinct from e.hourly_cost_cents;
    update public.daily_report_vehicles v
    set hourly_cost_cents = m.hourly_cost_cents
    from public.vehicles m
    where v.report_id = new.id and m.id = v.vehicle_id
      and v.hourly_cost_cents is distinct from m.hourly_cost_cents;
  elsif old.status = 'approved' then
    update public.daily_report_labor set hourly_cost_cents = null
    where report_id = new.id and hourly_cost_cents is not null;
    update public.daily_report_vehicles set hourly_cost_cents = null
    where report_id = new.id and hourly_cost_cents is not null;
  end if;
  return null;
end
$$;
revoke all on function app.fix_daily_report_hourly_costs() from public;

create trigger daily_reports_hourly_costs
  after update of status on public.daily_reports
  for each row
  when (old.status is distinct from new.status
        and (new.status = 'approved' or old.status = 'approved'))
  execute function app.fix_daily_report_hourly_costs();

-- The copy is not a change of the report: the change log of its rows ignores the column.
drop trigger daily_report_labor_audit on public.daily_report_labor;
create trigger daily_report_labor_audit
  after insert or update of hours, overtime_hours, description, position or delete
  on public.daily_report_labor
  for each row
  execute function app.audit_child_row('daily_report', 'daily_reports', 'report_id', 'labor');
drop trigger daily_report_vehicles_audit on public.daily_report_vehicles;
create trigger daily_report_vehicles_audit
  after insert or update of hours, description, position or delete
  on public.daily_report_vehicles
  for each row
  execute function app.audit_child_row('daily_report', 'daily_reports', 'report_id', 'vehicles');
