-- Daily reports (rapportini): one per site and day, with the hours of employees and
-- vehicles and the work done. Draft → submitted → approved; only drafts change.
-- Sites, employees and vehicles named in a report cannot be deleted.

create table public.daily_reports (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies (id) on delete cascade,
  site_id uuid not null,
  report_date date not null,
  status text not null default 'draft' check (status in ('draft', 'submitted', 'approved')),
  weather text check (char_length(weather) <= 100),
  work_done text check (char_length(work_done) <= 5000),
  notes text check (char_length(notes) <= 2000),
  -- Who wrote and who approved: no foreign key, users live in the auth schema.
  created_by uuid,
  submitted_at timestamptz,
  approved_at timestamptz,
  approved_by uuid,
  version integer not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (company_id, id),
  unique (site_id, report_date),
  foreign key (company_id, site_id) references public.sites (company_id, id) on delete restrict
);
create index daily_reports_company_date_idx on public.daily_reports (company_id, report_date, id);

create table public.daily_report_labor (
  company_id uuid not null references public.companies (id) on delete cascade,
  report_id uuid not null,
  employee_id uuid not null,
  hours numeric(4, 2) not null check (hours > 0 and hours <= 24),
  description text check (char_length(description) <= 500),
  position integer not null,
  primary key (report_id, employee_id),
  foreign key (company_id, report_id) references public.daily_reports (company_id, id)
    on delete cascade,
  foreign key (company_id, employee_id) references public.employees (company_id, id)
    on delete restrict
);
create index daily_report_labor_employee_idx on public.daily_report_labor (employee_id);

create table public.daily_report_vehicles (
  company_id uuid not null references public.companies (id) on delete cascade,
  report_id uuid not null,
  vehicle_id uuid not null,
  hours numeric(4, 2) not null check (hours > 0 and hours <= 24),
  description text check (char_length(description) <= 500),
  position integer not null,
  primary key (report_id, vehicle_id),
  foreign key (company_id, report_id) references public.daily_reports (company_id, id)
    on delete cascade,
  foreign key (company_id, vehicle_id) references public.vehicles (company_id, id)
    on delete restrict
);
create index daily_report_vehicles_vehicle_idx on public.daily_report_vehicles (vehicle_id);

alter table public.daily_reports enable row level security;
alter table public.daily_report_labor enable row level security;
alter table public.daily_report_vehicles enable row level security;

create policy daily_reports_select on public.daily_reports
  for select using (company_id = app.current_company_id());
create policy daily_reports_insert on public.daily_reports
  for insert with check (company_id = app.current_company_id());
create policy daily_reports_update on public.daily_reports
  for update using (company_id = app.current_company_id())
  with check (company_id = app.current_company_id());
create policy daily_reports_delete on public.daily_reports
  for delete using (company_id = app.current_company_id());

create policy daily_report_labor_select on public.daily_report_labor
  for select using (company_id = app.current_company_id());
create policy daily_report_labor_insert on public.daily_report_labor
  for insert with check (company_id = app.current_company_id());
create policy daily_report_labor_delete on public.daily_report_labor
  for delete using (company_id = app.current_company_id());

create policy daily_report_vehicles_select on public.daily_report_vehicles
  for select using (company_id = app.current_company_id());
create policy daily_report_vehicles_insert on public.daily_report_vehicles
  for insert with check (company_id = app.current_company_id());
create policy daily_report_vehicles_delete on public.daily_report_vehicles
  for delete using (company_id = app.current_company_id());

grant select, insert, update, delete on public.daily_reports to gestionale_app;
-- The hours are replaced as a whole on every save: no update.
grant select, insert, delete on public.daily_report_labor to gestionale_app;
grant select, insert, delete on public.daily_report_vehicles to gestionale_app;

alter table public.audit_log drop constraint audit_log_entity_check;
alter table public.audit_log add constraint audit_log_entity_check
  check (entity in (
    'client', 'supplier', 'deadline', 'estimate', 'quote', 'site', 'employee', 'vehicle',
    'daily_report'
  ));

create trigger daily_reports_audit after insert or update or delete on public.daily_reports
  for each row execute function app.audit_row('daily_report');
