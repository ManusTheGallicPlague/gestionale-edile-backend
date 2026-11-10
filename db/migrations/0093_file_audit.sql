-- Change log for the files attached to a record: the logo of the company (field "logo" of
-- company_profile) and the PDF or scan of an invoice and of the documents of suppliers, vehicles
-- and employees (field "file" of the record). Replacing a file is one update; nothing is logged
-- while the record is being created or deleted with its file. Same merging as
-- app.audit_child_row() of 0091, but the row is never turned into JSON: a file can be 20 MB.
-- Arguments: entity of the record, its table, the field.

create function app.audit_file_row() returns trigger
language plpgsql security definer
set search_path = pg_catalog, public
as $$
declare
  entity_name constant text := tg_argv[0];
  parent_table constant text := tg_argv[1];
  field constant text := tg_argv[2];
  pid uuid;
  cid uuid;
  actor uuid := nullif(current_setting('app.user_id', true), '')::uuid;
  entry bigint;
begin
  -- One statement per table: a plpgsql expression resolves every field of the record it names.
  if tg_table_name = 'company_logos' then
    if tg_op = 'DELETE' then pid := old.company_id; else pid := new.company_id; end if;
  elsif tg_table_name = 'invoice_files' then
    if tg_op = 'DELETE' then pid := old.invoice_id; else pid := new.invoice_id; end if;
  elsif tg_op = 'DELETE' then
    pid := old.document_id;
  else
    pid := new.document_id;
  end if;
  execute format('select %s from public.%I where id = $1',
    case when parent_table = 'companies' then 'id' else 'company_id' end, parent_table)
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
revoke all on function app.audit_file_row() from public;

create trigger company_logos_audit
  after insert or update or delete on public.company_logos
  for each row execute function app.audit_file_row('company_profile', 'companies', 'logo');
create trigger invoice_files_audit
  after insert or delete on public.invoice_files
  for each row execute function app.audit_file_row('invoice', 'invoices', 'file');
create trigger supplier_document_files_audit
  after insert or delete on public.supplier_document_files
  for each row
  execute function app.audit_file_row('supplier_document', 'supplier_documents', 'file');
create trigger vehicle_document_files_audit
  after insert or delete on public.vehicle_document_files
  for each row
  execute function app.audit_file_row('vehicle_document', 'vehicle_documents', 'file');
create trigger employee_document_files_audit
  after insert or delete on public.employee_document_files
  for each row
  execute function app.audit_file_row('employee_document', 'employee_documents', 'file');
