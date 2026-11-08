-- Change log also for the absences of the employees: holidays and sick leave decide the payslip,
-- so who recorded or changed them matters. The log keeps only the names of the changed fields,
-- never the values: the kind of absence (sick leave, injury) does not end up in it.

alter table public.audit_log drop constraint audit_log_entity_check;
alter table public.audit_log add constraint audit_log_entity_check
  check (entity in (
    'client', 'supplier', 'deadline', 'estimate', 'quote', 'site', 'employee', 'vehicle',
    'daily_report', 'site_cost', 'site_document', 'purchase_order', 'warehouse_item', 'invoice',
    'progress_statement', 'price_list', 'site_activity', 'employee_absence'
  ));

create trigger employee_absences_audit
  after insert or update or delete on public.employee_absences
  for each row execute function app.audit_row('employee_absence');
