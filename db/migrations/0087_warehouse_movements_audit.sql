-- Change log also for the warehouse movements: who deleted a load or an unload (the movement
-- itself keeps only who entered it). Stock counts and returns are movements too.

alter table public.audit_log drop constraint audit_log_entity_check;
alter table public.audit_log add constraint audit_log_entity_check
  check (entity in (
    'client', 'supplier', 'deadline', 'estimate', 'quote', 'site', 'employee', 'vehicle',
    'daily_report', 'site_cost', 'site_document', 'purchase_order', 'warehouse_item', 'invoice',
    'progress_statement', 'price_list', 'site_activity', 'employee_absence', 'vehicle_maintenance',
    'vehicle_refueling', 'vehicle_document', 'employee_document', 'invoice_payment',
    'supplier_document', 'warehouse_movement'
  ));

create trigger warehouse_movements_audit
  after insert or update or delete on public.warehouse_movements
  for each row execute function app.audit_row('warehouse_movement');
