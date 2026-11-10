-- Change log also for the payments of the invoices (who recorded or deleted a collection, a
-- payment or a refund) and for the documents of the suppliers (who recorded, renewed or
-- deleted a DURC). As for the other entities, only the names of the changed fields.

alter table public.audit_log drop constraint audit_log_entity_check;
alter table public.audit_log add constraint audit_log_entity_check
  check (entity in (
    'client', 'supplier', 'deadline', 'estimate', 'quote', 'site', 'employee', 'vehicle',
    'daily_report', 'site_cost', 'site_document', 'purchase_order', 'warehouse_item', 'invoice',
    'progress_statement', 'price_list', 'site_activity', 'employee_absence', 'vehicle_maintenance',
    'vehicle_refueling', 'vehicle_document', 'employee_document', 'invoice_payment',
    'supplier_document'
  ));

create trigger invoice_payments_audit
  after insert or update or delete on public.invoice_payments
  for each row execute function app.audit_row('invoice_payment');

create trigger supplier_documents_audit
  after insert or update or delete on public.supplier_documents
  for each row execute function app.audit_row('supplier_document');
