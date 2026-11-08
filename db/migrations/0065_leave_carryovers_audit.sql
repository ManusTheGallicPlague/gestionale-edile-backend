-- Change log also for the vacation carried over: it decides the payslip like the absences.
-- The carry-overs have no id of their own, so a change is logged as a change of the employee,
-- field leave_carryover, without the value. When the carry-over goes because the employee
-- (or the company) is deleted, the delete of the employee is already logged: nothing more.

create function app.audit_leave_carryover() returns trigger
language plpgsql security definer
set search_path = pg_catalog, public
as $$
declare
  actor uuid := nullif(current_setting('app.user_id', true), '')::uuid;
  row_company uuid;
  row_employee uuid;
begin
  if tg_op = 'DELETE' then
    row_company := old.company_id;
    row_employee := old.employee_id;
    if not exists (select 1 from public.employees where id = row_employee) then
      return null;
    end if;
  else
    row_company := new.company_id;
    row_employee := new.employee_id;
    if tg_op = 'UPDATE' and new.days = old.days and new.year = old.year then
      return null;
    end if;
  end if;
  insert into public.audit_log (company_id, entity, entity_id, action, fields, user_id)
  values (row_company, 'employee', row_employee, 'update', array['leave_carryover'], actor);
  return null;
end
$$;
revoke all on function app.audit_leave_carryover() from public;

create trigger employee_leave_carryovers_audit
  after insert or update or delete on public.employee_leave_carryovers
  for each row execute function app.audit_leave_carryover();
