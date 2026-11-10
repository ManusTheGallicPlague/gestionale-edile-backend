-- Change log also for the company's access: who created, renamed or deleted a role, who changed
-- its permissions, who gave a user another role, who deactivated or reactivated them.

alter table public.audit_log drop constraint audit_log_entity_check;
alter table public.audit_log add constraint audit_log_entity_check
  check (entity in (
    'client', 'supplier', 'deadline', 'estimate', 'quote', 'site', 'employee', 'vehicle',
    'daily_report', 'site_cost', 'site_document', 'purchase_order', 'warehouse_item', 'invoice',
    'progress_statement', 'price_list', 'site_activity', 'employee_absence', 'vehicle_maintenance',
    'vehicle_refueling', 'vehicle_document', 'employee_document', 'invoice_payment',
    'supplier_document', 'warehouse_movement', 'role', 'user'
  ));

-- Roles have their own id: the usual trigger (name only; permissions below).
create trigger roles_audit
  after insert or update or delete on public.roles
  for each row execute function app.audit_row('role');

-- A permission added to or removed from a role is a change of the role, field "permissions".
-- One entry per role and transaction: a rename in the same transaction gets the field added
-- to its own entry. Nothing for the permissions of a role created in the same transaction,
-- nor for those deleted together with their role.
create function app.audit_role_permission() returns trigger
language plpgsql security definer
set search_path = pg_catalog, public
as $$
declare
  rid uuid := case when tg_op = 'DELETE' then old.role_id else new.role_id end;
  cid uuid;
  actor uuid := nullif(current_setting('app.user_id', true), '')::uuid;
  entry bigint;
begin
  select company_id into cid from public.roles where id = rid;
  if cid is null then
    return null;
  end if;
  if exists (
    select 1 from public.audit_log
    where entity = 'role' and entity_id = rid and action = 'create' and created_at = now()
  ) then
    return null;
  end if;
  select id into entry from public.audit_log
  where entity = 'role' and entity_id = rid and action = 'update' and created_at = now()
  order by id desc limit 1;
  if entry is null then
    insert into public.audit_log (company_id, entity, entity_id, action, fields, user_id)
    values (cid, 'role', rid, 'update', array['permissions'], actor);
  else
    update public.audit_log
    set fields = array(select distinct f from unnest(fields || array['permissions']) f order by f)
    where id = entry;
  end if;
  return null;
end
$$;
revoke all on function app.audit_role_permission() from public;

create trigger role_permissions_audit
  after insert or delete on public.role_permissions
  for each row execute function app.audit_role_permission();

-- Memberships have no id of their own: the entry is about the user, as in …/users/{user}.
create function app.audit_membership() returns trigger
language plpgsql security definer
set search_path = pg_catalog, public
as $$
declare
  actor uuid := nullif(current_setting('app.user_id', true), '')::uuid;
  changed text[] := '{}';
begin
  if tg_op = 'INSERT' then
    insert into public.audit_log (company_id, entity, entity_id, action, user_id)
    values (new.company_id, 'user', new.user_id, 'create', actor);
  elsif tg_op = 'DELETE' then
    insert into public.audit_log (company_id, entity, entity_id, action, user_id)
    values (old.company_id, 'user', old.user_id, 'delete', actor);
  else
    if new.disabled_at is distinct from old.disabled_at then
      changed := changed || 'disabled_at'::text;
    end if;
    if new.role_id is distinct from old.role_id then
      changed := changed || 'role_id'::text;
    end if;
    if cardinality(changed) > 0 then
      insert into public.audit_log (company_id, entity, entity_id, action, fields, user_id)
      values (new.company_id, 'user', new.user_id, 'update', changed, actor);
    end if;
  end if;
  return null;
end
$$;
revoke all on function app.audit_membership() from public;

create trigger memberships_audit
  after insert or update or delete on public.memberships
  for each row execute function app.audit_membership();
