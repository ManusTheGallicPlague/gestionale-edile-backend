-- Change log for the remaining rows inside a document, with app.audit_child_row() of 0091: lines
-- of purchase orders and progress statements, hours of people and vehicles in a daily report,
-- dependencies of a schedule activity. The routes now update only the rows that changed, so that
-- saving the same rows leaves no entry.

create trigger purchase_order_lines_audit
  after insert or update or delete on public.purchase_order_lines
  for each row
  execute function app.audit_child_row('purchase_order', 'purchase_orders', 'order_id', 'lines');
create trigger progress_statement_lines_audit
  after insert or update or delete on public.progress_statement_lines
  for each row
  execute function app.audit_child_row(
    'progress_statement', 'progress_statements', 'statement_id', 'lines'
  );
create trigger daily_report_labor_audit
  after insert or update or delete on public.daily_report_labor
  for each row
  execute function app.audit_child_row('daily_report', 'daily_reports', 'report_id', 'labor');
create trigger daily_report_vehicles_audit
  after insert or update or delete on public.daily_report_vehicles
  for each row
  execute function app.audit_child_row('daily_report', 'daily_reports', 'report_id', 'vehicles');
create trigger site_activity_dependencies_audit
  after insert or update or delete on public.site_activity_dependencies
  for each row
  execute function app.audit_child_row(
    'site_activity', 'site_activities', 'activity_id', 'dependencies'
  );

-- The rows are now updated in place (insert ... on conflict do update): only the values, never
-- the company or the document they belong to.
create policy purchase_order_lines_update on public.purchase_order_lines
  for update using (company_id = app.current_company_id())
  with check (company_id = app.current_company_id());
create policy progress_statement_lines_update on public.progress_statement_lines
  for update using (company_id = app.current_company_id())
  with check (company_id = app.current_company_id());
create policy daily_report_labor_update on public.daily_report_labor
  for update using (company_id = app.current_company_id())
  with check (company_id = app.current_company_id());
create policy daily_report_vehicles_update on public.daily_report_vehicles
  for update using (company_id = app.current_company_id())
  with check (company_id = app.current_company_id());

grant update (description, unit, quantity, unit_price_cents)
  on public.purchase_order_lines to gestionale_app;
grant update (quantity, unit_price_cents) on public.progress_statement_lines to gestionale_app;
grant update (hours, description, position) on public.daily_report_labor to gestionale_app;
grant update (hours, description, position) on public.daily_report_vehicles to gestionale_app;
