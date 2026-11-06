-- Change log: who changed what and when on the main records (clients, suppliers, deadlines,
-- estimates, quotes). Filled by triggers, so no write path of the API can skip it, and
-- append-only: the API role can only read it, under RLS. Only the names of the changed
-- fields are kept, not the values.

create table public.audit_log (
  id bigint generated always as identity primary key,
  -- No foreign key: deleting a company deletes its records, and those deletes are logged too.
  company_id uuid not null,
  entity text not null
    check (entity in ('client', 'supplier', 'deadline', 'estimate', 'quote')),
  entity_id uuid not null,
  action text not null check (action in ('create', 'update', 'delete')),
  fields text[] not null default '{}',
  -- Null when the change did not come through the API (migrations, maintenance).
  user_id uuid,
  created_at timestamptz not null default now()
);
create index audit_log_company_idx on public.audit_log (company_id, id);
create index audit_log_entity_idx on public.audit_log (company_id, entity, entity_id, id);

alter table public.audit_log enable row level security;

create policy audit_log_select on public.audit_log
  for select using (company_id = app.current_company_id());

grant select on public.audit_log to gestionale_app;

-- Columns that change on every write or are bookkeeping: not worth a line in the log.
create function app.audit_row() returns trigger
language plpgsql security definer
set search_path = pg_catalog, public
as $$
declare
  ignored constant text[] := array[
    'id', 'company_id', 'version', 'structure_version', 'created_at', 'updated_at'
  ];
  changed text[];
  old_row jsonb;
  new_row jsonb;
  actor uuid := nullif(current_setting('app.user_id', true), '')::uuid;
begin
  if tg_op = 'INSERT' then
    insert into public.audit_log (company_id, entity, entity_id, action, user_id)
    values (new.company_id, tg_argv[0], new.id, 'create', actor);
    return null;
  elsif tg_op = 'DELETE' then
    insert into public.audit_log (company_id, entity, entity_id, action, user_id)
    values (old.company_id, tg_argv[0], old.id, 'delete', actor);
    return null;
  end if;
  old_row := to_jsonb(old);
  new_row := to_jsonb(new);
  select coalesce(array_agg(k order by k), '{}') into changed
  from jsonb_object_keys(new_row) k
  where k <> all (ignored) and new_row -> k is distinct from old_row -> k;
  -- A write that only touched the bookkeeping columns (e.g. the estimate's updated_at
  -- after a change in its tree) is not a change of the record.
  if cardinality(changed) > 0 then
    insert into public.audit_log (company_id, entity, entity_id, action, fields, user_id)
    values (new.company_id, tg_argv[0], new.id, 'update', changed, actor);
  end if;
  return null;
end
$$;
revoke all on function app.audit_row() from public;

create trigger clients_audit after insert or update or delete on public.clients
  for each row execute function app.audit_row('client');
create trigger suppliers_audit after insert or update or delete on public.suppliers
  for each row execute function app.audit_row('supplier');
create trigger deadlines_audit after insert or update or delete on public.deadlines
  for each row execute function app.audit_row('deadline');
create trigger estimates_audit after insert or update or delete on public.estimates
  for each row execute function app.audit_row('estimate');
create trigger quotes_audit after insert or update or delete on public.quotes
  for each row execute function app.audit_row('quote');

-- Names of the people in the log, also of those who have left the company since: the API
-- role cannot read auth.users. Only users that appear in the declared company's log.
create function app.audit_users(p_ids uuid[])
returns table (user_id uuid, name text)
language sql stable security definer
set search_path = pg_catalog, public
as $$
  select u.id, u.name from auth.users u
  where u.id = any (p_ids)
    and exists (
      select 1 from public.audit_log a
      where a.company_id = app.current_company_id() and a.user_id = u.id
    )
$$;
revoke all on function app.audit_users(uuid[]) from public;
grant execute on function app.audit_users(uuid[]) to gestionale_app;
