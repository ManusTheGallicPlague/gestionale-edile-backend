-- Maintenance of vehicles: services, repairs, inspections, tyres. One row per job, with the
-- workshop (a supplier of the company), the cost in cents and the odometer or hour meter.

create table public.vehicle_maintenances (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies (id) on delete cascade,
  vehicle_id uuid not null,
  performed_on date not null,
  kind text not null check (kind in ('service', 'repair', 'inspection', 'tires', 'other')),
  description text not null check (char_length(description) between 1 and 300),
  supplier_id uuid,
  amount_cents bigint check (amount_cents >= 0),
  meter_reading integer check (meter_reading between 0 and 9999999),
  notes text check (char_length(notes) <= 2000),
  version integer not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- The maintenance belongs to the vehicle: it goes with it.
  foreign key (company_id, vehicle_id) references public.vehicles (company_id, id)
    on delete cascade,
  -- A workshop with maintenance jobs is not deleted (409 has_documents, as for site costs).
  foreign key (company_id, supplier_id) references public.suppliers (company_id, id)
    on delete restrict
);
create index vehicle_maintenances_vehicle_idx
  on public.vehicle_maintenances (vehicle_id, performed_on);
create index vehicle_maintenances_supplier_idx on public.vehicle_maintenances (supplier_id)
  where supplier_id is not null;

alter table public.vehicle_maintenances enable row level security;

create policy vehicle_maintenances_select on public.vehicle_maintenances
  for select using (company_id = app.current_company_id());
create policy vehicle_maintenances_insert on public.vehicle_maintenances
  for insert with check (company_id = app.current_company_id());
create policy vehicle_maintenances_update on public.vehicle_maintenances
  for update using (company_id = app.current_company_id())
  with check (company_id = app.current_company_id());
create policy vehicle_maintenances_delete on public.vehicle_maintenances
  for delete using (company_id = app.current_company_id());

grant select, insert, update, delete on public.vehicle_maintenances to gestionale_app;
