-- Change log also for invitations (who invited whom, who withdrew an invitation, when it was
-- accepted) and for the company's details (legal name, VAT number, IBAN of the documents).

alter table public.audit_log drop constraint audit_log_entity_check;
alter table public.audit_log add constraint audit_log_entity_check
  check (entity in (
    'client', 'supplier', 'deadline', 'estimate', 'quote', 'site', 'employee', 'vehicle',
    'daily_report', 'site_cost', 'site_document', 'purchase_order', 'warehouse_item', 'invoice',
    'progress_statement', 'price_list', 'site_activity', 'employee_absence', 'vehicle_maintenance',
    'vehicle_refueling', 'vehicle_document', 'employee_document', 'invoice_payment',
    'supplier_document', 'warehouse_movement', 'role', 'user', 'invitation', 'company_profile'
  ));

create trigger invitations_audit
  after insert or update or delete on public.invitations
  for each row execute function app.audit_row('invitation');

-- The company's details have no id of their own: the entry is about the company. One entry per
-- transaction: a save that also sets the patron saint day is one change, and a first save that
-- sets it is only a creation.
create function app.audit_company_profile() returns trigger
language plpgsql security definer
set search_path = pg_catalog, public
as $$
declare
  ignored constant text[] := array['company_id', 'version', 'created_at', 'updated_at'];
  changed text[];
  old_row jsonb;
  new_row jsonb;
  actor uuid := nullif(current_setting('app.user_id', true), '')::uuid;
  entry bigint;
begin
  if tg_op = 'INSERT' then
    insert into public.audit_log (company_id, entity, entity_id, action, user_id)
    values (new.company_id, 'company_profile', new.company_id, 'create', actor);
    return null;
  elsif tg_op = 'DELETE' then
    insert into public.audit_log (company_id, entity, entity_id, action, user_id)
    values (old.company_id, 'company_profile', old.company_id, 'delete', actor);
    return null;
  end if;
  old_row := to_jsonb(old);
  new_row := to_jsonb(new);
  select coalesce(array_agg(k order by k), '{}') into changed
  from jsonb_object_keys(new_row) k
  where k <> all (ignored) and new_row -> k is distinct from old_row -> k;
  if cardinality(changed) = 0 then
    return null;
  end if;
  if exists (
    select 1 from public.audit_log
    where entity = 'company_profile' and entity_id = new.company_id and action = 'create'
      and created_at = now()
  ) then
    return null;
  end if;
  select id into entry from public.audit_log
  where entity = 'company_profile' and entity_id = new.company_id and action = 'update'
    and created_at = now()
  order by id desc limit 1;
  if entry is null then
    insert into public.audit_log (company_id, entity, entity_id, action, fields, user_id)
    values (new.company_id, 'company_profile', new.company_id, 'update', changed, actor);
  else
    update public.audit_log
    set fields = array(select distinct f from unnest(fields || changed) f order by f)
    where id = entry;
  end if;
  return null;
end
$$;
revoke all on function app.audit_company_profile() from public;

create trigger company_profiles_audit
  after insert or update or delete on public.company_profiles
  for each row execute function app.audit_company_profile();
