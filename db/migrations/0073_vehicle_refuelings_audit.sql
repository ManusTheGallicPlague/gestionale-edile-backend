-- Change log also for the refuelings of the vehicles: who recorded, changed or deleted a fill-up.
-- As for the other entities, only the names of the changed fields.

alter table public.audit_log drop constraint audit_log_entity_check;
alter table public.audit_log add constraint audit_log_entity_check
  check (entity in (
    'client', 'supplier', 'deadline', 'estimate', 'quote', 'site', 'employee', 'vehicle',
    'daily_report', 'site_cost', 'site_document', 'purchase_order', 'warehouse_item', 'invoice',
    'progress_statement', 'price_list', 'site_activity', 'employee_absence', 'vehicle_maintenance',
    'vehicle_refueling'
  ));

create trigger vehicle_refuelings_audit
  after insert or update or delete on public.vehicle_refuelings
  for each row execute function app.audit_row('vehicle_refueling');
