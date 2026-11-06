-- Vehicles and machinery (mezzi): vans, trucks, excavators, cranes. Daily reports will
-- record their hours; the hourly cost feeds the site costs.

create table public.vehicles (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies (id) on delete cascade,
  name text not null check (char_length(name) between 1 and 200),
  kind text not null check (kind in ('vehicle', 'machine', 'equipment')),
  plate text check (plate ~ '^[A-Z0-9]{1,10}$'),
  model text check (char_length(model) <= 200),
  hourly_cost_cents bigint check (hourly_cost_cents >= 0),
  active boolean not null default true,
  notes text check (char_length(notes) <= 2000),
  version integer not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (company_id, id)
);
create unique index vehicles_company_plate_idx on public.vehicles (company_id, plate)
  where plate is not null;
create index vehicles_company_name_idx on public.vehicles (company_id, lower(name), id);

alter table public.vehicles enable row level security;

create policy vehicles_select on public.vehicles
  for select using (company_id = app.current_company_id());
create policy vehicles_insert on public.vehicles
  for insert with check (company_id = app.current_company_id());
create policy vehicles_update on public.vehicles
  for update using (company_id = app.current_company_id())
  with check (company_id = app.current_company_id());
create policy vehicles_delete on public.vehicles
  for delete using (company_id = app.current_company_id());

grant select, insert, update, delete on public.vehicles to gestionale_app;

alter table public.audit_log drop constraint audit_log_entity_check;
alter table public.audit_log add constraint audit_log_entity_check
  check (entity in (
    'client', 'supplier', 'deadline', 'estimate', 'quote', 'site', 'employee', 'vehicle'
  ));

create trigger vehicles_audit after insert or update or delete on public.vehicles
  for each row execute function app.audit_row('vehicle');
