-- Change log also for progress statements (SAL), price lists and schedule activities: the SAL
-- is approved and invoiced, so who changed it matters as much as for the other documents.

alter table public.audit_log drop constraint audit_log_entity_check;
alter table public.audit_log add constraint audit_log_entity_check
  check (entity in (
    'client', 'supplier', 'deadline', 'estimate', 'quote', 'site', 'employee', 'vehicle',
    'daily_report', 'site_cost', 'site_document', 'purchase_order', 'warehouse_item', 'invoice',
    'progress_statement', 'price_list', 'site_activity'
  ));

create trigger progress_statements_audit
  after insert or update or delete on public.progress_statements
  for each row execute function app.audit_row('progress_statement');
create trigger price_lists_audit after insert or update or delete on public.price_lists
  for each row execute function app.audit_row('price_list');
create trigger site_activities_audit after insert or update or delete on public.site_activities
  for each row execute function app.audit_row('site_activity');
