-- Change log also for the rows inside a document: quote lines, price list items and the tree of
-- an estimate (chapters, items, measurements). They are an update of the document with one field
-- ("lines", "items", "structure"), one entry per document and transaction, merged with the entry
-- of the document itself, as the team of a site. Nothing is logged while the document is being
-- created (a revision of a quote copies its lines) or deleted with it.
-- Arguments: entity of the document, its table, the column of the row pointing to it, the field.

create function app.audit_child_row() returns trigger
language plpgsql security definer
set search_path = pg_catalog, public
as $$
declare
  entity_name constant text := tg_argv[0];
  parent_table constant text := tg_argv[1];
  parent_column constant text := tg_argv[2];
  field constant text := tg_argv[3];
  ignored constant text[] := array['version', 'created_at', 'updated_at'];
  row_data jsonb := case when tg_op = 'DELETE' then to_jsonb(old) else to_jsonb(new) end;
  pid uuid := (row_data ->> parent_column)::uuid;
  cid uuid;
  actor uuid := nullif(current_setting('app.user_id', true), '')::uuid;
  entry bigint;
begin
  if tg_op = 'UPDATE' and not exists (
    select 1 from jsonb_object_keys(row_data) k
    where k <> all (ignored) and row_data -> k is distinct from to_jsonb(old) -> k
  ) then
    return null;
  end if;
  execute format('select company_id from public.%I where id = $1', parent_table)
    into cid using pid;
  if cid is null then
    return null;
  end if;
  if exists (
    select 1 from public.audit_log
    where company_id = cid and entity = entity_name and entity_id = pid and action = 'create'
      and created_at = now()
  ) then
    return null;
  end if;
  select id into entry from public.audit_log
  where company_id = cid and entity = entity_name and entity_id = pid and action = 'update'
    and created_at = now()
  order by id desc limit 1;
  if entry is null then
    insert into public.audit_log (company_id, entity, entity_id, action, fields, user_id)
    values (cid, entity_name, pid, 'update', array[field], actor);
  elsif not (select field = any (fields) from public.audit_log where id = entry) then
    update public.audit_log
    set fields = array(select distinct f from unnest(fields || array[field]) f order by f)
    where id = entry;
  end if;
  return null;
end
$$;
revoke all on function app.audit_child_row() from public;

create trigger quote_lines_audit
  after insert or update or delete on public.quote_lines
  for each row
  execute function app.audit_child_row('quote', 'quotes', 'quote_id', 'lines');
create trigger price_list_items_audit
  after insert or update or delete on public.price_list_items
  for each row
  execute function app.audit_child_row('price_list', 'price_lists', 'price_list_id', 'items');
create trigger estimate_chapters_audit
  after insert or update or delete on public.estimate_chapters
  for each row
  execute function app.audit_child_row('estimate', 'estimates', 'estimate_id', 'structure');
create trigger estimate_items_audit
  after insert or update or delete on public.estimate_items
  for each row
  execute function app.audit_child_row('estimate', 'estimates', 'estimate_id', 'structure');
create trigger estimate_measurements_audit
  after insert or update or delete on public.estimate_measurements
  for each row
  execute function app.audit_child_row('estimate', 'estimates', 'estimate_id', 'structure');
