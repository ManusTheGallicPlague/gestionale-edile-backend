-- Hours of leave (permessi, ROL and former holidays) not taken and carried over into a year,
-- next to the vacation days: the payslip shows both. Either part may be missing, not both.
-- The table keeps its RLS policies and privileges; the audit trigger now also notices a
-- change of the hours.

alter table public.employee_leave_carryovers
  alter column days drop not null,
  add column permit_hours numeric(6, 2)
    check (permit_hours is null or permit_hours between -2000 and 2000),
  add constraint employee_leave_carryovers_something
    check (days is not null or permit_hours is not null);

create or replace function app.audit_leave_carryover() returns trigger
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
    if tg_op = 'UPDATE' and new.days is not distinct from old.days
      and new.permit_hours is not distinct from old.permit_hours and new.year = old.year then
      return null;
    end if;
  end if;
  insert into public.audit_log (company_id, entity, entity_id, action, fields, user_id)
  values (row_company, 'employee', row_employee, 'update', array['leave_carryover'], actor);
  return null;
end
$$;
revoke all on function app.audit_leave_carryover() from public;
