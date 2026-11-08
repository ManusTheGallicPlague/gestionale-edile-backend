-- Change log also for the documents of the employees: who recorded, renewed or deleted a
-- fitness-for-work certificate or a safety training. As for the other entities, only the names
-- of the changed fields.

alter table public.audit_log drop constraint audit_log_entity_check;
alter table public.audit_log add constraint audit_log_entity_check
  check (entity in (
    'client', 'supplier', 'deadline', 'estimate', 'quote', 'site', 'employee', 'vehicle',
    'daily_report', 'site_cost', 'site_document', 'purchase_order', 'warehouse_item', 'invoice',
    'progress_statement', 'price_list', 'site_activity', 'employee_absence', 'vehicle_maintenance',
    'vehicle_refueling', 'vehicle_document', 'employee_document'
  ));

create trigger employee_documents_audit
  after insert or update or delete on public.employee_documents
  for each row execute function app.audit_row('employee_document');
